import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { AccountRoutingRuntime } from "./account-runtime.js";
import type { RoutingConfig } from "./routing-config.js";
export declare const CODING_SUBSCRIPTION_STATUS_TOOL = "coding_subscription_status";
export declare function subscriptionRoutingStatus(current: RoutingConfig, accounts: AccountRoutingRuntime): {
    limitations: {
        enforcementScope: string;
        delegation: string;
        guidance: string;
        sessionCatalog: string;
        quotas: string;
    };
    state: import("./account-runtime.js").AccountRuntimeState;
    accounts: readonly import("./account-runtime.js").RoutedAccountStatus[];
    configuration: {
        enabled: boolean;
        usageEnabled: boolean;
        guidanceEnabled: boolean;
        enforcePolicy: boolean;
    };
    policy: {
        state: "empty" | "valid";
        policy: import("./routing-policy.js").RoutingPolicy | undefined;
    } | {
        state: "invalid";
        policy: undefined;
    } | {
        state: "invalid" | "empty" | "valid";
    };
};
export declare function createRoutingStatusTool(options: {
    current(): RoutingConfig;
    accounts: AccountRoutingRuntime;
}): Promise<ToolDefinition>;
//# sourceMappingURL=routing-tools.d.ts.map