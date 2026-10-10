#!/usr/bin/env node
/** Local Claude callback bridge CLI; this entry has no DSH runtime dependencies. */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { request } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BridgeTarget, startCallbackBridge } from "./callback-bridge.ts";

export const BRIDGE_LAUNCH_AGENT_LABEL = "io.dsh.claude-callback-bridge";
const AGENT_MARKER = "<!-- Managed by dsh-claude-bridge; schema=1 -->";
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';
const INSTALL_READY_TIMEOUT_MS = 5_000;

function safeGcpName(value: string): boolean {
	return /^[a-z][a-z0-9-]{0,62}$/u.test(value);
}

export interface BridgeRunConfig {
	remoteOrigin: string;
	target: BridgeTarget;
	configurationId?: string;
}

export interface BridgeCliConfig {
	remoteOrigin: string;
	target: BridgeTarget | { kind: "gcp"; instance: "auto"; project: string; zone?: string };
}

export type BridgeCliCommand =
	| { action: "help" }
	| { action: "uninstall" }
	| ({ action: "run" | "install" } & BridgeCliConfig);

export interface BridgeCliDependencies {
	platform: NodeJS.Platform;
	home: string;
	nodeExecutable: string;
	binPath: string;
	executableSearchPath: string;
	uid: number | undefined;
	stdout(text: string): void;
	stderr(text: string): void;
	start(config: BridgeRunConfig): Promise<{ url: string; close(): Promise<void> }>;
	onSignal(signal: "SIGINT" | "SIGTERM", handler: () => void): void;
	removeSignal(signal: "SIGINT" | "SIGTERM", handler: () => void): void;
	readAgent(path: string): Promise<string | undefined>;
	writeAgent(path: string, content: string): Promise<void>;
	secureAgent(path: string): Promise<void>;
	removeAgent(path: string): Promise<void>;
	launchctl(args: string[]): Promise<number>;
	exec(command: string, args: string[], signal?: AbortSignal): Promise<string>;
	probeHealth(timeoutMs: number): Promise<unknown>;
	wait(milliseconds: number): Promise<void>;
	now(): number;
}

