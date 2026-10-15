/** Account-bound native pi-ai credentials; the base file remains the only owner. */
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { type OAuthCredentialFileStore } from "./store.js";
/** No active-account fallback, login upsert, or transport-owned logout. */
export declare class AccountCredentialStore implements CredentialStore {
    private readonly base;
    private readonly accountId;
    readonly nativeProviderId: string;
    constructor(base: OAuthCredentialFileStore, accountId: string);
    read(providerId: string): Promise<Credential | undefined>;
    list(): Promise<readonly CredentialInfo[]>;
    modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined>;
    /** A late AUTH failure must not invalidate a newer token from another stream. */
    invalidateRejectedAccessToken(rejectedAccessToken: string): Promise<boolean>;
    delete(providerId: string): Promise<void>;
}
//# sourceMappingURL=account-credentials.d.ts.map