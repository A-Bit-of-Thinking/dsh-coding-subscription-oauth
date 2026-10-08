/**
 * Session-backed model listing and event streaming for the local gateway.
 * @module dsh-coding-subscription-oauth/gateway-backend
 */

import type { Api, Context, JsonObject, Message, Model, ThinkingLevel, Tool } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import {
	type GatewayChatMessage,
	type GatewayCompletionRequest,
	type GatewayStreamPart,
	type GatewayTool,
	isThinkingLevel,
} from "./gateway-protocol.ts";
import type { OAuthProviderSession } from "./oauth-session.ts";
import { safeMessage } from "./redact.ts";
import type { GrokBuildSession } from "./session.ts";

export interface GatewayListedModel {
	id: string;
	owned_by: string;
}

export interface GatewayBackend {
	listModels(): Promise<readonly GatewayListedModel[]>;
	stream(request: GatewayCompletionRequest): AsyncIterable<GatewayStreamPart>;
	streamText(modelId: string, messages: readonly GatewayChatMessage[]): AsyncIterable<string>;
}

export class GatewayRequestError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

interface OwnedModel {
	owned_by: string;
	model: Model<Api>;
	stream: (
		model: Model<Api>,
		context: Context,
		options?: { reasoning?: ThinkingLevel },
	) => AsyncIterable<{
		type: string;
		delta?: string;
		errorMessage?: string;
		reason?: string;
		toolCall?: { id: string; name: string; arguments?: unknown };
		partial?: { content?: readonly { type?: string; id?: string; name?: string }[] };
	}>;
}

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function createSessionGatewayBackend(
	grok: GrokBuildSession,
	subscriptions: readonly OAuthProviderSession[],
): GatewayBackend {
	return {
		async listModels() {
			const listed: GatewayListedModel[] = [];
			const seen = new Map<string, string>();
			for (const owned of await collectOwnedModels(grok, subscriptions)) {
				const previous = seen.get(owned.model.id);
				if (previous !== undefined && previous !== owned.owned_by) continue;
				seen.set(owned.model.id, owned.owned_by);
				listed.push({ id: owned.model.id, owned_by: owned.owned_by });
			}
			return listed;
		},
		async *stream(request) {
			const owned = selectOwnedModel(await collectOwnedModels(grok, subscriptions), request.model);
			const context = buildGatewayContext(request.messages, request.tools);
			const reasoning = resolveReasoning(request.reasoning, owned.owned_by);
			let usedTools = false;
			for await (const event of owned.stream(
				owned.model,
				context,
				reasoning === undefined ? undefined : { reasoning },
			)) {
				if (event.type === "text_delta" && typeof event.delta === "string" && event.delta.length > 0) {
					yield { type: "text", text: event.delta };
				}
				if (event.type === "thinking_delta" && typeof event.delta === "string" && event.delta.length > 0) {
					yield { type: "thinking", text: event.delta };
				}
				if (event.type === "toolcall_end" && event.toolCall !== undefined) {
					usedTools = true;
					yield {
						type: "tool_call",
						index: 0,
						id: event.toolCall.id,
						name: event.toolCall.name,
						arguments: stringifyToolArguments(event.toolCall.arguments),
					};
				}
				if (event.type === "error") {
					throw new GatewayRequestError(502, "upstream_error", event.errorMessage ?? "upstream stream error");
				}
				if (event.type === "done") {
					const finish =
						event.reason === "length" ? "length" : usedTools || event.reason === "toolUse" ? "tool_calls" : "stop";
					yield { type: "done", finish };
				}
			}
		},
		async *streamText(modelId, messages) {
			for await (const part of this.stream({ model: modelId, messages })) {
				if (part.type === "text") yield part.text;
			}
		},
	};
}

export function selectOwnedModel(owned: readonly OwnedModel[], modelId: string): OwnedModel {
	const matches = owned.filter((item) => item.model.id === modelId);
	if (matches.length === 0) throw new GatewayRequestError(404, "model_not_found", `Unknown model ${modelId}`);
	const owners = new Set(matches.map((item) => item.owned_by));
	if (owners.size > 1) {
		throw new GatewayRequestError(404, "model_not_found", `Model ${modelId} is owned by multiple signed-in providers`);
	}
	return matches[0]!;
}

export function buildGatewayContext(messages: readonly GatewayChatMessage[], tools?: readonly GatewayTool[]): Context {
	let systemPrompt: string | undefined;
	const mapped: Message[] = [];
	for (const message of messages) {
		if (message.role === "system") {
			systemPrompt = `${systemPrompt === undefined ? "" : `${systemPrompt}\n`}${message.content}`;
			continue;
		}
		if (message.role === "assistant") {
			mapped.push(assistantReplay(message));
			continue;
		}
		if (message.role === "tool") {
			mapped.push({
				role: "toolResult",
				toolCallId: message.tool_call_id ?? "",
				toolName: message.tool_name ?? "tool",
				content: [{ type: "text", text: message.content }],
				isError: false,
				timestamp: Date.now(),
			});
			continue;
		}
		mapped.push({ role: "user", content: message.content, timestamp: Date.now() });
	}
	const context: Context = systemPrompt === undefined ? { messages: mapped } : { systemPrompt, messages: mapped };
	if (tools !== undefined && tools.length > 0) context.tools = tools.map(toPiTool);
	return context;
}

