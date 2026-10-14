import type {
	GenerateOptions,
	LlmModelInfo,
	LlmResolvedModelInfo,
	PreparedAdapterCall,
	StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { LlmAdapter, LlmError } from "@deepseek-ai/dsh-llm";
import { describe, expect, it } from "vitest";
import { assertRoutingAllowed, parseRoutingPolicy, RoutingPolicyAdapter } from "../src/routing-policy.ts";

const NOW = 1_800_000_000_000;
const entry = { family: "codex", model: "model-a", allowedEfforts: ["effort-a"] };
const policy = (models: unknown[] = [entry], guidance = "") => JSON.stringify({ version: 1, guidance, models });
const request = (effort: string | undefined, extra: Partial<GenerateOptions> = {}): GenerateOptions => ({
	provider: "provider-a",
	model: "model-a",
	messages: [],
	...(effort === undefined ? {} : { reasoningEffort: effort as NonNullable<GenerateOptions["reasoningEffort"]> }),
	...extra,
});
class FakeLlmAdapter extends LlmAdapter {
	calls: GenerateOptions[] = [];
	readonly info = { id: "provider-a", name: "Provider A" };
	readonly models: readonly LlmModelInfo[] = [
		{ provider: "provider-a", id: "model-a", name: "Model A", inputModalities: ["text"] },
	];
	readonly resolved: LlmResolvedModelInfo = {
		provider: "provider-a",
		id: "model-a",
		name: "Model A",
		inputModalities: ["text"],
	};
	providerInfo() {
		return this.info;
	}
	listModels() {
		return Promise.resolve(this.models);
	}
	resolveModel() {
		return Promise.resolve(this.resolved);
	}
	async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
		this.calls.push(options);
		yield { type: "text-delta", index: 0, text: "ok" };
	}
}
class PreparedFakeLlmAdapter extends FakeLlmAdapter {
	generation = 1;
	preparedCalls: { options: GenerateOptions; generation: number }[] = [];
	preparation: { provider: string; model: string; signal?: AbortSignal; metadata: LlmResolvedModelInfo } | undefined;
	async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
		const generation = this.generation;
		const metadata: LlmResolvedModelInfo = { ...this.resolved, provider, id: model, name: `Generation ${generation}` };
		this.preparation = { provider, model, metadata, ...(signal === undefined ? {} : { signal }) };
		const inner = this;
		return {
			model: metadata,
			async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
				// Deliberately bypass inner.stream: a wrapper must guard this separate dispatch seam.
				inner.preparedCalls.push({ options, generation });
				yield { type: "text-delta", index: 0, text: `generation-${generation}` };
			},
		};
	}
}
function fixture(policyJson = policy(), enforcePolicy = true, inner = new FakeLlmAdapter()) {
	const current = { policyJson, enforcePolicy };
	const adapter = new RoutingPolicyAdapter(inner, {
		current: () => current,
		familyForRoute: (provider) => (provider === "provider-a" ? "codex" : undefined),
	});
	return { inner, current, adapter };
}
async function consume(adapter: Pick<LlmAdapter, "stream">, options = request("effort-a")) {
	const chunks: StreamChunk[] = [];
	for await (const chunk of adapter.stream(options)) chunks.push(chunk);
	return chunks;
}
function invalid(fn: () => unknown) {
	expect(fn).toThrow(LlmError);
	try {
		fn();
	} catch (error) {
		expect(error).toMatchObject({ code: "INVALID_ARGS" });
		expect((error as Error).cause).toBeUndefined();
	}
}

