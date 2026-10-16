import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerateOptions } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountBoundAdapter } from "../src/account-adapter.ts";
import { AccountRouteRegistry } from "../src/account-routes.ts";
import { CLAUDE_CODE_OAUTH_PROVIDER } from "../src/oauth-providers.ts";
import { OAuthProviderSession } from "../src/oauth-session.ts";
import { OAuthCredentialFileStore } from "../src/store.ts";

const dirs: string[] = [];
beforeEach(() =>
	vi.stubGlobal("fetch", () => {
		throw new Error("Unexpected real network");
	}),
);
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	for (const dir of dirs.splice(0)) {
		if (!dir.startsWith(join(tmpdir(), "dsh-account-adapter-"))) throw new Error("Unexpected cleanup target");
		await rm(dir, { recursive: true, force: true });
	}
});
async function fixture() {
	const home = await mkdtemp(join(tmpdir(), "dsh-account-adapter-"));
	dirs.push(home);
	const store = new OAuthCredentialFileStore("anthropic", join(home, "auth.json"), "fixture");
	for (const id of ["a", "b"])
		await store.upsertAccount({
			id,
			credential: {
				type: "oauth",
				access: `fixture-access-${id}`,
				refresh: `fixture-refresh-${id}`,
				expires: Date.now() + 3_600_000,
			},
		});
	const session = new OAuthProviderSession(CLAUDE_CODE_OAUTH_PROVIDER, undefined, store, join(home, "models.json"));
	const rows = await store.listAccounts({ includeCreatedAt: true });
	const bindings = await new AccountRouteRegistry(join(home, "routes.json")).synchronize(
		rows.map((row) => ({ family: "claude", accountId: row.id, createdAt: row.createdAt! })),
	);
	const adapters = bindings.map((binding) => new AccountBoundAdapter(session, binding, () => undefined));
	return { store, session, adapters, model: session.availableModels()[0]!.id };
}
async function collect(adapter: AccountBoundAdapter, model: string) {
	const chunks = [];
	for await (const chunk of adapter.stream({ provider: adapter.binding.route, model, messages: [] } as GenerateOptions))
		chunks.push(chunk);
	return chunks;
}
function apiKey(inner: PiAiAdapter): Promise<string> {
	return (inner as unknown as { config: { resolveApiKey(): Promise<string> } }).config.resolveApiKey();
}

