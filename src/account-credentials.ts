/** Account-bound native pi-ai credentials; the base file remains the only owner. */
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { isValidAccountId, type OAuthCredentialFileStore } from "./store.ts";

/** No active-account fallback, login upsert, or transport-owned logout. */
export class AccountCredentialStore implements CredentialStore {
	readonly nativeProviderId: string;

	constructor(
		private readonly base: OAuthCredentialFileStore,
		private readonly accountId: string,
	) {
		if (!isValidAccountId(accountId)) throw new TypeError("Account credential scope is invalid");
		this.nativeProviderId = base.providerId;
	}

	async read(providerId: string): Promise<Credential | undefined> {
		if (providerId !== this.nativeProviderId) return undefined;
		try {
			return await this.base.readAccount(this.accountId, { readOnly: true });
		} catch {
			throw new Error("Account credential read failed");
		}
	}

	async list(): Promise<readonly CredentialInfo[]> {
		return (await this.read(this.nativeProviderId)) === undefined
			? []
			: [{ providerId: this.nativeProviderId, type: "oauth" }];
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		if (providerId !== this.nativeProviderId) throw new Error("Account credential provider is not owned");
		try {
			return await this.base.modifyAccount(this.accountId, async (current) => {
				if (current?.type !== "oauth") return undefined;
				// Capture identity before invoking an untrusted refresh callback (which may mutate current).
				const identity = current.accountId;
				const candidate = await fn(current);
				if (candidate === undefined) return undefined;
				if (candidate.type !== "oauth") throw new Error("Account credential type is invalid");
				if (identity !== undefined && candidate.accountId !== undefined && identity !== candidate.accountId)
					throw new Error("Account credential identity changed");
				return candidate;
			});
		} catch {
			// Neither storage errors nor provider callback errors may expose credential/path details.
			throw new Error("Account credential modification failed");
		}
	}

	/** A late AUTH failure must not invalidate a newer token from another stream. */
	async invalidateRejectedAccessToken(rejectedAccessToken: string): Promise<boolean> {
		if (typeof rejectedAccessToken !== "string" || rejectedAccessToken.length === 0)
			throw new TypeError("Rejected access token is required");
		let invalidated = false;
		await this.modify(this.nativeProviderId, async (current) => {
			if (current?.type !== "oauth" || current.access !== rejectedAccessToken) return undefined;
			invalidated = true;
			return { ...current, expires: Date.now() - 1000 };
		});
		return invalidated;
	}

	async delete(providerId: string): Promise<void> {
		if (providerId !== this.nativeProviderId) return;
		// removeAccount has no atomic identity precondition; delete would remove every account.
		throw new Error("Account credential deletion is unsupported; use the existing account manager");
	}
}
