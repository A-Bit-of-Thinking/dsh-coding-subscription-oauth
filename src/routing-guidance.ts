/** One operator-owned policy, delivered literally at every prompt assembly. */
import type { AccountRoutingRuntime } from "./account-runtime.ts";
import type { RoutingConfig } from "./routing-config.ts";
import { parseRoutingPolicy } from "./routing-policy.ts";

export const ROUTING_POLICY_SECTION = "coding-oauth:routing-policy";
export const ROUTING_QUOTA_CONTEXT = "coding-oauth:account-quotas";
export interface RoutingPromptRegistry {
	section(section: {
		name: string;
		order: number;
		text: string | ((context: unknown) => string);
		interpolate?: boolean;
	}): () => void;
	context(context: { name: string; order: number; text: string | ((context: unknown) => string) }): () => void;
}
export function routingPolicySnapshot(current: RoutingConfig) {
	try {
		const policy = parseRoutingPolicy(current.policyJson);
		return { state: policy === undefined ? ("empty" as const) : ("valid" as const), policy };
	} catch {
		return { state: "invalid" as const, policy: undefined };
	}
}

/** Register globally on the owner's context, never as a complete persona replacement. */
export function registerRoutingGuidance(
	registry: RoutingPromptRegistry,
	current: () => RoutingConfig,
	accounts: Pick<AccountRoutingRuntime, "snapshot">,
): () => void {
	const section = registry.section({
		name: ROUTING_POLICY_SECTION,
		order: 3100,
		interpolate: false,
		text: () => {
			const config = current();
			if (!config.guidanceEnabled) return "";
			const snapshot = routingPolicySnapshot(config);
			if (snapshot.state !== "valid" || snapshot.policy === undefined)
				return "Operator routing policy is missing or invalid. Consult coding_subscription_status; do not invent authorizations.";
			return [
				"Operator-authored subscription routing policy (complete text; no model substitutions):",
				snapshot.policy.guidance,
				"Exact machine authorizations and operator notes:",
				JSON.stringify(snapshot.policy.models, null, 2),
				"Use coding_subscription_status for fixed account routes and quota freshness/resets. Unknown quota is not zero. Choose the provider route, model and effort explicitly; never switch an in-flight request. Delegation is available to all authorized models subject to the host's actual depth and shared capacity; no model-class blacklist is added here. The request guard covers this plugin's routes only, not other providers or native web tools.",
			].join("\n\n");
		},
	});
	try {
		const context = registry.context({
			name: ROUTING_QUOTA_CONTEXT,
			order: 3100,
			text: () =>
				current().guidanceEnabled
					? `Cached subscription account status (no implicit network; refresh explicitly if stale/unknown):\n${JSON.stringify(accounts.snapshot())}`
					: "",
		});
		return () => {
			context();
			section();
		};
	} catch (error) {
		section();
		throw error;
	}
}
