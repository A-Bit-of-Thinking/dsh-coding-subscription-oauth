import { type ChildProcess } from "node:child_process";
export type BridgeTarget = {
    kind: "browser";
} | {
    kind: "ssh";
    host: string;
} | {
    kind: "gcp";
    instance: string;
    project: string;
    zone: string;
};
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
/** A local, opt-in daemon. Tokens remain with the remote DSH OAuth implementation. */
export declare function startCallbackBridge(options: CallbackBridgeOptions): Promise<{
    url: string;
    close(): Promise<void>;
}>;
export {};
//# sourceMappingURL=callback-bridge.d.ts.map