/** Fingerprint the original configured transport, including unresolved automatic targets. */
export function bridgeConfigurationId(config: BridgeCliConfig): string {
	const target = config.target;
	const identity =
		target.kind === "browser"
			? [config.remoteOrigin, target.kind]
			: target.kind === "ssh"
				? [config.remoteOrigin, target.kind, target.host]
				: [config.remoteOrigin, target.kind, target.instance, target.project, target.zone ?? null];
	return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export function parseBridgeArguments(args: readonly string[]): BridgeCliCommand {
	if (args.length === 0 || (args.length === 1 && (args[0] === "--help" || args[0] === "help"))) {
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
	const allowed = new Set(["--origin", "--ssh-host", "--gcp-instance", "--gcp-project", "--gcp-zone"]);
	const values = new Map<string, string>();
	for (let index = 0; index < options.length; index += 2) {
		const key = options[index];
		const value = options[index + 1];
		if (key === undefined || !allowed.has(key)) throw new Error("unknown bridge option; use --help");
		if (values.has(key)) throw new Error("bridge options must not be repeated");
		if (value === undefined || value.length === 0 || value.startsWith("--")) {
			throw new Error("each bridge option requires a value");
		}
		values.set(key, value);
	}
	const rawOrigin = values.get("--origin");
	let remoteOrigin: string;
	try {
		const origin = new URL(rawOrigin ?? "");
		if (
			origin.protocol !== "https:" ||
			origin.username !== "" ||
			origin.password !== "" ||
			origin.pathname !== "/" ||
			origin.search !== "" ||
			origin.hash !== ""
		) {
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
	const safeName = (value: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,252}$/u.test(value);
	let target: BridgeCliConfig["target"];
	if (host === undefined && instance === undefined && project === undefined && zone === undefined) {
		target = { kind: "browser" };
	} else if (host !== undefined) {
		if (instance !== undefined || project !== undefined || zone !== undefined) {
			throw new Error("choose either --ssh-host or the three GCP options");
		}
		if (!host.split("@").every(safeName) || host.split("@").length > 2) {
			throw new Error("--ssh-host must be an SSH alias or [user@]hostname");
		}
		target = { kind: "ssh", host };
	} else {
		if (instance === undefined || project === undefined || (zone === undefined && instance !== "auto")) {
			throw new Error("provide --ssh-host or all of --gcp-instance, --gcp-project, and --gcp-zone");
		}
		if (![instance, project, ...(zone === undefined ? [] : [zone])].every(safeGcpName)) {
			throw new Error("GCP identifiers must be lowercase plain names starting with a letter");
		}
		if (instance === "auto") target = { kind: "gcp", instance, project, ...(zone === undefined ? {} : { zone }) };
		else target = { kind: "gcp", instance, project, zone: zone! };
	}
	return { action, remoteOrigin, target };
}

export function bridgeRunArguments(config: BridgeCliConfig): string[] {
	if (config.target.kind === "browser") return ["run", "--origin", config.remoteOrigin];
	return [
		"run",
		"--origin",
		config.remoteOrigin,
		...(config.target.kind === "ssh"
			? ["--ssh-host", config.target.host]
			: [
					"--gcp-instance",
					config.target.instance,
					"--gcp-project",
					config.target.project,
					...(config.target.zone === undefined ? [] : ["--gcp-zone", config.target.zone]),
				]),
	];
}

function xmlEscape(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

export function bridgeLaunchAgentPlist(
	config: BridgeCliConfig,
	nodeExecutable: string,
	binPath: string,
	executableSearchPath: string,
): string {
	if (!nodeExecutable.startsWith("/") || !binPath.startsWith("/")) {
		throw new Error("LaunchAgent Node and CLI paths must be absolute");
	}
	const argumentsXml = [nodeExecutable, binPath, ...bridgeRunArguments(config)]
		.map((argument) => `\t\t<string>${xmlEscape(argument)}</string>`)
		.join("\n");
	return `${XML_HEADER}\n${AGENT_MARKER}\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n\t<key>Label</key>\n\t<string>${BRIDGE_LAUNCH_AGENT_LABEL}</string>\n\t<key>ProgramArguments</key>\n\t<array>\n${argumentsXml}\n\t</array>\n\t<key>EnvironmentVariables</key>\n\t<dict>\n\t\t<key>PATH</key>\n\t\t<string>${xmlEscape(executableSearchPath)}</string>\n\t</dict>\n\t<key>RunAtLoad</key>\n\t<true/>\n\t<key>KeepAlive</key>\n\t<true/>\n\t<key>ThrottleInterval</key>\n\t<integer>30</integer>\n\t<key>ProcessType</key>\n\t<string>Background</string>\n</dict>\n</plist>\n`;
}

function ownedAgent(content: string): boolean {
	return (
		content.startsWith(`${XML_HEADER}\n${AGENT_MARKER}\n`) &&
		content.includes(`<key>Label</key>\n\t<string>${BRIDGE_LAUNCH_AGENT_LABEL}</string>`)
	);
}

function agentLocation(dependencies: BridgeCliDependencies): { path: string; domain: string; service: string } {
	if (dependencies.platform !== "darwin" || dependencies.uid === undefined) {
		throw new Error("install and uninstall support per-user macOS LaunchAgents; use run on other systems");
	}
	const domain = `gui/${dependencies.uid}`;
	return {
		path: join(dependencies.home, "Library", "LaunchAgents", `${BRIDGE_LAUNCH_AGENT_LABEL}.plist`),
		domain,
		service: `${domain}/${BRIDGE_LAUNCH_AGENT_LABEL}`,
	};
}

async function installBridge(config: BridgeCliConfig, dependencies: BridgeCliDependencies): Promise<void> {
	const location = agentLocation(dependencies);
	const expected = bridgeLaunchAgentPlist(
		config,
		dependencies.nodeExecutable,
		dependencies.binPath,
		dependencies.executableSearchPath,
	);
	const existing = await dependencies.readAgent(location.path);
	if (existing !== undefined && (!ownedAgent(existing) || existing !== expected)) {
		throw new Error(
			"LaunchAgent already exists with different contents; inspect it and uninstall the owned bridge before changing its configuration",
		);
	}
	let loaded: boolean;
	try {
		const registrationStatus = await dependencies.launchctl(["print", location.service]);
		if (!Number.isInteger(registrationStatus) || registrationStatus < 0 || registrationStatus > 255) {
			throw new Error("Invalid registration response");
		}
		loaded = registrationStatus === 0;
	} catch {
		throw new Error("Could not verify the existing macOS bridge registration; installation left it unchanged");
	}
	if (existing === undefined && loaded) {
		throw new Error(
			"The macOS bridge service is already registered without an owned LaunchAgent file; inspect that existing service before installing",
		);
	}
	if (existing === undefined) await dependencies.writeAgent(location.path, expected);
	else await dependencies.secureAgent(location.path);
	if (!loaded) {
		if ((await dependencies.launchctl(["bootstrap", location.domain, location.path])) !== 0) {
			throw new Error("macOS could not load the bridge LaunchAgent; its owned file remains available for retry");
		}
	}
	if ((await dependencies.launchctl(["kickstart", location.service])) !== 0) {
		throw new Error("macOS could not start the bridge LaunchAgent; retry install or use run");
	}
	await verifyInstalledBridge(config, dependencies);
	dependencies.stdout("Bridge installed for your macOS user and started. It starts again when you log in.\n");
}

async function verifyInstalledBridge(config: BridgeCliConfig, dependencies: BridgeCliDependencies): Promise<void> {
	const configurationId = bridgeConfigurationId(config);
	const deadline = dependencies.now() + INSTALL_READY_TIMEOUT_MS;
	while (dependencies.now() < deadline) {
		let health: unknown;
		const timeoutMs = Math.min(500, deadline - dependencies.now());
		if (timeoutMs <= 0) break;
		try {
			health = await dependencies.probeHealth(timeoutMs);
		} catch {
			// Startup and connection errors must not expose private configuration or response contents.
		}
		if (dependencies.now() >= deadline) break;
		if (health !== undefined) {
			if (
				typeof health === "object" &&
				health !== null &&
				"service" in health &&
				health.service === "dsh-claude-bridge" &&
				"protocol" in health &&
				health.protocol === 1 &&
				"configurationId" in health &&
				health.configurationId === configurationId
			) {
				return;
			}
			throw new Error(
				"The local bridge service does not match this installation. Run dsh-claude-bridge uninstall, then install the intended configuration again; stop any separate foreground helper first",
			);
		}
		const remaining = deadline - dependencies.now();
		if (remaining > 0) await dependencies.wait(Math.min(100, remaining));
	}
	throw new Error(
		"The installed bridge did not become ready within five seconds. Run dsh-claude-bridge uninstall, then install again; use run to diagnose startup and stop any separate foreground helper first",
	);
}

async function uninstallBridge(dependencies: BridgeCliDependencies): Promise<void> {
	const location = agentLocation(dependencies);
	const existing = await dependencies.readAgent(location.path);
	if (existing === undefined) {
		dependencies.stdout("The bridge LaunchAgent is not installed.\n");
		return;
	}
	if (!ownedAgent(existing)) throw new Error("refusing to remove a LaunchAgent not owned by dsh-claude-bridge");
	if ((await dependencies.launchctl(["print", location.service])) === 0) {
		if ((await dependencies.launchctl(["bootout", location.service])) !== 0) {
			throw new Error("macOS could not stop the owned bridge; its LaunchAgent file was preserved");
		}
	}
	if ((await dependencies.readAgent(location.path)) !== existing) {
		throw new Error("LaunchAgent changed during uninstall; its file was preserved");
	}
	await dependencies.removeAgent(location.path);
	dependencies.stdout("Bridge uninstalled. Other LaunchAgents were left unchanged.\n");
}

/** Discover one account-owned devbox without switching accounts or exposing instance metadata. */
export async function resolveBridgeRunConfig(
	config: BridgeCliConfig,
	dependencies: Pick<BridgeCliDependencies, "exec">,
	signal?: AbortSignal,
): Promise<BridgeRunConfig> {
	signal?.throwIfAborted();
	const target = config.target;
	if (target.kind === "browser" || target.kind === "ssh") return { remoteOrigin: config.remoteOrigin, target };
	if (target.instance !== "auto") {
		if (target.zone === undefined) throw new Error("an explicit GCP instance requires --gcp-zone");
		return { remoteOrigin: config.remoteOrigin, target: { ...target, zone: target.zone } };
	}
	let account: string;
	let inventory: unknown;
	const exec = (args: string[]): Promise<string> =>
		signal === undefined ? dependencies.exec("gcloud", args) : dependencies.exec("gcloud", args, signal);
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
				"--quiet",
			]),
		);
		signal?.throwIfAborted();
		if (!Array.isArray(inventory)) throw new Error("invalid inventory");
	} catch {
		signal?.throwIfAborted();
		throw new Error("GCP target discovery failed; authenticate gcloud, verify project access, then retry");
	}
	const owned = (inventory as unknown[]).filter((entry): entry is Record<string, unknown> => {
		if (typeof entry !== "object" || entry === null) return false;
		const metadata = (entry as Record<string, unknown>)["metadata"];
		if (typeof metadata !== "object" || metadata === null || !("items" in metadata) || !Array.isArray(metadata.items))
			return false;
		return metadata.items.some((item: unknown) => {
			if (typeof item !== "object" || item === null) return false;
			const value = item as Record<string, unknown>;
			return (
				value["key"] === "owner-email" &&
				typeof value["value"] === "string" &&
				value["value"].toLowerCase() === account.toLowerCase()
			);
		});
	});
	if (owned.length !== 1) {
		throw new Error("No uniquely owned devbox found; verify project access or specify --gcp-instance and --gcp-zone");
	}
	const selected = owned[0]!;
	if (selected["status"] !== "RUNNING")
		throw new Error("The owned devbox is not running; start it before retrying sign-in");
	const instance = selected["name"];
	const zone = typeof selected["zone"] === "string" ? selected["zone"].split("/").at(-1) : undefined;
	if (typeof instance !== "string" || !safeGcpName(instance) || zone === undefined || !safeGcpName(zone)) {
		throw new Error("GCP target discovery returned an invalid instance; specify an explicit instance and zone");
	}
	if (target.zone !== undefined && target.zone !== zone)
		throw new Error("The owned devbox is in another zone; omit --gcp-zone for automatic discovery");
	return { remoteOrigin: config.remoteOrigin, target: { kind: "gcp", instance, project: target.project, zone } };
}

async function runBridge(config: BridgeCliConfig, dependencies: BridgeCliDependencies): Promise<void> {
	const cancellation = new AbortController();
	const cancelled = Symbol("cancelled");
	let stop: () => void = () => {};
	const stopped = new Promise<typeof cancelled>((resolve) => {
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
			configurationId: bridgeConfigurationId(config),
		});
		const bridge = await Promise.race([starting, stopped]);
		if (bridge === cancelled || cancellation.signal.aborted) {
			// Observe a non-cooperative startup and close only the bridge it eventually returns.
			void starting.then((lateBridge) => lateBridge.close()).catch(() => {});
			return;
		}
		try {
			dependencies.stdout(
				`Claude callback bridge ready: ${bridge.url}\nKeep this process running while you sign in.\n`,
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

const HELP = `Usage: dsh-claude-bridge [run|install] --origin https://example.com\n       dsh-claude-bridge [run|install] --origin https://example.com --ssh-host SSH_ALIAS\n       dsh-claude-bridge [run|install] --origin https://example.com --gcp-instance INSTANCE --gcp-project PROJECT --gcp-zone ZONE\n       dsh-claude-bridge [run|install] --origin https://example.com --gcp-instance auto --gcp-project PROJECT\n       dsh-claude-bridge uninstall\n\nThe default browser-return mode needs no SSH or Google Cloud access.\nrun starts the local bridge until Ctrl+C; install starts it now and at macOS login.\nOptional SSH/GCP forwarding must connect to the same remote machine that runs DSH.\nAutomatic GCP discovery selects exactly one devbox owned by the active gcloud account.\nThe bridge does not log in to GCP, change IAM, or store Claude tokens.\n`;

export async function runCallbackBridgeCli(
	args: readonly string[],
	dependencies: BridgeCliDependencies,
): Promise<number> {
	try {
		const command = parseBridgeArguments(args);
		if (command.action === "help") dependencies.stdout(HELP);
		else if (command.action === "uninstall") await uninstallBridge(dependencies);
		else if (command.action === "install") await installBridge(command, dependencies);
		else await runBridge(command, dependencies);
		return 0;
	} catch (error: unknown) {
		dependencies.stderr(`Bridge: ${error instanceof Error ? error.message : "operation failed"}\n`);
		return 1;
	}
}

export function defaultBridgeCliDependencies(): BridgeCliDependencies {
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
			let info: Awaited<ReturnType<typeof lstat>>;
			try {
				info = await lstat(path);
			} catch (error: unknown) {
				if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
				throw error;
			}
			if (!info.isFile() || info.isSymbolicLink() || info.size > 65_536) {
				throw new Error("refusing to read an unsafe bridge LaunchAgent file");
			}
			return readFile(path, "utf8");
		},
		writeAgent: async (path, content) => {
			await mkdir(dirname(path), { recursive: true, mode: 0o700 });
			const file = await open(path, "wx", 0o600);
			try {
				await file.writeFile(content, "utf8");
			} finally {
				await file.close();
			}
		},
		secureAgent: (path) => chmod(path, 0o600),
		removeAgent: (path) => unlink(path),
		probeHealth: (timeoutMs) =>
			new Promise<unknown>((resolve) => {
				let completed = false;
				const finish = (health?: unknown): void => {
					if (completed) return;
					completed = true;
					clearTimeout(timer);
					resolve(health);
				};
				const probe = request(
					{
						hostname: "127.0.0.1",
						port: 53700,
						path: "/health",
						method: "GET",
						headers: { accept: "application/json" },
					},
					(response) => {
						let bytes = 0;
						let body = "";
						response.setEncoding("utf8");
						response.on("data", (chunk: string) => {
							bytes += Buffer.byteLength(chunk);
							if (bytes > 4096) {
								finish(null);
								probe.destroy();
							} else body += chunk;
						});
						response.once("error", () => finish());
						response.once("end", () => {
							try {
								finish(response.statusCode === 200 ? (JSON.parse(body) as unknown) : null);
							} catch {
								finish(null);
							}
						});
					},
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
		launchctl: (args) =>
			new Promise<number>((resolve, reject) => {
				const child = spawn("/bin/launchctl", args, { stdio: "ignore", shell: false });
				child.once("error", reject);
				child.once("exit", (code) => resolve(code ?? 1));
			}),
		exec: (command, args, signal) =>
			new Promise<string>((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("GCP discovery was cancelled"));
					return;
				}
				const ownsGroup = process.platform !== "win32";
				const child = spawn(command, args, {
					stdio: ["ignore", "pipe", "ignore"],
					shell: false,
					detached: ownsGroup,
				});
				let output = "";
				let completed = false;
				let abortKillTimer: ReturnType<typeof setTimeout> | undefined;
				const signalChild = (value: NodeJS.Signals | 0): boolean => {
					if (!ownsGroup || child.pid === undefined) return value === 0 ? false : child.kill(value);
					try {
						process.kill(-child.pid, value);
						return true;
					} catch {
						return false;
					}
				};
				const finish = (error?: Error): void => {
					if (completed) return;
					completed = true;
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					if (error === undefined) resolve(output);
					else reject(error);
				};
				const onAbort = (): void => {
					if (completed) return;
					if (signalChild("SIGTERM")) {
						abortKillTimer = setTimeout(() => signalChild("SIGKILL"), 1000);
					}
					finish(new Error("GCP discovery was cancelled"));
				};
				const timer = setTimeout(() => {
					signalChild("SIGKILL");
					finish(new Error("GCP discovery timed out"));
				}, 30_000);
				child.stdout?.setEncoding("utf8");
				child.stdout?.on("data", (chunk: string) => {
					output += chunk;
					if (output.length > 1_048_576) {
						signalChild("SIGKILL");
						finish(new Error("GCP discovery response was too large"));
					}
				});
				child.once("error", () => finish(new Error("GCP discovery command could not start")));
				child.once("close", (code) => {
					if (!ownsGroup || !signalChild(0)) clearTimeout(abortKillTimer);
					finish(code === 0 ? undefined : new Error("GCP discovery command failed"));
				});
				signal?.addEventListener("abort", onAbort, { once: true });
				if (signal?.aborted) onAbort();
			}),
	};
}

function isDirectExecution(): boolean {
	try {
		return (
			process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
		);
	} catch {
		return false;
	}
}

if (isDirectExecution()) {
	process.exitCode = await runCallbackBridgeCli(process.argv.slice(2), defaultBridgeCliDependencies());
}
