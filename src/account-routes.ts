/** Owner-private route metadata. OAuth files remain the sole credential owner. */
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { CLAUDE_CODE_OAUTH_ROUTE, CODEX_OAUTH_ROUTE, KIMI_CODE_OAUTH_ROUTE } from "./ids.ts";
import type { SubscriptionProviderSlug } from "./oauth-providers.ts";
import { OAuthSourceError, readHardenedOAuthSourceFile } from "./oauth-sources.ts";
import { isValidAccountId, OAUTH_MAX_ACCOUNTS } from "./store.ts";

export const ACCOUNT_ROUTES_FILENAME = ".coding-oauth-account-routes.json";
const MAX_BYTES = 64 * 1024;
const MAX_BINDINGS = 256;
const ROOTS: Record<SubscriptionProviderSlug, string> = {
	claude: CLAUDE_CODE_OAUTH_ROUTE,
	codex: CODEX_OAUTH_ROUTE,
	kimi: KIMI_CODE_OAUTH_ROUTE,
};

/** Internal identifiers must NOT be returned directly to tools/status consumers. */
export interface AccountRouteDescriptor {
	readonly family: SubscriptionProviderSlug;
	readonly accountId: string;
	readonly createdAt: number;
}
export interface AccountRouteBinding extends AccountRouteDescriptor {
	readonly route: string;
	readonly slot: number;
}
/** `slot` stays an internal persistence detail; users and models see names instead. */
export interface AccountRouteView {
	readonly family: SubscriptionProviderSlug;
	readonly route: string;
}
interface Document {
	version: 1;
	bindings: AccountRouteBinding[];
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function family(value: unknown): value is SubscriptionProviderSlug {
	return value === "claude" || value === "codex" || value === "kimi";
}
function validDescriptor(value: unknown): value is AccountRouteDescriptor {
	return (
		record(value) &&
		family(value.family) &&
		isValidAccountId(value.accountId) &&
		typeof value.createdAt === "number" &&
		Number.isFinite(value.createdAt) &&
		value.createdAt > 0
	);
}
function key(value: AccountRouteDescriptor): string {
	return JSON.stringify([value.family, value.accountId, value.createdAt]);
}
function unavailable(): Error {
	return new Error("Account route metadata is unavailable or invalid");
}

/** Allowlisted projection: no provider account IDs, labels, epochs, filenames or tokens. */
export function publicAccountRoute(binding: AccountRouteBinding): AccountRouteView {
	return { family: binding.family, route: binding.route };
}

function parse(text: string): Document {
	if (Buffer.byteLength(text, "utf8") > MAX_BYTES) throw unavailable();
	const value: unknown = JSON.parse(text);
	if (
		!record(value) ||
		Object.keys(value).some((name) => name !== "version" && name !== "bindings") ||
		value.version !== 1 ||
		!Array.isArray(value.bindings) ||
		value.bindings.length > MAX_BINDINGS
	)
		throw unavailable();
	const keys = new Set<string>();
	const routes = new Set<string>();
	const slots = new Set<string>();
	const bindings: AccountRouteBinding[] = [];
	for (const row of value.bindings) {
		if (
			!validDescriptor(row) ||
			!record(row) ||
			Object.keys(row).some((name) => !["family", "accountId", "createdAt", "route", "slot"].includes(name)) ||
			typeof row.route !== "string" ||
			!new RegExp(`^${ROOTS[row.family]}-account-[a-f0-9]{32}$`, "u").test(row.route) ||
			typeof row.slot !== "number" ||
			!Number.isSafeInteger(row.slot) ||
			row.slot < 1 ||
			row.slot > MAX_BINDINGS
		)
			throw unavailable();
		const rowKey = key(row);
		const slotKey = `${row.family}:${row.slot}`;
		if (keys.has(rowKey) || routes.has(row.route) || slots.has(slotKey)) throw unavailable();
		keys.add(rowKey);
		routes.add(row.route);
		slots.add(slotKey);
		bindings.push({
			family: row.family,
			accountId: row.accountId,
			createdAt: row.createdAt,
			route: row.route,
			slot: row.slot,
		});
	}
	return { version: 1, bindings };
}

/** Stable random slots, not credential-derived aliases or active-account switches. */
export class AccountRouteRegistry {
	readonly filename: string;
	constructor(
		filename: string,
		private readonly createId: () => string = () => randomUUID().replaceAll("-", ""),
	) {
		this.filename = resolve(filename);
	}

	private async load(): Promise<Document> {
		try {
			return parse((await readHardenedOAuthSourceFile(this.filename)).text);
		} catch (error) {
			if (error instanceof OAuthSourceError && error.code === "not_found") return { version: 1, bindings: [] };
			throw unavailable();
		}
	}

	/** Only the explicitly enabled runtime calls this mutation; history slots are never reused. */
	async synchronize(accounts: readonly AccountRouteDescriptor[]): Promise<readonly AccountRouteBinding[]> {
		if (!Array.isArray(accounts as unknown)) throw unavailable();
		const selected = new Set<string>();
		const ids = new Set<string>();
		const counts = new Map<SubscriptionProviderSlug, number>();
		const snapshot: AccountRouteDescriptor[] = [];
		for (const source of accounts) {
			if (!validDescriptor(source)) throw unavailable();
			const account = { family: source.family, accountId: source.accountId, createdAt: source.createdAt };
			snapshot.push(account);
			const id = JSON.stringify([account.family, account.accountId]);
			if (ids.has(id)) throw unavailable();
			ids.add(id);
			selected.add(key(account));
			const count = (counts.get(account.family) ?? 0) + 1;
			if (count > OAUTH_MAX_ACCOUNTS) throw unavailable();
			counts.set(account.family, count);
		}
		if (accounts.length === 0) return [];
		try {
			await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 });
			return await withFileLock(this.filename, async () => {
				const document = await this.load();
				const existing = new Set(document.bindings.map(key));
				const routes = new Set(document.bindings.map((row) => row.route));
				let changed = false;
				for (const account of snapshot) {
					if (existing.has(key(account))) continue;
					if (document.bindings.length >= MAX_BINDINGS) throw unavailable();
					const id = this.createId();
					if (!/^[a-f0-9]{32}$/u.test(id)) throw unavailable();
					const route = `${ROOTS[account.family]}-account-${id}`;
					if (routes.has(route)) throw unavailable();
					const slot =
						1 + Math.max(0, ...document.bindings.filter((row) => row.family === account.family).map((row) => row.slot));
					document.bindings.push({
						family: account.family,
						accountId: account.accountId,
						createdAt: account.createdAt,
						route,
						slot,
					});
					existing.add(key(account));
					routes.add(route);
					changed = true;
				}
				if (changed) {
					const text = `${JSON.stringify(document, null, 2)}\n`;
					if (Buffer.byteLength(text, "utf8") > MAX_BYTES) throw unavailable();
					// Recheck hardened destination immediately before the atomic replacement.
					await this.load();
					await writeFileAtomic(this.filename, text, { mode: 0o600, dirMode: 0o700 });
				}
				return document.bindings.filter((row) => selected.has(key(row))).map((row) => ({ ...row }));
			});
		} catch {
			throw unavailable();
		}
	}
}
