#!/usr/bin/env node

// src/callback-bridge-bin.ts
import { spawn as spawn2 } from "node:child_process";
import { createHash as createHash2 } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { request as request2 } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// src/callback-bridge.ts
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, request } from "node:http";
import { createServer as createTcpServer } from "node:net";
var CALLBACK_PORT = 53692;
var CONTROL_PORT = 53700;
var FORWARD_PORT = 53694;
var REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;
var PAGE_TOKEN_TTL = 6e4;
var MAX_BODY_BYTES = 8192;
function configuredOrigin(value, allowHttp = false) {
  const url = new URL(value);
  if (url.origin !== value || url.username || url.password || url.protocol !== "https:" && !(allowHttp && url.protocol === "http:"))
    throw new Error("Configure the exact HTTPS origin of your remote DSH instance.");
  return url.origin;
}
function unique(params, name) {
  const values = params.getAll(name);
  if (values.length !== 1 || !values[0]) throw new Error("Invalid Claude authorization request.");
  return values[0];
}
function authorization(input) {
  if (typeof input !== "string" || Buffer.byteLength(input) > 4096) {
    throw new Error("Invalid Claude authorization request.");
  }
  const url = new URL(input);
  if (url.origin !== "https://claude.ai" || url.pathname !== "/oauth/authorize" || url.username || url.password || url.hash || unique(url.searchParams, "response_type") !== "code" || unique(url.searchParams, "redirect_uri") !== REDIRECT_URI || unique(url.searchParams, "code_challenge_method") !== "S256")
    throw new Error("Invalid Claude authorization request.");
  unique(url.searchParams, "code_challenge");
  const state = unique(url.searchParams, "state");
  return { url: url.href, state };
}
function tunnelCommand(target, forwardPort) {
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
    `127.0.0.1:${forwardPort}:127.0.0.1:${CALLBACK_PORT}`
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
    `-L127.0.0.1:${forwardPort}:127.0.0.1:${CALLBACK_PORT}`
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
      ...sshFlags.map((flag) => `--ssh-flag=${flag}`)
    ]
  };
}
function localPeer(req, port) {
  const peer = req.socket.remoteAddress;
  return (peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1") && (req.headers.host === `127.0.0.1:${port}` || req.headers.host === `localhost:${port}`);
}
function headers(res, type = "application/json") {
  res.setHeader("Content-Type", `${type}; charset=utf-8`);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}
function json(res, status, value) {
  headers(res);
  res.writeHead(status);
  res.end(JSON.stringify(value));
}
async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
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
async function listen(server, port, host = "127.0.0.1") {
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
async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
async function checkForwardPort(port) {
  const probe = createTcpServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () => probe.close((error) => error ? reject(error) : resolve()));
  });
}
async function terminate(child, timeout, ownedGroup) {
  await new Promise((resolve) => {
    let settled = false;
    let groupPoll;
    const signal = (value) => {
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
async function forwardedGet(port, path) {
  return new Promise((resolve, reject) => {
    let timer;
    const req = request({ host: "127.0.0.1", port, path, method: "GET", timeout: 2e3 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
        if (body.length > 65536) req.destroy(new Error("Unexpected callback response."));
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
    timer = setTimeout(() => req.destroy(new Error("Callback connection timed out.")), 2e3);
    req.end();
  });
}
function page(token) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Claude to DSH</title><style>body{font:16px system-ui;max-width:560px;margin:12vh auto;padding:24px;color:#202124}h1{font-size:24px}p{line-height:1.6}</style><h1>Preparing your secure connection\u2026</h1><p id="message">Claude will open when the callback connection is ready. Keep DSH Settings open.</p><script>const params=new URLSearchParams(location.hash.slice(1));history.replaceState(null,"",location.pathname);const authUrl=params.get("authUrl"),remoteOrigin=params.get("remoteOrigin");fetch("/start",{method:"POST",headers:{"Content-Type":"application/json","x-dsh-bridge-page-token":${JSON.stringify(token)}},body:JSON.stringify({authUrl,remoteOrigin})}).then(async response=>{const result=await response.json();if(!response.ok)throw new Error(result.error||"Connection failed.");location.replace(result.authUrl);}).catch(error=>{document.querySelector("h1").textContent="Connection could not start";document.querySelector("#message").textContent=error.message+" Return to DSH Settings to retry or use the paste option.";});</script></html>`;
}
async function startCallbackBridge(options) {
  const remoteOrigin = configuredOrigin(options.remoteOrigin, options._test?.allowHttpOrigin);
  const targetFields = options.target.kind === "browser" ? [] : options.target.kind === "ssh" ? [options.target.host] : [options.target.instance, options.target.project, options.target.zone];
  const configurationId = options.configurationId ?? createHash("sha256").update(JSON.stringify([remoteOrigin, options.target.kind, ...targetFields])).digest("hex");
  if (typeof configurationId !== "string" || !/^[a-f0-9]{64}$/u.test(configurationId)) {
    throw new Error("Invalid bridge configuration fingerprint.");
  }
  const callbackPort = options._test?.callbackPort ?? CALLBACK_PORT;
  const forwardPort = options._test?.forwardPort ?? FORWARD_PORT;
  const command = options.target.kind === "browser" ? void 0 : tunnelCommand(options.target, forwardPort);
  const readyTimeout = options._test?.readyTimeoutMs ?? 3e4;
  const sessionTimeout = options._test?.sessionTimeoutMs ?? 5 * 6e4;
  const killTimeout = options._test?.killTimeoutMs ?? 1500;
  const ownedGroups = /* @__PURE__ */ new WeakSet();
  const spawnTunnel = options._test?.spawnTunnel ?? ((name, args) => {
    const child = spawn(name, args, { shell: false, stdio: "ignore", detached: process.platform !== "win32" });
    if (process.platform !== "win32") ownedGroups.add(child);
    return child;
  });
  const pageTokens = /* @__PURE__ */ new Map();
  let active;
  let closed = false;
  let controlPort = options._test?.controlPort ?? CONTROL_PORT;
  let controlOrigin = `http://127.0.0.1:${controlPort}`;
  async function begin(auth) {
    if (active || closed) throw new Error("Another login is active. Finish it before trying again.");
    const session = {
      state: auth.state,
      stopped: false,
      ready: false,
      used: false,
      stop: async () => {
      }
    };
    active = session;
    let stopping;
    let finishInitialization = () => {
    };
    const initialized = new Promise((resolve) => {
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
        if (active === session) active = void 0;
      })();
      return stopping;
    };
    try {
      try {
        if (command) await checkForwardPort(forwardPort);
      } catch (error) {
        if (error.code === "EADDRINUSE")
          throw new Error("The local tunnel port is already in use. Close the other connection and retry.");
        throw error;
      }
      if (session.stopped) throw new Error("Login was cancelled.");
      const receiveCallback = (req, res) => {
        void (async () => {
          if (!localPeer(req, callbackPort) || req.method !== "GET") return json(res, 403, { error: "Forbidden." });
          const url = new URL(req.url ?? "/", "http://localhost");
          if (url.pathname !== "/callback" || session.stopped)
            return json(res, 404, { error: "Callback unavailable." });
          if (session.used) return json(res, 409, { error: "Callback already delivered." });
          let state;
          let code;
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
            res.end("<!doctype html><title>Returning to DSH</title><p>Returning to DSH to finish sign-in\u2026</p>");
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
              "<!doctype html><title>Callback delivered</title><h1>Callback delivered to DSH</h1><p>DSH is finishing sign-in. Return to DSH Settings to see the result.</p>"
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
        if (!["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(error.code ?? "")) throw error;
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
                }, options._test?.pollIntervalMs ?? 1e3);
            };
            session.healthTimer = setTimeout(() => {
              void checkRemote();
            }, options._test?.pollIntervalMs ?? 1e3);
            finishInitialization();
            session.ready = true;
            return;
          }
        } catch {
        }
        await new Promise((resolve) => setTimeout(resolve, options._test?.pollIntervalMs ?? 150));
      }
      throw new Error("The secure connection is not ready. Check SSH/IAP access and retry.");
    } catch (error) {
      finishInitialization();
      await session.stop();
      if (error.code === "EADDRINUSE") {
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
        }
        if (referringOrigin !== remoteOrigin)
          return json(res, 403, { error: "Open this connection from your configured DSH Settings." });
        const now = Date.now();
        for (const [token3, expiry] of pageTokens) if (expiry < now) pageTokens.delete(token3);
        if (pageTokens.size >= 16) return json(res, 429, { error: "Too many pending requests. Retry shortly." });
        const token2 = randomBytes(32).toString("base64url");
        pageTokens.set(token2, now + PAGE_TOKEN_TTL);
        headers(res, "text/html");
        res.setHeader(
          "Content-Security-Policy",
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
        );
        res.end(page(token2));
        return;
      }
      if (req.method !== "POST" || req.headers.origin !== controlOrigin || req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json" || req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin")
        return json(res, 403, { error: "Forbidden." });
      const token = req.headers["x-dsh-bridge-page-token"];
      if (typeof token !== "string" || (pageTokens.get(token) ?? 0) <= Date.now())
        return json(res, 403, { error: "Expired connection page. Reopen it from DSH Settings." });
      pageTokens.delete(token);
      let payload;
      try {
        payload = await readBody(req);
      } catch {
        return json(res, 400, { error: "Invalid connection request." });
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload))
        return json(res, 400, { error: "Invalid connection request." });
      const value = payload;
      if (value.remoteOrigin !== remoteOrigin)
        return json(res, 403, { error: "Remote DSH origin does not match this bridge." });
      let auth;
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
        await active.stop();
      }
      if (active) return json(res, 409, { error: "Another login is active. Finish it before trying again." });
      try {
        await begin(auth);
        json(res, 200, { authUrl: auth.url });
      } catch (error) {
        json(res, 503, {
          error: error instanceof Error && !error.message.includes("spawn") ? error.message : "The secure connection could not start. Check SSH/IAP access and retry."
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
    }
  };
}

// src/callback-bridge-bin.ts
var BRIDGE_LAUNCH_AGENT_LABEL = "io.dsh.claude-callback-bridge";
var AGENT_MARKER = "<!-- Managed by dsh-claude-bridge; schema=1 -->";
var XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';
var INSTALL_READY_TIMEOUT_MS = 5e3;
function safeGcpName(value) {
  return /^[a-z][a-z0-9-]{0,62}$/u.test(value);
}
function bridgeConfigurationId(config) {
  const target = config.target;
  const identity = target.kind === "browser" ? [config.remoteOrigin, target.kind] : target.kind === "ssh" ? [config.remoteOrigin, target.kind, target.host] : [config.remoteOrigin, target.kind, target.instance, target.project, target.zone ?? null];
  return createHash2("sha256").update(JSON.stringify(identity)).digest("hex");
}
function parseBridgeArguments(args) {
  if (args.length === 0 || args.length === 1 && (args[0] === "--help" || args[0] === "help")) {
    return { action: "help" };
  }
  const first = args[0];
  const action = first === "run" || first === "install" || first === "uninstall" ? first : "run";
  const options = action === first ? args.slice(1) : args;
  if (action === "uninstall") {
    if (options.length > 0) throw new Error("uninstall does not accept connection options");
    return { action };
  }
  if (options.length === 1 && options[0] === "--help") return { action: "help" };
  const allowed = /* @__PURE__ */ new Set(["--origin", "--ssh-host", "--gcp-instance", "--gcp-project", "--gcp-zone"]);
  const values = /* @__PURE__ */ new Map();
  for (let index = 0; index < options.length; index += 2) {
    const key = options[index];
    const value = options[index + 1];
    if (key === void 0 || !allowed.has(key)) throw new Error("unknown bridge option; use --help");
    if (values.has(key)) throw new Error("bridge options must not be repeated");
    if (value === void 0 || value.length === 0 || value.startsWith("--")) {
      throw new Error("each bridge option requires a value");
    }
    values.set(key, value);
  }
  const rawOrigin = values.get("--origin");
  let remoteOrigin;
  try {
    const origin = new URL(rawOrigin ?? "");
    if (origin.protocol !== "https:" || origin.username !== "" || origin.password !== "" || origin.pathname !== "/" || origin.search !== "" || origin.hash !== "") {
      throw new Error("invalid origin");
    }
    remoteOrigin = origin.origin;
  } catch {
    throw new Error("--origin must be an HTTPS origin without credentials, a path, query, or fragment");
  }
  const host = values.get("--ssh-host");
  const instance = values.get("--gcp-instance");
  const project = values.get("--gcp-project");
  const zone = values.get("--gcp-zone");
  const safeName = (value) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,252}$/u.test(value);
  let target;
  if (host === void 0 && instance === void 0 && project === void 0 && zone === void 0) {
    target = { kind: "browser" };
  } else if (host !== void 0) {
    if (instance !== void 0 || project !== void 0 || zone !== void 0) {
      throw new Error("choose either --ssh-host or the three GCP options");
    }
    if (!host.split("@").every(safeName) || host.split("@").length > 2) {
      throw new Error("--ssh-host must be an SSH alias or [user@]hostname");
    }
    target = { kind: "ssh", host };
  } else {
    if (instance === void 0 || project === void 0 || zone === void 0 && instance !== "auto") {
      throw new Error("provide --ssh-host or all of --gcp-instance, --gcp-project, and --gcp-zone");
    }
    if (![instance, project, ...zone === void 0 ? [] : [zone]].every(safeGcpName)) {
      throw new Error("GCP identifiers must be lowercase plain names starting with a letter");
    }
    if (instance === "auto") target = { kind: "gcp", instance, project, ...zone === void 0 ? {} : { zone } };
    else target = { kind: "gcp", instance, project, zone };
  }
  return { action, remoteOrigin, target };
}
function bridgeRunArguments(config) {
  if (config.target.kind === "browser") return ["run", "--origin", config.remoteOrigin];
  return [
    "run",
    "--origin",
    config.remoteOrigin,
    ...config.target.kind === "ssh" ? ["--ssh-host", config.target.host] : [
      "--gcp-instance",
      config.target.instance,
      "--gcp-project",
      config.target.project,
      ...config.target.zone === void 0 ? [] : ["--gcp-zone", config.target.zone]
    ]
  ];
}
function xmlEscape(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
function bridgeLaunchAgentPlist(config, nodeExecutable, binPath, executableSearchPath) {
  if (!nodeExecutable.startsWith("/") || !binPath.startsWith("/")) {
    throw new Error("LaunchAgent Node and CLI paths must be absolute");
  }
  const argumentsXml = [nodeExecutable, binPath, ...bridgeRunArguments(config)].map((argument) => `		<string>${xmlEscape(argument)}</string>`).join("\n");
  return `${XML_HEADER}
${AGENT_MARKER}
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${BRIDGE_LAUNCH_AGENT_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
${argumentsXml}
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>${xmlEscape(executableSearchPath)}</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>30</integer>
	<key>ProcessType</key>
	<string>Background</string>
</dict>
</plist>
`;
}
function ownedAgent(content) {
  return content.startsWith(`${XML_HEADER}
${AGENT_MARKER}
`) && content.includes(`<key>Label</key>
	<string>${BRIDGE_LAUNCH_AGENT_LABEL}</string>`);
}
function agentLocation(dependencies) {
  if (dependencies.platform !== "darwin" || dependencies.uid === void 0) {
    throw new Error("install and uninstall support per-user macOS LaunchAgents; use run on other systems");
  }
  const domain = `gui/${dependencies.uid}`;
  return {
    path: join(dependencies.home, "Library", "LaunchAgents", `${BRIDGE_LAUNCH_AGENT_LABEL}.plist`),
    domain,
    service: `${domain}/${BRIDGE_LAUNCH_AGENT_LABEL}`
  };
}
async function installBridge(config, dependencies) {
  const location = agentLocation(dependencies);
  const expected = bridgeLaunchAgentPlist(
    config,
    dependencies.nodeExecutable,
    dependencies.binPath,
    dependencies.executableSearchPath
  );
  const existing = await dependencies.readAgent(location.path);
  if (existing !== void 0 && (!ownedAgent(existing) || existing !== expected)) {
    throw new Error(
      "LaunchAgent already exists with different contents; inspect it and uninstall the owned bridge before changing its configuration"
    );
  }
  let loaded;
  try {
    const registrationStatus = await dependencies.launchctl(["print", location.service]);
    if (!Number.isInteger(registrationStatus) || registrationStatus < 0 || registrationStatus > 255) {
      throw new Error("Invalid registration response");
    }
    loaded = registrationStatus === 0;
  } catch {
    throw new Error("Could not verify the existing macOS bridge registration; installation left it unchanged");
  }
  if (existing === void 0 && loaded) {
    throw new Error(
      "The macOS bridge service is already registered without an owned LaunchAgent file; inspect that existing service before installing"
    );
  }
  if (existing === void 0) await dependencies.writeAgent(location.path, expected);
  else await dependencies.secureAgent(location.path);
  if (!loaded) {
    if (await dependencies.launchctl(["bootstrap", location.domain, location.path]) !== 0) {
      throw new Error("macOS could not load the bridge LaunchAgent; its owned file remains available for retry");
    }
  }
  if (await dependencies.launchctl(["kickstart", location.service]) !== 0) {
    throw new Error("macOS could not start the bridge LaunchAgent; retry install or use run");
  }
  await verifyInstalledBridge(config, dependencies);
  dependencies.stdout("Bridge installed for your macOS user and started. It starts again when you log in.\n");
}
async function verifyInstalledBridge(config, dependencies) {
  const configurationId = bridgeConfigurationId(config);
  const deadline = dependencies.now() + INSTALL_READY_TIMEOUT_MS;
  while (dependencies.now() < deadline) {
    let health;
    const timeoutMs = Math.min(500, deadline - dependencies.now());
    if (timeoutMs <= 0) break;
    try {
      health = await dependencies.probeHealth(timeoutMs);
    } catch {
    }
    if (dependencies.now() >= deadline) break;
    if (health !== void 0) {
      if (typeof health === "object" && health !== null && "service" in health && health.service === "dsh-claude-bridge" && "protocol" in health && health.protocol === 1 && "configurationId" in health && health.configurationId === configurationId) {
        return;
      }
      throw new Error(
        "The local bridge service does not match this installation. Run dsh-claude-bridge uninstall, then install the intended configuration again; stop any separate foreground helper first"
      );
    }
    const remaining = deadline - dependencies.now();
    if (remaining > 0) await dependencies.wait(Math.min(100, remaining));
  }
  throw new Error(
    "The installed bridge did not become ready within five seconds. Run dsh-claude-bridge uninstall, then install again; use run to diagnose startup and stop any separate foreground helper first"
  );
}
async function uninstallBridge(dependencies) {
  const location = agentLocation(dependencies);
  const existing = await dependencies.readAgent(location.path);
  if (existing === void 0) {
    dependencies.stdout("The bridge LaunchAgent is not installed.\n");
    return;
  }
  if (!ownedAgent(existing)) throw new Error("refusing to remove a LaunchAgent not owned by dsh-claude-bridge");
  if (await dependencies.launchctl(["print", location.service]) === 0) {
    if (await dependencies.launchctl(["bootout", location.service]) !== 0) {
      throw new Error("macOS could not stop the owned bridge; its LaunchAgent file was preserved");
    }
  }
  if (await dependencies.readAgent(location.path) !== existing) {
    throw new Error("LaunchAgent changed during uninstall; its file was preserved");
  }
  await dependencies.removeAgent(location.path);
  dependencies.stdout("Bridge uninstalled. Other LaunchAgents were left unchanged.\n");
}
async function resolveBridgeRunConfig(config, dependencies, signal) {
  signal?.throwIfAborted();
  const target = config.target;
  if (target.kind === "browser" || target.kind === "ssh") return { remoteOrigin: config.remoteOrigin, target };
  if (target.instance !== "auto") {
    if (target.zone === void 0) throw new Error("an explicit GCP instance requires --gcp-zone");
    return { remoteOrigin: config.remoteOrigin, target: { ...target, zone: target.zone } };
  }
  let account;
  let inventory;
  const exec = (args) => signal === void 0 ? dependencies.exec("gcloud", args) : dependencies.exec("gcloud", args, signal);
  try {
    account = (await exec(["config", "get-value", "account", "--quiet"])).trim();
    signal?.throwIfAborted();
    if (!/^[^\s@]+@[^\s@]+$/u.test(account)) throw new Error("no active account");
    inventory = JSON.parse(
      await exec([
        "compute",
        "instances",
        "list",
        "--project",
        target.project,
        "--filter=labels.workload=devbox",
        "--format=json(name,zone,status,metadata.items)",
        "--quiet"
      ])
    );
    signal?.throwIfAborted();
    if (!Array.isArray(inventory)) throw new Error("invalid inventory");
  } catch {
    signal?.throwIfAborted();
    throw new Error("GCP target discovery failed; authenticate gcloud, verify project access, then retry");
  }
  const owned = inventory.filter((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const metadata = entry["metadata"];
    if (typeof metadata !== "object" || metadata === null || !("items" in metadata) || !Array.isArray(metadata.items))
      return false;
    return metadata.items.some((item) => {
      if (typeof item !== "object" || item === null) return false;
      const value = item;
      return value["key"] === "owner-email" && typeof value["value"] === "string" && value["value"].toLowerCase() === account.toLowerCase();
    });
  });
  if (owned.length !== 1) {
    throw new Error("No uniquely owned devbox found; verify project access or specify --gcp-instance and --gcp-zone");
  }
  const selected = owned[0];
  if (selected["status"] !== "RUNNING")
    throw new Error("The owned devbox is not running; start it before retrying sign-in");
  const instance = selected["name"];
  const zone = typeof selected["zone"] === "string" ? selected["zone"].split("/").at(-1) : void 0;
  if (typeof instance !== "string" || !safeGcpName(instance) || zone === void 0 || !safeGcpName(zone)) {
    throw new Error("GCP target discovery returned an invalid instance; specify an explicit instance and zone");
  }
  if (target.zone !== void 0 && target.zone !== zone)
    throw new Error("The owned devbox is in another zone; omit --gcp-zone for automatic discovery");
  return { remoteOrigin: config.remoteOrigin, target: { kind: "gcp", instance, project: target.project, zone } };
}
async function runBridge(config, dependencies) {
  const cancellation = new AbortController();
  const cancelled = /* @__PURE__ */ Symbol("cancelled");
  let stop = () => {
  };
  const stopped = new Promise((resolve) => {
    stop = () => {
      cancellation.abort();
      resolve(cancelled);
    };
  });
  dependencies.onSignal("SIGINT", stop);
  dependencies.onSignal("SIGTERM", stop);
  try {
    const resolved = await Promise.race([resolveBridgeRunConfig(config, dependencies, cancellation.signal), stopped]);
    if (resolved === cancelled || cancellation.signal.aborted) return;
    const starting = dependencies.start({
      ...resolved,
      configurationId: bridgeConfigurationId(config)
    });
    const bridge = await Promise.race([starting, stopped]);
    if (bridge === cancelled || cancellation.signal.aborted) {
      void starting.then((lateBridge) => lateBridge.close()).catch(() => {
      });
      return;
    }
    try {
      dependencies.stdout(
        `Claude callback bridge ready: ${bridge.url}
Keep this process running while you sign in.
`
      );
      await stopped;
    } finally {
      await bridge.close();
    }
  } catch (error) {
    if (!cancellation.signal.aborted) throw error;
  } finally {
    dependencies.removeSignal("SIGINT", stop);
    dependencies.removeSignal("SIGTERM", stop);
  }
}
var HELP = `Usage: dsh-claude-bridge [run|install] --origin https://example.com
       dsh-claude-bridge [run|install] --origin https://example.com --ssh-host SSH_ALIAS
       dsh-claude-bridge [run|install] --origin https://example.com --gcp-instance INSTANCE --gcp-project PROJECT --gcp-zone ZONE
       dsh-claude-bridge [run|install] --origin https://example.com --gcp-instance auto --gcp-project PROJECT
       dsh-claude-bridge uninstall

The default browser-return mode needs no SSH or Google Cloud access.
run starts the local bridge until Ctrl+C; install starts it now and at macOS login.
Optional SSH/GCP forwarding must connect to the same remote machine that runs DSH.
Automatic GCP discovery selects exactly one devbox owned by the active gcloud account.
The bridge does not log in to GCP, change IAM, or store Claude tokens.
`;
async function runCallbackBridgeCli(args, dependencies) {
  try {
    const command = parseBridgeArguments(args);
    if (command.action === "help") dependencies.stdout(HELP);
    else if (command.action === "uninstall") await uninstallBridge(dependencies);
    else if (command.action === "install") await installBridge(command, dependencies);
    else await runBridge(command, dependencies);
    return 0;
  } catch (error) {
    dependencies.stderr(`Bridge: ${error instanceof Error ? error.message : "operation failed"}
`);
    return 1;
  }
}
function defaultBridgeCliDependencies() {
  return {
    platform: process.platform,
    home: homedir(),
    nodeExecutable: process.execPath,
    binPath: realpathSync(fileURLToPath(import.meta.url)),
    executableSearchPath: process.env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    uid: process.getuid?.(),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    start: startCallbackBridge,
    onSignal: (signal, handler) => process.on(signal, handler),
    removeSignal: (signal, handler) => process.removeListener(signal, handler),
    readAgent: async (path) => {
      let info;
      try {
        info = await lstat(path);
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return void 0;
        throw error;
      }
      if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) {
        throw new Error("refusing to read an unsafe bridge LaunchAgent file");
      }
      return readFile(path, "utf8");
    },
    writeAgent: async (path, content) => {
      await mkdir(dirname(path), { recursive: true, mode: 448 });
      const file = await open(path, "wx", 384);
      try {
        await file.writeFile(content, "utf8");
      } finally {
        await file.close();
      }
    },
    secureAgent: (path) => chmod(path, 384),
    removeAgent: (path) => unlink(path),
    probeHealth: (timeoutMs) => new Promise((resolve) => {
      let completed = false;
      const finish = (health) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        resolve(health);
      };
      const probe = request2(
        {
          hostname: "127.0.0.1",
          port: 53700,
          path: "/health",
          method: "GET",
          headers: { accept: "application/json" }
        },
        (response) => {
          let bytes = 0;
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            bytes += Buffer.byteLength(chunk);
            if (bytes > 4096) {
              finish(null);
              probe.destroy();
            } else body += chunk;
          });
          response.once("error", () => finish());
          response.once("end", () => {
            try {
              finish(response.statusCode === 200 ? JSON.parse(body) : null);
            } catch {
              finish(null);
            }
          });
        }
      );
      const timer = setTimeout(() => {
        finish();
        probe.destroy();
      }, timeoutMs);
      probe.once("error", () => finish());
      probe.end();
    }),
    wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now: () => performance.now(),
    launchctl: (args) => new Promise((resolve, reject) => {
      const child = spawn2("/bin/launchctl", args, { stdio: "ignore", shell: false });
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    }),
    exec: (command, args, signal) => new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("GCP discovery was cancelled"));
        return;
      }
      const ownsGroup = process.platform !== "win32";
      const child = spawn2(command, args, {
        stdio: ["ignore", "pipe", "ignore"],
        shell: false,
        detached: ownsGroup
      });
      let output = "";
      let completed = false;
      let abortKillTimer;
      const signalChild = (value) => {
        if (!ownsGroup || child.pid === void 0) return value === 0 ? false : child.kill(value);
        try {
          process.kill(-child.pid, value);
          return true;
        } catch {
          return false;
        }
      };
      const finish = (error) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (error === void 0) resolve(output);
        else reject(error);
      };
      const onAbort = () => {
        if (completed) return;
        if (signalChild("SIGTERM")) {
          abortKillTimer = setTimeout(() => signalChild("SIGKILL"), 1e3);
        }
        finish(new Error("GCP discovery was cancelled"));
      };
      const timer = setTimeout(() => {
        signalChild("SIGKILL");
        finish(new Error("GCP discovery timed out"));
      }, 3e4);
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        output += chunk;
        if (output.length > 1048576) {
          signalChild("SIGKILL");
          finish(new Error("GCP discovery response was too large"));
        }
      });
      child.once("error", () => finish(new Error("GCP discovery command could not start")));
      child.once("close", (code) => {
        if (!ownsGroup || !signalChild(0)) clearTimeout(abortKillTimer);
        finish(code === 0 ? void 0 : new Error("GCP discovery command failed"));
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    })
  };
}
function isDirectExecution() {
  try {
    return process.argv[1] !== void 0 && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isDirectExecution()) {
  process.exitCode = await runCallbackBridgeCli(process.argv.slice(2), defaultBridgeCliDependencies());
}
export {
  BRIDGE_LAUNCH_AGENT_LABEL,
  bridgeConfigurationId,
  bridgeLaunchAgentPlist,
  bridgeRunArguments,
  defaultBridgeCliDependencies,
  parseBridgeArguments,
  resolveBridgeRunConfig,
  runCallbackBridgeCli
};
