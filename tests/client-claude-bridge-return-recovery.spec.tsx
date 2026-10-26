/** @vitest-environment jsdom */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { act, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { GrokBuildWebAuth, registerCodingOAuthRoutes } from "../src/auth-routes.ts";
import { LOGIN_CANCEL_PATH, LOGIN_CODE_PATH, LOGIN_PATH, STATUS_PATH } from "../src/client/constants.ts";
import { en } from "../src/client/locales.ts";
import type { CodingOAuthStatus } from "../src/client/types.ts";
import { OAUTH_PROVIDER_DEFINITIONS } from "../src/oauth-providers.ts";
import type { OAuthProviderSession } from "../src/oauth-session.ts";
import type { GrokBuildSession } from "../src/session.ts";

const challenge =
	"https://claude.ai/oauth/authorize?state=fixture-state&redirect_uri=http%3A%2F%2Flocalhost%3A53692%2Fcallback";
const callback = "http://localhost:53692/callback?code=fixture-code&state=fixture-state";

async function fixture(
	options: {
		initialFailure?: "transport" | number;
		statusFailureAlways?: number;
		pauseFirstCode?: boolean;
		acceptedCodeResponse?: number;
		codeRejection?: number;
	} = {},
) {
	const api = await import("../src/client/api.ts");
	const consumer = await import("../src/client/claude-bridge-return.tsx");
	const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>();
	const cleanups: Array<() => void | Promise<void>> = [];
	const context = {
		webServer: {
			register: (route: {
				path: string;
				handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
			}) => {
				routes.set(route.path, route.handler);
				return () => routes.delete(route.path);
			},
		},
		llm: { listProviders: () => [] },
		effect: (setup: () => void | (() => void | Promise<void>)) => {
			const cleanup = setup();
			if (typeof cleanup === "function") cleanups.push(cleanup);
		},
	} as unknown as Context;
	let authenticated = false;
	let finish = () => {};
	let fail = () => {};
	let generation = 0;
	let codeAccepted = false;
	const sessions = OAUTH_PROVIDER_DEFINITIONS.map((definition) => ({
		definition,
		availableModels: () => [],
		visibleModels: () => [],
		selectedModelIds: () => undefined,
		status: async () => ({ authenticated: definition.slug === "claude" && authenticated }),
		store: { listAccounts: async () => [{ id: "fixture-account" }], getActiveAccountId: async () => "fixture-account" },
		login: async (interaction: AuthInteraction) => {
			generation += 1;
			codeAccepted = false;
			interaction.notify({
				type: "auth_url",
				url: generation === 1 ? challenge : challenge.replace("fixture-state", `fixture-state-${generation}`),
			});
			await interaction.prompt({ type: "manual_code", message: "fixture" });
			await new Promise<void>((resolve, reject) => {
				const abort = () => reject(interaction.signal?.reason);
				finish = () => {
					interaction.signal?.removeEventListener("abort", abort);
					authenticated = true;
					resolve();
				};
				fail = () => {
					interaction.signal?.removeEventListener("abort", abort);
					reject(new Error("fixture exchange failed"));
				};
				interaction.signal?.addEventListener("abort", abort, { once: true });
				if (interaction.signal?.aborted) abort();
				codeAccepted = true;
			});
		},
	})) as unknown as OAuthProviderSession[];
	const grok = vi
		.spyOn(GrokBuildWebAuth.prototype, "status")
		.mockResolvedValue({ status: "signed-out", grokImportAvailable: false });
	registerCodingOAuthRoutes(context, {} as GrokBuildSession, sessions);
	let reads = 0;
	let posts = 0;
	let codeEntered = false;
	let releaseCode: () => void = () => {};
	const codeWait = new Promise<void>((resolve) => {
		releaseCode = resolve;
	});
	const server = createServer(async (req, res) => {
		const deadline = setTimeout(() => res.destroy(), 2000);
		res.once("close", () => clearTimeout(deadline));
		try {
			if (req.url === STATUS_PATH) {
				reads += 1;
				const statusFailure = options.statusFailureAlways ?? (reads === 1 ? options.initialFailure : undefined);
				if (statusFailure !== undefined) {
					if (statusFailure === "transport") {
						res.destroy();
						return;
					}
					res.writeHead(statusFailure, { "content-type": "application/json" });
					res.end('{"error":"fixture temporarily unavailable"}');
					return;
				}
			}
			if (req.url === LOGIN_CODE_PATH) {
				posts += 1;
				if (posts === 1 && options.pauseFirstCode) {
					codeEntered = true;
					await codeWait;
				}
				if (options.codeRejection !== undefined) {
					res.writeHead(options.codeRejection, { "content-type": "application/json" });
					res.end('{"error":"fixture callback denied"}');
					return;
				}
				if (options.acceptedCodeResponse !== undefined) {
					const writeHead = res.writeHead.bind(res);
					res.writeHead = ((status: number, ...args: unknown[]) =>
						writeHead(
							status === 200 ? options.acceptedCodeResponse! : status,
							...(args as []),
						)) as typeof res.writeHead;
				}
			}
			const route = routes.get(req.url!);
			if (route) await route(req, res);
			else {
				res.writeHead(404);
				res.end();
			}
		} catch {
			res.writeHead(500);
			res.end();
		}
	});
	let restoreFetch = () => {};
	const close = async () => {
		releaseCode();
		restoreFetch();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		try {
			for (const cleanup of cleanups.reverse()) await cleanup();
		} finally {
			grok.mockRestore();
		}
	};
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.off("error", reject);
				resolve();
			});
		});
		const address = server.address() as { port: number };
		const fetch = globalThis.fetch;
		const fetchOverride = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation((path, init) =>
				fetch(
					typeof path === "string" && path.startsWith("/") ? `http://127.0.0.1:${address.port}${path}` : path,
					init,
				),
			);
		restoreFetch = () => fetchOverride.mockRestore();
		await api.jsonRequest(LOGIN_PATH, "POST", { provider: "claude", method: "browser" });
	} catch (error) {
		await close();
		throw error;
	}
	return {
		api,
		consumer,
		codeEntered: () => codeEntered,
		releaseCode,
		accepted: () => codeAccepted,
		finish: () => finish(),
		fail: () => fail(),
		reads: () => reads,
		posts: () => posts,
		close,
	};
}

