import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountBoundAdapter } from "../src/account-adapter.ts";
import { QUOTA_MAX_BACKOFF_FACTOR, QUOTA_READ_TIMEOUT_MS } from "../src/account-quota.ts";
import { AccountRouteRegistry } from "../src/account-routes.ts";
import { type AccountAdapterRegistrar, AccountRoutingRuntime } from "../src/account-runtime.ts";
import { CODEX_PI_PROVIDER } from "../src/ids.ts";
import { CLAUDE_CODE_OAUTH_PROVIDER, CODEX_OAUTH_PROVIDER } from "../src/oauth-providers.ts";
import { OAuthProviderSession } from "../src/oauth-session.ts";
import { readRoutingConfig } from "../src/routing-config.ts";
import { OAuthCredentialFileStore } from "../src/store.ts";
import { createHostLikeRegistrar } from "./account-host.ts";

const MIN = 60_000;
// Captured before faking: real waits let the (real) file-store operations settle while the clock is fake.
const realSetTimeout = globalThis.setTimeout;
const realSleep = (ms: number): Promise<void> => new Promise((resolve) => realSetTimeout(resolve, ms));
async function until(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 400 && !condition(); attempt += 1) await realSleep(5);
	expect(condition()).toBe(true);
}

/** Intervals created and not yet cleared through the (fake) global timer functions. */
function watchIntervals() {
	const created = vi.spyOn(globalThis, "setInterval");
	const cleared = vi.spyOn(globalThis, "clearInterval");
	return {
		active: () =>
			created.mock.results.filter((result) => !cleared.mock.calls.some((call) => call[0] === result.value)).length,
	};
}

const dirs: string[] = [];
const runtimes: AccountRoutingRuntime[] = [];
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
});
afterEach(async () => {
	for (const runtime of runtimes.splice(0)) runtime.dispose();
	// Spies (setInterval watchers, prototype stubs) first, so useRealTimers restores the genuine timers.
	vi.restoreAllMocks();
	vi.useRealTimers();
	for (const dir of dirs.splice(0)) {
		if (!dir.startsWith(join(tmpdir(), "dsh-account-quota-"))) throw new Error("Unexpected cleanup target");
		await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}
});

const CLAUDE_OK = () =>
	new Response(JSON.stringify({ five_hour: { utilization: 73 }, seven_day: { utilization: 40 } }));
const CODEX_OK = () =>
	new Response(
		JSON.stringify({
			rate_limit: {
				primary_window: { used_percent: 20, limit_window_seconds: 18_000, reset_at: 1_700_000_100 },
				secondary_window: { used_percent: 50, limit_window_seconds: 604_800 },
			},
		}),
		{ headers: { "content-type": "application/json" } },
	);

async function setup(options: { family?: "claude" | "codex"; usage?: boolean; enabled?: boolean } = {}) {
	const family = options.family ?? "claude";
	const home = await mkdtemp(join(tmpdir(), "dsh-account-quota-"));
	dirs.push(home);
	const store = new OAuthCredentialFileStore(
		family === "claude" ? "anthropic" : CODEX_PI_PROVIDER,
		join(home, "auth.json"),
		"fixture",
	);
	for (const id of ["account-a", "account-b"])
		await store.upsertAccount({
			id,
			credential: {
				type: "oauth",
				access: `fixture-${id}`,
				refresh: `fixture-refresh-${id}`,
				expires: Date.now() + 86_400_000,
				...(family === "codex" ? { accountId: `chatgpt-${id}` } : {}),
			},
		});
	const session = new OAuthProviderSession(
		family === "claude" ? CLAUDE_CODE_OAUTH_PROVIDER : CODEX_OAUTH_PROVIDER,
		undefined,
		store,
		join(home, "models.json"),
	);
	const current = {
		...readRoutingConfig(undefined),
		enabled: options.enabled ?? true,
		usageEnabled: options.usage ?? true,
	};
	const fetchImpl = vi.fn<typeof fetch>(async () => (family === "claude" ? CLAUDE_OK() : CODEX_OK()));
	const runtime = new AccountRoutingRuntime({
		registry: new AccountRouteRegistry(join(home, "routes.json")),
		sessions: [session],
		current: () => current,
		resolveAttachments: () => undefined,
		fetchImpl,
	});
	runtimes.push(runtime);
	const { register } = createHostLikeRegistrar();
	const states = () => runtime.snapshot().accounts.map((row) => row.quota.state);
	return { runtime, current, fetchImpl, register, states, session };
}
/** attach() reconciles by itself; a second concurrent reconcile would contend for the (fake-timer) file lock. */
async function start(runtime: AccountRoutingRuntime, register: AccountAdapterRegistrar) {
	const detach = runtime.attach(register);
	await until(() => runtime.snapshot().state === "ready");
	return detach;
}
const tooFast =
	(code: number, headers: Record<string, string> = {}) =>
	async () =>
		new Response("", { status: code, headers });

