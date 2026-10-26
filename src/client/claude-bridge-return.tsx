/** Consume the local callback in the authenticated DSH page, independently of popup openers. */

import { useLayoutEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { isPluginRequestError, jsonRequest } from "./api.ts";
import { LOGIN_CODE_PATH, STATUS_PATH } from "./constants.ts";
import type { GrokBuildSettingsInjected } from "./GrokBuildSettings.tsx";
import { isMatchingClaudeCallback } from "./parsers.ts";
import { bodyStyle, buttonStyle, panelStyle, titleStyle } from "./styles.ts";
import type { CodingOAuthStatus } from "./types.ts";

const RETURN_KEY = "dsh-claude-callback";
const RETURN_DEADLINE_MS = 60_000;
const RETURN_POLL_ATTEMPTS = 120;

class ClaudeBridgeReturnUnconfirmedError extends Error {}

class ClaudeBridgeReturnTimeoutError extends ClaudeBridgeReturnUnconfirmedError {
	constructor() {
		super("Sign-in confirmation timed out.");
	}
}

/** Erase even malformed return payloads before fetching, rendering, or loading other resources. */
export function takeClaudeBridgeReturn(location: Location, history: History): string | undefined {
	const params = new URLSearchParams(location.hash.slice(1));
	if (!params.has(RETURN_KEY)) return undefined;
	const values = params.getAll(RETURN_KEY);
	history.replaceState(history.state, "", `${location.pathname}${location.search}`);
	return values.length === 1 && values[0]!.length <= 8192 ? values[0]! : "";
}

interface ReturnDependencies {
	request: typeof jsonRequest;
	wait: (signal: AbortSignal) => Promise<void>;
}

/** Submission queues the native OAuth prompt; only this attempt's persisted receipt confirms completion. */
export async function finishClaudeBridgeReturn(
	callback: string,
	signal: AbortSignal,
	dependencies: ReturnDependencies = {
		request: jsonRequest,
		wait: (signal) =>
			new Promise<void>((resolve, reject) => {
				const aborted = () => {
					clearTimeout(timer);
					signal.removeEventListener("abort", aborted);
					reject(new Error("Sign-in stopped."));
				};
				const timer = setTimeout(() => {
					signal.removeEventListener("abort", aborted);
					resolve();
				}, 500);
				signal.addEventListener("abort", aborted, { once: true });
				if (signal.aborted) aborted();
			}),
	},
): Promise<void> {
	if (!callback || callback.length > 8192 || signal.aborted) throw new Error("Invalid callback.");
	let reads = 0;
	const readStatus = async () => {
		if (reads >= RETURN_POLL_ATTEMPTS) throw new ClaudeBridgeReturnTimeoutError();
		reads += 1;
		return (await dependencies.request<CodingOAuthStatus>(STATUS_PATH, "GET", undefined, signal)).providers.claude;
	};
	const retryStatusError = (error: unknown) => {
		if (
			signal.aborted ||
			error instanceof ClaudeBridgeReturnTimeoutError ||
			(isPluginRequestError(error) && error.status < 500)
		)
			throw error;
		return dependencies.wait(signal);
	};
	let pending: CodingOAuthStatus["providers"]["claude"];
	for (;;) {
		if (signal.aborted) throw new Error("Sign-in stopped.");
		try {
			pending = await readStatus();
			break;
		} catch (error) {
			await retryStatusError(error);
		}
	}
	if (pending.status === "signed-in" && !pending.operationError) {
		// Another page may have completed sign-in before this page observed the
		// attempt. A current account alone cannot identify this callback's receipt.
		throw new ClaudeBridgeReturnUnconfirmedError("This return cannot be linked to a completed sign-in.");
	}
	const attemptId = pending.loginAttemptId;
	if (
		pending.status !== "signing-in" ||
		pending.method !== "browser" ||
		typeof attemptId !== "string" ||
		attemptId.length === 0 ||
		!isMatchingClaudeCallback(callback, pending.url)
	) {
		throw new Error("This callback does not match a pending Claude sign-in.");
	}
	if (signal.aborted) throw new Error("Sign-in stopped.");
	try {
		await dependencies.request(
			LOGIN_CODE_PATH,
			"POST",
			{ provider: "claude", code: callback, loginAttemptId: attemptId },
			signal,
		);
	} catch (error) {
		if (signal.aborted || (isPluginRequestError(error) && error.status !== 409 && error.status < 500)) throw error;
		// Transport/server failures may follow acceptance, and another page may
		// have delivered this attempt first. Observe only its receipt; never repost.
	}
	for (;;) {
		if (signal.aborted) throw new Error("Sign-in stopped.");
		let status: CodingOAuthStatus["providers"]["claude"];
		try {
			status = await readStatus();
		} catch (error) {
			await retryStatusError(error);
			continue;
		}
		// Native status preserves an existing account after a failed new login.
		// That stored account must not turn this callback's failure into success.
		if (status.operationError) throw new Error("Sign-in did not complete.");
		if (status.status === "signed-in" && status.completedLoginAttemptId === attemptId) return;
		if (
			status.status !== "signing-in" ||
			status.method !== "browser" ||
			status.loginAttemptId !== attemptId ||
			!isMatchingClaudeCallback(callback, status.url)
		) {
			throw new Error("Sign-in did not complete.");
		}
		await dependencies.wait(signal);
	}
}

type ReturnState = "pending" | "success" | "failure" | "unconfirmed";

function ClaudeBridgeReturnDialog({
	state,
	t,
	dismiss,
}: {
	state: ReturnState;
	t: GrokBuildSettingsInjected["t"];
	dismiss: () => void;
}) {
	const dialog = useRef<HTMLDivElement>(null);
	const close = useRef<HTMLButtonElement>(null);
	useLayoutEffect(() => {
		const host = dialog.current?.parentElement;
		if (!host) return;
		const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const background = new Map<Element, string | null>();
		const makeBackgroundInert = () => {
			for (const element of document.body.children) {
				if (element === host) continue;
				if (!background.has(element)) background.set(element, element.getAttribute("inert"));
				element.setAttribute("inert", "");
			}
		};
		makeBackgroundInert();
		const observer = new MutationObserver(makeBackgroundInert);
		observer.observe(document.body, { childList: true });
		const containTab = (event: KeyboardEvent) => {
			if (event.key !== "Tab") return;
			event.preventDefault();
			event.stopImmediatePropagation();
			(close.current ?? dialog.current)?.focus();
		};
		document.addEventListener("keydown", containTab, true);
		return () => {
			observer.disconnect();
			document.removeEventListener("keydown", containTab, true);
			for (const [element, inert] of background) {
				if (inert === null) element.removeAttribute("inert");
				else element.setAttribute("inert", inert);
			}
			if (previousFocus?.isConnected) previousFocus.focus();
		};
	}, []);
	useLayoutEffect(() => {
		(state === "pending" ? dialog.current : close.current)?.focus();
	}, [state]);
	const copy = {
		pending: ["finishingSignIn", "bridgeReturnPendingHint"],
		success: ["bridgeReturnSuccess", "bridgeReturnSuccessHint"],
		failure: ["bridgeReturnFailure", "bridgeReturnFailureHint"],
		unconfirmed: ["bridgeReturnUnconfirmed", "bridgeReturnUnconfirmedHint"],
	} as const;
	return (
		<div
			ref={dialog}
			role="dialog"
			aria-modal="true"
			aria-labelledby="claude-bridge-return-title"
			tabIndex={-1}
			style={{
				position: "fixed",
				inset: 0,
				zIndex: 50,
				display: "grid",
				placeItems: "center",
				padding: 20,
				background: "var(--dsw-alias-bg-layer-1, #fff)",
			}}
		>
			<section style={{ ...panelStyle, width: "min(480px, 100%)", boxSizing: "border-box" }}>
				<h2 id="claude-bridge-return-title" style={titleStyle}>
					{t(copy[state][0])}
				</h2>
				<p role={state === "failure" ? "alert" : "status"} style={bodyStyle}>
					{t(copy[state][1])}
				</p>
				{state === "pending" ? null : (
					<button ref={close} type="button" style={buttonStyle} onClick={dismiss}>
						{t("bridgeReturnClose")}
					</button>
				)}
			</section>
		</div>
	);
}

export function mountClaudeBridgeReturn(callback: string, t: GrokBuildSettingsInjected["t"]): () => void {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const controller = new AbortController();
	let disposed = false;
	let finished = false;
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		clearTimeout(timeout);
		if (!finished) controller.abort();
		root.unmount();
		host.remove();
	};
	const dismiss = () => {
		dispose();
		window.close();
	};
	const render = (state: ReturnState) =>
		root.render(<ClaudeBridgeReturnDialog state={state} t={t} dismiss={dismiss} />);
	render("pending");
	const timeout = setTimeout(() => {
		controller.abort(new ClaudeBridgeReturnTimeoutError());
	}, RETURN_DEADLINE_MS);
	void finishClaudeBridgeReturn(callback, controller.signal)
		.then(
			() => {
				if (!disposed) render("success");
			},
			(error: unknown) => {
				if (!disposed)
					render(
						error instanceof ClaudeBridgeReturnUnconfirmedError ||
							controller.signal.reason instanceof ClaudeBridgeReturnUnconfirmedError
							? "unconfirmed"
							: "failure",
					);
			},
		)
		.finally(() => {
			finished = true;
			clearTimeout(timeout);
		});
	return dispose;
}
