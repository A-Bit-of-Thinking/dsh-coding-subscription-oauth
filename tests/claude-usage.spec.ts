import { LlmError } from "@deepseek-ai/dsh-llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CLAUDE_USAGE_URL,
	type ClaudeUsageReaderOptions,
	createClaudeUsageReader,
	normalizeClaudeUsage,
} from "../src/claude-usage.ts";

const SECRET = "fixture-secret-not-real";
const body = (used = 25) => ({ five_hour: { utilization: used }, seven_day: { utilization: 40 } });
const response = (used = 25) => new Response(JSON.stringify(body(used)));
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function fixture(extra: Partial<ClaudeUsageReaderOptions> = {}) {
	let generation = "generation-a";
	let time = 1_700_000_000_000;
	const auth = {
		resolve: vi.fn(async () => ({ accessToken: SECRET, generation })),
		isCurrent: vi.fn(async (expected: string) => expected === generation),
	};
	const fetchImpl = vi.fn(async (_input: string, _init?: RequestInit) => response());
	const reader = createClaudeUsageReader({ auth, fetchImpl, now: () => time, ...extra });
	return {
		reader,
		auth,
		fetchImpl,
		setGeneration: (value: string) => {
			generation = value;
		},
		advance: (value: number) => {
			time += value;
		},
	};
}
async function flush() {
	for (let index = 0; index < 15; index += 1) await Promise.resolve();
}
async function safeFailure(promise: Promise<unknown>, code: string) {
	const error = await promise.then(
		() => {
			throw new Error("expected failure");
		},
		(value: unknown) => value,
	);
	expect(error).toBeInstanceOf(LlmError);
	expect(error).toMatchObject({ code });
	expect(String(error)).not.toContain(SECRET);
	expect(JSON.stringify(error)).not.toContain(SECRET);
	expect((error as Error).cause).toBeUndefined();
	return error;
}
beforeEach(() => {
	vi.stubGlobal("fetch", () => {
		throw new Error("unexpected real network");
	});
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("Claude usage normalization", () => {
	it("projects only general windows with correct seconds and ISO reset milliseconds", () => {
		const usage = normalizeClaudeUsage(
			{
				five_hour: { utilization: 0, resets_at: "2026-10-01T14:15:00Z", token: SECRET },
				seven_day: { utilization: 100, resets_at: "2026-10-01T16:15:00+02:00" },
				seven_day_sonnet: { utilization: 30 },
				seven_day_opus: { utilization: 50 },
				token: SECRET,
			},
			123,
		);
		expect(usage).toEqual({
			fetchedAt: 123,
			windows: [
				{
					id: "five_hour",
					usedPercent: 0,
					remainingPercent: 100,
					windowSeconds: 18_000,
					resetsAt: Date.parse("2026-10-01T14:15:00Z"),
				},
				{
					id: "seven_day",
					usedPercent: 100,
					remainingPercent: 0,
					windowSeconds: 604_800,
					resetsAt: Date.parse("2026-10-01T14:15:00Z"),
				},
			],
		});
		expect(JSON.stringify(usage)).not.toContain(SECRET);
	});
	it("keeps the reset date when the provider sends microseconds, as the live endpoint does", () => {
		const usage = normalizeClaudeUsage({
			five_hour: { utilization: 10, resets_at: "2026-10-16T15:00:00.123456+00:00" },
			seven_day: { utilization: 20, resets_at: "2026-10-21T08:30:00.000000+00:00" },
		});
		expect(usage.windows.map((window) => window.resetsAt)).toEqual([
			Date.parse("2026-10-16T15:00:00.123Z"),
			Date.parse("2026-10-21T08:30:00Z"),
		]);
	});
	it.each([null, undefined, [], 1, "bad"])("rejects a non-record root %s", (value) => {
		expect(() => normalizeClaudeUsage(value)).toThrow("malformed");
	});
	it.each([null, undefined, -1, 101, NaN, Infinity, "0", false])("omits invalid utilization %s", (value) => {
		expect(normalizeClaudeUsage({ five_hour: { utilization: value }, seven_day: null }).windows).toEqual([]);
	});
	it.each([
		null,
		undefined,
		0,
		"0",
		SECRET,
		"2026-10-01",
		"2026-10-01T12:00:00",
		"2026-99-99T12:00:00Z",
		"2026-02-30T12:00:00Z",
		"2026-10-01T24:00:00Z",
	])("omits invalid reset %s", (value) => {
		expect(normalizeClaudeUsage({ five_hour: { utilization: 10, resets_at: value } }).windows[0]).not.toHaveProperty(
			"resetsAt",
		);
	});
});

describe("Claude bounded HTTP", () => {
	it("creates without auth/network, then uses the exact URL, headers, GET and redirect:error", async () => {
		const f = fixture();
		expect(f.fetchImpl).not.toHaveBeenCalled();
		expect(f.auth.resolve).not.toHaveBeenCalled();
		expect(f.reader.getCached()).toBeUndefined();
		await f.reader.read();
		expect(f.fetchImpl).toHaveBeenCalledOnce();
		expect(f.fetchImpl.mock.calls[0]).toEqual([
			CLAUDE_USAGE_URL,
			{
				method: "GET",
				redirect: "error",
				signal: expect.any(AbortSignal),
				headers: {
					authorization: `Bearer ${SECRET}`,
					"anthropic-beta": "oauth-2025-04-20",
					accept: "application/json",
					"cache-control": "no-store",
					"user-agent": "dsh-coding-subscription-oauth",
				},
			},
		]);
	});
	it.each([
		[401, "AUTH"],
		[403, "PERMISSION"],
		[429, "RATE_LIMIT"],
		[500, "SERVER"],
		[503, "SERVER"],
	] as const)("classifies HTTP %s without reading malformed error bodies", async (status, code) => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(`<html>${SECRET}`));
			},
		});
		const cancel = vi.spyOn(stream, "cancel");
		const fetchImpl = vi.fn(async () => new Response(stream, { status }));
		await safeFailure(fixture({ fetchImpl }).reader.read(), code);
		expect(fetchImpl).toHaveBeenCalledOnce();
		expect(cancel).toHaveBeenCalledOnce();
	});
	it("sanitizes malformed successful JSON and invalid roots", async () => {
		for (const raw of [`<html>${SECRET}`, `{"token":"${SECRET}",`, "null"]) {
			await safeFailure(fixture({ fetchImpl: async () => new Response(raw) }).reader.read(), "SERVER");
		}
	});
	it("rejects declared oversize before reading and cancels", async () => {
		const stream = new ReadableStream<Uint8Array>();
		const cancel = vi.spyOn(stream, "cancel");
		await safeFailure(
			fixture({
				fetchImpl: async () => new Response(stream, { headers: { "content-length": "65537" } }),
			}).reader.read(),
			"SERVER",
		);
		expect(cancel).toHaveBeenCalledOnce();
	});
	it("limits chunked responses, regardless of a lying small Content-Length", async () => {
		const cancel = vi.fn();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(32_768));
				controller.enqueue(new Uint8Array(32_769));
			},
			cancel,
		});
		await safeFailure(
			fixture({ fetchImpl: async () => new Response(stream, { headers: { "content-length": "1" } }) }).reader.read(),
			"SERVER",
		);
		expect(cancel).toHaveBeenCalledOnce();
	});
	it("allows exactly 64KiB JSON", async () => {
		const json = JSON.stringify(body());
		const raw = json + " ".repeat(65_536 - new TextEncoder().encode(json).byteLength);
		await expect(fixture({ fetchImpl: async () => new Response(raw) }).reader.read()).resolves.toMatchObject({
			windows: [{ usedPercent: 25 }, { usedPercent: 40 }],
		});
	});
	it.each([new Error(SECRET), new LlmError(SECRET, "SERVER", { cause: new Error(SECRET) })])(
		"sanitizes transport exceptions including injected LlmError",
		async (error) => {
			const fetchImpl = vi.fn(async () => {
				throw error;
			});
			await safeFailure(fixture({ fetchImpl }).reader.read(), "TRANSPORT");
			expect(fetchImpl).toHaveBeenCalledOnce();
		},
	);
	it("sanitizes stream failures", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.error(new Error(SECRET));
			},
		});
		await safeFailure(fixture({ fetchImpl: async () => new Response(stream) }).reader.read(), "TRANSPORT");
	});
	it("enforces the default 15s timeout even when fetch ignores abort", async () => {
		vi.useFakeTimers();
		const f = fixture({ fetchImpl: () => new Promise<Response>(() => {}) });
		const result = safeFailure(f.reader.read(), "TIMEOUT");
		await flush();
		await vi.advanceTimersByTimeAsync(14_999);
		expect(f.reader.getCached()).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
		await result;
		expect(vi.getTimerCount()).toBe(0);
	});
	it("includes body streaming in timeout and cancels the stream", async () => {
		vi.useFakeTimers();
		const cancel = vi.fn();
		const stream = new ReadableStream<Uint8Array>({ cancel });
		const f = fixture({ fetchImpl: async () => new Response(stream), requestTimeoutMs: 50 });
		const result = safeFailure(f.reader.read(), "TIMEOUT");
		await flush();
		await vi.advanceTimersByTimeAsync(50);
		await result;
		expect(cancel).toHaveBeenCalledOnce();
	});
	it("cancels before auth and during fetch without leaking reason", async () => {
		const controller = new AbortController();
		controller.abort(SECRET);
		const f = fixture();
		await safeFailure(f.reader.read({ signal: controller.signal }), "TIMEOUT");
		expect(f.auth.resolve).not.toHaveBeenCalled();
		const next = new AbortController();
		const pending = fixture({ fetchImpl: () => new Promise<Response>(() => {}) });
		const result = safeFailure(pending.reader.read({ signal: next.signal }), "TIMEOUT");
		await flush();
		next.abort(SECRET);
		await result;
	});
	it.each([
		["2", 2000],
		["Tue, 14 Nov 2023 22:13:24 GMT", 4000],
		["999999999999999999", 300_000],
		["invalid", 60_000],
		["0", 1000],
	] as const)("honors bounded cooldown %s without retries or force bypass", async (retry, expected) => {
		const fetchImpl = vi.fn(async () => new Response(SECRET, { status: 429, headers: { "retry-after": retry } }));
		const f = fixture({ fetchImpl });
		const first = (await safeFailure(f.reader.read(), "RATE_LIMIT")) as LlmError;
		const delay = first.failure.providerRetryAfterMs ?? 0;
		expect(delay).toBe(expected);
		await safeFailure(f.reader.read({ force: true }), "RATE_LIMIT");
		expect(fetchImpl).toHaveBeenCalledOnce();
		f.reader.clear();
		await safeFailure(f.reader.read({ force: true }), "RATE_LIMIT");
		expect(fetchImpl).toHaveBeenCalledOnce();
		f.advance(delay);
		await safeFailure(f.reader.read(), "RATE_LIMIT");
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});
});

