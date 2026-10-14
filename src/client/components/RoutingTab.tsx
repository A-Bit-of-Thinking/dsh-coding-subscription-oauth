/** Routing options: four independent opt-ins and the operator policy. Saves are revision-checked. */

import { useCallback, useEffect, useRef, useState } from "react";
import { isConflictError, isPluginRequestError, isRecord, jsonRequest } from "../api.ts";
import {
	bodyStyle,
	buttonStyle,
	cardStyle,
	errorStyle,
	hintStyle,
	inputStyle,
	primaryButtonStyle,
	successStyle,
	titleStyle,
} from "../styles.ts";
import type { GrokBuildSettingsInjected } from "../types.ts";
import { ToggleSwitch } from "./ToggleSwitch.tsx";

const SETTINGS_PATH = "/plugins/dsh-grok-build/routing/settings";
const POLICY_MAX_BYTES = 64 * 1024;
const FLAGS = ["enabled", "usageEnabled", "guidanceEnabled", "enforcePolicy"] as const;
type Flag = (typeof FLAGS)[number];

interface Draft {
	enabled: boolean;
	usageEnabled: boolean;
	guidanceEnabled: boolean;
	enforcePolicy: boolean;
	policyJson: string;
}
interface Loaded {
	revision: number;
	writable: boolean;
	value: Draft;
}

const FLAG_KEYS: Record<
	Flag,
	{
		label: "routingFlagEnabled" | "routingFlagUsage" | "routingFlagGuidance" | "routingFlagEnforce";
		hint: "routingFlagEnabledHint" | "routingFlagUsageHint" | "routingFlagGuidanceHint" | "routingFlagEnforceHint";
	}
> = {
	enabled: { label: "routingFlagEnabled", hint: "routingFlagEnabledHint" },
	usageEnabled: { label: "routingFlagUsage", hint: "routingFlagUsageHint" },
	guidanceEnabled: { label: "routingFlagGuidance", hint: "routingFlagGuidanceHint" },
	enforcePolicy: { label: "routingFlagEnforce", hint: "routingFlagEnforceHint" },
};

/** Allowlist parse: anything unexpected is dropped rather than displayed. */
function parseLoaded(value: unknown): Loaded | undefined {
	if (!isRecord(value) || !isRecord(value["value"])) return undefined;
	const raw = value["value"];
	const revision = value["revision"];
	if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) return undefined;
	return {
		revision,
		writable: value["writable"] === true,
		value: {
			enabled: raw["enabled"] === true,
			usageEnabled: raw["usageEnabled"] === true,
			guidanceEnabled: raw["guidanceEnabled"] === true,
			enforcePolicy: raw["enforcePolicy"] === true,
			policyJson: typeof raw["policyJson"] === "string" ? raw["policyJson"] : "",
		},
	};
}

type Notice = "saved" | "failed" | "conflict" | "policy" | "readOnly" | "fileTooLarge" | "fileUnreadable";

