/** Compact quota windows and actionable account errors. Shared by settings and dock. */

import type { GrokBuildSettingsKey } from "../locales.ts";
import { formatReset, type QuotaRow, quotaNote, windowOf } from "../quotaModel.ts";
import { hintStyle } from "../styles.ts";
import { ProgressBar } from "./ProgressBar.tsx";

type Translate = (key: GrokBuildSettingsKey, params?: Record<string, unknown>) => string;

export function QuotaRowDetails({ t, row, now }: { t: Translate; row: QuotaRow; now: number }) {
	const note = quotaNote(t, row);
	const failed = row.quota.state === "error" || (row.quota.state === "stale" && row.quota.errorCode !== undefined);
	const showWindows = row.quota.state !== "disabled" && row.quota.state !== "unsupported";
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
			{showWindows
				? (["five_hour", "seven_day"] as const).map((id) => {
						const found = windowOf(row, id);
						if (found === undefined) return null;
						const label = id === "five_hour" ? t("routingFiveHour") : t("routingWeek");
						const reset = formatReset(found.resetsAt, id, now);
						return (
							<ProgressBar
								key={id}
								value={found.usedPercent}
								label={`${label} · ${t("quotaUsedPercent", { percent: Math.round(found.usedPercent) })}`}
								compactLabel={label}
								compactValue={t("quotaUsedPercent", { percent: Math.round(found.usedPercent) })}
								{...(reset === undefined ? {} : { meta: t("quotaResetsAt", { time: reset }) })}
							/>
						);
					})
				: null}
			{note === undefined ? null : (
				<div
					style={{ ...hintStyle, ...(failed ? { color: "var(--dsw-alias-state-warn-primary)" } : {}) }}
					role={failed ? "alert" : undefined}
				>
					{note}
				</div>
			)}
		</div>
	);
}
