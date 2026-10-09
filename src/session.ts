/**
 * Shared OAuth store + live catalog for the host plugin and CLI.
 * @module dsh-coding-subscription-oauth/session
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import type { Api, Model, MutableModels, Provider, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import {
	type CatalogSource,
	fetchLiveModels,
	type LiveModelDescriptor,
	materializeLiveModel,
	mergeLiveCatalog,
} from "./catalog.ts";
import { GROK_BUILD_MODELS_CACHE_FILENAME, GROK_BUILD_ROUTE, XAI_PI_PROVIDER } from "./ids.ts";
import { ModelCacheQueue, writeModelCache } from "./model-cache.ts";
import { grokBuildBaselineModels, grokBuildProvider } from "./provider.ts";
import { safeMessage } from "./redact.ts";
import { GrokBuildCredentialStore } from "./store.ts";

const MODELS_CACHE_VERSION = 4;
const CACHE_BYTES_LIMIT = 4 * 1024 * 1024;
const CACHE_ROWS_LIMIT = 4096;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

interface ModelsCacheDocument {
	version: typeof MODELS_CACHE_VERSION;
	selectionMode: "default" | "selected";
	ids: string[];
	selected?: string[];
	models: LiveModelDescriptor[];
	owner?: string;
	fetchedAt: number;
}

interface ParsedCache {
	ids: string[];
	selected?: string[];
	models: LiveModelDescriptor[];
	owner?: string;
	fetchedAt?: number;
}

/** Tokens are compared only in memory, never used as the persisted owner. */
interface CatalogIdentity {
	accountId: string | undefined;
	access: string | undefined;
	refresh: string | undefined;
}

function ownerFor(accountId: string | undefined): string | undefined {
	return accountId === undefined ? undefined : createHash("sha256").update(accountId).digest("hex");
}

function sameIdentity(left: CatalogIdentity | undefined, right: CatalogIdentity): boolean {
	return left?.accountId === right.accountId && left?.access === right.access && left?.refresh === right.refresh;
}

function isENOENT(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function modelsCachePath(dshHome?: string): string {
	return resolve(join(resolveDshHome(dshHome), GROK_BUILD_MODELS_CACHE_FILENAME));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, limit = 256): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= limit;
}

function parseIdList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	// The document byte ceiling bounds this list without narrowing selection IDs.
	return [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0))];
}

/** Whitelist only the small overlay understood by materializeLiveModel. */
function parseOverlays(value: unknown, ids: readonly string[]): LiveModelDescriptor[] {
	if (!Array.isArray(value)) return [];
	const allowed = new Set(ids);
	const seen = new Set<string>();
	const models: LiveModelDescriptor[] = [];
	for (const row of value.slice(0, CACHE_ROWS_LIMIT)) {
		if (!isRecord(row) || !boundedString(row["id"]) || !allowed.has(row["id"]) || seen.has(row["id"])) continue;
		const model: LiveModelDescriptor = { id: row["id"] };
		if (boundedString(row["name"], 512)) model.name = row["name"];
		const context = row["contextWindow"];
		if (typeof context === "number" && Number.isSafeInteger(context) && context > 0) model.contextWindow = context;
		if (typeof row["reasoning"] === "boolean") model.reasoning = row["reasoning"];
		const thinking = row["thinkingLevelMap"];
		if (isRecord(thinking)) {
			const map: ThinkingLevelMap = {};
			let valid = true;
			for (const level of THINKING_LEVELS) {
				const effort = thinking[level];
				if (effort === null || boundedString(effort)) map[level] = effort;
				else if (effort !== undefined) valid = false;
			}
			if (valid && Object.keys(map).length > 0) model.thinkingLevelMap = map;
		}
		seen.add(model.id);
		models.push(model);
	}
	return models;
}

