/**
 * Opt-in candidate for the historically observed private OAuth usage endpoint.
 * Current availability/scopes are NOT guaranteed. General windows only; no
 * invented Sonnet/Opus buckets. Auth and account selection remain parent-owned.
 */
import { LlmError } from "@deepseek-ai/dsh-llm";

export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const MAX_BYTES = 64 * 1024;
const MAX_COOLDOWN_MS = 300_000;

/** Internal marker: injected exceptions, even LlmError, must never escape. */
class ClaudeUsageError extends LlmError {}

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
		resolve(): Promise<{ accessToken: string; generation: string } | undefined>;
		isCurrent(generation: string): Promise<boolean>;
	};
	readonly fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
	readonly now?: () => number;
	readonly ttlMs?: number;
	readonly requestTimeoutMs?: number;
}
export interface ClaudeUsageReader {
	read(options?: { force?: boolean; signal?: AbortSignal }): Promise<ClaudeUsage>;
	/** Cache only. Parent MUST clear on credential changes. Returns a deep copy. */
	getCached(): ClaudeUsage | undefined;
	clear(): void;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function malformed(): LlmError {
	return new ClaudeUsageError("Claude usage response is malformed", "SERVER");
}
function authError(): LlmError {
	return new ClaudeUsageError("Claude usage credentials are unavailable or changed", "AUTH");
}
function aborted(): LlmError {
	return new ClaudeUsageError("Claude usage request cancelled or timed out", "TIMEOUT");
}
function checkAbort(signal?: AbortSignal): void {
	if (signal?.aborted) throw aborted();
}
function copy(value: ClaudeUsage): ClaudeUsage {
	return { fetchedAt: value.fetchedAt, windows: value.windows.map((window) => ({ ...window })) };
}

function isoReset(value: unknown): number | undefined {
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
	)
		return undefined;
	const year = Number(value.slice(0, 4));
	const month = Number(value.slice(5, 7));
	const day = Number(value.slice(8, 10));
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
	if (days === undefined || day < 1 || day > days || Number(value.slice(11, 13)) > 23) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Missing/null/invalid utilization is unavailable, never zero. Unknown buckets ignored. */
export function normalizeClaudeUsage(payload: unknown, fetchedAt = Date.now()): ClaudeUsage {
	if (!record(payload)) throw malformed();
	const windows: ClaudeUsageWindow[] = [];
	for (const [id, windowSeconds] of [
		["five_hour", 18_000],
		["seven_day", 604_800],
	] as const) {
		const raw = payload[id];
		if (!record(raw)) continue;
		const usedPercent = raw["utilization"];
		if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) {
			continue;
		}
		const resetsAt = isoReset(raw["resets_at"]);
		windows.push({
			id,
			usedPercent,
			remainingPercent: 100 - usedPercent,
			windowSeconds,
			...(resetsAt === undefined ? {} : { resetsAt }),
		});
	}
	return { windows, fetchedAt };
}

/** Race even uncooperative injected callbacks/fetch against cancellation. Never expose reason. */
function cancellable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (signal === undefined) return pending;
	if (signal.aborted) {
		void pending.catch(() => undefined);
		return Promise.reject(aborted());
	}
	return new Promise((resolve, reject) => {
		const onAbort = (): void => reject(aborted());
		signal.addEventListener("abort", onAbort, { once: true });
		pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}
function cancelBody(response: Response): void {
	void response.body?.cancel().catch(() => undefined);
}
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_BYTES) {
		cancelBody(response);
		throw new ClaudeUsageError("Claude usage response exceeds size limit", "SERVER");
	}
	if (response.body === null) throw malformed();
	const reader = response.body.getReader();
	const bytes = new Uint8Array(MAX_BYTES);
	let size = 0;
	const cancel = (): void => {
		void reader.cancel().catch(() => undefined);
	};
	signal.addEventListener("abort", cancel, { once: true });
	try {
		for (;;) {
			checkAbort(signal);
			const { done, value } = await cancellable(reader.read(), signal);
			checkAbort(signal);
			if (done) break;
			if (value === undefined || value.byteLength === 0) continue;
			size += value.byteLength;
			if (size > MAX_BYTES) {
				cancel();
				throw new ClaudeUsageError("Claude usage response exceeds size limit", "SERVER");
			}
			bytes.set(value, size - value.byteLength);
		}
	} finally {
		signal.removeEventListener("abort", cancel);
		reader.releaseLock();
	}
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))) as unknown;
	} catch {
		throw malformed();
	}
}
function retryAfter(value: string | null, now: number): number {
	let ms = NaN;
	if (value !== null && value.length <= 128) {
		ms = /^\d+(?:\.\d+)?$/u.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - now;
	}
	return Number.isFinite(ms) && ms >= 0 ? Math.min(MAX_COOLDOWN_MS, Math.max(1000, ms)) : 60_000;
}
function statusError(status: number, retryMs?: number): LlmError {
	const code = status === 401 ? "AUTH" : status === 403 ? "PERMISSION" : status === 429 ? "RATE_LIMIT" : "SERVER";
	return new ClaudeUsageError(`Claude usage request rejected (HTTP ${status})`, code, {
		status,
		...(retryMs === undefined ? {} : { providerRetryAfterMs: retryMs }),
	});
}