export function assistantReplay(message: GatewayChatMessage): Message {
	const content: Array<
		| { type: "text"; text: string }
		| { type: "thinking"; thinking: string }
		| { type: "toolCall"; id: string; name: string; arguments: JsonObject }
	> = [];
	const needsPlaceholder = message.tool_calls !== undefined && message.tool_calls.length > 0;
	const reasoning = message.reasoning_content ?? (needsPlaceholder ? "" : undefined);
	if (reasoning !== undefined) content.push({ type: "thinking", thinking: reasoning });
	if (message.content.length > 0) content.push({ type: "text", text: message.content });
	if (message.tool_calls !== undefined) {
		for (const call of message.tool_calls) {
			content.push({
				type: "toolCall",
				id: call.id,
				name: call.name,
				arguments: parseToolArguments(call.arguments),
			});
		}
	}
	return {
		role: "assistant",
		content: content.length === 0 ? [{ type: "text", text: "" }] : content,
		api: "openai-responses",
		provider: "gateway",
		model: "gateway",
		usage: EMPTY_USAGE,
		stopReason: needsPlaceholder ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
}

function toPiTool(tool: GatewayTool): Tool {
	return {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters as Tool["parameters"],
	};
}

/**
 * Coerce parsed tool arguments into the strict `JsonObject` shape pi-ai 0.87+
 * demands on `ToolCall.arguments` (it was `Record<string, any>` through 0.84).
 * The gateway parses untrusted client JSON, so anything that is not a JSON
 * value is dropped rather than smuggled through the type boundary; a value
 * that is not a plain object is wrapped under `value` exactly as before.
 */
function toJsonObject(value: Record<string, unknown>): JsonObject {
	const out: Record<string, JsonObject[string]> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (isJsonValue(entry)) out[key] = entry;
	}
	return out as JsonObject;
}

function isJsonValue(value: unknown): value is JsonObject[string] {
	if (value === null) return true;
	const kind = typeof value;
	if (kind === "string" || kind === "number" || kind === "boolean") return true;
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (kind === "object") return Object.values(value as Record<string, unknown>).every(isJsonValue);
	return false;
}

function parseToolArguments(raw: string): JsonObject {
	try {
		const value = JSON.parse(raw) as unknown;
		if (typeof value === "object" && value !== null && !Array.isArray(value)) {
			return toJsonObject(value as Record<string, unknown>);
		}
		// A parsed non-object (array or scalar) is already a JSON value and keeps
		// its historical `{ value }` wrapper; a parse result that is neither
		// falls back to the raw string.
		return isJsonValue(value) ? { value } : { value: raw };
	} catch {
		return { value: raw };
	}
}

function stringifyToolArguments(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value ?? {});
	} catch {
		return "{}";
	}
}

function resolveReasoning(value: string | undefined, ownedBy: string): ThinkingLevel | undefined {
	if (value === undefined || !isThinkingLevel(value)) return undefined;
	if (ownedBy === "kimi-code-oauth" || ownedBy === "claude-code-oauth") return undefined;
	return value as ThinkingLevel;
}

async function collectOwnedModels(
	grok: GrokBuildSession,
	subscriptions: readonly OAuthProviderSession[],
): Promise<OwnedModel[]> {
	const owned: OwnedModel[] = [];
	const grokAuth = await grok.models.getAuth("xai");
	if (grokAuth?.auth.apiKey) {
		// The xai collection owns OAuth refresh, not Grok Build inference.
		const provider = grok.provider();
		const apiKey = grokAuth.auth.apiKey;
		for (const model of grok.visibleModels()) {
			owned.push({
				owned_by: "grok-build",
				model,
				stream: (item, context, options) =>
					provider.streamSimple(item, normalizeContext(context), {
						...options,
						apiKey,
						...(provider.headers === undefined ? {} : { headers: provider.headers }),
					}),
			});
		}
	}
	for (const session of subscriptions) {
		const status = await session.status();
		if (!status.authenticated) continue;
		for (const model of session.visibleModels()) {
			owned.push({
				owned_by: session.definition.route,
				model,
				stream: (item, context, options) => session.models.streamSimple(item, context, options),
			});
		}
	}
	return owned;
}

export function gatewayErrorEnvelope(error: unknown): {
	status: number;
	body: { error: { message: string; type: string; code: string } };
} {
	if (error instanceof GatewayRequestError) {
		return {
			status: error.status,
			body: { error: { message: error.message.slice(0, 1000), type: "invalid_request_error", code: error.code } },
		};
	}
	return {
		status: 500,
		body: { error: { message: safeMessage(error).slice(0, 1000), type: "server_error", code: "internal" } },
	};
}
