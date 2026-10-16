import type { AttachmentStore } from "@deepseek-ai/dsh-attachment";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import * as llm from "@deepseek-ai/dsh-llm";
import type { AccountRouteBinding } from "./account-routes.js";
import type { OAuthProviderSession } from "./oauth-session.js";
export declare class AccountBoundAdapter extends llm.LlmAdapter {
    private readonly session;
    private readonly resolveAttachments;
    private alive;
    private readonly scope;
    private readonly tokens;
    private readonly catalog;
    /**
     * Read lazily by providerInfo (never captured at construction): a rename or a change of
     * default account only mutates this field, so no entry is recreated and no request is cut.
     */
    private displayName;
    readonly binding: AccountRouteBinding;
    constructor(session: OAuthProviderSession, binding: AccountRouteBinding, resolveAttachments: () => AttachmentStore | undefined);
    /** Called synchronously on withdrawal; already sent streams may finish, never refresh a replacement. */
    dispose(): void;
    /** Name shown by the model picker; takes effect for the next providerInfo call. */
    setDisplayName(name: string): void;
    /** The default account is listed through the legacy route; this fixed route stays usable but is hidden. */
    private isDefaultAccount;
    private assertCurrent;
    private generation;
    /** Internal auth for quota readers only; never serialize this result to API/tools. */
    resolveAccess(): Promise<{
        accessToken: string;
        generation: string;
        accountId?: string;
    }>;
    /**
     * Marks the stored access token expired when it is still the rejected one, so the next resolveAccess
     * refreshes instead of replaying it. A token already replaced by another refresh is left alone.
     */
    invalidateAccess(rejected: string | undefined): Promise<void>;
    isCurrent(generation: string): Promise<boolean>;
    private makeAdapter;
    providerInfo(provider: string): llm.LlmProviderInfo;
    providerRetryPolicy(provider: string): llm.ResolvedRetryPolicy | undefined;
    /** Hidden (empty) while this account is the default one; resolveModel and stream are unaffected. */
    listModels(provider: string): Promise<readonly llm.LlmModelInfo[]>;
    resolveModel(provider: string, model: string): Promise<llm.LlmResolvedModelInfo>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
//# sourceMappingURL=account-adapter.d.ts.map