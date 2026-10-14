/** Fixed-account registrations are separate from the legacy/Fast registration owner. */
import type { AttachmentStore } from "@deepseek-ai/dsh-attachment";
import { type LlmAdapter } from "@deepseek-ai/dsh-llm";
import { type AccountRouteRegistry, type AccountRouteView } from "./account-routes.js";
import { type ClaudeUsage } from "./claude-usage.js";
import type { OAuthProviderSession } from "./oauth-session.js";
import type { RoutingConfig } from "./routing-config.js";
export type AccountRuntimeState = "disabled" | "waiting-for-llm" | "loading" | "ready" | "error";
export type AccountAdapterRegistrar = (routes: string[], adapter: LlmAdapter) => () => void;
export interface RoutedAccountStatus extends AccountRouteView {
    quota: {
        state: "disabled" | "unsupported" | "unknown" | "fresh" | "stale" | "error";
        windows: ClaudeUsage["windows"];
        fetchedAt?: number;
        errorCode?: string;
    };
}
export interface AccountRuntimeOptions {
    registry: AccountRouteRegistry;
    sessions: readonly OAuthProviderSession[];
    current(): RoutingConfig;
    resolveAttachments(): AttachmentStore | undefined;
    fetchImpl?: typeof fetch;
    onError?(): void;
}
export declare class AccountRoutingRuntime {
    private readonly options;
    private entries;
    private registrar;
    private epoch;
    private state;
    private disposed;
    constructor(options: AccountRuntimeOptions);
    private clear;
    dispose(): void;
    /** The LLM child may disappear; OAuth/settings ownership remains in the parent. */
    attach(registrar: AccountAdapterRegistrar): () => void;
    /**
     * Differential: unchanged routes keep their adapter (and any request in flight);
     * only removed or recreated accounts are withdrawn. A transient read or
     * metadata error keeps the already validated routes and reports `error`.
     */
    reconcile(): Promise<void>;
    snapshot(): {
        state: AccountRuntimeState;
        accounts: readonly RoutedAccountStatus[];
    };
    /** No network occurs in snapshots/prompt assembly; only this explicit opt-in operation reads quotas. */
    refreshUsage(route?: string, signal?: AbortSignal): Promise<ReturnType<AccountRoutingRuntime["snapshot"]>>;
}
//# sourceMappingURL=account-runtime.d.ts.map