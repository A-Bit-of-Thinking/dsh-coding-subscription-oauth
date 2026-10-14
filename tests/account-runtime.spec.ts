import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmAdapter } from "@deepseek-ai/dsh-llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountRouteRegistry } from "../src/account-routes.ts";
import { AccountRoutingRuntime } from "../src/account-runtime.ts";
import { CLAUDE_CODE_OAUTH_PROVIDER } from "../src/oauth-providers.ts";
import { OAuthProviderSession } from "../src/oauth-session.ts";
import { type RoutingConfig, readRoutingConfig } from "../src/routing-config.ts";
import { OAuthCredentialFileStore } from "../src/store.ts";

const dirs: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) {
		if (!dir.startsWith(join(tmpdir(), "dsh-account-runtime-"))) throw new Error("Unexpected cleanup target");
		// attach() starts its own background reconciliation, which may still be writing the alias sidecar.
		await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}
});
async function fixture(enabled = true) {
	const home = await mkdtemp(join(tmpdir(), "dsh-account-runtime-"));
	dirs.push(home);
	const store = new OAuthCredentialFileStore("anthropic", join(home, "auth.json"), "fixture");
	for (const id of ["account-a", "account-b"])
		await store.upsertAccount({
			id,
			credential: {
				type: "oauth",
				access: `fixture-${id}`,
				refresh: `fixture-refresh-${id}`,
				expires: Date.now() + 3_600_000,
			},
		});
	const session = new OAuthProviderSession(CLAUDE_CODE_OAUTH_PROVIDER, undefined, store, join(home, "models.json"));
	const current: RoutingConfig = { ...readRoutingConfig(undefined), enabled };
	const fetchImpl = vi.fn(
		async () => new Response(JSON.stringify({ five_hour: { utilization: 73 }, seven_day: { utilization: 40 } })),
	);
	const filename = join(home, "routes.json");
	// Legacy-only configuration must never alter the fixed-account retry policy.
	const options = {
		registry: new AccountRouteRegistry(filename),
		sessions: [session],
		current: () => current,
		resolveAttachments: () => undefined,
		fetchImpl,
		retryPolicy: { mode: "always" as const, maxRetries: 5, retryableCodes: ["RATE_LIMIT"] },
	};
	const runtime = new AccountRoutingRuntime(options);
	const registered = new Map<string, LlmAdapter>([
		["codex-oauth-fast", {} as LlmAdapter],
		["claude-code-oauth", {} as LlmAdapter],
	]);
	const register = vi.fn((routes: string[], adapter: LlmAdapter) => {
		for (const route of routes) registered.set(route, adapter);
		return () => {
			for (const route of routes) if (registered.get(route) === adapter) registered.delete(route);
		};
	});
	return { runtime, current, store, register, registered, fetchImpl, filename };
}