describe("Claude cache and generation boundaries", () => {
	it("validates auth before cached reads, defaults TTL to 5min and copies every nested result", async () => {
		const f = fixture();
		const first = await f.reader.read();
		(first.windows[0] as { usedPercent: number }).usedPercent = 99;
		(first.windows as unknown as unknown[]).pop();
		const cached = f.reader.getCached();
		(cached?.windows[0] as { usedPercent: number }).usedPercent = 88;
		expect((await f.reader.read()).windows[0]?.usedPercent).toBe(25);
		expect(f.auth.resolve).toHaveBeenCalledTimes(2);
		expect(f.auth.isCurrent).toHaveBeenCalled();
		f.advance(299_999);
		await f.reader.read();
		expect(f.fetchImpl).toHaveBeenCalledOnce();
		f.advance(1);
		await f.reader.read();
		expect(f.fetchImpl).toHaveBeenCalledTimes(2);
	});
	it("singleflights non-force and returns detached copies to each caller", async () => {
		const network = deferred<Response>();
		const fetchImpl = vi.fn(() => network.promise);
		const f = fixture({ fetchImpl });
		const first = f.reader.read();
		const second = f.reader.read();
		await flush();
		expect(fetchImpl).toHaveBeenCalledOnce();
		network.resolve(response());
		const [a, b] = await Promise.all([first, second]);
		expect(a).not.toBe(b);
		expect(a.windows[0]).not.toBe(b.windows[0]);
	});
	it("a cancelled joiner does not cancel the shared GET", async () => {
		const network = deferred<Response>();
		const f = fixture({ fetchImpl: () => network.promise });
		const leader = f.reader.read();
		await flush();
		const controller = new AbortController();
		const joined = safeFailure(f.reader.read({ signal: controller.signal }), "TIMEOUT");
		await flush();
		controller.abort(SECRET);
		await joined;
		network.resolve(response());
		await expect(leader).resolves.toMatchObject({ windows: [{ usedPercent: 25 }, {}] });
	});
	it("force starts a new GET and late old success cannot overwrite it", async () => {
		const old = deferred<Response>();
		const fetchImpl = vi
			.fn()
			.mockImplementationOnce(() => old.promise)
			.mockImplementation(async () => response(90));
		const f = fixture({ fetchImpl });
		const first = f.reader.read();
		await flush();
		const forced = await f.reader.read({ force: true });
		expect(forced.windows[0]?.usedPercent).toBe(90);
		old.resolve(response(10));
		await first;
		expect(f.reader.getCached()?.windows[0]?.usedPercent).toBe(90);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});
	it("clear detaches old GET and does not repopulate", async () => {
		const old = deferred<Response>();
		const f = fixture({ fetchImpl: () => old.promise });
		const first = f.reader.read();
		await flush();
		f.reader.clear();
		old.resolve(response(10));
		await first;
		expect(f.reader.getCached()).toBeUndefined();
	});
	it("a new read after clear does not join the detached request", async () => {
		const old = deferred<Response>();
		const fetchImpl = vi
			.fn()
			.mockImplementationOnce(() => old.promise)
			.mockImplementation(async () => response(80));
		const f = fixture({ fetchImpl });
		const first = f.reader.read();
		await flush();
		f.reader.clear();
		await f.reader.read();
		old.resolve(response(10));
		await first;
		expect(f.reader.getCached()?.windows[0]?.usedPercent).toBe(80);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});
	it("changed generation before cached read fetches separately", async () => {
		const f = fixture();
		await f.reader.read();
		f.setGeneration("generation-b");
		await f.reader.read();
		expect(f.fetchImpl).toHaveBeenCalledTimes(2);
	});
	it("rejects old-account success rather than returning/committing it", async () => {
		const old = deferred<Response>();
		const fetchImpl = vi
			.fn()
			.mockImplementationOnce(() => old.promise)
			.mockImplementation(async () => response(70));
		const f = fixture({ fetchImpl });
		const first = safeFailure(f.reader.read(), "AUTH");
		await flush();
		f.setGeneration("generation-b");
		await f.reader.read();
		old.resolve(response(10));
		await first;
		expect(f.reader.getCached()?.windows[0]?.usedPercent).toBe(70);
	});
	it("sanitizes missing/failed auth and failed generation validation without using cache", async () => {
		const f = fixture();
		await f.reader.read();
		f.auth.resolve.mockRejectedValueOnce(new Error(SECRET));
		await safeFailure(f.reader.read(), "AUTH");
		f.auth.isCurrent.mockRejectedValueOnce(new Error(SECRET));
		await safeFailure(f.reader.read(), "AUTH");
		f.auth.isCurrent.mockResolvedValueOnce(false);
		await safeFailure(f.reader.read(), "AUTH");
		expect(f.fetchImpl).toHaveBeenCalledOnce();
		await safeFailure(
			fixture({ auth: { resolve: async () => undefined, isCurrent: async () => true } }).reader.read(),
			"AUTH",
		);
	});
	it("rejects post-fetch failed generation validation", async () => {
		const f = fixture();
		f.auth.isCurrent.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error(SECRET));
		await safeFailure(f.reader.read(), "AUTH");
		expect(f.reader.getCached()).toBeUndefined();
	});
	it("slow old auth resolution cannot supersede newer generation", async () => {
		const old = deferred<{ accessToken: string; generation: string }>();
		const f = fixture();
		f.auth.resolve.mockImplementationOnce(() => old.promise);
		const first = safeFailure(f.reader.read(), "AUTH");
		f.setGeneration("generation-b");
		await f.reader.read();
		old.resolve({ accessToken: SECRET, generation: "generation-a" });
		await first;
		expect(f.fetchImpl).toHaveBeenCalledOnce();
		expect(f.reader.getCached()).toBeDefined();
	});
	it("clear during pending auth cannot populate or start a detached GET", async () => {
		const old = deferred<{ accessToken: string; generation: string }>();
		const f = fixture();
		f.auth.resolve.mockImplementationOnce(() => old.promise);
		const first = safeFailure(f.reader.read(), "AUTH");
		f.reader.clear();
		old.resolve({ accessToken: SECRET, generation: "generation-a" });
		await first;
		expect(f.fetchImpl).not.toHaveBeenCalled();
	});
	it("old generation 429 cannot impose cooldown on the new generation", async () => {
		const old = deferred<Response>();
		const fetchImpl = vi
			.fn()
			.mockImplementationOnce(() => old.promise)
			.mockImplementation(async () => response(70));
		const f = fixture({ fetchImpl });
		const first = safeFailure(f.reader.read(), "RATE_LIMIT");
		await flush();
		f.setGeneration("generation-b");
		await f.reader.read();
		old.resolve(new Response(SECRET, { status: 429 }));
		await first;
		await f.reader.read({ force: true });
		expect(fetchImpl).toHaveBeenCalledTimes(3);
	});
	it("multiple forced requests remain independent and only latest can commit", async () => {
		const old = deferred<Response>();
		const fetchImpl = vi
			.fn()
			.mockImplementationOnce(() => old.promise)
			.mockImplementation(async () => response(75));
		const f = fixture({ fetchImpl });
		const first = f.reader.read({ force: true });
		await flush();
		await f.reader.read({ force: true });
		old.resolve(response(5));
		await first;
		expect(f.reader.getCached()?.windows[0]?.usedPercent).toBe(75);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});
	it("cancellation during post-fetch generation validation cannot commit", async () => {
		const validation = deferred<boolean>();
		const f = fixture();
		f.auth.isCurrent.mockResolvedValueOnce(true).mockImplementationOnce(() => validation.promise);
		const controller = new AbortController();
		const result = safeFailure(f.reader.read({ signal: controller.signal }), "TIMEOUT");
		await flush();
		expect(f.auth.isCurrent).toHaveBeenCalledTimes(2);
		controller.abort(SECRET);
		await result;
		validation.resolve(true);
		await flush();
		expect(f.reader.getCached()).toBeUndefined();
	});
	it("pending auth and generation callbacks can be cancelled without waiting", async () => {
		for (const phase of ["resolve", "isCurrent"] as const) {
			const f = fixture();
			if (phase === "resolve") f.auth.resolve.mockImplementation(() => new Promise(() => {}));
			else f.auth.isCurrent.mockImplementation(() => new Promise(() => {}));
			const controller = new AbortController();
			const result = safeFailure(f.reader.read({ signal: controller.signal }), "TIMEOUT");
			await flush();
			controller.abort(SECRET);
			await result;
			expect(f.fetchImpl).not.toHaveBeenCalled();
		}
	});
	it("opaque generation and token never occur in projections", async () => {
		const f = fixture();
		f.setGeneration(SECRET);
		expect(JSON.stringify(await f.reader.read())).not.toContain(SECRET);
		expect(JSON.stringify(f.reader.getCached())).not.toContain(SECRET);
	});
});
