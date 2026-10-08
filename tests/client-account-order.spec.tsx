/** @vitest-environment jsdom */
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountsTab, type AccountsTabProps } from "../src/client/components/AccountsTab.tsx";
import type { GoSnapshot } from "../src/client/components/OpenCodeGoConnectionView.tsx";
import { OPENCODE_GO_CONNECTION_PATH, PROVIDERS } from "../src/client/constants.ts";
import { en } from "../src/client/locales.ts";
import type { CodingOAuthStatus, ProviderSlug, SubscriptionStatus } from "../src/client/types.ts";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../src/client/api.ts", () => ({ jsonRequest: mocks.request }));

afterEach(() => {
	cleanup();
	vi.resetAllMocks();
});
beforeEach(() => {
	mocks.request.mockResolvedValue(goSnapshot(false));
});

function goSnapshot(ready: boolean, revision = 2): GoSnapshot {
	return {
		credential: {
			selectedRef: "EXISTING_GO_KEY",
			configured: true,
			writable: true,
			requiresChoice: false,
			candidates: [{ ref: "EXISTING_GO_KEY", configured: true, writable: true }],
		},
		configuration: {
			revision,
			writable: true,
			ready,
			api: "openai-completions",
			conflicts: [],
			models: [{ id: "deepseek-v4.1-flash" }],
		},
		call: { active: true, lastCall: "no-call", updatedAt: null },
	};
}

function subscription(provider: Exclude<ProviderSlug, "grok">, connected = false): SubscriptionStatus {
	const base = {
		provider,
		route: `${provider}-oauth`,
		displayName: provider,
		loginMethods: ["browser"] as const,
		recommendedLoginMethod: "browser" as const,
		models: ["model-a"],
		available: ["model-a", "model-b"],
		selected: ["model-a"],
	};
	return connected
		? { ...base, status: "signed-in", accounts: [{ id: `${provider}-account`, expires: 2_000_000_000_000 }], activeAccountId: `${provider}-account` }
		: { ...base, status: "signed-out" };
}

function status(): CodingOAuthStatus {
	return {
		accessMode: "loopback",
		uiOwner: "standalone",
		compatibility: { coreAbi: "fixture", dshVersion: null, status: "healthy", diagnostics: [] },
		providers: {
			grok: { status: "signed-out", grokImportAvailable: false },
			codex: subscription("codex"),
			kimi: subscription("kimi"),
			claude: subscription("claude"),
		},
		antigravity: { installed: false, route: "agy", management: "cli" },
		opencodeGo: { active: true, lastCall: "success", updatedAt: 10 },
	};
}

function props(value = status()): AccountsTabProps {
	return {
		t: (key, params) => Object.entries(params ?? {}).reduce((text, [name, replacement]) => text.replaceAll(`{${name}}`, String(replacement)), en[key]),
		status: value,
		remote: false,
		remoteTipDismissed: true,
		onDismissRemoteTip: vi.fn(),
		sources: undefined,
		sourcesError: undefined,
		sourcesNotice: undefined,
		sourcesBusy: false,
		preview: undefined,
		confirmOverwrite: false,
		busyProvider: undefined,
		codeInputs: {},
		popupBlocked: {},
		expandedProviders: {},
		showUsage: false,
		usage: undefined,
		usageError: undefined,
		usageLoading: false,
		onSignIn: vi.fn(),
		onSignOut: vi.fn(),
		onCancelLogin: vi.fn(),
		onSubmitCode: vi.fn(),
		onCodeChange: vi.fn(),
		onToggleExpanded: vi.fn(),
		onPreviewSource: vi.fn(),
		onSaveModels: vi.fn(async () => undefined),
		onSetDefaultAccount: vi.fn(),
		onRemoveAccount: vi.fn(async () => true),
		onRetryStatus: vi.fn(),
		onConfirmOverwriteChange: vi.fn(),
		onCommitSource: vi.fn(),
		onCancelSourcePreview: vi.fn(),
		onRefreshSources: vi.fn(),
		onDismissSourcesNotice: vi.fn(),
		onStartConversation: vi.fn(),
	};
}

function titles(): string[] {
	return screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent!);
}

function expectedTitles(...slugs: (ProviderSlug | "go")[]): string[] {
	return [...slugs.map((slug) => slug === "go" ? en.opencodeGoTitle : en[PROVIDERS.find((item) => item.slug === slug)!.titleKey]), en.antigravityTitle];
}

it("stably places connected OAuth services first and active Go after them, without changing the provider table", async () => {
	const originalOrder = PROVIDERS.map((provider) => provider.slug);
	const value = status();
	value.providers.codex = subscription("codex", true);
	value.providers.claude = subscription("claude", true);
	mocks.request.mockResolvedValue(goSnapshot(true));
	render(createElement(AccountsTab, props(value)));
	await waitFor(() => expect(titles()).toEqual(expectedTitles("codex", "claude", "go", "grok", "kimi")));
	expect(PROVIDERS.map((provider) => provider.slug)).toEqual(originalOrder);
	expect(screen.getByRole("button", { name: en.opencodeGoEdit }).getAttribute("aria-expanded")).toBe("false");
	expect(mocks.request).toHaveBeenCalledExactlyOnceWith(OPENCODE_GO_CONNECTION_PATH);
});

