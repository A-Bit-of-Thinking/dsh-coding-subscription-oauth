/**
 * Quota sources of fixed account routes: one uniform, secret-free reading shape for Claude and Codex.
 * Pure wiring, no scheduling: timing rules (automatic cadence, minimal delay, backoff) live in the runtime.
 */
import { type ClaudeUsage } from "./claude-usage.js";
import { type CodexUsage } from "./codex-usage.js";
/** Automatic read cadence while routing and quota reads are both enabled. */
export declare const QUOTA_AUTO_REFRESH_MS: number;
/** No two network reads of the same route closer than this, whatever the trigger (timer, tool, HTTP). */
export declare const QUOTA_MIN_READ_INTERVAL_MS = 60000;
/** A reading older than this is reported "stale" (and refreshed by the status tool). */
export declare const QUOTA_STALE_AFTER_MS = 300000;
/**
 * Hard deadline of one read, enforced by the runtime whatever the source does (the wait is raced against
 * it, and it also aborts the signal handed to the source); independent of any caller waiting for it.
 */
export declare const QUOTA_READ_TIMEOUT_MS = 20000;
/** Backoff doubles after each RATE_LIMIT, up to this factor, and resets after a successful read. */
export declare const QUOTA_MAX_BACKOFF_FACTOR = 8;
export type QuotaWindow = ClaudeUsage["windows"][number];
export type QuotaState = "disabled" | "unsupported" | "not-read" | "fresh" | "stale" | "error" | "unknown";
export interface QuotaReading {
    readonly windows: readonly QuotaWindow[];
    readonly fetchedAt: number;
}
export interface QuotaSource {
    /** Reads and stores the result; the stored reading is exposed by `cached()`. Throws an LlmError on failure. */
    read(signal: AbortSignal): Promise<void>;
    cached(): QuotaReading | undefined;
    clear(): void;
}
/** The narrow part of a fixed-account adapter the quota readers need. */
export interface QuotaAccess {
    resolveAccess(): Promise<{
        accessToken: string;
        generation: string;
        accountId?: string;
    }>;
    isCurrent(generation: string): Promise<boolean>;
    /** Marks a rejected access token expired so the next `resolveAccess` refreshes (Codex 401 retry). */
    invalidateAccess?(rejected: string | undefined): Promise<void>;
}
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export declare function createClaudeQuotaSource(access: QuotaAccess, fetchImpl?: FetchLike): QuotaSource;
/**
 * The main "codex" rate limit only; its 5 h and 7 d windows (exact durations). Any other duration or
 * additional bucket is ignored rather than guessed. Codex reports `resetsAt` in seconds: converted to ms.
 */
export declare function codexQuotaWindows(usage: CodexUsage): QuotaWindow[];
export declare function createCodexQuotaSource(access: QuotaAccess, fetchImpl?: FetchLike): QuotaSource;
export {};
//# sourceMappingURL=account-quota.d.ts.map