/** A fixed route owns one credential scope; each stream owns its rejected-token snapshot. */
import { createHash } from "node:crypto";
import type { AttachmentStore } from "@deepseek-ai/dsh-attachment";
import type { GenerateOptions, RetryPolicyConfig, StreamChunk } from "@deepseek-ai/dsh-llm";
import * as llm from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { type CredentialStore, createModels, type OAuthCredential } from "@earendil-works/pi-ai";
import { AccountCredentialStore } from "./account-credentials.ts";
import { accountFamilyName } from "./account-names.ts";
import type { AccountRouteBinding } from "./account-routes.ts";
import { codingOAuthProfile } from "./adapter.ts";
import { AliasLlmAdapter } from "./alias-adapter.ts";
import type { OAuthProviderSession } from "./oauth-session.ts";

const NO_EXTERNAL_AUTH = { env: async () => undefined, fileExists: async () => false };
const ACCOUNT_RETRY: RetryPolicyConfig = {
	mode: "normal",
	maxRetries: 1,
	retryableCodes: ["AUTH"],
	backoff: { initialDelayMs: 250, maxDelayMs: 250, jitterRatio: 0 },
};
function unavailable(): never {
	throw new llm.LlmError(
		"Selected account route is disconnected or has changed; choose an available route",
		"MISSING_CREDENTIAL",
	);
}

export class AccountBoundAdapter extends llm.LlmAdapter {
	private alive = true;
	private readonly scope: CredentialStore;
	private readonly tokens: ReturnType<typeof createModels>;
	private readonly catalog: AliasLlmAdapter;
	/**
	 * Read lazily by providerInfo (never captured at construction): a rename or a change of
	 * default account only mutates this field, so no entry is recreated and no request is cut.
	 */
	private displayName: string;
	readonly binding: AccountRouteBinding;

	constructor(
		private readonly session: OAuthProviderSession,
		binding: AccountRouteBinding,
		private readonly resolveAttachments: () => AttachmentStore | undefined,
	) {
		super();
		if (binding.family !== session.definition.slug) unavailable();
		this.binding = { ...binding };
		this.displayName = accountFamilyName(binding.family);
		const base = new AccountCredentialStore(session.store, binding.accountId);
		const native = session.definition.nativeProviderId;
		this.scope = {
			read: async (provider) => {
				if (provider !== native) return undefined;
				await this.assertCurrent();
				const value = await base.read(provider);
				await this.assertCurrent();
				return value;
			},
			list: async () => ((await this.scope.read(native)) === undefined ? [] : [{ providerId: native, type: "oauth" }]),
			modify: (provider, fn) =>
				base.modify(provider, async (current) => {
					await this.assertCurrent();
					const value = await fn(current);
					await this.assertCurrent();
					return value;
				}),
			delete: (provider) => base.delete(provider),
		};
		this.tokens = createModels({ credentials: this.scope, authContext: NO_EXTERNAL_AUTH });
		this.tokens.setProvider(session.definition.providerFactory());
		this.catalog = this.makeAdapter();
	}

	/** Called synchronously on withdrawal; already sent streams may finish, never refresh a replacement. */
	dispose(): void {
		this.alive = false;
	}

	/** Name shown by the model picker; takes effect for the next providerInfo call. */
	setDisplayName(name: string): void {
		this.displayName = name;
	}

	/** The default account is listed through the legacy route; this fixed route stays usable but is hidden. */
	private async isDefaultAccount(): Promise<boolean> {
		try {
			return (await this.session.store.getActiveAccountId({ readOnly: true })) === this.binding.accountId;
		} catch {
			// Unreadable store: showing a possible duplicate is safer than hiding a usable route.
			return false;
		}
	}

	private async assertCurrent(): Promise<void> {
		if (!this.alive) unavailable();
		const rows = await this.session.store.listAccounts({ readOnly: true, includeCreatedAt: true });
		if (
			!this.alive ||
			!rows.some((row) => row.id === this.binding.accountId && row.createdAt === this.binding.createdAt)
		)
			unavailable();
	}
	private generation(credential: OAuthCredential): string {
		return createHash("sha256")
			.update(JSON.stringify([this.binding.createdAt, credential.access, credential.refresh, credential.accountId]))
			.digest("hex");
	}

