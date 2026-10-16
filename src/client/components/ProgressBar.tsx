/** Usage quota progress bar with threshold-based color. */

import { hintStyle } from "../styles.ts";

export interface ProgressBarProps {
	/** 0–100 used percentage. */
	value: number;
	label?: string;
	meta?: string;
	compactLabel?: string;
	compactValue?: string;
}

function barColor(percent: number): string {
	if (percent >= 90) return "var(--dsw-alias-state-error-primary, #d92d20)";
	if (percent >= 75) return "var(--dsw-alias-state-warn-primary, #e06c00)";
	// Prefer info fill over brand-primary: dark theme inverts brand-primary to near-white.
	return "var(--dsw-alias-button-info-fill, var(--dsw-static-deepseek-500, #4f6ef7))";
}

export function ProgressBar({ value, label, meta, compactLabel, compactValue }: ProgressBarProps) {
	const clamped = Math.max(0, Math.min(100, value));
	if (compactLabel !== undefined) {
		const text = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 } as const;
		return (
			<div
				data-quota-window="true"
				style={{
					display: "flex",
					alignItems: "center",
					gap: 5,
					minWidth: 0,
					fontSize: 11,
					lineHeight: "16px",
					whiteSpace: "nowrap",
				}}
			>
				<span style={{ ...text, flex: "0 1 38px" }} title={compactLabel}>
					{compactLabel}
				</span>
				<div
					role="progressbar"
					aria-label={label}
					aria-valuenow={clamped}
					aria-valuemin={0}
					aria-valuemax={100}
					style={{
						flex: "1 1 48px",
						minWidth: 12,
						height: 5,
						borderRadius: 4,
						background: "var(--dsw-alias-border-l2)",
						overflow: "hidden",
					}}
				>
					<div style={{ width: `${clamped}%`, height: "100%", background: barColor(clamped) }} />
				</div>
				<span style={{ ...text, flex: "0 1 auto" }} title={compactValue}>
					{compactValue}
				</span>
				{meta === undefined ? null : (
					<span style={{ ...text, flex: "0 1 auto", color: "var(--dsw-alias-label-tertiary)" }} title={meta}>
						{meta}
					</span>
				)}
			</div>
		);
	}
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
			{label === undefined ? null : (
				<div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
					<span style={{ ...hintStyle, color: "var(--dsw-alias-label-primary)" }}>{label}</span>
					{meta === undefined ? null : <span style={hintStyle}>{meta}</span>}
				</div>
			)}
			<div
				role="progressbar"
				aria-label={label}
				aria-valuenow={clamped}
				aria-valuemin={0}
				aria-valuemax={100}
				style={{
					height: 8,
					borderRadius: 4,
					background: "var(--dsw-alias-border-l2)",
					overflow: "hidden",
				}}
			>
				<div
					style={{
						width: `${String(clamped)}%`,
						height: "100%",
						borderRadius: 4,
						background: barColor(clamped),
						transition: "width 0.3s ease, background 0.3s ease",
					}}
				/>
			</div>
		</div>
	);
}
