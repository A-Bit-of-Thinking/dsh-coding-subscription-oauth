/** Inline rename of one account: Enter saves, Escape cancels, empty restores the automatic name. */

import { useEffect, useRef, useState } from "react";
import type { GrokBuildSettingsKey } from "../locales.ts";
import {
	ACCOUNT_LABEL_MAX,
	type QuotaRow,
	type RenameFailure,
	type RoutingView,
	renameAccount,
	validateLabel,
} from "../quotaModel.ts";
import { buttonStyle, errorStyle, hintStyle } from "../styles.ts";

type Translate = (key: GrokBuildSettingsKey, params?: Record<string, unknown>) => string;

const FAILURE_KEYS: Record<RenameFailure, GrokBuildSettingsKey> = {
	invalid: "quotaRenameInvalid",
	notFound: "quotaRenameNotFound",
	forbidden: "quotaRenameForbidden",
	failed: "quotaRenameFailed",
};

export function AccountNameEditor({
	t,
	row,
	onRenamed,
	onEditStart,
}: {
	t: Translate;
	row: QuotaRow;
	onRenamed: (view: RoutingView) => void;
	/** Called when the user starts a new edit (lets the parent drop its previous success message). */
	onEditStart?: () => void;
}) {
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<GrokBuildSettingsKey | undefined>();
	const input = useRef<HTMLInputElement>(null);
	const opener = useRef<HTMLButtonElement>(null);
	const mounted = useRef(true);
	const restoreOpenerFocus = useRef(false);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	useEffect(() => {
		if (editing) input.current?.focus();
		else if (restoreOpenerFocus.current) {
			// The opener only exists once the editor is closed and rendered: focus it from an effect.
			restoreOpenerFocus.current = false;
			opener.current?.focus();
		}
	}, [editing]);

	const close = (): void => {
		if (busy) return;
		restoreOpenerFocus.current = true;
		setEditing(false);
		setError(undefined);
	};
	const save = async (): Promise<void> => {
		if (busy) return;
		const checked = validateLabel(value);
		if (!checked.ok) {
			setError("quotaRenameInvalid");
			return;
		}
		setBusy(true);
		setError(undefined);
		const result = await renameAccount(row.route, checked.label);
		if (!mounted.current) return;
		setBusy(false);
		if ("failure" in result) {
			setError(FAILURE_KEYS[result.failure]);
			// The field stays mounted (read-only, not disabled, while sending): keep the keyboard on it.
			input.current?.focus();
			return;
		}
		onRenamed(result.view);
		restoreOpenerFocus.current = true;
		setEditing(false);
		setError(undefined);
	};

	if (!editing) {
		return (
			<button
				ref={opener}
				type="button"
				style={{ ...buttonStyle, minHeight: 28, padding: "2px 10px", fontSize: 13 }}
				onClick={() => {
					setValue(row.label ?? "");
					setEditing(true);
					onEditStart?.();
				}}
			>
				{t("quotaRename")}
			</button>
		);
	}
	const hintId = `coding-oauth-rename-hint-${row.route}`;
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
			<div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
				<input
					ref={input}
					type="text"
					value={value}
					readOnly={busy}
					aria-busy={busy}
					maxLength={ACCOUNT_LABEL_MAX * 2}
					aria-label={t("quotaRenameField", { name: row.name })}
					aria-describedby={hintId}
					aria-invalid={error !== undefined}
					style={{
						minWidth: 0,
						flex: "1 1 160px",
						padding: "4px 8px",
						border: "1px solid var(--dsw-alias-border-l4, rgba(127, 127, 127, 0.4))",
						borderRadius: 8,
						background: "var(--dsw-alias-bg-layer-1)",
						color: "var(--dsw-alias-label-primary)",
						font: "inherit",
					}}
					onChange={(event) => {
						setValue(event.target.value);
						setError(undefined);
					}}
					onKeyDown={(event) => {
						// An IME uses Enter/Escape to confirm or cancel the composition: never save or cancel then.
						if (event.nativeEvent.isComposing || event.keyCode === 229) return;
						if (event.key === "Enter") {
							event.preventDefault();
							void save();
						} else if (event.key === "Escape") {
							event.preventDefault();
							event.stopPropagation();
							close();
						}
					}}
				/>
				<button type="button" style={buttonStyle} aria-disabled={busy} onClick={() => void save()}>
					{busy ? t("quotaRenameSaving") : t("quotaRenameSave")}
				</button>
				<button type="button" style={buttonStyle} aria-disabled={busy} onClick={close}>
					{t("quotaRenameCancel")}
				</button>
			</div>
			<span id={hintId} style={hintStyle}>
				{t("quotaRenameHint")}
			</span>
			{error === undefined ? null : (
				<span style={errorStyle} role="alert">
					{t(error)}
				</span>
			)}
		</div>
	);
}