	/** Internal auth for quota readers only; never serialize this result to API/tools. */
	async resolveAccess(): Promise<{ accessToken: string; generation: string; accountId?: string }> {
		await this.assertCurrent();
		try {
			const auth = await this.tokens.getAuth(this.session.definition.nativeProviderId, { minOAuthValidityMs: 60_000 });
			const credential = await this.scope.read(this.session.definition.nativeProviderId);
			if (credential?.type !== "oauth" || !auth?.auth.apiKey || credential.access !== auth.auth.apiKey) unavailable();
			return {
				accessToken: credential.access,
				generation: this.generation(credential),
				...(typeof credential.accountId === "string" ? { accountId: credential.accountId } : {}),
			};
		} catch {
			unavailable();
		}
	}
	/**
	 * Marks the stored access token expired when it is still the rejected one, so the next resolveAccess
	 * refreshes instead of replaying it. A token already replaced by another refresh is left alone.
	 */
	async invalidateAccess(rejected: string | undefined): Promise<void> {
		if (!this.alive || rejected === undefined) return;
		await this.scope.modify(this.session.definition.nativeProviderId, async (current) =>
			current?.type === "oauth" && current.access === rejected ? { ...current, expires: Date.now() - 1000 } : undefined,
		);
	}
	async isCurrent(generation: string): Promise<boolean> {
		try {
			const credential = await this.scope.read(this.session.definition.nativeProviderId);
			return credential?.type === "oauth" && this.generation(credential) === generation;
		} catch {
			return false;
		}
	}

	private makeAdapter(): AliasLlmAdapter {
		const native = this.session.definition.nativeProviderId;
		let sentAccess: string | undefined;
		const currentName = (): string => this.displayName;
		const inner = new PiAiAdapter({
			profiles: () =>
				// Full catalog on purpose (no selectedIds): the plugin's model selection only trims the legacy
				// route; a fixed account route must offer every model so the host's per-pair sub-agent
				// checklist can list them all.
				new Map([
					[
						native,
						codingOAuthProfile(native, this.displayName, this.session.definition.requestProvider(), ACCOUNT_RETRY),
					],
				]),
			auth: { credentials: this.scope, authContext: NO_EXTERNAL_AUTH },
			resolveApiKey: async () => {
				const access = await this.resolveAccess();
				sentAccess = access.accessToken;
				return access.accessToken;
			},
			resolveAttachments: this.resolveAttachments,
		});
		return new AliasLlmAdapter(
			inner,
			new Map([[this.binding.route, native]]),
			new Map([
				[
					this.binding.route,
					{
						// Getter: providerInfo reads the current name on every call (rename-safe).
						get displayName() {
							return currentName();
						},
						isAuthenticated: async () => {
							try {
								return (await this.scope.read(native))?.type === "oauth";
							} catch {
								return false;
							}
						},
						onAuthFailure: () => this.invalidateAccess(sentAccess),
					},
				],
			]),
		);
	}

	providerInfo(provider: string) {
		return this.catalog.providerInfo(provider);
	}
	providerRetryPolicy(provider: string) {
		return this.catalog.providerRetryPolicy(provider);
	}
	/** Hidden (empty) while this account is the default one; resolveModel and stream are unaffected. */
	async listModels(provider: string) {
		if (await this.isDefaultAccount()) return [];
		return this.catalog.listModels(provider);
	}
	resolveModel(provider: string, model: string) {
		return this.catalog.resolveModel(provider, model);
	}
	async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
		await this.assertCurrent();
		// Fresh inner adapter prevents another concurrent stream from replacing sentAccess.
		try {
			for await (const chunk of this.makeAdapter().stream(options)) {
				if (chunk.type === "finish" && chunk.reason.kind === "error") {
					const failure = chunk.reason.failure;
					yield {
						...chunk,
						reason: {
							kind: "error",
							failure: {
								code: failure.code,
								message: `Subscription account request failed (${failure.code})`,
								...(failure.status === undefined ? {} : { status: failure.status }),
								...(failure.providerRetryAfterMs === undefined
									? {}
									: { providerRetryAfterMs: failure.providerRetryAfterMs }),
								...(failure.offloadImages === undefined ? {} : { offloadImages: failure.offloadImages }),
							},
						},
					};
				} else yield chunk;
			}
		} catch (error) {
			throw new llm.LlmError(
				"Subscription account request could not complete",
				error instanceof llm.LlmError ? error.code : "TRANSPORT",
			);
		}
	}
}
