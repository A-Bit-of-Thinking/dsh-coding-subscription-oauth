import type { Context } from "@deepseek-ai/cordis";
import { type CapabilitySettingsPatch, type CapabilitySettingsService } from "./capability-settings.js";
/** Stable Config references are structural: no new cosmokit dependency is needed. */
export interface CapabilitySettingsReference {
    get(): CapabilitySettingsPatch | undefined;
}
export declare function readCapabilityConfig(value: CapabilitySettingsPatch | CapabilitySettingsReference | undefined): CapabilitySettingsPatch | undefined;
/** Injections inherit the owning loader entry; follow parent contexts when absent. */
export declare function capabilityEntryNamespace(context: Context): string | undefined;
export declare function hasCapabilitySettingsForms(settings: CapabilitySettingsService): boolean;
/**
 * Keep the public capability namespace while editing only the owning entry's
 * volatile capabilities form. Legacy register() services remain untouched.
 */
export declare function adaptCapabilityHostSettings(settings: CapabilitySettingsService, entryNamespace: string | undefined): CapabilitySettingsService;
/** Host describe() itself may emit this event; defer/coalesce to avoid reentrant reads. */
export declare function watchCapabilityHostSettings(context: Context, entryNamespace: string | undefined, reconcile: () => void, onError: (error: unknown) => void): () => void;
//# sourceMappingURL=capability-host-settings.d.ts.map