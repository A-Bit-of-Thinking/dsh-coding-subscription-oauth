/** Shared fixtures for the quota panel and dock client tests (no secrets, example data only). */
import { en } from "../src/client/locales.ts";

export const t = ((key: keyof typeof en, params?: Record<string, unknown>) =>
	en[key].replace(/\{(\w+)\}/gu, (_match, name: string) => String(params?.[name] ?? ""))) as never;

export const failure = (status: number, message = "x") =>
	Object.assign(new Error(message), { name: "PluginRequestError", status });

export interface Row {
	family: string;
	route: string;
	name: string;
	label: string | null;
	isDefault: boolean;
	quota: Record<string, unknown>;
}

export const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

export const row = (overrides: Partial<Row> = {}): Row => ({
	family: "claude",
	route: "route-a",
	name: "Claude · compte 1",
	label: null,
	isDefault: false,
	quota: {
		state: "fresh",
		fetchedAt: NOW - 3 * 60_000,
		windows: [
			{ id: "five_hour", usedPercent: 42.4, windowSeconds: 18_000, resetsAt: NOW + 3_600_000 },
			{ id: "seven_day", usedPercent: 12, windowSeconds: 604_800, resetsAt: NOW + 86_400_000 },
		],
	},
	...overrides,
});

export const snapshot = (accounts: Row[] = [row()], flags: Record<string, unknown> = {}): Record<string, unknown> => ({
	flags: { enabled: true, usageEnabled: true, guidanceEnabled: false, enforcePolicy: false, ...flags },
	policy: { state: "off" },
	state: "ready",
	accounts,
});