it("never promotes Go based on a past successful call or OAuth based on retained model lists", async () => {
	const value = status();
	value.providers.kimi = subscription("kimi", true);
	const go = goSnapshot(false);
	mocks.request.mockResolvedValue({ ...go, call: { active: true, lastCall: "success", updatedAt: 20 } });
	render(createElement(AccountsTab, props(value)));
	await waitFor(() => expect(mocks.request).toHaveBeenCalledOnce());
	expect(titles()).toEqual(expectedTitles("kimi", "grok", "codex", "claude", "go"));
	expect(screen.queryByRole("button", { name: en.opencodeGoStartConversation })).toBeNull();
	expect(screen.getByText(en["opencodeGoStatus.success"])).toBeTruthy();
});

it("keeps known connected services first through read errors and reauthorization, then clears them on sign-out", async () => {
	const value = status();
	value.providers.codex = subscription("codex", true);
	value.providers.kimi = subscription("kimi", true);
	mocks.request.mockResolvedValue(goSnapshot(true));
	const input = { ...props(value), expandedProviders: { kimi: true } };
	const view = render(createElement(AccountsTab, input));
	await waitFor(() => expect(titles()).toEqual(expectedTitles("codex", "kimi", "go", "grok", "claude")));
	const model = screen.getByRole("checkbox", { name: "model-a" }) as HTMLInputElement;
	fireEvent.click(model);
	const errorStatus = {
		...value,
		providers: { ...value.providers, codex: { ...subscription("codex"), status: "error" as const, message: "storage read failed" } },
	};
	view.rerender(createElement(AccountsTab, { ...input, status: errorStatus }));
	expect(titles()).toEqual(expectedTitles("codex", "kimi", "go", "grok", "claude"));
	expect(screen.getByRole("alert").textContent).toContain("storage read failed");
	view.rerender(createElement(AccountsTab, {
		...input,
		status: { ...value, providers: { ...value.providers, codex: { ...subscription("codex"), status: "signing-in", method: "browser", url: "https://example.com/auth" } } },
	}));
	expect(titles()).toEqual(expectedTitles("codex", "kimi", "go", "grok", "claude"));
	expect(screen.getByRole("button", { name: en.cancelLogin })).toBeTruthy();
	view.rerender(createElement(AccountsTab, {
		...input,
		status: { ...value, providers: { ...value.providers, codex: subscription("codex") } },
	}));
	expect(titles()).toEqual(expectedTitles("kimi", "go", "grok", "codex", "claude"));
	expect(screen.getByRole("checkbox", { name: "model-a" })).toBe(model);
	expect(model.checked).toBe(false);
	expect(model.closest("[data-unsaved]")?.getAttribute("data-unsaved")).toBe("true");
	expect(input.onSaveModels).not.toHaveBeenCalled();
});

it("recognizes error snapshots retaining accounts, but does not retain them after explicit sign-out", () => {
	const value = status();
	value.providers.claude = { ...subscription("claude", true), status: "error", message: "read failed" };
	const input = props(value);
	const view = render(createElement(AccountsTab, input));
	expect(titles()).toEqual(expectedTitles("claude", "grok", "codex", "kimi", "go"));
	view.rerender(createElement(AccountsTab, {
		...input,
		status: { ...value, providers: { ...value.providers, claude: subscription("claude") } },
	}));
	expect(titles()).toEqual(expectedTitles("grok", "codex", "kimi", "claude", "go"));
});

it("resorts live Go readiness without remounting its editor or trusting stale revisions or call outcomes", async () => {
	const value = status();
	value.providers.codex = subscription("codex", true);
	const input = props(value);
	const view = render(createElement(AccountsTab, input));
	const goArticle = screen.getByRole("article", { name: en.opencodeGoTitle });
	await waitFor(() => expect(mocks.request).toHaveBeenCalledOnce());
	fireEvent.click(within(goArticle).getByRole("button", { name: en.opencodeGoEdit }));
	const apiKey = within(goArticle).getByLabelText(en.opencodeGoApiKey) as HTMLInputElement;
	fireEvent.change(apiKey, { target: { value: "fixture-only" } });
	apiKey.focus();
	mocks.request.mockResolvedValueOnce({ ...goSnapshot(true, 3), call: { active: true, lastCall: "failure", updatedAt: 20 } });
	fireEvent.focus(window);
	await waitFor(() => expect(titles()).toEqual(expectedTitles("codex", "go", "grok", "kimi", "claude")));
	expect(screen.getByRole("article", { name: en.opencodeGoTitle })).toBe(goArticle);
	expect(within(goArticle).getByLabelText(en.opencodeGoApiKey)).toBe(apiKey);
	expect(apiKey.value).toBe("fixture-only");
	expect(within(goArticle).getByRole("button", { name: en.collapseModels }).getAttribute("aria-expanded")).toBe("true");
	expect(within(goArticle).getByText(en["opencodeGoStatus.failure"])).toBeTruthy();
	mocks.request.mockResolvedValueOnce(goSnapshot(false, 1));
	fireEvent.focus(window);
	await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(3));
	expect(titles()).toEqual(expectedTitles("codex", "go", "grok", "kimi", "claude"));
	mocks.request.mockResolvedValueOnce(goSnapshot(false, 4));
	fireEvent.focus(window);
	await waitFor(() => expect(titles()).toEqual(expectedTitles("codex", "grok", "kimi", "claude", "go")));
	expect(apiKey.value).toBe("fixture-only");
	expect(document.activeElement).toBe(apiKey);
	mocks.request.mockResolvedValueOnce(goSnapshot(false, 5));
	fireEvent.click(within(goArticle).getByRole("button", { name: en.opencodeGoSaveKey }));
	await waitFor(() => expect(mocks.request).toHaveBeenCalledWith(OPENCODE_GO_CONNECTION_PATH, "POST", { action: "credential", credentialRef: "EXISTING_GO_KEY", apiKey: "fixture-only" }));
	await within(goArticle).findByText(en.opencodeGoCredentialSaved);
	expect(apiKey.value).toBe("");
	view.unmount();
	fireEvent.focus(window);
	expect(mocks.request).toHaveBeenCalledTimes(5);
});

