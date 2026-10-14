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
    readonly binding: AccountRouteBinding;
    constructor(session: OAuthProviderSession, binding: AccountRouteBinding, resolveAttachments: () => AttachmentStore | undefined);
    /** Called synchronously on withdrawal; already sent streams may finish, never refresh a replacement. */
    dispose(): void;
    private assertCurrent;
    private generation;
    /** Internal auth for quota readers only; never serialize this result to API/tools. */
    resolveAccess(): Promise<{
        accessToken: string;
        generation: string;
        accountId?: string;
    }>;
    isCurrent(generation: string): Promise<boolean>;
    private makeAdapter;
    providerInfo(provider: string): llm.LlmProviderInfo;
    providerRetryPolicy(provider: string): llm.ResolvedRetryPolicy | undefined;
    listModels(provider: string): Promise<readonly llm.LlmModelInfo[]>;
    resolveModel(provider: string, model: string): Promise<llm.LlmResolvedModelInfo>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
//# sourceMappingURL=account-adapter.d.ts.map