/**
 * Human account names. Pure functions only: no I/O, no credential access.
 * The user-visible name is a label chosen by the user, else "<Family> · compte N"
 * where N is the rank among the CURRENT accounts of the family ordered by creation.
 */
export type AccountFamily = "claude" | "codex" | "kimi";
export declare const ACCOUNT_LABEL_MAX_LENGTH = 40;
export type AccountRenameErrorCode = "invalid-label" | "unknown-route";
/** Generic messages only: a label (possibly pasted by mistake) is never echoed. */
export declare class AccountRenameError extends Error {
    readonly code: AccountRenameErrorCode;
    constructor(code: AccountRenameErrorCode);
}
export declare function accountFamilyName(family: AccountFamily): string;
/** trim, 1..40 characters, no control characters. Empty/whitespace/null/undefined = clear (null). */
export declare function normalizeAccountLabel(value: unknown): string | null;
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
export declare function describeFamilyAccounts(family: AccountFamily, accounts: readonly AccountNameSource[], activeId: string | undefined): Map<string, AccountDisplay>;
export declare const DEFAULT_SUFFIX = " (par d\u00E9faut)";
/** Model-facing view of a runtime snapshot: compact, names only (no family/label duplicates of the name). */
export declare function modelFacingAccounts<S extends string, T extends {
    name: string;
    isDefault: boolean;
    route: string;
    quota: unknown;
}>(snapshot: {
    state: S;
    accounts: readonly T[];
}): {
    state: S;
    accounts: {
        name: string;
        isDefault: boolean;
        route: string;
        quota: T["quota"];
    }[];
};
//# sourceMappingURL=account-names.d.ts.map