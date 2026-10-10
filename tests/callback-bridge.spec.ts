import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, request, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { type BridgeTarget, startCallbackBridge } from "../src/callback-bridge.ts";

const remoteOrigin = "https://dsh.example.com";
const authUrl = `https://claude.ai/oauth/authorize?${new URLSearchParams({
	response_type: "code",
	redirect_uri: "http://localhost:53692/callback",
	state: "fixture-state",
	code_challenge_method: "S256",
	code_challenge: "fixture-challenge",
})}`;

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function listen(server: Server): Promise<number> {
	return new Promise((resolve) =>
		server.listen(0, "127.0.0.1", () => {
			resolve((server.address() as { port: number }).port);
		}),
	);
}

async function close(server: Server): Promise<void> {
	if (!server.listening) return;
	await new Promise<void>((resolve) => {
		server.close(() => resolve());
		server.closeAllConnections();
	});
}

async function freePort(): Promise<number> {
	const server = createServer();
	const port = await listen(server);
	await close(server);
	return port;
}

async function rawGet(url: string, headers: Record<string, string>): Promise<number> {
	return new Promise((resolve, reject) => {
		const req = request(url, { headers }, (res) => {
			res.resume();
			res.once("end", () => resolve(res.statusCode ?? 0));
		});
		req.once("error", reject);
		req.end();
	});
}

class FakeTunnel extends EventEmitter {
	signals: string[] = [];
	alive = true;
	ignoreTerm = false;
	onStop?: () => void;
	kill(signal: string): boolean {
		this.signals.push(signal);
		if (!this.alive) return false;
		if (this.ignoreTerm && signal === "SIGTERM") return true;
		this.alive = false;
		this.onStop?.();
		queueMicrotask(() => this.emit("exit", 0));
		return true;
	}
}

async function fixture(
	options: {
		ready?: boolean;
		callbackStatus?: number;
		target?: BridgeTarget;
		ttl?: number;
		ignoreTerm?: boolean;
		beforeBrowserReady?: () => Promise<void>;
		configurationId?: string;
	} = {},
) {
	const callbacks: string[] = [];
	let ready = options.ready ?? true;
	let hold: (() => void) | undefined;
	let delayed = false;
	const forward = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (!url.searchParams.has("code")) {
			res.writeHead(ready ? 400 : 200);
			res.end(ready ? "<p>Missing code or state parameter.</p>" : "Not a native callback service");
			return;
		}
		callbacks.push(req.url ?? "");
		const respond = () => {
			res.writeHead(options.callbackStatus ?? 200);
			res.end("Remote callback reply; no tokens in the fixture");
		};
		if (delayed) hold = respond;
		else respond();
	});
	const forwardPort = await listen(forward);
	await close(forward);
	const callbackPort = await freePort();
	const child = new FakeTunnel();
	child.ignoreTerm = options.ignoreTerm ?? false;
	child.onStop = () => {
		forward.close();
		forward.closeAllConnections();
	};
	const spawns: Array<{ command: string; args: string[] }> = [];
	const bridge = await startCallbackBridge({
		target: options.target ?? { kind: "ssh", host: "devbox.example.com" },
		remoteOrigin,
		...(options.configurationId === undefined ? {} : { configurationId: options.configurationId }),
		_test: {
			controlPort: 0,
			callbackPort,
			forwardPort,
			readyTimeoutMs: 100,
			sessionTimeoutMs: options.ttl ?? 5000,
			pollIntervalMs: 10,
			killTimeoutMs: 15,
			...(options.beforeBrowserReady === undefined ? {} : { beforeBrowserReady: options.beforeBrowserReady }),
			spawnTunnel: (command, args) => {
				child.alive = true;
				forward.listen(forwardPort, "127.0.0.1");
				spawns.push({ command, args });
				return child as unknown as ChildProcess;
			},
		},
	});
	cleanup.push(() => close(forward));
	cleanup.push(bridge.close);
	const controlOrigin = new URL(bridge.url).origin;
	async function pageToken(headers: Record<string, string> = {}) {
		const response = await fetch(bridge.url, { headers: { Referer: `${remoteOrigin}/?fixture=1`, ...headers } });
		const html = await response.text();
		return { response, html, token: html.match(/"x-dsh-bridge-page-token":"([^"]+)"/)?.[1] ?? "" };
	}
	async function start(payload: unknown = { authUrl, remoteOrigin }, headers: Record<string, string> = {}) {
		const page = await pageToken();
		expect(page.response.status).toBe(200);
		return fetch(bridge.url, {
			method: "POST",
			headers: {
				Origin: controlOrigin,
				"Content-Type": "application/json",
				"x-dsh-bridge-page-token": page.token,
				...headers,
			},
			body: JSON.stringify(payload),
		});
	}
	return {
		bridge,
		forwardPort,
		callbackPort,
		callbacks,
		child,
		spawns,
		pageToken,
		start,
		controlOrigin,
		setReady: (value: boolean) => {
			ready = value;
		},
		delayCallback: () => {
			delayed = true;
		},
		releaseCallback: () => {
			hold?.();
		},
	};
}