describe("fixed account runtime", () => {
	it("default-off does not generate metadata, register accounts or fetch quotas", async () => {
		const { runtime, register, fetchImpl, filename } = await fixture(false);
		const detach = runtime.attach(register);
		await runtime.reconcile();
		expect(runtime.snapshot()).toEqual({ state: "disabled", accounts: [] });
		expect(register).not.toHaveBeenCalled();
		expect(fetchImpl).not.toHaveBeenCalled();
		await expect(stat(filename)).rejects.toMatchObject({ code: "ENOENT" });
		detach();
		runtime.dispose();
	});
	it("publishes both routes without replacing legacy/Fast and withdraws only its registrations", async () => {
		const { runtime, register, registered } = await fixture();
		const detach = runtime.attach(register);
		await runtime.reconcile();
		const snapshot = runtime.snapshot();
		expect(snapshot.state).toBe("ready");
		expect(snapshot.accounts).toHaveLength(2);
		expect(registered.size).toBe(4);
		for (const row of snapshot.accounts)
			expect(registered.get(row.route)!.providerRetryPolicy(row.route)).toMatchObject({
				maxRetries: 1,
				retryableCodes: ["AUTH"],
			});
		expect(JSON.stringify(snapshot)).not.toContain('"account-a"');
		for (const row of snapshot.accounts) expect(Object.keys(row).sort()).toEqual(["family", "quota", "route", "slot"]);
		expect(JSON.stringify(snapshot)).not.toContain("fixture-");
		detach();
		expect(runtime.snapshot()).toEqual({ state: "waiting-for-llm", accounts: [] });
		expect([...registered.keys()]).toEqual(["codex-oauth-fast", "claude-code-oauth"]);
		runtime.dispose();
	});
	it("keeps aliases after reconciliation, removes disconnected accounts, and disables cleanly", async () => {
		const { runtime, current, store, register, registered } = await fixture();
		runtime.attach(register);
		await runtime.reconcile();
		const original = runtime.snapshot().accounts.map((row) => row.route);
		await runtime.reconcile();
		expect(runtime.snapshot().accounts.map((row) => row.route)).toEqual(original);
		await store.removeAccount("account-a");
		await runtime.reconcile();
		expect(runtime.snapshot().accounts.map((row) => row.route)).toEqual([original[1]]);
		current.enabled = false;
		await runtime.reconcile();
		expect(runtime.snapshot().state).toBe("disabled");
		expect(registered.size).toBe(2);
		runtime.dispose();
	});
	it("never fetches from snapshots and reads each account only after quota opt-in", async () => {
		const { runtime, current, register, fetchImpl } = await fixture();
		runtime.attach(register);
		await runtime.reconcile();
		runtime.snapshot();
		expect(fetchImpl).not.toHaveBeenCalled();
		await expect(runtime.refreshUsage()).rejects.toMatchObject({ code: "INVALID_ARGS" });
		current.usageEnabled = true;
		expect(runtime.snapshot().accounts.every((row) => row.quota.state === "unknown")).toBe(true);
		const snapshot = await runtime.refreshUsage();
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(snapshot.accounts.every((row) => row.quota.state === "fresh")).toBe(true);
		expect(snapshot.accounts[0]?.quota.windows[0]?.usedPercent).toBe(73);
		const tokens = fetchImpl.mock.calls.map(
			(call) => (call as unknown as [string, RequestInit])[1].headers as Record<string, string>,
		);
		expect(tokens.map((headers) => headers.authorization).sort()).toEqual([
			"Bearer fixture-account-a",
			"Bearer fixture-account-b",
		]);
		await runtime.refreshUsage();
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		current.usageEnabled = false;
		expect(runtime.snapshot().accounts.every((row) => row.quota.windows.length === 0)).toBe(true);
		runtime.dispose();
	});
	it("late quota results from disposed routes cannot populate replacement snapshots", async () => {
		const { runtime, current, store, register, fetchImpl } = await fixture();
		current.usageEnabled = true;
		let release!: (response: Response) => void;
		fetchImpl.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		runtime.attach(register);
		await runtime.reconcile();
		const route = runtime.snapshot().accounts[0]!.route;
		const pending = runtime.refreshUsage(route);
		await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
		await store.removeAccount("account-a");
		await runtime.reconcile();
		release(new Response(JSON.stringify({ five_hour: { utilization: 99 } })));
		await pending;
		const after = runtime.snapshot().accounts;
		expect(after).toHaveLength(1);
		expect(after[0]!.route).not.toBe(route);
		expect(after[0]!.quota.windows.some((window) => window.usedPercent === 99)).toBe(false);
		runtime.dispose();
	});
	it("a no-op reconcile keeps the same adapters so requests in flight are never withdrawn", async () => {
		const { runtime, register, registered } = await fixture();
		runtime.attach(register);
		await runtime.reconcile();
		const routes = runtime.snapshot().accounts.map((row) => row.route);
		const adapters = routes.map((route) => registered.get(route));
		const calls = register.mock.calls.length;
		await runtime.reconcile();
		await runtime.reconcile();
		expect(register.mock.calls.length).toBe(calls);
		expect(routes.map((route) => registered.get(route))).toEqual(adapters);
		expect(runtime.snapshot().state).toBe("ready");
		runtime.dispose();
	});
	it("a transient storage error keeps validated routes, reports error, and recovers", async () => {
		const { runtime, store, register, registered } = await fixture();
		runtime.attach(register);
		await runtime.reconcile();
		const routes = runtime.snapshot().accounts.map((row) => row.route);
		vi.spyOn(store, "listAccounts").mockRejectedValueOnce(new Error("storage read failed"));
		await runtime.reconcile();
		expect(runtime.snapshot().state).toBe("error");
		expect(runtime.snapshot().accounts.map((row) => row.route)).toEqual(routes);
		for (const route of routes) expect(registered.has(route)).toBe(true);
		await runtime.reconcile();
		expect(runtime.snapshot().state).toBe("ready");
		runtime.dispose();
	});
});