describe("account-bound transport", () => {
	it("dispatches concurrent accounts with native anthropic identity and exact independent tokens", async () => {
		const { store, adapters, model } = await fixture();
		const seen: { provider: string; token: string }[] = [];
		vi.spyOn(PiAiAdapter.prototype, "stream").mockImplementation(async function* (this: PiAiAdapter, options) {
			seen.push({ provider: options.provider, token: await apiKey(this) });
			yield { type: "finish", reason: { kind: "stop" } };
		});
		await store.setActiveAccount("b");
		await Promise.all(adapters.map((adapter) => collect(adapter, model)));
		expect(seen.map((item) => item.token).sort()).toEqual(["fixture-access-a", "fixture-access-b"]);
		expect(seen.every((item) => item.provider === "anthropic")).toBe(true);
		await store.setActiveAccount("a");
		expect((await adapters[1]!.resolveAccess()).accessToken).toBe("fixture-access-b");
	});
	it("uses per-stream snapshots so late AUTH cannot expire another stream's refreshed token", async () => {
		const { store, adapters, model } = await fixture();
		const adapter = adapters[0]!;
		let entered!: () => void;
		const enteredPromise = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let calls = 0;
		vi.spyOn(PiAiAdapter.prototype, "stream").mockImplementation(async function* (this: PiAiAdapter) {
			await apiKey(this);
			if (++calls === 1) {
				entered();
				await gate;
				yield { type: "finish", reason: { kind: "error", failure: { code: "AUTH", message: "fixture rejected" } } };
			} else yield { type: "finish", reason: { kind: "stop" } };
		});
		const old = collect(adapter, model);
		await enteredPromise;
		await store.modifyAccount("a", async (current) => ({ ...current!, access: "fixture-access-new" }));
		await collect(adapter, model);
		release();
		await old;
		const current = await store.readAccount("a", { readOnly: true });
		expect(current?.access).toBe("fixture-access-new");
		expect(current!.expires).toBeGreaterThan(Date.now());
	});
	it("expires only the exact rejected account and disables old handles after withdrawal", async () => {
		const { store, adapters, model } = await fixture();
		vi.spyOn(PiAiAdapter.prototype, "stream").mockImplementation(async function* (this: PiAiAdapter) {
			await apiKey(this);
			yield { type: "finish", reason: { kind: "error", failure: { code: "AUTH", message: "fixture rejected" } } };
		});
		await collect(adapters[0]!, model);
		expect((await store.readAccount("a"))!.expires).toBeLessThan(Date.now());
		expect((await store.readAccount("b"))!.expires).toBeGreaterThan(Date.now());
		adapters[1]!.dispose();
		await expect(adapters[1]!.resolveAccess()).rejects.toMatchObject({ code: "MISSING_CREDENTIAL" });
	});
	it("refuses removed/recreated records and never falls back to global or environment credentials", async () => {
		const { store, adapters } = await fixture();
		const adapter = adapters[0]!;
		const access = await adapter.resolveAccess();
		expect(await adapter.isCurrent(access.generation)).toBe(true);
		await store.removeAccount("a");
		await expect(adapter.resolveAccess()).rejects.toMatchObject({ code: "MISSING_CREDENTIAL" });
		expect(await adapter.isCurrent(access.generation)).toBe(false);
		vi.stubEnv("ANTHROPIC_API_KEY", "fixture-env-forbidden");
		try {
			await store.upsertAccount({
				id: "a",
				credential: { type: "oauth", access: "fixture-new", refresh: "fixture-new", expires: Date.now() + 3_600_000 },
			});
			await expect(adapter.resolveAccess()).rejects.toMatchObject({ code: "MISSING_CREDENTIAL" });
		} finally {
			vi.unstubAllEnvs();
		}
	});
	it("does not expose provider error messages, request IDs or thrown causes", async () => {
		const { adapters, model } = await fixture();
		const spy = vi.spyOn(PiAiAdapter.prototype, "stream").mockImplementation(async function* (this: PiAiAdapter) {
			await apiKey(this);
			yield {
				type: "finish",
				reason: {
					kind: "error",
					failure: { code: "RATE_LIMIT", message: "PRIVATE_ERROR_CANARY", status: 429, providerRetryAfterMs: 1000 },
				},
			};
		});
		const chunks = await collect(adapters[0]!, model);
		expect(JSON.stringify(chunks)).not.toContain("PRIVATE_ERROR_CANARY");
		expect(chunks[0]).toMatchObject({
			reason: { failure: { code: "RATE_LIMIT", status: 429, providerRetryAfterMs: 1000 } },
		});
		spy.mockImplementation(() => {
			throw new Error("PRIVATE_ERROR_CANARY");
		});
		await expect(collect(adapters[0]!, model)).rejects.toThrow(/^Subscription account request could not complete$/u);
	});
	it("advertises a neutral name and conservative no-rate-limit-retry policy", async () => {
		const { adapters } = await fixture();
		const adapter = adapters[1]!;
		const info = adapter.providerInfo(adapter.binding.route);
		expect(info.name).toBe("Claude");
		expect(info.name).not.toMatch(/slot|account \d/iu);
		expect(JSON.stringify(info)).not.toContain("fixture-access");
		expect(adapter.providerRetryPolicy(adapter.binding.route)).toMatchObject({
			maxRetries: 1,
			retryableCodes: ["AUTH"],
		});
		expect((await adapter.listModels(adapter.binding.route)).length).toBeGreaterThan(0);
	});
	it("lists the full catalog on a fixed account route, whatever the plugin's model selection", async () => {
		const { session, adapters } = await fixture();
		const adapter = adapters[1]!;
		const all = session.availableModels().map((model) => model.id);
		expect(all.length).toBeGreaterThan(1);
		await session.setSelectedModels([all[0]!]);
		expect(session.visibleModels()).toHaveLength(1);
		const listed = (await adapter.listModels(adapter.binding.route)).map((model) => model.id);
		expect([...listed].sort()).toEqual([...all].sort());
	});
	// Adapter level only: the host snapshots names at registration, so making a rename visible in the model
	// picker is the job of `replace` (asserted in account-runtime.spec.ts with a host-like registrar).
	it("answers providerInfo with the name set at call time, without a new adapter", async () => {
		const { adapters } = await fixture();
		const adapter = adapters[1]!;
		adapter.setDisplayName("Claude · Perso");
		expect(adapter.providerInfo(adapter.binding.route).name).toBe("Claude · Perso");
		adapter.setDisplayName("Claude · compte 2");
		expect(adapter.providerInfo(adapter.binding.route).name).toBe("Claude · compte 2");
	});
	it("invalidateAccess expires only the still-rejected access token, and nothing once withdrawn", async () => {
		const { store, adapters } = await fixture();
		const adapter = adapters[0]!;
		await adapter.invalidateAccess("fixture-access-other");
		expect((await store.readAccount("a"))!.expires).toBeGreaterThan(Date.now());
		await adapter.invalidateAccess(undefined);
		expect((await store.readAccount("a"))!.expires).toBeGreaterThan(Date.now());
		await adapter.invalidateAccess("fixture-access-a");
		expect((await store.readAccount("a"))!.expires).toBeLessThan(Date.now());
		expect((await store.readAccount("b"))!.expires).toBeGreaterThan(Date.now());
		const other = adapters[1]!;
		other.dispose();
		await other.invalidateAccess("fixture-access-b");
		expect((await store.readAccount("b"))!.expires).toBeGreaterThan(Date.now());
	});
	it("hides the default account from listings but keeps resolveModel and stream working; the hiding follows setActive", async () => {
		const { store, adapters, model } = await fixture();
		const [a, b] = adapters as [AccountBoundAdapter, AccountBoundAdapter];
		vi.spyOn(PiAiAdapter.prototype, "stream").mockImplementation(async function* (this: PiAiAdapter) {
			await apiKey(this);
			yield { type: "finish", reason: { kind: "stop" } };
		});
		// "a" is the default account (first stored).
		expect(await a.listModels(a.binding.route)).toEqual([]);
		expect((await b.listModels(b.binding.route)).length).toBeGreaterThan(0);
		await expect(a.resolveModel(a.binding.route, model)).resolves.toMatchObject({ provider: a.binding.route });
		expect(await collect(a, model)).toEqual([{ type: "finish", reason: { kind: "stop" } }]);
		await store.setActiveAccount("b");
		expect((await a.listModels(a.binding.route)).length).toBeGreaterThan(0);
		expect(await b.listModels(b.binding.route)).toEqual([]);
		await expect(b.resolveModel(b.binding.route, model)).resolves.toMatchObject({ provider: b.binding.route });
		expect(await collect(b, model)).toEqual([{ type: "finish", reason: { kind: "stop" } }]);
	});
});
