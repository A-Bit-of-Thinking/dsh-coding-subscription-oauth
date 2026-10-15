/** Read-only account routes and quota windows. Options are edited in DSH settings. */

import { useCallback, useRef, useState } from "react";
import { isRecord, jsonRequest } from "../api.ts";
import { bodyStyle, buttonStyle, cardStyle, hintStyle, monoStyle, titleStyle } from "../styles.ts";
import type { GrokBuildSettingsInjected } from "../types.ts";

const STATUS_PATH = "/plugins/dsh-grok-build/routing";
const USAGE_PATH = "/plugins/dsh-grok-build/routing/usage";

interface QuotaWindow {
	id: "five_hour" | "seven_day";
	usedPercent: number;
	resetsAt?: number;
}
interface RouteRow {
	family: string;
	route: string;
	slot: number;
	quota: { state: string; windows: QuotaWindow[]; fetchedAt?: number; errorCode?: string };
}
interface RoutingView {
	enabled: boolean;
	usageEnabled: boolean;
	state: string;
	accounts: RouteRow[];
}

const num = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Minimal allowlist: anything unexpected is dropped, never displayed. */
function parseView(value: unknown): RoutingView | undefined {
	if (!isRecord(value) || !isRecord(value["flags"]) || !Array.isArray(value["accounts"])) return undefined;
	const accounts: RouteRow[] = [];
	for (const row of value["accounts"]) {
		if (!isRecord(row) || typeof row["route"] !== "string" || typeof row["family"] !== "string" || !num(row["slot"]))
			continue;
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
		accounts.push({
			family: row["family"],
			route: row["route"],
			slot: row["slot"],
			quota: {
				state: typeof quota["state"] === "string" ? quota["state"] : "unknown",
				windows,
				...(num(quota["fetchedAt"]) ? { fetchedAt: quota["fetchedAt"] } : {}),
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

const when = (ms: number | undefined): string => (ms === undefined ? "—" : new Date(ms).toLocaleString());

export function AccountRoutingPanel({ t }: { t: GrokBuildSettingsInjected["t"] }) {
	const [view, setView] = useState<RoutingView | undefined>();
	const [error, setError] = useState<string | undefined>();
	const [busy, setBusy] = useState(false);
	const busyRef = useRef(false);

	const run = useCallback(async (refresh: boolean) => {
		if (busyRef.current) return;
		busyRef.current = true;
		setBusy(true);
		try {
			const parsed = parseView(
				await jsonRequest<unknown>(
					refresh ? USAGE_PATH : STATUS_PATH,
					refresh ? "POST" : "GET",
					refresh ? {} : undefined,
				),
			);
			if (parsed === undefined) throw new Error("Unexpected response");
			setView(parsed);
			setError(undefined);
		} catch {
			// Keep the last good view; server text is never echoed, the localized label is enough.
			setError("failed");
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	}, []);

	// Nothing is requested until the user opens the panel; opening reads cached status only.
	const [open, setOpen] = useState(false);
	const toggle = (): void => {
		const next = !open;
		setOpen(next);
		if (next && view === undefined) void run(false);
	};

	const windowText = (row: RouteRow, id: QuotaWindow["id"]): string => {
		const found = row.quota.windows.find((entry) => entry.id === id);
		return found === undefined
			? t("routingUnknown")
			: `${Math.round(found.usedPercent)} % ${t("routingUsed")} · ${t("routingResets")} ${when(found.resetsAt)}`;
	};

	const body = (
		<>
			{error === undefined ? null : (
				<p style={{ ...bodyStyle, color: "var(--dsw-alias-state-error-primary)" }} role="alert">
					{t("routingQuotaError")}{" "}
					<button type="button" style={buttonStyle} disabled={busy} onClick={() => void run(false)}>
						{t("routingRetry")}
					</button>
				</p>
			)}
			{view === undefined ? (
				busy ? (
					<p style={hintStyle} role="status">
						{t("routingRefreshing")}
					</p>
				) : null
			) : !view.enabled ? (
				<p style={hintStyle}>{t("routingOff")}</p>
			) : (
				<>
					<p style={hintStyle}>
						{t("routingState")}: <span style={monoStyle}>{view.state}</span>
					</p>
					<ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
						{view.accounts.map((row) => (
							<li key={row.route} style={{ ...bodyStyle, overflowWrap: "anywhere" }}>
								<strong>
									{row.family} · {t("routingAccount")} {row.slot}
								</strong>
								<br />
								<span style={monoStyle}>{row.route}</span>
								<br />
								{row.quota.state === "disabled" ? (
									<span style={hintStyle}>{t("routingQuotaOff")}</span>
								) : row.quota.state === "unsupported" ? (
									<span style={hintStyle}>{t("routingQuotaUnsupported")}</span>
								) : (
									<span>
										{t("routingFiveHour")}: {windowText(row, "five_hour")}
										<br />
										{t("routingWeek")}: {windowText(row, "seven_day")}
										<br />
										<span style={hintStyle}>
											{t("routingFetched")}: {when(row.quota.fetchedAt)}
											{row.quota.state === "stale" || row.quota.state === "error"
												? ` · ${row.quota.state}${row.quota.errorCode === undefined ? "" : ` (${row.quota.errorCode})`}`
												: ""}
										</span>
									</span>
								)}
							</li>
						))}
					</ul>
					{view.usageEnabled ? (
						<button type="button" style={buttonStyle} disabled={busy} aria-busy={busy} onClick={() => void run(true)}>
							{busy ? t("routingRefreshing") : t("routingRefresh")}
						</button>
					) : null}
					<p style={hintStyle}>{t("routingNote")}</p>
				</>
			)}
		</>
	);

	return (
		<section style={{ ...cardStyle, gridColumn: "1 / -1" }} aria-labelledby="coding-oauth-routing-title">
			<h3 id="coding-oauth-routing-title" style={{ ...titleStyle, fontSize: 16 }}>
				{t("routingTitle")}
			</h3>
			<p style={bodyStyle}>{t("routingIntro")}</p>
			<button
				type="button"
				style={buttonStyle}
				aria-expanded={open}
				aria-controls="coding-oauth-routing-body"
				onClick={toggle}
			>
				{open ? t("routingHide") : t("routingShow")}
			</button>
			<div id="coding-oauth-routing-body" hidden={!open}>
				{open ? body : null}
			</div>
		</section>
	);
}
