import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLiveModels, type LiveModelDescriptor } from "../src/catalog.ts";
import { GROK_BUILD_MODELS_CACHE_FILENAME, GROK_BUILD_ROUTE } from "../src/ids.ts";
import { writeModelCache } from "../src/model-cache.ts";
import { GrokBuildSession } from "../src/session.ts";
import { GrokBuildCredentialStore } from "../src/store.ts";

vi.mock("../src/catalog.ts", async (original) => ({
	...(await original<typeof import("../src/catalog.ts")>()),
	fetchLiveModels: vi.fn(),
}));
vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof import("node:fs/promises")>();
	return { ...actual, readFile: vi.fn(actual.readFile) };
});
vi.mock("../src/model-cache.ts", async (original) => {
	const actual = await original<typeof import("../src/model-cache.ts")>();
	return { ...actual, writeModelCache: vi.fn(actual.writeModelCache) };
});

const dirs: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
	vi.unstubAllEnvs();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function listing() {
	const started = deferred<void>();
	const result = deferred<LiveModelDescriptor[]>();
	vi.mocked(fetchLiveModels).mockImplementationOnce(() => {
		started.resolve();
		return result.promise;
	});
	return { started: started.promise, ...result };
}

function owner(id: string) {
	return createHash("sha256").update(id).digest("hex");
}

async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "grok-catalog-state-"));
	dirs.push(dir);
	vi.stubEnv("DSH_HOME", dir);
	// No default home, vendor calls, or operator credentials are used.
	const state = { accountId: "slot-a" as string | undefined, access: "EXAMPLE_ACCESS_A", refresh: "EXAMPLE_REFRESH_A" };
	const store = new GrokBuildCredentialStore(join(dir, "auth.json"));
	vi.spyOn(store, "getActiveAccountId").mockImplementation(async () => state.accountId);
	vi.spyOn(store, "read").mockImplementation(async () =>
		state.accountId === undefined
			? undefined
			: { type: "oauth", access: state.access, refresh: state.refresh, expires: Date.now() + 3600000 },
	);
	vi.spyOn(store, "delete").mockImplementation(async () => {
		state.accountId = undefined;
	});
	const notify = vi.fn();
	const session = new GrokBuildSession(store, notify);
	vi.spyOn(session.models, "getAuth").mockImplementation(async () =>
		state.accountId === undefined ? undefined : { auth: { apiKey: state.access } },
	);
	const file = join(dir, GROK_BUILD_MODELS_CACHE_FILENAME);
	const cache = async () => JSON.parse(await readFile(file, "utf8"));
	return { dir, file, state, store, notify, session, cache };
}

async function discover(session: GrokBuildSession, models: LiveModelDescriptor[] = [{ id: "model-a" }]) {
	const pending = listing();
	const refresh = session.refreshLiveCatalog();
	await pending.started;
	pending.resolve(models);
	await refresh;
}

async function settledBackground(notify: ReturnType<typeof vi.fn>, count: number) {
	await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(count));
}

/** Resolve the identity read, then logout between its guard and caller continuation. */
function logoutAtReadBoundary(
	store: GrokBuildCredentialStore,
	session: GrokBuildSession,
	readNumber: number,
	hops: number,
) {
	const originalRead = vi.mocked(store.read).getMockImplementation()!;
	const started = deferred<void>();
	const completed = deferred<void>();
	let reads = 0;
	vi.mocked(store.read).mockImplementation((providerId) => {
		const credential = originalRead(providerId);
		if (++reads === readNumber) {
			const schedule = (remaining: number): void => {
				queueMicrotask(() => {
					if (remaining > 1) schedule(remaining - 1);
					else {
						void session.logout().then(() => completed.resolve(), completed.reject);
						started.resolve();
					}
				});
			};
			schedule(hops);
		}
		return credential;
	});
	return { started: started.promise, completed: completed.promise };
}

