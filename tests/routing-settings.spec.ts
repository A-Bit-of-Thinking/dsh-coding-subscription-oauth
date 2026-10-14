import { describe, expect, it, vi } from "vitest";
import type { CapabilitySettingsService } from "../src/capability-settings.ts";
import { readRoutingConfig } from "../src/routing-config.ts";
import { createRoutingSettingsController, type RoutingSettingsError } from "../src/routing-settings.ts";

const NS = "entry-example";
const goodPolicy = JSON.stringify({ version: 1, guidance: "Keep this text exactly.", models: [] });

function fixture(overrides: Partial<CapabilitySettingsService> & { revision?: number; rowWritable?: boolean } = {}) {
	let revision = overrides.revision ?? 3;
	const update = vi.fn(async (_ns: string, _patch: object, expected?: number) => {
		if (expected !== revision) throw Object.assign(new Error("moved"), { code: "SETTINGS_CONFLICT" });
		revision += 1;
	});
	const settings: CapabilitySettingsService = {
		writable: true,
		describe: () => [{ ns: NS, revision, writable: overrides.rowWritable ?? true }] as never,
		update,
		...overrides,
	};
	const controller = createRoutingSettingsController({
		settings: () => settings,
		entryNamespace: () => NS,
		current: () => readRoutingConfig(undefined),
	});
	return { controller, update, settings };
}
const rejection = async (promise: Promise<unknown>) =>
	(await promise.catch((error: unknown) => error)) as RoutingSettingsError;

describe("routing settings controller", () => {
	it("reports the host revision and writability", () => {
		const { controller } = fixture();
		expect(controller.snapshot()).toMatchObject({ revision: 3, writable: true, value: { enabled: false } });
	});
	it("writes only the routing form with the expected revision and returns the admitted values", async () => {
		const { controller, update } = fixture();
		const saved = await controller.patch({ enabled: true, policyJson: goodPolicy }, 3);
		expect(update).toHaveBeenCalledWith(NS, { routing: { enabled: true, policyJson: goodPolicy } }, 3);
		expect(saved.revision).toBe(4);
		expect(saved.value).toMatchObject({ enabled: true, policyJson: goodPolicy, enforcePolicy: false });
	});
	it("maps a stale revision to a 409 conflict without writing", async () => {
		const { controller } = fixture();
		const error = await rejection(controller.patch({ enabled: true }, 1));
		expect(error).toMatchObject({ status: 409, code: "SETTINGS_CONFLICT" });
	});
	it("refuses an invalid policy before anything is persisted, without echoing it", async () => {
		const { controller, update } = fixture();
		const error = await rejection(controller.patch({ policyJson: "{PRIVATE_CANARY" }, 3));
		expect(error).toMatchObject({ status: 400, code: "policy_invalid" });
		expect(error.message).not.toContain("PRIVATE_CANARY");
		expect(update).not.toHaveBeenCalled();
	});
	it.each([
		{},
		[],
		null,
		{ enabled: "yes" },
		{ unknown: true },
		{ policyJson: 7 },
		{ policyJson: "x".repeat(65 * 1024) },
	])("rejects malformed patch %j", async (patch) => {
		const { controller, update } = fixture();
		expect(await rejection(controller.patch(patch, 3))).toMatchObject({ status: 400 });
		expect(update).not.toHaveBeenCalled();
	});
	it("rejects a bad revision, a read-only host and an absent settings service", async () => {
		expect(await rejection(fixture().controller.patch({ enabled: true }, -1))).toMatchObject({ status: 400 });
		const readOnly = fixture({ rowWritable: false });
		expect(await rejection(readOnly.controller.patch({ enabled: true }, 3))).toMatchObject({ status: 403 });
		expect(readOnly.controller.snapshot().writable).toBe(false);
		const absent = createRoutingSettingsController({
			settings: () => undefined,
			entryNamespace: () => NS,
			current: () => readRoutingConfig(undefined),
		});
		expect(absent.snapshot()).toMatchObject({ writable: false, revision: 0 });
		expect(await rejection(absent.patch({ enabled: true }, 0))).toMatchObject({ status: 503 });
	});
	it("treats a legacy register()-style service as not editable", () => {
		const legacy = fixture({ register: (() => undefined) as never });
		expect(legacy.controller.snapshot().writable).toBe(false);
	});
});
