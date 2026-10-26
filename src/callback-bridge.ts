import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, request, type Server, type ServerResponse } from "node:http";
import { createServer as createTcpServer } from "node:net";

export type BridgeTarget =
	| { kind: "browser" }
	| { kind: "ssh"; host: string }
	| { kind: "gcp"; instance: string; project: string; zone: string };

type TunnelProcess = Pick<ChildProcess, "once" | "removeListener" | "kill" | "pid">;

export interface CallbackBridgeOptions {
	target: BridgeTarget;
	remoteOrigin: string;
	/** Non-secret configuration fingerprint supplied by the CLI before optional target discovery. */
	configurationId?: string;
	/** Dependency injection for isolated tests. The installed CLI never accepts these options. */
	_test?: {
		controlPort?: number;
		callbackPort?: number;
		forwardPort?: number;
		allowHttpOrigin?: boolean;
		spawnTunnel?: (command: string, args: string[]) => TunnelProcess;
		spawnOwnsProcessGroup?: boolean;
		beforeBrowserReady?: () => Promise<void>;
		readyTimeoutMs?: number;
		sessionTimeoutMs?: number;
		pollIntervalMs?: number;
		killTimeoutMs?: number;
	};
}

interface ActiveSession {
	state: string;
	tunnel?: TunnelProcess;
	callback?: Server;
	callbackV6?: Server;
	timer?: ReturnType<typeof setTimeout>;
	healthTimer?: ReturnType<typeof setTimeout>;
	stopped: boolean;
	ready: boolean;
	used: boolean;
	stop: () => Promise<void>;
}

const CALLBACK_PORT = 53692;
const CONTROL_PORT = 53700;
const FORWARD_PORT = 53694;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;
const PAGE_TOKEN_TTL = 60_000;
const MAX_BODY_BYTES = 8192;

function configuredOrigin(value: string, allowHttp = false): string {
	const url = new URL(value);
	if (
		url.origin !== value ||
		url.username ||
		url.password ||
		(url.protocol !== "https:" && !(allowHttp && url.protocol === "http:"))
	)
		throw new Error("Configure the exact HTTPS origin of your remote DSH instance.");
	return url.origin;
}

function unique(params: URLSearchParams, name: string): string {
	const values = params.getAll(name);
	if (values.length !== 1 || !values[0]) throw new Error("Invalid Claude authorization request.");
	return values[0];
}

function authorization(input: unknown): { url: string; state: string } {
	if (typeof input !== "string" || Buffer.byteLength(input) > 4096) {
		throw new Error("Invalid Claude authorization request.");
	}
	const url = new URL(input);
	if (
		url.origin !== "https://claude.ai" ||
		url.pathname !== "/oauth/authorize" ||
		url.username ||
		url.password ||
		url.hash ||
		unique(url.searchParams, "response_type") !== "code" ||
		unique(url.searchParams, "redirect_uri") !== REDIRECT_URI ||
		unique(url.searchParams, "code_challenge_method") !== "S256"
	)
		throw new Error("Invalid Claude authorization request.");
	unique(url.searchParams, "code_challenge");
	const state = unique(url.searchParams, "state");
	return { url: url.href, state };
}

function tunnelCommand(
	target: Exclude<BridgeTarget, { kind: "browser" }>,
	forwardPort: number,
): { command: string; args: string[] } {
	const flags = [
		"-N",
		"-T",
		"-o",
		"BatchMode=yes",
		"-o",
		"StrictHostKeyChecking=yes",
		"-o",
		"ExitOnForwardFailure=yes",
		"-o",
		"ControlMaster=no",
		"-o",
		"ControlPath=none",
		"-o",
		"ServerAliveInterval=15",
		"-o",
		"ServerAliveCountMax=2",
		"-L",
		`127.0.0.1:${forwardPort}:127.0.0.1:${CALLBACK_PORT}`,
	];
	if (target.kind === "ssh") {
		if (!/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(target.host)) {
			throw new Error("Invalid configured SSH host.");
		}
		return { command: "ssh", args: [...flags, target.host] };
	}
	if (![target.instance, target.project, target.zone].every((value) => /^[a-z][a-z0-9-]{0,62}$/.test(value))) {
		throw new Error("Invalid configured GCP target.");
	}
	// gcloud accepts each SSH option separately; no shell or remote command is involved.
	const sshFlags = [
		"-N",
		"-T",
		"-o BatchMode=yes",
		"-o StrictHostKeyChecking=yes",
		"-o ExitOnForwardFailure=yes",
		"-o ControlMaster=no",
		"-o ControlPath=none",
		"-o ServerAliveInterval=15",
		"-o ServerAliveCountMax=2",
		`-L127.0.0.1:${forwardPort}:127.0.0.1:${CALLBACK_PORT}`,
	];
	return {
		command: "gcloud",
		args: [
			"compute",
			"ssh",
			target.instance,
			`--project=${target.project}`,
			`--zone=${target.zone}`,
			"--tunnel-through-iap",
			"--quiet",
			...sshFlags.map((flag) => `--ssh-flag=${flag}`),
		],
	};
}