describe("parseRoutingPolicy", () => {
	it("has an empty neutral public default", () => {
		expect(parseRoutingPolicy("")).toBeUndefined();
		expect(parseRoutingPolicy(" \r\n\t")).toBeUndefined();
		expect(parseRoutingPolicy(policy([]))).toEqual({ version: 1, guidance: "", models: [] });
	});
	it("preserves complete literal operator rationale and advisory fields", () => {
		const guidance =
			"  OperatorText\r\nWhy: preserve every rationale; no defaults.\n工具 & é 😀\n" +
			"rationale\n".repeat(3000) +
			"FIN  ";
		const json = policy([{ ...entry, reason: "  literal reason\n", resourceClass: "heavy" }], guidance);
		expect(parseRoutingPolicy(json)?.guidance).toBe(guidance);
		expect(parseRoutingPolicy(json)).toEqual(JSON.parse(json));
	});
	it.each(["{", "null", "[]", "1", "{}", '{"version":2,"guidance":"","models":[]}'])(
		"rejects malformed root %s",
		(json) => invalid(() => parseRoutingPolicy(json)),
	);
	it("rejects unknown keys, wrong types and unsupported vocabulary", () => {
		for (const json of [
			JSON.stringify({ version: 1, guidance: "", models: [], extra: true }),
			JSON.stringify({ version: 1, guidance: [], models: [] }),
			JSON.stringify({ version: 1, guidance: "", models: {} }),
			policy([{ ...entry, extra: true }]),
			policy([{ ...entry, family: "provider-a" }]),
			policy([{ ...entry, family: ["codex"] }]),
			policy([{ ...entry, resourceClass: ["heavy"] }]),
			policy([{ ...entry, reason: 7 }]),
			policy([{ ...entry, exceptionEfforts: null }]),
		])
			invalid(() => parseRoutingPolicy(json));
	});
	it("enforces UTF-8 byte budget, guidance and model count bounds", () => {
		invalid(() => parseRoutingPolicy(" ".repeat(65_537)));
		invalid(() => parseRoutingPolicy(policy([], "界".repeat(25_000))));
		invalid(() => parseRoutingPolicy(policy([], "a".repeat(32_001))));
		invalid(() =>
			parseRoutingPolicy(policy(Array.from({ length: 129 }, (_, i) => ({ ...entry, model: `model-${i}` })))),
		);
		expect(parseRoutingPolicy(policy([], "a".repeat(32_000)))?.guidance.length).toBe(32_000);
		expect(
			parseRoutingPolicy(policy(Array.from({ length: 128 }, (_, i) => ({ ...entry, model: `model-${i}` }))))?.models,
		).toHaveLength(128);
	});
	it("rejects duplicate family/models, effort duplicates and overlaps", () => {
		for (const models of [
			[entry, entry],
			[{ ...entry, allowedEfforts: ["effort-a", "effort-a"] }],
			[{ ...entry, exceptionEfforts: ["effort-b", "effort-b"] }],
			[{ ...entry, exceptionEfforts: ["effort-a"] }],
		]) {
			invalid(() => parseRoutingPolicy(policy(models)));
		}
		expect(parseRoutingPolicy(policy([entry, { ...entry, family: "claude" }]))?.models).toHaveLength(2);
	});
	it("validates safe model IDs and bounded opaque native effort IDs", () => {
		for (const model of ["", "bad model", "bad\nmodel", "../model", "模型", "a".repeat(201)]) {
			invalid(() => parseRoutingPolicy(policy([{ ...entry, model }])));
		}
		for (const effort of ["", " effort-a", "effort-a\n", "a\u0000b", "a".repeat(201), 1]) {
			invalid(() => parseRoutingPolicy(policy([{ ...entry, allowedEfforts: [effort] }])));
		}
		const parsed = parseRoutingPolicy(
			policy([{ ...entry, model: "vendor/model-a:preview", allowedEfforts: ["native:深度"] }]),
		)!;
		expect(parsed.models[0]?.allowedEfforts).toEqual(["native:深度"]);
		assertRoutingAllowed(parsed, "codex", "vendor/model-a:preview", "native:深度");
	});
	it("requires finite bounded explicit approval without auto-activating exceptions", () => {
		const exception = { ...entry, exceptionEfforts: ["effort-b"] };
		for (const until of [null, "later", NOW + 86_400_001]) {
			invalid(() => parseRoutingPolicy(policy([{ ...exception, exceptionApprovedUntil: until }]), NOW));
		}
		invalid(() =>
			parseRoutingPolicy(
				'{"version":1,"guidance":"","models":[{"family":"codex","model":"model-a","allowedEfforts":[],"exceptionEfforts":["effort-b"],"exceptionApprovedUntil":1e999}]}',
				NOW,
			),
		);
		invalid(() => parseRoutingPolicy(policy([{ ...entry, exceptionApprovedUntil: NOW + 1 }]), NOW));
		for (const model of [
			exception,
			{ ...exception, exceptionApprovedUntil: NOW },
			{ ...exception, exceptionApprovedUntil: NOW - 1 },
		]) {
			invalid(() =>
				assertRoutingAllowed(parseRoutingPolicy(policy([model]), NOW)!, "codex", "model-a", "effort-b", NOW),
			);
		}
		const approved = parseRoutingPolicy(policy([{ ...exception, exceptionApprovedUntil: NOW + 86_400_000 }]), NOW)!;
		expect(() => assertRoutingAllowed(approved, "codex", "model-a", "effort-b", NOW)).not.toThrow();
		invalid(() => assertRoutingAllowed(approved, "codex", "model-a", "effort-b", NOW + 86_400_000));
	});
});