function parseCache(text: string): ParsedCache | undefined {
	if (Buffer.byteLength(text, "utf8") > CACHE_BYTES_LIMIT) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(value)) return undefined;
	if (![1, 2, 3, MODELS_CACHE_VERSION].includes(value["version"] as number)) return undefined;
	const ids = parseIdList(value["ids"]);
	const selected = parseIdList(value["selected"]);
	const hasMode = value["version"] === 3 || value["version"] === MODELS_CACHE_VERSION;
	const explicit = hasMode && value["selectionMode"] === "selected";
	const defaultMode = hasMode && value["selectionMode"] === "default";
	const owner = value["owner"];
	const fetchedAt = value["fetchedAt"];
	return {
		ids,
		models: value["version"] === MODELS_CACHE_VERSION ? parseOverlays(value["models"], ids) : [],
		...(defaultMode || (selected.length === 0 && !explicit) ? {} : { selected }),
		...(value["version"] === MODELS_CACHE_VERSION && typeof owner === "string" && /^[a-f0-9]{64}$/u.test(owner)
			? { owner }
			: {}),
		...(typeof fetchedAt === "number" && Number.isSafeInteger(fetchedAt) && fetchedAt >= 0 ? { fetchedAt } : {}),
	};
}

function asHarnessModels(models: readonly Model<Api>[]): Model<Api>[] {
	return models.map((model) =>
		model.provider === GROK_BUILD_ROUTE ? model : { ...model, provider: GROK_BUILD_ROUTE },
	);
}

/** One process-local owner of the credential and the account model list. */
export class GrokBuildSession {
	readonly store: GrokBuildCredentialStore;
	readonly models: MutableModels;
	private readonly baselineCatalog: readonly Model<Api>[];
	private liveIds: string[] | undefined;
	private liveModels: readonly LiveModelDescriptor[] | undefined;
	private selectedIds: string[] | undefined;
	private selectionLoaded = false;
	private catalogOwner: string | undefined;
	private fetchedAt = 0;
	private identity: CatalogIdentity | undefined;
	private generation = 0;
	private readonly cacheQueue = new ModelCacheQueue();
	private source: CatalogSource = "fallback";
	private listingError: string | undefined;
	private readonly cacheFile: string;
	private onCatalogChange: (() => void) | undefined;

	constructor(store: GrokBuildCredentialStore = new GrokBuildCredentialStore(), onCatalogChange?: () => void) {
		this.store = store;
		this.cacheFile = modelsCachePath();
		this.baselineCatalog = grokBuildBaselineModels();
		// The built-in xai provider owns login/refresh (device flow today); the
		// credential lives in this plugin's own file via the store above.
		this.models = createModels({ credentials: store });
		this.models.setProvider(xaiProvider());
		this.onCatalogChange = onCatalogChange;
	}

	/** Secret-free listing diagnostic from the last refresh. */
	get catalogError(): string | undefined {
		return this.listingError;
	}

	get catalogSource(): CatalogSource {
		return this.source;
	}

	availableModels(): Model<Api>[] {
		return mergeLiveCatalog(this.baselineCatalog, this.liveIds, this.liveModels);
	}

	selectedModelIds(): string[] | undefined {
		return this.selectedIds === undefined ? undefined : [...this.selectedIds];
	}

	visibleModels(): Model<Api>[] {
		const available = this.availableModels();
		if (this.selectedIds === undefined) return available;
		const byId = new Map(available.map((model) => [model.id, model]));
		return this.selectedIds.map((id) => byId.get(id) ?? materializeLiveModel(id, this.baselineCatalog));
	}

	/** Provider whose id matches the harness route so PiAiAdapter can list models. */
	provider(): Provider {
		const visible = this.visibleModels();
		const base = grokBuildProvider(visible);
		return {
			...base,
			getModels: () => asHarnessModels(this.visibleModels()),
		};
	}

	async loadCachedCatalog(): Promise<void> {
		const generation = this.generation;
		try {
			const identity = await this.readIdentity();
			const cache = parseCache(await readFile(this.cacheFile, "utf8"));
			if (cache === undefined || !(await this.isCurrent(generation, identity)) || generation !== this.generation)
				return;
			this.clearDiscovery();
			this.identity = identity;
			if (!this.selectionLoaded) {
				this.selectedIds = cache.selected;
				this.selectionLoaded = true;
			}
			if (cache.owner !== undefined && cache.owner === ownerFor(identity.accountId) && cache.fetchedAt !== undefined) {
				this.liveIds = cache.ids;
				this.liveModels = cache.models;
				this.catalogOwner = cache.owner;
				this.fetchedAt = cache.fetchedAt;
				this.source = cache.ids.length > 0 ? "cache" : "fallback";
			}
		} catch (error) {
			if (!isENOENT(error)) throw error;
		}
	}

