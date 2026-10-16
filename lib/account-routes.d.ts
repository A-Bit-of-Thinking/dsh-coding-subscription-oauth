import type { SubscriptionProviderSlug } from "./oauth-providers.js";
export declare const ACCOUNT_ROUTES_FILENAME = ".coding-oauth-account-routes.json";
/** Internal identifiers must NOT be returned directly to tools/status consumers. */
export interface AccountRouteDescriptor {
    readonly family: SubscriptionProviderSlug;
    readonly accountId: string;
    readonly createdAt: number;
}
export interface AccountRouteBinding extends AccountRouteDescriptor {
    readonly route: string;
    readonly slot: number;
}
/** `slot` stays an internal persistence detail; users and models see names instead. */
export interface AccountRouteView {
    readonly family: SubscriptionProviderSlug;
    readonly route: string;
}
/** Allowlisted projection: no provider account IDs, labels, epochs, filenames or tokens. */
export declare function publicAccountRoute(binding: AccountRouteBinding): AccountRouteView;
/** Stable random slots, not credential-derived aliases or active-account switches. */
export declare class AccountRouteRegistry {
    private readonly createId;
    readonly filename: string;
    constructor(filename: string, createId?: () => string);
    private load;
    /** Only the explicitly enabled runtime calls this mutation; history slots are never reused. */
    synchronize(accounts: readonly AccountRouteDescriptor[]): Promise<readonly AccountRouteBinding[]>;
}
//# sourceMappingURL=account-routes.d.ts.map