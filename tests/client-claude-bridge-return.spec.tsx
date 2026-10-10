/** @vitest-environment jsdom */
import { act, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SubscriptionWebAuth } from "../src/auth-routes.ts";
import { CLAUDE_CODE_OAUTH_PROVIDER } from "../src/oauth-providers.ts";
import { finishClaudeBridgeReturn, mountClaudeBridgeReturn, takeClaudeBridgeReturn } from "../src/client/claude-bridge-return.tsx";
import type { jsonRequest } from "../src/client/api.ts";
import { LOGIN_CODE_PATH, STATUS_PATH } from "../src/client/constants.ts";
import { en } from "../src/client/locales.ts";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../src/client/api.ts", async () => ({ ...await vi.importActual("../src/client/api.ts"), jsonRequest: mocks.request }));
const challenge = "https://claude.ai/oauth/authorize?state=pending-state&redirect_uri=http%3A%2F%2Flocalhost%3A53692%2Fcallback";
const callback = "http://localhost:53692/callback?code=fixture-code&state=pending-state";
const attemptId = "fixture-attempt";
const pending = { status: "signing-in", method: "browser", url: challenge, loginAttemptId: attemptId };
const status = (claude: unknown) => ({ providers: { claude } });
const cleanups: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanups.splice(0)) dispose(); vi.useRealTimers(); vi.restoreAllMocks(); mocks.request.mockReset(); window.history.replaceState(null, "", "/"); });

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const abort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			reject(signal?.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		}, milliseconds);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
	});
}

function nativeReturnFixture(exchangeDelayMs: number, initialStatusDelayMs = 0) {
	let authenticated = false;
	const auth = new SubscriptionWebAuth({
		definition: CLAUDE_CODE_OAUTH_PROVIDER,
		availableModels: () => [], visibleModels: () => [], selectedModelIds: () => undefined,
		status: async () => ({ authenticated }),
		store: {
			listAccounts: async () => [{ id: "fixture-account", expires: 9999999999999 }],
			getActiveAccountId: async () => "fixture-account",
		},
		login: async (interaction: import("@earendil-works/pi-ai").AuthInteraction) => {
			interaction.notify({ type: "auth_url", url: challenge });
			await interaction.prompt({ type: "manual_code", message: "fixture" });
			await delay(exchangeDelayMs, interaction.signal);
			authenticated = true;
		},
	} as never);
	let firstRead = true;
	mocks.request.mockImplementation(async (path: string, _method: string, body: { code: string; loginAttemptId: string }, signal?: AbortSignal) => {
		if (signal?.aborted) throw signal.reason;
		if (path === LOGIN_CODE_PATH) {
			await auth.submitCode(body.code, body.loginAttemptId);
			return { ok: true };
		}
		if (firstRead) {
			firstRead = false;
			if (initialStatusDelayMs > 0) await delay(initialStatusDelayMs, signal);
		}
		return status(await auth.status());
	});
	return auth;
}

it("removes the callback fragment before any request and consumes it only once", () => {
	window.history.replaceState({ fixture: true }, "", `/?session=fixture#${new URLSearchParams({ "dsh-claude-callback": callback })}`);
	expect(takeClaudeBridgeReturn(window.location, window.history)).toBe(callback);
	expect(window.location.hash).toBe("");
	expect(window.location.search).toBe("?session=fixture");
	expect(window.history.state).toEqual({ fixture: true });
	expect(takeClaudeBridgeReturn(window.location, window.history)).toBeUndefined();
	expect(mocks.request).not.toHaveBeenCalled();
});

it("clears duplicate or oversized payloads but preserves unrelated fragments", () => {
	window.history.replaceState(null, "", "#dsh-claude-callback=a&dsh-claude-callback=b");
	expect(takeClaudeBridgeReturn(window.location, window.history)).toBe("");
	expect(window.location.hash).toBe("");
	window.history.replaceState(null, "", `#dsh-claude-callback=${"x".repeat(8193)}`);
	expect(takeClaudeBridgeReturn(window.location, window.history)).toBe("");
	expect(window.location.hash).toBe("");
	window.history.replaceState(null, "", "#unrelated");
	expect(takeClaudeBridgeReturn(window.location, window.history)).toBeUndefined();
	expect(window.location.hash).toBe("#unrelated");
});