export function RoutingTab({ t }: { t: GrokBuildSettingsInjected["t"] }) {
	const [loaded, setLoaded] = useState<Loaded | undefined>();
	const [draft, setDraft] = useState<Draft | undefined>();
	const [loadError, setLoadError] = useState(false);
	const [notice, setNotice] = useState<Notice | undefined>();
	const [busy, setBusy] = useState(false);
	const busyRef = useRef(false);

	const load = useCallback(async (keepDraft: boolean) => {
		try {
			const parsed = parseLoaded(await jsonRequest<unknown>(SETTINGS_PATH));
			if (parsed === undefined) throw new Error("unexpected");
			setLoaded(parsed);
			// A conflict reload refreshes the revision but never discards what the user typed.
			setDraft((current) => (keepDraft && current !== undefined ? current : parsed.value));
			setLoadError(false);
		} catch {
			setLoadError(true);
		}
	}, []);

	useEffect(() => {
		void load(false);
	}, [load]);

	const dirty =
		loaded !== undefined &&
		draft !== undefined &&
		(FLAGS.some((flag) => draft[flag] !== loaded.value[flag]) || draft.policyJson !== loaded.value.policyJson);
	const editable = loaded?.writable === true && !busy;

	const save = async (): Promise<void> => {
		if (loaded === undefined || draft === undefined || busyRef.current || !dirty) return;
		const patch: Partial<Draft> = {};
		for (const flag of FLAGS) if (draft[flag] !== loaded.value[flag]) patch[flag] = draft[flag];
		if (draft.policyJson !== loaded.value.policyJson) patch.policyJson = draft.policyJson;
		busyRef.current = true;
		setBusy(true);
		setNotice(undefined);
		try {
			const next = parseLoaded(
				await jsonRequest<unknown>(SETTINGS_PATH, "PATCH", { expectedRevision: loaded.revision, patch }),
			);
			if (next === undefined) throw new Error("unexpected");
			setLoaded(next);
			setDraft(next.value);
			setNotice("saved");
		} catch (error) {
			if (isConflictError(error)) {
				setNotice("conflict");
				await load(true);
			} else if (isPluginRequestError(error) && error.code === "policy_invalid") setNotice("policy");
			else if (isPluginRequestError(error) && error.code === "SETTINGS_READ_ONLY") setNotice("readOnly");
			else setNotice("failed");
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	};

	const importFile = async (file: File | undefined): Promise<void> => {
		if (file === undefined) return;
		if (file.size > POLICY_MAX_BYTES) {
			setNotice("fileTooLarge");
			return;
		}
		try {
			const text = await file.text();
			// Only fills the draft; nothing is saved until the user presses Save.
			setDraft((current) => (current === undefined ? current : { ...current, policyJson: text }));
			setNotice(undefined);
		} catch {
			setNotice("fileUnreadable");
		}
	};

	const noticeText: Record<Notice, string> = {
		saved: t("routingSaved"),
		failed: t("routingSaveFailed"),
		conflict: t("routingConflict"),
		policy: t("routingPolicyRejected"),
		readOnly: t("routingReadOnly"),
		fileTooLarge: t("routingFileTooLarge"),
		fileUnreadable: t("routingFileUnreadable"),
	};

	if (loadError && loaded === undefined) {
		return (
			<div style={cardStyle} role="alert">
				<p style={errorStyle}>{t("routingLoadFailed")}</p>
				<button type="button" style={buttonStyle} onClick={() => void load(false)}>
					{t("routingRetry")}
				</button>
			</div>
		);
	}
	if (loaded === undefined || draft === undefined) {
		return (
			<div style={cardStyle} role="status" aria-busy="true">
				<p style={hintStyle}>{t("routingLoading")}</p>
			</div>
		);
	}

	return (
		<div style={cardStyle} data-unsaved={dirty ? "true" : undefined}>
			<h3 style={{ ...titleStyle, fontSize: 16 }}>{t("tabRouting")}</h3>
			<p style={bodyStyle}>{t("routingTabIntro")}</p>
			{loaded.writable ? null : <p style={hintStyle}>{t("routingReadOnly")}</p>}
			<fieldset style={{ border: "none", padding: 0, margin: 0, display: "grid", gap: 12 }} disabled={!editable}>
				<legend style={{ ...hintStyle, padding: 0 }}>{t("routingOptionsLegend")}</legend>
				{FLAGS.map((flag) => (
					<div key={flag} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
						<ToggleSwitch
							id={`coding-oauth-routing-${flag}`}
							checked={draft[flag]}
							disabled={!editable}
							ariaLabel={t(FLAG_KEYS[flag].label)}
							ariaDescribedBy={`coding-oauth-routing-${flag}-hint`}
							onChange={(checked) => setDraft({ ...draft, [flag]: checked })}
						/>
						<div>
							<label htmlFor={`coding-oauth-routing-${flag}`} style={bodyStyle}>
								<strong>{t(FLAG_KEYS[flag].label)}</strong>
							</label>
							<p id={`coding-oauth-routing-${flag}-hint`} style={hintStyle}>
								{t(FLAG_KEYS[flag].hint)}
							</p>
						</div>
					</div>
				))}
				<div>
					<label htmlFor="coding-oauth-routing-policy" style={bodyStyle}>
						<strong>{t("routingPolicyLabel")}</strong>
					</label>
					<p id="coding-oauth-routing-policy-hint" style={hintStyle}>
						{t("routingPolicyHint")}
					</p>
					<textarea
						id="coding-oauth-routing-policy"
						aria-describedby="coding-oauth-routing-policy-hint"
						style={{
							...inputStyle,
							width: "100%",
							minHeight: 180,
							fontFamily: "ui-monospace, Menlo, Consolas, monospace",
						}}
						spellCheck={false}
						disabled={!editable}
						value={draft.policyJson}
						onChange={(event) => setDraft({ ...draft, policyJson: event.target.value })}
					/>
					<label style={{ ...buttonStyle, display: "inline-block", cursor: editable ? "pointer" : "not-allowed" }}>
						{t("routingPolicyImport")}
						<input
							type="file"
							accept=".json,application/json"
							disabled={!editable}
							style={{ display: "none" }}
							onChange={(event) => {
								void importFile(event.target.files?.[0]);
								event.target.value = "";
							}}
						/>
					</label>
				</div>
			</fieldset>
			<div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
				<button
					type="button"
					style={primaryButtonStyle}
					disabled={!editable || !dirty}
					aria-busy={busy}
					onClick={() => void save()}
				>
					{busy ? t("routingSaving") : t("routingSave")}
				</button>
				<button
					type="button"
					style={buttonStyle}
					disabled={busy || !dirty}
					onClick={() => {
						setDraft(loaded.value);
						setNotice(undefined);
					}}
				>
					{t("routingDiscard")}
				</button>
			</div>
			<p
				role="status"
				aria-live="polite"
				style={notice === "saved" ? successStyle : notice === undefined ? hintStyle : errorStyle}
			>
				{notice === undefined ? "" : noticeText[notice]}
			</p>
		</div>
	);
}