export function createClaudeUsageReader(options: ClaudeUsageReaderOptions): ClaudeUsageReader {
	const fetchImpl = options.fetchImpl ?? fetch;
	const now = options.now ?? Date.now;
	const ttlMs = options.ttlMs ?? 300_000;
	const timeoutMs = options.requestTimeoutMs ?? 15_000;
	if (
		!Number.isSafeInteger(ttlMs) ||
		ttlMs < 0 ||
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs <= 0 ||
		timeoutMs > 2_147_483_647
	) {
		throw new TypeError("Claude usage durations must be bounded nonnegative TTL and positive timeout integers");
	}
	let cached: ClaudeUsage | undefined;
	let generation: string | undefined;
	let epoch = 0;
	let callSequence = 0;
	let latestValidated = 0;
	let cooldownUntil = 0;
	let inFlight: { epoch: number; generation: string; promise: Promise<ClaudeUsage> } | undefined;

	const current = async (expected: string): Promise<void> => {
		try {
			if ((await options.auth.isCurrent(expected)) === true) return;
		} catch {
			/* no raw callback errors */
		}
		throw authError();
	};
	const request = async (
		accessToken: string,
		expected: string,
		started: number,
		signal?: AbortSignal,
	): Promise<ClaudeUsage> => {
		const controller = new AbortController();
		const onAbort = (): void => controller.abort();
		const timer = setTimeout(onAbort, timeoutMs);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
		const combined = controller.signal;
		try {
			checkAbort(combined);
			const response = await cancellable(
				fetchImpl(CLAUDE_USAGE_URL, {
					method: "GET",
					redirect: "error",
					signal: combined,
					headers: {
						authorization: `Bearer ${accessToken}`,
						"anthropic-beta": "oauth-2025-04-20",
						accept: "application/json",
						"cache-control": "no-store",
						"user-agent": "dsh-coding-subscription-oauth",
					},
				}).then((value) => {
					if (combined.aborted) {
						cancelBody(value);
						throw aborted();
					}
					return value;
				}),
				combined,
			);
			checkAbort(combined);
			if (!response.ok) {
				cancelBody(response); // Never read or parse provider errors, including malformed HTML.
				const retryMs = response.status === 429 ? retryAfter(response.headers.get("retry-after"), now()) : undefined;
				if (retryMs !== undefined && started === epoch && generation === expected) {
					cooldownUntil = Math.max(cooldownUntil, now() + retryMs);
				}
				throw statusError(response.status, retryMs);
			}
			return normalizeClaudeUsage(await boundedJson(response, combined), now());
		} catch (error) {
			checkAbort(combined);
			// Only module-created errors may cross this seam, not arbitrary fetch exceptions.
			if (error instanceof ClaudeUsageError) throw error;
			throw new ClaudeUsageError("Claude usage request failed", "TRANSPORT");
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	};
	const read = async ({
		force = false,
		signal,
	}: {
		force?: boolean;
		signal?: AbortSignal;
	} = {}): Promise<ClaudeUsage> => {
		checkAbort(signal);
		const sequence = ++callSequence;
		if (force) {
			epoch += 1;
			inFlight = undefined;
		}
		const entering = epoch;
		let access: { accessToken: string; generation: string } | undefined;
		try {
			access = await cancellable(options.auth.resolve(), signal);
		} catch {
			checkAbort(signal);
			throw authError();
		}
		checkAbort(signal);
		if (
			!record(access) ||
			typeof access.accessToken !== "string" ||
			access.accessToken.trim().length === 0 ||
			typeof access.generation !== "string" ||
			access.generation.length === 0
		)
			throw authError();
		access = { accessToken: access.accessToken.trim(), generation: access.generation };
		await cancellable(current(access.generation), signal);
		checkAbort(signal);
		if (entering !== epoch || (sequence < latestValidated && generation !== access.generation)) throw authError();
		latestValidated = Math.max(latestValidated, sequence);
		if (generation !== access.generation) {
			generation = access.generation;
			cached = undefined;
			inFlight = undefined;
			cooldownUntil = 0;
		}
		const started = epoch;
		if (now() < cooldownUntil) throw statusError(429, cooldownUntil - now());
		if (!force && cached !== undefined && now() - cached.fetchedAt >= 0 && now() - cached.fetchedAt < ttlMs) {
			return copy(cached);
		}
		let pending =
			!force && inFlight?.generation === access.generation && inFlight.epoch === epoch ? inFlight.promise : undefined;
		if (pending === undefined) {
			const expected = access.generation;
			pending = request(access.accessToken, expected, started, signal).then(async (value) => {
				await cancellable(current(expected), signal);
				checkAbort(signal);
				if (generation !== expected) throw authError();
				if (started === epoch && generation === expected) cached = copy(value);
				return value;
			});
			const flight = { epoch: started, generation: expected, promise: pending };
			inFlight = flight;
			void pending
				.finally(() => {
					if (inFlight === flight) inFlight = undefined;
				})
				.catch(() => undefined);
		}
		const value = await cancellable(pending, signal);
		await cancellable(current(access.generation), signal);
		checkAbort(signal);
		if (generation !== access.generation) throw authError();
		return copy(value);
	};
	return {
		read,
		getCached: () => (cached === undefined ? undefined : copy(cached)),
		clear() {
			epoch += 1;
			cached = undefined;
			inFlight = undefined;
		},
	};
}