it.each([false, true])(
	"leaves an account completed before the first return observation unconfirmed (stale callback=%s)",
	async (stale) => {
		const f = await fixture();
		let dispose: (() => void) | undefined;
		try {
			const pending = (await f.api.jsonRequest<CodingOAuthStatus>(STATUS_PATH)).providers.claude;
			await f.api.jsonRequest(LOGIN_CODE_PATH, "POST", {
				provider: "claude",
				code: callback,
				loginAttemptId: pending.loginAttemptId,
			});
			await waitFor(() => expect(f.accepted()).toBe(true));
			f.finish();
			await waitFor(async () =>
				expect((await f.api.jsonRequest<CodingOAuthStatus>(STATUS_PATH)).providers.claude).toMatchObject({
					status: "signed-in",
					completedLoginAttemptId: pending.loginAttemptId,
				}),
			);
			await act(async () => {
				dispose = f.consumer.mountClaudeBridgeReturn(
					stale ? callback.replace("fixture-state", "unrelated-state") : callback,
					(key) => en[key],
				);
			});
			await waitFor(() => expect(document.body.textContent).toContain(en.bridgeReturnUnconfirmed));
			expect((await f.api.jsonRequest<CodingOAuthStatus>(STATUS_PATH)).providers.claude).toMatchObject({
				status: "signed-in",
				completedLoginAttemptId: pending.loginAttemptId,
			});
			expect(document.body.textContent).not.toContain(en.bridgeReturnFailure);
			expect(document.body.textContent).not.toContain(en.bridgeReturnSuccess);
			expect(f.posts()).toBe(1);
		} finally {
			await act(async () => dispose?.());
			await f.close();
		}
	},
);

it("leaves manual completion during initial readiness recovery unconfirmed without another callback POST", async () => {
	const options: Parameters<typeof fixture>[0] = {};
	const f = await fixture(options);
	let dispose: (() => void) | undefined;
	try {
		const pending = (await f.api.jsonRequest<CodingOAuthStatus>(STATUS_PATH)).providers.claude;
		options.statusFailureAlways = 503;
		await act(async () => {
			dispose = f.consumer.mountClaudeBridgeReturn(callback, (key) => en[key]);
		});
		await waitFor(() => expect(f.reads()).toBe(2));
		await f.api.jsonRequest(LOGIN_CODE_PATH, "POST", {
			provider: "claude",
			code: callback,
			loginAttemptId: pending.loginAttemptId,
		});
		await waitFor(() => expect(f.accepted()).toBe(true));
		f.finish();
		delete options.statusFailureAlways;
		await waitFor(() => expect(document.body.textContent).toContain(en.bridgeReturnUnconfirmed));
		expect((await f.api.jsonRequest<CodingOAuthStatus>(STATUS_PATH)).providers.claude).toMatchObject({
			status: "signed-in",
			completedLoginAttemptId: pending.loginAttemptId,
		});
		expect(document.body.textContent).not.toContain(en.bridgeReturnFailure);
		expect(document.body.textContent).not.toContain(en.bridgeReturnSuccess);
		expect(f.posts()).toBe(1);
	} finally {
		await act(async () => dispose?.());
		await f.close();
	}
});

