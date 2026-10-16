import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerateOptions, LlmAdapter } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountRenameError, modelFacingAccounts } from "../src/account-names.ts";
import { AccountRouteRegistry } from "../src/account-routes.ts";
import { AccountRoutingRuntime } from "../src/account-runtime.ts";
import { CLAUDE_CODE_OAUTH_PROVIDER } from "../src/oauth-providers.ts";
import { OAuthProviderSession } from "../src/oauth-session.ts";
import { type RoutingConfig, readRoutingConfig } from "../src/routing-config.ts";
import { OAuthCredentialFileStore } from "../src/store.ts";
import { createHostLikeRegistrar } from "./account-host.ts";

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
	const onLegacyDisplayChange = vi.fn();
	// Legacy-only configuration must never alter the fixed-account retry policy.
	const options = {
		registry: new AccountRouteRegistry(filename),
		sessions: [session],
		current: () => current,
		resolveAttachments: () => undefined,
		fetchImpl,
		onLegacyDisplayChange,
		retryPolicy: { mode: "always" as const, maxRetries: 5, retryableCodes: ["RATE_LIMIT"] },
	};
	const runtime = new AccountRoutingRuntime(options);
	const { register, registered, hostNames, replaces } = createHostLikeRegistrar({
		"codex-oauth-fast": {} as LlmAdapter,
		"claude-code-oauth": {} as LlmAdapter,
	});
	return {
		runtime,
		current,
		store,
		register,
		registered,
		hostNames,
		replaces,
		fetchImpl,
		filename,
		onLegacyDisplayChange,
		session,
	};
}
const credential = (id: string) => ({
	type: "oauth" as const,
	access: `fixture-${id}`,
	refresh: `fixture-refresh-${id}`,
	expires: Date.now() + 3_600_000,
});
function rows(runtime: AccountRoutingRuntime) {
	return runtime.snapshot().accounts.map(({ name, label, isDefault }) => ({ name, label, isDefault }));
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
		for (const row of snapshot.accounts)
			expect(Object.keys(row).sort()).toEqual(["family", "isDefault", "label", "name", "quota", "route"]);
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
		expect(runtime.snapshot().accounts.every((row) => row.quota.state === "not-read")).toBe(true);
		expect(runtime.snapshot().accounts.every((row) => row.quota.windows.length === 0)).toBe(true);
		expect(fetchImpl).not.toHaveBeenCalled();
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
		let release!: (response: Response) => void;
		fetchImpl.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		runtime.attach(register);
		await runtime.reconcile();
		current.usageEnabled = true;
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

describe("account names, default marker and renaming", () => {
	it("falls back to 'Claude · compte N' with the default marker on the stored default account only", async () => {
		const { runtime, register } = await fixture();
		runtime.attach(register);
		await runtime.reconcile();
		expect(rows(runtime)).toEqual([
			{ name: "Claude · compte 1", label: null, isDefault: true },
			{ name: "Claude · compte 2", label: null, isDefault: false },
		]);
		expect(runtime.defaultRouteName("claude")).toBe("Claude · compte 1 (par défaut)");
		expect(JSON.stringify(runtime.snapshot())).not.toMatch(/slot/iu);
		runtime.dispose();
	});
	it("ranks among CURRENT accounts: removing one leaves no hole, whatever the old slots were", async () => {
		const { runtime, register, store } = await fixture();
		await store.upsertAccount({ id: "account-c", credential: credential("account-c") });
		runtime.attach(register);
		await runtime.reconcile();
		expect(rows(runtime).map((row) => row.name)).toEqual([
			"Claude · compte 1",
			"Claude · compte 2",
			"Claude · compte 3",
		]);
		await store.removeAccount("account-a");
		await runtime.reconcile();
		expect(rows(runtime)).toEqual([
			{ name: "Claude · compte 1", label: null, isDefault: true },
			{ name: "Claude · compte 2", label: null, isDefault: false },
		]);
		runtime.dispose();
	});
	it("uses a custom label, restores the fallback on null/empty, and never touches credentials or the active account", async () => {
		const { runtime, register, store } = await fixture();
		runtime.attach(register);
		await runtime.reconcile();
		const route = runtime.snapshot().accounts[1]!.route;
		const before = await store.readAccount("account-b", { readOnly: true });
		const renamed = await runtime.renameAccount(route, "  Perso  ");
		expect(renamed.accounts[1]).toMatchObject({ name: "Claude · Perso", label: "Perso", isDefault: false });
		expect(await store.readAccount("account-b", { readOnly: true })).toEqual(before);
		expect(await store.getActiveAccountId({ readOnly: true })).toBe("account-a");
		expect((await store.listAccounts({ readOnly: true }))[1]?.label).toBe("Perso");
		for (const cleared of [null, "", "   "]) {
			await runtime.renameAccount(route, "Autre");
			const back = await runtime.renameAccount(route, cleared);
			expect(back.accounts[1]).toMatchObject({ name: "Claude · compte 2", label: null });
		}
		expect((await store.listAccounts({ readOnly: true }))[1]).not.toHaveProperty("label");
		runtime.dispose();
	});
	it("validates labels without echoing them, and rejects unknown routes", async () => {
		const { runtime, register } = await fixture();
		runtime.attach(register);
		await runtime.reconcile();
		const route = runtime.snapshot().accounts[0]!.route;
		const canary = "CANARY_LABEL_VALUE";
		for (const bad of [`${canary}${"x".repeat(40)}`, `${canary}\u0007`, `${canary}\u202e`, 12, {}, ["a"]]) {
			const error = await runtime.renameAccount(route, bad).catch((reason: unknown) => reason);
			expect(error).toBeInstanceOf(AccountRenameError);
			expect(error).toMatchObject({ code: "invalid-label" });
			expect(String((error as Error).message)).not.toContain("CANARY");
		}
		await expect(runtime.renameAccount(route, "x".repeat(41))).rejects.toMatchObject({ code: "invalid-label" });
		await expect(runtime.renameAccount(route, "é".repeat(40))).resolves.toBeDefined();
		await expect(runtime.renameAccount("claude-code-oauth-account-unknown", "Ok")).rejects.toMatchObject({
			code: "unknown-route",
		});
		runtime.dispose();
	});
	it("hides the default account's route from listings and swaps the roles at setActive; resolveModel/stream still work", async () => {
		const { runtime, register, registered, store } = await fixture();
		runtime.attach(register);
		await runtime.reconcile();
		const [first, second] = runtime
			.snapshot()
			.accounts.map((row) => registered.get(row.route)! as unknown as LlmAdapter);
		const [routeA, routeB] = runtime.snapshot().accounts.map((row) => row.route) as [string, string];
		const model = (await second!.listModels(routeB))[0]!.id;
		expect(await first!.listModels(routeA)).toEqual([]);
		expect((await second!.listModels(routeB)).length).toBeGreaterThan(0);
		await store.setActiveAccount("account-b");
		// Immediately correct (live read), before any reconcile.
		expect((await first!.listModels(routeA)).length).toBeGreaterThan(0);
		expect(await second!.listModels(routeB)).toEqual([]);
		await runtime.reconcile();
		expect(rows(runtime).map((row) => row.isDefault)).toEqual([false, true]);
		expect(runtime.defaultRouteName("claude")).toBe("Claude · compte 2 (par défaut)");
		await expect(second!.resolveModel(routeB, model)).resolves.toMatchObject({ provider: routeB });
		vi.spyOn(PiAiAdapter.prototype, "stream").mockImplementation(async function* () {
			yield { type: "finish", reason: { kind: "stop" } };
		});
		const chunks = [];
		for await (const chunk of second!.stream({ provider: routeB, model, messages: [] } as unknown as GenerateOptions))
			chunks.push(chunk);
		expect(chunks).toEqual([{ type: "finish", reason: { kind: "stop" } }]);
		runtime.dispose();
	});
	it("re-publishes through replace (the host never re-reads names) when the default account changes", async () => {
		const { runtime, register, registered, replaces, onLegacyDisplayChange, store } = await fixture();
		runtime.attach(register);
		await runtime.reconcile();
		const [routeA, routeB] = runtime.snapshot().accounts.map((row) => row.route) as [string, string];
		const adapters = [registered.get(routeA), registered.get(routeB)];
		const registrations = register.mock.calls.length;
		// Registration alone published nothing: replace is for changes only.
		expect(replaces.get(routeA)).not.toHaveBeenCalled();
		expect(onLegacyDisplayChange).toHaveBeenCalledTimes(1); // first default name of the family
		onLegacyDisplayChange.mockClear();
		await store.setActiveAccount("account-b");
		await runtime.reconcile();
		// Hidden/shown roles swap on BOTH routes, each re-published once with its own route and the same adapter.
		expect(replaces.get(routeA)).toHaveBeenCalledTimes(1);
		expect(replaces.get(routeA)).toHaveBeenCalledWith([routeA]);
		expect(replaces.get(routeB)).toHaveBeenCalledTimes(1);
		expect(replaces.get(routeB)).toHaveBeenCalledWith([routeB]);
		expect(onLegacyDisplayChange).toHaveBeenCalledTimes(1);
		expect([registered.get(routeA), registered.get(routeB)]).toEqual(adapters);
		expect(register.mock.calls.length).toBe(registrations);
		// Nothing changed: no further publication at all.
		await runtime.reconcile();
		expect(replaces.get(routeA)).toHaveBeenCalledTimes(1);
		expect(replaces.get(routeB)).toHaveBeenCalledTimes(1);
		expect(onLegacyDisplayChange).toHaveBeenCalledTimes(1);
		runtime.dispose();
	});
	it("renames while a request is in flight: the host name changes through replace, same adapter, stream kept", async () => {
		const { runtime, register, registered, hostNames, replaces, onLegacyDisplayChange } = await fixture();
		runtime.attach(register);
		await runtime.reconcile();
		const accounts = runtime.snapshot().accounts;
		const route = accounts[1]!.route;
		const adapter = registered.get(route)! as unknown as LlmAdapter;
		expect(hostNames.get(route)).toBe("Claude · compte 2");
		const model = (await adapter.listModels(route))[0]!.id;
		let entered!: () => void;
		const enteredPromise = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.spyOn(PiAiAdapter.prototype, "stream").mockImplementation(async function* () {
			entered();
			await gate;
			yield { type: "finish", reason: { kind: "stop" } };
		});
		const calls = register.mock.calls.length;
		onLegacyDisplayChange.mockClear();
		const pending = (async () => {
			const chunks = [];
			for await (const chunk of adapter.stream({ provider: route, model, messages: [] } as unknown as GenerateOptions))
				chunks.push(chunk);
			return chunks;
		})();
		await enteredPromise;
		// Without replace the host keeps its snapshot, whatever the adapter now answers.
		await runtime.renameAccount(route, "Pendant");
		expect(adapter.providerInfo(route).name).toBe("Claude · Pendant");
		expect(replaces.get(route)).toHaveBeenCalledTimes(1);
		expect(replaces.get(route)).toHaveBeenCalledWith([route]);
		expect(hostNames.get(route)).toBe("Claude · Pendant");
		expect(registered.get(route)).toBe(adapter);
		expect(register.mock.calls.length).toBe(calls);
		expect(onLegacyDisplayChange).not.toHaveBeenCalled(); // not the default account
		release();
		expect(await pending).toEqual([{ type: "finish", reason: { kind: "stop" } }]);
		runtime.dispose();
	});
	it("renaming the default account also asks the owner to re-publish the legacy route", async () => {
		const { runtime, register, replaces, hostNames, onLegacyDisplayChange } = await fixture();
		runtime.attach(register);
		await runtime.reconcile();
		const route = runtime.snapshot().accounts[0]!.route;
		onLegacyDisplayChange.mockClear();
		await runtime.renameAccount(route, "Principal");
		expect(runtime.defaultRouteName("claude")).toBe("Claude · Principal (par défaut)");
		expect(onLegacyDisplayChange).toHaveBeenCalledTimes(1);
		expect(replaces.get(route)).toHaveBeenCalledWith([route]);
		expect(hostNames.get(route)).toBe("Claude · Principal");
		runtime.dispose();
	});
	it("answers with the label actually written even when the reconciliation does not run", async () => {
		const { runtime, register, store } = await fixture();
		runtime.attach(register);
		await runtime.reconcile();
		const route = runtime.snapshot().accounts[1]!.route;
		vi.spyOn(runtime, "reconcile").mockResolvedValue(undefined);
		const renamed = await runtime.renameAccount(route, "Écrit");
		expect(renamed.accounts[1]).toMatchObject({ name: "Claude · Écrit", label: "Écrit", isDefault: false });
		expect((await store.listAccounts({ readOnly: true }))[1]?.label).toBe("Écrit");
		// Clearing: the numbered fallback computed from the store, not the previous custom name.
		const cleared = await runtime.renameAccount(route, null);
		expect(cleared.accounts[1]).toMatchObject({ name: "Claude · compte 2", label: null });
		runtime.dispose();
	});
	it("serializes concurrent reconciliations: no duplicate registration, one consistent result", async () => {
		const { runtime, register, registered } = await fixture();
		runtime.attach(register);
		await Promise.all([runtime.reconcile(), runtime.reconcile(), runtime.reconcile()]);
		const routes = runtime.snapshot().accounts.map((row) => row.route);
		expect(runtime.snapshot().state).toBe("ready");
		expect(routes).toHaveLength(2);
		expect(register.mock.calls.length).toBe(2);
		for (const route of routes) expect(registered.has(route)).toBe(true);
		runtime.dispose();
	});
	it("a reconcile superseded by a disabling one leaves nothing registered", async () => {
		const { runtime, current, register, registered } = await fixture();
		runtime.attach(register);
		const first = runtime.reconcile();
		current.enabled = false;
		await Promise.all([first, runtime.reconcile()]);
		expect(runtime.snapshot()).toEqual({ state: "disabled", accounts: [] });
		expect([...registered.keys()]).toEqual(["codex-oauth-fast", "claude-code-oauth"]);
		runtime.dispose();
	});
	it("reverts the legacy route name when routing is switched off while the LLM stays attached", async () => {
		const { runtime, current, register, onLegacyDisplayChange } = await fixture();
		runtime.attach(register);
		await runtime.reconcile();
		expect(runtime.defaultRouteName("claude")).toBeDefined();
		onLegacyDisplayChange.mockClear();
		current.enabled = false;
		await runtime.reconcile();
		expect(runtime.defaultRouteName("claude")).toBeUndefined();
		expect(onLegacyDisplayChange).toHaveBeenCalledTimes(1);
		runtime.dispose();
	});
	it("exposes no account identifier in snapshots or the model-facing view", async () => {
		const { runtime, register, store } = await fixture();
		const ids = [randomUUID(), randomUUID()];
		for (const id of ids) await store.upsertAccount({ id, credential: credential(id) });
		runtime.attach(register);
		await runtime.reconcile();
		const snapshot = runtime.snapshot();
		for (const view of [snapshot, modelFacingAccounts(snapshot)]) {
			// Routes are public handles (random, unrelated to account ids): drop them, then look for any identifier.
			let text = JSON.stringify(view);
			for (const row of snapshot.accounts) text = text.split(row.route).join("");
			for (const id of ["account-a", "account-b", ...ids]) expect(text).not.toContain(id);
			expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu);
			expect(text).not.toMatch(/[0-9a-f]{16,}/iu);
			expect(text).not.toContain("fixture");
		}
		runtime.dispose();
	});
});
