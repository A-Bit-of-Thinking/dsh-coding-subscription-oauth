/**
 * Human account names. Pure functions only: no I/O, no credential access.
 * The user-visible name is a label chosen by the user, else "<Family> · compte N"
 * where N is the rank among the CURRENT accounts of the family ordered by creation.
 */

export type AccountFamily = "claude" | "codex" | "kimi";
export const ACCOUNT_LABEL_MAX_LENGTH = 40;
const FAMILY_NAMES: Record<AccountFamily, string> = { claude: "Claude", codex: "Codex", kimi: "Kimi" };
/**
 * Control and format characters (zero-width, bidi marks/overrides/isolates such as U+200B, U+200E/F,
 * U+061C, U+202A-202E, U+2066-2069) and line/paragraph separators. The client mirrors this exact class.
 */
const FORBIDDEN_LABEL_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Bidi_Control}]/u;

export type AccountRenameErrorCode = "invalid-label" | "unknown-route";
/** Generic messages only: a label (possibly pasted by mistake) is never echoed. */
export class AccountRenameError extends Error {
	constructor(readonly code: AccountRenameErrorCode) {
		super(code === "invalid-label" ? "Account label is invalid" : "Account route is unavailable");
		this.name = "AccountRenameError";
	}
}

export function accountFamilyName(family: AccountFamily): string {
	return FAMILY_NAMES[family];
}

/** trim, 1..40 characters, no control characters. Empty/whitespace/null/undefined = clear (null). */
export function normalizeAccountLabel(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string") throw new AccountRenameError("invalid-label");
	const label = value.trim();
	if (label.length === 0) return null;
	if ([...label].length > ACCOUNT_LABEL_MAX_LENGTH || FORBIDDEN_LABEL_CHARS.test(label))
		throw new AccountRenameError("invalid-label");
	return label;
}

/** Stored labels predate validation: an unusable one silently falls back to the numbered name. */
function storedLabel(value: string | undefined): string | null {
	try {
		return normalizeAccountLabel(value);
	} catch {
		return null;
	}
}

export interface AccountNameSource {
	readonly id: string;
	readonly createdAt: number;
	readonly label?: string | undefined;
}
export interface AccountDisplay {
	/** "Claude · <label>" or "Claude · compte N". */
	readonly name: string;
	/** User-chosen label, or null when the numbered fallback is used. */
	readonly label: string | null;
	readonly isDefault: boolean;
}

/** Rank by createdAt (ties by id) among the accounts passed in: no holes from deleted accounts. */
export function describeFamilyAccounts(
	family: AccountFamily,
	accounts: readonly AccountNameSource[],
	activeId: string | undefined,
): Map<string, AccountDisplay> {
	const ordered = [...accounts].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const result = new Map<string, AccountDisplay>();
	ordered.forEach((account, index) => {
		const label = storedLabel(account.label);
		result.set(account.id, {
			name: `${accountFamilyName(family)} · ${label ?? `compte ${String(index + 1)}`}`,
			label,
			isDefault: account.id === activeId,
		});
	});
	return result;
}

export const DEFAULT_SUFFIX = " (par défaut)";

/** Model-facing view of a runtime snapshot: compact, names only (no family/label duplicates of the name). */
export function modelFacingAccounts<
	S extends string,
	T extends { name: string; isDefault: boolean; route: string; quota: unknown },
>(snapshot: { state: S; accounts: readonly T[] }) {
	return {
		state: snapshot.state,
		accounts: snapshot.accounts.map(({ name, isDefault, route, quota }) => ({
			name,
			isDefault,
			route,
			quota: quota as T["quota"],
		})),
	};
}