it.each([false, true])(
	"does not infer completion from an older account after a later attempt ends (operationError=%s)",
	async (operationError) => {
		const f = await fixture();
		let dispose: (() => void) | undefined;
		try {
			const first = (await f.api.jsonRequest<CodingOAuthStatus>(STATUS_PATH)).providers.claude;
			await f.api.jsonRequest(LOGIN_CODE_PATH, "POST", {
				provider: "claude",
				code: callback,
				loginAttemptId: first.loginAttemptId,
			});
			await waitFor(() => expect(f.accepted()).toBe(true));
			f.finish();
			await waitFor(async () =>
				expect((await f.api.jsonRequest<CodingOAuthStatus>(STATUS_PATH)).providers.claude.status).toBe("signed-in"),
			);
			await f.api.jsonRequest(LOGIN_PATH, "POST", { provider: "claude", method: "browser" });
			const second = (await f.api.jsonRequest<CodingOAuthStatus>(STATUS_PATH)).providers.claude;
			const returned = callback.replace("fixture-state", "fixture-state-2");
			if (operationError) {
				await f.api.jsonRequest(LOGIN_CODE_PATH, "POST", {
					provider: "claude",
					code: returned,
					loginAttemptId: second.loginAttemptId,
				});
				await waitFor(() => expect(f.accepted()).toBe(true));
				f.fail();
				await waitFor(async () =>
					expect((await f.api.jsonRequest<CodingOAuthStatus>(STATUS_PATH)).providers.claude.operationError).toBe(
						"fixture exchange failed",
					),
				);
			} else await f.api.jsonRequest(LOGIN_CANCEL_PATH, "POST", { provider: "claude" });
			const stored = (await f.api.jsonRequest<CodingOAuthStatus>(STATUS_PATH)).providers.claude;
			expect(stored.status).toBe("signed-in");
			expect(stored.completedLoginAttemptId).toBeUndefined();
			const posts = f.posts();
			await act(async () => {
				dispose = f.consumer.mountClaudeBridgeReturn(returned, (key) => en[key]);
			});
			await waitFor(() =>
				expect(document.body.textContent).toContain(
					operationError ? en.bridgeReturnFailure : en.bridgeReturnUnconfirmed,
				),
			);
			expect(document.body.textContent).not.toContain(en.bridgeReturnSuccess);
			expect(f.posts()).toBe(posts);
		} finally {
			await act(async () => dispose?.());
			await f.close();
		}
	},
);

it.each(["transport", 503] as const)(
	"recovers one transient initial %s status failure before the sole callback POST",
	async (initialFailure) => {
		const f = await fixture({ initialFailure });
		let dispose: (() => void) | undefined;
		try {
			await act(async () => {
				dispose = f.consumer.mountClaudeBridgeReturn(callback, (key) => en[key]);
			});
			await waitFor(() => expect(f.accepted()).toBe(true));
			const pending = (await f.api.jsonRequest<CodingOAuthStatus>(STATUS_PATH)).providers.claude;
			expect(pending).toMatchObject({ status: "signing-in", url: challenge, loginAttemptId: expect.any(String) });
			f.finish();
			await waitFor(() => expect(document.body.textContent).toContain(en.bridgeReturnSuccess));
			expect((await f.api.jsonRequest<CodingOAuthStatus>(STATUS_PATH)).providers.claude).toMatchObject({
				status: "signed-in",
				completedLoginAttemptId: pending.loginAttemptId,
			});
			expect(document.body.textContent).not.toContain(en.bridgeReturnFailure);
			expect(f.posts()).toBe(1);
		} finally {
			await act(async () => dispose?.());
			await f.close();
		}
	},
);

