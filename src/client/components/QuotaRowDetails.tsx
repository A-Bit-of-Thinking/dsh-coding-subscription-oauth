/** Quota windows (5 h / weekly) plus an explicit note when numbers are missing or old. Shared by settings and dock. */

import type { GrokBuildSettingsKey } from "../locales.ts";
import {
	formatClock,
	formatReset,
	nextAutoRead,
	type QuotaRow,
	quotaNote,
	updatedAgo,
	windowOf,
} from "../quotaModel.ts";
import { hintStyle } from "../styles.ts";
import { ProgressBar } from "./ProgressBar.tsx";

type Translate = (key: GrokBuildSettingsKey, params?: Record<string, unknown>) => string;

export function QuotaRowDetails({ t, row, now }: { t: Translate; row: QuotaRow; now: number }) {
	const note = quotaNote(t, row);
	const next = nextAutoRead(row, now);
	const showWindows = row.quota.state !== "disabled" && row.quota.state !== "unsupported";
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
			{showWindows
				? (["five_hour", "seven_day"] as const).map((id) => {
						const found = windowOf(row, id);
						const label = id === "five_hour" ? t("routingFiveHour") : t("routingWeek");
						if (found === undefined) {
							return (
								<div key={id} style={hintStyle}>
									{label}: {t("quotaNoReading")}
								</div>
							);
						}
						const reset = formatReset(found.resetsAt);
						return (
							<ProgressBar
								key={id}
								value={found.usedPercent}
								label={`${label} · ${t("quotaUsedPercent", { percent: Math.round(found.usedPercent) })}`}
								{...(reset === undefined ? {} : { meta: t("quotaResetsAt", { time: reset }) })}
							/>
						);
					})
				: null}
			{note === undefined ? null : (
				<div
					style={{
						...hintStyle,
						color:
							row.quota.state === "error" || row.quota.state === "stale"
								? "var(--dsw-alias-state-warn-primary)"
								: hintStyle.color,
					}}
					role={row.quota.state === "error" ? "alert" : undefined}
				>
					{note}
				</div>
			)}
			{showWindows && row.quota.fetchedAt !== undefined ? (
				<div style={hintStyle}>{updatedAgo(t, row.quota.fetchedAt, now)}</div>
			) : null}
			{showWindows && next !== undefined ? (
				<div style={hintStyle}>{t("quotaNextAutoRead", { time: formatClock(next) })}</div>
			) : null}
		</div>
	);
}
