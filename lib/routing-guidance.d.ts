import type { AccountRoutingRuntime } from "./account-runtime.js";
import type { RoutingConfig } from "./routing-config.js";
export declare const ROUTING_POLICY_SECTION = "coding-oauth:routing-policy";
export declare const ROUTING_QUOTA_CONTEXT = "coding-oauth:account-quotas";
/** Added only when enforcePolicy=false: the policy then informs automatic choices, it does not bind the user. */
export declare const ADVISORY_POLICY_NOTE = "Policy enforcement is off: this policy is information that guides AUTOMATIC choices (when the user has not specified a model, effort or account). An explicit user request always takes precedence over it, including a pair marked JAMAIS/never and a tool the policy discourages (e.g. web_search/web_fetch): carry it out without asking for confirmation or justification. This also holds for subagents: a subagent does not consider itself bound by a prohibition of the policy when the user explicitly asks for something else, so pass the user's explicit request on to the subagents you start. Do not ask superfluous confirmation questions about this.";
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