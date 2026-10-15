import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Credential, OAuthCredential } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountCredentialStore } from "../src/account-credentials.ts";
import { OAUTH_SOURCE_MAX_BYTES } from "../src/oauth-sources.ts";
import { OAuthCredentialFileStore, oauthCredentialPath } from "../src/store.ts";

const provider = "anthropic";
const directories: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function credential(suffix: string): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 600_000,
		accountId: `identity-${suffix}`,
	};
}
async function fixture() {
	// Explicit isolated DSH home; no process profile or real credential is resolved.
	const home = await mkdtemp(join(tmpdir(), "dsh-account-credentials-"));
	directories.push(home);
	const base = new OAuthCredentialFileStore(provider, oauthCredentialPath("auth.json", home), "fixture");
	await base.upsertAccount({ id: "account-a", credential: credential("a"), makeActive: true });
	await base.upsertAccount({ id: "account-b", credential: credential("b") });
	return { base, a: new AccountCredentialStore(base, "account-a"), b: new AccountCredentialStore(base, "account-b") };
}
function updated(current: Credential | undefined): OAuthCredential {
	if (current?.type !== "oauth") throw new Error("Missing fixture credential");
	return { ...current, access: `${current.access}-next` };
}

describe("AccountCredentialStore", () => {
	it("observes v1 without migration while default readAccount retains migration", async () => {
		const { base } = await fixture();
		const original = `${JSON.stringify({ version: 1, credential: credential("a") })}\n`;
		await writeFile(base.filename, original, { mode: 0o600 });
		const facade = new AccountCredentialStore(base, "identity-a");
		expect(await facade.read(provider)).toMatchObject({ access: "access-a", accountId: "identity-a" });
		expect(await facade.list()).toEqual([{ providerId: provider, type: "oauth" }]);
		expect(await readFile(base.filename, "utf8")).toBe(original);
		await base.readAccount("identity-a");
		expect(JSON.parse(await readFile(base.filename, "utf8")).version).toBe(2);
	});

	it("observes missing parent directory without creating it", async () => {
		const { base } = await fixture();
		const missing = new OAuthCredentialFileStore(
			provider,
			join(dirname(base.filename), "absent", "auth.json"),
			"fixture",
		);
		const facade = new AccountCredentialStore(missing, "account-a");
		expect(await facade.read(provider)).toBeUndefined();
		expect(await facade.list()).toEqual([]);
	});

	it("retains hardened source checks and sanitized errors", async () => {
		const { base, a } = await fixture();
		await writeFile(base.filename, "x".repeat(OAUTH_SOURCE_MAX_BYTES + 1), { mode: 0o600 });
		await expect(a.read(provider)).rejects.toThrow(/^Account credential read failed$/);
		await expect(a.modify(provider, async () => credential("a"))).rejects.toThrow(
			/^Account credential modification failed$/,
		);
		if (process.platform === "win32") return;
		await writeFile(base.filename, JSON.stringify({ version: 1, credential: credential("a") }), { mode: 0o600 });
		await chmod(base.filename, 0o644);
		await expect(a.read(provider)).rejects.toThrow(/^Account credential read failed$/);
		await chmod(base.filename, 0o600);
		const target = join(directories[directories.length - 1]!, "link.json");
		await symlink(base.filename, target);
		const linked = new AccountCredentialStore(new OAuthCredentialFileStore(provider, target, "fixture"), "identity-a");
		await expect(linked.read(provider)).rejects.toThrow(/^Account credential read failed$/);
	});

	it("projects concurrent accounts independently of global active changes", async () => {
		const { base, a, b } = await fixture();
		expect(a.nativeProviderId).toBe(provider);
		for (const active of ["account-b", "account-a"]) {
			await base.setActiveAccount(active);
			const [first, second] = await Promise.all([a.read(provider), b.read(provider)]);
			expect(first).toMatchObject({ access: "access-a" });
			expect(second).toMatchObject({ access: "access-b" });
			expect(await a.list()).toEqual([{ providerId: provider, type: "oauth" }]);
			expect(await b.list()).toEqual([{ providerId: provider, type: "oauth" }]);
			expect(await base.getActiveAccountId()).toBe(active);
		}
	});

	it("serializes A/A and A/B refresh without losing updates or moving active", async () => {
		const { base, a, b } = await fixture();
		const secondA = new AccountCredentialStore(
			new OAuthCredentialFileStore(provider, base.filename, "fixture"),
			"account-a",
		);
		await Promise.all([
			a.modify(provider, async (current) => updated(current)),
			secondA.modify(provider, async (current) => updated(current)),
			b.modify(provider, async (current) => updated(current)),
		]);
		expect(await a.read(provider)).toMatchObject({ access: "access-a-next-next" });
		expect(await b.read(provider)).toMatchObject({ access: "access-b-next" });
		expect(await base.getActiveAccountId()).toBe("account-a");
		const document = JSON.parse(await readFile(base.filename, "utf8"));
		expect(document.accounts).toHaveLength(2);
	});

	it("ignores foreign reads/deletes and refuses foreign modifications before callback", async () => {
		const { base, a } = await fixture();
		const before = await readFile(base.filename, "utf8");
		const callback = vi.fn(async () => credential("foreign"));
		expect(await a.read("foreign")).toBeUndefined();
		await expect(a.modify("foreign", callback)).rejects.toThrow("provider is not owned");
		await a.delete("foreign");
		expect(callback).not.toHaveBeenCalled();
		expect(await readFile(base.filename, "utf8")).toBe(before);
	});

	it("never falls back or recreates removed and absent accounts", async () => {
		const { base, a, b } = await fixture();
		await base.removeAccount("account-a");
		const callback = vi.fn(async () => credential("replacement"));
		for (const store of [a, new AccountCredentialStore(base, "absent")]) {
			expect(await store.read(provider)).toBeUndefined();
			expect(await store.list()).toEqual([]);
			expect(await store.modify(provider, callback)).toBeUndefined();
			expect(await store.invalidateRejectedAccessToken("access-a")).toBe(false);
		}
		expect(callback).not.toHaveBeenCalled();
		expect(await b.read(provider)).toMatchObject({ access: "access-b" });
		await base.removeAccount("account-b");
		expect(await b.modify(provider, callback)).toBeUndefined();
	});

	it("invalidates only the exact rejected token and preserves newer and other credentials", async () => {
		const { a, b } = await fixture();
		const other = await b.read(provider);
		expect(await a.invalidateRejectedAccessToken("access-b")).toBe(false);
		await a.modify(provider, async (current) => updated(current));
		const renewed = await a.read(provider);
		expect(await a.invalidateRejectedAccessToken("access-a")).toBe(false);
		expect(await a.read(provider)).toEqual(renewed);
		expect(await a.invalidateRejectedAccessToken("access-a-next")).toBe(true);
		expect(await a.read(provider)).toMatchObject({
			access: "access-a-next",
			refresh: "refresh-a",
			expires: expect.any(Number),
		});
		const invalidated = await a.read(provider);
		if (invalidated?.type === "oauth") expect(invalidated.expires).toBeLessThan(Date.now());
		expect(await b.read(provider)).toEqual(other);
		await expect(a.invalidateRejectedAccessToken(undefined as unknown as string)).rejects.toThrow("required");
		await expect(a.invalidateRejectedAccessToken("")).rejects.toThrow("required");
	});

	it("serializes rejected-token comparison behind an in-flight renewal", async () => {
		const { a } = await fixture();
		let entered!: () => void;
		let release!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const refreshing = a.modify(provider, async (current) => {
			entered();
			await gate;
			return updated(current);
		});
		await started;
		const lateFailure = a.invalidateRejectedAccessToken("access-a");
		release();
		await refreshing;
		expect(await lateFailure).toBe(false);
		const current = await a.read(provider);
		if (current?.type === "oauth") expect(current.expires).toBeGreaterThan(Date.now());
	});

	it("rejects wrong types, malformed values and changed provider identity without writing", async () => {
		const { base, a } = await fixture();
		const before = await readFile(base.filename, "utf8");
		for (const candidate of [
			{ type: "api_key", key: "canary" },
			{ ...credential("a"), accountId: "identity-b" },
			{ ...credential("a"), accountId: null },
			{ ...credential("a"), access: "" },
			{ ...credential("a"), expires: Number.NaN },
		]) {
			await expect(a.modify(provider, async () => candidate as Credential)).rejects.toThrow("modification failed");
			expect(await readFile(base.filename, "utf8")).toBe(before);
		}
		await expect(
			a.modify(provider, async (current) => {
				if (current?.type === "oauth") current.accountId = "identity-b";
				return current;
			}),
		).rejects.toThrow("modification failed");
		expect(await readFile(base.filename, "utf8")).toBe(before);
	});

	it("allows optional identity when one side omits it and undefined leaves state unchanged", async () => {
		const { a } = await fixture();
		const before = await a.read(provider);
		expect(await a.modify(provider, async () => undefined)).toEqual(before);
		await a.modify(provider, async (current) => {
			const next = updated(current);
			delete next.accountId;
			return next;
		});
		expect(await a.read(provider)).toMatchObject({ access: "access-a-next" });
	});

	it("refuses native deletion without calling global delete or removing accounts", async () => {
		const { base, a } = await fixture();
		const before = await readFile(base.filename, "utf8");
		const globalDelete = vi.spyOn(base, "delete");
		const remove = vi.spyOn(base, "removeAccount");
		await expect(a.delete(provider)).rejects.toThrow("existing account manager");
		expect(globalDelete).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
		expect(await readFile(base.filename, "utf8")).toBe(before);
	});

	it("fails closed on invalid constructor account IDs", async () => {
		const { base } = await fixture();
		for (const id of ["", "../canary", "has spaces", "x".repeat(129), undefined, null])
			expect(() => new AccountCredentialStore(base, id as string)).toThrow("scope is invalid");
	});

	it("sanitizes storage/callback errors and never overwrites corrupted documents", async () => {
		const { base, a } = await fixture();
		const secret = "SECRET_TOKEN_EMAIL_BODY_CANARY";
		await expect(
			a.modify(provider, async () => {
				throw new Error(`${base.filename} account-a ${secret}`);
			}),
		).rejects.toThrow(/^Account credential modification failed$/);
		for (const corrupted of [
			`{${secret}`,
			JSON.stringify({
				version: 2,
				activeAccountId: "account-a",
				accounts: [
					{ id: "account-a", createdAt: 1, credential: { ...credential("a"), type: "api_key", accountId: secret } },
				],
			}),
		]) {
			await writeFile(base.filename, corrupted, { mode: 0o600 });
			await expect(a.read(provider)).rejects.toThrow(/^Account credential read failed$/);
			await expect(a.list()).rejects.toThrow(/^Account credential read failed$/);
			const callback = vi.fn(async () => credential("replaced"));
			expect(await a.modify(provider, callback)).toBeUndefined();
			expect(callback).not.toHaveBeenCalled();
			expect(await readFile(base.filename, "utf8")).toBe(corrupted);
		}
	});
});