describe("RoutingPolicyAdapter prepared dispatch", () => {
	it("forwards preparation and preserves metadata, options and captured inner generation", async () => {
		const inner = new PreparedFakeLlmAdapter();
		const { adapter } = fixture(policy(), true, inner);
		const signal = new AbortController().signal;
		const prepared = await adapter.prepareCall("provider-a", "model-a", signal);
		expect(inner.preparation).toMatchObject({ provider: "provider-a", model: "model-a", signal });
		expect(prepared.model).toBe(inner.preparation?.metadata);
		inner.generation = 2;
		const options = request("effort-a", { system: "literal system", signal });
		expect(await consume(prepared, options)).toEqual([{ type: "text-delta", index: 0, text: "generation-1" }]);
		expect(inner.preparedCalls[0]?.options).toBe(options);
		expect(inner.preparedCalls[0]?.generation).toBe(1);
		expect(inner.calls).toHaveLength(0);
	});
	it.each([
		request(undefined),
		request("effort-b"),
		request("effort-a", { model: "model-b" }),
		request("effort-b", { purpose: "compaction" }),
	])("guards prepared vendor dispatch even when it bypasses inner.stream", async (options) => {
		const inner = new PreparedFakeLlmAdapter();
		const { adapter } = fixture(policy(), true, inner);
		const prepared = await adapter.prepareCall("provider-a", "model-a");
		await expect(consume(prepared, options)).rejects.toMatchObject({ code: "INVALID_ARGS" });
		expect(inner.preparedCalls).toHaveLength(0);
		expect(inner.calls).toHaveLength(0);
	});
	it.each([
		{ enforce: true, provider: "provider-b", model: "model-a" },
		{ enforce: true, provider: "provider-a", model: "model-b" },
		{ enforce: true, provider: "provider-b", model: "model-b" },
	])(
		"rejects forged provider/model on a prepared binding before vendor dispatch",
		async ({ enforce, provider, model }) => {
			const inner = new PreparedFakeLlmAdapter();
			const { adapter } = fixture(policy(), enforce, inner);
			const prepared = await adapter.prepareCall("provider-a", "model-a");
			const options = request("effort-b", { provider, model });
			await expect(consume(prepared, options)).rejects.toMatchObject({ code: "INVALID_ARGS" });
			expect(inner.preparedCalls).toHaveLength(0);
			expect(inner.calls).toHaveLength(0);
			expect(options.provider).toBe(provider);
			expect(options.model).toBe(model);
		},
	);
	it("leaves a prepared binding completely unchanged while enforcement is off", async () => {
		const inner = new PreparedFakeLlmAdapter();
		const { adapter } = fixture(policy(), false, inner);
		const prepared = await adapter.prepareCall("provider-a", "model-a");
		// Even a differing provider/model is delegated untouched: no behavior change without enforcement.
		await consume(prepared, request("effort-b", { provider: "provider-b", model: "model-b" }));
		expect(inner.preparedCalls).toHaveLength(1);
	});
	it.each(["invalid", "", policy([{ ...entry, allowedEfforts: ["effort-b"] }])])(
		"reads late policy changes at prepared dispatch, not at preparation",
		async (json) => {
			const inner = new PreparedFakeLlmAdapter();
			const { adapter, current } = fixture(policy(), true, inner);
			const prepared = await adapter.prepareCall("provider-a", "model-a");
			current.policyJson = json;
			await expect(consume(prepared)).rejects.toMatchObject({ code: "INVALID_ARGS" });
			expect(inner.preparedCalls).toHaveLength(0);
		},
	);
	it("reads enforcement toggles after preparation and allows later approved requests", async () => {
		const inner = new PreparedFakeLlmAdapter();
		const { adapter, current } = fixture("invalid", false, inner);
		const prepared = await adapter.prepareCall("provider-a", "model-a");
		current.enforcePolicy = true;
		await expect(consume(prepared)).rejects.toMatchObject({ code: "INVALID_ARGS" });
		current.policyJson = policy([{ ...entry, allowedEfforts: ["effort-b"] }]);
		await consume(prepared, request("effort-b"));
		current.enforcePolicy = false;
		await consume(prepared, request(undefined));
		expect(inner.preparedCalls).toHaveLength(2);
	});
	it.each([
		{ provider: "provider-a", enforce: false },
		{ provider: "provider-b", enforce: true },
	])("preserves off-mode and foreign prepared dispatch unchanged", async ({ provider, enforce }) => {
		const inner = new PreparedFakeLlmAdapter();
		const { adapter } = fixture("invalid", enforce, inner);
		const prepared = await adapter.prepareCall(provider, "model-b");
		const options = request(undefined, { provider, model: "model-b" });
		await consume(prepared, options);
		expect(inner.preparedCalls[0]?.options).toBe(options);
		expect(inner.calls).toHaveLength(0);
	});
});

