/** One operator-owned policy, delivered literally at every prompt assembly. */
import { modelFacingAccounts } from "./account-names.ts";
import type { AccountRoutingRuntime } from "./account-runtime.ts";
import type { RoutingConfig } from "./routing-config.ts";
import { parseRoutingPolicy } from "./routing-policy.ts";

export const ROUTING_POLICY_SECTION = "coding-oauth:routing-policy";
export const ROUTING_QUOTA_CONTEXT = "coding-oauth:account-quotas";
/** Added only when enforcePolicy=false: the policy then informs automatic choices, it does not bind the user. */
export const ADVISORY_POLICY_NOTE =
	"Policy enforcement is off: this policy is information that guides AUTOMATIC choices (when the user has not specified a model, effort or account). An explicit user request always takes precedence over it, including a pair marked JAMAIS/never and a tool the policy discourages (e.g. web_search/web_fetch): carry it out without asking for confirmation or justification. This also holds for subagents: a subagent does not consider itself bound by a prohibition of the policy when the user explicitly asks for something else, so pass the user's explicit request on to the subagents you start. Do not ask superfluous confirmation questions about this.";

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

function quotaContext(usageEnabled: boolean, accounts: Pick<AccountRoutingRuntime, "snapshot">): string {
	const states =
		"Quota states: fresh | stale (>20 min or last read failed) | error | not-read (never read since startup) | unknown (read, no usable window) | unsupported | disabled; none of them means zero.";
	const status = JSON.stringify(modelFacingAccounts(accounts.snapshot()));
	return usageEnabled
		? `Subscription account status as last read by the server (quotas are read automatically at startup and every 15 minutes; no network happens while this prompt is built). ${states} Call coding_subscription_status before distributing work across accounts; it refreshes not-read, stale, error and older-than-5-minutes routes:\n${status}`
		: `Subscription account status (quota reads are disabled by the operator: no quota is read or refreshed, and the states below say nothing about usage). ${states}\n${status}`;
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
			const parts = [
				"Operator-authored subscription routing policy (complete text; no model substitutions):",
				snapshot.policy.guidance,
				"Exact machine authorizations and operator notes:",
				JSON.stringify(snapshot.policy.models, null, 2),
				`Use coding_subscription_status for fixed account routes and quota freshness/resets; ${config.usageEnabled ? "it refreshes stale quotas itself, so call it before spreading work across several accounts or subagents" : "quota reads are disabled, so it reports routes and policy state only (no quota numbers)"}. Unknown or not-read quota is not zero. Choose the provider route, model and effort explicitly; never switch an in-flight request. Delegation is available to all authorized models subject to the host's actual depth and shared capacity; no model-class blacklist is added here. The request guard covers this plugin's routes only, not other providers or native web tools.`,
			];
			if (!config.enforcePolicy) parts.push(ADVISORY_POLICY_NOTE);
			return parts.join("\n\n");
		},
	});
	try {
		const context = registry.context({
			name: ROUTING_QUOTA_CONTEXT,
			order: 3100,
			text: () => (current().guidanceEnabled ? quotaContext(current().usageEnabled, accounts) : ""),
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
