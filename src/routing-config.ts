/** Separate opt-ins: registration, quota reads, full guidance, and request enforcement. */
import z from "@deepseek-ai/schemastery";

export interface RoutingConfig {
	enabled: boolean;
	usageEnabled: boolean;
	guidanceEnabled: boolean;
	enforcePolicy: boolean;
	policyJson: string;
}
export interface RoutingConfigReference {
	get(): unknown;
}
export const RoutingConfigSchema = z.object({
	enabled: z
		.boolean()
		.default(false)
		.description("Register a distinct, fixed route for each connected subscription account."),
	usageEnabled: z
		.boolean()
		.default(false)
		.description(
			"Allow explicit quota refreshes for routed Claude accounts (private endpoint, availability not guaranteed).",
		),
	guidanceEnabled: z
		.boolean()
		.default(false)
		.description("Deliver the complete operator-authored routing policy to agent system prompts."),
	enforcePolicy: z
		.boolean()
		.default(false)
		.description("Reject disallowed model/effort requests on this plugin's routes, without substitutions."),
	policyJson: z
		.string()
		.default("")
		.role("textarea")
		.description(
			"Operator policy JSON. Do not enter credentials. Empty public default; personal policies are not packaged.",
		),
});
export function readRoutingConfig(input: Partial<RoutingConfig> | RoutingConfigReference | undefined): RoutingConfig {
	const value: unknown = input !== undefined && "get" in input ? input.get() : input;
	const row = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
	return {
		enabled: row.enabled === true,
		usageEnabled: row.usageEnabled === true,
		guidanceEnabled: row.guidanceEnabled === true,
		enforcePolicy: row.enforcePolicy === true,
		policyJson: typeof row.policyJson === "string" ? row.policyJson : "",
	};
}