it("submits a matching callback once and waits beyond POST acceptance for persisted signed-in state", async () => {
	const controller = new AbortController();
	let confirmed = false;
	const request = vi.fn(async (path: string) => path === LOGIN_CODE_PATH ? { ok: true } : status(confirmed ? { status: "signed-in", completedLoginAttemptId: attemptId } : pending));
	const wait = vi.fn(async () => { confirmed = true; });
	await finishClaudeBridgeReturn(callback, controller.signal, { request: request as typeof jsonRequest, wait });
	expect(request.mock.calls.filter(([path]) => path === STATUS_PATH)).toHaveLength(3);
	expect(request.mock.calls.filter(([path]) => path === LOGIN_CODE_PATH)).toHaveLength(1);
	expect(request).toHaveBeenCalledWith(LOGIN_CODE_PATH, "POST", { provider: "claude", code: callback, loginAttemptId: attemptId }, controller.signal);
	expect(wait).toHaveBeenCalledOnce();
});

it.each([
	status({ ...pending, url: challenge.replace("pending-state", "another-state") }),
	status({ status: "signed-in" }),
	status({ ...pending, method: "device" }),
	status({ ...pending, url: challenge.replace("claude.ai", "example.com") }),
	status({ ...pending, loginAttemptId: undefined }),
	status({ ...pending, loginAttemptId: "" }),
])("rejects a stale or unrelated pending login before submission", async (initial) => {
	const request = vi.fn(async () => initial);
	await expect(finishClaudeBridgeReturn(callback, new AbortController().signal, { request: request as typeof jsonRequest, wait: vi.fn() })).rejects.toThrow();
	expect(request).toHaveBeenCalledOnce();
});

it("does not report success when native exchange fails after accepting the callback", async () => {
	let reads = 0;
	const request = vi.fn(async (path: string) => path === LOGIN_CODE_PATH ? { ok: true } : status(++reads === 1 ? pending : { status: "error" }));
	await expect(finishClaudeBridgeReturn(callback, new AbortController().signal, { request: request as typeof jsonRequest, wait: vi.fn() })).rejects.toThrow("did not complete");
});

it("rejects a failed new exchange even when native status preserves an existing signed-in account", async () => {
	let reads = 0;
	const request = vi.fn(async (path: string) => path === LOGIN_CODE_PATH ? { ok: true } : status(++reads === 1 ? pending : {
		status: "signed-in",
		operationError: "fixture token exchange failed",
		accounts: [{ id: "existing-account", expires: 9999999999999 }],
		activeAccountId: "existing-account",
	}));
	await expect(finishClaudeBridgeReturn(callback, new AbortController().signal, { request: request as typeof jsonRequest, wait: vi.fn() })).rejects.toThrow("did not complete");
	expect(request.mock.calls.filter(([path]) => path === LOGIN_CODE_PATH)).toHaveLength(1);
});

it.each([
	{ status: "signed-in", activeAccountId: "existing-account" },
	{ status: "signed-in", activeAccountId: "existing-account", completedLoginAttemptId: "previous-attempt" },
	{ ...pending, loginAttemptId: "replacement-attempt" },
])("does not accept cancellation or a different attempt's status as this callback's completion", async (next) => {
	let reads = 0;
	const request = vi.fn(async (path: string) => path === LOGIN_CODE_PATH ? { ok: true } : status(++reads === 1 ? pending : next));
	await expect(finishClaudeBridgeReturn(callback, new AbortController().signal, { request: request as typeof jsonRequest, wait: vi.fn() })).rejects.toThrow("did not complete");
	expect(request.mock.calls.filter(([path]) => path === LOGIN_CODE_PATH)).toHaveLength(1);
});

it("bounds polling and stops without resubmitting a code when canceled", async () => {
	const request = vi.fn(async (path: string) => path === LOGIN_CODE_PATH ? { ok: true } : status(pending));
	await expect(finishClaudeBridgeReturn(callback, new AbortController().signal, { request: request as typeof jsonRequest, wait: vi.fn(async () => {}) })).rejects.toThrow("timed out");
	expect(request.mock.calls.filter(([path]) => path === LOGIN_CODE_PATH)).toHaveLength(1);
	const controller = new AbortController();
	request.mockClear();
	await expect(finishClaudeBridgeReturn(callback, controller.signal, { request: request as typeof jsonRequest, wait: async () => { controller.abort(); } })).rejects.toThrow("stopped");
	expect(request.mock.calls.filter(([path]) => path === LOGIN_CODE_PATH)).toHaveLength(1);
});

