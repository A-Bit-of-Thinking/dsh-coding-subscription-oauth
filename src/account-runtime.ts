/** Fixed-account registrations are separate from the legacy/Fast registration owner. */
import type { AttachmentStore } from "@deepseek-ai/dsh-attachment";
import { type LlmAdapter, LlmError } from "@deepseek-ai/dsh-llm";
import { AccountBoundAdapter } from "./account-adapter.ts";
import {
	type AccountDisplay,
	AccountRenameError,
	accountFamilyName,
	DEFAULT_SUFFIX,
	describeFamilyAccounts,
	normalizeAccountLabel,
} from "./account-names.ts";
import {
	createClaudeQuotaSource,
	createCodexQuotaSource,
	QUOTA_AUTO_REFRESH_MS,
	QUOTA_MAX_BACKOFF_FACTOR,
	QUOTA_MIN_READ_INTERVAL_MS,
	QUOTA_READ_TIMEOUT_MS,
	QUOTA_STALE_AFTER_MS,
	QUOTA_TOOL_REFRESH_AFTER_MS,
	type QuotaSource,
	type QuotaState,
	type QuotaWindow,
} from "./account-quota.ts";
import {
	type AccountRouteDescriptor,
	type AccountRouteRegistry,
	type AccountRouteView,
	publicAccountRoute,
} from "./account-routes.ts";
import { ClaudeUsageCooldownError } from "./claude-usage.ts";
import type { OAuthProviderSession } from "./oauth-session.ts";
import type { RoutingConfig } from "./routing-config.ts";

export type AccountRuntimeState = "disabled" | "waiting-for-llm" | "loading" | "ready" | "error";
/**
 * What the host returns for a registered adapter: the disposer, plus an atomic route replacement for the
 * same adapter instance. `replace` re-reads providerInfo (the host snapshots names at registration) and
 * announces the catalog change itself; it never interrupts a request in flight.
 */
export type AccountRegistration = (() => void) & { replace(routes: string[]): void };
export type AccountAdapterRegistrar = (routes: string[], adapter: LlmAdapter) => AccountRegistration;
/**
 * Quota states: `disabled` (quota reads off), `unsupported` (no reader for this family), `not-read`
 * (never read since startup), `fresh` (read < 5 min ago), `stale` (older, or a later read failed),
 * `error` (every read failed so far; `errorCode` says why), `unknown` (read, but no usable window:
 * `errorCode` is NO_WINDOWS). None of them means "zero used".
 */
export interface RoutedAccountStatus extends AccountRouteView, AccountDisplay {
	quota: {
		state: QuotaState;
		windows: readonly QuotaWindow[];
		fetchedAt?: number;
		errorCode?: string;
		/** When the next automatic read of this route is expected (epoch ms); absent while no schedule is active. */
		nextRefreshAt?: number;
	};
}
/**
 * Read pacing of one route. Kept in a map that outlives entries (disable/re-enable, LLM re-attach), so
 * switching the feature off and on cannot be used to bypass the minimal delay or a RATE_LIMIT backoff.
 * Dropped when the account is removed or recreated.
 */
interface Throttle {
	readonly accountId: string;
	readonly createdAt: number;
	/** Start of the last network attempt (success or failure): drives the minimal delay between reads. */
	lastAttemptAt?: number;
	/** Earliest time the timer reads this route again (grows with the RATE_LIMIT backoff). */
	nextAutoAt?: number;
	/** 1 normally; doubled after each network RATE_LIMIT, reset by a successful read. */
	backoff: number;
}
interface Entry {
	adapter: AccountBoundAdapter;
	display: AccountDisplay;
	registration: AccountRegistration;
	throttle: Throttle;
	usage?: QuotaSource;
	errorCode?: string;
	/** Aborts the read in flight (deadline, withdrawal of the route, disposal). */
	abort?: AbortController;
	/** At most one read at a time per route. Never rejects. */
	flight?: Promise<void>;
}
/** Races a read against its signal: a source that ignores the signal still cannot outlive the deadline. */
function untilAborted(pending: Promise<void>, signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const onAbort = (): void => reject(new LlmError("Account quota read timed out or was cancelled", "TIMEOUT"));
		if (signal.aborted) {
			void pending.catch(() => undefined);
			return onAbort();
		}
		signal.addEventListener("abort", onAbort, { once: true });
		pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}
