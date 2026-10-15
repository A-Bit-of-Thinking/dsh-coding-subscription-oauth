/** Fixed-account registrations are separate from the legacy/Fast registration owner. */
import type { AttachmentStore } from "@deepseek-ai/dsh-attachment";
import { type LlmAdapter, LlmError } from "@deepseek-ai/dsh-llm";
import { AccountBoundAdapter } from "./account-adapter.ts";
import { type AccountRouteRegistry, type AccountRouteView, publicAccountRoute } from "./account-routes.ts";
import { type ClaudeUsage, type ClaudeUsageReader, createClaudeUsageReader } from "./claude-usage.ts";
import type { OAuthProviderSession } from "./oauth-session.ts";
import type { RoutingConfig } from "./routing-config.ts";

export type AccountRuntimeState = "disabled" | "waiting-for-llm" | "loading" | "ready" | "error";
export type AccountAdapterRegistrar = (routes: string[], adapter: LlmAdapter) => () => void;
export interface RoutedAccountStatus extends AccountRouteView {
	quota: {
		state: "disabled" | "unsupported" | "unknown" | "fresh" | "stale" | "error";
		windows: ClaudeUsage["windows"];
		fetchedAt?: number;
		errorCode?: string;
	};
}
interface Entry {
	adapter: AccountBoundAdapter;
	registration: () => void;
	usage?: ClaudeUsageReader;
	errorCode?: string;
}
export interface AccountRuntimeOptions {
	registry: AccountRouteRegistry;
	sessions: readonly OAuthProviderSession[];
	current(): RoutingConfig;
	resolveAttachments(): AttachmentStore | undefined;
	fetchImpl?: typeof fetch;
	onError?(): void;
}

export class AccountRoutingRuntime {
	private entries = new Map<string, Entry>();
	private registrar: AccountAdapterRegistrar | undefined;
	private epoch = 0;
	private state: "disabled" | "waiting-for-llm" | "loading" | "ready" | "error" = "disabled";
	private disposed = false;
	constructor(private readonly options: AccountRuntimeOptions) {}

	private clear(): void {
		for (const entry of this.entries.values()) {
			entry.adapter.dispose();
			entry.usage?.clear();
			entry.registration();
		}
		this.entries.clear();
	}
	dispose(): void {
		this.disposed = true;
		this.epoch += 1;
		this.clear();
	}

