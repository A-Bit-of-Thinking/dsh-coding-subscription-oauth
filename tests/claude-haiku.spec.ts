import { normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_CODE_OAUTH_PROVIDER } from "../src/oauth-providers.ts";

afterEach(() => vi.unstubAllGlobals());

describe("Claude Haiku 5.5", () => {
	it("exposes the reviewed model and preserves selection filtering", () => {
		const provider = CLAUDE_CODE_OAUTH_PROVIDER.requestProvider(["claude-haiku-5-5"]);
		expect(provider.getModels()).toHaveLength(1);
		expect(provider.getModels()[0]).toMatchObject({
			id: "claude-haiku-5-5",
			provider: "anthropic",
			api: "anthropic-messages",
			input: ["text", "image"],
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			cost: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
			compat: { forceAdaptiveThinking: true, supportsTemperature: false },
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			},
		});
	});

	it.each(["low", "medium", "high", "xhigh", "max"] as const)(
		"uses adaptive thinking, not an inherited token budget, at %s effort",
		async (reasoning) => {
			let payload: Record<string, unknown> | undefined;
			const fetchFixture = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const request = input instanceof Request ? input : new Request(input, init);
				payload = (await request.json()) as Record<string, unknown>;
				return new Response(JSON.stringify({ error: { message: "fixture stop" } }), {
					status: 401,
					headers: { "content-type": "application/json" },
				});
			});
			vi.stubGlobal("fetch", fetchFixture);
			const provider = CLAUDE_CODE_OAUTH_PROVIDER.requestProvider(["claude-haiku-5-5"]);
			const result = await provider
				.streamSimple(provider.getModels()[0]!, normalizeContext({ messages: [] }), {
					apiKey: "sk-ant-oat01-fixture",
					reasoning,
					temperature: 0.2,
				})
				.result();
			expect(result.stopReason).toBe("error");
			expect(fetchFixture).toHaveBeenCalled();
			expect(payload).toMatchObject({
				model: "claude-haiku-5-5",
				thinking: { type: "adaptive" },
				output_config: { effort: reasoning },
			});
			expect(payload?.["thinking"]).not.toHaveProperty("budget_tokens");
			expect(payload).not.toHaveProperty("temperature");
			expect(payload).not.toHaveProperty("top_p");
			expect(payload).not.toHaveProperty("top_k");
		},
	);

	it("leaves the provider's adaptive/medium default intact when no effort is requested", async () => {
		let payload: Record<string, unknown> | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const request = input instanceof Request ? input : new Request(input, init);
				payload = (await request.json()) as Record<string, unknown>;
				return new Response(JSON.stringify({ error: { message: "fixture stop" } }), {
					status: 401,
					headers: { "content-type": "application/json" },
				});
			}),
		);
		const provider = CLAUDE_CODE_OAUTH_PROVIDER.requestProvider(["claude-haiku-5-5"]);
		await provider
			.streamSimple(provider.getModels()[0]!, normalizeContext({ messages: [] }), {
				apiKey: "sk-ant-oat01-fixture",
				temperature: 0.2,
			})
			.result();
		expect(payload?.["model"]).toBe("claude-haiku-5-5");
		expect(payload).not.toHaveProperty("thinking");
		expect(payload).not.toHaveProperty("output_config");
		expect(payload).not.toHaveProperty("temperature");
	});
});
