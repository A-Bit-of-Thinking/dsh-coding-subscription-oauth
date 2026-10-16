import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { AccountRoutingRuntime } from "./account-runtime.js";
import type { RoutingConfig } from "./routing-config.js";
import type { RoutingPolicy } from "./routing-policy.js";
export declare const CODING_SUBSCRIPTION_STATUS_TOOL = "coding_subscription_status";
/** Upper bound on the time the tool waits for a quota refresh before answering with the cached state. */
export declare const STATUS_REFRESH_TIMEOUT_MS = 8000;
export declare function subscriptionRoutingStatus(current: RoutingConfig, accounts: Pick<AccountRoutingRuntime, "snapshot">, options?: {
    includePolicy?: boolean;
    quotaRefresh?: string;
}): {
    limitations: {
        enforcementScope: string;
        delegation: string;
        guidance: string;
        sessionCatalog: string;
        quotas: string;
    };
    quotaRefresh?: string;
    state: import("./account-runtime.js").AccountRuntimeState;
    accounts: {
        name: string;
        isDefault: boolean;
        route: string;
        quota: {
            state: import("./account-quota.js").QuotaState;
            windows: readonly import("./account-quota.js").QuotaWindow[];
            fetchedAt?: number;
            errorCode?: string;
            nextRefreshAt?: number;
        };
    }[];
    configuration: {
        enabled: boolean;
        usageEnabled: boolean;
        guidanceEnabled: boolean;
        enforcePolicy: boolean;
    };
    policy: {
        state: "empty" | "valid";
        policy: RoutingPolicy | undefined;
    } | {
        state: "invalid";
        policy: undefined;
    } | {
        state: "invalid" | "empty" | "valid";
        length?: never;
        models?: never;
        note?: never;
    } | {
        state: "empty" | "valid";
        length: number;
        models: string[];
        note: string;
    };
};
export declare function createRoutingStatusTool(options: {
    current(): RoutingConfig;
    accounts: AccountRoutingRuntime;
}): Promise<ToolDefinition>;
//# sourceMappingURL=routing-tools.d.ts.map