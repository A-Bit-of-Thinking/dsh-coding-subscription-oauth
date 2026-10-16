import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	AccountRenameError,
	describeFamilyAccounts,
	modelFacingAccounts,
	normalizeAccountLabel,
} from "../src/account-names.ts";
import { createCodingOAuthAdapter } from "../src/adapter.ts";
import { CLAUDE_CODE_OAUTH_ROUTE, CODEX_OAUTH_ROUTE } from "../src/ids.ts";
import { OAUTH_PROVIDER_DEFINITIONS } from "../src/oauth-providers.ts";
import { OAuthProviderSession } from "../src/oauth-session.ts";
import { GrokBuildSession } from "../src/session.ts";
import { GrokBuildCredentialStore, OAuthCredentialFileStore } from "../src/store.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) {
		if (!dir.startsWith(join(tmpdir(), "dsh-account-labels-"))) throw new Error("Unexpected cleanup target");
		await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}
});
async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "dsh-account-labels-"));
	dirs.push(dir);
	return dir;
}
const credential = (id: string) => ({
	type: "oauth" as const,
	access: `fixture-access-${id}`,
	refresh: `fixture-refresh-${id}`,
	expires: Date.now() + 3_600_000,
});
async function storeWith(ids: readonly string[]) {
	const dir = await tempDir();
	const store = new OAuthCredentialFileStore("anthropic", join(dir, "auth.json"), "fixture");
	for (const id of ids) await store.upsertAccount({ id, credential: credential(id) });
	return { dir, store };
}

describe("normalizeAccountLabel", () => {
	it("trims, accepts 1..40 characters and treats null/undefined/blank as a clear", () => {
		expect(normalizeAccountLabel("  Perso  ")).toBe("Perso");
		expect(normalizeAccountLabel("x".repeat(40))).toBe("x".repeat(40));
		expect(normalizeAccountLabel("😀".repeat(40))).toBe("😀".repeat(40));
		for (const blank of [null, undefined, "", "   ", "\t "]) expect(normalizeAccountLabel(blank)).toBeNull();
	});
	it("rejects too long labels, control characters, bidi overrides and non-strings", () => {
		for (const bad of ["x".repeat(41), "a\nb", "a\u0000b", "a\u007fb", "a\u2028b", "a\u202eb", 3, true, {}, []]) {
			expect(() => normalizeAccountLabel(bad)).toThrow(AccountRenameError);
		}
	});
	it("rejects every invisible format character: zero-width, bidi marks, overrides and isolates", () => {
		const hidden = [
			"\u200b",
			"\u200e",
			"\u200f",
			"\u061c",
			"\u202a",
			"\u202c",
			"\u202e",
			"\u2066",
			"\u2069",
			"\u2028",
			"\u2029",
			"\u00ad",
			"\ufeff",
		];
		for (const char of hidden) {
			expect(() => normalizeAccountLabel(`a${char}b`), `U+${char.codePointAt(0)!.toString(16)}`).toThrow(
				AccountRenameError,
			);
		}
		expect(normalizeAccountLabel("Compte perso é 日本語 😀")).toBe("Compte perso é 日本語 😀");
	});
	it("never echoes the label in its error", () => {
		try {
			normalizeAccountLabel(`SECRET_LOOKING_VALUE${"x".repeat(60)}`);
			expect.unreachable();
		} catch (error) {
			expect(String((error as Error).message)).not.toContain("SECRET");
			expect(JSON.stringify(error)).not.toContain("SECRET");
		}
	});
});

describe("describeFamilyAccounts", () => {
	it("ranks by createdAt among the given (current) accounts, ties broken by id, with no holes", () => {
		const described = describeFamilyAccounts(
			"codex",
			[
				{ id: "z", createdAt: 30 },
				{ id: "b", createdAt: 10 },
				{ id: "a", createdAt: 10 },
			],
			"z",
		);
		expect([...described].map(([id, d]) => [id, d.name, d.isDefault])).toEqual([
			["a", "Codex · compte 1", false],
			["b", "Codex · compte 2", false],
			["z", "Codex · compte 3", true],
		]);
		const afterRemoval = describeFamilyAccounts(
			"codex",
			[
				{ id: "z", createdAt: 30 },
				{ id: "a", createdAt: 10 },
			],
			"a",
		);
		expect(afterRemoval.get("z")).toEqual({ name: "Codex · compte 2", label: null, isDefault: false });
	});
	it("uses a valid label and silently falls back for an unusable stored one", () => {
		const described = describeFamilyAccounts(
			"claude",
			[
				{ id: "a", createdAt: 1, label: "Pro" },
				{ id: "b", createdAt: 2, label: "bad\u0007label" },
			],
			undefined,
		);
		expect(described.get("a")).toEqual({ name: "Claude · Pro", label: "Pro", isDefault: false });
		expect(described.get("b")).toEqual({ name: "Claude · compte 2", label: null, isDefault: false });
	});
});

describe("modelFacingAccounts", () => {
	it("keeps only name, isDefault, route and quota", () => {
		const view = modelFacingAccounts({
			state: "ready",
			accounts: [
				{
					family: "claude",
					route: "r",
					name: "Claude · compte 1",
					label: null,
					isDefault: true,
					quota: { state: "unknown" },
				},
			],
		});
		expect(view).toEqual({
			state: "ready",
			accounts: [{ name: "Claude · compte 1", isDefault: true, route: "r", quota: { state: "unknown" } }],
		});
	});
});

