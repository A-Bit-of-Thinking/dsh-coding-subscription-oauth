/** Shared, secret-free model of GET /routing used by the settings panel and the composer quota dock. */

import { isPluginRequestError, isRecord, jsonRequest } from "./api.ts";
import type { GrokBuildSettingsKey } from "./locales.ts";

export const ROUTING_STATUS_PATH = "/plugins/dsh-grok-build/routing";
export const ROUTING_USAGE_PATH = "/plugins/dsh-grok-build/routing/usage";
export const ROUTING_LABEL_PATH = "/plugins/dsh-grok-build/routing/accounts/label";
export const ACCOUNT_LABEL_MAX = 40;

export type QuotaWindowId = "five_hour" | "seven_day";
export interface QuotaWindow {
	id: QuotaWindowId;
	usedPercent: number;
	resetsAt?: number;
}
export type QuotaState = "disabled" | "unsupported" | "not-read" | "fresh" | "stale" | "error" | "unknown";
export interface QuotaRow {
	family: string;
	route: string;
	name: string;
	label: string | null;
	isDefault: boolean;
	quota: { state: QuotaState; windows: QuotaWindow[]; fetchedAt?: number; errorCode?: string; nextRefreshAt?: number };
}
export interface RoutingView {
	enabled: boolean;
	usageEnabled: boolean;
	state: string;
	accounts: QuotaRow[];
}

type Translate = (key: GrokBuildSettingsKey, params?: Record<string, unknown>) => string;

const STATES: readonly QuotaState[] = ["disabled", "unsupported", "not-read", "fresh", "stale", "error", "unknown"];
const num = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Minimal allowlist: unexpected fields are dropped and never displayed. */
export function parseRoutingView(value: unknown): RoutingView | undefined {
	if (!isRecord(value) || !isRecord(value["flags"]) || !Array.isArray(value["accounts"])) return undefined;
	const accounts: QuotaRow[] = [];
	for (const row of value["accounts"]) {
		if (!isRecord(row) || typeof row["route"] !== "string" || typeof row["family"] !== "string") continue;
		const quota = isRecord(row["quota"]) ? row["quota"] : {};
		const windows: QuotaWindow[] = [];
		for (const window of Array.isArray(quota["windows"]) ? quota["windows"] : []) {
			if (!isRecord(window) || !num(window["usedPercent"])) continue;
			if (window["id"] !== "five_hour" && window["id"] !== "seven_day") continue;
			windows.push({
				id: window["id"],
				usedPercent: window["usedPercent"],
				...(num(window["resetsAt"]) ? { resetsAt: window["resetsAt"] } : {}),
			});
		}
		const rawState = quota["state"];
		const label = typeof row["label"] === "string" ? row["label"].slice(0, 80) : null;
		const name = typeof row["name"] === "string" && row["name"].length > 0 ? row["name"].slice(0, 120) : row["family"];
		accounts.push({
			family: row["family"],
			route: row["route"],
			name,
			label,
			isDefault: row["isDefault"] === true,
			quota: {
				state: STATES.find((state) => state === rawState) ?? "unknown",
				windows,
				...(num(quota["fetchedAt"]) ? { fetchedAt: quota["fetchedAt"] } : {}),
				...(num(quota["nextRefreshAt"]) ? { nextRefreshAt: quota["nextRefreshAt"] } : {}),
				...(typeof quota["errorCode"] === "string" ? { errorCode: quota["errorCode"].slice(0, 32) } : {}),
			},
		});
	}
	return {
		enabled: value["flags"]["enabled"] === true,
		usageEnabled: value["flags"]["usageEnabled"] === true,
		state: typeof value["state"] === "string" ? value["state"] : "unknown",
		accounts,
	};
}

export async function readRouting(path: string = ROUTING_STATUS_PATH, post = false): Promise<RoutingView> {
	const parsed = parseRoutingView(await jsonRequest<unknown>(path, post ? "POST" : "GET", post ? {} : undefined));
	if (parsed === undefined) throw new Error("Unexpected response");
	return parsed;
}

export const windowOf = (row: QuotaRow, id: QuotaWindowId): QuotaWindow | undefined =>
	row.quota.windows.find((entry) => entry.id === id);

export const latestFetch = (view: RoutingView | undefined): number =>
	view === undefined ? 0 : Math.max(0, ...view.accounts.map((row) => row.quota.fetchedAt ?? 0));

const ERROR_KEYS: Record<string, GrokBuildSettingsKey> = {
	AUTH: "quotaErrAuth",
	PERMISSION: "quotaErrPermission",
	RATE_LIMIT: "quotaErrRateLimit",
	SERVER: "quotaErrServer",
	TIMEOUT: "quotaErrTimeout",
	TRANSPORT: "quotaErrTransport",
	UNAVAILABLE: "quotaErrUnavailable",
	NO_WINDOWS: "quotaErrNoWindows",
};

