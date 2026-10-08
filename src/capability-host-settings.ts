import type { Context } from "@deepseek-ai/cordis";
import {
	CAPABILITY_SETTINGS_NAMESPACE,
	type CapabilitySettingsDescriptor,
	type CapabilitySettingsPatch,
	type CapabilitySettingsService,
} from "./capability-settings.ts";

/** Stable Config references are structural: no new cosmokit dependency is needed. */
export interface CapabilitySettingsReference {
	get(): CapabilitySettingsPatch | undefined;
}

export function readCapabilityConfig(
	value: CapabilitySettingsPatch | CapabilitySettingsReference | undefined,
): CapabilitySettingsPatch | undefined {
	if (value !== undefined && "get" in value && typeof value.get === "function") return value.get();
	return value as CapabilitySettingsPatch | undefined;
}

/** Injections inherit the owning loader entry; follow parent contexts when absent. */
export function capabilityEntryNamespace(context: Context): string | undefined {
	let fiber: unknown = context.fiber;
	const seen = new Set<unknown>();
	while (fiber !== undefined && !seen.has(fiber)) {
		seen.add(fiber);
		const current = record(fiber);
		const id = record(record(current?.["entry"])?.["options"])?.["id"];
		if (typeof id === "string" && id.length > 0) return id;
		fiber = record(current?.["parent"])?.["fiber"];
	}
	return undefined;
}

export function hasCapabilitySettingsForms(settings: CapabilitySettingsService): boolean {
	return (
		typeof settings.describe === "function" &&
		typeof settings.update === "function" &&
		typeof settings.mutate === "function"
	);
}

/**
 * Keep the public capability namespace while editing only the owning entry's
 * volatile capabilities form. Legacy register() services remain untouched.
 */
export function adaptCapabilityHostSettings(
	settings: CapabilitySettingsService,
	entryNamespace: string | undefined,
): CapabilitySettingsService {
	if (typeof settings.register === "function" || !hasCapabilitySettingsForms(settings)) return settings;
	const descriptor = (): CapabilitySettingsDescriptor | undefined => {
		if (entryNamespace === undefined) return undefined;
		try {
			const rows = settings.describe!({ redactSecrets: true });
			const row = Array.isArray(rows) ? rows.find((candidate) => candidate.ns === entryNamespace) : undefined;
			// Only the filtered live form authorizes writes; never guess another plugin's id.
			const schema = record(row?.schema);
			// Schemastery serializes nodes through uid/refs, not inline dictionaries.
			const refs = record(schema?.["refs"]);
			const root = refs === undefined ? schema : record(refs[String(schema?.["uid"])]);
			const fieldRef = record(root?.["dict"])?.["capabilities"];
			const field = record(fieldRef) ?? record(refs?.[String(fieldRef)]);
			return field?.["type"] === "object" && Number.isSafeInteger(row?.revision) && row!.revision! >= 0
				? row
				: undefined;
		} catch {
			return undefined;
		}
	};
	const target = (ns: string, expectedRevision: number | undefined): string => {
		if (ns !== CAPABILITY_SETTINGS_NAMESPACE || entryNamespace === undefined || descriptor() === undefined) {
			throw new Error("capability settings form is unavailable");
		}
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision! < 0) {
			throw new TypeError("capability settings expectedRevision must be a non-negative integer");
		}
		return entryNamespace;
	};
	return {
		get writable() {
			const row = descriptor();
			return settings.writable !== false && row !== undefined && row.writable !== false;
		},
		describe() {
			const row = descriptor();
			return row === undefined
				? []
				: [
						{
							ns: CAPABILITY_SETTINGS_NAMESPACE,
							value: record(row.value)?.["capabilities"],
							base: record(row.base)?.["capabilities"],
							user: record(row.user)?.["capabilities"],
							revision: row.revision!,
							applies: "live",
							secrets: [],
						},
					];
		},
		async update(ns, patch, expectedRevision) {
			await settings.update!(target(ns, expectedRevision), { capabilities: patch }, expectedRevision);
		},
		async replace(ns, section, expectedRevision) {
			// unset re-inherits this subtree, then nested sets retain that inheritance.
			// settings.replace() would reset every volatile field in the whole entry.
			await settings.mutate!(
				target(ns, expectedRevision),
				[
					{ op: "unset", path: ["capabilities"] },
					...Object.entries(section).map(([key, value]) => ({
						op: "set" as const,
						path: ["capabilities", key],
						value,
					})),
				],
				expectedRevision,
			);
		},
	};
}

/** Host describe() itself may emit this event; defer/coalesce to avoid reentrant reads. */
export function watchCapabilityHostSettings(
	context: Context,
	entryNamespace: string | undefined,
	reconcile: () => void,
	onError: (error: unknown) => void,
): () => void {
	if (entryNamespace === undefined) return () => undefined;
	let active = true;
	let queued = false;
	const events = context as unknown as {
		on(name: "settings/document-updated", listener: (ns: string, revision: number) => void): () => void;
	};
	const stop = events.on("settings/document-updated", (ns) => {
		if (!active || queued || ns !== entryNamespace) return;
		queued = true;
		queueMicrotask(() => {
			queued = false;
			if (!active) return;
			try {
				reconcile();
			} catch (error) {
				onError(error);
			}
		});
	});
	return () => {
		if (!active) return;
		active = false;
		stop();
	};
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}