describe("OAuthCredentialFileStore.setAccountLabel", () => {
	it("persists a trimmed label, clears it, and leaves credentials and the active account untouched", async () => {
		const { store, dir } = await storeWith(["a", "b"]);
		const before = JSON.parse(await readFile(join(dir, "auth.json"), "utf8")) as {
			activeAccountId: string;
			accounts: { id: string; credential: unknown; createdAt: number; label?: string }[];
		};
		await store.setAccountLabel("b", "  Travail ");
		const labelled = JSON.parse(await readFile(join(dir, "auth.json"), "utf8")) as typeof before;
		expect(labelled.activeAccountId).toBe(before.activeAccountId);
		expect(labelled.accounts.map((account) => account.credential)).toEqual(
			before.accounts.map((account) => account.credential),
		);
		expect(labelled.accounts.map((account) => account.createdAt)).toEqual(
			before.accounts.map((account) => account.createdAt),
		);
		expect(labelled.accounts.map((account) => account.label)).toEqual([undefined, "Travail"]);
		expect((await store.listAccounts({ readOnly: true })).map((row) => row.label)).toEqual([undefined, "Travail"]);
		await store.setAccountLabel("b", null);
		const cleared = JSON.parse(await readFile(join(dir, "auth.json"), "utf8")) as typeof before;
		expect(cleared).toEqual(before);
	});
	it("survives a reconnection of the same account (credential refresh keeps the label)", async () => {
		const { store } = await storeWith(["a"]);
		await store.setAccountLabel("a", "Perso");
		await store.upsertAccount({ id: "a", credential: credential("a-new") });
		expect((await store.listAccounts({ readOnly: true }))[0]?.label).toBe("Perso");
	});
	it("rejects invalid labels and unknown accounts without modifying the file or echoing the label", async () => {
		const { store, dir } = await storeWith(["a"]);
		const file = join(dir, "auth.json");
		const before = await readFile(file, "utf8");
		const canary = "CANARY_LABEL";
		await expect(store.setAccountLabel("a", `${canary}\u0007`)).rejects.toThrow(AccountRenameError);
		await expect(store.setAccountLabel("a", canary.repeat(10))).rejects.toThrow(/label is invalid/u);
		await expect(store.setAccountLabel("missing", canary)).rejects.toThrow(/not stored/u);
		await expect(store.setAccountLabel("bad id!", canary)).rejects.toThrow(TypeError);
		for (const call of [
			store.setAccountLabel("missing", canary).catch((error: Error) => error.message),
			store.setAccountLabel("a", canary.repeat(10)).catch((error: Error) => error.message),
		])
			expect(await call).not.toContain(canary);
		expect(await readFile(file, "utf8")).toBe(before);
	});
	it("keeps concurrent writes for different accounts (serialized under the document lock)", async () => {
		const { store } = await storeWith(["a", "b", "c"]);
		await Promise.all([
			store.setAccountLabel("a", "Un"),
			store.setAccountLabel("b", "Deux"),
			store.setAccountLabel("c", "Trois"),
		]);
		expect((await store.listAccounts({ readOnly: true })).map((row) => row.label)).toEqual(["Un", "Deux", "Trois"]);
	});
});

describe("legacy route name follows the default account", () => {
	// providerInfo is read live by the adapter; the host only sees it when the registration is `replace`d
	// (the legacy registration refresh is asserted in capability-runtime.spec.ts).
	it("answers providerInfo with the live default name, and the static name again when none is known", async () => {
		const dir = await tempDir();
		const grok = new GrokBuildSession(new GrokBuildCredentialStore(join(dir, "grok.json")));
		const subscriptions = OAUTH_PROVIDER_DEFINITIONS.map(
			(definition) =>
				new OAuthProviderSession(
					definition,
					undefined,
					new OAuthCredentialFileStore(
						definition.nativeProviderId,
						join(dir, `${definition.slug}.json`),
						definition.route,
					),
					join(dir, `${definition.slug}-models.json`),
				),
		);
		let claude: string | undefined;
		const adapter = createCodingOAuthAdapter(grok, subscriptions, () => undefined, {
			defaultAccountName: (family) => (family === "claude" ? claude : undefined),
		});
		expect(adapter.providerInfo(CLAUDE_CODE_OAUTH_ROUTE).name).toBe("Claude Code (OAuth)");
		claude = "Claude · Perso (par défaut)";
		expect(adapter.providerInfo(CLAUDE_CODE_OAUTH_ROUTE).name).toBe("Claude · Perso (par défaut)");
		claude = "Claude · compte 2 (par défaut)";
		expect(adapter.providerInfo(CLAUDE_CODE_OAUTH_ROUTE).name).toBe("Claude · compte 2 (par défaut)");
		expect(adapter.providerInfo(CODEX_OAUTH_ROUTE).name).toBe("OpenAI Codex (OAuth)");
		claude = undefined;
		expect(adapter.providerInfo(CLAUDE_CODE_OAUTH_ROUTE).name).toBe("Claude Code (OAuth)");
	});
});
