import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { modelFacingAccounts } from "./account-names.ts";
import type { AccountRoutingRuntime } from "./account-runtime.ts";
import type { RoutingConfig } from "./routing-config.ts";
import { routingPolicySnapshot } from "./routing-guidance.ts";
import type { RoutingPolicy } from "./routing-policy.ts";

export const CODING_SUBSCRIPTION_STATUS_TOOL = "coding_subscription_status";
/** Upper bound on the time the tool waits for a quota refresh before answering with the cached state. */
export const STATUS_REFRESH_TIMEOUT_MS = 8_000;
const POLICY_IN_PROMPT_NOTE =
	"Full policy is already in the system prompt; call again with include_policy=true to re-read it.";
const GUIDANCE_IN_PROMPT = "global-system-section; complete-prompt-presets-can-replace-sections";
const GUIDANCE_NOT_IN_PROMPT = "off; policy-not-injected-in-the-system-prompt";
const NO_EFFORT = "aucun effort autorisé";

function modelLine(entry: RoutingPolicy["models"][number], now: number): string {
	const allowed = entry.allowedEfforts.length === 0 ? NO_EFFORT : entry.allowedEfforts.join(", ");
	const exceptions = entry.exceptionEfforts ?? [];
	if (exceptions.length === 0) return `${entry.family}/${entry.model}: ${allowed}`;
	const until = entry.exceptionApprovedUntil;
	const approval =
		typeof until === "number" && until > now ? `approved until ${new Date(until).toISOString()}` : "not approved";
	return `${entry.family}/${entry.model}: ${allowed} (exception: ${exceptions.join(", ")}, ${approval})`;
}

/** Compact policy view: no guidance text, only what is needed to double-check authorizations. */
function policySummary(current: RoutingConfig) {
	const snapshot = routingPolicySnapshot(current);
	if (snapshot.policy === undefined) return { state: snapshot.state };
	const now = Date.now();
	return {
		state: snapshot.state,
		length: JSON.stringify(snapshot.policy).length,
		models: snapshot.policy.models.map((entry) => modelLine(entry, now)),
		note: POLICY_IN_PROMPT_NOTE,
	};
}

export function subscriptionRoutingStatus(
	current: RoutingConfig,
	accounts: Pick<AccountRoutingRuntime, "snapshot">,
	options: { includePolicy?: boolean; quotaRefresh?: string } = {},
) {
	// The policy text is only disclosed to agents when the operator enabled guidance.
	const policy = !current.guidanceEnabled
		? { state: routingPolicySnapshot(current).state }
		: options.includePolicy === true
			? routingPolicySnapshot(current)
			: policySummary(current);
	return {
		configuration: {
			enabled: current.enabled,
			usageEnabled: current.usageEnabled,
			guidanceEnabled: current.guidanceEnabled,
			enforcePolicy: current.enforcePolicy,
		},
		policy,
		...modelFacingAccounts(accounts.snapshot()),
		...(options.quotaRefresh === undefined ? {} : { quotaRefresh: options.quotaRefresh }),
		limitations: {
			enforcementScope: "this-plugin-routes-only",
			delegation: "all-authorized-models-within-host-depth-and-shared-capacity",
			guidance: current.guidanceEnabled
				? `${GUIDANCE_IN_PROMPT}; this-tool-returns-full-policy-with-include_policy-true`
				: `${GUIDANCE_NOT_IN_PROMPT}; the-policy-text-is-not-available-while-guidance-is-off`,
			sessionCatalog: "new-routes-may-require-a-new-session-or-a-host-whitelist-refresh",
			quotas:
				"Claude-and-Codex-five-hour/weekly-windows-only; private-endpoints-current-availability-not-verified; states: fresh|stale|error|not-read|unknown|unsupported|disabled; not-read/unknown-is-not-zero",
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
			"Consult fixed subscription account routes, five-hour/weekly quota windows with reset and freshness, plus a compact policy summary (state, size, authorized models/efforts). Quotas are refreshed automatically by the server (at startup then every 15 minutes) and, when quota reads are enabled, this tool first refreshes any route that is not-read, stale (>5 min) or in error (at most 8 s of waiting; never more than one read per route per minute; failures are not fatal), so the status is already up to date: no need to call it twice. The complete operator policy is already in the system prompt when guidance is on: set include_policy=true only if it is not visible in your context or you doubt it. No model/account substitution; never treat unknown or not-read as zero; never retry rate limits in a loop.",
		parameters: {
			include_policy: {
				type: "boolean",
				description:
					"Return the complete policy text and authorizations. Default false: compact summary only (use true only if the policy is not in your context or you doubt it).",
			},
			refresh: {
				type: "boolean",
				description:
					"Force a quota read now, even for a fresh route. Optional (stale data is already refreshed automatically). Still limited to one read per route per minute; requires quota reads to be enabled by the operator.",
			},
			route: {
				type: "string",
				description:
					"With refresh=true: the single fixed account route to read; omitted selects all registered accounts.",
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
			const current = options.current();
			const forced = args.refresh === true;
			let quotaRefresh: string | undefined;
			if (!current.usageEnabled) {
				if (forced) quotaRefresh = "skipped: quota reads are disabled by the operator";
			} else if (forced) {
				try {
					await options.accounts.refreshUsage(args.route, exec.signal, { timeoutMs: STATUS_REFRESH_TIMEOUT_MS });
				} catch {
					// An unknown or just-withdrawn route is a skip, not a failure of the whole status.
					quotaRefresh = "skipped: the requested route is unknown or unavailable";
				}
			} else {
				try {
					await options.accounts.refreshUsage(undefined, exec.signal, {
						timeoutMs: STATUS_REFRESH_TIMEOUT_MS,
						onlyIfNeeded: true,
					});
				} catch {
					// Best effort: the cached state is still a valid answer.
				}
			}
			return {
				report: JSON.stringify(
					subscriptionRoutingStatus(options.current(), options.accounts, {
						includePolicy: args.include_policy === true,
						...(quotaRefresh === undefined ? {} : { quotaRefresh }),
					}),
				),
			};
		},
	});
}
