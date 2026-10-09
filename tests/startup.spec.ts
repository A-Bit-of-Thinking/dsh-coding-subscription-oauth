import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CODING_OAUTH_STATUS_PATH } from "../src/auth-routes.ts";
import { CAPABILITY_SETTINGS_PATH } from "../src/capability-routes.ts";
import {
	type CapabilitySettingsPatch,
	CapabilitySettingsSchema,
	type CapabilitySettingsScope,
	type CapabilitySettingsService,
	normalizeCapabilitySettings,
} from "../src/capability-settings.ts";
import { GrokImagineClient } from "../src/grok-imagine.ts";
import { GROK_BUILD_MODELS_CACHE_FILENAME } from "../src/ids.ts";
import { apply, Config } from "../src/index.ts";
import { MediaStore } from "../src/media-store.ts";
import { OAuthProviderSession } from "../src/oauth-session.ts";
import { GrokBuildSession } from "../src/session.ts";

const temporaryDirectories: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const dir of temporaryDirectories.splice(0)) await rm(dir, { recursive: true, force: true });
});

function runFiber(callback?: () => unknown) {
	let startupError: unknown;
	let cleanup: (() => void | Promise<void>) | undefined;
	const startup = Promise.resolve()
		.then(async () => {
			const result = await callback?.();
			if (typeof result === "function") cleanup = result as () => void | Promise<void>;
		})
		.catch((error) => {
			startupError = error;
		});
	return {
		async await() {
			await startup;
			if (startupError !== undefined) throw startupError;
		},
		async dispose() {
			await startup;
			await cleanup?.();
		},
	};
}

function requiredWebContext(): Context {
	return {
		webServer: { register: vi.fn(() => vi.fn()) },
		get: vi.fn(() => undefined),
		effect: vi.fn((setup: () => unknown) => setup()),
	} as unknown as Context;
}

function liveSettings(initial: CapabilitySettingsPatch): {
	service: CapabilitySettingsService;
	set(next: CapabilitySettingsPatch): void;
	watcherCount(): number;
} {
	let value: CapabilitySettingsPatch = initial;
	const watchers = new Set<(next: unknown, prev: unknown) => void | Promise<void>>();
	const scope: CapabilitySettingsScope = {
		get: () => value,
		watch: (callback) => {
			watchers.add(callback);
			return () => {
				watchers.delete(callback);
			};
		},
		update: async () => undefined,
		replace: async () => undefined,
	};
	return {
		service: {
			writable: true,
			register: () => scope,
		},
		set(next) {
			const previous = value;
			value = next;
			for (const watcher of [...watchers]) void watcher(next, previous);
		},
		watcherCount: () => watchers.size,
	};
}

