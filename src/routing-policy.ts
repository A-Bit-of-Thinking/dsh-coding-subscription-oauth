import type { GenerateOptions, PreparedAdapterCall, StreamChunk } from "@deepseek-ai/dsh-llm";
import { LlmAdapter, LlmError } from "@deepseek-ai/dsh-llm";

export type RoutingFamily = "claude" | "codex" | "kimi" | "grok";
export interface RoutingPolicy {
	version: 1;
	guidance: string;
	models: readonly {
		family: RoutingFamily;
		model: string;
		allowedEfforts: readonly string[];
		exceptionEfforts?: readonly string[];
		exceptionApprovedUntil?: number;
		resourceClass?: "light" | "moderate" | "heavy";
		reason?: string;
	}[];
}
export interface RoutingPolicyAdapterOptions {
	current: () => { enforcePolicy: boolean; policyJson: string };
	familyForRoute: (provider: string) => RoutingFamily | undefined;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MODEL_KEYS = [
	"family",
	"model",
	"allowedEfforts",
	"exceptionEfforts",
	"exceptionApprovedUntil",
	"resourceClass",
	"reason",
];
function reject(): never {
	// No input, identifiers, parser diagnostics or chained causes escape this boundary.
	throw new LlmError("Routing policy is invalid or does not authorize this request.", "INVALID_ARGS");
}
/**
 * A refusal that names what the request asked for (its own model/effort ids, bounded and
 * reduced to a safe alphabet) so the owner can fix it. It never repeats policy text or input JSON.
 */
function refuse(reason: string): never {
	throw new LlmError(
		`Routing policy refused this request: ${reason}. Change the model or effort, or turn off "Enforce the policy" in Settings > Coding OAuth > Routing.`,
		"INVALID_ARGS",
	);
}
function shown(value: string): string {
	return value.slice(0, 60).replace(/[^A-Za-z0-9._:/@+ -]/gu, "?");
}
function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function knownKeys(value: Record<string, unknown>, keys: readonly string[]): void {
	if (Object.keys(value).some((key) => !keys.includes(key))) reject();
}
function effortId(value: unknown): value is string {
	// Provider-owned opaque IDs: no effort vocabulary or provider-language assumptions.
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 200 &&
		value.trim() === value &&
		!/\p{Cc}/u.test(value)
	);
}
function efforts(value: unknown): value is string[] {
	return Array.isArray(value) && value.length <= 128 && value.every(effortId) && new Set(value).size === value.length;
}

/** Empty means no policy. Invalid nonempty input throws a sanitized INVALID_ARGS error. */
export function parseRoutingPolicy(json: string, now = Date.now()): RoutingPolicy | undefined {
	if (typeof json !== "string" || !Number.isFinite(now)) reject();
	if (json.length > 64 * 1024 || new TextEncoder().encode(json).byteLength > 64 * 1024) reject();
	if (json.trim() === "") return undefined;
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		reject();
	}
	if (!record(value)) reject();
	knownKeys(value, ["version", "guidance", "models"]);
	if (
		value.version !== 1 ||
		typeof value.guidance !== "string" ||
		value.guidance.length > 32_000 ||
		!Array.isArray(value.models) ||
		value.models.length > 128
	)
		reject();
	const identities = new Set<string>();
	for (const model of value.models) {
		if (!record(model)) reject();
		knownKeys(model, MODEL_KEYS);
		if (
			typeof model.family !== "string" ||
			!["claude", "codex", "kimi", "grok"].includes(model.family) ||
			typeof model.model !== "string" ||
			model.model.length > 200 ||
			!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/u.test(model.model) ||
			!efforts(model.allowedEfforts)
		)
			reject();
		const identity = `${model.family}:${model.model}`;
		if (identities.has(identity)) reject();
		identities.add(identity);
		if (
			"exceptionEfforts" in model &&
			(!efforts(model.exceptionEfforts) ||
				model.exceptionEfforts.some((effort) => (model.allowedEfforts as string[]).includes(effort)))
		)
			reject();
		if (
			"exceptionApprovedUntil" in model &&
			(typeof model.exceptionApprovedUntil !== "number" ||
				!Number.isFinite(model.exceptionApprovedUntil) ||
				model.exceptionApprovedUntil > now + DAY_MS ||
				!(model.exceptionEfforts as string[] | undefined)?.length)
		)
			reject();
		if (
			"resourceClass" in model &&
			(typeof model.resourceClass !== "string" || !["light", "moderate", "heavy"].includes(model.resourceClass))
		)
			reject();
		if ("reason" in model && (typeof model.reason !== "string" || model.reason.length > 32_000)) reject();
	}
	// Return the whole validated JSON value, including literal guidance and advisory fields.
	return value as unknown as RoutingPolicy;
}

