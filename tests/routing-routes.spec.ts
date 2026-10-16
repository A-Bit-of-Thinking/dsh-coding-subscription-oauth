import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QUOTA_READ_TIMEOUT_MS } from "../src/account-quota.ts";
import { AccountRouteRegistry } from "../src/account-routes.ts";
import { AccountRoutingRuntime } from "../src/account-runtime.ts";
import { JSON_BODY_LIMIT_BYTES } from "../src/http-json.ts";
import { CLAUDE_CODE_OAUTH_PROVIDER } from "../src/oauth-providers.ts";
import { OAuthProviderSession } from "../src/oauth-session.ts";
import { readRoutingConfig } from "../src/routing-config.ts";
import {
	ROUTING_ACCOUNT_LABEL_PATH,
	ROUTING_STATUS_PATH,
	ROUTING_USAGE_PATH,
	ROUTING_USAGE_WAIT_MS,
	registerRoutingRoutes,
} from "../src/routing-routes.ts";
import { OAuthCredentialFileStore } from "../src/store.ts";

type Handler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) {
		if (!dir.startsWith(join(tmpdir(), "dsh-routing-routes-"))) throw new Error("Unexpected cleanup target");
		await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}
});

class TestResponse {
	status = 0;
	body = "";
	writeHead(status: number): this {
		this.status = status;
		return this;
	}
	end(value?: string): this {
		this.body += value ?? "";
		return this;
	}
}
function request(
	method: string,
	body = "",
	headers: IncomingMessage["headers"] = {},
	remoteAddress = "127.0.0.1",
): IncomingMessage {
	const stream = Readable.from([body]) as unknown as IncomingMessage;
	Object.defineProperties(stream, {
		method: { value: method, configurable: true },
		headers: {
			value: { host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080", ...headers },
			configurable: true,
		},
		socket: { value: { remoteAddress }, configurable: true },
	});
	return stream;
}
interface Body {
	error?: string;
	accounts: { name: string; label: string | null; isDefault: boolean; route: string }[];
}
async function invoke(handler: Handler | undefined, req: IncomingMessage): Promise<{ status: number; body: Body }> {
	if (handler === undefined) throw new Error("route was not registered");
	const response = new TestResponse();
	await handler(req, response as unknown as ServerResponse);
	return { status: response.status, body: response.body.length === 0 ? undefined : JSON.parse(response.body) };
}

async function harness(options: { usage?: boolean } = {}) {
	const fetchImpl = vi.fn(
		async () => new Response(JSON.stringify({ five_hour: { utilization: 12 }, seven_day: { utilization: 34 } })),
	);
	const home = await mkdtemp(join(tmpdir(), "dsh-routing-routes-"));
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
	const config = { ...readRoutingConfig(undefined), enabled: true };
	const accounts = new AccountRoutingRuntime({
		registry: new AccountRouteRegistry(join(home, "routes.json")),
		sessions: [session],
		current: () => config,
		resolveAttachments: () => undefined,
		fetchImpl,
	});
	// Quota reads are opt-in: switching them on before attach starts the automatic startup reads.
	config.usageEnabled = options.usage === true;
	accounts.attach(() => Object.assign(() => undefined, { replace: () => undefined }));
	await accounts.reconcile();
	const routes = new Map<string, Handler>();
	registerRoutingRoutes(
		{
			webServer: {
				register(route: { path: string; handler: Handler }) {
					routes.set(route.path, route.handler);
					return () => routes.delete(route.path);
				},
			},
			effect(setup: () => unknown) {
				return setup();
			},
		} as never,
		{ current: () => config, accounts, settings: {} as never },
	);
	return { accounts, routes, store, config, fetchImpl, route: accounts.snapshot().accounts[1]!.route as string };
}

describe("account label route and routing status contract", () => {
	it("registers the label route next to status and usage", async () => {
		const { routes, accounts } = await harness();
		expect([...routes.keys()]).toEqual(
			expect.arrayContaining([ROUTING_STATUS_PATH, ROUTING_USAGE_PATH, ROUTING_ACCOUNT_LABEL_PATH]),
		);
		accounts.dispose();
	});
	it("GET /routing lists name, label, isDefault, route, family and quota - and no slot", async () => {
		const { routes, accounts } = await harness();
		const { status, body } = await invoke(routes.get(ROUTING_STATUS_PATH), request("GET"));
		expect(status).toBe(200);
		expect(body.accounts).toHaveLength(2);
		for (const row of body.accounts)
			expect(Object.keys(row).sort()).toEqual(["family", "isDefault", "label", "name", "quota", "route"]);
		expect(body.accounts.map((row: { name: string }) => row.name)).toEqual(["Claude · compte 1", "Claude · compte 2"]);
		expect(body.accounts.map((row: { isDefault: boolean }) => row.isDefault)).toEqual([true, false]);
		expect(JSON.stringify(body)).not.toMatch(/slot/iu);
		accounts.dispose();
	});
	it("POST renames, returns the snapshot, then clears with null", async () => {
		const { routes, accounts, route, store } = await harness();
		const handler = routes.get(ROUTING_ACCOUNT_LABEL_PATH);
		const renamed = await invoke(handler, request("POST", JSON.stringify({ route, label: " Perso " })));
		expect(renamed.status).toBe(200);
		expect(renamed.body.accounts[1]).toMatchObject({ route, name: "Claude · Perso", label: "Perso", isDefault: false });
		expect((await store.listAccounts({ readOnly: true }))[1]?.label).toBe("Perso");
		const status = await invoke(routes.get(ROUTING_STATUS_PATH), request("GET"));
		expect(status.body.accounts[1]?.name).toBe("Claude · Perso");
		const cleared = await invoke(handler, request("POST", JSON.stringify({ route, label: null })));
		expect(cleared.status).toBe(200);
		expect(cleared.body.accounts[1]).toMatchObject({ name: "Claude · compte 2", label: null });
		accounts.dispose();
	});
	it("refuses non-loopback peers, cross-site origins and non-POST methods", async () => {
		const { routes, accounts, route } = await harness();
		const handler = routes.get(ROUTING_ACCOUNT_LABEL_PATH);
		const payload = JSON.stringify({ route, label: "Nope" });
		expect((await invoke(handler, request("POST", payload, {}, "10.0.0.8"))).status).toBe(403);
		expect((await invoke(handler, request("POST", payload, { origin: "https://evil.example" }))).status).toBe(403);
		expect((await invoke(handler, request("POST", payload, { host: "evil.example:3080" }))).status).toBe(403);
		expect((await invoke(handler, request("GET"))).status).toBe(405);
		expect((await invoke(handler, request("PATCH", payload))).status).toBe(405);
		expect(accounts.snapshot().accounts[1]?.label).toBeNull();
		accounts.dispose();
	});
	it("validates the body: malformed JSON, oversize, missing label, bad route, bad label, unknown route", async () => {
		const { routes, accounts, route } = await harness();
		const handler = routes.get(ROUTING_ACCOUNT_LABEL_PATH);
		expect((await invoke(handler, request("POST", "{not-json"))).status).toBe(400);
		const huge = JSON.stringify({ route, label: "x".repeat(JSON_BODY_LIMIT_BYTES + 1) });
		expect((await invoke(handler, request("POST", huge))).status).toBe(413);
		expect((await invoke(handler, request("POST", JSON.stringify({ route })))).status).toBe(400);
		expect((await invoke(handler, request("POST", JSON.stringify([route])))).status).toBe(400);
		for (const badRoute of [undefined, 3, "", "r".repeat(201)]) {
			const result = await invoke(handler, request("POST", JSON.stringify({ route: badRoute, label: "Ok" })));
			expect(result).toEqual({ status: 400, body: { error: "invalid route" } });
		}
		const canary = "CANARY_LABEL";
		const tooLong = await invoke(handler, request("POST", JSON.stringify({ route, label: canary + "x".repeat(40) })));
		expect(tooLong).toEqual({ status: 400, body: { error: "invalid label" } });
		const control = await invoke(handler, request("POST", JSON.stringify({ route, label: `${canary}\u0007` })));
		expect(control).toEqual({ status: 400, body: { error: "invalid label" } });
		const notString = await invoke(handler, request("POST", JSON.stringify({ route, label: 12 })));
		expect(notString.status).toBe(400);
		const unknown = await invoke(
			handler,
			request("POST", JSON.stringify({ route: "claude-code-oauth-account-unknown", label: canary })),
		);
		expect(unknown).toEqual({ status: 404, body: { error: "unknown route" } });
		expect(accounts.snapshot().accounts[1]?.label).toBeNull();
		accounts.dispose();
	});
});

describe("POST /routing/usage", () => {
	it("is refused while quota reads are disabled, and never reads", async () => {
		const { routes, accounts, fetchImpl } = await harness();
		const result = await invoke(routes.get(ROUTING_USAGE_PATH), request("POST", "{}"));
		expect(result).toEqual({ status: 404, body: { error: "disabled" } });
		expect(fetchImpl).not.toHaveBeenCalled();
		accounts.dispose();
	});
	it("bounds the wait of an explicit refresh (the read keeps its own 20 s deadline)", async () => {
		const { routes, accounts, route } = await harness({ usage: true });
		const spy = vi.spyOn(accounts, "refreshUsage").mockResolvedValue(accounts.snapshot());
		const handler = routes.get(ROUTING_USAGE_PATH);
		expect((await invoke(handler, request("POST", "{}"))).status).toBe(200);
		expect((await invoke(handler, request("POST", JSON.stringify({ route })))).status).toBe(200);
		expect(spy.mock.calls).toEqual([
			[undefined, undefined, { timeoutMs: ROUTING_USAGE_WAIT_MS }],
			[route, undefined, { timeoutMs: ROUTING_USAGE_WAIT_MS }],
		]);
		expect(ROUTING_USAGE_WAIT_MS).toBeGreaterThan(QUOTA_READ_TIMEOUT_MS);
		accounts.dispose();
	});
	it("returns the snapshot and obeys the minimal delay between reads (no extra call, no error)", async () => {
		const { routes, accounts, fetchImpl, config } = await harness({ usage: true });
		const handler = routes.get(ROUTING_USAGE_PATH);
		// The startup read of both routes is already in flight or done: the explicit call joins or is throttled.
		const first = await invoke(handler, request("POST", "{}"));
		expect(first.status).toBe(200);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		const states = first.body.accounts.map((row) => (row as unknown as { quota: { state: string } }).quota.state);
		expect(states).toEqual(["fresh", "fresh"]);
		const second = await invoke(handler, request("POST", JSON.stringify({ route: first.body.accounts[0]!.route })));
		expect(second.status).toBe(200);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		const bad = await invoke(handler, request("POST", JSON.stringify({ route: 12 })));
		expect(bad).toEqual({ status: 400, body: { error: "invalid route" } });
		config.usageEnabled = false;
		accounts.dispose();
	});
});