it("keeps the CLI preview next to its service across sorting and preserves handlers and focus restoration", async () => {
	const value = status();
	value.providers.codex = subscription("codex", true);
	const input = { ...props(value), sources: [{ kind: "kimi" as const, displayPath: "~/.cli/fixture.json", available: true }] };
	const view = render(createElement(AccountsTab, input));
	const sourceButton = document.getElementById("coding-oauth-source-pull-kimi")!;
	fireEvent.click(sourceButton);
	expect(input.onPreviewSource).toHaveBeenCalledWith("kimi");
	const preview = {
		previewId: "fixture",
		kind: "kimi" as const,
		displayPath: "~/.cli/fixture.json",
		conflict: "different_account" as const,
		action: "overwrite" as const,
		warnings: [],
		confirmOverwriteRequired: true,
	};
	view.rerender(createElement(AccountsTab, { ...input, preview }));
	const section = document.getElementById("coding-oauth-source-preview-kimi")!;
	expect(section.parentElement?.previousElementSibling?.querySelector("h3")?.textContent).toBe(en.kimiTitle);
	expect(document.activeElement).toBe(section);
	view.rerender(createElement(AccountsTab, {
		...input,
		preview,
		status: { ...value, providers: { ...value.providers, kimi: subscription("kimi", true) } },
	}));
	expect(document.getElementById("coding-oauth-source-preview-kimi")).toBe(section);
	expect(section.parentElement?.previousElementSibling?.querySelector("h3")?.textContent).toBe(en.kimiTitle);
	expect(document.activeElement).toBe(section);
	fireEvent.click(within(section).getByRole("checkbox"));
	expect(input.onConfirmOverwriteChange).toHaveBeenCalledWith(true);
	view.rerender(createElement(AccountsTab, { ...input, preview, confirmOverwrite: true }));
	fireEvent.click(within(section).getByRole("button", { name: en.sourcesCommit }));
	expect(input.onCommitSource).toHaveBeenCalledOnce();
	fireEvent.click(within(section).getByRole("button", { name: en.sourcesCancelPreview }));
	expect(input.onCancelSourcePreview).toHaveBeenCalledOnce();
	view.rerender(createElement(AccountsTab, input));
	expect(document.activeElement).toBe(document.getElementById("coding-oauth-source-pull-kimi"));
});

it("leaves new signing-in flows open with their browser link, code draft, keyboard submission and login handlers", () => {
	const value = status();
	value.providers.codex = subscription("codex", true);
	value.providers.kimi = { ...subscription("kimi"), status: "signing-in", method: "browser", url: "https://example.com/auth" };
	const input = { ...props(value), codeInputs: { kimi: "fixture-code" } };
	render(createElement(AccountsTab, input));
	expect(titles()).toEqual(expectedTitles("codex", "grok", "kimi", "claude", "go"));
	expect(screen.getByRole("link", { name: en.openAuthUrl }).getAttribute("href")).toBe("https://example.com/auth");
	const code = screen.getByLabelText(en.pasteCodeLabel) as HTMLInputElement;
	expect(code.value).toBe("fixture-code");
	fireEvent.change(code, { target: { value: "next-code" } });
	expect(input.onCodeChange).toHaveBeenCalledWith("kimi", "next-code");
	fireEvent.keyDown(code, { key: "Enter" });
	expect(input.onSubmitCode).toHaveBeenCalledWith("kimi");
	fireEvent.click(screen.getByRole("button", { name: en.cancelLogin }));
	expect(input.onCancelLogin).toHaveBeenCalledWith("kimi");
	fireEvent.click(document.getElementById("coding-oauth-login-claude")!);
	expect(input.onSignIn).toHaveBeenCalledWith("claude", "browser", undefined);
});
