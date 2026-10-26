import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	BRIDGE_LAUNCH_AGENT_LABEL,
	type BridgeCliConfig,
	type BridgeCliDependencies,
	bridgeConfigurationId,
	bridgeLaunchAgentPlist,
	defaultBridgeCliDependencies,
	parseBridgeArguments,
	resolveBridgeRunConfig,
	runCallbackBridgeCli,
} from "../src/callback-bridge-bin.ts";

const SSH_ARGS = ["--origin", "https://example.com", "--ssh-host", "dsh-example"];
const CONFIG = { remoteOrigin: "https://example.com", target: { kind: "ssh" as const, host: "dsh-example" } };
const BROWSER_CONFIG = { remoteOrigin: "https://example.com", target: { kind: "browser" as const } };

function fixture(config: BridgeCliConfig = CONFIG) {
	const files = new Map<string, string>();
	const signals = new Map<string, () => void>();
	const close = vi.fn(async () => {});
	let elapsed = 0;
	const dependencies: BridgeCliDependencies = {
		platform: "darwin",
		home: "/example-home",
		nodeExecutable: "/example-bin/node",
		binPath: "/example-package/lib/callback-bridge-bin.js",
		executableSearchPath: "/example-bin:/usr/bin:/bin",
		uid: 501,
		stdout: vi.fn(),
		stderr: vi.fn(),
		start: vi.fn(async () => ({ url: "http://127.0.0.1:53700/start", close })),
		onSignal: vi.fn((signal, handler) => {
			signals.set(signal, handler);
		}),
		removeSignal: vi.fn((signal) => {
			signals.delete(signal);
		}),
		readAgent: vi.fn(async (path) => files.get(path)),
		writeAgent: vi.fn(async (path, contents) => {
			if (files.has(path)) throw new Error("already exists");
			files.set(path, contents);
		}),
		secureAgent: vi.fn(async () => {}),
		removeAgent: vi.fn(async (path) => {
			files.delete(path);
		}),
		launchctl: vi.fn(async (args) => (args[0] === "print" ? 1 : 0)),
		exec: vi.fn(async () => {
			throw new Error("unexpected command");
		}),
		probeHealth: vi.fn(async () => ({
			service: "dsh-claude-bridge",
			protocol: 1,
			configurationId: bridgeConfigurationId(config),
		})),
		wait: vi.fn(async (milliseconds) => {
			elapsed += milliseconds;
		}),
		now: () => elapsed,
	};
	return {
		dependencies,
		files,
		signals,
		close,
		advance: (milliseconds: number) => {
			elapsed += milliseconds;
		},
		path: `/example-home/Library/LaunchAgents/${BRIDGE_LAUNCH_AGENT_LABEL}.plist`,
	};
}

describe("callback bridge arguments", () => {
	it("defaults an origin-only command to browser return without a cloud transport", () => {
		expect(parseBridgeArguments(["--origin", "https://example.com"])).toEqual({
			action: "run",
			remoteOrigin: "https://example.com",
			target: { kind: "browser" },
		});
		expect(parseBridgeArguments(["install", "--origin", "https://example.com"])).toEqual({
			action: "install",
			remoteOrigin: "https://example.com",
			target: { kind: "browser" },
		});
	});

	it("accepts an SSH profile and canonical HTTPS origin", () => {
		expect(parseBridgeArguments(["run", "--origin", "https://EXAMPLE.com/", "--ssh-host", "user@dsh-example"])).toEqual(
			{ action: "run", remoteOrigin: "https://example.com", target: { kind: "ssh", host: "user@dsh-example" } },
		);
		expect(parseBridgeArguments(SSH_ARGS)).toEqual({ action: "run", ...CONFIG });
	});

	it("accepts a complete GCP target without allowing mixed transports", () => {
		expect(
			parseBridgeArguments([
				"install",
				"--origin",
				"https://example.com",
				"--gcp-instance",
				"example-vm",
				"--gcp-project",
				"example-project",
				"--gcp-zone",
				"us-central1-a",
			]),
		).toEqual({
			action: "install",
			remoteOrigin: "https://example.com",
			target: { kind: "gcp", instance: "example-vm", project: "example-project", zone: "us-central1-a" },
		});
		expect(() => parseBridgeArguments([...SSH_ARGS, "--gcp-instance", "example-vm"])).toThrow("either");
	});

	it.each([
		["--origin", "http://example.com", "--ssh-host", "dsh-example"],
		["--origin", "https://user:password@example.com", "--ssh-host", "dsh-example"],
		["--origin", "https://example.com/path", "--ssh-host", "dsh-example"],
		["--origin", "https://example.com?code=example", "--ssh-host", "dsh-example"],
		["--origin", "https://example.com#example", "--ssh-host", "dsh-example"],
		[...SSH_ARGS, "--ssh-host", "another-host"],
		[...SSH_ARGS, "--arbitrary-option", "example"],
		["--origin", "https://example.com", "--ssh-host", "-oProxyCommand=example"],
		["--origin", "https://example.com", "--ssh-host", "host;example"],
		["--origin", "https://example.com", "--gcp-instance", "example-vm"],
		["--origin", "https://example.com", "--gcp-project", "example-project"],
		["--origin", "https://example.com", "--gcp-zone", "us-central1-a"],
		["uninstall", ...SSH_ARGS],
	])("rejects unsafe or incomplete input %j", (...args) => {
		expect(() => parseBridgeArguments(args)).toThrow();
	});

	it("prints help without starting a bridge or installing anything", async () => {
		const { dependencies } = fixture();
		expect(await runCallbackBridgeCli(["--help"], dependencies)).toBe(0);
		expect(dependencies.stdout).toHaveBeenCalledWith(expect.stringContaining("dsh-claude-bridge"));
		expect(dependencies.start).not.toHaveBeenCalled();
		expect(dependencies.writeAgent).not.toHaveBeenCalled();
	});
});

