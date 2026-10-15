/** Revision-checked writes of the live `routing` form through the host settings service. */
import type { CapabilitySettingsService } from "./capability-settings.ts";
import type { RoutingConfig } from "./routing-config.ts";
import { parseRoutingPolicy } from "./routing-policy.ts";

export interface RoutingSettingsSnapshot {
	readonly revision: number;
	readonly writable: boolean;
	readonly value: RoutingConfig;
}
export interface RoutingSettingsController {
	snapshot(): RoutingSettingsSnapshot;
	patch(patch: unknown, expectedRevision: number): Promise<RoutingSettingsSnapshot>;
}
export class RoutingSettingsError extends Error {
	constructor(
		readonly status: 400 | 403 | 409 | 503,
		readonly code: string,
	) {
		super(code);
		this.name = "RoutingSettingsError";
	}
}

const FLAGS = ["enabled", "usageEnabled", "guidanceEnabled", "enforcePolicy"] as const;
export const ROUTING_POLICY_MAX_BYTES = 64 * 1024;

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Admit only known keys; the policy must parse before anything is persisted. */
function admit(patch: unknown): Partial<RoutingConfig> {
	if (!record(patch) || Object.keys(patch).length === 0) throw new RoutingSettingsError(400, "invalid");
	const out: { -readonly [K in keyof RoutingConfig]?: RoutingConfig[K] } = {};
	for (const [key, value] of Object.entries(patch)) {
		if ((FLAGS as readonly string[]).includes(key)) {
			if (typeof value !== "boolean") throw new RoutingSettingsError(400, "invalid");
			out[key as (typeof FLAGS)[number]] = value;
		} else if (key === "policyJson") {
			if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > ROUTING_POLICY_MAX_BYTES) {
				throw new RoutingSettingsError(400, "invalid");
			}
			try {
				parseRoutingPolicy(value);
			} catch {
				throw new RoutingSettingsError(400, "policy_invalid");
			}
			out.policyJson = value;
		} else {
			throw new RoutingSettingsError(400, "invalid");
		}
	}
	return out;
}

export function createRoutingSettingsController(options: {
	settings(): CapabilitySettingsService | undefined;
	entryNamespace(): string | undefined;
	current(): RoutingConfig;
}): RoutingSettingsController {
	/** A modern host exposes the entry's live form through describe()/update(); otherwise read-only. */
	const host = ():
		| { settings: CapabilitySettingsService; ns: string; revision: number; writable: boolean }
		| undefined => {
		const settings = options.settings();
		const ns = options.entryNamespace();
		if (settings === undefined || ns === undefined) return undefined;
		if (typeof settings.describe !== "function" || typeof settings.update !== "function") return undefined;
		if (typeof settings.register === "function") return undefined;
		try {
			const row = settings.describe({ redactSecrets: true }).find((candidate) => candidate.ns === ns);
			if (row === undefined || !Number.isSafeInteger(row.revision) || row.revision! < 0) return undefined;
			return { settings, ns, revision: row.revision!, writable: settings.writable !== false && row.writable !== false };
		} catch {
			return undefined;
		}
	};
	const snapshot = (): RoutingSettingsSnapshot => {
		const found = host();
		return { revision: found?.revision ?? 0, writable: found?.writable === true, value: options.current() };
	};
	return {
		snapshot,
		async patch(patch, expectedRevision) {
			const admitted = admit(patch);
			if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
				throw new RoutingSettingsError(400, "invalid");
			const found = host();
			if (found === undefined) throw new RoutingSettingsError(503, "SETTINGS_PROVIDER_ABSENT");
			if (!found.writable) throw new RoutingSettingsError(403, "SETTINGS_READ_ONLY");
			try {
				await found.settings.update!(found.ns, { routing: admitted }, expectedRevision);
			} catch (error) {
				const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
				if (code === "SETTINGS_CONFLICT") throw new RoutingSettingsError(409, "SETTINGS_CONFLICT");
				if (code === "SETTINGS_READ_ONLY") throw new RoutingSettingsError(403, "SETTINGS_READ_ONLY");
				if (code === "SETTINGS_PROVIDER_ABSENT" || code === "SETTINGS_DISPOSED") {
					throw new RoutingSettingsError(503, "SETTINGS_PROVIDER_ABSENT");
				}
				throw error;
			}
			const after = host();
			// The live reference may lag a tick behind the write; the admitted values are authoritative.
			return {
				revision: after?.revision ?? expectedRevision + 1,
				writable: after?.writable === true,
				value: { ...options.current(), ...admitted },
			};
		},
	};
}
