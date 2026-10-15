/** Separate opt-ins: registration, quota reads, full guidance, and request enforcement. */
import z from "@deepseek-ai/schemastery";
export interface RoutingConfig {
    enabled: boolean;
    usageEnabled: boolean;
    guidanceEnabled: boolean;
    enforcePolicy: boolean;
    policyJson: string;
}
export interface RoutingConfigReference {
    get(): unknown;
}
export declare const RoutingConfigSchema: z<Schemastery.ObjectS<NoInfer<{
    enabled: z<boolean, boolean, "defined">;
    usageEnabled: z<boolean, boolean, "defined">;
    guidanceEnabled: z<boolean, boolean, "defined">;
    enforcePolicy: z<boolean, boolean, "defined">;
    policyJson: z<string, string, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    enabled: z<boolean, boolean, "defined">;
    usageEnabled: z<boolean, boolean, "defined">;
    guidanceEnabled: z<boolean, boolean, "defined">;
    enforcePolicy: z<boolean, boolean, "defined">;
    policyJson: z<string, string, "defined">;
}>>, "plain">;
export declare function readRoutingConfig(input: Partial<RoutingConfig> | RoutingConfigReference | undefined): RoutingConfig;
//# sourceMappingURL=routing-config.d.ts.map