describe("automatic quota reads", () => {
	it("reads every route at startup, then every 15 minutes, and cleans its timer on dispose", async () => {
		const { runtime, fetchImpl, register, states } = await setup();
		const intervals = watchIntervals();
		const detach = await start(runtime, register);
		await until(() => states().every((state) => state === "fresh"));
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(intervals.active()).toBe(1);
		const started = Date.now();
		await vi.advanceTimersByTimeAsync(14 * MIN);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(MIN);
		await until(() => fetchImpl.mock.calls.length === 4);
		await until(() => runtime.snapshot().accounts.every((row) => (row.quota.fetchedAt ?? 0) >= started + 15 * MIN));
		const next = runtime.snapshot().accounts[0]!.quota.nextRefreshAt!;
		expect(next).toBeGreaterThan(Date.now() + 14 * MIN);
		expect(next).toBeLessThanOrEqual(Date.now() + 15 * MIN);
		detach();
		expect(intervals.active()).toBe(0);
		runtime.dispose();
		await vi.advanceTimersByTimeAsync(60 * MIN);
		expect(fetchImpl).toHaveBeenCalledTimes(4);
	});

	it("never reads (no timer, no call) while quota reads or routing are off, and follows live toggles", async () => {
		const { runtime, current, fetchImpl, register, states } = await setup({ usage: false });
		const intervals = watchIntervals();
		await start(runtime, register);
		expect(states()).toEqual(["disabled", "disabled"]);
		await vi.advanceTimersByTimeAsync(60 * MIN);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(intervals.active()).toBe(0);
		current.usageEnabled = true;
		await runtime.reconcile();
		await until(() => states().every((state) => state === "fresh"));
		expect(intervals.active()).toBe(1);
		current.usageEnabled = false;
		await runtime.reconcile();
		expect(intervals.active()).toBe(0);
		expect(states()).toEqual(["disabled", "disabled"]);
		const calls = fetchImpl.mock.calls.length;
		await vi.advanceTimersByTimeAsync(60 * MIN);
		expect(fetchImpl.mock.calls.length).toBe(calls);
		current.enabled = false;
		current.usageEnabled = true;
		await runtime.reconcile();
		expect(runtime.snapshot()).toEqual({ state: "disabled", accounts: [] });
		expect(intervals.active()).toBe(0);
	});

	it("a manual read closer than 60 s to the previous attempt keeps the snapshot, with no call and no error", async () => {
		const { runtime, fetchImpl, register, states } = await setup();
		fetchImpl.mockImplementation(tooFast(500));
		await start(runtime, register);
		await until(() => states().every((state) => state === "error"));
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(30_000);
		const throttled = await runtime.refreshUsage();
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(throttled.accounts.map((row) => [row.quota.state, row.quota.errorCode])).toEqual([
			["error", "SERVER"],
			["error", "SERVER"],
		]);
		await vi.advanceTimersByTimeAsync(31_000);
		fetchImpl.mockImplementation(async () => CLAUDE_OK());
		await runtime.refreshUsage();
		expect(fetchImpl).toHaveBeenCalledTimes(4);
		expect(states()).toEqual(["fresh", "fresh"]);
		expect(runtime.snapshot().accounts[0]!.quota.errorCode).toBeUndefined();
	});

	it("doubles the delay after each RATE_LIMIT and resumes the normal cadence after one successful read", async () => {
		const { runtime, fetchImpl, register, states } = await setup();
		fetchImpl.mockImplementation(tooFast(429, { "retry-after": "1" }));
		await start(runtime, register);
		await until(() => states().every((state) => state === "error"));
		expect(runtime.snapshot().accounts[0]!.quota.errorCode).toBe("RATE_LIMIT");
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		// Backoff x2: manual reads need 120 s, not 60 s.
		await vi.advanceTimersByTimeAsync(61_000);
		await runtime.refreshUsage();
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(60_000);
		await runtime.refreshUsage();
		expect(fetchImpl).toHaveBeenCalledTimes(4); // second 429: x4 now, so the next automatic read is ~60 min away
		// Ticks at 15/30/45/60 min are skipped.
		fetchImpl.mockImplementation(async () => CLAUDE_OK());
		await vi.advanceTimersByTimeAsync(59 * MIN);
		expect(fetchImpl).toHaveBeenCalledTimes(4);
		await vi.advanceTimersByTimeAsync(13 * MIN + 59_000); // lands exactly on the 75 min tick
		await until(() => states().every((state) => state === "fresh"));
		expect(fetchImpl).toHaveBeenCalledTimes(6);
		// A good read resets the factor: the following tick reads again 15 minutes later.
		await vi.advanceTimersByTimeAsync(15 * MIN);
		await until(() => fetchImpl.mock.calls.length === 8);
	});

	it("joins a read already in flight (no overlap) and bounds the wait without cancelling the read", async () => {
		const { runtime, fetchImpl, register, states } = await setup();
		fetchImpl.mockImplementation(() => new Promise<Response>(() => undefined));
		await start(runtime, register);
		await until(() => fetchImpl.mock.calls.length === 2);
		let waited = false;
		const pending = runtime.refreshUsage(undefined, undefined, { timeoutMs: 8_000 }).then((snapshot) => {
			waited = true;
			return snapshot;
		});
		await vi.advanceTimersByTimeAsync(7_000);
		expect(waited).toBe(false);
		await vi.advanceTimersByTimeAsync(1_000);
		await pending;
		expect(waited).toBe(true);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(states()).toEqual(["not-read", "not-read"]);
		// The read keeps its own deadline: it ends as an error without any caller waiting for it.
		await vi.advanceTimersByTimeAsync(20_000);
		await until(() => states().every((state) => state === "error"));
		expect(runtime.snapshot().accounts[0]!.quota.errorCode).toBe("TIMEOUT");
	});

	it("an aborted caller stops waiting without an error", async () => {
		const { runtime, fetchImpl, register } = await setup();
		fetchImpl.mockImplementation(() => new Promise<Response>(() => undefined));
		await start(runtime, register);
		await until(() => fetchImpl.mock.calls.length === 2);
		const controller = new AbortController();
		const pending = runtime.refreshUsage(undefined, controller.signal);
		controller.abort();
		await expect(pending).resolves.toMatchObject({ state: "ready" });
	});

	it("reports 'unknown' with errorCode NO_WINDOWS when the response has no usable window", async () => {
		const { runtime, fetchImpl, register, states } = await setup();
		fetchImpl.mockImplementation(async () => new Response(JSON.stringify({ five_hour: { utilization: null } })));
		await start(runtime, register);
		await until(() => states().every((state) => state === "unknown"));
		const quota = runtime.snapshot().accounts[0]!.quota;
		expect(quota).toMatchObject({ state: "unknown", windows: [], errorCode: "NO_WINDOWS" });
		expect(quota.fetchedAt).toBeDefined();
	});

	it("stays fresh between two automatic reads, and is stale only after 20 minutes", async () => {
		const { runtime, register, states } = await setup();
		await start(runtime, register);
		await until(() => states().every((state) => state === "fresh"));
		// Move the clock only (no timer fires, no read in flight can expire artificially).
		vi.setSystemTime(Date.now() + 14 * MIN);
		expect(states()).toEqual(["fresh", "fresh"]);
		vi.setSystemTime(Date.now() + 7 * MIN); // 21 minutes after the reading
		expect(states()).toEqual(["stale", "stale"]);
	});

	it("refreshUsage(onlyIfNeeded) reads only routes that are not-read, in error, stale or older than 5 minutes", async () => {
		const { runtime, current, fetchImpl, register, states } = await setup({ usage: false });
		await start(runtime, register);
		current.usageEnabled = true; // no reconcile: the timer is not started, routes stay not-read
		expect(states()).toEqual(["not-read", "not-read"]);
		await runtime.refreshUsage(undefined, undefined, { onlyIfNeeded: true });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(states()).toEqual(["fresh", "fresh"]);
		await vi.advanceTimersByTimeAsync(2 * MIN);
		await runtime.refreshUsage(undefined, undefined, { onlyIfNeeded: true });
		expect(fetchImpl).toHaveBeenCalledTimes(2); // fresh: skipped
		await vi.advanceTimersByTimeAsync(4 * MIN);
		await runtime.refreshUsage(undefined, undefined, { onlyIfNeeded: true });
		expect(fetchImpl).toHaveBeenCalledTimes(4); // still "fresh" for display, but older than the tool's 5 minutes
	});

	it("never touches the network from snapshot()", async () => {
		const { runtime, current, fetchImpl, register } = await setup({ usage: false });
		await start(runtime, register);
		current.usageEnabled = true;
		for (let index = 0; index < 5; index += 1) runtime.snapshot();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("caps the RATE_LIMIT backoff at x8", async () => {
		const { runtime, fetchImpl, register, states } = await setup();
		fetchImpl.mockImplementation(tooFast(429, { "retry-after": "1" }));
		await start(runtime, register);
		await until(() => states().every((state) => state === "error"));
		// Backoff after each answered 429: x2, x4, x8, then still x8 (not x16).
		for (const wait of [121, 241, 481]) {
			await vi.advanceTimersByTimeAsync(wait * 1000);
			await runtime.refreshUsage();
		}
		expect(fetchImpl).toHaveBeenCalledTimes(8);
		expect(QUOTA_MAX_BACKOFF_FACTOR).toBe(8);
		const next = runtime.snapshot().accounts[0]!.quota.nextRefreshAt!;
		expect(next).toBeGreaterThan(Date.now() + 110 * MIN);
		expect(next).toBeLessThanOrEqual(Date.now() + 135 * MIN); // 8 x 15 min plus one tick of alignment, never 16 x 15
	});

	it("does not double the backoff when the 429 is the local cooldown (no request sent)", async () => {
		const { runtime, fetchImpl, register, states } = await setup();
		fetchImpl.mockImplementation(tooFast(429, { "retry-after": "300" }));
		await start(runtime, register);
		await until(() => states().every((state) => state === "error"));
		expect(fetchImpl).toHaveBeenCalledTimes(2); // one real 429 per account: backoff x2
		await vi.advanceTimersByTimeAsync(121_000);
		const answered = await runtime.refreshUsage(); // the 5 minute cooldown answers locally
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(answered.accounts[0]!.quota.errorCode).toBe("RATE_LIMIT");
		// Still x2 (30 min), not x4 (60 min): the next automatic read is at most one tick after 30 minutes.
		expect(answered.accounts[0]!.quota.nextRefreshAt!).toBeLessThanOrEqual(Date.now() + 45 * MIN);
	});

	it("keeps the delay and the backoff across a disable/re-enable of routing", async () => {
		const { runtime, current, fetchImpl, register, states } = await setup();
		fetchImpl.mockImplementation(tooFast(429, { "retry-after": "1" }));
		await start(runtime, register);
		await until(() => states().every((state) => state === "error"));
		expect(fetchImpl).toHaveBeenCalledTimes(2); // backoff x2: 120 s between reads
		current.enabled = false;
		await runtime.reconcile();
		expect(runtime.snapshot().accounts).toEqual([]);
		current.enabled = true;
		await runtime.reconcile();
		await vi.advanceTimersByTimeAsync(61_000);
		await runtime.refreshUsage();
		expect(fetchImpl).toHaveBeenCalledTimes(2); // neither the restart nor a manual read bypasses the backoff
		await vi.advanceTimersByTimeAsync(60_000);
		await runtime.refreshUsage();
		expect(fetchImpl).toHaveBeenCalledTimes(4);
	});

	it("keeps the minimal delay across a detach/re-attach of the LLM service", async () => {
		const { runtime, fetchImpl, register, states } = await setup();
		fetchImpl.mockImplementation(tooFast(500));
		const detach = await start(runtime, register);
		await until(() => states().every((state) => state === "error"));
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		detach();
		await vi.advanceTimersByTimeAsync(10_000);
		await start(runtime, register);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(fetchImpl).toHaveBeenCalledTimes(2); // the startup read of the new attachment is throttled
		await vi.advanceTimersByTimeAsync(41_000);
		await runtime.refreshUsage();
		expect(fetchImpl).toHaveBeenCalledTimes(4);
	});

	it("aborts the read in flight when the LLM service detaches, and ignores its late result", async () => {
		const { runtime, fetchImpl, register } = await setup();
		const signals: AbortSignal[] = [];
		let late!: (response: Response) => void;
		fetchImpl.mockImplementation((_url, init) => {
			signals.push(init!.signal as AbortSignal);
			return new Promise<Response>((resolve) => {
				late = resolve;
			});
		});
		const detach = await start(runtime, register);
		await until(() => signals.length === 2);
		expect(signals.every((signal) => !signal.aborted)).toBe(true);
		detach();
		expect(signals.every((signal) => signal.aborted)).toBe(true);
		late(CLAUDE_OK());
		await vi.advanceTimersByTimeAsync(0);
		expect(runtime.snapshot()).toEqual({ state: "waiting-for-llm", accounts: [] });
	});

	it("aborts the read in flight on dispose", async () => {
		const { runtime, fetchImpl, register } = await setup();
		const signals: AbortSignal[] = [];
		fetchImpl.mockImplementation((_url, init) => {
			signals.push(init!.signal as AbortSignal);
			return new Promise<Response>(() => undefined);
		});
		await start(runtime, register);
		await until(() => signals.length === 2);
		runtime.dispose();
		expect(signals.every((signal) => signal.aborted)).toBe(true);
	});

	it.each(["claude", "codex"] as const)(
		"%s: a token resolution that never settles is abandoned at the hard 20 s deadline",
		async (family) => {
			const { runtime, fetchImpl, register, states } = await setup({ family });
			vi.spyOn(AccountBoundAdapter.prototype, "resolveAccess").mockImplementation(() => new Promise(() => undefined));
			await start(runtime, register);
			await vi.advanceTimersByTimeAsync(QUOTA_READ_TIMEOUT_MS - 1_000);
			expect(states()).toEqual(["not-read", "not-read"]);
			await vi.advanceTimersByTimeAsync(1_000);
			await until(() => states().every((state) => state === "error"));
			expect(runtime.snapshot().accounts[0]!.quota.errorCode).toBe("TIMEOUT");
			expect(fetchImpl).not.toHaveBeenCalled();
		},
	);

	it("a hung read does not hold an HTTP-style bounded wait longer than asked, nor the next read afterwards", async () => {
		const { runtime, register, states } = await setup();
		vi.spyOn(AccountBoundAdapter.prototype, "resolveAccess").mockImplementation(() => new Promise(() => undefined));
		await start(runtime, register);
		const waited = runtime.refreshUsage(undefined, undefined, { timeoutMs: 25_000 });
		await vi.advanceTimersByTimeAsync(20_000);
		await waited; // joined the hung flights, which ended at their own 20 s deadline
		await until(() => states().every((state) => state === "error"));
		expect(runtime.snapshot().state).toBe("ready");
	});
});

describe("Codex account quotas", () => {
	it("reads the 5 h and weekly windows of each Codex route with its own account id", async () => {
		const { runtime, fetchImpl, register, states } = await setup({ family: "codex" });
		await start(runtime, register);
		await until(() => states().every((state) => state === "fresh"));
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		const headers = fetchImpl.mock.calls.map((call) => call[1]!.headers as Record<string, string>);
		expect(headers.map((row) => row["chatgpt-account-id"]).sort()).toEqual(["chatgpt-account-a", "chatgpt-account-b"]);
		expect(headers.map((row) => row.authorization).sort()).toEqual([
			"Bearer fixture-account-a",
			"Bearer fixture-account-b",
		]);
		expect(fetchImpl.mock.calls[0]![0]).toBe("https://chatgpt.com/backend-api/wham/usage");
		const quota = runtime.snapshot().accounts[0]!.quota;
		expect(quota.windows).toEqual([
			{ id: "five_hour", usedPercent: 20, remainingPercent: 80, windowSeconds: 18_000, resetsAt: 1_700_000_100_000 },
			{ id: "seven_day", usedPercent: 50, remainingPercent: 50, windowSeconds: 604_800 },
		]);
		expect(JSON.stringify(runtime.snapshot())).not.toContain("fixture-account");
	});

	it("follows the same rules: unknown without a usable window, then a failed read keeps it stale with a code", async () => {
		const { runtime, fetchImpl, register, states } = await setup({ family: "codex" });
		fetchImpl.mockImplementation(
			async () =>
				new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 60 } } })),
		);
		await start(runtime, register);
		await until(() => states().every((state) => state === "unknown"));
		expect(runtime.snapshot().accounts[0]!.quota.errorCode).toBe("NO_WINDOWS");
		await vi.advanceTimersByTimeAsync(2 * MIN);
		fetchImpl.mockImplementation(async () => new Response("", { status: 403 }));
		await runtime.refreshUsage();
		expect(fetchImpl).toHaveBeenCalledTimes(4);
		expect(runtime.snapshot().accounts.map((row) => [row.quota.state, row.quota.errorCode])).toEqual([
			["stale", "PERMISSION"],
			["stale", "PERMISSION"],
		]);
	});

	it("marks the rejected token expired on a 401 so the single retry uses a refreshed one", async () => {
		const { runtime, fetchImpl, register, states } = await setup({ family: "codex" });
		let issued = 0;
		vi.spyOn(AccountBoundAdapter.prototype, "resolveAccess").mockImplementation(async () => {
			issued += 1;
			return {
				accessToken: `fixture-token-${String(issued)}`,
				generation: `g${String(issued)}`,
				accountId: "chatgpt-x",
			};
		});
		const invalidate = vi.spyOn(AccountBoundAdapter.prototype, "invalidateAccess").mockResolvedValue(undefined);
		let calls = 0;
		fetchImpl.mockImplementation(async () => (++calls === 1 ? new Response("", { status: 401 }) : CODEX_OK()));
		await start(runtime, register);
		await until(() => states().every((state) => state === "fresh"));
		const bearer = fetchImpl.mock.calls.map((call) => (call[1]!.headers as Record<string, string>).authorization);
		expect(bearer).toHaveLength(3); // two accounts, one of them retried once
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(invalidate).toHaveBeenCalledWith(bearer[0]!.replace("Bearer ", "")); // exactly the rejected token
		expect(new Set(bearer).size).toBe(3); // the retry did not replay the rejected token
	});

	it("exposes no account identifier (ChatGPT account id included) in the snapshot", async () => {
		const { runtime, register, states } = await setup({ family: "codex" });
		await start(runtime, register);
		await until(() => states().every((state) => state === "fresh"));
		const snapshot = runtime.snapshot();
		let text = JSON.stringify(snapshot);
		for (const row of snapshot.accounts) text = text.split(row.route).join("");
		for (const forbidden of ["chatgpt-", "account-a", "account-b", "fixture"]) expect(text).not.toContain(forbidden);
		expect(text).not.toMatch(/[0-9a-f]{16,}/iu);
	});
});
