import { describe, expect, it, vi } from "vitest";
import { readRoutingConfig } from "../src/routing-config.ts";
import {
	CODING_SUBSCRIPTION_STATUS_TOOL,
	createRoutingStatusTool,
	STATUS_REFRESH_TIMEOUT_MS,
	subscriptionRoutingStatus,
} from "../src/routing-tools.ts";

const SECRET_TEXT = "OPERATOR_POLICY_TEXT_THAT_MUST_STAY_PRIVATE";
const policyJson = JSON.stringify({ version: 1, guidance: SECRET_TEXT, models: [] });
const accounts = { snapshot: () => ({ state: "disabled" as const, accounts: [] }) };

describe("coding_subscription_status disclosure", () => {
	it("does not reveal the policy text unless the operator enabled guidance", () => {
		const off = subscriptionRoutingStatus({ ...readRoutingConfig(undefined), policyJson }, accounts as never);
		expect(JSON.stringify(off)).not.toContain(SECRET_TEXT);
		expect(off.policy).toEqual({ state: "valid" });
		const forced = subscriptionRoutingStatus({ ...readRoutingConfig(undefined), policyJson }, accounts as never, {
			includePolicy: true,
		});
		expect(JSON.stringify(forced)).not.toContain(SECRET_TEXT);
	});
	it("returns the complete policy text once guidance is enabled and include_policy is requested", () => {
		const on = subscriptionRoutingStatus(
			{ ...readRoutingConfig(undefined), guidanceEnabled: true, policyJson },
			accounts as never,
			{ includePolicy: true },
		);
		expect(JSON.stringify(on)).toContain(SECRET_TEXT);
	});
	it("returns only a compact policy summary by default", () => {
		const big = "x".repeat(13_000);
		const bigJson = JSON.stringify({
			version: 1,
			guidance: `${SECRET_TEXT}${big}`,
			models: [{ family: "claude", model: "claude-haiku-5-5", allowedEfforts: ["medium", "high"] }],
		});
		const config = { ...readRoutingConfig(undefined), guidanceEnabled: true, policyJson: bigJson };
		const compact = subscriptionRoutingStatus(config, accounts as never);
		const full = subscriptionRoutingStatus(config, accounts as never, { includePolicy: true });
		expect(JSON.stringify(compact)).not.toContain(SECRET_TEXT);
		expect(compact.policy).toMatchObject({
			state: "valid",
			models: ["claude/claude-haiku-5-5: medium, high"],
			note: expect.stringContaining("include_policy=true"),
		});
		expect((compact.policy as { length: number }).length).toBeGreaterThan(13_000);
		// Absolute ceiling, independent of how big the full policy is.
		expect(JSON.stringify(compact).length).toBeLessThan(2000);
		expect(JSON.stringify(full).length).toBeGreaterThan(13_000);
	});
	it("summarizes exception efforts and an empty allowedEfforts list", () => {
		const until = Date.now() + 3_600_000;
		const json = JSON.stringify({
			version: 1,
			guidance: "g",
			models: [
				{ family: "claude", model: "claude-opus-5-5", allowedEfforts: ["medium", "high"], exceptionEfforts: ["xhigh"] },
				{
					family: "claude",
					model: "claude-opus-x",
					allowedEfforts: ["high"],
					exceptionEfforts: ["xhigh"],
					exceptionApprovedUntil: until,
				},
				{ family: "codex", model: "gpt-never", allowedEfforts: [] },
			],
		});
		const status = subscriptionRoutingStatus(
			{ ...readRoutingConfig(undefined), guidanceEnabled: true, policyJson: json },
			accounts as never,
		);
		expect((status.policy as { models: string[] }).models).toEqual([
			"claude/claude-opus-5-5: medium, high (exception: xhigh, not approved)",
			`claude/claude-opus-x: high (exception: xhigh, approved until ${new Date(until).toISOString()})`,
			"codex/gpt-never: aucun effort autorisé",
		]);
	});
	it("says the policy is not injected when guidance is off (no 'already in the system prompt' claim)", () => {
		const off = subscriptionRoutingStatus({ ...readRoutingConfig(undefined), policyJson }, accounts as never);
		expect(JSON.stringify(off)).not.toMatch(/already in the system prompt/u);
		expect(off.limitations.guidance).toMatch(/not-injected/u);
		const on = subscriptionRoutingStatus(
			{ ...readRoutingConfig(undefined), guidanceEnabled: true, policyJson },
			accounts as never,
		);
		expect(JSON.stringify(on)).toMatch(/already in the system prompt/u);
		expect(on.limitations.guidance).not.toMatch(/not-injected/u);
	});
	it("reports an empty policy as a state only", () => {
		const status = subscriptionRoutingStatus(
			{ ...readRoutingConfig(undefined), guidanceEnabled: true, policyJson: "" },
			accounts as never,
			{ includePolicy: true },
		);
		expect(status.policy).toEqual({ state: "empty" });
	});
	it("lists accounts by name and default marker, compactly and without any 'slot'", () => {
		const named = {
			snapshot: () => ({
				state: "ready" as const,
				accounts: [
					{
						family: "claude" as const,
						route: "claude-code-oauth-account-aaaa",
						name: "Claude · Perso",
						label: "Perso",
						isDefault: true,
						quota: { state: "unknown" as const, windows: [] },
					},
					{
						family: "claude" as const,
						route: "claude-code-oauth-account-bbbb",
						name: "Claude · compte 2",
						label: null,
						isDefault: false,
						quota: { state: "unknown" as const, windows: [] },
					},
				],
			}),
		};
		const status = subscriptionRoutingStatus(readRoutingConfig(undefined), named as never);
		expect(status.accounts).toEqual([
			{
				name: "Claude · Perso",
				isDefault: true,
				route: "claude-code-oauth-account-aaaa",
				quota: { state: "unknown", windows: [] },
			},
			{
				name: "Claude · compte 2",
				isDefault: false,
				route: "claude-code-oauth-account-bbbb",
				quota: { state: "unknown", windows: [] },
			},
		]);
		expect(JSON.stringify(status)).not.toMatch(/slot/iu);
	});
	it("reports an invalid policy as a state only, never echoing its content", () => {
		for (const includePolicy of [false, true]) {
			const status = subscriptionRoutingStatus(
				{ ...readRoutingConfig(undefined), guidanceEnabled: true, policyJson: "{PRIVATE_CANARY" },
				accounts as never,
				{ includePolicy },
			);
			expect(status.policy).toMatchObject({ state: "invalid" });
			expect(JSON.stringify(status)).not.toContain("PRIVATE_CANARY");
		}
	});
});