	/** The LLM child may disappear; OAuth/settings ownership remains in the parent. */
	attach(registrar: AccountAdapterRegistrar): () => void {
		this.registrar = registrar;
		void this.reconcile();
		return () => {
			if (this.registrar !== registrar) return;
			this.registrar = undefined;
			this.epoch += 1;
			this.clear();
			this.state = this.options.current().enabled ? "waiting-for-llm" : "disabled";
		};
	}
	/**
	 * Differential: unchanged routes keep their adapter (and any request in flight);
	 * only removed or recreated accounts are withdrawn. A transient read or
	 * metadata error keeps the already validated routes and reports `error`.
	 */
	async reconcile(): Promise<void> {
		const epoch = ++this.epoch;
		if (this.disposed || !this.options.current().enabled) {
			this.clear();
			this.state = "disabled";
			return;
		}
		const registrar = this.registrar;
		if (registrar === undefined) {
			this.clear();
			this.state = "waiting-for-llm";
			return;
		}
		if (this.entries.size === 0) this.state = "loading";
		const stale = (): boolean =>
			epoch !== this.epoch || this.disposed || !this.options.current().enabled || registrar !== this.registrar;
		const added: Entry[] = [];
		try {
			const descriptors = [];
			for (const session of this.options.sessions) {
				// Explicit enablement permits the legacy v1 migration, establishing a stable createdAt.
				for (const row of await session.store.listAccounts({ includeCreatedAt: true })) {
					if (row.createdAt === undefined) throw new Error("Missing account metadata");
					descriptors.push({ family: session.definition.slug, accountId: row.id, createdAt: row.createdAt });
				}
			}
			if (stale()) return;
			const bindings = await this.options.registry.synchronize(descriptors);
			if (stale()) return;
			// No await below: the swap is atomic with respect to other reconciliations.
			const next = new Map<string, Entry>();
			for (const binding of bindings) {
				const current = this.entries.get(binding.route);
				if (
					current !== undefined &&
					current.adapter.binding.accountId === binding.accountId &&
					current.adapter.binding.createdAt === binding.createdAt
				) {
					next.set(binding.route, current);
					continue;
				}
				const session = this.options.sessions.find((value) => value.definition.slug === binding.family)!;
				const adapter = new AccountBoundAdapter(session, binding, this.options.resolveAttachments);
				let registration: (() => void) | undefined;
				try {
					registration = registrar([binding.route], adapter);
				} catch {
					adapter.dispose();
					throw new Error("Account route registration failed");
				}
				const entry: Entry = { adapter, registration };
				added.push(entry);
				if (binding.family === "claude")
					entry.usage = createClaudeUsageReader({
						auth: { resolve: () => adapter.resolveAccess(), isCurrent: (generation) => adapter.isCurrent(generation) },
						...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
					});
				next.set(binding.route, entry);
			}
			for (const [route, entry] of this.entries) {
				if (next.get(route) === entry) continue;
				entry.adapter.dispose();
				entry.usage?.clear();
				entry.registration();
			}
			this.entries = next;
			this.state = "ready";
		} catch {
			// Only what this attempt created is rolled back; validated routes stay.
			for (const entry of added) {
				entry.adapter.dispose();
				entry.usage?.clear();
				entry.registration();
			}
			if (epoch === this.epoch) {
				this.state = "error";
				this.options.onError?.();
			}
		}
	}
	snapshot(): { state: AccountRuntimeState; accounts: readonly RoutedAccountStatus[] } {
		const usageEnabled = this.options.current().usageEnabled;
		return {
			state: this.state,
			accounts: [...this.entries.values()].map((entry) => {
				const cached = entry.usage?.getCached();
				const state = !usageEnabled
					? "disabled"
					: entry.usage === undefined
						? "unsupported"
						: cached === undefined
							? entry.errorCode === undefined
								? "unknown"
								: "error"
							: entry.errorCode !== undefined || Date.now() - cached.fetchedAt >= 300_000
								? "stale"
								: cached.windows.length === 0
									? "unknown"
									: "fresh";
				return {
					...publicAccountRoute(entry.adapter.binding),
					quota: {
						state,
						windows: usageEnabled ? (cached?.windows ?? []) : [],
						...(!usageEnabled || cached === undefined ? {} : { fetchedAt: cached.fetchedAt }),
						...(!usageEnabled || entry.errorCode === undefined ? {} : { errorCode: entry.errorCode }),
					},
				};
			}),
		};
	}

	/** No network occurs in snapshots/prompt assembly; only this explicit opt-in operation reads quotas. */
	async refreshUsage(route?: string, signal?: AbortSignal): Promise<ReturnType<AccountRoutingRuntime["snapshot"]>> {
		if (!this.options.current().usageEnabled) throw new LlmError("Account quota reads are disabled", "INVALID_ARGS");
		const selected = [...this.entries.entries()].filter(([id]) => route === undefined || id === route);
		if (route !== undefined && selected.length === 0)
			throw new LlmError("Account route is unavailable", "INVALID_ARGS");
		await Promise.all(
			selected.map(async ([id, entry]) => {
				if (entry.usage === undefined) return;
				try {
					const deadline = AbortSignal.timeout(20_000);
					await entry.usage.read({ signal: signal === undefined ? deadline : AbortSignal.any([signal, deadline]) });
					if (this.entries.get(id) === entry && this.options.current().usageEnabled) delete entry.errorCode;
				} catch (error) {
					if (this.entries.get(id) !== entry || !this.options.current().usageEnabled) return;
					const codes = ["AUTH", "PERMISSION", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"];
					entry.errorCode = error instanceof LlmError && codes.includes(error.code) ? error.code : "UNAVAILABLE";
				}
			}),
		);
		return this.snapshot();
	}
}