describe("local Claude callback bridge", () => {
	it("exposes only protocol and configuration identity in its loopback health response", async () => {
		const f = await fixture({ target: { kind: "browser" } });
		expect((await f.start()).status).toBe(200);
		const response = await fetch(`${f.controlOrigin}/health`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			service: "dsh-claude-bridge",
			protocol: 1,
			configurationId: createHash("sha256")
				.update(JSON.stringify([remoteOrigin, "browser"]))
				.digest("hex"),
		});
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("access-control-allow-origin")).toBeNull();
		expect(f.spawns).toHaveLength(0);
	});

	it("uses the supplied original configuration fingerprint after optional target discovery", async () => {
		const configurationId = "a".repeat(64);
		const f = await fixture({
			target: { kind: "gcp", instance: "example-vm", project: "example-project", zone: "us-central1-a" },
			configurationId,
		});
		const payload = await (await fetch(`${f.controlOrigin}/health`)).json();
		expect(payload).toEqual({ service: "dsh-claude-bridge", protocol: 1, configurationId });
		expect(JSON.stringify(payload)).not.toContain(remoteOrigin);
		expect(JSON.stringify(payload)).not.toContain("example-project");
		expect(JSON.stringify(payload)).not.toContain("example-vm");
		expect(JSON.stringify(payload)).not.toContain("us-central1-a");
		expect(f.spawns).toHaveLength(0);
	});

	it("rejects health requests with non-loopback Host or unsupported methods and invalid identity", async () => {
		const f = await fixture();
		expect(await rawGet(`${f.controlOrigin}/health`, { Host: "evil.example.com" })).toBe(403);
		expect(await rawGet(`${f.controlOrigin}/health`, { Host: `127.0.0.1:1` })).toBe(403);
		expect((await fetch(`${f.controlOrigin}/health`, { method: "POST" })).status).toBe(405);
		await expect(
			startCallbackBridge({ target: { kind: "browser" }, remoteOrigin, configurationId: "invalid" }),
		).rejects.toThrow("fingerprint");
	});

	it("reuses a fully ready browser challenge and replaces only its owned cancelled attempt for a new state", async () => {
		const f = await fixture({ target: { kind: "browser" } });
		expect((await f.start()).status).toBe(200);
		expect((await f.start()).status).toBe(200);
		const freshAuth = authUrl.replace("state=fixture-state", "state=fresh-state");
		expect((await f.start({ authUrl: freshAuth, remoteOrigin })).status).toBe(200);
		const callback = `http://127.0.0.1:${f.callbackPort}/callback`;
		expect((await fetch(`${callback}?code=old-code&state=fixture-state`)).status).toBe(400);
		const accepted = await fetch(`${callback}?code=fresh-code&state=fresh-state`, { redirect: "manual" });
		expect(accepted.status).toBe(303);
		const fragment = new URL(accepted.headers.get("location") ?? "").hash;
		expect(new URLSearchParams(fragment.slice(1)).get("dsh-claude-callback")).toBe(
			"http://localhost:53692/callback?code=fresh-code&state=fresh-state",
		);
		expect(f.spawns).toHaveLength(0);
		expect(f.child.signals).toHaveLength(0);
	});

	it("does not claim an identical browser challenge is ready while its callback setup is pending", async () => {
		let entered = false;
		let ready: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const f = await fixture({
			target: { kind: "browser" },
			beforeBrowserReady: async () => {
				entered = true;
				await gate;
			},
		});
		const first = f.start();
		await expect.poll(() => entered).toBe(true);
		try {
			expect((await f.start()).status).toBe(409);
		} finally {
			ready();
		}
		expect((await first).status).toBe(200);
		expect((await f.start()).status).toBe(200);
	});

	it("releases an owned browser listener for a fresh retry overlapping its initial preparation", async () => {
		let entered = false;
		let ready: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const f = await fixture({
			target: { kind: "browser" },
			beforeBrowserReady: async () => {
				entered = true;
				await gate;
			},
		});
		const first = f.start();
		await expect.poll(() => entered).toBe(true);
		const freshAuth = authUrl.replace("state=fixture-state", "state=fresh-state");
		const retry = f.start({ authUrl: freshAuth, remoteOrigin });
		try {
			await new Promise((resolve) => setTimeout(resolve, 25));
		} finally {
			ready();
		}
		// The first response may finish just before replacement, or report that its own setup was cancelled.
		expect([200, 503]).toContain((await first).status);
		expect((await retry).status).toBe(200);
		const callback = `http://127.0.0.1:${f.callbackPort}/callback`;
		expect((await fetch(`${callback}?code=old-code&state=fixture-state`)).status).toBe(400);
		expect((await fetch(`${callback}?code=fresh-code&state=fresh-state`, { redirect: "manual" })).status).toBe(303);
		expect(f.spawns).toHaveLength(0);
		expect(f.child.signals).toHaveLength(0);
	});

	it("returns matching browser callbacks through an exact remote-origin fragment without SSH, IAM or claiming a forward port", async () => {
		const f = await fixture({ target: { kind: "browser" } });
		const incumbent = createServer((_req, res) => res.end("existing local service"));
		await new Promise<void>((resolve) => incumbent.listen(f.forwardPort, "127.0.0.1", resolve));
		cleanup.push(() => close(incumbent));
		expect((await f.start()).status).toBe(200);
		expect(f.spawns).toHaveLength(0);
		const callback = `http://127.0.0.1:${f.callbackPort}/callback`;
		expect((await fetch(`${callback}?code=fixture-code&state=wrong`)).status).toBe(400);
		expect((await fetch(`${callback}?code=fixture-code&state=fixture-state&state=second`)).status).toBe(400);
		expect((await fetch(`${callback}?code=fixture-code&code=second&state=fixture-state`)).status).toBe(400);
		const response = await fetch(`${callback}?code=fixture-code&state=fixture-state&next=https://evil.example.com/`, {
			redirect: "manual",
		});
		expect(response.status).toBe(303);
		const location = new URL(response.headers.get("location") ?? "");
		expect(location.origin).toBe(remoteOrigin);
		expect(location.pathname).toBe("/");
		expect(location.search).toBe("");
		expect(new URLSearchParams(location.hash.slice(1)).get("dsh-claude-callback")).toBe(
			"http://localhost:53692/callback?code=fixture-code&state=fixture-state",
		);
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.text()).not.toContain("fixture-code");
		expect(f.callbacks).toHaveLength(0);
		expect(f.child.signals).toHaveLength(0);
		expect(await (await fetch(`http://127.0.0.1:${f.forwardPort}`)).text()).toBe("existing local service");
		await expect
			.poll(async () => {
				const proof = createServer();
				const free = await new Promise<boolean>((resolve) => {
					proof.once("error", () => resolve(false));
					proof.listen(f.callbackPort, "127.0.0.1", () => resolve(true));
				});
				await close(proof);
				return free;
			})
			.toBe(true);
		expect((await f.pageToken()).response.status).toBe(200);
	});

	it("bounds a browser-only session and does not reflect arbitrary callback errors", async () => {
		const f = await fixture({ target: { kind: "browser" }, ttl: 50 });
		expect((await f.start()).status).toBe(200);
		const declined = await fetch(
			`http://127.0.0.1:${f.callbackPort}/callback?error=private-provider-detail&state=fixture-state`,
		);
		expect(declined.status).toBe(400);
		expect(await declined.text()).not.toContain("private-provider-detail");
		await expect.poll(async () => (await f.start()).status).toBe(200);
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect((await f.start()).status).toBe(200);
		expect(f.spawns).toHaveLength(0);
	});

	it("requires the configured remote referrer and erases fragment before a one-time same-origin POST", async () => {
		const f = await fixture();
		expect((await fetch(f.bridge.url)).status).toBe(403);
		expect(await rawGet(f.bridge.url, { Host: "evil.example.com", Referer: remoteOrigin })).toBe(403);
		expect((await f.pageToken({ Referer: "https://other.example.com/" })).response.status).toBe(403);
		const page = await f.pageToken();
		expect(page.html).toContain('history.replaceState(null,"",location.pathname)');
		expect(page.html).toContain("location.replace(result.authUrl)");
		expect(page.html).not.toContain("fixture-state");
		expect(page.response.headers.get("referrer-policy")).toBe("no-referrer");
		expect((await fetch(f.bridge.url, { method: "OPTIONS" })).status).toBe(403);
		const headers = {
			Origin: f.controlOrigin,
			"Content-Type": "application/json",
			"x-dsh-bridge-page-token": page.token,
		};
		const body = JSON.stringify({ authUrl, remoteOrigin });
		expect((await fetch(f.bridge.url, { method: "POST", headers, body })).status).toBe(200);
		expect((await fetch(f.bridge.url, { method: "POST", headers, body })).status).toBe(403);
	});

	it("rejects cross-origin requests, non-JSON bodies, missing tokens, wrong remote origins and oversized input", async () => {
		const f = await fixture();
		expect((await f.start(undefined, { Origin: "https://evil.example.com" })).status).toBe(403);
		expect((await f.start(undefined, { "sec-fetch-site": "cross-site" })).status).toBe(403);
		expect((await f.start(undefined, { "Content-Type": "text/plain" })).status).toBe(403);
		expect((await f.start(undefined, { "x-dsh-bridge-page-token": "wrong" })).status).toBe(403);
		expect((await f.start({ authUrl, remoteOrigin: "https://other.example.com" })).status).toBe(403);
		expect((await f.start({ authUrl, remoteOrigin, extra: "x".repeat(8192) })).status).toBe(400);
		expect(f.spawns).toHaveLength(0);
	});

	it("validates the exact Claude challenge before spawning a fixed-target shell-free tunnel", async () => {
		const f = await fixture();
		for (const changed of [
			authUrl.replace("claude.ai", "evil.example.com"),
			authUrl.replace("/oauth/authorize", "/other"),
			authUrl.replace("response_type=code", "response_type=token"),
			authUrl.replace("S256", "plain"),
			authUrl.replace("53692", "53693"),
			`${authUrl}&state=second`,
			`${authUrl}&redirect_uri=second`,
			authUrl.replace("state=fixture-state", "state="),
			authUrl.replace("code_challenge=fixture-challenge", "code_challenge="),
		])
			expect((await f.start({ authUrl: changed, remoteOrigin })).status).toBe(400);
		expect(f.spawns).toHaveLength(0);
		const started = await f.start();
		expect(started.status).toBe(200);
		expect(await started.json()).toEqual({ authUrl });
		expect(f.spawns[0]?.command).toBe("ssh");
		expect(f.spawns[0]?.args).toEqual(
			expect.arrayContaining([
				"-N",
				"-T",
				"BatchMode=yes",
				"StrictHostKeyChecking=yes",
				"ControlMaster=no",
				"ControlPath=none",
			]),
		);
		expect(f.spawns[0]?.args.at(-1)).toBe("devbox.example.com");
		expect(f.spawns[0]?.args.join(" ")).not.toContain("fixture-state");
	});

	it("requires the native readiness response rather than an open TCP port and then allows a retry", async () => {
		const f = await fixture({ ready: false });
		expect((await f.start()).status).toBe(503);
		expect(f.child.signals).toContain("SIGTERM");
		f.setReady(true);
		expect((await f.start()).status).toBe(200);
	});

	it("forwards matching code/state once, rejects unrelated callbacks, and closes only its owned resources", async () => {
		const f = await fixture();
		expect((await f.start()).status).toBe(200);
		const callback = `http://127.0.0.1:${f.callbackPort}/callback`;
		expect((await fetch(`${callback}?code=fixture-code&state=other`)).status).toBe(400);
		expect((await fetch(`${callback}?code=fixture-code&state=fixture-state&state=fixture-state`)).status).toBe(400);
		expect(f.callbacks).toHaveLength(0);
		f.delayCallback();
		const delivered = fetch(`${callback}?code=fixture-code&state=fixture-state`);
		await expect.poll(() => f.callbacks.length).toBe(1);
		expect((await fetch(`${callback}?code=fixture-code&state=fixture-state`)).status).toBe(409);
		f.releaseCallback();
		const result = await delivered;
		expect(result.status).toBe(200);
		expect(await result.text()).toContain("DSH is finishing sign-in");
		expect(f.callbacks).toEqual(["/callback?code=fixture-code&state=fixture-state"]);
		await expect.poll(() => f.child.signals).toContain("SIGTERM");
		expect((await f.pageToken()).response.status).toBe(200);
	});

	it("lets an accepted native callback finish after the pending-login lease expires", async () => {
		const f = await fixture({ ttl: 80 });
		expect((await f.start()).status).toBe(200);
		f.delayCallback();
		const delivered = fetch(`http://127.0.0.1:${f.callbackPort}/callback?code=fixture-code&state=fixture-state`).then(
			(response) => response,
			(error: unknown) => error,
		);
		await expect.poll(() => f.callbacks.length).toBe(1);
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect(f.child.signals).toHaveLength(0);
		f.releaseCallback();
		const result = await delivered;
		expect(result).toBeInstanceOf(Response);
		expect((result as Response).status).toBe(200);
		expect(await (result as Response).text()).toContain("DSH is finishing sign-in");
		await expect.poll(() => f.child.signals).toContain("SIGTERM");
	});

	it("fails on callback port conflicts without spawning or killing an existing service", async () => {
		const f = await fixture();
		const incumbent = createServer((_req, res) => res.end("incumbent"));
		await new Promise<void>((resolve) => incumbent.listen(f.callbackPort, "127.0.0.1", resolve));
		cleanup.push(() => close(incumbent));
		const result = await f.start();
		expect(result.status).toBe(503);
		expect((await result.json()).error).toContain("already in use");
		expect(f.spawns).toHaveLength(0);
		expect(f.child.signals).toHaveLength(0);
		expect(await (await fetch(`http://127.0.0.1:${f.callbackPort}`)).text()).toBe("incumbent");
	});

	it("fails on an occupied forwarding port without trusting or killing that listener", async () => {
		const f = await fixture();
		const forwardingFlagPort = f.forwardPort;
		// The fixture exposes its configured port; an incumbent could even mimic readiness.
		const incumbent = createServer((_req, res) => {
			res.writeHead(400);
			res.end("Missing code or state parameter.");
		});
		await new Promise<void>((resolve) => incumbent.listen(forwardingFlagPort, "127.0.0.1", resolve));
		cleanup.push(() => close(incumbent));
		const result = await f.start();
		expect(result.status).toBe(503);
		expect((await result.json()).error).toContain("tunnel port is already in use");
		expect(f.spawns).toHaveLength(0);
		expect(f.child.signals).toHaveLength(0);
	});

	it("accepts localhost callbacks over IPv6 and cleans up an explicit authorization decline", async () => {
		const f = await fixture();
		expect((await f.start()).status).toBe(200);
		const wrong = await rawGet(`http://[::1]:${f.callbackPort}/callback?code=fixture-code&state=other`, {
			Host: `localhost:${f.callbackPort}`,
		});
		expect(wrong).toBe(400);
		const declined = await fetch(`http://127.0.0.1:${f.callbackPort}/callback?error=access_denied&state=fixture-state`);
		expect(declined.status).toBe(400);
		await expect.poll(() => f.child.signals).toContain("SIGTERM");
		expect(f.callbacks).toHaveLength(0);
	});

	it("closes listeners and a starting tunnel when the daemon is stopped during readiness", async () => {
		const f = await fixture({ ready: false });
		const pending = f.start().catch(() => undefined);
		await expect.poll(() => f.spawns.length).toBe(1);
		await f.bridge.close();
		await pending;
		const probe = createServer();
		await new Promise<void>((resolve, reject) => {
			probe.once("error", reject);
			probe.listen(f.callbackPort, "127.0.0.1", resolve);
		});
		await close(probe);
		expect(f.child.signals).toContain("SIGTERM");
	});

	it("keeps one active session and rejects a second login before spawning", async () => {
		const f = await fixture();
		expect((await f.start()).status).toBe(200);
		expect((await f.start()).status).toBe(409);
		expect(f.spawns).toHaveLength(1);
	});

	it("cleans up after remote cancellation and escalates an unresponsive owned child to SIGKILL", async () => {
		const f = await fixture({ ignoreTerm: true });
		expect((await f.start()).status).toBe(200);
		f.setReady(false);
		await expect.poll(() => f.child.signals).toContain("SIGKILL");
		expect((await f.pageToken()).response.status).toBe(200);
	});

	it("cleans up failed callback forwarding and bounded session expiry", async () => {
		const f = await fixture({ callbackStatus: 400 });
		expect((await f.start()).status).toBe(200);
		const result = await fetch(`http://127.0.0.1:${f.callbackPort}/callback?code=fixture-code&state=fixture-state`);
		expect(result.status).toBe(502);
		await expect.poll(() => f.child.signals).toContain("SIGTERM");
		const expiry = await fixture({ ttl: 40 });
		expect((await expiry.start()).status).toBe(200);
		await expect.poll(() => expiry.child.signals).toContain("SIGTERM");
	});

	it("builds IAP forwarding arguments solely from configured target and rejects unsafe configuration", async () => {
		const f = await fixture({
			target: { kind: "gcp", instance: "devbox-example", project: "example-project", zone: "us-central1-a" },
		});
		expect((await f.start()).status).toBe(200);
		expect(f.spawns[0]?.command).toBe("gcloud");
		expect(f.spawns[0]?.args).toEqual(
			expect.arrayContaining([
				"compute",
				"ssh",
				"devbox-example",
				"--project=example-project",
				"--zone=us-central1-a",
				"--tunnel-through-iap",
				"--ssh-flag=-o BatchMode=yes",
			]),
		);
		await expect(
			startCallbackBridge({ target: { kind: "ssh", host: "-oProxyCommand=evil" }, remoteOrigin }),
		).rejects.toThrow("Invalid configured SSH host");
		await expect(
			startCallbackBridge({ target: { kind: "ssh", host: "example.com" }, remoteOrigin: "http://example.com" }),
		).rejects.toThrow("HTTPS origin");
	});

	it.skipIf(process.platform === "win32")(
		"terminates owned tunnel descendants even after the tunnel parent exits",
		async () => {
			const forwardPort = await freePort();
			const callbackPort = await freePort();
			const descendantSource = `const http=require('node:http');process.on('SIGTERM',()=>{});http.createServer((req,res)=>{res.writeHead(400);res.end('Missing code or state parameter.');}).listen(${forwardPort},'127.0.0.1');`;
			const parentSource = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendantSource)}],{stdio:'ignore'});setInterval(()=>{},1000);`;
			let tunnel: ChildProcess | undefined;
			const bridge = await startCallbackBridge({
				target: { kind: "ssh", host: "devbox.example.com" },
				remoteOrigin,
				_test: {
					controlPort: 0,
					callbackPort,
					forwardPort,
					readyTimeoutMs: 2000,
					killTimeoutMs: 100,
					spawnOwnsProcessGroup: true,
					spawnTunnel: () => {
						tunnel = spawn(process.execPath, ["-e", parentSource], { detached: true, stdio: "ignore" });
						return tunnel;
					},
				},
			});
			cleanup.push(async () => {
				await bridge.close();
				if (tunnel?.pid) {
					try {
						process.kill(-tunnel.pid, "SIGKILL");
					} catch {
						/* Already stopped. */
					}
				}
			});
			const html = await (await fetch(bridge.url, { headers: { Referer: remoteOrigin } })).text();
			const token = html.match(/"x-dsh-bridge-page-token":"([^"]+)"/)?.[1] ?? "";
			const started = await fetch(bridge.url, {
				method: "POST",
				headers: {
					Origin: new URL(bridge.url).origin,
					"Content-Type": "application/json",
					"x-dsh-bridge-page-token": token,
				},
				body: JSON.stringify({ authUrl, remoteOrigin }),
			});
			expect(started.status).toBe(200);
			await bridge.close();
			// The descendant ignores SIGTERM; SIGKILL must release the forward port.
			await expect
				.poll(async () => {
					const proof = createServer();
					const available = await new Promise<boolean>((resolve) => {
						proof.once("error", () => resolve(false));
						proof.listen(forwardPort, "127.0.0.1", () => resolve(true));
					});
					await close(proof);
					return available;
				})
				.toBe(true);
		},
	);
});
