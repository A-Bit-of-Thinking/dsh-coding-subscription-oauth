import type { AccountRoutingRuntime } from "./account-runtime.js";
import type { CapabilityRouteContext } from "./capability-routes.js";
import type { RoutingConfig } from "./routing-config.js";
import { type RoutingSettingsController } from "./routing-settings.js";
import { type OwnerRequestPolicy } from "./web-origin.js";
export declare const ROUTING_STATUS_PATH: string;
export declare const ROUTING_USAGE_PATH: string;
export declare const ROUTING_SETTINGS_PATH: string;
export interface RoutingRouteOptions {
    readonly current: () => RoutingConfig;
    readonly accounts: AccountRoutingRuntime;
    readonly settings: RoutingSettingsController;
    readonly ownerRequestPolicy?: OwnerRequestPolicy;
}
/** Status for display: flags, policy validity only (never the policy text), routes and quotas. */
export declare function publicRoutingStatus(options: Pick<RoutingRouteOptions, "current" | "accounts">): {
    state: import("./account-runtime.js").AccountRuntimeState;
    accounts: readonly import("./account-runtime.js").RoutedAccountStatus[];
    flags: {
        enabled: boolean;
        usageEnabled: boolean;
        guidanceEnabled: boolean;
        enforcePolicy: boolean;
    };
    policy: {
        state: "invalid" | "empty" | "valid";
    };
};
export declare function registerRoutingRoutes(ctx: CapabilityRouteContext, options: RoutingRouteOptions): void;
//# sourceMappingURL=routing-routes.d.ts.map