describe("callback bridge process lifecycle", () => {
	it("starts browser-return mode without executing SSH or GCP discovery", async () => {
		const { dependencies, signals, close } = fixture();
		const running = runCallbackBridgeCli(["run", "--origin", "https://example.com"], dependencies);
		await vi.waitFor(() => expect(dependencies.start).toHaveBeenCalled());
		expect(dependencies.start).toHaveBeenCalledWith({
			...BROWSER_CONFIG,
			configurationId: bridgeConfigurationId(BROWSER_CONFIG),
		});
		expect(dependencies.exec).not.toHaveBeenCalled();
		signals.get("SIGTERM")?.();
		expect(await running).toBe(0);
		expect(close).toHaveBeenCalledTimes(1);
	});

	it.each(["SIGINT", "SIGTERM"] as const)("closes its bridge once on %s and removes both handlers", async (signal) => {
		const { dependencies, signals, close } = fixture();
		const running = runCallbackBridgeCli(SSH_ARGS, dependencies);
		await vi.waitFor(() => expect(dependencies.stdout).toHaveBeenCalled());
		expect(dependencies.start).toHaveBeenCalledWith({ ...CONFIG, configurationId: bridgeConfigurationId(CONFIG) });
		signals.get(signal)?.();
		signals.get(signal)?.();
		expect(await running).toBe(0);
		expect(close).toHaveBeenCalledTimes(1);
		expect(signals.size).toBe(0);
	});

	it("remembers a shutdown signal received during startup", async () => {
		const { dependencies, signals, close } = fixture();
		let ready: ((value: { url: string; close(): Promise<void> }) => void) | undefined;
		dependencies.start = vi.fn(
			() =>
				new Promise<{ url: string; close(): Promise<void> }>((resolve) => {
					ready = resolve;
				}),
		);
		const running = runCallbackBridgeCli(SSH_ARGS, dependencies);
		await vi.waitFor(() => expect(dependencies.start).toHaveBeenCalled());
		signals.get("SIGTERM")?.();
		ready?.({ url: "http://127.0.0.1:53700/start", close });
		expect(await running).toBe(0);
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("returns promptly when startup ignores cancellation and closes its late bridge without claiming readiness", async () => {
		const { dependencies, signals, close } = fixture();
		let ready: ((value: { url: string; close(): Promise<void> }) => void) | undefined;
		dependencies.start = vi.fn(
			() =>
				new Promise<{ url: string; close(): Promise<void> }>((resolve) => {
					ready = resolve;
				}),
		);
		const running = runCallbackBridgeCli(SSH_ARGS, dependencies);
		await vi.waitFor(() => expect(dependencies.start).toHaveBeenCalled());
		signals.get("SIGTERM")?.();
		expect(await running).toBe(0);
		expect(dependencies.stdout).not.toHaveBeenCalled();
		expect(signals.size).toBe(0);
		expect(close).not.toHaveBeenCalled();
		ready?.({ url: "http://127.0.0.1:53700/start", close });
		await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
	});

	it("observes a canceled startup rejection without exposing it or claiming readiness", async () => {
		const { dependencies, signals } = fixture();
		let rejectStartup: ((reason: Error) => void) | undefined;
		dependencies.start = vi.fn(
			() =>
				new Promise<{ url: string; close(): Promise<void> }>((_resolve, reject) => {
					rejectStartup = reject;
				}),
		);
		const running = runCallbackBridgeCli(SSH_ARGS, dependencies);
		await vi.waitFor(() => expect(dependencies.start).toHaveBeenCalled());
		signals.get("SIGINT")?.();
		expect(await running).toBe(0);
		rejectStartup?.(new Error("private-startup-response"));
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(dependencies.stderr).not.toHaveBeenCalled();
		expect(dependencies.stdout).not.toHaveBeenCalled();
	});

	it("reports startup failure and cleans up signal handlers", async () => {
		const { dependencies, signals } = fixture();
		dependencies.start = vi.fn(async () => {
			throw new Error("local control port is occupied");
		});
		expect(await runCallbackBridgeCli(SSH_ARGS, dependencies)).toBe(1);
		expect(dependencies.stderr).toHaveBeenCalledWith(expect.stringContaining("port is occupied"));
		expect(signals.size).toBe(0);
	});
});

describe("per-user macOS bridge installer", () => {
	it.each([
		["bad.name", "example-project", "us-central1-a"],
		["example-vm", "Example_Project", "us-central1-a"],
		["example-vm", "example-project", "us_central1_a"],
		["1invalid-vm", "example-project", "us-central1-a"],
		["x".repeat(64), "example-project", "us-central1-a"],
		["auto", "Example_Project", "us-central1-a"],
	])(
		"rejects a core-invalid GCP target before writing or starting a LaunchAgent: %j",
		async (instance, project, zone) => {
			const { dependencies } = fixture();
			expect(
				await runCallbackBridgeCli(
					[
						"install",
						"--origin",
						"https://example.com",
						"--gcp-instance",
						instance,
						"--gcp-project",
						project,
						"--gcp-zone",
						zone,
					],
					dependencies,
				),
			).toBe(1);
			expect(dependencies.writeAgent).not.toHaveBeenCalled();
			expect(dependencies.launchctl).not.toHaveBeenCalled();
			expect(dependencies.start).not.toHaveBeenCalled();
			expect(dependencies.exec).not.toHaveBeenCalled();
		},
	);

	it("installs the default origin-only browser mode without cloud configuration", async () => {
		const { dependencies, files, path } = fixture(BROWSER_CONFIG);
		expect(await runCallbackBridgeCli(["install", "--origin", "https://example.com"], dependencies)).toBe(0);
		expect(files.get(path)).toContain("<string>--origin</string>");
		expect(files.get(path)).not.toContain("--gcp-");
		expect(files.get(path)).not.toContain("--ssh-host");
		expect(dependencies.exec).not.toHaveBeenCalled();
	});

	it("XML-escapes absolute executable paths and persists only the executable PATH", () => {
		const plist = bridgeLaunchAgentPlist(CONFIG, '/example<&"/node', "/example'/>/bin.js", "/example<&:/usr/bin");
		expect(plist).toContain("/example&lt;&amp;&quot;/node");
		expect(plist).toContain("/example&apos;/&gt;/bin.js");
		expect(plist).toContain("/example&lt;&amp;:/usr/bin");
		expect(plist).toContain("<key>RunAtLoad</key>\n\t<true/>");
		expect(plist).toContain("<key>KeepAlive</key>\n\t<true/>");
		expect(plist).not.toContain("StandardOutPath");
		expect(() => bridgeLaunchAgentPlist(CONFIG, "node", "/example/bin.js", "/usr/bin")).toThrow("absolute");
	});

	it("writes only its named LaunchAgent and starts it in the user's GUI domain", async () => {
		const { dependencies, files, path } = fixture();
		expect(await runCallbackBridgeCli(["install", ...SSH_ARGS], dependencies)).toBe(0);
		expect([...files.keys()]).toEqual([path]);
		expect(files.get(path)).toContain("--ssh-host");
		expect(dependencies.launchctl).toHaveBeenCalledWith(["bootstrap", "gui/501", path]);
		expect(dependencies.launchctl).toHaveBeenCalledWith(["kickstart", `gui/501/${BRIDGE_LAUNCH_AGENT_LABEL}`]);
		expect(dependencies.start).not.toHaveBeenCalled();
		expect(dependencies.probeHealth).toHaveBeenCalledWith(500);
		expect(dependencies.stdout).toHaveBeenCalledWith(expect.stringContaining("installed"));
	});

	it.each(["matching health", "unrelated health"])(
		"leaves a registered incumbent without an owned file unclaimed through install and uninstall: %s",
		async (health) => {
			const { dependencies, files, path } = fixture();
			files.set("/example-home/Library/LaunchAgents/incumbent.plist", "incumbent configuration");
			dependencies.launchctl = vi.fn(async () => 0);
			if (health === "unrelated health") {
				dependencies.probeHealth = vi.fn(async () => ({ service: "unrelated-service" }));
			}
			expect(await runCallbackBridgeCli(["install", ...SSH_ARGS], dependencies)).toBe(1);
			expect(files.has(path)).toBe(false);
			expect(dependencies.stderr).toHaveBeenCalledWith(expect.stringContaining("without an owned LaunchAgent file"));
			expect(dependencies.writeAgent).not.toHaveBeenCalled();
			expect(dependencies.secureAgent).not.toHaveBeenCalled();
			expect(dependencies.probeHealth).not.toHaveBeenCalled();
			expect(dependencies.stdout).not.toHaveBeenCalled();
			expect(await runCallbackBridgeCli(["uninstall"], dependencies)).toBe(0);
			expect(dependencies.launchctl).toHaveBeenCalledTimes(1);
			expect(dependencies.launchctl).toHaveBeenCalledWith(["print", `gui/501/${BRIDGE_LAUNCH_AGENT_LABEL}`]);
			expect(dependencies.removeAgent).not.toHaveBeenCalled();
			expect([...files.entries()]).toEqual([
				["/example-home/Library/LaunchAgents/incumbent.plist", "incumbent configuration"],
			]);
		},
	);

	it.each(["unreadable", "malformed"])(
		"refuses installation before writing when registration verification is %s",
		async (response) => {
			const { dependencies, files } = fixture();
			dependencies.launchctl = vi.fn(async () => {
				if (response === "unreadable") throw new Error("private-registration-response");
				return Number.NaN;
			});
			expect(await runCallbackBridgeCli(["install", ...SSH_ARGS], dependencies)).toBe(1);
			expect(files.size).toBe(0);
			expect(dependencies.launchctl).toHaveBeenCalledTimes(1);
			expect(dependencies.writeAgent).not.toHaveBeenCalled();
			expect(dependencies.probeHealth).not.toHaveBeenCalled();
			expect(dependencies.stderr).toHaveBeenCalledWith(expect.stringContaining("Could not verify"));
			expect(dependencies.stderr).not.toHaveBeenCalledWith(expect.stringContaining("private-registration-response"));
		},
	);

	it("waits for matching local readiness before reporting success", async () => {
		const { dependencies } = fixture();
		const ready = await dependencies.probeHealth(500);
		dependencies.probeHealth = vi
			.fn()
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("private-response private-origin private-target"))
			.mockResolvedValueOnce(ready);
		expect(await runCallbackBridgeCli(["install", ...SSH_ARGS], dependencies)).toBe(0);
		expect(dependencies.wait).toHaveBeenCalledTimes(2);
		expect(dependencies.stdout).toHaveBeenCalledTimes(1);
		expect(dependencies.stderr).not.toHaveBeenCalled();
	});

	it("bounds missing-service polling to five seconds without exposing probe errors or claiming success", async () => {
		const { dependencies, files, path, advance } = fixture();
		dependencies.probeHealth = vi.fn(async (timeoutMs) => {
			advance(timeoutMs);
			throw new Error("private-response private-origin private-target");
		});
		expect(await runCallbackBridgeCli(["install", ...SSH_ARGS], dependencies)).toBe(1);
		expect(dependencies.now()).toBe(5_000);
		expect(dependencies.stdout).not.toHaveBeenCalled();
		expect(dependencies.stderr).toHaveBeenCalledWith(expect.stringContaining("within five seconds"));
		expect(dependencies.stderr).toHaveBeenCalledWith(expect.stringContaining("uninstall"));
		expect(dependencies.stderr).not.toHaveBeenCalledWith(expect.stringContaining("private-"));
		expect(files.has(path)).toBe(true);
		expect(dependencies.removeAgent).not.toHaveBeenCalled();
		expect(dependencies.launchctl).not.toHaveBeenCalledWith(expect.arrayContaining(["bootout"]));
	});

	it("does not accept a matching response received after the installation deadline", async () => {
		const { dependencies, advance } = fixture();
		const ready = await dependencies.probeHealth(500);
		dependencies.probeHealth = vi.fn(async () => {
			advance(5_001);
			return ready;
		});
		expect(await runCallbackBridgeCli(["install", ...SSH_ARGS], dependencies)).toBe(1);
		expect(dependencies.stdout).not.toHaveBeenCalled();
		expect(dependencies.stderr).toHaveBeenCalledWith(expect.stringContaining("within five seconds"));
	});

	it.each([
		null,
		{ service: "unrelated-service", protocol: 1, configurationId: bridgeConfigurationId(CONFIG) },
		{ service: "dsh-claude-bridge", protocol: 2, configurationId: bridgeConfigurationId(CONFIG) },
		{
			service: "dsh-claude-bridge",
			protocol: 1,
			configurationId: bridgeConfigurationId(BROWSER_CONFIG),
		},
		{ service: "dsh-claude-bridge", protocol: "1", configurationId: bridgeConfigurationId(CONFIG) },
	])("rejects a stale or unrelated running service without restarting it: %j", async (health) => {
		const { dependencies, files, path } = fixture();
		const existing = bridgeLaunchAgentPlist(
			CONFIG,
			dependencies.nodeExecutable,
			dependencies.binPath,
			dependencies.executableSearchPath,
		);
		files.set(path, existing);
		dependencies.launchctl = vi.fn(async () => 0);
		dependencies.probeHealth = vi.fn(async () => health);
		expect(await runCallbackBridgeCli(["install", ...SSH_ARGS], dependencies)).toBe(1);
		expect(dependencies.stdout).not.toHaveBeenCalled();
		expect(dependencies.stderr).toHaveBeenCalledWith(expect.stringContaining("does not match"));
		expect(dependencies.stderr).toHaveBeenCalledWith(expect.stringContaining("uninstall"));
		expect(files.get(path)).toBe(existing);
		expect(dependencies.writeAgent).not.toHaveBeenCalled();
		expect(dependencies.removeAgent).not.toHaveBeenCalled();
		expect(dependencies.wait).not.toHaveBeenCalled();
		expect(dependencies.launchctl).not.toHaveBeenCalledWith(expect.arrayContaining(["-k"]));
		expect(dependencies.launchctl).not.toHaveBeenCalledWith(expect.arrayContaining(["bootout"]));
	});

	it("reuses the exact owned configuration without rewriting or restarting an existing agent", async () => {
		const { dependencies, files, path } = fixture();
		files.set(
			path,
			bridgeLaunchAgentPlist(
				CONFIG,
				dependencies.nodeExecutable,
				dependencies.binPath,
				dependencies.executableSearchPath,
			),
		);
		dependencies.launchctl = vi.fn(async () => 0);
		expect(await runCallbackBridgeCli(["install", ...SSH_ARGS], dependencies)).toBe(0);
		expect(dependencies.writeAgent).not.toHaveBeenCalled();
		expect(dependencies.secureAgent).toHaveBeenCalledWith(path);
		expect(dependencies.launchctl).not.toHaveBeenCalledWith(expect.arrayContaining(["bootstrap"]));
		expect(dependencies.launchctl).not.toHaveBeenCalledWith(expect.arrayContaining(["-k"]));
	});

	it.each(["unrelated LaunchAgent", "owned conflicting config"])(
		"preserves %s without invoking launchctl",
		async (kind) => {
			const { dependencies, files, path } = fixture();
			const existing =
				kind === "unrelated LaunchAgent"
					? "<plist>unrelated</plist>"
					: bridgeLaunchAgentPlist(
							{ ...CONFIG, remoteOrigin: "https://other.example.com" },
							dependencies.nodeExecutable,
							dependencies.binPath,
							dependencies.executableSearchPath,
						);
			files.set(path, existing);
			expect(await runCallbackBridgeCli(["install", ...SSH_ARGS], dependencies)).toBe(1);
			expect(files.get(path)).toBe(existing);
			expect(dependencies.launchctl).not.toHaveBeenCalled();
			expect(dependencies.writeAgent).not.toHaveBeenCalled();
		},
	);

	it("preserves the owned file when launchctl bootstrap fails, allowing a retry", async () => {
		const { dependencies, files, path } = fixture();
		dependencies.launchctl = vi.fn(async () => 1);
		expect(await runCallbackBridgeCli(["install", ...SSH_ARGS], dependencies)).toBe(1);
		expect(files.has(path)).toBe(true);
		expect(dependencies.removeAgent).not.toHaveBeenCalled();
	});

	it("unloads and deletes only the owned agent, preserving unrelated files", async () => {
		const { dependencies, files, path } = fixture();
		files.set(
			path,
			bridgeLaunchAgentPlist(
				CONFIG,
				dependencies.nodeExecutable,
				dependencies.binPath,
				dependencies.executableSearchPath,
			),
		);
		files.set("/example-home/Library/LaunchAgents/unrelated.plist", "unrelated");
		dependencies.launchctl = vi.fn(async () => 0);
		expect(await runCallbackBridgeCli(["uninstall"], dependencies)).toBe(0);
		expect(dependencies.launchctl).toHaveBeenCalledWith(["bootout", `gui/501/${BRIDGE_LAUNCH_AGENT_LABEL}`]);
		expect(dependencies.removeAgent).toHaveBeenCalledWith(path);
		expect([...files.keys()]).toEqual(["/example-home/Library/LaunchAgents/unrelated.plist"]);
	});

	it("does not delete an agent that failed to stop or is not owned", async () => {
		const { dependencies, files, path } = fixture();
		files.set(path, "<plist>unrelated</plist>");
		expect(await runCallbackBridgeCli(["uninstall"], dependencies)).toBe(1);
		expect(dependencies.launchctl).not.toHaveBeenCalled();
		files.set(
			path,
			bridgeLaunchAgentPlist(
				CONFIG,
				dependencies.nodeExecutable,
				dependencies.binPath,
				dependencies.executableSearchPath,
			),
		);
		dependencies.launchctl = vi.fn(async (args) => (args[0] === "print" ? 0 : 1));
		expect(await runCallbackBridgeCli(["uninstall"], dependencies)).toBe(1);
		expect(files.has(path)).toBe(true);
		expect(dependencies.removeAgent).not.toHaveBeenCalled();
	});

	it("refuses deletion if the owned file changes during uninstall", async () => {
		const { dependencies, path } = fixture();
		const original = bridgeLaunchAgentPlist(
			CONFIG,
			dependencies.nodeExecutable,
			dependencies.binPath,
			dependencies.executableSearchPath,
		);
		dependencies.readAgent = vi.fn().mockResolvedValueOnce(original).mockResolvedValueOnce("changed");
		expect(await runCallbackBridgeCli(["uninstall"], dependencies)).toBe(1);
		expect(dependencies.removeAgent).not.toHaveBeenCalledWith(path);
	});

	it("makes uninstall idempotent and refuses install on unsupported platforms", async () => {
		const { dependencies } = fixture();
		expect(await runCallbackBridgeCli(["uninstall"], dependencies)).toBe(0);
		expect(dependencies.launchctl).not.toHaveBeenCalled();
		dependencies.platform = "linux";
		expect(await runCallbackBridgeCli(["install", ...SSH_ARGS], dependencies)).toBe(1);
		expect(dependencies.writeAgent).not.toHaveBeenCalled();
	});
});

describe("automatic GCP devbox discovery", () => {
	const auto = {
		remoteOrigin: "https://example.com",
		target: { kind: "gcp" as const, instance: "auto" as const, project: "example-project" },
	};
	const instance = (name: string, owner: string, status = "RUNNING") => ({
		name,
		zone: "https://www.googleapis.com/compute/v1/projects/example-project/zones/us-central1-a",
		status,
		metadata: {
			items: [
				{ key: "owner-email", value: owner },
				{ key: "unrelated", value: "not-for-logs" },
			],
		},
	});

	it("parses auto without requiring a zone, while explicit instance still requires one", () => {
		expect(
			parseBridgeArguments([
				"--origin",
				"https://example.com",
				"--gcp-instance",
				"auto",
				"--gcp-project",
				"example-project",
			]),
		).toEqual({ action: "run", ...auto });
		expect(() =>
			parseBridgeArguments([
				"--origin",
				"https://example.com",
				"--gcp-instance",
				"example-vm",
				"--gcp-project",
				"example-project",
			]),
		).toThrow("--gcp-zone");
	});

	it("selects exactly one account-owned running devbox, case-insensitively", async () => {
		const { dependencies } = fixture();
		dependencies.exec = vi
			.fn()
			.mockResolvedValueOnce("USER@example.com\n")
			.mockResolvedValueOnce(
				JSON.stringify([instance("other-vm", "other@example.com"), instance("owned-vm", "user@example.com")]),
			);
		expect(await resolveBridgeRunConfig(auto, dependencies)).toEqual({
			remoteOrigin: "https://example.com",
			target: { kind: "gcp", instance: "owned-vm", project: "example-project", zone: "us-central1-a" },
		});
		expect(dependencies.exec).toHaveBeenNthCalledWith(1, "gcloud", ["config", "get-value", "account", "--quiet"]);
		expect(dependencies.exec).toHaveBeenNthCalledWith(2, "gcloud", [
			"compute",
			"instances",
			"list",
			"--project",
			"example-project",
			"--filter=labels.workload=devbox",
			"--format=json(name,zone,status,metadata.items)",
			"--quiet",
		]);
		expect(dependencies.stdout).not.toHaveBeenCalled();
		expect(dependencies.stderr).not.toHaveBeenCalled();
	});

	it.each(["account", "inventory"] as const)(
		"cancels deferred %s discovery promptly even when the dependency ignores abort",
		async (phase) => {
			const { dependencies, signals } = fixture(auto);
			let release: ((value: string) => void) | undefined;
			dependencies.exec = vi.fn(async (_command, args) => {
				if (phase === "account" || args[0] === "compute") {
					return new Promise<string>((resolve) => {
						release = resolve;
					});
				}
				return "user@example.com";
			});
			const running = runCallbackBridgeCli(
				["run", "--origin", "https://example.com", "--gcp-instance", "auto", "--gcp-project", "example-project"],
				dependencies,
			);
			await vi.waitFor(() => expect(dependencies.exec).toHaveBeenCalledTimes(phase === "account" ? 1 : 2));
			const signal = vi.mocked(dependencies.exec).mock.calls[0]?.[2];
			expect(signal).toBeInstanceOf(AbortSignal);
			signals.get("SIGTERM")?.();
			expect(await running).toBe(0);
			expect(signal?.aborted).toBe(true);
			expect(signals.size).toBe(0);
			release?.(phase === "account" ? "user@example.com" : JSON.stringify([instance("owned-vm", "user@example.com")]));
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(dependencies.exec).toHaveBeenCalledTimes(phase === "account" ? 1 : 2);
			expect(dependencies.start).not.toHaveBeenCalled();
			expect(dependencies.stdout).not.toHaveBeenCalled();
			expect(dependencies.stderr).not.toHaveBeenCalled();
		},
	);

	it("observes an ignored-abort discovery rejection after cancellation", async () => {
		const { dependencies, signals } = fixture(auto);
		let rejectDiscovery: ((reason: Error) => void) | undefined;
		dependencies.exec = vi.fn(
			() =>
				new Promise<string>((_resolve, reject) => {
					rejectDiscovery = reject;
				}),
		);
		const running = runCallbackBridgeCli(
			["run", "--origin", "https://example.com", "--gcp-instance", "auto", "--gcp-project", "example-project"],
			dependencies,
		);
		await vi.waitFor(() => expect(dependencies.exec).toHaveBeenCalled());
		signals.get("SIGINT")?.();
		expect(await running).toBe(0);
		rejectDiscovery?.(new Error("private-discovery-response"));
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(dependencies.start).not.toHaveBeenCalled();
		expect(dependencies.stderr).not.toHaveBeenCalled();
	});

	it.each([
		{ inventory: [] },
		{ inventory: [instance("other-vm", "other@example.com")] },
		{ inventory: [instance("one-vm", "user@example.com"), instance("two-vm", "user@example.com")] },
		{
			inventory: [
				{
					name: "invalid-vm",
					zone: "us-central1-a",
					status: "RUNNING",
					metadata: { items: [{ key: "owner-name", value: "user@example.com" }] },
				},
			],
		},
	])("refuses an absent or ambiguous owner match", async ({ inventory }) => {
		const { dependencies } = fixture();
		dependencies.exec = vi
			.fn()
			.mockResolvedValueOnce("user@example.com")
			.mockResolvedValueOnce(JSON.stringify(inventory));
		await expect(resolveBridgeRunConfig(auto, dependencies)).rejects.toThrow("uniquely owned");
	});

	it("requires the single owned instance to be running", async () => {
		const { dependencies } = fixture();
		dependencies.exec = vi
			.fn()
			.mockResolvedValueOnce("user@example.com")
			.mockResolvedValueOnce(JSON.stringify([instance("owned-vm", "user@example.com", "TERMINATED")]));
		await expect(resolveBridgeRunConfig(auto, dependencies)).rejects.toThrow("not running");
	});

	it("redacts failed authentication or inventory errors and never logs metadata", async () => {
		const { dependencies } = fixture();
		dependencies.exec = vi.fn(async () => {
			throw new Error("private-account secret-provider-error");
		});
		expect(
			await runCallbackBridgeCli(
				["--origin", "https://example.com", "--gcp-instance", "auto", "--gcp-project", "example-project"],
				dependencies,
			),
		).toBe(1);
		expect(dependencies.stderr).toHaveBeenCalledWith(expect.stringContaining("authenticate gcloud"));
		expect(dependencies.stderr).not.toHaveBeenCalledWith(expect.stringContaining("secret-provider-error"));
		expect(dependencies.start).not.toHaveBeenCalled();
	});

	it("does not query inventory with an unset account or malformed response", async () => {
		const { dependencies } = fixture();
		dependencies.exec = vi.fn().mockResolvedValueOnce("(unset)");
		await expect(resolveBridgeRunConfig(auto, dependencies)).rejects.toThrow("authenticate gcloud");
		expect(dependencies.exec).toHaveBeenCalledTimes(1);
		dependencies.exec = vi.fn().mockResolvedValueOnce("user@example.com").mockResolvedValueOnce("not-for-logs");
		await expect(resolveBridgeRunConfig(auto, dependencies)).rejects.toThrow("authenticate gcloud");
	});

	it("stores the automatic target at install time and discovers it only when run starts", async () => {
		const { dependencies, files, path } = fixture(auto);
		expect(
			await runCallbackBridgeCli(
				["install", "--origin", "https://example.com", "--gcp-instance", "auto", "--gcp-project", "example-project"],
				dependencies,
			),
		).toBe(0);
		expect(files.get(path)).toContain("<string>auto</string>");
		expect(files.get(path)).not.toContain("--gcp-zone");
		expect(dependencies.exec).not.toHaveBeenCalled();
	});

	it("retains the original automatic configuration identity after resolving its runtime target", async () => {
		const { dependencies, signals } = fixture(auto);
		dependencies.exec = vi
			.fn()
			.mockResolvedValueOnce("user@example.com")
			.mockResolvedValueOnce(JSON.stringify([instance("owned-vm", "user@example.com")]));
		const running = runCallbackBridgeCli(
			["run", "--origin", "https://example.com", "--gcp-instance", "auto", "--gcp-project", "example-project"],
			dependencies,
		);
		await vi.waitFor(() => expect(dependencies.start).toHaveBeenCalled());
		const resolved = {
			remoteOrigin: "https://example.com",
			target: { kind: "gcp" as const, instance: "owned-vm", project: "example-project", zone: "us-central1-a" },
		};
		expect(dependencies.start).toHaveBeenCalledWith({
			...resolved,
			configurationId: bridgeConfigurationId(auto),
		});
		expect(bridgeConfigurationId(auto)).not.toBe(bridgeConfigurationId(resolved));
		signals.get("SIGTERM")?.();
		expect(await running).toBe(0);
	});
});

describe("owned discovery subprocess cancellation", () => {
	it("rejects an already aborted discovery before spawning a command", async () => {
		const dependencies = defaultBridgeCliDependencies();
		const cancellation = new AbortController();
		cancellation.abort();
		await expect(dependencies.exec("unused-command", [], cancellation.signal)).rejects.toThrow("cancelled");
	});

	it("terminates only its own stubborn discovery subprocess within the cleanup bound", async () => {
		const dependencies = defaultBridgeCliDependencies();
		const directory = await mkdtemp(join(tmpdir(), "dsh-bridge-cancel-"));
		const marker = join(directory, "pid");
		const cancellation = new AbortController();
		let pid: number | undefined;
		try {
			const execution = dependencies.exec(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					"import {writeFileSync} from 'node:fs'; process.on('SIGTERM',()=>{}); writeFileSync(process.argv[1],String(process.pid)); setInterval(()=>{},1000);",
					marker,
				],
				cancellation.signal,
			);
			const rejected = expect(execution).rejects.toThrow("cancelled");
			await vi.waitFor(async () => {
				pid = Number(await readFile(marker, "utf8"));
				expect(pid).toBeGreaterThan(0);
			});
			cancellation.abort();
			await rejected;
			await vi.waitFor(
				() => {
					expect(() => process.kill(pid!, 0)).toThrow();
				},
				{ timeout: 2_000 },
			);
		} finally {
			cancellation.abort();
			if (pid !== undefined) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// The owned fixture process was already terminated.
				}
			}
			await rm(directory, { recursive: true, force: true });
		}
	});
});