function localPeer(req: IncomingMessage, port: number): boolean {
	const peer = req.socket.remoteAddress;
	return (
		(peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1") &&
		(req.headers.host === `127.0.0.1:${port}` || req.headers.host === `localhost:${port}`)
	);
}

function headers(res: ServerResponse, type = "application/json"): void {
	res.setHeader("Content-Type", `${type}; charset=utf-8`);
	res.setHeader("Cache-Control", "no-store");
	res.setHeader("Referrer-Policy", "no-referrer");
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

function json(res: ServerResponse, status: number, value: unknown): void {
	headers(res);
	res.writeHead(status);
	res.end(JSON.stringify(value));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let bytes = 0;
		let failed = false;
		req.on("data", (chunk) => {
			if (failed) return;
			bytes += Buffer.byteLength(chunk);
			if (bytes > MAX_BODY_BYTES) {
				failed = true;
				reject(new Error("Request body is too large."));
				return;
			}
			chunks.push(Buffer.from(chunk));
		});
		req.on("error", reject);
		req.on("end", () => {
			if (failed) return;
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch (error) {
				reject(error);
			}
		});
	});
}

async function listen(server: Server, port: number, host = "127.0.0.1"): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.removeListener("error", reject);
			const address = server.address();
			if (!address || typeof address === "string") reject(new Error("Local bridge listener did not start."));
			else resolve(address.port);
		});
	});
}

async function closeServer(server?: Server): Promise<void> {
	if (!server?.listening) return;
	await new Promise<void>((resolve) => {
		server.close(() => resolve());
		server.closeAllConnections();
	});
}

async function checkForwardPort(port: number): Promise<void> {
	const probe = createTcpServer();
	await new Promise<void>((resolve, reject) => {
		probe.once("error", reject);
		probe.listen(port, "127.0.0.1", () => probe.close((error) => (error ? reject(error) : resolve())));
	});
}

async function terminate(child: TunnelProcess, timeout: number, ownedGroup: boolean): Promise<void> {
	await new Promise<void>((resolve) => {
		let settled = false;
		let groupPoll: ReturnType<typeof setTimeout> | undefined;
		const signal = (value: NodeJS.Signals | 0): boolean => {
			if (!ownedGroup || !child.pid) return value === 0 ? true : child.kill(value);
			try {
				process.kill(-child.pid, value);
				return true;
			} catch {
				return false;
			}
		};
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(groupPoll);
			child.removeListener("exit", onExit);
			resolve();
		};
		const onExit = () => {
			if (!ownedGroup || !signal(0)) finish();
		};
		const pollGroup = () => {
			if (settled) return;
			if (!signal(0)) finish();
			else groupPoll = setTimeout(pollGroup, 20);
		};
		const timer = setTimeout(() => {
			signal("SIGKILL");
			finish();
		}, timeout);
		child.once("exit", onExit);
		if (!signal("SIGTERM")) finish();
		else if (ownedGroup) groupPoll = setTimeout(pollGroup, 20);
	});
}

async function forwardedGet(port: number, path: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout>;
		const req = request({ host: "127.0.0.1", port, path, method: "GET", timeout: 2000 }, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => {
				body += chunk;
				if (body.length > 65_536) req.destroy(new Error("Unexpected callback response."));
			});
			res.on("end", () => {
				clearTimeout(timer);
				resolve({ status: res.statusCode ?? 0, body });
			});
			res.on("error", reject);
		});
		req.on("timeout", () => req.destroy(new Error("Callback connection timed out.")));
		req.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		timer = setTimeout(() => req.destroy(new Error("Callback connection timed out.")), 2000);
		req.end();
	});
}