export type RefreshOutcome = "updated" | "current" | "provider-error" | "nothing";

/**
 * What a manual refresh really achieved, judged from the two snapshots (HTTP 200 does not mean the provider
 * answered): "provider-error" when any readable account is in error or shows a new/changed error code,
 * "updated" when a newer reading arrived, "current" only for fresh/stale numbers that did not advance and
 * carry no new error, "nothing" otherwise (e.g. never read).
 */
export function refreshOutcome(before: RoutingView | undefined, next: RoutingView): RefreshOutcome {
	const previous = new Map((before?.accounts ?? []).map((row) => [row.route, row.quota.errorCode]));
	const readable = next.accounts.filter((row) => row.quota.state !== "disabled" && row.quota.state !== "unsupported");
	const failed = readable.some(
		(row) =>
			row.quota.state === "error" ||
			(row.quota.errorCode !== undefined && row.quota.errorCode !== previous.get(row.route)),
	);
	if (failed) return "provider-error";
	if (latestFetch(next) > latestFetch(before)) return "updated";
	const hasNumbers = readable.some(
		(row) => row.quota.windows.length > 0 && (row.quota.state === "fresh" || row.quota.state === "stale"),
	);
	return hasNumbers ? "current" : "nothing";
}

/** One schedule summary for all accounts, never repeated per row. */
export function quotaSchedule(t: Translate, view: RoutingView, now: number): string {
	const latest = latestFetch(view);
	const future = view.accounts.flatMap((row) => {
		const at = row.quota.nextRefreshAt;
		return at !== undefined && at > now ? [at] : [];
	});
	return [
		latest > 0 ? t("quotaLastRead", { time: formatClock(latest) }) : undefined,
		future.length > 0 ? t("quotaNextRead", { time: formatClock(Math.min(...future)) }) : undefined,
	]
		.filter(Boolean)
		.join(" · ");
}

export function formatClock(ms: number): string {
	try {
		return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	} catch {
		return new Date(ms).toISOString().slice(11, 16);
	}
}

export function errorCause(t: Translate, code: string | undefined): string {
	const key = code === undefined ? undefined : ERROR_KEYS[code];
	return t(key ?? "quotaErrUnknown");
}

/**
 * Human sentence explaining why a row may lack (fresh) numbers; undefined when the numbers are current.
 * Never returns an empty or "unknown" text for a state without numbers.
 */
export function quotaNote(t: Translate, row: QuotaRow): string | undefined {
	const { state, errorCode } = row.quota;
	if (state === "disabled") return t("quotaStateDisabled");
	if (state === "unsupported") return t("quotaStateUnsupported");
	if (state === "error") return t("quotaStateError", { cause: errorCause(t, errorCode) });
	if (state === "stale")
		return errorCode === undefined
			? row.quota.windows.length === 0
				? t("quotaStateNotRead")
				: undefined
			: t("quotaLastReadFailed", { cause: errorCause(t, errorCode) });
	if (state === "not-read") return t("quotaStateNotRead");
	if (state === "unknown")
		return errorCode === undefined
			? row.quota.windows.length === 0
				? t("quotaStateNotRead")
				: undefined
			: t("quotaStateError", { cause: errorCause(t, errorCode) });
	return undefined;
}

export function formatReset(ms: number | undefined, id: QuotaWindowId, now: number): string | undefined {
	if (ms === undefined) return undefined;
	const time = formatClock(ms);
	return id === "seven_day" && ms - now >= 86_400_000
		? `${new Date(ms).toLocaleDateString(undefined, { weekday: "short" })} ${time}`
		: time;
}

/**
 * Client-side mirror of the server rule (must stay identical to it): trim, 1..40 code points, none of the
 * control, format, line/paragraph separator or bidi-control characters. Empty = clear.
 */
const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Bidi_Control}]/u;
export function validateLabel(raw: string): { ok: true; label: string | null } | { ok: false } {
	const label = raw.trim();
	if (label.length === 0) return { ok: true, label: null };
	if ([...label].length > ACCOUNT_LABEL_MAX || FORBIDDEN.test(label)) return { ok: false };
	return { ok: true, label };
}

export type RenameFailure = "invalid" | "notFound" | "forbidden" | "failed";
export async function renameAccount(
	route: string,
	label: string | null,
): Promise<{ view: RoutingView } | { failure: RenameFailure }> {
	try {
		const view = parseRoutingView(await jsonRequest<unknown>(ROUTING_LABEL_PATH, "POST", { route, label }));
		return view === undefined ? { failure: "failed" } : { view };
	} catch (error) {
		const status = isPluginRequestError(error) ? error.status : 0;
		return {
			failure: status === 400 ? "invalid" : status === 404 ? "notFound" : status === 403 ? "forbidden" : "failed",
		};
	}
}
