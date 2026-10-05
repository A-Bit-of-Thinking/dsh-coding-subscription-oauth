/** Stable compatibility contracts for standalone and future co-installation. */
import type { DshHostCapability, OwnerAccessMode } from "dsh-coding-oauth-core";
export interface DshCompatibilityDiagnostic {
    readonly id: string;
    readonly component: "host" | "client" | "owner-request" | "runtime";
    readonly level: "info" | "warning" | "error";
    readonly message: string;
    readonly expected?: string;
    readonly actual?: string;
}
export interface CodingOAuthParticipantDiagnosticSource {
    readonly participantId: "coding-subscription-oauth";
    diagnostics(): readonly DshCompatibilityDiagnostic[];
}
export interface DshCompatibility {
    readonly coreAbi: string;
    readonly dshVersion: string | null;
    readonly status: "healthy" | "degraded" | "incompatible";
    readonly uiOwner: "hub" | "standalone" | null;
    readonly accessMode: OwnerAccessMode;
    readonly capabilities: Readonly<Record<string, DshHostCapability>>;
    readonly diagnostics: readonly string[];
}
export declare const DSH_EXACT_BOM: Readonly<{
    readonly "@deepseek-ai/cordis": "4.0.4";
    readonly "@deepseek-ai/dsh-atomic-write": "0.2.0-rc.2";
    readonly "@deepseek-ai/dsh-attachment": "0.2.0-rc.2";
    readonly "@deepseek-ai/dsh-client-locale": "0.2.0-rc.2";
    readonly "@deepseek-ai/dsh-client-ui-settings": "0.2.0-rc.2";
    readonly "@deepseek-ai/dsh-client-ui-slots": "0.2.0-rc.2";
    readonly "@deepseek-ai/dsh-client-web": "0.2.0-rc.2";
    readonly "@deepseek-ai/dsh-credentials": "0.2.0-rc.2";
    readonly "@deepseek-ai/dsh-home-paths": "0.2.0-rc.2";
    readonly "@deepseek-ai/dsh-host-webserver": "0.2.0-rc.2";
    readonly "@deepseek-ai/dsh-invariants": "0.2.0-rc.2";
    readonly "@deepseek-ai/dsh-llm": "0.2.0-rc.2";
    readonly "@deepseek-ai/dsh-llm-pi-ai": "0.2.0-rc.2";
    readonly "@deepseek-ai/dsh-tools": "0.2.0-rc.2";
    readonly "@deepseek-ai/schemastery": "3.18.4";
    readonly "@earendil-works/pi-ai": "0.87.1";
    readonly react: "18.3.1";
    readonly "react-dom": "18.3.1";
}>;
export declare function incompatibleDiagnostics(diagnostics: readonly DshCompatibilityDiagnostic[]): DshCompatibilityDiagnostic[];
//# sourceMappingURL=compatibility.d.ts.map