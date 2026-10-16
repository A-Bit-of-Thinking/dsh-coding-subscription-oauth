/**
 * Quota sources of fixed account routes: one uniform, secret-free reading shape for Claude and Codex.
 * Pure wiring, no scheduling: timing rules (automatic cadence, minimal delay, backoff) live in the runtime.
 */
import { type ClaudeUsage, createClaudeUsageReader } from "./claude-usage.ts";
import { type CodexUsage, createCodexUsageReader } from "./codex-usage.ts";

/** Automatic read cadence while routing and quota reads are both enabled. */
export const QUOTA_AUTO_REFRESH_MS = 15 * 60_000;
/** No two network reads of the same route closer than this, whatever the trigger (timer, tool, HTTP). */
export const QUOTA_MIN_READ_INTERVAL_MS = 60_000;
/**
 * A reading older than this is reported "stale". It must exceed the automatic cadence, otherwise a healthy
 * route would be "stale" most of the time between two ticks.
 */
export const QUOTA_STALE_AFTER_MS = QUOTA_AUTO_REFRESH_MS + 5 * 60_000;
/** The status tool re-reads a route whose reading is older than this (still at most once per minimal interval). */
export const QUOTA_TOOL_REFRESH_AFTER_MS = 300_000;
/**
 * Hard deadline of one read, enforced by the runtime whatever the source does (the wait is raced against
 * it, and it also aborts the signal handed to the source); independent of any caller waiting for it.
 */
export const QUOTA_READ_TIMEOUT_MS = 20_000;
/** Backoff doubles after each RATE_LIMIT, up to this factor, and resets after a successful read. */
export const QUOTA_MAX_BACKOFF_FACTOR = 8;

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
	resolveAccess(): Promise<{ accessToken: string; generation: string; accountId?: string }>;
	isCurrent(generation: string): Promise<boolean>;
	/** Marks a rejected access token expired so the next `resolveAccess` refreshes (Codex 401 retry). */
	invalidateAccess?(rejected: string | undefined): Promise<void>;
}
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function createClaudeQuotaSource(access: QuotaAccess, fetchImpl?: FetchLike): QuotaSource {
	const reader = createClaudeUsageReader({
		auth: { resolve: () => access.resolveAccess(), isCurrent: (generation) => access.isCurrent(generation) },
		...(fetchImpl === undefined ? {} : { fetchImpl }),
	});
	return {
		read: async (signal) => {
			await reader.read({ signal });
		},
		cached: () => reader.getCached(),
		clear: () => reader.clear(),
	};
}

const FIVE_HOURS_S = 18_000;
const SEVEN_DAYS_S = 604_800;
/**
 * The main "codex" rate limit only; its 5 h and 7 d windows (exact durations). Any other duration or
 * additional bucket is ignored rather than guessed. Codex reports `resetsAt` in seconds: converted to ms.
 */
export function codexQuotaWindows(usage: CodexUsage): QuotaWindow[] {
	const windows: QuotaWindow[] = [];
	for (const window of usage.rateLimits.find((limit) => limit.id === "codex")?.windows ?? []) {
		const id =
			window.windowSeconds === FIVE_HOURS_S
				? "five_hour"
				: window.windowSeconds === SEVEN_DAYS_S
					? "seven_day"
					: undefined;
		if (id === undefined || windows.some((existing) => existing.id === id)) continue;
		windows.push({
			id,
			usedPercent: window.usedPercent,
			remainingPercent: window.remainingPercent,
			windowSeconds: window.windowSeconds,
			...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt * 1000 }),
		});
	}
	return windows;
}

export function createCodexQuotaSource(access: QuotaAccess, fetchImpl?: FetchLike): QuotaSource {
	let lastAccessToken: string | undefined;
	const reader = createCodexUsageReader({
		auth: {
			resolve: async () => {
				const { accessToken, accountId } = await access.resolveAccess();
				lastAccessToken = accessToken;
				return { accessToken, ...(accountId === undefined ? {} : { accountId }) };
			},
			// After a 401 the rejected token is marked expired, so the single retry resolves a refreshed one.
			invalidate: async () => access.invalidateAccess?.(lastAccessToken),
		},
		...(fetchImpl === undefined ? {} : { fetchImpl }),
	});
	let cached: QuotaReading | undefined;
	let epoch = 0;
	return {
		read: async (signal) => {
			const started = epoch;
			const usage = await reader.read({ signal });
			if (started === epoch) cached = { windows: codexQuotaWindows(usage), fetchedAt: usage.fetchedAt };
		},
		cached: () => (cached === undefined ? undefined : { ...cached, windows: cached.windows.map((w) => ({ ...w })) }),
		clear() {
			epoch += 1;
			cached = undefined;
			reader.clear();
		},
	};
}