function page(token: string): string {
	return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Claude to DSH</title><style>body{font:16px system-ui;max-width:560px;margin:12vh auto;padding:24px;color:#202124}h1{font-size:24px}p{line-height:1.6}</style><h1>Preparing your secure connection…</h1><p id="message">Claude will open when the callback connection is ready. Keep DSH Settings open.</p><script>const params=new URLSearchParams(location.hash.slice(1));history.replaceState(null,"",location.pathname);const authUrl=params.get("authUrl"),remoteOrigin=params.get("remoteOrigin");fetch("/start",{method:"POST",headers:{"Content-Type":"application/json","x-dsh-bridge-page-token":${JSON.stringify(token)}},body:JSON.stringify({authUrl,remoteOrigin})}).then(async response=>{const result=await response.json();if(!response.ok)throw new Error(result.error||"Connection failed.");location.replace(result.authUrl);}).catch(error=>{document.querySelector("h1").textContent="Connection could not start";document.querySelector("#message").textContent=error.message+" Return to DSH Settings to retry or use the paste option.";});</script></html>`;
}

/** A local, opt-in daemon. Tokens remain with the remote DSH OAuth implementation. */
export async function startCallbackBridge(
	options: CallbackBridgeOptions,
): Promise<{ url: string; close(): Promise<void> }> {
	const remoteOrigin = configuredOrigin(options.remoteOrigin, options._test?.allowHttpOrigin);
	const targetFields =
		options.target.kind === "browser"
			? []
			: options.target.kind === "ssh"
				? [options.target.host]
				: [options.target.instance, options.target.project, options.target.zone];
	const configurationId =
		options.configurationId ??
		createHash("sha256")
			.update(JSON.stringify([remoteOrigin, options.target.kind, ...targetFields]))
			.digest("hex");
	if (typeof configurationId !== "string" || !/^[a-f0-9]{64}$/u.test(configurationId)) {
		throw new Error("Invalid bridge configuration fingerprint.");
	}
	const callbackPort = options._test?.callbackPort ?? CALLBACK_PORT;
	const forwardPort = options._test?.forwardPort ?? FORWARD_PORT;
	const command = options.target.kind === "browser" ? undefined : tunnelCommand(options.target, forwardPort);
	const readyTimeout = options._test?.readyTimeoutMs ?? 30_000;
	const sessionTimeout = options._test?.sessionTimeoutMs ?? 5 * 60_000;
	const killTimeout = options._test?.killTimeoutMs ?? 1500;
	const ownedGroups = new WeakSet<TunnelProcess>();
	const spawnTunnel =
		options._test?.spawnTunnel ??
		((name, args) => {
			const child = spawn(name, args, { shell: false, stdio: "ignore", detached: process.platform !== "win32" });
			if (process.platform !== "win32") ownedGroups.add(child);
			return child;
		});
	const pageTokens = new Map<string, number>();
	let active: ActiveSession | undefined;
	let closed = false;
	let controlPort = options._test?.controlPort ?? CONTROL_PORT;
	let controlOrigin = `http://127.0.0.1:${controlPort}`;

	async function begin(auth: { url: string; state: string }): Promise<void> {
		if (active || closed) throw new Error("Another login is active. Finish it before trying again.");
		const session: ActiveSession = {
			state: auth.state,
			stopped: false,
			ready: false,
			used: false,
			stop: async () => {},
		};
		active = session;
		let stopping: Promise<void> | undefined;
		let finishInitialization: () => void = () => {};
		const initialized = new Promise<void>((resolve) => {
			finishInitialization = resolve;
		});
		session.stop = () => {
			if (stopping) return stopping;
			if (session.stopped) return Promise.resolve();
			session.stopped = true;
			clearTimeout(session.timer);
			clearTimeout(session.healthTimer);
			stopping = (async () => {
				await initialized;
				await Promise.all([closeServer(session.callback), closeServer(session.callbackV6)]);
				if (session.tunnel) await terminate(session.tunnel, killTimeout, ownedGroups.has(session.tunnel));
				if (active === session) active = undefined;
			})();
			return stopping;
		};
		try {
			try {
				if (command) await checkForwardPort(forwardPort);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EADDRINUSE")
					throw new Error("The local tunnel port is already in use. Close the other connection and retry.");
				throw error;
			}
			if (session.stopped) throw new Error("Login was cancelled.");
			const receiveCallback = (req: IncomingMessage, res: ServerResponse) => {
				void (async () => {
					if (!localPeer(req, callbackPort) || req.method !== "GET") return json(res, 403, { error: "Forbidden." });
					const url = new URL(req.url ?? "/", "http://localhost");
					if (url.pathname !== "/callback" || session.stopped)
						return json(res, 404, { error: "Callback unavailable." });
					if (session.used) return json(res, 409, { error: "Callback already delivered." });
					let state: string;
					let code: string;
					try {
						state = unique(url.searchParams, "state");
					} catch {
						return json(res, 400, { error: "Invalid callback." });
					}
					if (state !== session.state || Buffer.byteLength(req.url ?? "") > 8192) {
						return json(res, 400, { error: "This callback does not match the active login." });
					}
					if (url.searchParams.has("error")) {
						res.once("finish", () => {
							void session.stop();
						});
						return json(res, 400, { error: "Claude authorization did not complete. Return to DSH Settings to retry." });
					}
					try {
						code = unique(url.searchParams, "code");
					} catch {
						return json(res, 400, { error: "Invalid callback." });
					}
					// The pending-login lease ends when its callback arrives. Forwarding has its own bounded request timeout.
					clearTimeout(session.timer);
					session.used = true;
					res.once("close", () => {
						void session.stop();
					});
					if (!command) {
						const callback = new URL(REDIRECT_URI);
						callback.search = new URLSearchParams({ code, state }).toString();
						const destination = new URL("/", remoteOrigin);
						destination.hash = new URLSearchParams({ "dsh-claude-callback": callback.href }).toString();
						headers(res, "text/html");
						res.writeHead(303, { Location: destination.href });
						res.once("finish", () => {
							void session.stop();
						});
						res.end("<!doctype html><title>Returning to DSH</title><p>Returning to DSH to finish sign-in…</p>");
						return;
					}
					try {
						const result = await forwardedGet(forwardPort, `/callback?${new URLSearchParams({ code, state })}`);
						if (result.status !== 200) throw new Error("Callback was not accepted.");
						headers(res, "text/html");
						res.writeHead(200);
						res.once("finish", () => {
							void session.stop();
						});
						res.end(
							"<!doctype html><title>Callback delivered</title><h1>Callback delivered to DSH</h1><p>DSH is finishing sign-in. Return to DSH Settings to see the result.</p>",
						);
					} catch {
						res.once("finish", () => {
							void session.stop();
						});
						json(res, 502, { error: "The callback could not reach DSH. Return to Settings and retry." });
					}
				})().catch(() => json(res, 400, { error: "Invalid callback." }));
			};
			session.callback = createServer(receiveCallback);
			await listen(session.callback, callbackPort);
			session.callbackV6 = createServer(receiveCallback);
			try {
				await listen(session.callbackV6, callbackPort, "::1");
			} catch (error) {
				// Some hosts disable IPv6 entirely; IPv4 localhost remains usable there.
				if (!["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
			}
			if (session.stopped) throw new Error("Login was cancelled.");
			session.timer = setTimeout(() => {
				void session.stop();
			}, sessionTimeout);
			if (!command) {
				await options._test?.beforeBrowserReady?.();
				if (session.stopped) throw new Error("Login was cancelled.");
				session.ready = true;
				finishInitialization();
				return;
			}
			session.tunnel = spawnTunnel(command.command, [...command.args]);
			if (options._test?.spawnOwnsProcessGroup) ownedGroups.add(session.tunnel);
			session.tunnel.once("error", () => {
				void session.stop();
			});
			session.tunnel.once("exit", () => {
				void session.stop();
			});
			const deadline = Date.now() + readyTimeout;
			while (Date.now() < deadline && !session.stopped) {
				try {
					const probe = await forwardedGet(forwardPort, "/callback");
					if (session.stopped) throw new Error("Login was cancelled.");
					if (probe.status === 400 && probe.body.includes("Missing code or state parameter.")) {
						const checkRemote = async () => {
							if (session.stopped || session.used) return;
							try {
								const health = await forwardedGet(forwardPort, "/callback");
								if (session.stopped || session.used) return;
								if (health.status !== 400 || !health.body.includes("Missing code or state parameter.")) {
									await session.stop();
									return;
								}
							} catch {
								if (session.stopped || session.used) return;
								await session.stop();
								return;
							}
							if (!session.stopped && !session.used)
								session.healthTimer = setTimeout(() => {
									void checkRemote();
								}, options._test?.pollIntervalMs ?? 1000);
						};
						session.healthTimer = setTimeout(() => {
							void checkRemote();
						}, options._test?.pollIntervalMs ?? 1000);
						finishInitialization();
						session.ready = true;
						return;
					}
				} catch {
					/* A tunnel can bind before its remote destination is ready. */
				}
				await new Promise((resolve) => setTimeout(resolve, options._test?.pollIntervalMs ?? 150));
			}
			throw new Error("The secure connection is not ready. Check SSH/IAP access and retry.");
		} catch (error) {
			finishInitialization();
			await session.stop();
			if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
				throw new Error("The local callback port is already in use. Close the other login and retry.");
			}
			throw error;
		}
	}

	const control = createServer((req, res) => {
		void (async () => {
			if (!localPeer(req, controlPort) || closed) return json(res, 403, { error: "Forbidden." });
			if (req.url === "/health") {
				if (req.method !== "GET") return json(res, 405, { error: "Method not allowed." });
				return json(res, 200, { service: "dsh-claude-bridge", protocol: 1, configurationId });
			}
			if (req.url !== "/start") return json(res, 404, { error: "Not found." });
			if (req.method === "GET") {
				let referringOrigin = "";
				try {
					referringOrigin = new URL(req.headers.referer ?? "").origin;
				} catch {
					/* Missing referrer is forbidden. */
				}
				if (referringOrigin !== remoteOrigin)
					return json(res, 403, { error: "Open this connection from your configured DSH Settings." });
				const now = Date.now();
				for (const [token, expiry] of pageTokens) if (expiry < now) pageTokens.delete(token);
				if (pageTokens.size >= 16) return json(res, 429, { error: "Too many pending requests. Retry shortly." });
				const token = randomBytes(32).toString("base64url");
				pageTokens.set(token, now + PAGE_TOKEN_TTL);
				headers(res, "text/html");
				res.setHeader(
					"Content-Security-Policy",
					"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
				);
				res.end(page(token));
				return;
			}
			if (
				req.method !== "POST" ||
				req.headers.origin !== controlOrigin ||
				req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json" ||
				(req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin")
			)
				return json(res, 403, { error: "Forbidden." });
			const token = req.headers["x-dsh-bridge-page-token"];
			if (typeof token !== "string" || (pageTokens.get(token) ?? 0) <= Date.now())
				return json(res, 403, { error: "Expired connection page. Reopen it from DSH Settings." });
			pageTokens.delete(token);
			let payload: unknown;
			try {
				payload = await readBody(req);
			} catch {
				return json(res, 400, { error: "Invalid connection request." });
			}
			if (!payload || typeof payload !== "object" || Array.isArray(payload))
				return json(res, 400, { error: "Invalid connection request." });
			const value = payload as Record<string, unknown>;
			if (value.remoteOrigin !== remoteOrigin)
				return json(res, 403, { error: "Remote DSH origin does not match this bridge." });
			let auth: { url: string; state: string };
			try {
				auth = authorization(value.authUrl);
			} catch {
				return json(res, 400, { error: "Invalid Claude authorization request." });
			}
			if (active && !command) {
				if (active.state === auth.state) {
					if (!active.ready || active.stopped || active.used)
						return json(res, 409, { error: "This login is still preparing. Retry shortly." });
					return json(res, 200, { authUrl: auth.url });
				}
				// A new authenticated DSH challenge replaces only our old browser attempt.
				await active.stop();
			}
			if (active) return json(res, 409, { error: "Another login is active. Finish it before trying again." });
			try {
				await begin(auth);
				json(res, 200, { authUrl: auth.url });
			} catch (error) {
				json(res, 503, {
					error:
						error instanceof Error && !error.message.includes("spawn")
							? error.message
							: "The secure connection could not start. Check SSH/IAP access and retry.",
				});
			}
		})().catch(() => json(res, 500, { error: "The local bridge could not process this request." }));
	});
	controlPort = await listen(control, controlPort);
	controlOrigin = `http://127.0.0.1:${controlPort}`;
	return {
		url: `${controlOrigin}/start`,
		close: async () => {
			closed = true;
			pageTokens.clear();
			await Promise.all([active?.stop(), closeServer(control)]);
		},
	};
}