	/** Capture before startup barriers; an obsolete continuation cannot start a new generation. */
	deferredCatalogRefresh(): () => Promise<void> {
		const generation = this.generation;
		return () => {
			if (generation !== this.generation) return Promise.resolve();
			return this.refreshLiveCatalog();
		};
	}

	async refreshLiveCatalog(signal?: AbortSignal): Promise<void> {
		const generation = ++this.generation;
		let identity: CatalogIdentity | undefined;
		try {
			if (!this.selectionLoaded) await this.cacheQueue.run(() => this.loadSelectedModelsOnce());
			if (generation !== this.generation) return;
			identity = await this.readIdentity();
			if (generation !== this.generation) return;
			// Login/import and the CLI also enter here without a preceding notify.
			if (!sameIdentity(this.identity, identity) || this.catalogOwner !== ownerFor(identity.accountId)) {
				this.clearDiscovery();
				this.identity = identity;
				await this.cacheQueue.run(() => this.writeCache(this.selectedIds));
				if (!(await this.isCurrent(generation, identity)) || generation !== this.generation) return;
			}
			const auth = await this.models.getAuth(XAI_PI_PROVIDER);
			if (generation !== this.generation) return;
			const afterAuth = await this.readIdentity();
			const access = auth?.auth.apiKey;
			if (
				generation !== this.generation ||
				identity.accountId !== afterAuth.accountId ||
				(access !== undefined && access !== afterAuth.access)
			)
				return;
			// getAuth may legitimately rotate tokens in this same slot. xAI's
			// toAuth uses credential.access; an old auth must not bless an import.
			identity = afterAuth;
			this.identity = identity;
			if (access === undefined || access.length === 0 || identity.accountId === undefined) {
				this.clearDiscovery();
				await this.cacheQueue.run(() => this.writeCache(this.selectedIds));
				return;
			}
			const live = await fetchLiveModels(access, signal);
			const fetchedAt = Date.now();
			const requestIdentity = identity;
			await this.cacheQueue.run(async () => {
				if (!(await this.isCurrent(generation, requestIdentity)) || generation !== this.generation) return;
				const ids = parseIdList(live.map((model) => model.id));
				const models = parseOverlays(live, ids);
				const owner = ownerFor(requestIdentity.accountId);
				await this.writeCache(this.selectedIds, { ids, models, owner, fetchedAt });
				if (!(await this.isCurrent(generation, requestIdentity)) || generation !== this.generation) {
					// A newer request/credential change can arrive during atomic disk I/O.
					// Restore the last published snapshot before releasing the queue.
					await this.writeCache(this.selectedIds);
					return;
				}
				this.liveIds = ids;
				this.liveModels = models;
				this.catalogOwner = owner;
				this.fetchedAt = fetchedAt;
				this.source = "live";
				this.listingError = undefined;
			});
		} catch (error) {
			if (generation !== this.generation) return;
			if (identity !== undefined && !(await this.isCurrent(generation, identity).catch(() => false))) return;
			if (generation !== this.generation) return;
			this.listingError = safeMessage(error);
			if (this.liveIds === undefined) this.source = "fallback";
		} finally {
			// Only the current operation may reveal the fallback or publish a result.
			if (
				generation === this.generation &&
				(identity === undefined || (await this.isCurrent(generation, identity).catch(() => false))) &&
				generation === this.generation
			) {
				this.onCatalogChange?.();
			}
		}
	}

	async setSelectedModels(ids: readonly string[] | undefined): Promise<void> {
		const selected = ids === undefined ? undefined : [...new Set(ids.filter((id) => id.length > 0))];
		await this.cacheQueue.run(async () => {
			await this.writeCache(selected);
			this.selectedIds = selected;
			this.selectionLoaded = true;
			this.onCatalogChange?.();
		});
	}

	/**
	 * Backdate the stored token's expiry so the next `getAuth()` refreshes.
	 * Called after an upstream 401 rejected a locally-valid token.
	 */
	async invalidateAccessToken(): Promise<void> {
		await this.store.invalidate(XAI_PI_PROVIDER);
	}

