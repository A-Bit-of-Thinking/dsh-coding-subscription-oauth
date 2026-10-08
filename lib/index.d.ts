import type { Context } from "@deepseek-ai/cordis";
import { type RetryPolicyConfig } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
import { type CapabilitySettingsReference } from "./capability-host-settings.js";
import { type CapabilitySettingsPatch } from "./capability-settings.js";
import { type GatewayConfig } from "./gateway-config.js";
export type { CodingOAuthParticipant, CodingOAuthRuntime, DshHostCapabilities, OwnerRequestPolicy as CoreOwnerRequestPolicy, } from "dsh-coding-oauth-core";
export { acquireCodingOAuthRuntime, CODING_OAUTH_CORE_ABI, } from "dsh-coding-oauth-core";
export { createCodingOAuthAdapter, createGrokBuildAdapter, preferredGrokBuildModel } from "./adapter.js";
export type { AliasLlmRoutePolicy } from "./alias-adapter.js";
export { AliasLlmAdapter } from "./alias-adapter.js";
export type { GrokBuildAuthStatus } from "./auth.js";
export { grokBuildAuthStatus, importGrokBuildFromGrok, importGrokBuildSession, loginGrokBuild, loginGrokBuildSession, logoutGrokBuild, } from "./auth.js";
export type { CodingOAuthWebStatus, GrokBuildLoginMethod, GrokBuildWebAuthStatus, LoginChallenge, SubscriptionLoginChallenge, SubscriptionWebAuthStatus, } from "./auth-routes.js";
export { CODING_OAUTH_LOGIN_CANCEL_PATH, CODING_OAUTH_LOGIN_CODE_PATH, CODING_OAUTH_LOGIN_PATH, CODING_OAUTH_LOGOUT_PATH, CODING_OAUTH_MODELS_PATH, CODING_OAUTH_STATUS_PATH, GROK_BUILD_AUTH_IMPORT_PATH, GROK_BUILD_AUTH_LOGIN_CANCEL_PATH, GROK_BUILD_AUTH_LOGIN_CODE_PATH, GROK_BUILD_AUTH_LOGIN_PATH, GROK_BUILD_AUTH_LOGOUT_PATH, GROK_BUILD_AUTH_MODELS_PATH, GROK_BUILD_AUTH_STATUS_PATH, GrokBuildWebAuth, registerCodingOAuthRoutes, registerGrokBuildAuthRoutes, SubscriptionWebAuth, } from "./auth-routes.js";
export type { CatalogSource, LiveModelDescriptor } from "./catalog.js";
export { extractLiveModels, extractModelIds, fetchLiveModelIds, fetchLiveModels, materializeLiveModel, mergeLiveCatalog, preferredGrokBuildModelFrom, thinkingLevelMapFromLiveEfforts, } from "./catalog.js";
export { createDshHostAdapter } from "./dsh-host-adapter.js";
export type { GrokImportProbe } from "./grok-import.js";
export { grokAuthPath, importGrokAuth, parseGrokAuthDocument, probeGrokAuth } from "./grok-import.js";
export type { CodingOAuthProviderSlug, CodingOAuthRoute } from "./ids.js";
export { ANTIGRAVITY_ROUTE, CLAUDE_CODE_OAUTH_AUTH_FILENAME, CLAUDE_CODE_OAUTH_MODELS_CACHE_FILENAME, CLAUDE_CODE_OAUTH_ROUTE, CLAUDE_PI_PROVIDER, CODEX_OAUTH_AUTH_FILENAME, CODEX_OAUTH_MODELS_CACHE_FILENAME, CODEX_OAUTH_ROUTE, CODEX_PI_PROVIDER, CODING_OAUTH_ROUTES, DEFAULT_GROK_BUILD_MODEL, GROK_BUILD_AUTH_FILENAME, GROK_BUILD_MODELS_CACHE_FILENAME, GROK_BUILD_ROUTE, GROK_BUILD_STREAM_IDLE_TIMEOUT_MS, KIMI_CODE_OAUTH_AUTH_FILENAME, KIMI_CODE_OAUTH_MODELS_CACHE_FILENAME, KIMI_CODE_OAUTH_ROUTE, KIMI_PI_PROVIDER, XAI_PI_PROVIDER, } from "./ids.js";
export type { GrokBuildOAuthErrorCode, GrokBuildOAuthParams, PkceLoginCallbacks } from "./oauth.js";
export { buildAuthorizeUrl, discoverOAuthEndpoints, extractCode, GROK_BUILD_OAUTH_CLIENT_ID, GROK_BUILD_OAUTH_DEFAULT_PORT, GROK_BUILD_OAUTH_ISSUER, GROK_BUILD_OAUTH_SCOPE, GrokBuildOAuthError, generatePkce, loginGrokBuildPkce, refreshGrokBuildToken, resolveOAuthParams, } from "./oauth.js";
export type { OAuthProviderDefinition, SubscriptionLoginMethod, SubscriptionProviderSlug } from "./oauth-providers.js";
export { CLAUDE_CODE_OAUTH_PROVIDER, CODEX_OAUTH_PROVIDER, KIMI_CODE_OAUTH_PROVIDER, OAUTH_PROVIDER_DEFINITIONS, oauthProviderDefinition, } from "./oauth-providers.js";
export type { OAuthProviderStatus } from "./oauth-session.js";
export { OAuthProviderSession, oauthModelsCachePath } from "./oauth-session.js";
export { GROK_BUILD_BASE_URL, GROK_BUILD_MODELS_URL, GROK_CLIENT_VERSION, grokBuildBaselineModels, grokBuildFingerprintHeaders, grokBuildProvider, grokBuildReasoningMap, } from "./provider.js";
export type { CodingOAuthProxyOptions } from "./proxy.js";
export { codingOAuthProxyInEffect, codingOAuthProxyUnreachableHint, ensureCodingOAuthProxy, ensureGrokBuildProxy, grokBuildProxyInEffect, } from "./proxy.js";
export { redactProxyUrl, safeMessage } from "./redact.js";
export { GrokBuildSession } from "./session.js";
export type { AccountId, AccountRecord, AccountSummary, AuthDocumentV2, LoginPersistMode, LoginPersistOptions, } from "./store.js";
export { GrokBuildCredentialStore, grokBuildAuthPath, isValidAccountId, OAUTH_MAX_ACCOUNTS, OAuthCredentialFileStore, oauthCredentialPath, resolveAccountIdForCredential, } from "./store.js";
export type { OwnerRequestPolicy, OwnerRequestPolicyConfig } from "./web-origin.js";
export { createOwnerRequestPolicy, LOOPBACK_OWNER_REQUEST_POLICY, OWNER_CSRF_HEADER, OWNER_PROOF_HEADER, } from "./web-origin.js";
/** Stable Cordis plugin name. */
export declare const name = "llm-grok-build-oauth";
/** Separate API-key credential used only by official xAI Imagine REST calls. */
export declare const XAI_API_KEY_CREDENTIAL = "XAI_API_KEY";
/** Owner-private artifact directory below the resolved DSH home. */
export { IMAGINE_MEDIA_STORE_DIRNAME } from "./ids.js";
/** Optional host services are acquired inside the elected child fiber. */
export declare const inject: readonly ["webServer"];
/** Plugin configuration; every field is optional. */
export interface Config {
    /** HTTP(S) proxy URL for the audited coding-subscription host allowlist. */
    proxy?: string;
    /** Kimi China traffic stays direct unless explicitly opted into the proxy. */
    proxyKimi?: boolean;
    /**
     * Optional provider retry policy override for the four OAuth routes. When
     * omitted, the plugin retries transient failures (rate limit, server,
     * timeout, transport, empty response) plus AUTH — the latter is safe because
     * the stored credential is invalidated on every AUTH finish, so the retried
     * step refreshes before reuse. Quota exhaustion is never retried.
     */
    retryPolicy?: RetryPolicyConfig;
    /** Live Config reference; plain composition values remain accepted by apply(). */
    capabilities?: CapabilitySettingsPatch | CapabilitySettingsReference;
    /** Opt-in isolated local OpenAI-compatible gateway. Default off. */
    gateway?: Partial<GatewayConfig>;
    /** Owner-only request authorization for loopback, SSH tunnels, and trusted HTTPS proxies. */
    ownerRequest?: {
        loopbackAccessMode?: "loopback" | "ssh-tunnel";
        trustedProxy?: {
            peers?: string[];
            origins?: string[];
            ownerProof?: string;
            csrfToken?: string;
        };
    };
}
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    proxy: z<string, string, "plain">;
    proxyKimi: z<boolean, boolean, "defined">;
    retryPolicy: z<RetryPolicyConfig>;
    capabilities: z<NoInfer<Schemastery.ObjectS<NoInfer<{
        codexSearch: z<boolean, boolean, "defined">;
        codexImages: z<boolean, boolean, "defined">;
        codexImageEdits: z<boolean, boolean, "defined">;
        codexImagesAnyModel: z<boolean, boolean, "defined">;
        codexUsage: z<boolean, boolean, "defined">;
        codexFast: z<boolean, boolean, "defined">;
        grokImagineImage: z<boolean, boolean, "defined">;
        grokImagineVideo: z<boolean, boolean, "defined">;
        searchResults: z<number, number, "defined">;
        imageCount: z<number, number, "defined">;
        videoArtifactTtlMs: z<number, number, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        codexSearch: z<boolean, boolean, "defined">;
        codexImages: z<boolean, boolean, "defined">;
        codexImageEdits: z<boolean, boolean, "defined">;
        codexImagesAnyModel: z<boolean, boolean, "defined">;
        codexUsage: z<boolean, boolean, "defined">;
        codexFast: z<boolean, boolean, "defined">;
        grokImagineImage: z<boolean, boolean, "defined">;
        grokImagineVideo: z<boolean, boolean, "defined">;
        searchResults: z<number, number, "defined">;
        imageCount: z<number, number, "defined">;
        videoArtifactTtlMs: z<number, number, "defined">;
    }>>>, "volatile">;
    gateway: z<Partial<GatewayConfig>>;
    ownerRequest: z<Schemastery.ObjectS<NoInfer<{
        loopbackAccessMode: z<"loopback" | "ssh-tunnel", "loopback" | "ssh-tunnel", "plain">;
        trustedProxy: z<Schemastery.ObjectS<NoInfer<{
            peers: z<string[], string[], "plain">;
            origins: z<string[], string[], "plain">;
            ownerProof: z<string, string, "plain">;
            csrfToken: z<string, string, "plain">;
        }>>, Schemastery.ObjectT<NoInfer<{
            peers: z<string[], string[], "plain">;
            origins: z<string[], string[], "plain">;
            ownerProof: z<string, string, "plain">;
            csrfToken: z<string, string, "plain">;
        }>>, "plain">;
    }>>, Schemastery.ObjectT<NoInfer<{
        loopbackAccessMode: z<"loopback" | "ssh-tunnel", "loopback" | "ssh-tunnel", "plain">;
        trustedProxy: z<Schemastery.ObjectS<NoInfer<{
            peers: z<string[], string[], "plain">;
            origins: z<string[], string[], "plain">;
            ownerProof: z<string, string, "plain">;
            csrfToken: z<string, string, "plain">;
        }>>, Schemastery.ObjectT<NoInfer<{
            peers: z<string[], string[], "plain">;
            origins: z<string[], string[], "plain">;
            ownerProof: z<string, string, "plain">;
            csrfToken: z<string, string, "plain">;
        }>>, "plain">;
    }>>, "plain">;
}>>, Schemastery.ObjectT<NoInfer<{
    proxy: z<string, string, "plain">;
    proxyKimi: z<boolean, boolean, "defined">;
    retryPolicy: z<RetryPolicyConfig>;
    capabilities: z<NoInfer<Schemastery.ObjectS<NoInfer<{
        codexSearch: z<boolean, boolean, "defined">;
        codexImages: z<boolean, boolean, "defined">;
        codexImageEdits: z<boolean, boolean, "defined">;
        codexImagesAnyModel: z<boolean, boolean, "defined">;
        codexUsage: z<boolean, boolean, "defined">;
        codexFast: z<boolean, boolean, "defined">;
        grokImagineImage: z<boolean, boolean, "defined">;
        grokImagineVideo: z<boolean, boolean, "defined">;
        searchResults: z<number, number, "defined">;
        imageCount: z<number, number, "defined">;
        videoArtifactTtlMs: z<number, number, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        codexSearch: z<boolean, boolean, "defined">;
        codexImages: z<boolean, boolean, "defined">;
        codexImageEdits: z<boolean, boolean, "defined">;
        codexImagesAnyModel: z<boolean, boolean, "defined">;
        codexUsage: z<boolean, boolean, "defined">;
        codexFast: z<boolean, boolean, "defined">;
        grokImagineImage: z<boolean, boolean, "defined">;
        grokImagineVideo: z<boolean, boolean, "defined">;
        searchResults: z<number, number, "defined">;
        imageCount: z<number, number, "defined">;
        videoArtifactTtlMs: z<number, number, "defined">;
    }>>>, "volatile">;
    gateway: z<Partial<GatewayConfig>>;
    ownerRequest: z<Schemastery.ObjectS<NoInfer<{
        loopbackAccessMode: z<"loopback" | "ssh-tunnel", "loopback" | "ssh-tunnel", "plain">;
        trustedProxy: z<Schemastery.ObjectS<NoInfer<{
            peers: z<string[], string[], "plain">;
            origins: z<string[], string[], "plain">;
            ownerProof: z<string, string, "plain">;
            csrfToken: z<string, string, "plain">;
        }>>, Schemastery.ObjectT<NoInfer<{
            peers: z<string[], string[], "plain">;
            origins: z<string[], string[], "plain">;
            ownerProof: z<string, string, "plain">;
            csrfToken: z<string, string, "plain">;
        }>>, "plain">;
    }>>, Schemastery.ObjectT<NoInfer<{
        loopbackAccessMode: z<"loopback" | "ssh-tunnel", "loopback" | "ssh-tunnel", "plain">;
        trustedProxy: z<Schemastery.ObjectS<NoInfer<{
            peers: z<string[], string[], "plain">;
            origins: z<string[], string[], "plain">;
            ownerProof: z<string, string, "plain">;
            csrfToken: z<string, string, "plain">;
        }>>, Schemastery.ObjectT<NoInfer<{
            peers: z<string[], string[], "plain">;
            origins: z<string[], string[], "plain">;
            ownerProof: z<string, string, "plain">;
            csrfToken: z<string, string, "plain">;
        }>>, "plain">;
    }>>, "plain">;
}>>, "plain">;
/**
 * Register the `grok-build` LLM route with a provider-native OAuth store.
 * @param ctx - plugin context carrying the LLM registry plus optional web server.
 */
export declare function apply(ctx: Context, config?: Config): void;
//# sourceMappingURL=index.d.ts.map