describe("RoutingPolicyAdapter", () => {
	it("delegates the identical options unchanged when disabled, even with invalid policy", async () => {
		for (const json of ["", "invalid"]) {
			const { adapter, inner } = fixture(json, false);
			const options = request(undefined, { model: "model-b" });
			await consume(adapter, options);
			expect(inner.calls).toEqual([options]);
			expect(inner.calls[0]).toBe(options);
		}
	});
	it("passes authorized explicit request and all payload fields without rewriting", async () => {
		const { adapter, inner } = fixture();
		const options = request("effort-a", { system: "literal system", temperature: 0.2, tools: [], messages: [] });
		expect(await consume(adapter, options)).toEqual([{ type: "text-delta", index: 0, text: "ok" }]);
		expect(inner.calls[0]).toBe(options);
		expect(options.provider).toBe("provider-a");
		expect(options.reasoningEffort).toBe("effort-a");
	});
	it.each([
		request("effort-b"),
		request(undefined),
		request("effort-a", { model: "model-b" }),
		request("effort-b", { purpose: "compaction" }),
		request(undefined, { purpose: "session-title" }),
	])("blocks forbidden, missing, unknown and auxiliary requests without a vendor call", async (options) => {
		const { adapter, inner } = fixture();
		await expect(consume(adapter, options)).rejects.toMatchObject({ code: "INVALID_ARGS" });
		expect(inner.calls).toHaveLength(0);
	});
	it.each([
		"",
		"invalid",
		policy([{ ...entry, exceptionEfforts: ["effort-b"] }]),
		policy([{ ...entry, exceptionEfforts: ["effort-b"], exceptionApprovedUntil: NOW - 1 }]),
	])("refuses missing/invalid policy and unapproved/expired exception", async (json) => {
		const { adapter, inner } = fixture(json);
		await expect(consume(adapter, request("effort-b"))).rejects.toMatchObject({ code: "INVALID_ARGS" });
		expect(inner.calls).toHaveLength(0);
	});
	it("passes only an explicitly approved live exception", async () => {
		const { adapter, inner } = fixture(
			policy([{ ...entry, exceptionEfforts: ["effort-b"], exceptionApprovedUntil: Date.now() + 60_000 }]),
		);
		const options = request("effort-b");
		await consume(adapter, options);
		expect(inner.calls[0]).toBe(options);
	});
	it("does not intercept a foreign route, even with invalid enforced policy", async () => {
		const { adapter, inner } = fixture("invalid");
		const options = request(undefined, { provider: "provider-b", model: "model-b" });
		await consume(adapter, options);
		expect(inner.calls[0]).toBe(options);
	});
	it("uses fresh policy on the next request without caching", async () => {
		const { adapter, inner, current } = fixture();
		await consume(adapter);
		current.policyJson = policy([{ ...entry, allowedEfforts: ["effort-b"] }]);
		await expect(consume(adapter)).rejects.toMatchObject({ code: "INVALID_ARGS" });
		await consume(adapter, request("effort-b"));
		current.enforcePolicy = false;
		await consume(adapter, request(undefined));
		expect(inner.calls).toHaveLength(3);
	});
	it("keeps metadata and provider retry policy delegated, not policy-filtered", async () => {
		const { adapter, inner } = fixture("invalid");
		expect(adapter.providerInfo("provider-a")).toBe(inner.info);
		expect(await adapter.listModels("provider-a")).toBe(inner.models);
		expect(await adapter.resolveModel("provider-a", "model-a")).toBe(inner.resolved);
		expect(adapter.providerRetryPolicy("provider-a")).toBe(inner.providerRetryPolicy("provider-a"));
	});
	it("sanitizes parser and authorization errors without secret input or cause", async () => {
		const canary = "SECRET_CANARY_NOT_A_REAL_CREDENTIAL";
		const malformed = `{"guidance":"${canary}"`;
		for (const json of [malformed, policy([], canary)]) {
			const { adapter, inner } = fixture(json);
			try {
				await consume(adapter, request(canary, { model: canary }));
				expect.fail("Expected rejection");
			} catch (error) {
				expect(error).toBeInstanceOf(LlmError);
				expect(error).toMatchObject({ code: "INVALID_ARGS" });
				expect(String(error)).not.toContain(canary);
				expect(JSON.stringify(error)).not.toContain(canary);
				expect((error as Error).cause).toBeUndefined();
			}
			expect(inner.calls).toHaveLength(0);
		}
	});
});
