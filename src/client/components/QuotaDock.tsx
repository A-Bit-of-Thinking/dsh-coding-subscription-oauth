/**
 * Composer dock button "Quotas" with a floating, minimizable panel (slot `conversation.composer.dock`).
 * Network: one cached GET /routing at mount (to know whether routing is enabled), then, only while the
 * panel is open and the tab visible, one GET every 60 s. Provider reads happen only on the Refresh button.
 */

import {
	type KeyboardEvent as ReactKeyboardEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { isPluginRequestError } from "../api.ts";
import type { GrokBuildSettingsKey } from "../locales.ts";
import { computePlacement, type Placement, samePlacement } from "../quotaDockPlacement.ts";
import { ensureQuotaDockStyles } from "../quotaDockStyles.ts";
import {
	hasOldFiveHour,
	latestFetch,
	ROUTING_STATUS_PATH,
	ROUTING_USAGE_PATH,
	type RoutingView,
	readRouting,
	refreshOutcome,
	updatedAgo,
	worstFiveHour,
} from "../quotaModel.ts";
import { QuotaRowDetails } from "./QuotaRowDetails.tsx";

type Translate = (key: GrokBuildSettingsKey, params?: Record<string, unknown>) => string;

export const QUOTA_POLL_MS = 60_000;

export function QuotaDock({ t }: { t: Translate }) {
	const [view, setView] = useState<RoutingView | undefined>();
	const [loadFailed, setLoadFailed] = useState(false);
	const [unavailable, setUnavailable] = useState(false);
	const [open, setOpen] = useState(false);
	const [minimized, setMinimized] = useState(false);
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState<"current" | "failed" | "provider" | undefined>();
	const [placement, setPlacement] = useState<Placement | undefined>();
	const trigger = useRef<HTMLButtonElement>(null);
	const panel = useRef<HTMLDivElement>(null);
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
		if (!open || !pollable) return;
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
	}, [open, pollable, load]);

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
	}, [open, close]);

	// Anchor above the button (right edges aligned) and bound the panel inside the viewport (8 px margins,
	// width and height capped, internal scroll). Measured synchronously on open and when the view changes
	// (the trigger text can change its width); resize and scroll are coalesced to one measure per frame.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `view` only re-measures the anchor after a content change.
	useLayoutEffect(() => {
		if (!open) {
			setPlacement(undefined);
			return;
		}
		const measure = (): void => {
			const rect = trigger.current?.getBoundingClientRect();
			if (rect === undefined) return;
			const next = computePlacement(rect, { width: window.innerWidth, height: window.innerHeight });
			setPlacement((previous) => (samePlacement(previous, next) ? previous : next));
		};
		measure();
		let frame: number | undefined;
		const schedule = (): void => {
			if (frame !== undefined) return;
			frame = window.requestAnimationFrame(() => {
				frame = undefined;
				measure();
			});
		};
		window.addEventListener("resize", schedule);
		window.addEventListener("scroll", schedule, true);
		return () => {
			window.removeEventListener("resize", schedule);
			window.removeEventListener("scroll", schedule, true);
			if (frame !== undefined) window.cancelAnimationFrame(frame);
		};
	}, [open, view]);

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
		const items = [...(panel.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [])];
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

	const worst = view === undefined ? undefined : worstFiveHour(view);
	const tone =
		loadFailed && view === undefined
			? "error"
			: worst !== undefined && worst >= 90
				? "error"
				: worst !== undefined && worst >= 75
					? "warn"
					: undefined;
	const old = view !== undefined && worst !== undefined && hasOldFiveHour(view);
	const ariaLabel =
		view === undefined
			? t("quotaButtonAriaError")
			: worst === undefined
				? t("quotaButtonAria")
				: t(old ? "quotaButtonAriaWorstOld" : "quotaButtonAriaWorst", { percent: worst });
	const now = Date.now();
	const newest = view === undefined ? undefined : latestFetch(view) || undefined;

	return (
		<span style={{ display: "inline-flex", flex: "none" }}>
			<button
				ref={trigger}
				type="button"
				className="dsh-coding-oauth-quota-trigger"
				data-tone={tone}
				data-stale={old ? "true" : undefined}
				aria-label={ariaLabel}
				title={old ? ariaLabel : undefined}
				aria-haspopup="dialog"
				aria-expanded={open}
				onClick={() => setOpen((value) => !value)}
			>
				<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" fill="currentColor">
					<rect x="1" y="7" width="3" height="6" rx="1" />
					<rect x="5.5" y="3" width="3" height="10" rx="1" />
					<rect x="10" y="5" width="3" height="8" rx="1" />
				</svg>
				<span>{t("quotaButton")}</span>
				{view === undefined ? <span aria-hidden="true">!</span> : null}
				{worst === undefined ? null : <span>{worst}%</span>}
			</button>
			{open && typeof document !== "undefined"
				? createPortal(
						<div
							ref={panel}
							className="dsh-coding-oauth-quota-panel"
							role="dialog"
							aria-label={t("quotaPopupTitle")}
							data-minimized={minimized}
							style={placement === undefined ? { visibility: "hidden", right: 0, bottom: 0 } : placement}
							onKeyDown={trapTab}
						>
							<div className="dsh-coding-oauth-quota-header">
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
											<ul className="dsh-coding-oauth-quota-list">
												{view.accounts.map((row) => (
													<li key={row.route} className="dsh-coding-oauth-quota-account">
														<span className="dsh-coding-oauth-quota-name">
															{row.name}
															{row.isDefault ? (
																<span className="dsh-coding-oauth-quota-default">{t("quotaDefaultMark")}</span>
															) : null}
														</span>
														<QuotaRowDetails t={t} row={row} now={now} />
													</li>
												))}
											</ul>
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
											<span className="dsh-coding-oauth-quota-message">{updatedAgo(t, newest, now)}</span>
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
						</div>,
						document.body,
					)
				: null}
		</span>
	);
}