	/** Invalidate synchronously; routes never wait for the network rediscovery. */
	notifyCredentialChange(): void {
		const generation = ++this.generation;
		this.clearDiscovery();
		this.identity = undefined;
		// This queued reset also repairs a write already in flight for the old slot.
		const reset = this.cacheQueue.run(async () => {
			await this.loadSelectedModelsOnce();
			await this.writeCache(this.selectedIds);
		});
		void reset
			.catch((error: unknown) => {
				if (generation === this.generation) this.listingError = safeMessage(error);
			})
			.then(() => {
				if (generation === this.generation) return this.refreshLiveCatalog();
			})
			.catch(() => undefined);
		this.onCatalogChange?.();
	}

	async logout(): Promise<void> {
		++this.generation;
		this.clearDiscovery();
		this.identity = undefined;
		return this.cacheQueue.run(async () => {
			try {
				await this.store.delete(XAI_PI_PROVIDER);
				this.selectedIds = undefined;
				this.selectionLoaded = true;
				await mkdir(dirname(this.cacheFile), { recursive: true, mode: 0o700 });
				await rm(this.cacheFile, { force: true });
			} finally {
				// Credential deletion may succeed before cache cleanup fails.
				this.onCatalogChange?.();
			}
		});
	}

	/** CLI login/import may refresh a fresh session without loading discovery first. */
	private async loadSelectedModelsOnce(): Promise<void> {
		if (this.selectionLoaded) return;
		try {
			const cache = parseCache(await readFile(this.cacheFile, "utf8"));
			if (!this.selectionLoaded) this.selectedIds = cache?.selected;
		} catch (error) {
			if (!isENOENT(error)) throw error;
		}
		this.selectionLoaded = true;
	}

	private clearDiscovery(): void {
		this.liveIds = undefined;
		this.liveModels = undefined;
		this.catalogOwner = undefined;
		this.fetchedAt = 0;
		this.source = "fallback";
		this.listingError = undefined;
	}

	private async readIdentity(): Promise<CatalogIdentity> {
		const accountId = await this.store.getActiveAccountId({ readOnly: true });
		const credential = await this.store.read(XAI_PI_PROVIDER);
		return {
			accountId,
			access: credential?.type === "oauth" ? credential.access : undefined,
			refresh: credential?.type === "oauth" ? credential.refresh : undefined,
		};
	}

	/** Callers must recheck generation synchronously after awaiting this observation. */
	private async isCurrent(generation: number, identity: CatalogIdentity): Promise<boolean> {
		if (generation !== this.generation) return false;
		const current = await this.readIdentity();
		return generation === this.generation && sameIdentity(identity, current);
	}

	private async writeCache(
		selected: string[] | undefined,
		discovery?: { ids: string[]; models: LiveModelDescriptor[]; owner: string | undefined; fetchedAt: number },
	): Promise<void> {
		const owner = discovery?.owner ?? this.catalogOwner;
		let document: ModelsCacheDocument = {
			version: MODELS_CACHE_VERSION,
			ids: discovery?.ids ?? (this.liveIds === undefined ? [] : [...this.liveIds]),
			models: discovery?.models ?? (this.liveModels === undefined ? [] : [...this.liveModels]),
			selectionMode: selected === undefined ? "default" : "selected",
			fetchedAt: discovery?.fetchedAt ?? this.fetchedAt,
			...(owner === undefined ? {} : { owner }),
			...(selected === undefined ? {} : { selected: [...selected] }),
		};
		// The generic writer appends a newline. Never produce a document our
		// bounded reader would discard, especially one carrying explicit [].
		if (Buffer.byteLength(JSON.stringify(document), "utf8") + 1 > CACHE_BYTES_LIMIT) {
			document = {
				version: MODELS_CACHE_VERSION,
				ids: [],
				models: [],
				selectionMode: selected === undefined ? "default" : "selected",
				fetchedAt: 0,
				...(selected === undefined ? {} : { selected: [...selected] }),
			};
			if (Buffer.byteLength(JSON.stringify(document), "utf8") + 1 > CACHE_BYTES_LIMIT) {
				throw new Error("Grok Build model selection exceeds the 4 MiB cache ceiling");
			}
		}
		await writeModelCache(this.cacheFile, document);
	}
}
