import { describe, expect, it } from "vitest";
import { readRoutingConfig } from "../src/routing-config.ts";
import { subscriptionRoutingStatus } from "../src/routing-tools.ts";

const SECRET_TEXT = "OPERATOR_POLICY_TEXT_THAT_MUST_STAY_PRIVATE";
const policyJson = JSON.stringify({ version: 1, guidance: SECRET_TEXT, models: [] });
const accounts = { snapshot: () => ({ state: "disabled" as const, accounts: [] }) };

describe("coding_subscription_status disclosure", () => {
	it("does not reveal the policy text unless the operator enabled guidance", () => {
		const off = subscriptionRoutingStatus({ ...readRoutingConfig(undefined), policyJson }, accounts as never);
		expect(JSON.stringify(off)).not.toContain(SECRET_TEXT);
		expect(off.policy).toEqual({ state: "valid" });
	});
	it("returns the complete policy text once guidance is enabled", () => {
		const on = subscriptionRoutingStatus(
			{ ...readRoutingConfig(undefined), guidanceEnabled: true, policyJson },
			accounts as never,
		);
		expect(JSON.stringify(on)).toContain(SECRET_TEXT);
	});
	it("reports an invalid policy as a state only, never echoing its content", () => {
		const status = subscriptionRoutingStatus(
			{ ...readRoutingConfig(undefined), guidanceEnabled: true, policyJson: "{PRIVATE_CANARY" },
			accounts as never,
		);
		expect(status.policy).toMatchObject({ state: "invalid" });
		expect(JSON.stringify(status)).not.toContain("PRIVATE_CANARY");
	});
});
