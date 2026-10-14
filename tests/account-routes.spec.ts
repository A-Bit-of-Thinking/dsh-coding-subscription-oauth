import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AccountRouteDescriptor, AccountRouteRegistry, publicAccountRoute } from "../src/account-routes.ts";
import { OAuthCredentialFileStore } from "../src/store.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const directory of dirs.splice(0)) {
		if (!directory.startsWith(join(tmpdir(), "dsh-account-routes-"))) throw new Error("Unexpected cleanup target");
		await rm(directory, { recursive: true, force: true });
	}
});
async function fixture() {
	const home = await mkdtemp(join(tmpdir(), "dsh-account-routes-"));
	dirs.push(home);
	return { home, filename: join(home, "routes.json") };
}
const a: AccountRouteDescriptor = { family: "claude", accountId: "provider-account-a", createdAt: 1 };
const b: AccountRouteDescriptor = { family: "claude", accountId: "provider-account-b", createdAt: 2 };

describe("opaque account route registry", () => {
	it("persists stable random aliases across restart, reordering and removal", async () => {
		const { filename } = await fixture();
		const registry = new AccountRouteRegistry(filename);
		const first = await registry.synchronize([a, b]);
		expect(first).toHaveLength(2);
		expect(first[0]?.route).toMatch(/^claude-code-oauth-account-[a-f0-9]{32}$/u);
		expect(first[0]?.route).not.toContain(a.accountId);
		expect(first[0]?.slot).toBe(1);
		expect(first[1]?.slot).toBe(2);
		const restored = await new AccountRouteRegistry(filename).synchronize([b, a]);
		expect(restored).toEqual(first);
		expect(await registry.synchronize([b])).toEqual([first[1]]);
		expect(await registry.synchronize([a])).toEqual([first[0]]);
	});
	it("does not reuse an alias for a recreated record or another provider", async () => {
		const { filename } = await fixture();
		const registry = new AccountRouteRegistry(filename);
		const old = (await registry.synchronize([a]))[0]!;
		const next = (await registry.synchronize([{ ...a, createdAt: 3 }]))[0]!;
		expect(next.route).not.toBe(old.route);
		expect(next.slot).toBe(2);
		const codex = (await registry.synchronize([{ ...a, family: "codex" }]))[0]!;
		expect(codex.route).toMatch(/^codex-oauth-account-[a-f0-9]{32}$/u);
		expect(codex.slot).toBe(1);
	});
	it("serializes independent instances and retains both historical bindings", async () => {
		const { filename } = await fixture();
		const [one, two] = await Promise.all([
			new AccountRouteRegistry(filename).synchronize([a]),
			new AccountRouteRegistry(filename).synchronize([b]),
		]);
		expect(one[0]?.route).not.toBe(two[0]?.route);
		const restored = await new AccountRouteRegistry(filename).synchronize([a, b]);
		expect(restored).toHaveLength(2);
		expect(new Set(restored.map((row) => row.slot)).size).toBe(2);
	});
	it("does not write again for unchanged bindings and returns detached results", async () => {
		const { filename } = await fixture();
		const registry = new AccountRouteRegistry(filename);
		const first = await registry.synchronize([a]);
		const original = await readFile(filename, "utf8");
		(first[0] as { route: string }).route = "mutated";
		const next = await registry.synchronize([a]);
		expect(next[0]?.route).not.toBe("mutated");
		expect(await readFile(filename, "utf8")).toBe(original);
	});
	it("projects no internal account IDs, epochs or surplus secret fields", async () => {
		const { filename } = await fixture();
		const registry = new AccountRouteRegistry(filename);
		const row = (await registry.synchronize([{ ...a, token: "SECRET_CANARY" } as AccountRouteDescriptor]))[0]!;
		expect(JSON.stringify(publicAccountRoute(row))).not.toContain(a.accountId);
		expect(publicAccountRoute(row)).toEqual({ family: "claude", route: row.route, slot: 1 });
		expect(await readFile(filename, "utf8")).not.toContain("SECRET_CANARY");
	});
	it("captures descriptor inputs before asynchronous storage work", async () => {
		const { filename } = await fixture();
		const input = { ...a };
		const pending = new AccountRouteRegistry(filename).synchronize([input]);
		input.accountId = "mutated-account";
		const result = await pending;
		expect(result[0]?.accountId).toBe(a.accountId);
		expect(await readFile(filename, "utf8")).not.toContain("mutated-account");
	});
	it("empty input neither creates a parent directory nor a metadata file", async () => {
		const { home } = await fixture();
		const parent = join(home, "absent");
		expect(await new AccountRouteRegistry(join(parent, "routes.json")).synchronize([])).toEqual([]);
		await expect(stat(parent)).rejects.toMatchObject({ code: "ENOENT" });
	});
	it.each(
		[
			[{ ...a, family: "foreign" }],
			[{ ...a, accountId: "../escape" }],
			[{ ...a, createdAt: 0 }],
			[{ ...a, createdAt: NaN }],
			[a, a],
			[a, { ...a, createdAt: 3 }],
			Array.from({ length: 9 }, (_, index) => ({ ...a, accountId: `account-${index}` })),
		].map((accounts) => ({ accounts })),
	)("fails closed on invalid or duplicate current descriptors", async ({ accounts }) => {
		const { filename } = await fixture();
		await expect(new AccountRouteRegistry(filename).synchronize(accounts as AccountRouteDescriptor[])).rejects.toThrow(
			"unavailable or invalid",
		);
		await expect(stat(filename)).rejects.toMatchObject({ code: "ENOENT" });
	});
	it.each(["{SECRET_CANARY", JSON.stringify({ version: 2, bindings: [] }), "x".repeat(65 * 1024)])(
		"does not repair or overwrite malformed metadata",
		async (bad) => {
			const { filename } = await fixture();
			await writeFile(filename, bad, { mode: 0o600 });
			await expect(new AccountRouteRegistry(filename).synchronize([a])).rejects.toThrow(
				/^Account route metadata is unavailable or invalid$/u,
			);
			expect(await readFile(filename, "utf8")).toBe(bad);
		},
	);
	it("rejects duplicated persisted routes and invalid id generators without leaking data", async () => {
		const { filename } = await fixture();
		const registry = new AccountRouteRegistry(filename);
		await registry.synchronize([a]);
		const saved = JSON.parse(await readFile(filename, "utf8"));
		saved.bindings.push({ ...saved.bindings[0], accountId: "SECRET_CANARY" });
		const bad = JSON.stringify(saved);
		await writeFile(filename, bad, { mode: 0o600 });
		await expect(registry.synchronize([a])).rejects.toThrow(/^Account route metadata is unavailable or invalid$/u);
		expect(await readFile(filename, "utf8")).toBe(bad);
		const other = join(dirs[dirs.length - 1]!, "other.json");
		await expect(new AccountRouteRegistry(other, () => "SECRET_CANARY").synchronize([a])).rejects.toThrow(
			/^Account route metadata is unavailable or invalid$/u,
		);
		await expect(stat(other)).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("store metadata is explicitly requested and is not added to ordinary account status", async () => {
		const { home } = await fixture();
		const store = new OAuthCredentialFileStore("anthropic", join(home, "auth.json"), "fixture");
		await store.upsertAccount({
			id: "account-a",
			credential: {
				type: "oauth",
				access: "fixture-access",
				refresh: "fixture-refresh",
				expires: Date.now() + 600_000,
			},
		});
		expect((await store.listAccounts())[0]).not.toHaveProperty("createdAt");
		const observed = (await store.listAccounts({ readOnly: true, includeCreatedAt: true }))[0]!;
		expect(observed.createdAt).toBeGreaterThan(0);
		expect(observed).not.toHaveProperty("credential");
		expect(observed).not.toHaveProperty("access");
	});
});
