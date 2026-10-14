/** Revision-checked writes of the live `routing` form through the host settings service. */
import type { CapabilitySettingsService } from "./capability-settings.js";
import type { RoutingConfig } from "./routing-config.js";
export interface RoutingSettingsSnapshot {
    readonly revision: number;
    readonly writable: boolean;
    readonly value: RoutingConfig;
}
export interface RoutingSettingsController {
    snapshot(): RoutingSettingsSnapshot;
    patch(patch: unknown, expectedRevision: number): Promise<RoutingSettingsSnapshot>;
}
export declare class RoutingSettingsError extends Error {
    readonly status: 400 | 403 | 409 | 503;
    readonly code: string;
    constructor(status: 400 | 403 | 409 | 503, code: string);
}
export declare const ROUTING_POLICY_MAX_BYTES: number;
export declare function createRoutingSettingsController(options: {
    settings(): CapabilitySettingsService | undefined;
    entryNamespace(): string | undefined;
    current(): RoutingConfig;
}): RoutingSettingsController;
//# sourceMappingURL=routing-settings.d.ts.map