describe("plugin startup catalog initialization", () => {
	it("captures the owner's deferred refresh before all cache loads and cancels it on logout", async () => {
		const directory = await mkdtemp(join(tmpdir(), "grok-startup-generation-"));
		temporaryDirectories.push(directory);
		vi.stubEnv("DSH_HOME", directory);
		let session!: GrokBuildSession;
		let releaseOtherLoad!: () => void;
		let loading!: () => void;
		let initialized!: () => void;
		const otherLoad = new Promise<void>((resolve) => {
			releaseOtherLoad = resolve;
		});
		const started = new Promise<void>((resolve) => {
			loading = resolve;
		});
		const completed = new Promise<void>((resolve) => {
			initialized = resolve;
		});
		const order: string[] = [];
		const capture = GrokBuildSession.prototype.deferredCatalogRefresh;
		vi.spyOn(GrokBuildSession.prototype, "deferredCatalogRefresh").mockImplementation(function (
			this: GrokBuildSession,
		) {
			session = this;
			order.push("capture");
			const refresh = capture.call(this);
			return async () => {
				try {
					await refresh();
				} finally {
					initialized();
				}
			};
		});
		vi.spyOn(GrokBuildSession.prototype, "loadCachedCatalog").mockImplementation(async () => {
			order.push("grok-load");
		});
		vi.spyOn(OAuthProviderSession.prototype, "loadCachedModels")
			.mockResolvedValue(undefined)
			.mockImplementationOnce(() => {
				order.push("other-load");
				loading();
				return otherLoad;
			});
		const refresh = vi.spyOn(GrokBuildSession.prototype, "refreshLiveCatalog").mockResolvedValue(undefined);
		const emit = vi.fn();
		const requiredWeb = requiredWebContext();
		const disposers: Array<() => void | Promise<void>> = [];
		const context = {
			webServer: requiredWeb.webServer,
			logger: () => ({ warn: vi.fn() }),
			emit,
			get: vi.fn(() => undefined),
			effect: vi.fn((setup: () => unknown) => {
				const cleanup = setup();
				if (typeof cleanup === "function") disposers.push(cleanup as () => void | Promise<void>);
			}),
			inject: vi.fn((services: readonly string[], callback: (ctx: Context) => unknown) => {
				if (services.length === 0) return runFiber(() => callback(context));
				if (services.length === 1 && services[0] === "webServer") return runFiber(() => callback(requiredWeb));
				return runFiber();
			}),
		} as unknown as Context;
		apply(context, {});
		await started;
		expect(order).toEqual(["capture", "grok-load", "other-load"]);
		const auth = vi.spyOn(session.models, "getAuth").mockResolvedValue(undefined);
		await session.logout();
		releaseOtherLoad();
		await completed;
		expect(refresh).not.toHaveBeenCalled();
		expect(auth).not.toHaveBeenCalled();
		expect(emit).toHaveBeenCalledOnce();
		await expect(readFile(join(directory, GROK_BUILD_MODELS_CACHE_FILENAME))).rejects.toMatchObject({ code: "ENOENT" });
		await Promise.all(disposers.map((dispose) => dispose()));
	});

	it("keeps owner Web routes alive across optional LLM activation, unload, and reload", async () => {
		vi.spyOn(GrokBuildSession.prototype, "loadCachedCatalog").mockResolvedValue(undefined);
		vi.spyOn(OAuthProviderSession.prototype, "loadCachedModels").mockResolvedValue(undefined);
		vi.spyOn(GrokBuildSession.prototype, "refreshLiveCatalog").mockResolvedValue(undefined);
		const routeDisposers: Array<() => void | Promise<void>> = [];
		const llmDisposers: Array<() => void | Promise<void>> = [];
		const registeredPaths = new Set<string>();
		const register = vi.fn((route: { path: string }) => {
			if (registeredPaths.has(route.path)) throw new Error(`duplicate route ${route.path}`);
			registeredPaths.add(route.path);
			return () => {
				registeredPaths.delete(route.path);
			};
		});
		const registration = Object.assign(vi.fn(), { replace: vi.fn() });
		const registerAdapter = vi.fn(() => registration);
		let activateLlm: ((ctx: Context) => unknown) | undefined;
		const webCtx = {
			webServer: { register },
			effect: vi.fn((setup: () => (() => void | Promise<void>) | undefined) => {
				const dispose = setup();
				if (dispose !== undefined) routeDisposers.push(dispose);
			}),
		} as unknown as Context;
		const llmCtx = {
			llm: { registerAdapter, resolveModelInfo: vi.fn() },
			get: vi.fn(() => undefined),
			logger: () => ({ warn: vi.fn() }),
			effect: vi.fn((setup: () => (() => void | Promise<void>) | undefined) => {
				const dispose = setup();
				if (dispose !== undefined) llmDisposers.push(dispose);
			}),
			inject: vi.fn(),
		} as unknown as Context;
		const ownerCtx = {
			webServer: webCtx.webServer,
			logger: () => ({ warn: vi.fn() }),
			emit: vi.fn(),
			effect: vi.fn((setup: () => (() => void | Promise<void>) | undefined) => setup()),
			get: vi.fn(() => undefined),
			inject: vi.fn((services: readonly string[], callback: (ctx: Context) => unknown) => {
				if (services.length === 1 && services[0] === "llm") {
					activateLlm = callback;
					return runFiber();
				}
				if (services.length === 1 && services[0] === "webServer") return runFiber(() => callback(webCtx));
				return runFiber();
			}),
		} as unknown as Context;
		const context = {
			...ownerCtx,
			inject: vi.fn((services: readonly string[], callback: (ctx: Context) => unknown) => {
				return services.length === 0 ? runFiber(() => callback(ownerCtx)) : runFiber();
			}),
		} as unknown as Context;

		apply(context, {});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(registeredPaths).toContain(CODING_OAUTH_STATUS_PATH);
		expect(registeredPaths).toContain(CAPABILITY_SETTINGS_PATH);
		expect(registerAdapter).not.toHaveBeenCalled();
		const webRouteCount = registeredPaths.size;

		activateLlm?.(llmCtx);
		expect(registerAdapter).toHaveBeenCalledOnce();
		expect(registeredPaths.size).toBe(webRouteCount);

		await Promise.all(llmDisposers.map((dispose) => dispose()));
		expect(registration).toHaveBeenCalledOnce();
		expect(registeredPaths.size).toBe(webRouteCount);

		llmDisposers.length = 0;
		activateLlm?.(llmCtx);
		expect(registerAdapter).toHaveBeenCalledTimes(2);
		expect(registeredPaths.size).toBe(webRouteCount);
		await Promise.all(routeDisposers.map((dispose) => dispose()));
	});

	it("applies composition capability defaults before an optional settings service exists", async () => {
		vi.spyOn(GrokBuildSession.prototype, "loadCachedCatalog").mockResolvedValue(undefined);
		vi.spyOn(OAuthProviderSession.prototype, "loadCachedModels").mockResolvedValue(undefined);
		vi.spyOn(GrokBuildSession.prototype, "refreshLiveCatalog").mockResolvedValue(undefined);
		const registration = Object.assign(vi.fn(), { replace: vi.fn() });
		const registerSearchProvider = vi.fn(() => vi.fn());
		const requiredWeb = requiredWebContext();
		const child = {
			get: vi.fn((name: string) => (name === "web" ? { registerSearchProvider } : undefined)),
			effect: vi.fn((setup: () => unknown) => setup()),
		};
		const context = {
			webServer: requiredWeb.webServer,
			logger: () => ({ warn: vi.fn() }),
			emit: vi.fn(),
			effect: vi.fn((setup: () => unknown) => setup()),
			llm: { registerAdapter: vi.fn(() => registration) },
			get: vi.fn(() => undefined),
			inject: vi.fn((services: readonly string[], callback: (ctx: unknown) => void) => {
				if (services.length === 0) return runFiber(() => callback(context));
				if (services.length === 1 && services[0] === "llm") return runFiber(() => callback(context));
				if (services.length === 1 && services[0] === "web") return runFiber(() => callback(child));
				if (services.length === 1 && services[0] === "webServer") return runFiber(() => callback(requiredWeb));
				return runFiber();
			}),
		} as unknown as Context;

		apply(context, { capabilities: { codexSearch: true, searchResults: 3 } });
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(registerSearchProvider).toHaveBeenCalledOnce();
	});

	it("releases an obsolete settings watcher before reinjection and restores composition defaults on dispose", async () => {
		vi.spyOn(GrokBuildSession.prototype, "loadCachedCatalog").mockResolvedValue(undefined);
		vi.spyOn(OAuthProviderSession.prototype, "loadCachedModels").mockResolvedValue(undefined);
		vi.spyOn(GrokBuildSession.prototype, "refreshLiveCatalog").mockResolvedValue(undefined);
		const registration = Object.assign(vi.fn(), { replace: vi.fn() });
		const searchReleases: ReturnType<typeof vi.fn>[] = [];
		const registerSearchProvider = vi.fn(() => {
			const release = vi.fn();
			searchReleases.push(release);
			return release;
		});
		const requiredWeb = requiredWebContext();
		let settingsInjection: ((ctx: Context) => void) | undefined;
		const webCtx = {
			get: vi.fn((service: string) => (service === "web" ? { registerSearchProvider } : undefined)),
			effect: vi.fn((setup: () => unknown) => setup()),
		} as unknown as Context;
		const context = {
			logger: () => ({ warn: vi.fn() }),
			emit: vi.fn(),
			effect: vi.fn(),
			llm: { registerAdapter: vi.fn(() => registration) },
			get: vi.fn(() => undefined),
			inject: vi.fn((services: readonly string[], callback: (ctx: Context) => void) => {
				if (services.length === 0) return runFiber(() => callback(context));
				if (services.length === 1 && services[0] === "llm") return runFiber(() => callback(context));
				if (services.length === 1 && services[0] === "settings") {
					settingsInjection = callback;
					return runFiber();
				}
				if (services.length === 1 && services[0] === "web") return runFiber(() => callback(webCtx));
				if (services.length === 1 && services[0] === "webServer") return runFiber(() => callback(requiredWeb));
				return runFiber();
			}),
		} as unknown as Context;

		apply(context, { capabilities: { codexSearch: false } });
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(settingsInjection).toBeDefined();
		expect(registerSearchProvider).not.toHaveBeenCalled();

		const attach = (live: ReturnType<typeof liveSettings>): (() => void) => {
			let release = (): void => undefined;
			const child = {
				get: vi.fn((service: string) => (service === "settings" ? live.service : undefined)),
				effect: vi.fn((setup: () => () => void) => {
					release = setup();
				}),
				inject: vi.fn(),
			} as unknown as Context;
			settingsInjection!(child);
			return () => release();
		};

		const first = liveSettings({ codexSearch: true });
		attach(first);
		expect(first.watcherCount()).toBe(1);
		expect(registerSearchProvider).toHaveBeenCalledOnce();

		const second = liveSettings({ codexSearch: false });
		const releaseSecond = attach(second);
		expect(first.watcherCount()).toBe(0);
		expect(searchReleases[0]).toHaveBeenCalledOnce();
		first.set({ codexSearch: true });
		expect(registerSearchProvider).toHaveBeenCalledOnce();

		second.set({ codexSearch: true });
		expect(registerSearchProvider).toHaveBeenCalledTimes(2);
		releaseSecond();
		expect(second.watcherCount()).toBe(0);
		expect(searchReleases[1]).toHaveBeenCalledOnce();
	});

	it("reads volatile Config at startup and cleans modern host event listeners across settings churn", async () => {
		vi.spyOn(GrokBuildSession.prototype, "loadCachedCatalog").mockResolvedValue(undefined);
		vi.spyOn(OAuthProviderSession.prototype, "loadCachedModels").mockResolvedValue(undefined);
		vi.spyOn(GrokBuildSession.prototype, "refreshLiveCatalog").mockResolvedValue(undefined);
		const entryNamespace = "custom-oauth-entry";
		const registration = Object.assign(vi.fn(), { replace: vi.fn() });
		const searchReleases: ReturnType<typeof vi.fn>[] = [];
		const registerSearchProvider = vi.fn(() => {
			const release = vi.fn();
			searchReleases.push(release);
			return release;
		});
		const requiredWeb = requiredWebContext();
		let settingsInjection: ((ctx: Context) => void) | undefined;
		const webCtx = {
			get: (name: string) => (name === "web" ? { registerSearchProvider } : undefined),
			effect: (setup: () => unknown) => setup(),
		} as unknown as Context;
		const context = {
			fiber: { entry: { id: "nested/path/custom-oauth-entry", options: { id: entryNamespace } } },
			logger: () => ({ warn: vi.fn() }),
			emit: vi.fn(),
			effect: vi.fn(),
			llm: { registerAdapter: vi.fn(() => registration) },
			get: () => undefined,
			inject: (services: readonly string[], callback: (ctx: Context) => unknown) => {
				if (services.length === 0) return runFiber(() => callback(context));
				if (services.join() === "llm") return runFiber(() => callback(context));
				if (services.join() === "settings") {
					settingsInjection = callback;
					return runFiber();
				}
				if (services.join() === "web") return runFiber(() => callback(webCtx));
				if (services.join() === "webServer") return runFiber(() => callback(requiredWeb));
				return runFiber();
			},
		} as unknown as Context;
		apply(context, Config({ capabilities: { codexSearch: true } }));
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(registerSearchProvider).toHaveBeenCalledOnce();

		const attach = () => {
			let value: CapabilitySettingsPatch = { codexSearch: false };
			let revision = 0;
			const listeners = new Set<(ns: string, revision: number) => void>();
			let release = () => undefined;
			const service: CapabilitySettingsService = {
				writable: true,
				describe: () => [
					{
						ns: entryNamespace,
						revision,
						schema: Schema.object({ capabilities: CapabilitySettingsSchema }).toJSON(),
						value: { capabilities: normalizeCapabilitySettings(value) },
						base: { capabilities: {} },
						user: { capabilities: value },
					},
				],
				update: vi.fn(async () => undefined),
				mutate: vi.fn(async () => undefined),
			};
			settingsInjection!({
				get: (name: string) => (name === "settings" ? service : undefined),
				on: (event: string, listener: (ns: string, revision: number) => void) => {
					expect(event).toBe("settings/document-updated");
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				effect: (setup: () => () => undefined) => {
					release = setup();
				},
			} as unknown as Context);
			return {
				count: () => listeners.size,
				release: () => release(),
				set(next: CapabilitySettingsPatch) {
					value = next;
					revision++;
					for (const listener of listeners) listener(entryNamespace, revision);
				},
			};
		};
		const first = attach();
		expect(first.count()).toBe(1);
		expect(searchReleases[0]).toHaveBeenCalledOnce();
		first.set({ codexSearch: true });
		await Promise.resolve();
		expect(registerSearchProvider).toHaveBeenCalledTimes(2);
		const second = attach();
		expect(first.count()).toBe(0);
		expect(second.count()).toBe(1);
		expect(searchReleases[1]).toHaveBeenCalledOnce();
		first.release(); // A late obsolete fiber disposer must not release the new bridge.
		first.set({ codexSearch: true });
		await Promise.resolve();
		expect(registerSearchProvider).toHaveBeenCalledTimes(2);
		second.set({ codexSearch: true });
		await Promise.resolve();
		expect(registerSearchProvider).toHaveBeenCalledTimes(3);
		second.set({ codexSearch: false });
		second.release();
		await Promise.resolve();
		expect(second.count()).toBe(0);
		expect(registerSearchProvider).toHaveBeenCalledTimes(3);
		expect(searchReleases[2]).not.toHaveBeenCalled(); // Parsed startup reference remains enabled.
	});

	it("aborts the Imagine client before asynchronous media cleanup during injected-service teardown", async () => {
		vi.spyOn(GrokBuildSession.prototype, "loadCachedCatalog").mockResolvedValue(undefined);
		vi.spyOn(OAuthProviderSession.prototype, "loadCachedModels").mockResolvedValue(undefined);
		vi.spyOn(GrokBuildSession.prototype, "refreshLiveCatalog").mockResolvedValue(undefined);
		const order: string[] = [];
		const originalDispose = GrokImagineClient.prototype.dispose;
		vi.spyOn(GrokImagineClient.prototype, "dispose").mockImplementation(function disposeImagine(
			this: GrokImagineClient,
		) {
			order.push("dispose");
			originalDispose.call(this);
		});
		vi.spyOn(MediaStore.prototype, "cleanup").mockImplementation(async () => {
			order.push("cleanup");
			return { expiredArtifacts: 0, removedObjects: 0 };
		});
		const effects: Array<{ label?: string; setup: () => unknown }> = [];
		const pending: Promise<unknown>[] = [];
		const attachments = {
			imageLimits: {
				maxImageBytes: 1024,
				maxImagesPerMessage: 4,
				maxMessageImageBytes: 4096,
				mediaTypes: ["image/png"],
			},
			validateImage: async () => undefined,
			saveImage: async () => ({
				attachmentId: `sha256:${"ab".repeat(32)}`,
				mediaType: "image/png",
				bytes: 1,
				width: 1,
				height: 1,
			}),
			readImage: async () => {
				throw new Error("not used");
			},
		};
		const services: Record<string, unknown> = {
			tools: { register: vi.fn(() => vi.fn()) },
			attachments,
			credentials: { resolve: async () => undefined },
			webServer: { register: vi.fn(() => vi.fn()) },
		};
		const toolCtx = {
			...services,
			get: vi.fn((service: string) => services[service]),
			effect: vi.fn((setup: () => unknown, label?: string) => {
				effects.push({ setup, ...(label === undefined ? {} : { label }) });
			}),
		} as unknown as Context;
		const registration = Object.assign(vi.fn(), { replace: vi.fn() });
		const context = {
			logger: () => ({ warn: vi.fn() }),
			emit: vi.fn(),
			effect: vi.fn(),
			llm: {
				registerAdapter: vi.fn(() => registration),
				resolveModelInfo: vi.fn(),
			},
			get: vi.fn(() => undefined),
			inject: vi.fn((requested: readonly string[], callback: (ctx: Context) => unknown) => {
				if (requested.length === 0) return runFiber(() => callback(context));
				if (requested.length === 1 && requested[0] === "llm") return runFiber(() => callback(context));
				if (requested.length === 1 && requested[0] === "webServer") return runFiber(() => callback(toolCtx));
				if (requested.join(",") !== "tools,attachments,credentials,webServer") return runFiber();
				const fiber = runFiber(() => callback(toolCtx));
				pending.push(fiber.await());
				return fiber;
			}),
		} as unknown as Context;

		apply(context, {});
		await new Promise<void>((resolve) => setImmediate(resolve));
		await Promise.all(pending);
		order.length = 0;
		expect(effects.some((effect) => effect.label?.includes("imagine download routes") === true)).toBe(true);
		const lifetime = effects.find((effect) => effect.label?.includes("Imagine client and media lifetime") === true);
		expect(lifetime).toBeDefined();
		const dispose = lifetime!.setup();
		expect(dispose).toBeTypeOf("function");
		await (dispose as () => void | Promise<void>)();
		expect(order).toEqual(["dispose", "cleanup"]);
	});

	it("contains cache and refresh failures while registering the adapter", async () => {
		vi.spyOn(GrokBuildSession.prototype, "loadCachedCatalog").mockRejectedValue(new Error("grok cache failed"));
		vi.spyOn(OAuthProviderSession.prototype, "loadCachedModels").mockRejectedValue(new Error("oauth cache failed"));
		const refresh = vi
			.spyOn(GrokBuildSession.prototype, "refreshLiveCatalog")
			.mockRejectedValue(new Error("refresh failed"));
		const warn = vi.fn();
		const registration = Object.assign(vi.fn(), { replace: vi.fn() });
		const registerAdapter = vi.fn(() => registration);
		const requiredWeb = requiredWebContext();
		const context = {
			webServer: requiredWeb.webServer,
			logger: () => ({ warn }),
			emit: vi.fn(),
			effect: vi.fn((setup: () => unknown) => setup()),
			llm: { registerAdapter },
			get: vi.fn(() => undefined),
			inject: vi.fn((requested: readonly string[], callback: (ctx: Context) => unknown) => {
				if (requested.length === 0) return runFiber(() => callback(context));
				if (requested.length === 1 && requested[0] === "llm") return runFiber(() => callback(context));
				if (requested.length === 1 && requested[0] === "webServer") return runFiber(() => callback(requiredWeb));
				return runFiber();
			}),
		} as unknown as Context;

		apply(context, {});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(registerAdapter).toHaveBeenCalledOnce();

		await new Promise<void>((resolve) => setImmediate(resolve));
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(refresh).toHaveBeenCalledOnce();
		expect(warn).toHaveBeenCalledWith("one or more OAuth model caches could not be loaded; using in-memory fallbacks");
		expect(warn).toHaveBeenCalledWith("background OAuth model catalog initialization failed; using static fallbacks");
	});
});
