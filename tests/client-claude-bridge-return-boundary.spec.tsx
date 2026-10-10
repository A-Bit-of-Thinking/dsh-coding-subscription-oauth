/** @vitest-environment jsdom */
import { createServer } from "node:http";
import { act } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SubscriptionWebAuth } from "../src/auth-routes.ts";
import { en } from "../src/client/locales.ts";
import { CLAUDE_CODE_OAUTH_PROVIDER } from "../src/oauth-providers.ts";

const challenge =
	"https://claude.ai/oauth/authorize?state=fixture-state&redirect_uri=http%3A%2F%2Flocalhost%3A53692%2Fcallback";
const callback = "http://localhost:53692/callback?code=fixture-code&state=fixture-state";

it("actual fetch rejects an in-flight status body at abort even after the native receipt is persisted", async () => {
	const { jsonRequest } = await import("../src/client/api.ts");
	const { finishClaudeBridgeReturn } = await import("../src/client/claude-bridge-return.tsx");
	let authenticated = false;
	const auth = new SubscriptionWebAuth({
		definition: CLAUDE_CODE_OAUTH_PROVIDER,
		availableModels: () => [],
		visibleModels: () => [],
		selectedModelIds: () => undefined,
		status: async () => ({ authenticated }),
		store: {
			listAccounts: async () => [{ id: "fixture-account", expires: 9999999999999 }],
			getActiveAccountId: async () => "fixture-account",
		},
		login: async (interaction: import("@earendil-works/pi-ai").AuthInteraction) => {
			interaction.notify({ type: "auth_url", url: challenge });
			await interaction.prompt({ type: "manual_code", message: "fixture" });
			authenticated = true;
		},
	} as never);
	let reads = 0;
	let posts = 0;
	let streamedStatus: string | undefined;
	let bodyStarted: () => void;
	const bodyPending = new Promise<void>((resolve) => {
		bodyStarted = resolve;
	});
	const server = createServer(async (req, res) => {
		res.setHeader("Content-Type", "application/json");
		if (req.method === "POST") {
			posts += 1;
			let text = "";
			for await (const chunk of req) text += chunk;
			const body = JSON.parse(text);
			await auth.submitCode(body.code, body.loginAttemptId);
			res.end('{"ok":true}');
			return;
		}
		reads += 1;
		const snapshot = await auth.status();
		if (reads === 1) {
			res.end(JSON.stringify({ providers: { claude: snapshot } }));
			return;
		}
		streamedStatus = snapshot.status;
		res.write('{"providers":');
		bodyStarted!();
		// Deliberately leave a real response body open until the client aborts it.
	});
	const fetch = globalThis.fetch;
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as { port: number };
	const fetchOverride = vi
		.spyOn(globalThis, "fetch")
		.mockImplementation((path, init) =>
			fetch(typeof path === "string" && path.startsWith("/") ? `http://127.0.0.1:${address.port}${path}` : path, init),
		);
	const controller = new AbortController();
	const deadline = setTimeout(() => controller.abort(), 2000);
	try {
		await auth.signIn("browser");
		const attemptId = (await auth.status()).loginAttemptId;
		const outcome = finishClaudeBridgeReturn(callback, controller.signal, {
			request: jsonRequest,
			wait: async () => {},
		}).then(
			() => ({ completed: true }),
			() => ({ completed: false }),
		);
		await Promise.race([
			bodyPending,
			outcome.then(() => {
				throw new Error("Observation ended before the partial response body.");
			}),
		]);
		expect(streamedStatus).toBe("signed-in");
		expect(await auth.status()).toMatchObject({ status: "signed-in", completedLoginAttemptId: attemptId });
		controller.abort();
		expect(await outcome).toEqual({ completed: false });
		expect(posts).toBe(1);
		expect(reads).toBe(2);
	} finally {
		clearTimeout(deadline);
		controller.abort();
		fetchOverride.mockRestore();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await auth.dispose();
		expect(globalThis.fetch).toBe(fetch);
	}
});

it("dismissal restores dynamically added background inert attributes and removes keyboard/watchdog handlers", async () => {
	const api = await import("../src/client/api.ts");
	let reject: (error: Error) => void;
	const request = vi.spyOn(api, "jsonRequest").mockImplementation(
		() =>
			new Promise((_resolve, rejectRequest) => {
				reject = rejectRequest;
			}),
	);
	const { mountClaudeBridgeReturn } = await import("../src/client/claude-bridge-return.tsx");
	const close = vi.spyOn(window, "close").mockImplementation(() => {});
	vi.useFakeTimers();
	const trigger = document.createElement("button");
	const late = document.createElement("section");
	late.setAttribute("inert", "fixture-existing");
	document.body.append(trigger);
	trigger.focus();
	let dispose: (() => void) | undefined;
	try {
		await act(async () => {
			dispose = mountClaudeBridgeReturn(callback, (key) => en[key]);
		});
		await act(async () => {
			document.body.append(late);
		});
		expect(late.getAttribute("inert")).toBe("");
		await act(async () => {
			reject!(Object.assign(new Error("fixture rejection"), { name: "PluginRequestError", status: 403 }));
		});
		const button = document.querySelector<HTMLButtonElement>('[role="dialog"] button')!;
		expect(document.activeElement).toBe(button);
		await act(async () => button.click());
		expect(close).toHaveBeenCalledOnce();
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(late.getAttribute("inert")).toBe("fixture-existing");
		expect(trigger.hasAttribute("inert")).toBe(false);
		expect(document.activeElement).toBe(trigger);
		const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
		trigger.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);
		await vi.advanceTimersByTimeAsync(0);
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		await act(async () => dispose?.());
		trigger.remove();
		late.remove();
		vi.useRealTimers();
		request.mockRestore();
		close.mockRestore();
	}
});
