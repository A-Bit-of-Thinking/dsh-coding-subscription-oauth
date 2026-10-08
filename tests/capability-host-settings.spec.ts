import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { describe, expect, it, vi } from "vitest";
import {
	adaptCapabilityHostSettings,
	capabilityEntryNamespace,
	readCapabilityConfig,
	watchCapabilityHostSettings,
} from "../src/capability-host-settings.ts";
import { CapabilityRuntimeState } from "../src/capability-runtime.ts";
import {
	CAPABILITY_SETTINGS_NAMESPACE,
	type CapabilitySettingsDescriptor,
	type CapabilitySettingsPatch,
	type CapabilitySettingsService,
	createCapabilitySettingsController,
	DEFAULT_CAPABILITY_SETTINGS,
} from "../src/capability-settings.ts";
import { createDshHostAdapter } from "../src/dsh-host-adapter.ts";
import { Config } from "../src/index.ts";

const ENTRY = "oauth-instance";

/** The host selects only volatile nodes and removes their runtime-reference metadata. */
function formSchema(): Schema {
	const properties = Object.entries(Config.dict!).filter(([, field]) => field.meta.volatile);
	return Schema.object(
		Object.fromEntries(
			properties.map(([key, field]) => {
				const plain = new Schema(field.toJSON());
				delete plain.meta.volatile;
				return [key, plain];
			}),
		),
	);
}

class ModernSettings implements CapabilitySettingsService {
	writable = true;
	present = true;
	capabilitiesEditable = true;
	revision = 0;
	readonly base = { capabilities: { codexSearch: true, imageCount: 3 }, proxy: "https://example.com" };
	user: Record<string, unknown> = {
		capabilities: { codexSearch: false, codexUsage: true, searchResults: 9 },
		proxy: "https://proxy.example.com",
		proxyKimi: true,
		gateway: { enabled: false, port: 12345 },
		ownerRequest: { trustedProxy: { ownerProof: "private-test-value" } },
		unrelatedLive: { enabled: true },
	};
	readonly listeners = new Set<(ns: string, revision: number) => void>();
	readonly context = {
		on: vi.fn((event: string, callback: (ns: string, revision: number) => void) => {
			expect(event).toBe("settings/document-updated");
			this.listeners.add(callback);
			return () => {
				this.listeners.delete(callback);
			};
		}),
	} as unknown as Context;

	describe(): CapabilitySettingsDescriptor[] {
		return [
			{
				ns: "another-plugin",
				schema: formSchema().toJSON(),
				value: { capabilities: { codexFast: true } },
				revision: 42,
			},
			...(this.present
				? [
						{
							ns: ENTRY,
							schema: this.capabilitiesEditable ? formSchema().toJSON() : Schema.object({}).toJSON(),
							revision: this.revision,
							value: { capabilities: this.current(), unrelatedLive: this.user["unrelatedLive"] },
							base: this.base,
							user: this.user,
						},
					]
				: []),
		];
	}

	current(): CapabilitySettingsPatch | undefined {
		return Config({
			capabilities: { ...this.base.capabilities, ...(this.user["capabilities"] as object) },
		}).capabilities.get();
	}

	readonly update = vi.fn(async (ns: string, patch: object, expected?: number) => {
		await this.edit(ns, expected, () => {
			if (Object.keys(patch).some((key) => key !== "capabilities")) throw new Error("field is not volatile");
			this.user = {
				...this.user,
				capabilities: {
					...(this.user["capabilities"] as object),
					...(patch as { capabilities?: object }).capabilities,
				},
			};
		});
	});

	readonly replace = vi.fn(async () => {
		throw new Error("whole form replace must never be called");
	});

	readonly mutate = vi.fn(
		async (ns: string, ops: Parameters<NonNullable<CapabilitySettingsService["mutate"]>>[1], expected?: number) => {
			await this.edit(ns, expected, () => {
				for (const op of ops) {
					if (op.path[0] !== "capabilities") throw new Error("field is not volatile");
					if (op.op === "unset" && op.path.length === 1) {
						this.user = { ...this.user, capabilities: { ...this.base.capabilities } };
					} else if (op.op === "set" && op.path.length === 2) {
						this.user = {
							...this.user,
							capabilities: { ...(this.user["capabilities"] as object), [op.path[1]!]: op.value },
						};
					} else throw new Error("unexpected op");
				}
			});
		},
	);

	external(capabilities: CapabilitySettingsPatch): void {
		this.user = { ...this.user, capabilities };
		this.revision++;
		for (const listener of [...this.listeners]) listener(ENTRY, this.revision);
	}