/** Stops everything an entry owns: new streams, the quota read in flight, its cache and its host route. */
function retire(entry: Entry): void {
	entry.adapter.dispose();
	entry.abort?.abort();
	entry.usage?.clear();
	entry.registration();
}
/** One store read: route descriptors and display names of a family's current accounts. */
async function readFamily(session: OAuthProviderSession) {
	const family = session.definition.slug;
	const rows = await session.store.listAccounts({ includeCreatedAt: true });
	const descriptors: AccountRouteDescriptor[] = [];
	for (const row of rows) {
		if (row.createdAt === undefined) throw new Error("Missing account metadata");
		descriptors.push({ family, accountId: row.id, createdAt: row.createdAt });
	}
	const activeId = await session.store.getActiveAccountId({ readOnly: true });
	const displays = describeFamilyAccounts(
		family,
		rows.map((row) => ({ id: row.id, createdAt: row.createdAt!, label: row.label })),
		activeId,
	);
	return { descriptors, displays };
}
function displayKey(family: string, accountId: string): string {
	return JSON.stringify([family, accountId]);
}
const READ_ERROR_CODES = ["AUTH", "PERMISSION", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"];
/** The timer fires at fixed intervals while an attempt starts a few ms later: tolerate that skew. */
const TICK_TOLERANCE_MS = 5_000;

export interface AccountRuntimeOptions {
	registry: AccountRouteRegistry;
	sessions: readonly OAuthProviderSession[];
	current(): RoutingConfig;
	resolveAttachments(): AttachmentStore | undefined;
	fetchImpl?: typeof fetch;
	onError?(): void;
	/**
	 * The name the legacy (default-account) route shows changed. The legacy route belongs to another
	 * registration, so the owner must `replace` its routes (the host snapshots provider names at
	 * registration); fixed account routes are replaced here, through their own registration.
	 */
	onLegacyDisplayChange?(): void;
}

export class AccountRoutingRuntime {
	private entries = new Map<string, Entry>();
	private throttles = new Map<string, Throttle>();
	private registrar: AccountAdapterRegistrar | undefined;
	private epoch = 0;
	private state: "disabled" | "waiting-for-llm" | "loading" | "ready" | "error" = "disabled";
	private disposed = false;
	/** family -> "Claude Â· <name> (par dÃ©faut)" for the legacy route; empty until a reconcile succeeds. */
	private defaultNames = new Map<string, string>();
	/** Automatic quota reads: present only while routing and quota reads are both enabled and attached. */
	private timer: ReturnType<typeof setInterval> | undefined;
	private nextTickAt = 0;
	constructor(private readonly options: AccountRuntimeOptions) {}

	/** Synchronous (providerInfo cannot await): name the legacy route shows for the default account. */
	defaultRouteName(family: string): string | undefined {
		return this.defaultNames.get(family);
	}

	/**
	 * Set (or clear with null/empty) the label of the account behind `route`, then refresh names.
	 * Adapters are kept, so a request in flight is never interrupted. Errors carry no label.
	 * The answer always reflects the label actually written: should the reconciliation fail or be
	 * superseded, the renamed row is recomputed from the store instead of echoing the previous name.
	 */
	async renameAccount(route: string, label: unknown): Promise<ReturnType<AccountRoutingRuntime["snapshot"]>> {
		const normalized = normalizeAccountLabel(label);
		const entry = this.entries.get(route);
		if (entry === undefined) throw new AccountRenameError("unknown-route");
		const { family, accountId } = entry.adapter.binding;
		const session = this.options.sessions.find((value) => value.definition.slug === family);
		if (session === undefined) throw new AccountRenameError("unknown-route");
		await session.store.setAccountLabel(accountId, normalized);
		// A reconcile started before the write may supersede ours: retry once to observe the new label.
		for (let attempt = 0; attempt < 2; attempt += 1) {
			await this.reconcile();
			const current = this.entries.get(route);
			if (current === undefined || current.display.label === normalized) break;
		}
		const snapshot = this.snapshot();
		const shown = this.entries.get(route);
		if (shown === undefined || shown.display.label === normalized) return snapshot;
		const written = (await readFamily(session)).displays.get(accountId);
		if (written === undefined) throw new AccountRenameError("unknown-route");
		return {
			...snapshot,
			accounts: snapshot.accounts.map((row) => (row.route === route ? { ...row, ...written } : row)),
		};
	}

	/** Withdraws every route; returns whether the legacy route was showing a default-account name. */
	private clear(): boolean {
		this.stopSchedule();
		const hadLegacyNames = this.defaultNames.size > 0;
		this.defaultNames = new Map();
		for (const entry of this.entries.values()) retire(entry);
		this.entries.clear();
		return hadLegacyNames;
	}
	dispose(): void {
		this.disposed = true;
		this.epoch += 1;
		this.clear();
		this.throttles.clear();
	}

	/** The LLM child may disappear; OAuth/settings ownership remains in the parent. */
	attach(registrar: AccountAdapterRegistrar): () => void {
		this.registrar = registrar;
		void this.reconcile();
		return () => {
			if (this.registrar !== registrar) return;
			this.registrar = undefined;
			this.epoch += 1;
			this.clear();
			this.state = this.options.current().enabled ? "waiting-for-llm" : "disabled";
		};
	}
	private notifyLegacyDisplayChange(): void {
		try {
			this.options.onLegacyDisplayChange?.();
		} catch {
			// Advisory notification: never turns a successful reconciliation into an error.
		}
	}
	/**
	 * Differential: unchanged routes keep their adapter (and any request in flight);
	 * only removed or recreated accounts are withdrawn. A transient read or
	 * metadata error keeps the already validated routes and reports `error`.
	 */
	async reconcile(): Promise<void> {
		const epoch = ++this.epoch;
		if (this.disposed || !this.options.current().enabled) {
			const hadLegacyNames = this.clear();
			this.state = "disabled";
			// Routing switched off while the LLM service stays attached: the legacy route drops its "(par dÃ©faut)" name.
			if (hadLegacyNames && !this.disposed && this.registrar !== undefined) this.notifyLegacyDisplayChange();
			return;
		}
		const registrar = this.registrar;
		if (registrar === undefined) {
			this.clear();
			this.state = "waiting-for-llm";
			return;
		}
		if (this.entries.size === 0) this.state = "loading";
		const stale = (): boolean =>
			epoch !== this.epoch || this.disposed || !this.options.current().enabled || registrar !== this.registrar;
		const added: Entry[] = [];
		try {
			const descriptors = [];
			const displays = new Map<string, AccountDisplay>();
			for (const session of this.options.sessions) {
				// Explicit enablement permits the legacy v1 migration, establishing a stable createdAt.
				const family = await readFamily(session);
				descriptors.push(...family.descriptors);
				for (const [id, display] of family.displays) displays.set(displayKey(session.definition.slug, id), display);
			}
			if (stale()) return;
			const bindings = await this.options.registry.synchronize(descriptors);
			if (stale()) return;
			// No await below: the swap is atomic with respect to other reconciliations.
			const next = new Map<string, Entry>();
			const nextDisplays: [Entry, AccountDisplay][] = [];
			for (const binding of bindings) {
				const display = displays.get(displayKey(binding.family, binding.accountId)) ?? {
					name: accountFamilyName(binding.family),
					label: null,
					isDefault: false,
				};
				const current = this.entries.get(binding.route);
				if (
					current !== undefined &&
					current.adapter.binding.accountId === binding.accountId &&
					current.adapter.binding.createdAt === binding.createdAt
				) {
					next.set(binding.route, current);
					nextDisplays.push([current, display]);
					continue;
				}
				const session = this.options.sessions.find((value) => value.definition.slug === binding.family)!;
				const adapter = new AccountBoundAdapter(session, binding, this.options.resolveAttachments);
				adapter.setDisplayName(display.name);
				let registration: AccountRegistration | undefined;
				try {
					registration = registrar([binding.route], adapter);
				} catch {
					adapter.dispose();
					throw new Error("Account route registration failed");
				}
				let throttle = this.throttles.get(binding.route);
				if (
					throttle === undefined ||
					throttle.accountId !== binding.accountId ||
					throttle.createdAt !== binding.createdAt
				) {
					throttle = { accountId: binding.accountId, createdAt: binding.createdAt, backoff: 1 };
					this.throttles.set(binding.route, throttle);
				}
				const entry: Entry = { adapter, display, registration, throttle };
				added.push(entry);
				if (binding.family === "claude") entry.usage = createClaudeQuotaSource(adapter, this.options.fetchImpl);
				else if (binding.family === "codex") entry.usage = createCodexQuotaSource(adapter, this.options.fetchImpl);
				next.set(binding.route, entry);
			}
			for (const [route, entry] of this.entries) {
				if (next.get(route) !== entry) retire(entry);
			}
			for (const route of this.throttles.keys()) if (!next.has(route)) this.throttles.delete(route);
			// Names and default markers are mutated in place: adapters (and their requests) are kept.
			const changed: [string, Entry][] = [];
			for (const [entry, display] of nextDisplays) {
				if (entry.display.name !== display.name || entry.display.isDefault !== display.isDefault)
					changed.push([entry.adapter.binding.route, entry]);
				entry.display = display;
				entry.adapter.setDisplayName(display.name);
			}
			const defaults = new Map<string, string>();
			for (const entry of next.values())
				if (entry.display.isDefault)
					defaults.set(entry.adapter.binding.family, `${entry.display.name}${DEFAULT_SUFFIX}`);
			const legacyChanged = JSON.stringify([...defaults]) !== JSON.stringify([...this.defaultNames]);
			this.defaultNames = defaults;
			this.entries = next;
			this.state = "ready";
			this.syncSchedule();
			// The host snapshots provider names at registration: re-publish the routes whose name or
			// visibility (default account is hidden) changed. `replace` keeps the adapter and announces
			// the catalog change itself, so each changed route yields exactly one notification.
			for (const [route, entry] of changed) {
				try {
					entry.registration.replace([route]);
				} catch {
					// Advisory: a registration released meanwhile has nothing left to rename.
				}
			}
			if (legacyChanged) this.notifyLegacyDisplayChange();
		} catch {
			// Only what this attempt created is rolled back; validated routes stay.
			for (const entry of added) retire(entry);
			if (epoch === this.epoch) {
				this.state = "error";
				this.options.onError?.();
			}
		}
	}

	private quotaState(entry: Entry, usageEnabled: boolean, now: number): QuotaState {
		if (!usageEnabled) return "disabled";
		if (entry.usage === undefined) return "unsupported";
		const cached = entry.usage.cached();
		if (cached === undefined) return entry.errorCode === undefined ? "not-read" : "error";
		if (entry.errorCode !== undefined) return "stale";
		if (cached.windows.length === 0) return "unknown";
		return now - cached.fetchedAt >= QUOTA_STALE_AFTER_MS ? "stale" : "fresh";
	}

	/** Next timer tick that will reconsider this route (null when no schedule is active). */
	private nextRefreshAt(entry: Entry): number | undefined {
		if (this.timer === undefined || entry.usage === undefined) return undefined;
		const wanted = (entry.throttle.nextAutoAt ?? 0) - TICK_TOLERANCE_MS;
		if (wanted <= this.nextTickAt) return this.nextTickAt;
		return this.nextTickAt + Math.ceil((wanted - this.nextTickAt) / QUOTA_AUTO_REFRESH_MS) * QUOTA_AUTO_REFRESH_MS;
	}

	/** Pure: no network, no await. Prompt assembly and HTTP status rely on that. */
	snapshot(): { state: AccountRuntimeState; accounts: readonly RoutedAccountStatus[] } {
		const usageEnabled = this.options.current().usageEnabled;
		const now = Date.now();
		return {
			state: this.state,
			accounts: [...this.entries.values()].map((entry) => {
				const cached = usageEnabled ? entry.usage?.cached() : undefined;
				const state = this.quotaState(entry, usageEnabled, now);
				const errorCode = !usageEnabled
					? undefined
					: (entry.errorCode ?? (state === "unknown" ? "NO_WINDOWS" : undefined));
				const nextRefreshAt = usageEnabled ? this.nextRefreshAt(entry) : undefined;
				return {
					...publicAccountRoute(entry.adapter.binding),
					name: entry.display.name,
					label: entry.display.label,
					isDefault: entry.display.isDefault,
					quota: {
						state,
						windows: cached?.windows ?? [],
						...(cached === undefined ? {} : { fetchedAt: cached.fetchedAt }),
						...(errorCode === undefined ? {} : { errorCode }),
						...(nextRefreshAt === undefined ? {} : { nextRefreshAt }),
					},
				};
			}),
		};
	}

	private live(id: string, entry: Entry): boolean {
		return this.entries.get(id) === entry && this.options.current().usageEnabled;
	}

	/**
	 * Starts a read of one route, or joins the one in flight. Returns undefined when the route has no
	 * reader or was attempted less than the minimal delay ago (the caller then keeps the current
	 * snapshot, never an error). The read has its own deadline: no caller can abort it for the others.
	 */
	private startRead(id: string, entry: Entry): Promise<void> | undefined {
		const source = entry.usage;
		if (source === undefined) return undefined;
		if (entry.flight !== undefined) return entry.flight;
		const { throttle } = entry;
		const now = Date.now();
		if (
			throttle.lastAttemptAt !== undefined &&
			now - throttle.lastAttemptAt < QUOTA_MIN_READ_INTERVAL_MS * throttle.backoff
		) {
			return undefined;
		}
		throttle.lastAttemptAt = now;
		const controller = new AbortController();
		entry.abort = controller;
		const deadline = setTimeout(() => controller.abort(), QUOTA_READ_TIMEOUT_MS);
		let flight: Promise<void> | undefined;
		flight = (async () => {
			await Promise.resolve(); // `flight` is assigned before anything below can settle.
			try {
				// Hard deadline: the read is abandoned at QUOTA_READ_TIMEOUT_MS even if the source ignores its signal.
				await untilAborted(source.read(controller.signal), controller.signal);
				if (!this.live(id, entry)) return;
				delete entry.errorCode;
				throttle.backoff = 1;
			} catch (error) {
				if (!this.live(id, entry)) return;
				// Codex answers 403 with QUOTA (subscription cannot use the endpoint): same meaning as PERMISSION here.
				const raw = error instanceof LlmError ? (error.code === "QUOTA" ? "PERMISSION" : error.code) : undefined;
				const code = raw !== undefined && READ_ERROR_CODES.includes(raw) ? raw : "UNAVAILABLE";
				entry.errorCode = code;
				// Only a rate limit answered by the provider doubles the backoff; the local cooldown that
				// follows such an answer (no request sent) must not compound it.
				if (code === "RATE_LIMIT" && !(error instanceof ClaudeUsageCooldownError)) {
					throttle.backoff = Math.min(throttle.backoff * 2, QUOTA_MAX_BACKOFF_FACTOR);
				}
			} finally {
				clearTimeout(deadline);
				if (entry.abort === controller) delete entry.abort;
				throttle.nextAutoAt = now + QUOTA_AUTO_REFRESH_MS * throttle.backoff;
				if (entry.flight === flight) delete entry.flight;
			}
		})();
		entry.flight = flight;
		return flight;
	}

	/** Waits for the reads, but at most `timeoutMs` and never past `signal`; the reads themselves go on. */
	private async waitFor(flights: readonly Promise<void>[], signal?: AbortSignal, timeoutMs?: number): Promise<void> {
		if (flights.length === 0) return;
		const all = Promise.all(flights).then(() => undefined);
		if (signal === undefined && timeoutMs === undefined) return all;
		await new Promise<void>((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const done = (): void => {
				if (timer !== undefined) clearTimeout(timer);
				signal?.removeEventListener("abort", done);
				resolve();
			};
			if (signal?.aborted) return done();
			if (timeoutMs !== undefined) timer = setTimeout(done, timeoutMs);
			signal?.addEventListener("abort", done, { once: true });
			void all.then(done);
		});
	}

	private syncSchedule(): void {
		const config = this.options.current();
		const wanted =
			!this.disposed && this.registrar !== undefined && config.enabled && config.usageEnabled && this.state === "ready";
		if (!wanted) {
			this.stopSchedule();
			return;
		}
		const starting = this.timer === undefined;
		if (starting) {
			const timer = setInterval(() => this.tick(), QUOTA_AUTO_REFRESH_MS);
			(timer as { unref?: () => void }).unref?.();
			this.timer = timer;
			this.nextTickAt = Date.now() + QUOTA_AUTO_REFRESH_MS;
		}
		// Startup (or re-enable): every route, subject to the minimal delay. Later reconciles: only routes never read.
		this.autoRead(starting ? "all" : "unattempted");
	}
	private stopSchedule(): void {
		if (this.timer !== undefined) clearInterval(this.timer);
		this.timer = undefined;
	}
	private tick(): void {
		if (this.disposed || !this.options.current().usageEnabled) {
			this.stopSchedule();
			return;
		}
		this.nextTickAt = Date.now() + QUOTA_AUTO_REFRESH_MS;
		this.autoRead("due");
	}
	private autoRead(scope: "all" | "unattempted" | "due"): void {
		const now = Date.now();
		for (const [id, entry] of this.entries) {
			if (scope === "unattempted" && entry.throttle.lastAttemptAt !== undefined) continue;
			const next = entry.throttle.nextAutoAt;
			if (scope === "due" && next !== undefined && now + TICK_TOLERANCE_MS < next) continue;
			void this.startRead(id, entry);
		}
	}

	/**
	 * Explicit read of one route or all. Reads are never closer than the minimal delay per route
	 * (including timer reads): a throttled route simply keeps its current snapshot. `timeoutMs` bounds
	 * the wait, not the read. `onlyIfNeeded` skips routes that are fresh (or unsupported/unknown).
	 * No network happens in snapshots or prompt assembly; only this method and the timer read quotas.
	 */
	async refreshUsage(
		route?: string,
		signal?: AbortSignal,
		options: { timeoutMs?: number; onlyIfNeeded?: boolean } = {},
	): Promise<ReturnType<AccountRoutingRuntime["snapshot"]>> {
		if (!this.options.current().usageEnabled) throw new LlmError("Account quota reads are disabled", "INVALID_ARGS");
		const selected = [...this.entries.entries()].filter(([id]) => route === undefined || id === route);
		if (route !== undefined && selected.length === 0)
			throw new LlmError("Account route is unavailable", "INVALID_ARGS");
		const now = Date.now();
		const flights: Promise<void>[] = [];
		for (const [id, entry] of selected) {
			if (options.onlyIfNeeded === true) {
				const state = this.quotaState(entry, true, now);
				const fetchedAt = entry.usage?.cached()?.fetchedAt;
				const aged = fetchedAt !== undefined && now - fetchedAt >= QUOTA_TOOL_REFRESH_AFTER_MS;
				if (state !== "not-read" && state !== "stale" && state !== "error" && !(state === "fresh" && aged)) continue;
			}
			const flight = this.startRead(id, entry);
			if (flight !== undefined) flights.push(flight);
		}
		await this.waitFor(flights, signal, options.timeoutMs);
		return this.snapshot();
	}
}
