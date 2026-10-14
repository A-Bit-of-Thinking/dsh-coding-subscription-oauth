/** One operator-owned policy, delivered literally at every prompt assembly. */
import type { AccountRoutingRuntime } from "./account-runtime.js";
import type { RoutingConfig } from "./routing-config.js";
export declare const ROUTING_POLICY_SECTION = "coding-oauth:routing-policy";
export declare const ROUTING_QUOTA_CONTEXT = "coding-oauth:account-quotas";
export interface RoutingPromptRegistry {
    section(section: {
        name: string;
        order: number;
        text: string | ((context: unknown) => string);
        interpolate?: boolean;
    }): () => void;
    context(context: {
        name: string;
        order: number;
        text: string | ((context: unknown) => string);
    }): () => void;
}
export declare function routingPolicySnapshot(current: RoutingConfig): {
    state: "empty" | "valid";
    policy: import("./routing-policy.js").RoutingPolicy | undefined;
} | {
    state: "invalid";
    policy: undefined;
};
/** Register globally on the owner's context, never as a complete persona replacement. */
export declare function registerRoutingGuidance(registry: RoutingPromptRegistry, current: () => RoutingConfig, accounts: Pick<AccountRoutingRuntime, "snapshot">): () => void;
//# sourceMappingURL=routing-guidance.d.ts.map