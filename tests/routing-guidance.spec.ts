import { describe, expect, it, vi } from "vitest";
import { readRoutingConfig } from "../src/routing-config.ts";
import {
	ADVISORY_POLICY_NOTE,
	ROUTING_POLICY_SECTION,
	type RoutingPromptRegistry,
	registerRoutingGuidance,
} from "../src/routing-guidance.ts";

describe("complete operator guidance", () => {
	it("contributes literal full text to both head and child assemblies and rereads changes without network", () => {
		const full =
			"All detailed model comparisons, cost rationales and exceptions. Sol xhigh also for very important ultra-complex integration. Every authorized model may delegate. Haiku may work directly. {{literal-not-a-variable}}\n".repeat(
				50,
			);
		let config = {
			...readRoutingConfig(undefined),
			guidanceEnabled: true,
			usageEnabled: true,
			policyJson: JSON.stringify({ version: 1, guidance: full, models: [] }),
		};
		let section!: Parameters<RoutingPromptRegistry["section"]>[0];
		let context!: Parameters<RoutingPromptRegistry["context"]>[0];
		const stopSection = vi.fn(),
			stopContext = vi.fn();
		const accounts = { snapshot: vi.fn(() => ({ state: "ready" as const, accounts: [] })) };
		const stop = registerRoutingGuidance(
			{
				section: (value) => {
					section = value;
					return stopSection;
				},
				context: (value) => {
					context = value;
					return stopContext;
				},
			},
			() => config,
			accounts,
		);
		expect(section.name).toBe(ROUTING_POLICY_SECTION);
		expect(section.interpolate).toBe(false);
		expect(section).not.toHaveProperty("complete");
		const render = section.text as (scope: unknown) => string;
		for (const scope of [{ scope: "head" }, { scope: "child" }]) expect(render(scope)).toContain(full);
		expect(render({})).toContain("{{literal-not-a-variable}}");
		expect(accounts.snapshot).not.toHaveBeenCalled();
		const quotaContext = (context.text as (scope: unknown) => string)({ scope: "child" });
		expect(accounts.snapshot).toHaveBeenCalledOnce();
		expect(quotaContext).toMatch(/not-read/u);
		expect(quotaContext).toMatch(/every 15 minutes/u);
		expect(quotaContext).toMatch(/coding_subscription_status/u);
		config = { ...config, policyJson: JSON.stringify({ version: 1, guidance: "UPDATED_COMPLETE_TEXT", models: [] }) };
		expect(render({})).toContain("UPDATED_COMPLETE_TEXT");
		expect(render({})).not.toContain(full);
		config.guidanceEnabled = false;
		expect(render({})).toBe("");
		stop();
		expect(stopSection).toHaveBeenCalledOnce();
		expect(stopContext).toHaveBeenCalledOnce();
	});
	it("adds the advisory paragraph only when enforcePolicy is false", () => {
		let config = {
			...readRoutingConfig(undefined),
			guidanceEnabled: true,
			usageEnabled: true,
			enforcePolicy: false,
			policyJson: JSON.stringify({ version: 1, guidance: "POLICY_BODY", models: [] }),
		};
		let section!: Parameters<RoutingPromptRegistry["section"]>[0];
		registerRoutingGuidance(
			{
				section: (value) => {
					section = value;
					return vi.fn();
				},
				context: () => vi.fn(),
			},
			() => config,
			{ snapshot: () => ({ state: "disabled", accounts: [] }) },
		);
		const render = section.text as (scope: unknown) => string;
		const advisory = render({});
		expect(advisory).toContain("POLICY_BODY");
		expect(advisory.endsWith(ADVISORY_POLICY_NOTE)).toBe(true);
		expect(advisory).toContain("without asking for confirmation");
		// Unambiguous wording: the policy guides AUTOMATIC choices; explicit user requests win, subagents included.
		expect(ADVISORY_POLICY_NOTE).toMatch(/AUTOMATIC choices/u);
		expect(ADVISORY_POLICY_NOTE).toMatch(/explicit user request always takes precedence/u);
		expect(ADVISORY_POLICY_NOTE).toMatch(/JAMAIS/u);
		expect(ADVISORY_POLICY_NOTE).toMatch(/subagent does not consider itself bound/u);
		expect(ADVISORY_POLICY_NOTE).not.toMatch(/inherit no prohibition/u);
		// The section tells the model to consult the status (which refreshes stale quotas) before distributing work.
		expect(advisory).toMatch(/call it before spreading work across several accounts/u);
		config = { ...config, enforcePolicy: true };
		const enforced = render({});
		expect(enforced).toContain("POLICY_BODY");
		expect(enforced).not.toContain(ADVISORY_POLICY_NOTE);
	});
	it("claims quota refreshes only when quota reads are enabled", () => {
		let config = {
			...readRoutingConfig(undefined),
			guidanceEnabled: true,
			usageEnabled: false,
			policyJson: JSON.stringify({ version: 1, guidance: "POLICY_BODY", models: [] }),
		};
		let section!: Parameters<RoutingPromptRegistry["section"]>[0];
		let context!: Parameters<RoutingPromptRegistry["context"]>[0];
		registerRoutingGuidance(
			{
				section: (value) => {
					section = value;
					return vi.fn();
				},
				context: (value) => {
					context = value;
					return vi.fn();
				},
			},
			() => config,
			{ snapshot: () => ({ state: "disabled", accounts: [] }) },
		);
		const render = section.text as (scope: unknown) => string;
		const quota = context.text as (scope: unknown) => string;
		for (const text of [render({}), quota({})]) {
			expect(text).not.toMatch(/refreshes/u);
			expect(text).not.toMatch(/every 15 minutes/u);
			expect(text).toMatch(/quota reads are disabled/u);
		}
		config = { ...config, usageEnabled: true };
		expect(render({})).toMatch(/it refreshes stale quotas itself/u);
		expect(quota({})).toMatch(/it refreshes not-read, stale and error routes/u);
	});
	it("does not print invalid operator JSON and rolls back section registration if context fails", () => {
		let section!: Parameters<RoutingPromptRegistry["section"]>[0];
		const stop = vi.fn();
		const current = () => ({ ...readRoutingConfig(undefined), guidanceEnabled: true, policyJson: "{PRIVATE_CANARY" });
		expect(() =>
			registerRoutingGuidance(
				{
					section: (value) => {
						section = value;
						return stop;
					},
					context: () => {
						throw new Error("mock failure");
					},
				},
				current,
				{ snapshot: () => ({ state: "disabled", accounts: [] }) },
			),
		).toThrow("mock failure");
		expect(stop).toHaveBeenCalledOnce();
		expect((section.text as (scope: unknown) => string)({})).not.toContain("PRIVATE_CANARY");
	});
});