it("renders generic recovery text without reflecting callback codes or provider errors", async () => {
	mocks.request.mockRejectedValue(Object.assign(new Error(`upstream error ${callback}`), { name: "PluginRequestError", status: 403 }));
	cleanups.push(mountClaudeBridgeReturn(callback, (key) => en[key]));
	await waitFor(() => expect(document.body.textContent).toContain(en.bridgeReturnFailure));
	expect(document.body.textContent).not.toContain("fixture-code");
	expect(document.body.textContent).not.toContain("pending-state");
	expect(document.body.textContent).not.toContain(en.bridgeReturnSuccess);
});

it("keeps waiting through a valid slow native exchange after the initial status request", async () => {
	vi.useFakeTimers();
	const auth = nativeReturnFixture(29_000, 1500);
	try {
		await auth.signIn("browser");
		const receipt = (await auth.status()).loginAttemptId;
		cleanups.push(mountClaudeBridgeReturn(callback, (key) => en[key]));
		await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
		expect(await auth.status()).toMatchObject({ status: "signed-in", completedLoginAttemptId: receipt });
		expect(document.body.textContent).toContain(en.bridgeReturnSuccess);
		expect(document.body.textContent).not.toContain(en.bridgeReturnFailure);
	} finally {
		await auth.dispose();
	}
});

it("leaves a late native receipt unconfirmed after the observation deadline, without claiming failure or success", async () => {
	vi.useFakeTimers();
	const auth = nativeReturnFixture(65_000);
	try {
		await auth.signIn("browser");
		const receipt = (await auth.status()).loginAttemptId;
		cleanups.push(mountClaudeBridgeReturn(callback, (key) => en[key]));
		await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
		expect(document.body.textContent).toContain(en.bridgeReturnUnconfirmed);
		expect(document.body.textContent).not.toContain(en.bridgeReturnFailure);
		expect(document.body.textContent).not.toContain(en.bridgeReturnSuccess);
		await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
		expect(await auth.status()).toMatchObject({ status: "signed-in", completedLoginAttemptId: receipt });
		expect(document.body.textContent).toContain(en.bridgeReturnUnconfirmed);
		expect(document.body.textContent).not.toContain(en.bridgeReturnSuccess);
		expect(document.body.textContent).not.toContain(en.bridgeReturnFailure);
	} finally {
		await auth.dispose();
	}
});

it("stops observation on unmount while native persistence completes without a second callback submission", async () => {
	vi.useFakeTimers();
	const auth = nativeReturnFixture(5000);
	let dispose: (() => void) | undefined;
	try {
		await auth.signIn("browser");
		const receipt = (await auth.status()).loginAttemptId;
		await act(async () => { dispose = mountClaudeBridgeReturn(callback, (key) => en[key]); });
		expect(mocks.request.mock.calls.filter(([path]) => path === LOGIN_CODE_PATH)).toHaveLength(1);
		const reads = mocks.request.mock.calls.length;
		await act(async () => { dispose!(); dispose = undefined; });
		await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
		expect(await auth.status()).toMatchObject({ status: "signed-in", completedLoginAttemptId: receipt });
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(mocks.request).toHaveBeenCalledTimes(reads);
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		dispose?.();
		await auth.dispose();
	}
});

it.each(["callback acknowledgement", "status observation"])("confirms the same native receipt after a lost %s response without resubmitting", async (phase) => {
	vi.useFakeTimers();
	const auth = nativeReturnFixture(1500);
	const request = mocks.request.getMockImplementation()!;
	let posted = false;
	let failed = false;
	mocks.request.mockImplementation(async (...args) => {
		if (phase === "status observation" && posted && !failed && args[0] === STATUS_PATH) {
			failed = true;
			throw new TypeError("Failed to fetch");
		}
		const result = await request(...args);
		if (args[0] === LOGIN_CODE_PATH) {
			posted = true;
			if (phase === "callback acknowledgement" && !failed) {
				failed = true;
				throw new TypeError("Failed to fetch");
			}
		}
		return result;
	});
	try {
		await auth.signIn("browser");
		const receipt = (await auth.status()).loginAttemptId;
		cleanups.push(mountClaudeBridgeReturn(callback, (key) => en[key]));
		await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
		expect(await auth.status()).toMatchObject({ status: "signed-in", completedLoginAttemptId: receipt });
		expect(document.body.textContent).toContain(en.bridgeReturnSuccess);
		expect(document.body.textContent).not.toContain(en.bridgeReturnFailure);
		expect(mocks.request.mock.calls.filter(([path]) => path === LOGIN_CODE_PATH)).toHaveLength(1);
	} finally {
		await auth.dispose();
	}
});

