#!/usr/bin/env node
/** Local Claude callback bridge CLI; this entry has no DSH runtime dependencies. */
import { type BridgeTarget } from "./callback-bridge.js";
export declare const BRIDGE_LAUNCH_AGENT_LABEL = "io.dsh.claude-callback-bridge";
export interface BridgeRunConfig {
    remoteOrigin: string;
    target: BridgeTarget;
    configurationId?: string;
}
export interface BridgeCliConfig {
    remoteOrigin: string;
    target: BridgeTarget | {
        kind: "gcp";
        instance: "auto";
        project: string;
        zone?: string;
    };
}
export type BridgeCliCommand = {
    action: "help";
} | {
    action: "uninstall";
} | ({
    action: "run" | "install";
} & BridgeCliConfig);
export interface BridgeCliDependencies {
    platform: NodeJS.Platform;
    home: string;
    nodeExecutable: string;
    binPath: string;
    executableSearchPath: string;
    uid: number | undefined;
    stdout(text: string): void;
    stderr(text: string): void;
    start(config: BridgeRunConfig): Promise<{
        url: string;
        close(): Promise<void>;
    }>;
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
export declare function bridgeConfigurationId(config: BridgeCliConfig): string;
export declare function parseBridgeArguments(args: readonly string[]): BridgeCliCommand;
export declare function bridgeRunArguments(config: BridgeCliConfig): string[];
export declare function bridgeLaunchAgentPlist(config: BridgeCliConfig, nodeExecutable: string, binPath: string, executableSearchPath: string): string;
/** Discover one account-owned devbox without switching accounts or exposing instance metadata. */
export declare function resolveBridgeRunConfig(config: BridgeCliConfig, dependencies: Pick<BridgeCliDependencies, "exec">, signal?: AbortSignal): Promise<BridgeRunConfig>;
export declare function runCallbackBridgeCli(args: readonly string[], dependencies: BridgeCliDependencies): Promise<number>;
export declare function defaultBridgeCliDependencies(): BridgeCliDependencies;
//# sourceMappingURL=callback-bridge-bin.d.ts.map