it("observes the same persisted receipt when manual delivery wins an in-flight automatic POST", async () => {
	const f = await fixture({ pauseFirstCode: true });
	let dispose: (() => void) | undefined;
	try {
		await act(async () => {
			dispose = f.consumer.mountClaudeBridgeReturn(callback, (key) => en[key]);
		});
		await waitFor(() => expect(f.codeEntered()).toBe(true));
		const pending = (await f.api.jsonRequest<CodingOAuthStatus>(STATUS_PATH)).providers.claude;
		await f.api.jsonRequest(LOGIN_CODE_PATH, "POST", {
			provider: "claude",
			code: callback,
			loginAttemptId: pending.loginAttemptId,
		});
		f.releaseCode();
		await waitFor(() => expect(f.accepted()).toBe(true));
		f.finish();
		await waitFor(() => expect(document.body.textContent).toContain(en.bridgeReturnSuccess));
		expect((await f.api.jsonRequest<CodingOAuthStatus>(STATUS_PATH)).providers.claude).toMatchObject({
			status: "signed-in",
			completedLoginAttemptId: pending.loginAttemptId,
		});
		expect(document.body.textContent).not.toContain(en.bridgeReturnFailure);
		expect(f.posts()).toBe(2);
	} finally {
		await act(async () => dispose?.());
		await f.close();
	}
});

it.each([502, 503])(
	"confirms the same receipt after a %s acknowledgement for an accepted native callback",
	async (acceptedCodeResponse) => {
		const f = await fixture({ acceptedCodeResponse });
		let dispose: (() => void) | undefined;
		try {
			const pending = (await f.api.jsonRequest<CodingOAuthStatus>(STATUS_PATH)).providers.claude;
			await act(async () => {
				dispose = f.consumer.mountClaudeBridgeReturn(callback, (key) => en[key]);
			});
			await waitFor(() => expect(f.accepted()).toBe(true));
			f.finish();
			await waitFor(() => expect(document.body.textContent).toContain(en.bridgeReturnSuccess));
			expect((await f.api.jsonRequest<CodingOAuthStatus>(STATUS_PATH)).providers.claude).toMatchObject({
				status: "signed-in",
				completedLoginAttemptId: pending.loginAttemptId,
			});
			expect(document.body.textContent).not.toContain(en.bridgeReturnFailure);
			expect(f.posts()).toBe(1);
		} finally {
			await act(async () => dispose?.());
			await f.close();
		}
	},
);

it.each([401, 403])(
	"fails fast on initial HTTP%s permission rejection without posting a callback",
	async (initialFailure) => {
		const f = await fixture({ initialFailure });
		let dispose: (() => void) | undefined;
		try {
			await act(async () => {
				dispose = f.consumer.mountClaudeBridgeReturn(callback, (key) => en[key]);
			});
			await waitFor(() => expect(document.body.textContent).toContain(en.bridgeReturnFailure));
			expect(f.reads()).toBe(1);
			expect(f.posts()).toBe(0);
			expect(document.body.textContent).not.toContain(en.bridgeReturnUnconfirmed);
		} finally {
			await act(async () => dispose?.());
			await f.close();
		}
	},
);

it.each([401, 403])("does not observe or replay a callback rejected with HTTP%s", async (codeRejection) => {
	const f = await fixture({ codeRejection });
	let dispose: (() => void) | undefined;
	try {
		await act(async () => {
			dispose = f.consumer.mountClaudeBridgeReturn(callback, (key) => en[key]);
		});
		await waitFor(() => expect(document.body.textContent).toContain(en.bridgeReturnFailure));
		expect(f.reads()).toBe(1);
		expect(f.posts()).toBe(1);
		expect(f.accepted()).toBe(false);
	} finally {
		await act(async () => dispose?.());
		await f.close();
	}
});

it.each([false, true])("rejects an in-flight callback if its attempt is canceled (restart=%s)", async (restart) => {
	const f = await fixture({ pauseFirstCode: true });
	let dispose: (() => void) | undefined;
	try {
		await act(async () => {
			dispose = f.consumer.mountClaudeBridgeReturn(callback, (key) => en[key]);
		});
		await waitFor(() => expect(f.codeEntered()).toBe(true));
		const first = (await f.api.jsonRequest<CodingOAuthStatus>(STATUS_PATH)).providers.claude.loginAttemptId;
		await f.api.jsonRequest(LOGIN_CANCEL_PATH, "POST", { provider: "claude" });
		if (restart) await f.api.jsonRequest(LOGIN_PATH, "POST", { provider: "claude", method: "browser" });
		f.releaseCode();
		await waitFor(() => expect(document.body.textContent).toContain(en.bridgeReturnFailure));
		const current = (await f.api.jsonRequest<CodingOAuthStatus>(STATUS_PATH)).providers.claude;
		if (restart) {
			expect(current).toMatchObject({ status: "signing-in", loginAttemptId: expect.any(String) });
			expect(current.loginAttemptId).not.toBe(first);
			await f.api.jsonRequest(LOGIN_CODE_PATH, "POST", {
				provider: "claude",
				code: callback.replace("fixture-state", "fixture-state-2"),
				loginAttemptId: current.loginAttemptId,
			});
			await waitFor(() => expect(f.accepted()).toBe(true));
			f.finish();
			await waitFor(async () =>
				expect((await f.api.jsonRequest<CodingOAuthStatus>(STATUS_PATH)).providers.claude).toMatchObject({
					status: "signed-in",
					completedLoginAttemptId: current.loginAttemptId,
				}),
			);
			expect(document.body.textContent).toContain(en.bridgeReturnFailure);
		} else expect(current.status).toBe("signed-out");
	} finally {
		await act(async () => dispose?.());
		await f.close();
	}
});