it("does not observe or resubmit after the API definitively rejects the callback", async () => {
	vi.useFakeTimers();
	const auth = nativeReturnFixture(1500);
	const request = mocks.request.getMockImplementation()!;
	mocks.request.mockImplementation(async (...args) => {
		if (args[0] === LOGIN_CODE_PATH) {
			throw Object.assign(new Error("fixture callback rejected"), { name: "PluginRequestError", status: 403 });
		}
		return request(...args);
	});
	try {
		await auth.signIn("browser");
		cleanups.push(mountClaudeBridgeReturn(callback, (key) => en[key]));
		await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
		expect(document.body.textContent).toContain(en.bridgeReturnFailure);
		expect(document.body.textContent).not.toContain(en.bridgeReturnUnconfirmed);
		expect(mocks.request.mock.calls.filter(([path]) => path === STATUS_PATH)).toHaveLength(1);
		expect(mocks.request.mock.calls.filter(([path]) => path === LOGIN_CODE_PATH)).toHaveLength(1);
	} finally {
		await auth.dispose();
	}
});

it("reports unconfirmed when observation stays unavailable after native persistence", async () => {
	vi.useFakeTimers();
	const auth = nativeReturnFixture(1500);
	const request = mocks.request.getMockImplementation()!;
	let posted = false;
	mocks.request.mockImplementation(async (...args) => {
		if (posted && args[0] === STATUS_PATH) throw new TypeError("Failed to fetch");
		const result = await request(...args);
		if (args[0] === LOGIN_CODE_PATH) posted = true;
		return result;
	});
	try {
		await auth.signIn("browser");
		const receipt = (await auth.status()).loginAttemptId;
		cleanups.push(mountClaudeBridgeReturn(callback, (key) => en[key]));
		await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
		expect(await auth.status()).toMatchObject({ status: "signed-in", completedLoginAttemptId: receipt });
		expect(document.body.textContent).toContain(en.bridgeReturnUnconfirmed);
		expect(document.body.textContent).not.toContain(en.bridgeReturnFailure);
		expect(document.body.textContent).not.toContain(en.bridgeReturnSuccess);
		expect(mocks.request.mock.calls.filter(([path]) => path === LOGIN_CODE_PATH)).toHaveLength(1);
	} finally {
		await auth.dispose();
	}
});

it("bounds an unavailable initial status without submitting any callback", async () => {
	vi.useFakeTimers();
	const auth = nativeReturnFixture(1500, 65_000);
	try {
		await auth.signIn("browser");
		cleanups.push(mountClaudeBridgeReturn(callback, (key) => en[key]));
		await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
		expect(document.body.textContent).toContain(en.bridgeReturnUnconfirmed);
		expect(mocks.request.mock.calls.filter(([path]) => path === LOGIN_CODE_PATH)).toHaveLength(0);
	} finally {
		await auth.dispose();
	}
});

it("contains keyboard focus while pending, focuses recovery, and restores background focus on disposal", async () => {
	const background = document.createElement("div");
	const priorInert = document.createElement("div");
	priorInert.setAttribute("inert", "existing-value");
	const trigger = document.createElement("button");
	trigger.textContent = "Background action";
	background.append(trigger);
	document.body.append(background, priorInert);
	trigger.focus();
	let failRequest: (error: Error) => void = () => undefined;
	mocks.request.mockImplementation(async () => new Promise((_resolve, reject) => { failRequest = reject; }));
	let dispose: (() => void) | undefined;
	try {
		await act(async () => { dispose = mountClaudeBridgeReturn(callback, (key) => en[key]); });
		const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
		expect(document.activeElement).toBe(dialog);
		expect(background.hasAttribute("inert")).toBe(true);
		for (const shiftKey of [false, true]) {
			const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
			dialog.dispatchEvent(event);
			expect(event.defaultPrevented).toBe(true);
			expect(document.activeElement).toBe(dialog);
		}
		await act(async () => { failRequest(Object.assign(new Error("fixture failure"), { name: "PluginRequestError", status: 403 })); });
		const close = dialog.querySelector<HTMLButtonElement>("button")!;
		expect(document.activeElement).toBe(close);
		for (const shiftKey of [false, true]) {
			const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
			close.dispatchEvent(event);
			expect(event.defaultPrevented).toBe(true);
			expect(document.activeElement).toBe(close);
		}
		dispose!();
		dispose = undefined;
		expect(background.hasAttribute("inert")).toBe(false);
		expect(priorInert.getAttribute("inert")).toBe("existing-value");
		expect(document.activeElement).toBe(trigger);
	} finally {
		dispose?.();
		background.remove();
		priorInert.remove();
	}
});
