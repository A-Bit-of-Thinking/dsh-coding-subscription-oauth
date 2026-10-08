import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionGatewayBackend } from "../src/gateway-backend.ts";
import { CODEX_OAUTH_PROVIDER } from "../src/oauth-providers.ts";
import type { OAuthProviderSession } from "../src/oauth-session.ts";
import { GROK_BUILD_BASE_URL, grokBuildBaselineModels, grokBuildFingerprintHeaders } from "../src/provider.ts";
import { GrokBuildSession } from "../src/session.ts";

// All auth stays in memory. Global fetch is replaced before any lazy OAuth/API
// module is loaded; no real store, home, account, refresh, or network is used.
afterEach(() => {
	vi.unstubAllGlobals();
});

function fixtureGrok(selectedIds?: readonly string[]) {
	let credential: Credential | undefined = {
		type: "oauth",
		access: "fixture-grok-access",
		refresh: "fixture-unused-refresh",
		expires: Number.MAX_SAFE_INTEGER,
	};
	const read = vi.fn(async (id: string) => (id === "xai" ? credential : undefined));
	const store: CredentialStore = {
		read,
		list: async () => [],
		modify: async (_id, fn) => {
			credential = await fn(credential);
			return credential;
		},
		delete: async () => {
			throw new Error("fixture: credential deletion is forbidden");
		},
	};
	const models = createModels({
		credentials: store,
		authContext: { env: async () => undefined, fileExists: async () => false },
	});
	models.setProvider(xaiProvider());
	const catalog = grokBuildBaselineModels();
	const visibleModels = () => catalog.filter((model) => selectedIds === undefined || selectedIds.includes(model.id));
	// Reuse the real session provider factory without constructing a session,
	// whose constructor resolves the user's DSH home even with a fake store.
	const session = {
		models,
		visibleModels,
		provider: GrokBuildSession.prototype.provider,
	} as unknown as GrokBuildSession;
	return {
		session,
		read,
		models,
		setCredential(next: Credential | undefined) {
			credential = next;
		},
	};
}

