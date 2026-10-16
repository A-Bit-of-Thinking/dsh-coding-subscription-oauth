/** Account routes and quotas with explicit states, plus inline rename. Options are edited in DSH settings. */

import { useCallback, useEffect, useRef, useState } from "react";
import { ROUTING_STATUS_PATH, ROUTING_USAGE_PATH, type RoutingView, readRouting } from "../quotaModel.ts";
import { bodyStyle, buttonStyle, cardStyle, hintStyle, monoStyle, titleStyle } from "../styles.ts";
import type { GrokBuildSettingsInjected } from "../types.ts";
import { AccountNameEditor } from "./AccountNameEditor.tsx";
import { QuotaRowDetails } from "./QuotaRowDetails.tsx";

const RENAMED_MESSAGE_MS = 5000;

export function AccountRoutingPanel({ t }: { t: GrokBuildSettingsInjected["t"] }) {
	const [view, setView] = useState<RoutingView | undefined>();
	const [error, setError] = useState<"load" | "refresh" | undefined>();
	const [busy, setBusy] = useState(false);
	const [renamed, setRenamed] = useState(false);
	const busyRef = useRef(false);

	// The success message is transient: it disappears after a delay or when the next edit starts.
	useEffect(() => {
		if (!renamed) return;
		const timer = setTimeout(() => setRenamed(false), RENAMED_MESSAGE_MS);
		return () => clearTimeout(timer);
	}, [renamed]);

	const run = useCallback(async (refresh: boolean) => {
		if (busyRef.current) return;
		busyRef.current = true;
		setBusy(true);
		try {
			setView(await readRouting(refresh ? ROUTING_USAGE_PATH : ROUTING_STATUS_PATH, refresh));
			setError(undefined);
		} catch {
			// Keep the last good view; server text is never echoed, the localized label is enough.
			setError(refresh ? "refresh" : "load");
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
	const now = Date.now();

	const body = (
		<>
			{error === undefined ? null : (
				<p style={{ ...bodyStyle, color: "var(--dsw-alias-state-error-primary)" }} role="alert">
					{error === "refresh" ? t("quotaRefreshFailed") : t("quotaLoadFailed")}{" "}
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
					{view.accounts.length === 0 ? <p style={hintStyle}>{t("quotaNoAccounts")}</p> : null}
					<ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 12 }}>
						{view.accounts.map((row) => (
							<li key={row.route} style={{ ...bodyStyle, overflowWrap: "anywhere", display: "grid", gap: 6 }}>
								<strong>
									{row.name}
									{row.isDefault ? ` ${t("quotaDefaultMark")}` : ""}
								</strong>
								<span style={monoStyle}>{row.route}</span>
								<QuotaRowDetails t={t} row={row} now={now} />
								<AccountNameEditor
									t={t}
									row={row}
									onEditStart={() => setRenamed(false)}
									onRenamed={(next) => {
										setView(next);
										setRenamed(true);
									}}
								/>
							</li>
						))}
					</ul>
					{renamed ? (
						<p style={hintStyle} role="status">
							{t("quotaRenamed")}
						</p>
					) : null}
					{view.usageEnabled ? (
						<button type="button" style={buttonStyle} disabled={busy} aria-busy={busy} onClick={() => void run(true)}>
							{busy ? t("routingRefreshing") : t("routingRefresh")}
						</button>
					) : (
						<p style={hintStyle}>{t("quotaReadOnlyHint")}</p>
					)}
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