describe("Grok session catalog generations", () => {
	it("does not restart deferred startup discovery after logout during cache loading", async () => {
		const { session, store, file, notify } = await fixture();
		const reading = deferred<void>();
		const release = deferred<string | undefined>();
		vi.mocked(store.getActiveAccountId).mockImplementationOnce(() => {
			reading.resolve();
			return release.promise;
		});
		const refreshStartup = session.deferredCatalogRefresh();
		const startup = Promise.allSettled([session.loadCachedCatalog()]).then(refreshStartup);
		await reading.promise;
		await session.logout();
		release.resolve(undefined);
		await startup;
		expect(session.models.getAuth).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledOnce();
		await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("deferred refresh captured before all providers' cache barrier cannot run after logout", async () => {
		const { session, file, notify } = await fixture();
		const refreshStartup = session.deferredCatalogRefresh();
		const otherProvider = deferred<void>();
		const load = session.loadCachedCatalog();
		const startup = Promise.allSettled([load, otherProvider.promise]).then(refreshStartup);
		await load;
		await session.logout();
		otherProvider.resolve();
		await startup;
		expect(session.models.getAuth).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledOnce();
		await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("a current deferred refresh still discovers models after loading", async () => {
		const { session } = await fixture();
		const refreshStartup = session.deferredCatalogRefresh();
		await session.loadCachedCatalog();
		const pending = listing();
		const refresh = refreshStartup();
		await pending.started;
		pending.resolve([{ id: "current-startup" }]);
		await refresh;
		expect(session.catalogSource).toBe("live");
		expect(session.availableModels().map((model) => model.id)).toEqual(["current-startup"]);
	});

	it("rechecks generation at the final post-write publication microtask boundary", async () => {
		const { session, store, file, notify } = await fixture();
		// First discovery: identity / pre-auth / after-auth / pre-write / post-write.
		// Three hops let isCurrent resolve true, then logout runs before its caller.
		const logout = logoutAtReadBoundary(store, session, 5, 3);
		await discover(session, [{ id: "late-model" }]);
		await logout.started;
		await logout.completed;
		expect(session.catalogSource).toBe("fallback");
		expect(session.availableModels().map((model) => model.id)).not.toContain("late-model");
		expect(session.catalogError).toBeUndefined();
		expect(notify).toHaveBeenCalledOnce(); // Logout only, no stale refresh observer.
		await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rechecks generation before getAuth after the pre-auth guard resolves", async () => {
		const { session, store, file, notify } = await fixture();
		const logout = logoutAtReadBoundary(store, session, 2, 3);
		await session.refreshLiveCatalog();
		await logout.started;
		await logout.completed;
		expect(session.models.getAuth).not.toHaveBeenCalled();
		expect(fetchLiveModels).not.toHaveBeenCalled();
		expect(session.catalogSource).toBe("fallback");
		expect(notify).toHaveBeenCalledOnce();
		await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rechecks generation before starting discovery disk commit", async () => {
		const { session, store, file, notify } = await fixture();
		const logout = logoutAtReadBoundary(store, session, 4, 3);
		await discover(session, [{ id: "late-model" }]);
		await logout.started;
		await logout.completed;
		expect(writeModelCache).toHaveBeenCalledOnce(); // Initial identity reset only.
		expect(session.catalogSource).toBe("fallback");
		expect(notify).toHaveBeenCalledOnce();
		await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rechecks generation before publishing a late error diagnostic", async () => {
		const { session, store, file, notify } = await fixture();
		// The catch() on the guard adds a fourth promise-reaction hop.
		const logout = logoutAtReadBoundary(store, session, 4, 4);
		const pending = listing();
		const refresh = session.refreshLiveCatalog();
		await pending.started;
		pending.reject(new Error("late boundary error"));
		await refresh;
		await logout.started;
		await logout.completed;
		expect(session.catalogError).toBeUndefined();
		expect(session.catalogSource).toBe("fallback");
		expect(notify).toHaveBeenCalledOnce();
		await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rechecks generation before notifying after a resolved identity guard", async () => {
		const { session, store, notify } = await fixture();
		const logout = logoutAtReadBoundary(store, session, 6, 4);
		await discover(session);
		await logout.started;
		await logout.completed;
		expect(session.catalogSource).toBe("fallback");
		expect(notify).toHaveBeenCalledOnce(); // No obsolete refresh notification.
	});

	it.each(["success", "error"])(
		"does not resurrect discovery/cache or notify after logout with late %s",
		async (outcome) => {
			const { session, notify, file } = await fixture();
			await discover(session);
			const pending = listing();
			const refresh = session.refreshLiveCatalog();
			await pending.started;
			await session.logout();
			notify.mockClear();
			if (outcome === "success") pending.resolve([{ id: "late-model" }]);
			else pending.reject(new Error("late logged-out error"));
			await refresh;
			expect(session.catalogSource).toBe("fallback");
			expect(session.catalogError).toBeUndefined();
			expect(session.availableModels().map((model) => model.id)).not.toContain("late-model");
			expect(notify).not.toHaveBeenCalled();
			await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
		},
	);

	it("latest request wins when two listings finish in inverse order", async () => {
		const { session, notify, cache } = await fixture();
		const older = listing();
		const a = session.refreshLiveCatalog();
		await older.started;
		const newer = listing();
		const b = session.refreshLiveCatalog();
		await newer.started;
		newer.resolve([{ id: "newer" }]);
		await b;
		notify.mockClear();
		older.resolve([{ id: "older" }]);
		await a;
		expect(session.availableModels().map((model) => model.id)).toEqual(["newer"]);
		expect((await cache()).ids).toEqual(["newer"]);
		expect(notify).not.toHaveBeenCalled();
	});

	it("ignores an older error after the newer listing succeeded", async () => {
		const { session, notify } = await fixture();
		const older = listing();
		const a = session.refreshLiveCatalog();
		await older.started;
		await discover(session, [{ id: "newer" }]);
		notify.mockClear();
		older.reject(new Error("late listing error"));
		await a;
		expect(session.catalogError).toBeUndefined();
		expect(session.catalogSource).toBe("live");
		expect(notify).not.toHaveBeenCalled();
	});

	it.each([{ selection: undefined }, { selection: [] }, { selection: ["model-a"] }])(
		"switch invalidates discovery, not selection $selection, and rediscovers in background",
		async ({ selection }) => {
			const { session, state, notify, cache } = await fixture();
			await discover(session);
			await session.setSelectedModels(selection);
			const older = listing();
			const a = session.refreshLiveCatalog();
			await older.started;
			state.accountId = "slot-b";
			state.access = "EXAMPLE_ACCESS_B";
			state.refresh = "EXAMPLE_REFRESH_B";
			const newer = listing();
			notify.mockClear();
			expect(session.notifyCredentialChange()).toBeUndefined();
			expect(session.catalogSource).toBe("fallback");
			expect(session.selectedModelIds()).toEqual(selection);
			expect(session.availableModels().map((model) => model.id)).not.toContain("model-a");
			await newer.started;
			newer.resolve([{ id: "model-b" }]);
			await settledBackground(notify, 2);
			notify.mockClear();
			older.resolve([{ id: "late-a" }]);
			await a;
			expect(session.availableModels().map((model) => model.id)).toEqual(["model-b"]);
			expect(session.selectedModelIds()).toEqual(selection);
			expect((await cache()).owner).toBe(owner("slot-b"));
			expect(notify).not.toHaveBeenCalled();
		},
	);

	it("same-slot direct credential import discards the previous last-good snapshot even if rediscovery fails", async () => {
		const { session, state, cache, notify } = await fixture();
		await discover(session);
		await session.setSelectedModels(["model-a"]);
		const older = listing();
		const a = session.refreshLiveCatalog();
		await older.started;
		state.access = "EXAMPLE_IMPORTED_ACCESS";
		state.refresh = "EXAMPLE_IMPORTED_REFRESH";
		const newer = listing();
		const b = session.refreshLiveCatalog(); // auth.ts / CLI entry, no notify needed
		await newer.started;
		newer.reject(new Error("current listing unavailable"));
		await b;
		expect(session.catalogSource).toBe("fallback");
		expect(session.catalogError).toBe("current listing unavailable");
		expect(session.selectedModelIds()).toEqual(["model-a"]);
		expect((await cache()).ids).toEqual([]);
		notify.mockClear();
		older.resolve([{ id: "late-original-credential" }]);
		await a;
		expect(notify).not.toHaveBeenCalled();
		expect(session.catalogError).toBe("current listing unavailable");
	});

	it("checks the active slot after getAuth before listing", async () => {
		const { session, state } = await fixture();
		const auth = deferred<Awaited<ReturnType<typeof session.models.getAuth>>>();
		const started = deferred<void>();
		vi.mocked(session.models.getAuth).mockImplementationOnce(() => {
			started.resolve();
			return auth.promise;
		});
		const refresh = session.refreshLiveCatalog();
		await started.promise;
		state.accountId = "slot-b";
		auth.resolve({ auth: { apiKey: "EXAMPLE_ACCESS_A" } });
		await refresh;
		expect(fetchLiveModels).not.toHaveBeenCalled();
		expect(session.catalogSource).toBe("fallback");
	});

	it("rejects old auth if a same-slot credential changed during getAuth", async () => {
		const { session, state } = await fixture();
		const auth = deferred<Awaited<ReturnType<typeof session.models.getAuth>>>();
		const started = deferred<void>();
		vi.mocked(session.models.getAuth).mockImplementationOnce(() => {
			started.resolve();
			return auth.promise;
		});
		const refresh = session.refreshLiveCatalog();
		await started.promise;
		state.access = "EXAMPLE_IMPORTED_ACCESS";
		state.refresh = "EXAMPLE_IMPORTED_REFRESH";
		auth.resolve({ auth: { apiKey: "EXAMPLE_ACCESS_A" } });
		await refresh;
		expect(fetchLiveModels).not.toHaveBeenCalled();
		expect(session.catalogSource).toBe("fallback");
	});

	it("accepts a legitimate token rotation during getAuth", async () => {
		const { session, state, cache } = await fixture();
		vi.mocked(session.models.getAuth).mockImplementationOnce(async () => {
			state.access = "EXAMPLE_ROTATED_ACCESS";
			state.refresh = "EXAMPLE_ROTATED_REFRESH";
			return { auth: { apiKey: state.access } };
		});
		await discover(session);
		expect(session.catalogSource).toBe("live");
		expect((await cache()).owner).toBe(owner("slot-a"));
	});

	it("missing auth clears previous discovery while keeping an empty selection", async () => {
		const { session, cache } = await fixture();
		await discover(session);
		await session.setSelectedModels([]);
		vi.mocked(session.models.getAuth).mockResolvedValueOnce(undefined);
		await session.refreshLiveCatalog();
		expect(session.catalogSource).toBe("fallback");
		expect(session.visibleModels()).toEqual([]);
		expect((await cache()).ids).toEqual([]);
	});

	it("background rediscovery observes errors and exposes only a redacted diagnostic", async () => {
		const { session, notify } = await fixture();
		const pending = listing();
		session.notifyCredentialChange();
		await pending.started;
		pending.reject(new Error("Bearer EXAMPLE_SECRET"));
		await settledBackground(notify, 2);
		expect(session.catalogSource).toBe("fallback");
		expect(session.catalogError).toContain("[redacted]");
		expect(session.catalogError).not.toContain("EXAMPLE_SECRET");
	});

	it("a deferred notify refresh cannot restart after logout", async () => {
		const { session, file } = await fixture();
		await discover(session);
		vi.mocked(fetchLiveModels).mockClear();
		session.notifyCredentialChange();
		await session.logout();
		await Promise.resolve();
		expect(fetchLiveModels).not.toHaveBeenCalled();
		await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("repairs a superseded disk commit before releasing the queue", async () => {
		const { session, cache, notify } = await fixture();
		await discover(session, [{ id: "last-good" }]);
		const actual = await vi.importActual<typeof import("../src/model-cache.ts")>("../src/model-cache.ts");
		const writing = deferred<void>();
		const release = deferred<void>();
		vi.mocked(writeModelCache).mockImplementationOnce(async (file, document) => {
			writing.resolve();
			await release.promise;
			await actual.writeModelCache(file, document);
		});
		const older = listing();
		const a = session.refreshLiveCatalog();
		await older.started;
		older.resolve([{ id: "superseded" }]);
		await writing.promise;
		const newer = listing();
		const b = session.refreshLiveCatalog();
		await newer.started;
		newer.reject(new Error("latest failed"));
		await b;
		notify.mockClear();
		release.resolve();
		await a;
		expect((await cache()).ids).toEqual(["last-good"]);
		expect(session.availableModels().map((model) => model.id)).toEqual(["last-good"]);
		expect(notify).not.toHaveBeenCalled();
	});
});

describe("Grok v4 cache ownership and overlays", () => {
	it.each([{ selected: undefined }, { selected: [] }, { selected: ["chosen"] }])(
		"oversized derived discovery preserves selection $selected after restart",
		async ({ selected }) => {
			const { session, store, file, cache } = await fixture();
			await session.setSelectedModels(selected);
			const models = Array.from({ length: 4096 }, (_, index) => ({
				id: `model-${String(index).padStart(4, "0")}-`.padEnd(256, "x"),
				name: "n".repeat(512),
			}));
			// This listing is legal under the vendor parser's 4 MiB payload ceiling.
			expect(Buffer.byteLength(JSON.stringify({ data: models }), "utf8")).toBeLessThan(4 * 1024 * 1024);
			await discover(session, models);
			expect(session.catalogSource).toBe("live");
			expect(session.availableModels()).toHaveLength(4096);
			const restarted = new GrokBuildSession(store);
			await restarted.loadCachedCatalog();
			expect(restarted.selectedModelIds()).toEqual(selected);
			expect(Buffer.byteLength(await readFile(file, "utf8"), "utf8")).toBeLessThanOrEqual(4 * 1024 * 1024);
			expect(await cache()).toMatchObject({
				ids: [],
				models: [],
				fetchedAt: 0,
				selectionMode: selected === undefined ? "default" : "selected",
			});
			expect(await cache()).not.toHaveProperty("owner");
			expect(restarted.catalogSource).toBe("fallback");
		},
	);

	it("cache budget includes the writer newline at exactly 4 MiB and rejects one extra byte", async () => {
		const { session, store, file } = await fixture();
		const limit = 4 * 1024 * 1024;
		const empty = { version: 4, ids: [], models: [], selectionMode: "selected", fetchedAt: 0, selected: [""] };
		const overhead = Buffer.byteLength(JSON.stringify(empty), "utf8") + 1;
		const fitting = "a".repeat(limit - overhead);
		await session.setSelectedModels([fitting]);
		const before = await readFile(file, "utf8");
		expect(Buffer.byteLength(before, "utf8")).toBe(limit);
		const restarted = new GrokBuildSession(store);
		await restarted.loadCachedCatalog();
		expect(restarted.selectedModelIds()?.[0]?.length).toBe(fitting.length);
		await expect(session.setSelectedModels([`${fitting}a`])).rejects.toThrow("4 MiB cache ceiling");
		expect(await readFile(file, "utf8")).toBe(before);
		expect(session.selectedModelIds()?.[0]?.length).toBe(fitting.length);
	});

	it("rejects oversized selection before replacement, leaving cache and memory intact", async () => {
		const { session, file, notify } = await fixture();
		await session.setSelectedModels([]);
		const before = await readFile(file, "utf8");
		notify.mockClear();
		// UTF-8 exceeds the ceiling although the JS character count is below it.
		await expect(session.setSelectedModels(["é".repeat(2 * 1024 * 1024)])).rejects.toThrow("4 MiB cache ceiling");
		expect(await readFile(file, "utf8")).toBe(before);
		expect(session.selectedModelIds()).toEqual([]);
		expect(notify).not.toHaveBeenCalled();
	});

	it.each([{ selected: [] }, { selected: ["chosen"] }])(
		"fresh CLI refresh preserves persisted selection $selected without restoring unowned discovery",
		async ({ selected }) => {
			const { session, file, cache } = await fixture();
			await writeFile(
				file,
				JSON.stringify({ version: 3, ids: ["old-discovery"], selectionMode: "selected", selected, fetchedAt: 123 }),
			);
			await discover(session, [{ id: "new-discovery" }]);
			expect(session.selectedModelIds()).toEqual(selected);
			expect((await cache()).selected).toEqual(selected);
			expect(session.availableModels().map((model) => model.id)).toEqual(["new-discovery"]);
		},
	);

	it("early import notification preserves persisted empty selection, not prior discovery", async () => {
		const { session, file, cache, notify } = await fixture();
		await writeFile(
			file,
			JSON.stringify({
				version: 4,
				owner: owner("slot-a"),
				ids: ["old-discovery"],
				models: [],
				fetchedAt: 123,
				selectionMode: "selected",
				selected: [],
			}),
		);
		const next = listing();
		session.notifyCredentialChange();
		await next.started;
		expect(session.availableModels().map((model) => model.id)).not.toContain("old-discovery");
		expect(session.selectedModelIds()).toEqual([]);
		next.resolve([{ id: "new-discovery" }]);
		await settledBackground(notify, 2);
		expect((await cache()).selected).toEqual([]);
	});

	it("round-trips whitelisted metadata and real discovery date without plaintext identity/credentials", async () => {
		const { session, store, file, cache } = await fixture();
		vi.spyOn(Date, "now").mockReturnValue(1700000000000);
		const overlay = {
			id: "grok-4.6",
			name: "Fixture reasoning",
			contextWindow: 123456,
			reasoning: true,
			thinkingLevelMap: { off: null, low: "small", medium: null, high: "large", xhigh: null, max: null },
		};
		await discover(session, [overlay]);
		vi.mocked(Date.now).mockReturnValue(1800000000000);
		await session.setSelectedModels([]);
		const document = await cache();
		expect(document).toMatchObject({ version: 4, fetchedAt: 1700000000000, owner: owner("slot-a"), models: [overlay] });
		const raw = await readFile(file, "utf8");
		for (const forbidden of ["slot-a", "EXAMPLE_ACCESS_A", "EXAMPLE_REFRESH_A", store.filename, "email", "label"]) {
			expect(raw).not.toContain(forbidden);
		}
		const restarted = new GrokBuildSession(store);
		await restarted.loadCachedCatalog();
		expect(restarted.catalogSource).toBe("cache");
		expect(restarted.availableModels()[0]).toMatchObject({ ...overlay, provider: GROK_BUILD_ROUTE });
		expect(restarted.visibleModels()).toEqual([]);
		await restarted.setSelectedModels(undefined);
		expect((await cache()).fetchedAt).toBe(1700000000000);
	});

	it.each(["other-owner", "unowned", "invalid-date"])(
		"refuses %s discoveries, preserving selection without rewriting",
		async (kind) => {
			const { session, file } = await fixture();
			const raw = JSON.stringify({
				version: 4,
				ids: ["unproven"],
				models: [{ id: "unproven", name: "Wrong" }],
				selectionMode: "selected",
				selected: [],
				owner: kind === "unowned" ? undefined : owner(kind === "other-owner" ? "slot-b" : "slot-a"),
				fetchedAt: kind === "invalid-date" ? -1 : 1700000000000,
			});
			await writeFile(file, raw);
			await session.loadCachedCatalog();
			expect(session.catalogSource).toBe("fallback");
			expect(session.availableModels().map((model) => model.id)).not.toContain("unproven");
			expect(session.selectedModelIds()).toEqual([]);
			expect(await readFile(file, "utf8")).toBe(raw);
		},
	);

	it.each([
		{ version: 1, selected: [], expected: undefined },
		{ version: 2, selected: ["chosen"], expected: ["chosen"] },
		{ version: 3, selectionMode: "selected", selected: [], expected: [] },
		{ version: 3, selectionMode: "default", selected: ["ignored"], expected: undefined },
	])(
		"legacy $version keeps selection $expected but does not prove discovery ownership",
		async ({ expected, ...legacy }) => {
			const { session, file } = await fixture();
			const raw = JSON.stringify({ ...legacy, ids: ["legacy-discovery"], fetchedAt: 123 });
			await writeFile(file, raw);
			await session.loadCachedCatalog();
			expect(session.selectedModelIds()).toEqual(expected);
			expect(session.catalogSource).toBe("fallback");
			expect(session.availableModels().map((model) => model.id)).not.toContain("legacy-discovery");
			expect(await readFile(file, "utf8")).toBe(raw);
		},
	);

	it("ignores invalid overlay fields and never restores provider/API/cost extras", async () => {
		const { session, file } = await fixture();
		await writeFile(
			file,
			JSON.stringify({
				version: 4,
				owner: owner("slot-a"),
				fetchedAt: 123,
				selectionMode: "default",
				ids: ["grok-4.6"],
				models: [
					{
						id: "grok-4.6",
						name: "x".repeat(513),
						contextWindow: -1,
						reasoning: "yes",
						provider: "malicious",
						api: "malicious",
						cost: { input: -1 },
						thinkingLevelMap: { off: null, xhigh: null, high: 42, unknown: "unsupported" },
					},
					{ id: "not-listed", name: "Ignored" },
				],
			}),
		);
		await session.loadCachedCatalog();
		const model = session.availableModels()[0]!;
		expect(model.provider).toBe(GROK_BUILD_ROUTE);
		expect(model.api).toBe("openai-responses");
		expect(model.contextWindow).toBeGreaterThan(0);
		expect(model.name).not.toBe("x".repeat(513));
		expect(model.reasoning).toBe(true);
		// A malformed known level discards the map, preserving baseline safety.
		expect(model.thinkingLevelMap?.xhigh).toBe("xhigh");
		expect(model.thinkingLevelMap).not.toHaveProperty("unknown");
	});

	it("ignores oversized cache documents without changing defaults", async () => {
		const { session, file } = await fixture();
		await writeFile(file, JSON.stringify({ version: 4, selected: ["chosen"], padding: "x".repeat(4 * 1024 * 1024) }));
		await session.loadCachedCatalog();
		expect(session.selectedModelIds()).toBeUndefined();
		expect(session.catalogSource).toBe("fallback");
	});

	it("cache load and discovery guards do not migrate a v1 credential document", async () => {
		const { session, store, file } = await fixture();
		vi.mocked(store.getActiveAccountId).mockRestore();
		vi.mocked(store.read).mockRestore();
		const auth = JSON.stringify({
			version: 1,
			credential: {
				type: "oauth",
				access: "EXAMPLE_ACCESS_A",
				refresh: "EXAMPLE_REFRESH_A",
				expires: 1700000000000,
				accountId: "safe-user",
			},
		});
		await writeFile(store.filename, auth, { mode: 0o600 });
		const before = await stat(store.filename);
		await writeFile(
			file,
			JSON.stringify({ version: 3, ids: ["unowned"], selected: [], selectionMode: "selected", fetchedAt: 123 }),
		);
		await session.loadCachedCatalog();
		expect(session.visibleModels()).toEqual([]);
		await discover(session);
		expect(await readFile(store.filename, "utf8")).toBe(auth);
		expect((await stat(store.filename)).mtimeMs).toBe(before.mtimeMs);
	});

	it("rechecks generation before publishing a loaded cache after its guard resolves", async () => {
		const { session, store, file } = await fixture();
		await writeFile(
			file,
			JSON.stringify({
				version: 4,
				ids: ["late-cache"],
				models: [],
				owner: owner("slot-a"),
				fetchedAt: 123,
				selectionMode: "selected",
				selected: [],
			}),
		);
		const logout = logoutAtReadBoundary(store, session, 2, 3);
		await session.loadCachedCatalog();
		await logout.started;
		await logout.completed;
		expect(session.catalogSource).toBe("fallback");
		expect(session.selectedModelIds()).toBeUndefined();
		expect(session.availableModels().map((model) => model.id)).not.toContain("late-cache");
		await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("a cache load suspended during logout cannot restore models or selection", async () => {
		const { session, file } = await fixture();
		const reading = deferred<void>();
		const text = deferred<string>();
		vi.mocked(readFile).mockImplementationOnce(() => {
			reading.resolve();
			return text.promise as ReturnType<typeof readFile>;
		});
		const load = session.loadCachedCatalog();
		await reading.promise;
		await session.logout();
		text.resolve(
			JSON.stringify({
				version: 4,
				ids: ["late-cache"],
				owner: owner("slot-a"),
				fetchedAt: 123,
				selectionMode: "selected",
				selected: [],
			}),
		);
		await load;
		expect(session.catalogSource).toBe("fallback");
		expect(session.selectedModelIds()).toBeUndefined();
		await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
