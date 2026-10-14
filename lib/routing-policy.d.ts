import type { GenerateOptions, PreparedAdapterCall, StreamChunk } from "@deepseek-ai/dsh-llm";
import { LlmAdapter } from "@deepseek-ai/dsh-llm";
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
    current: () => {
        enforcePolicy: boolean;
        policyJson: string;
    };
    familyForRoute: (provider: string) => RoutingFamily | undefined;
}
/** Empty means no policy. Invalid nonempty input throws a sanitized INVALID_ARGS error. */
export declare function parseRoutingPolicy(json: string, now?: number): RoutingPolicy | undefined;
/** No default effort, substitution, automatic exception approval or capability restriction. */
export declare function assertRoutingAllowed(policy: RoutingPolicy, family: RoutingFamily, model: string, effort: string | undefined, now?: number): void;
/** Own routes only; every streamed purpose, including compaction, receives the same check. */
export declare class RoutingPolicyAdapter extends LlmAdapter {
    private readonly inner;
    private readonly options;
    constructor(inner: LlmAdapter, options: RoutingPolicyAdapterOptions);
    providerInfo(provider: string): import("@deepseek-ai/dsh-llm").LlmProviderInfo;
    listModels(provider: string): Promise<readonly import("@deepseek-ai/dsh-llm").LlmModelInfo[]>;
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<import("@deepseek-ai/dsh-llm").LlmResolvedModelInfo>;
    providerRetryPolicy(provider: string): import("@deepseek-ai/dsh-llm").ResolvedRetryPolicy | undefined;
    imageRequestPricing(provider: string, model: string): import("@deepseek-ai/dsh-llm").LlmImageRequestPricing | undefined;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>;
    private assertAllowed;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
//# sourceMappingURL=routing-policy.d.ts.map