	private async edit(ns: string, expected: number | undefined, change: () => void): Promise<void> {
		await Promise.resolve(); // Two readers can reach the host before either commits.
		if (ns !== ENTRY || !this.present) throw new Error("No configurable plugin entry");
		if (!this.writable) throw new Error("read-only");
		if (!this.capabilitiesEditable) throw new Error("field is not volatile");
		if (typeof expected !== "number") throw new Error("expectedRevision must be a number");
		if (expected !== this.revision)
			throw Object.assign(new Error("conflict"), {
				code: "SETTINGS_CONFLICT",
				expected,
				actual: this.revision,
			});
		change();
		this.revision++;
		for (const listener of [...this.listeners]) listener(ENTRY, this.revision);
	}
}

function controller(settings: ModernSettings) {
	return createCapabilitySettingsController({ settings: adaptCapabilityHostSettings(settings, ENTRY) });
}

describe("modern capability host settings", () => {
	it("parses a real volatile capability reference without making ordinary Config live", () => {
		const parsed = Config({ capabilities: { codexFast: true, searchResults: 3 }, proxy: "https://example.com" });
		expect(typeof parsed.capabilities.get).toBe("function");
		expect(readCapabilityConfig(parsed.capabilities)).toMatchObject({ codexFast: true, searchResults: 3 });
		expect(Config({}).capabilities.get()).toEqual(DEFAULT_CAPABILITY_SETTINGS);
		expect(readCapabilityConfig({ codexFast: true })).toEqual({ codexFast: true });
		expect(Config.meta.volatile).not.toBe(true);
		expect(Config.dict!["capabilities"]!.meta.volatile).toBe(true);
		for (const key of ["proxy", "proxyKimi", "retryPolicy", "gateway", "ownerRequest"]) {
			expect(Config.dict![key]!.meta.volatile).not.toBe(true);
		}
		expect(Object.keys(formSchema().dict!)).toEqual(["capabilities"]);
	});

	it("locates the owning profile entry through injection ancestry, never a descriptor's first row", () => {
		const owner = { fiber: { entry: { options: { id: ENTRY } } } };
		const child = { fiber: { parent: { fiber: { parent: owner } } } } as unknown as Context;
		expect(capabilityEntryNamespace(child)).toBe(ENTRY);
		expect(capabilityEntryNamespace({ fiber: {} } as Context)).toBeUndefined();
		const cyclic = { fiber: { parent: {} } };
		cyclic.fiber.parent = cyclic;
		expect(capabilityEntryNamespace(cyclic as unknown as Context)).toBeUndefined();
	});

	it("persists nested capabilities with the whole host revision and projects secret-free state", async () => {
		const settings = new ModernSettings();
		const capabilities = controller(settings);
		const before = capabilities.snapshot();
		expect(before).toMatchObject({ ns: CAPABILITY_SETTINGS_NAMESPACE, revision: 0, writable: true });
		expect(before.value).toMatchObject({ codexSearch: false, codexUsage: true, imageCount: 3, searchResults: 9 });
		expect(before.user).toEqual({ codexSearch: false, codexUsage: true, searchResults: 9 });
		expect(JSON.stringify(before)).not.toContain("private-test-value");
		const next = await capabilities.patch({ codexSearch: true, codexFast: true }, before.revision);
		expect(settings.update).toHaveBeenCalledWith(ENTRY, { capabilities: { codexSearch: true, codexFast: true } }, 0);
		expect(next.value).toMatchObject({ codexSearch: true, codexFast: true });
		expect(next.revision).toBe(1);
		expect(controller(settings).current()).toEqual(next.value);
		await expect(settings.update(CAPABILITY_SETTINGS_NAMESPACE, { capabilities: {} }, 1)).rejects.toThrow(/entry/);
		await expect(settings.update(ENTRY, { proxy: "invalid" }, 1)).rejects.toThrow(/not volatile/);
	});

	it("rejects non-numeric revision envelopes before sending a write to the host", async () => {
		const settings = new ModernSettings();
		const capabilities = controller(settings);
		for (const revision of [Number.NaN, -1, 0.5, { revision: 0 } as unknown as number]) {
			await expect(capabilities.patch({ codexFast: true }, revision)).rejects.toThrow(/expectedRevision/);
		}
		expect(settings.update).not.toHaveBeenCalled();
		expect(settings.mutate).not.toHaveBeenCalled();
	});

	it("enforces host CAS for two simultaneous clients and edits outside the capability subtree", async () => {
		const settings = new ModernSettings();
		const first = controller(settings);
		const second = controller(settings);
		const results = await Promise.allSettled([
			first.patch({ codexFast: true }, 0),
			second.patch({ codexImages: true }, 0),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.find((result) => result.status === "rejected")).toMatchObject({
			status: "rejected",
			reason: { code: "SETTINGS_CONFLICT", expected: 0, actual: 1 },
		});
		const revision = first.snapshot().revision;
		settings.user["proxy"] = "https://changed.example.com";
		settings.revision++;
		await expect(first.patch({ codexSearch: true }, revision)).rejects.toMatchObject({
			code: "SETTINGS_CONFLICT",
			expected: revision,
			actual: revision + 1,
		});
	});

	it("replace resets only capabilities to inherited/default state and preserves all unrelated fields", async () => {
		const settings = new ModernSettings();
		const capabilities = controller(settings);
		const { capabilities: _previous, ...unrelated } = settings.user;
		const reset = await capabilities.replace({}, 0);
		expect(reset.value).toEqual({ ...DEFAULT_CAPABILITY_SETTINGS, codexSearch: true, imageCount: 3 });
		expect(settings.mutate).toHaveBeenCalledWith(ENTRY, [{ op: "unset", path: ["capabilities"] }], 0);
		const next = await capabilities.replace({ codexFast: true, imageCount: 2 }, reset.revision);
		expect(next.value).toMatchObject({ codexSearch: true, codexFast: true, imageCount: 2, codexUsage: false });
		const { capabilities: _next, ...remaining } = settings.user;
		expect(remaining).toEqual(unrelated);
		expect(settings.replace).not.toHaveBeenCalled();
	});

	it("fails closed for absent/non-live descriptors, unknown owner ids, and read-only hosts", async () => {
		const settings = new ModernSettings();
		const capabilities = controller(settings);
		settings.present = false;
		expect(capabilities.snapshot().writable).toBe(false);
		await expect(capabilities.patch({ codexFast: true }, 0)).rejects.toMatchObject({ code: "SETTINGS_READ_ONLY" });
		settings.present = true;
		settings.capabilitiesEditable = false;
		expect(capabilities.snapshot().writable).toBe(false);
		settings.capabilitiesEditable = true;
		settings.writable = false;
		expect(capabilities.snapshot().writable).toBe(false);
		await expect(capabilities.replace({}, 0)).rejects.toMatchObject({ code: "SETTINGS_READ_ONLY" });
		expect(
			createCapabilitySettingsController({ settings: adaptCapabilityHostSettings(settings, undefined) }).snapshot()
				.writable,
		).toBe(false);
		expect(
			createCapabilitySettingsController({ settings: adaptCapabilityHostSettings(settings, "wrong-entry") }).snapshot()
				.writable,
		).toBe(false);
		expect(settings.update).not.toHaveBeenCalled();
		expect(settings.mutate).not.toHaveBeenCalled();
	});

	it("reconciles external edits into live runtime and cancels queued events when released", async () => {
		const settings = new ModernSettings();
		const capabilities = controller(settings);
		const runtime = new CapabilityRuntimeState(capabilities.current());
		const unsubscribe = capabilities.subscribe((snapshot) => {
			runtime.set(snapshot.value);
		});
		const failed = vi.fn();
		const stop = watchCapabilityHostSettings(
			settings.context,
			ENTRY,
			() => {
				capabilities.reconcile();
			},
			failed,
		);
		settings.external({ codexFast: true });
		await Promise.resolve();
		expect(runtime.current().codexFast).toBe(true);
		expect(capabilities.current().codexUsage).toBe(false);
		settings.external({ codexFast: false });
		stop();
		stop();
		unsubscribe();
		capabilities.dispose();
		await Promise.resolve();
		expect(runtime.current().codexFast).toBe(true);
		expect(settings.listeners.size).toBe(0);
		expect(failed).not.toHaveBeenCalled();
	});

	it("contains reconcile failures and ignores events for another plugin", async () => {
		const settings = new ModernSettings();
		const failure = new Error("listener failed");
		const reconcile = vi.fn(() => {
			throw failure;
		});
		const failed = vi.fn();
		const stop = watchCapabilityHostSettings(settings.context, ENTRY, reconcile, failed);
		for (const listener of settings.listeners) listener("another-plugin", 3);
		await Promise.resolve();
		expect(reconcile).not.toHaveBeenCalled();
		settings.external({});
		await Promise.resolve();
		expect(failed).toHaveBeenCalledWith(failure);
		stop();
	});

	it("recognizes only the verified modern forms contract and leaves legacy register services intact", () => {
		const modern = new ModernSettings();
		const context = (settings: unknown) =>
			({
				get: (name: string) => (name === "settings" ? settings : undefined),
				effect: vi.fn(),
				inject: vi.fn(),
				logger: vi.fn(),
			}) as unknown as Context;
		expect(createDshHostAdapter(context(modern)).compatibility().capabilities["settings"]).toEqual({
			state: "available",
			contract: "settings-forms-v1",
		});
		expect(
			createDshHostAdapter(context({ describe: vi.fn(), update: vi.fn() })).compatibility().capabilities["settings"],
		).toMatchObject({ state: "incompatible" });
		const legacy = { register: vi.fn() };
		expect(adaptCapabilityHostSettings(legacy, ENTRY)).toBe(legacy);
		expect(createDshHostAdapter(context(legacy)).compatibility().capabilities["settings"]).toMatchObject({
			state: "available",
			contract: "settings-register-v1",
		});
	});
});