function fakeResponses() {
	const seen: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
	const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const request = input instanceof Request ? input : new Request(input, init);
		if (request.url !== `${GROK_BUILD_BASE_URL}/responses`) {
			throw new Error("fixture: unexpected endpoint; external network is forbidden");
		}
		seen.push({ url: request.url, headers: request.headers, body: JSON.parse(await request.text()) });
		const item = {
			id: "msg_fixture",
			type: "message",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "fixture answer", annotations: [] }],
		};
		const events = [
			{ type: "response.created", response: { id: "resp_fixture" } },
			{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
			{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "fixture answer" },
			{ type: "response.output_item.done", output_index: 0, item },
			{
				type: "response.completed",
				response: { id: "resp_fixture", status: "completed", output: [item] },
			},
		];
		const sse = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
		return new Response(sse, { headers: { "content-type": "text/event-stream" } });
	});
	vi.stubGlobal("fetch", fetch);
	return { fetch, seen };
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
	const events: T[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("session-backed gateway (offline)", () => {
	it("streams selected Grok models with resolved OAuth, Build URL, fingerprint and normalized context", async () => {
		const transport = fakeResponses();
		const grok = fixtureGrok(["grok-4.6"]);
		const backend = createSessionGatewayBackend(grok.session, []);
		expect(await backend.listModels()).toEqual([{ id: "grok-4.6", owned_by: "grok-build" }]);
		const wrongCollection = await grok.models.streamSimple(grok.session.visibleModels()[0]!, { messages: [] }).result();
		expect(wrongCollection.errorMessage).toContain("Unknown provider: grok-build");
		expect(transport.fetch).not.toHaveBeenCalled();

		const events = await collect(
			backend.stream({
				model: "grok-4.6",
				messages: [
					{ role: "system", content: "fixture system instruction" },
					{ role: "user", content: "fixture question" },
				],
				reasoning: "high",
				tools: [{ name: "fixture_tool", description: "fixture", parameters: { type: "object", properties: {} } }],
			}),
		);
		expect(events).toEqual([
			{ type: "text", text: "fixture answer" },
			{ type: "done", finish: "stop" },
		]);
		expect(transport.fetch).toHaveBeenCalledTimes(1);
		const request = transport.seen[0]!;
		expect(request.url).toBe(`${GROK_BUILD_BASE_URL}/responses`);
		expect(request.headers.get("authorization")).toBe("Bearer fixture-grok-access");
		for (const [name, value] of Object.entries(grokBuildFingerprintHeaders())) {
			expect(request.headers.get(name)).toBe(value);
		}
		expect(request.body).toMatchObject({ model: "grok-4.6", stream: true, reasoning: { effort: "high" } });
		expect(JSON.stringify(request.body)).toContain("fixture system instruction");
		expect(JSON.stringify(request.body)).toContain("fixture question");
		expect(request.body.tools).toEqual([expect.objectContaining({ type: "function", name: "fixture_tool" })]);
		expect(grok.read).toHaveBeenCalledWith("xai", expect.anything());
		expect(grok.models.getProviders().map((provider) => provider.id)).toEqual(["xai"]);
	});

	it("hides disconnected Grok and rejects inference before fetch", async () => {
		const transport = fakeResponses();
		const grok = fixtureGrok();
		grok.setCredential(undefined);
		const backend = createSessionGatewayBackend(grok.session, []);
		expect(await backend.listModels()).toEqual([]);
		await expect(collect(backend.stream({ model: "grok-4.6", messages: [] }))).rejects.toThrow("Unknown model");
		expect(transport.fetch).not.toHaveBeenCalled();
	});

	it("keeps unselected models hidden and resolves current auth for each request", async () => {
		const transport = fakeResponses();
		const grok = fixtureGrok(["grok-composer-2.5-fast"]);
		const backend = createSessionGatewayBackend(grok.session, []);
		expect(await backend.listModels()).toEqual([{ id: "grok-composer-2.5-fast", owned_by: "grok-build" }]);
		await expect(collect(backend.stream({ model: "grok-4.6", messages: [] }))).rejects.toThrow("Unknown model");
		expect(transport.fetch).not.toHaveBeenCalled();
		grok.setCredential({
			type: "oauth",
			access: "fixture-current-access",
			refresh: "fixture-unused-refresh",
			expires: Number.MAX_SAFE_INTEGER,
		});
		expect(await collect(backend.streamText("grok-composer-2.5-fast", [{ role: "user", content: "fixture" }]))).toEqual(
			["fixture answer"],
		);
		expect(transport.seen[0]?.headers.get("authorization")).toBe("Bearer fixture-current-access");
	});

	it("preserves subscription-native forwarding and its authentication gate", async () => {
		const transport = fakeResponses();
		const grok = fixtureGrok();
		grok.setCredential(undefined);
		const model = CODEX_OAUTH_PROVIDER.providerFactory().getModels()[0]!;
		const streamSimple = vi.fn(async function* () {
			yield { type: "text_delta", delta: "fixture subscription" };
			yield { type: "done", reason: "stop" };
		});
		const status = vi.fn(async () => ({ authenticated: true }));
		const subscription = {
			definition: CODEX_OAUTH_PROVIDER,
			status,
			visibleModels: () => [model],
			models: { streamSimple },
		} as unknown as OAuthProviderSession;
		const backend = createSessionGatewayBackend(grok.session, [subscription]);
		expect(await backend.listModels()).toEqual([{ id: model.id, owned_by: CODEX_OAUTH_PROVIDER.route }]);
		expect(
			await collect(backend.stream({ model: model.id, messages: [{ role: "user", content: "fixture" }] })),
		).toEqual([
			{ type: "text", text: "fixture subscription" },
			{ type: "done", finish: "stop" },
		]);
		expect(streamSimple).toHaveBeenCalledWith(
			model,
			expect.objectContaining({ messages: expect.any(Array) }),
			undefined,
		);
		expect(model.provider).toBe("openai-codex");
		status.mockResolvedValue({ authenticated: false });
		expect(await backend.listModels()).toEqual([]);
		expect(transport.fetch).not.toHaveBeenCalled();
	});
});