interface StatusReport {
	configuration: { usageEnabled: boolean };
	policy: unknown;
	limitations: { guidance: string };
	quotaRefresh?: string;
}

describe("coding_subscription_status tool wiring", () => {
	const snapshot = () => ({ state: "ready" as const, accounts: [] });
	async function tool(
		config: Partial<ReturnType<typeof readRoutingConfig>>,
		refreshUsage = vi.fn(async () => snapshot()),
	) {
		const current = { ...readRoutingConfig(undefined), ...config };
		const definition = await createRoutingStatusTool({
			current: () => current,
			accounts: { snapshot, refreshUsage } as never,
		});
		const run = async (args: Record<string, unknown>, signal = new AbortController().signal) => {
			const result = (await definition.execute(args as never, { signal } as never)) as { report: string };
			return { text: result.report, json: JSON.parse(result.report) as StatusReport };
		};
		return { run, refreshUsage, definition };
	}

	it("registers under the documented name and describes the automatic refresh", async () => {
		const { definition } = await tool({});
		expect(definition.name).toBe(CODING_SUBSCRIPTION_STATUS_TOOL);
		expect(definition.description).toMatch(/refreshed automatically/u);
		expect(definition.description).toMatch(/8 s/u);
	});
	it("execute() honours include_policy: compact by default, complete when true", async () => {
		const { run } = await tool({ guidanceEnabled: true, policyJson });
		expect((await run({})).text).not.toContain(SECRET_TEXT);
		expect((await run({ include_policy: false })).text).not.toContain(SECRET_TEXT);
		expect((await run({ include_policy: true })).text).toContain(SECRET_TEXT);
	});
	it('rejects include_policy:"true" (string) at the host argument validation: only a real boolean true returns the policy', async () => {
		const { run } = await tool({ guidanceEnabled: true, policyJson });
		for (const value of ["true", "false", 1, null])
			await expect(run({ include_policy: value })).rejects.toMatchObject({ name: "ToolArgsError" });
	});
	it("never discloses the policy through the tool while guidance is off, and says it is not injected", async () => {
		const { run } = await tool({ guidanceEnabled: false, policyJson });
		const { text, json } = await run({ include_policy: true });
		expect(text).not.toContain(SECRET_TEXT);
		expect(json.policy).toEqual({ state: "valid" });
		expect(json.limitations.guidance).toMatch(/not-injected/u);
		// No claim that include_policy would return anything: it discloses nothing while guidance is off.
		expect(text).not.toMatch(/returns the complete policy/u);
		expect(Object.keys(json.policy as object)).toEqual(["state"]);
	});
	it("refreshes stale routes before answering (bounded, non-forced) and survives a failing refresh", async () => {
		const failing = vi.fn(async () => {
			throw new Error("boom");
		});
		const { run, refreshUsage } = await tool({ usageEnabled: true }, failing);
		const { json } = await run({});
		expect(json.configuration.usageEnabled).toBe(true);
		expect(refreshUsage).toHaveBeenCalledWith(undefined, expect.any(AbortSignal), {
			timeoutMs: STATUS_REFRESH_TIMEOUT_MS,
			onlyIfNeeded: true,
		});
		expect(STATUS_REFRESH_TIMEOUT_MS).toBeLessThanOrEqual(8_000);
	});
	it("refresh:true forces a read of the given route; it is skipped, not failed, when quota reads are off", async () => {
		const on = await tool({ usageEnabled: true });
		await on.run({ refresh: true, route: "claude-code-oauth-account-x" });
		expect(on.refreshUsage).toHaveBeenCalledWith("claude-code-oauth-account-x", expect.any(AbortSignal), {
			timeoutMs: STATUS_REFRESH_TIMEOUT_MS,
		});
		const off = await tool({ usageEnabled: false });
		const { json } = await off.run({ refresh: true });
		expect(off.refreshUsage).not.toHaveBeenCalled();
		expect(json.quotaRefresh).toMatch(/disabled/u);
		// An unknown (or just withdrawn) route is a skip, never an exception of the whole tool.
		const unknown = await tool(
			{ usageEnabled: true },
			vi.fn(async () => {
				throw new Error("Account route is unavailable");
			}),
		);
		const skipped = await unknown.run({ refresh: true, route: "claude-code-oauth-account-nope" });
		expect(skipped.json.quotaRefresh).toMatch(/^skipped: .*unknown or unavailable/u);
		const quiet = await tool({ usageEnabled: false });
		expect((await quiet.run({})).json.quotaRefresh).toBeUndefined();
		expect(quiet.refreshUsage).not.toHaveBeenCalled();
	});
});
