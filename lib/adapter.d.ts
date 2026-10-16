/** Coding-subscription adapter assembled from public dsh-llm-pi-ai extension points. */
import type { AttachmentStore } from "@deepseek-ai/dsh-attachment";
import type { RetryPolicyConfig } from "@deepseek-ai/dsh-llm";
import { type LlmAdapter } from "@deepseek-ai/dsh-llm";
import type { ResolvedPiAiProviderProfile } from "@deepseek-ai/dsh-llm-pi-ai";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import type { OAuthProviderSession } from "./oauth-session.js";
import type { GrokBuildSession } from "./session.js";
/** Prefer grok-4.6 when the current (live or baseline) list has it. */
export declare function preferredGrokBuildModel(models?: readonly {
    id: string;
}[]): string;
export declare function codingOAuthProfile(provider: string, displayName: string, piProvider: ResolvedPiAiProviderProfile["piProvider"], retryPolicy?: RetryPolicyConfig | undefined, headers?: Record<string, string> | undefined): ResolvedPiAiProviderProfile & {
    modelErrors: Map<string, string>;
};
/** Existing Grok-only constructor retained for public API compatibility. */
export declare function createGrokBuildAdapter(session: GrokBuildSession, resolveAttachments: () => AttachmentStore | undefined): PiAiAdapter;
/** Opt-in Codex Fast wiring; ordinary `codex-oauth` is unchanged when this is omitted. */
export interface CodingOAuthAdapterOptions {
    retryPolicy?: RetryPolicyConfig;
    codexFast?: {
        isEligible(modelId: string): boolean;
    };
    /**
     * Live name of the default account per family ("Claude · <name> (par défaut)"), read on every
     * providerInfo call. Undefined keeps the static "<Family> (OAuth)" name.
     */
    defaultAccountName?: (family: string) => string | undefined;
}
/** Create the four-route OAuth adapter while preserving each pi-ai native id. */
export declare function createCodingOAuthAdapter(grok: GrokBuildSession, subscriptions: readonly OAuthProviderSession[], resolveAttachments: () => AttachmentStore | undefined, retryPolicy?: RetryPolicyConfig, options?: CodingOAuthAdapterOptions): LlmAdapter;
export declare function createCodingOAuthAdapter(grok: GrokBuildSession, subscriptions: readonly OAuthProviderSession[], resolveAttachments: () => AttachmentStore | undefined, options?: CodingOAuthAdapterOptions): LlmAdapter;
//# sourceMappingURL=adapter.d.ts.map