/** No default effort, substitution, automatic exception approval or capability restriction. */
export function assertRoutingAllowed(
	policy: RoutingPolicy,
	family: RoutingFamily,
	model: string,
	effort: string | undefined,
	now = Date.now(),
): void {
	const entry = policy.models.find((candidate) => candidate.family === family && candidate.model === model);
	if (!entry) refuse(`model "${shown(model)}" is not listed in your routing policy`);
	const allowed = entry.allowedEfforts.map((value) => shown(value)).join(", ") || "none";
	if (effort === undefined) refuse(`no reasoning effort was set for "${shown(model)}"; choose one of: ${allowed}`);
	if (!effortId(effort)) reject();
	if (entry.allowedEfforts.includes(effort)) return;
	const until = entry.exceptionApprovedUntil;
	if (
		entry.exceptionEfforts?.includes(effort) &&
		typeof until === "number" &&
		Number.isFinite(until) &&
		Number.isFinite(now) &&
		until > now &&
		until <= now + DAY_MS
	)
		return;
	if (entry.exceptionEfforts?.includes(effort)) {
		refuse(`effort "${shown(effort)}" for "${shown(model)}" is an exception that is not approved or has expired`);
	}
	refuse(`effort "${shown(effort)}" is not allowed for "${shown(model)}"; allowed: ${allowed}`);
}

/** Own routes only; every streamed purpose, including compaction, receives the same check. */
export class RoutingPolicyAdapter extends LlmAdapter {
	constructor(
		private readonly inner: LlmAdapter,
		private readonly options: RoutingPolicyAdapterOptions,
	) {
		super();
	}
	providerInfo(provider: string) {
		return this.inner.providerInfo(provider);
	}
	listModels(provider: string) {
		return this.inner.listModels(provider);
	}
	resolveModel(provider: string, model: string, signal?: AbortSignal) {
		return this.inner.resolveModel(provider, model, signal);
	}
	providerRetryPolicy(provider: string) {
		return this.inner.providerRetryPolicy(provider);
	}
	imageRequestPricing(provider: string, model: string) {
		return this.inner.imageRequestPricing(provider, model);
	}
	async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
		const prepared = await this.inner.prepareCall(provider, model, signal);
		const guard = this;
		return {
			model: prepared.model,
			async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
				// Binding check only matters (and only applies) while enforcement is on; with it off, behavior is unchanged.
				if (guard.options.current().enforcePolicy && (options.provider !== provider || options.model !== model))
					reject();
				guard.assertAllowed(options);
				yield* prepared.stream(options);
			},
		};
	}
	private assertAllowed(options: GenerateOptions): void {
		const current = this.options.current();
		if (current.enforcePolicy) {
			const family = this.options.familyForRoute(options.provider);
			if (family !== undefined) {
				const now = Date.now();
				let policy: RoutingPolicy | undefined;
				try {
					policy = parseRoutingPolicy(current.policyJson, now);
				} catch {
					refuse("the routing policy saved in settings is not valid");
				}
				if (!policy) refuse('"Enforce the policy" is on but no routing policy is saved');
				assertRoutingAllowed(policy, family, options.model, options.reasoningEffort, now);
			}
		}
	}
	async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
		this.assertAllowed(options);
		yield* this.inner.stream(options);
	}
}
