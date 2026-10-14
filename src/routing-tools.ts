import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { AccountRoutingRuntime } from "./account-runtime.ts";
import type { RoutingConfig } from "./routing-config.ts";
import { routingPolicySnapshot } from "./routing-guidance.ts";

export const CODING_SUBSCRIPTION_STATUS_TOOL = "coding_subscription_status";
export function subscriptionRoutingStatus(current: RoutingConfig, accounts: AccountRoutingRuntime) {
	return {
		configuration: {
			enabled: current.enabled,
			usageEnabled: current.usageEnabled,
			guidanceEnabled: current.guidanceEnabled,
			enforcePolicy: current.enforcePolicy,
		},
		// The policy text is only disclosed to agents when the operator enabled guidance.
		policy: current.guidanceEnabled ? routingPolicySnapshot(current) : { state: routingPolicySnapshot(current).state },
		...accounts.snapshot(),
		limitations: {
			enforcementScope: "this-plugin-routes-only",
			delegation: "all-authorized-models-within-host-depth-and-shared-capacity",
			guidance: "global-system-section; complete-prompt-presets-can-replace-sections; this-tool-retains-full-policy",
			sessionCatalog: "new-routes-may-require-a-new-session-or-a-host-whitelist-refresh",
			quotas: "Claude-general-windows-only; private-endpoint-current-availability-not-verified; unknown-is-not-zero",
		},
	};
}
export async function createRoutingStatusTool(options: {
	current(): RoutingConfig;
	accounts: AccountRoutingRuntime;
}): Promise<ToolDefinition> {
	const { defineTool } = await import("@deepseek-ai/dsh-tools");
	return defineTool({
		name: CODING_SUBSCRIPTION_STATUS_TOOL,
		description:
			"Consult the complete operator-authored model/effort/delegation policy, fixed subscription account routes, cached five-hour/weekly quota windows and reset/freshness. No model/account substitution. Explicit quota refresh requires operator opt-in; never treat unknown as zero or repeatedly retry rate limits.",
		parameters: {
			refresh: {
				type: "boolean",
				description: "Explicitly refresh quota data when opted in. Default false: cached state only.",
			},
			route: {
				type: "string",
				description: "Optional fixed account route to refresh; omitted selects all registered accounts.",
			},
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { report: { type: "string", required: true } },
			},
			render: (_args, value) => [{ type: "text", text: value.report }],
		},
		async execute(args, exec) {
			if (args.refresh === true) await options.accounts.refreshUsage(args.route, exec.signal);
			return { report: JSON.stringify(subscriptionRoutingStatus(options.current(), options.accounts)) };
		},
	});
}
