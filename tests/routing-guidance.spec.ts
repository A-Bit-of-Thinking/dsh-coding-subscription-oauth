import { describe, expect, it, vi } from "vitest";
import { readRoutingConfig } from "../src/routing-config.ts";
import {
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
		(context.text as (scope: unknown) => string)({ scope: "child" });
		expect(accounts.snapshot).toHaveBeenCalledOnce();
		config = { ...config, policyJson: JSON.stringify({ version: 1, guidance: "UPDATED_COMPLETE_TEXT", models: [] }) };
		expect(render({})).toContain("UPDATED_COMPLETE_TEXT");
		expect(render({})).not.toContain(full);
		config.guidanceEnabled = false;
		expect(render({})).toBe("");
		stop();
		expect(stopSection).toHaveBeenCalledOnce();
		expect(stopContext).toHaveBeenCalledOnce();
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
