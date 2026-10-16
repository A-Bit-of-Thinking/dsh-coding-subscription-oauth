/** Fixed-account registrations are separate from the legacy/Fast registration owner. */
import type { AttachmentStore } from "@deepseek-ai/dsh-attachment";
import { type LlmAdapter } from "@deepseek-ai/dsh-llm";
import { type AccountDisplay } from "./account-names.js";
import { type QuotaState, type QuotaWindow } from "./account-quota.js";
import { type AccountRouteRegistry, type AccountRouteView } from "./account-routes.js";
import type { OAuthProviderSession } from "./oauth-session.js";
import type { RoutingConfig } from "./routing-config.js";
export type AccountRuntimeState = "disabled" | "waiting-for-llm" | "loading" | "ready" | "error";
/**
 * What the host returns for a registered adapter: the disposer, plus an atomic route replacement for the
 * same adapter instance. `replace` re-reads providerInfo (the host snapshots names at registration) and
 * announces the catalog change itself; it never interrupts a request in flight.
 */
export type AccountRegistration = (() => void) & {
    replace(routes: string[]): void;
};
export type AccountAdapterRegistrar = (routes: string[], adapter: LlmAdapter) => AccountRegistration;
/**
 * Quota states: `disabled` (quota reads off), `unsupported` (no reader for this family), `not-read`
 * (never read since startup), `fresh` (read < 5 min ago), `stale` (older, or a later read failed),
 * `error` (every read failed so far; `errorCode` says why), `unknown` (read, but no usable window:
 * `errorCode` is NO_WINDOWS). None of them means "zero used".
 */
export interface RoutedAccountStatus extends AccountRouteView, AccountDisplay {
    quota: {
        state: QuotaState;
        windows: readonly QuotaWindow[];
        fetchedAt?: number;
        errorCode?: string;
        /** When the next automatic read of this route is expected (epoch ms); absent while no schedule is active. */
        nextRefreshAt?: number;
    };
}
export interface AccountRuntimeOptions {
    registry: AccountRouteRegistry;
    sessions: readonly OAuthProviderSession[];
    current(): RoutingConfig;
    resolveAttachments(): AttachmentStore | undefined;
    fetchImpl?: typeof fetch;
    onError?(): void;
    /**
     * The name the legacy (default-account) route shows changed. The legacy route belongs to another
     * registration, so the owner must `replace` its routes (the host snapshots provider names at
     * registration); fixed account routes are replaced here, through their own registration.
     */
    onLegacyDisplayChange?(): void;
}
export declare class AccountRoutingRuntime {
    private readonly options;
    private entries;
    private throttles;
    private registrar;
    private epoch;
    private state;
    private disposed;
    /** family -> "Claude Â· <name> (par dÃ©faut)" for the legacy route; empty until a reconcile succeeds. */
    private defaultNames;
    /** Automatic quota reads: present only while routing and quota reads are both enabled and attached. */
    private timer;
    private nextTickAt;
    constructor(options: AccountRuntimeOptions);
    /** Synchronous (providerInfo cannot await): name the legacy route shows for the default account. */
    defaultRouteName(family: string): string | undefined;
    /**
     * Set (or clear with null/empty) the label of the account behind `route`, then refresh names.
     * Adapters are kept, so a request in flight is never interrupted. Errors carry no label.
     * The answer always reflects the label actually written: should the reconciliation fail or be
     * superseded, the renamed row is recomputed from the store instead of echoing the previous name.
     */
    renameAccount(route: string, label: unknown): Promise<ReturnType<AccountRoutingRuntime["snapshot"]>>;
    /** Withdraws every route; returns whether the legacy route was showing a default-account name. */
    private clear;
    dispose(): void;
    /** The LLM child may disappear; OAuth/settings ownership remains in the parent. */
    attach(registrar: AccountAdapterRegistrar): () => void;
    private notifyLegacyDisplayChange;
    /**
     * Differential: unchanged routes keep their adapter (and any request in flight);
     * only removed or recreated accounts are withdrawn. A transient read or
     * metadata error keeps the already validated routes and reports `error`.
     */
    reconcile(): Promise<void>;
    private quotaState;
    /** Next timer tick that will reconsider this route (null when no schedule is active). */
    private nextRefreshAt;
    /** Pure: no network, no await. Prompt assembly and HTTP status rely on that. */
    snapshot(): {
        state: AccountRuntimeState;
        accounts: readonly RoutedAccountStatus[];
    };
    private live;
    /**
     * Starts a read of one route, or joins the one in flight. Returns undefined when the route has no
     * reader or was attempted less than the minimal delay ago (the caller then keeps the current
     * snapshot, never an error). The read has its own deadline: no caller can abort it for the others.
     */
    private startRead;
    /** Waits for the reads, but at most `timeoutMs` and never past `signal`; the reads themselves go on. */
    private waitFor;
    private syncSchedule;
    private stopSchedule;
    private tick;
    private autoRead;
    /**
     * Explicit read of one route or all. Reads are never closer than the minimal delay per route
     * (including timer reads): a throttled route simply keeps its current snapshot. `timeoutMs` bounds
     * the wait, not the read. `onlyIfNeeded` skips routes that are fresh (or unsupported/unknown).
     * No network happens in snapshots or prompt assembly; only this method and the timer read quotas.
     */
    refreshUsage(route?: string, signal?: AbortSignal, options?: {
        timeoutMs?: number;
        onlyIfNeeded?: boolean;
    }): Promise<ReturnType<AccountRoutingRuntime["snapshot"]>>;
}
//# sourceMappingURL=account-runtime.d.ts.map