/**
 * Composer dock button "Quotas" with a floating, minimizable panel (slot `conversation.composer.dock`).
 * Network: one cached GET /routing at mount (to know whether routing is enabled), then, only while the
 * panel is open and the tab visible, one GET every 60 s. Provider reads happen only on the Refresh button.
 */

import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isPluginRequestError } from "../api.ts";
import type { GrokBuildSettingsKey } from "../locales.ts";
import type { ResizeEdge } from "../quotaDockPlacement.ts";
import { ensureQuotaDockStyles } from "../quotaDockStyles.ts";
import {
	quotaSchedule,
	ROUTING_STATUS_PATH,
	ROUTING_USAGE_PATH,
	type RoutingView,
	readRouting,
	refreshOutcome,
} from "../quotaModel.ts";
import { useQuotaPanelGeometry } from "../useQuotaPanelGeometry.ts";
import { QuotaRowDetails } from "./QuotaRowDetails.tsx";

type Translate = (key: GrokBuildSettingsKey, params?: Record<string, unknown>) => string;

export const QUOTA_POLL_MS = 60_000;

export function QuotaDock({ t }: { t: Translate }) {
	const [view, setView] = useState<RoutingView | undefined>();
	const [loadFailed, setLoadFailed] = useState(false);
	const [unavailable, setUnavailable] = useState(false);
	const [open, setOpen] = useState(false);
	const [minimized, setMinimized] = useState(false);
	const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState<"current" | "failed" | "provider" | undefined>();
	const trigger = useRef<HTMLButtonElement>(null);
	const panel = useRef<HTMLDivElement>(null);
	const { placement, active, gesture, start, reset, keyDown } = useQuotaPanelGeometry(open, trigger);
	const mounted = useRef(true);
	const reading = useRef(false);
	const refreshing = useRef(false);
	const viewRef = useRef<RoutingView | undefined>(undefined);
	viewRef.current = view;

	useEffect(() => {
		ensureQuotaDockStyles();
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	/** Cached read (GET). Overlapping reads are dropped; a failure keeps the last good view. */
	const load = useCallback(async (): Promise<void> => {
		if (reading.current || refreshing.current) return;
		reading.current = true;
		try {
			const next = await readRouting(ROUTING_STATUS_PATH);
			if (!mounted.current) return;
			setView(next);
			setLoadFailed(false);
			setUnavailable(false);
		} catch (error) {
			if (!mounted.current) return;
			// 403/404 = not the owner or route absent: stay invisible instead of showing a broken button.
			const status = isPluginRequestError(error) ? error.status : 0;
			if (viewRef.current === undefined && (status === 403 || status === 404)) setUnavailable(true);
			setLoadFailed(true);
		} finally {
			reading.current = false;
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	// Routing switched off while the panel is open: close it. It is not reopened if routing comes back.
	useEffect(() => {
		if (view !== undefined && !view.enabled) setOpen(false);
	}, [view]);

	// One cached read each time the panel opens.
	useEffect(() => {
		if (open) void load();
	}, [open, load]);

	// Poll only while open and while quota reading is on (otherwise nothing new can arrive); skip ticks while
	// the tab is hidden and catch up when it becomes visible.
	const pollable = view?.enabled === true && view.usageEnabled;
	useEffect(() => {
		if (!open || minimized || !pollable) return;
		const tick = (): void => {
			if (document.visibilityState !== "hidden") void load();
		};
		const onVisible = (): void => {
			if (document.visibilityState === "visible") void load();
		};
		const timer = setInterval(tick, QUOTA_POLL_MS);
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			clearInterval(timer);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [open, minimized, pollable, load]);

	const close = useCallback((restoreFocus: boolean): void => {
		setOpen(false);
		if (restoreFocus) queueMicrotask(() => trigger.current?.focus());
	}, []);

	// Escape + outside pointer close the panel.
	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") close(true);
		};
		const onPointer = (event: Event): void => {
			if (gesture.current !== undefined) return;
			const target = event.target as Node | null;
			if (target === null || trigger.current?.contains(target) || panel.current?.contains(target)) return;
			close(false);
		};
		document.addEventListener("keydown", onKey);
		document.addEventListener("pointerdown", onPointer);
		document.addEventListener("mousedown", onPointer);
		return () => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("pointerdown", onPointer);
			document.removeEventListener("mousedown", onPointer);
		};
	}, [open, close, gesture]);

	// Move focus into the panel once, after the first positioned render: until `placement` exists the panel is
	// visibility:hidden and a hidden element cannot take focus (the portal is not next to the button in tab order).
	const placed = placement !== undefined;
	useEffect(() => {
		if (open && placed) panel.current?.querySelector<HTMLElement>("button")?.focus();
	}, [open, placed]);

	const refresh = async (): Promise<void> => {
		if (refreshing.current) return;
		refreshing.current = true;
		setBusy(true);
		setNotice(undefined);
		const before = viewRef.current;
		try {
			const next = await readRouting(ROUTING_USAGE_PATH, true);
			if (!mounted.current) return;
			setView(next);
			setLoadFailed(false);
			// HTTP 200 does not mean the provider answered. The server serves its current snapshot when the
			// last read is too recent ("current"); a provider failure shows its cause, never "read recently".
			const outcome = refreshOutcome(before, next);
			if (outcome === "current") setNotice("current");
			else if (outcome === "provider-error") setNotice("provider");
		} catch {
			if (mounted.current) setNotice("failed");
		} finally {
			refreshing.current = false;
			if (mounted.current) setBusy(false);
		}
	};

	const trapTab = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
		if (event.key !== "Tab") return;
		const items = [
			...(panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]') ?? []),
		].filter((item) => item.closest("[hidden]") === null);
		const first = items[0];
		const last = items.at(-1);
		if (first === undefined || last === undefined) return;
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	};

	if (unavailable || (view !== undefined && !view.enabled)) return null;
	if (view === undefined && !loadFailed) return null;

	const now = Date.now();
	const schedule = view === undefined ? "" : quotaSchedule(t, view, now);

	return (
		<span style={{ display: "inline-flex", flex: "none" }}>
			<button
				ref={trigger}
				type="button"
				className="dsh-coding-oauth-quota-trigger"
				aria-label={t("quotaButtonAria")}
				aria-haspopup="dialog"
				aria-expanded={open}
				onClick={() => setOpen((value) => !value)}
			>
				<span>{t("quotaButton")}</span>
			</button>
			{open && typeof document !== "undefined"
				? createPortal(
						<div
							ref={panel}
							className="dsh-coding-oauth-quota-panel"
							role="dialog"
							aria-label={t("quotaPopupTitle")}
							data-minimized={minimized}
							data-dragging={active}
							style={
								placement === undefined
									? { visibility: "hidden", left: 0, top: 0 }
									: { ...placement, height: minimized ? 48 : placement.height }
							}
							onKeyDown={trapTab}
						>
							{/* biome-ignore lint/a11y/useSemanticElements: draggable title bar, not a fieldset. */}
							<div
								className="dsh-coding-oauth-quota-header"
								role="group"
								aria-label={t("quotaMoveResize")}
								// biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard move/resize target required by the spec.
								tabIndex={0}
								onPointerDown={(event) => start(event)}
								onKeyDown={keyDown}
								onDoubleClick={(event) => {
									if (!(event.target as Element).closest("button")) reset();
								}}
							>
								<h2 className="dsh-coding-oauth-quota-title">{t("quotaPopupTitle")}</h2>
								<button
									type="button"
									className="dsh-coding-oauth-quota-icon"
									aria-expanded={!minimized}
									aria-controls="dsh-coding-oauth-quota-body"
									aria-label={t("quotaToggleDetails")}
									title={t("quotaToggleDetails")}
									onClick={() => setMinimized((value) => !value)}
								>
									{minimized ? "▢" : "–"}
								</button>
								<button
									type="button"
									className="dsh-coding-oauth-quota-icon"
									aria-label={t("quotaClose")}
									title={t("quotaClose")}
									onClick={() => close(true)}
								>
									×
								</button>
								<button
									type="button"
									className="dsh-coding-oauth-quota-icon"
									aria-label={t("quotaResetPosition")}
									title={t("quotaResetPosition")}
									onClick={reset}
								>
									↺
								</button>
							</div>
							<div id="dsh-coding-oauth-quota-body" className="dsh-coding-oauth-quota-body" hidden={minimized}>
								{loadFailed ? (
									<p className="dsh-coding-oauth-quota-message" data-tone="error" role="alert">
										{t("quotaLoadFailed")}{" "}
										<button type="button" className="dsh-coding-oauth-quota-button" onClick={() => void load()}>
											{t("routingRetry")}
										</button>
									</p>
								) : null}
								{view === undefined ? null : (
									<>
										{view.accounts.length === 0 ? (
											<p className="dsh-coding-oauth-quota-message">{t("quotaNoAccounts")}</p>
										) : (
											<div className="dsh-coding-oauth-quota-accounts">
												{view.accounts.map((row, index) => (
													<section key={row.route} className="dsh-coding-oauth-quota-account" aria-label={row.name}>
														<button
															type="button"
															className="dsh-coding-oauth-quota-account-toggle"
															aria-expanded={!collapsed[row.route]}
															aria-controls={`dsh-quota-account-${index}`}
															onClick={() =>
																setCollapsed((previous) => ({ ...previous, [row.route]: !previous[row.route] }))
															}
															onKeyDown={(event) => {
																if (event.key === "Enter" || event.key === " ") {
																	event.preventDefault();
																	if (!event.repeat) event.currentTarget.click();
																}
															}}
														>
															<svg
																className="dsh-coding-oauth-quota-chevron"
																viewBox="0 0 16 16"
																width="12"
																height="12"
																aria-hidden="true"
															>
																<path d="m5 3 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.5" />
															</svg>
															<span className="dsh-coding-oauth-quota-name">
																{row.name}
																{row.isDefault ? (
																	<span className="dsh-coding-oauth-quota-default">{t("quotaDefaultMark")}</span>
																) : null}
															</span>
														</button>
														<div id={`dsh-quota-account-${index}`} hidden={!!collapsed[row.route]}>
															<QuotaRowDetails t={t} row={row} now={now} spacious />
														</div>
													</section>
												))}
											</div>
										)}
										<div className="dsh-coding-oauth-quota-actions">
											{view.usageEnabled ? (
												<button
													type="button"
													className="dsh-coding-oauth-quota-button"
													disabled={busy}
													aria-busy={busy}
													onClick={() => void refresh()}
												>
													{busy ? t("quotaRefreshing") : t("quotaRefresh")}
												</button>
											) : null}
											{schedule ? (
												<span className="dsh-coding-oauth-quota-schedule" title={schedule}>
													{schedule}
												</span>
											) : null}
										</div>
										{view.usageEnabled ? null : (
											<p className="dsh-coding-oauth-quota-message">{t("quotaReadOnlyHint")}</p>
										)}
										{notice === undefined ? null : (
											<p
												className="dsh-coding-oauth-quota-message"
												data-tone={notice === "failed" ? "error" : undefined}
												role={notice === "failed" ? "alert" : "status"}
											>
												{notice === "failed"
													? t("quotaRefreshFailed")
													: notice === "provider"
														? t("quotaRefreshProviderError")
														: t("quotaRefreshCurrent")}
											</p>
										)}
									</>
								)}
							</div>
							{minimized
								? null
								: (["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const).map((edge: ResizeEdge) => (
										<div
											key={edge}
											className="dsh-coding-oauth-quota-resize"
											data-edge={edge}
											aria-hidden="true"
											onPointerDown={(event) => start(event, edge)}
										/>
									))}
						</div>,
						document.body,
					)
				: null}
		</span>
	);
}