it("revalidates the live challenge after initial recovery before posting any callback", async () => {
	const f = await fixture({ initialFailure: 503 });
	let dispose: (() => void) | undefined;
	try {
		await act(async () => {
			dispose = f.consumer.mountClaudeBridgeReturn(callback, (key) => en[key]);
		});
		await waitFor(() => expect(f.reads()).toBe(1));
		await f.api.jsonRequest(LOGIN_CANCEL_PATH, "POST", { provider: "claude" });
		await f.api.jsonRequest(LOGIN_PATH, "POST", { provider: "claude", method: "browser" });
		await waitFor(() => expect(document.body.textContent).toContain(en.bridgeReturnFailure));
		expect(f.posts()).toBe(0);
		expect((await f.api.jsonRequest<CodingOAuthStatus>(STATUS_PATH)).providers.claude).toMatchObject({
			status: "signing-in",
			url: challenge.replace("fixture-state", "fixture-state-2"),
		});
	} finally {
		await act(async () => dispose?.());
		await f.close();
	}
});

it("bounds persistent transient initial failure with zero POSTs and an unconfirmed result", async () => {
	const f = await fixture({ statusFailureAlways: 503 });
	const setTimeout = globalThis.setTimeout;
	const timers = vi
		.spyOn(globalThis, "setTimeout")
		.mockImplementation((handler, delay, ...args) => setTimeout(handler, delay === 500 ? 0 : delay, ...args));
	let dispose: (() => void) | undefined;
	try {
		await act(async () => {
			dispose = f.consumer.mountClaudeBridgeReturn(callback, (key) => en[key]);
		});
		await waitFor(() => expect(document.body.textContent).toContain(en.bridgeReturnUnconfirmed), { timeout: 2000 });
		expect(document.body.textContent).not.toContain(en.bridgeReturnFailure);
		expect(f.reads()).toBe(120);
		expect(f.posts()).toBe(0);
	} finally {
		await act(async () => dispose?.());
		timers.mockRestore();
		await f.close();
	}
});

it("keeps an accepted but persistently ambiguous acknowledgement unconfirmed without replay", async () => {
	const f = await fixture({ acceptedCodeResponse: 503 });
	const setTimeout = globalThis.setTimeout;
	const timers = vi
		.spyOn(globalThis, "setTimeout")
		.mockImplementation((handler, delay, ...args) => setTimeout(handler, delay === 500 ? 0 : delay, ...args));
	let dispose: (() => void) | undefined;
	try {
		await act(async () => {
			dispose = f.consumer.mountClaudeBridgeReturn(callback, (key) => en[key]);
		});
		await waitFor(() => expect(document.body.textContent).toContain(en.bridgeReturnUnconfirmed), { timeout: 2000 });
		expect(f.reads()).toBe(120);
		expect(f.posts()).toBe(1);
		expect(f.accepted()).toBe(true);
		const pending = (await f.api.jsonRequest<CodingOAuthStatus>(STATUS_PATH)).providers.claude;
		f.finish();
		await waitFor(async () =>
			expect((await f.api.jsonRequest<CodingOAuthStatus>(STATUS_PATH)).providers.claude).toMatchObject({
				status: "signed-in",
				completedLoginAttemptId: pending.loginAttemptId,
			}),
		);
		expect(document.body.textContent).toContain(en.bridgeReturnUnconfirmed);
		expect(document.body.textContent).not.toContain(en.bridgeReturnSuccess);
	} finally {
		await act(async () => dispose?.());
		timers.mockRestore();
		await f.close();
	}
});
