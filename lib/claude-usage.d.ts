/**
 * Opt-in candidate for the historically observed private OAuth usage endpoint.
 * Current availability/scopes are NOT guaranteed. General windows only; no
 * invented Sonnet/Opus buckets. Auth and account selection remain parent-owned.
 */
import { LlmError } from "@deepseek-ai/dsh-llm";
export declare const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
/** Internal marker: injected exceptions, even LlmError, must never escape. */
declare class ClaudeUsageError extends LlmError {
}
/** A 429 answered locally while an earlier Retry-After is still running: no request left the process. */
export declare class ClaudeUsageCooldownError extends ClaudeUsageError {
}
export interface ClaudeUsageWindow {
    readonly id: "five_hour" | "seven_day";
    readonly usedPercent: number;
    readonly remainingPercent: number;
    readonly windowSeconds: number;
    readonly resetsAt?: number;
}
export interface ClaudeUsage {
    readonly windows: readonly ClaudeUsageWindow[];
    readonly fetchedAt: number;
}
export interface ClaudeUsageReaderOptions {
    readonly auth: {
        resolve(): Promise<{
            accessToken: string;
            generation: string;
        } | undefined>;
        isCurrent(generation: string): Promise<boolean>;
    };
    readonly fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
    readonly now?: () => number;
    readonly ttlMs?: number;
    readonly requestTimeoutMs?: number;
}
export interface ClaudeUsageReader {
    read(options?: {
        force?: boolean;
        signal?: AbortSignal;
    }): Promise<ClaudeUsage>;
    /** Cache only. Parent MUST clear on credential changes. Returns a deep copy. */
    getCached(): ClaudeUsage | undefined;
    clear(): void;
}
/** Missing/null/invalid utilization is unavailable, never zero. Unknown buckets ignored. */
export declare function normalizeClaudeUsage(payload: unknown, fetchedAt?: number): ClaudeUsage;
export declare function createClaudeUsageReader(options: ClaudeUsageReaderOptions): ClaudeUsageReader;
export {};
//# sourceMappingURL=claude-usage.d.ts.map