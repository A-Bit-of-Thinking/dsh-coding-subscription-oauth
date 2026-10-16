/** @vitest-environment jsdom */
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AccountsTab, type AccountsTabProps } from "../src/client/components/AccountsTab.tsx";
import { en } from "../src/client/locales.ts";
import type { CodingOAuthStatus, SubscriptionStatus } from "../src/client/types.ts";

vi.mock("../src/client/api.ts", async (original) => ({
	...(await original<typeof import("../src/client/api.ts")>()),
	// The OpenCode Go card in the same tab reads this endpoint on mount.
	jsonRequest: vi.fn(async () => ({
		credential: { selectedRef: undefined, configured: false, writable: true, requiresChoice: false, candidates: [] },
		configuration: { revision: 1, writable: true, ready: false, api: "openai-completions", conflicts: [], models: [] },
		call: { active: false, lastCall: "no-call", updatedAt: null },
	})),
}));

afterEach(cleanup);

function claude(accountCount: number): SubscriptionStatus {
	const accounts = Array.from({ length: accountCount }, (_, index) => ({
		id: `account-${String(index)}`,
		expires: 2_000_000_000_000,
	}));
	return {
		provider: "claude",
		route: "claude-code-oauth",
		displayName: "claude",
		loginMethods: ["browser"] as const,
		recommendedLoginMethod: "browser" as const,
		models: ["model-a"],
		available: ["model-a"],
		selected: ["model-a"],
		status: "signed-in",
		accounts,
		activeAccountId: "account-0",
	};
}

function props(accountCount: number): AccountsTabProps {
	const status: CodingOAuthStatus = {
		accessMode: "loopback",
		uiOwner: "standalone",
		compatibility: { coreAbi: "fixture", dshVersion: null, status: "healthy", diagnostics: [] },
		providers: {
			grok: { status: "signed-out", grokImportAvailable: false },
			codex: { ...claude(1), provider: "codex", route: "codex-oauth", status: "signed-out" } as never,
			kimi: { ...claude(1), provider: "kimi", route: "kimi-code-oauth", status: "signed-out" } as never,
			claude: claude(accountCount),
		},
		antigravity: { installed: false, route: "agy", management: "cli" },
		opencodeGo: { active: false, lastCall: "no-call", updatedAt: null },
	};
	return {
		t: (key, params) =>
			Object.entries(params ?? {}).reduce(
				(text, [name, replacement]) => text.replaceAll(`{${name}}`, String(replacement)),
				en[key],
			),
		status,
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

it("lets a connected provider add another account, without targeting an existing one", () => {
	const input = props(1);
	render(createElement(AccountsTab, input));
	const button = screen.getByRole("button", { name: en.accountAdd });
	fireEvent.click(button);
	// "add" mode is chosen by the caller when no target account id is passed.
	expect(input.onSignIn).toHaveBeenCalledWith("claude", "browser", undefined);
	expect(screen.getByText(en.accountAddHint)).toBeTruthy();
});

it("hides the button and explains the limit at 8 stored accounts", () => {
	render(createElement(AccountsTab, props(8)));
	expect(screen.queryByRole("button", { name: en.accountAdd })).toBeNull();
	expect(screen.getByText(en.accountAddLimit)).toBeTruthy();
});

it("offers no add button for a signed-out provider (its normal sign-in button already does it)", () => {
	render(createElement(AccountsTab, props(1)));
	// Only the connected provider (claude) shows the add button.
	expect(screen.getAllByRole("button", { name: en.accountAdd })).toHaveLength(1);
});
