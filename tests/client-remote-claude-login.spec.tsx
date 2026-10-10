/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ProviderCard, type ProviderCardProps } from "../src/client/components/ProviderCard.tsx";
import { PROVIDERS } from "../src/client/constants.ts";
import { en, zh } from "../src/client/locales.ts";

afterEach(cleanup);

const initialStatus = {
	status: "signed-out" as const, provider: "claude" as const, route: "claude-code-oauth", displayName: "Claude",
	loginMethods: ["browser" as const], recommendedLoginMethod: "browser" as const, models: [], available: [], selected: [],
};

function fixture(copy = en): ProviderCardProps {
	return {
		t: (key) => copy[key],
		definition: PROVIDERS.find((item) => item.slug === "claude")!,
		providerStatus: initialStatus,
		busy: false, sourcesBusy: false, remote: true, codeInput: "", popupBlocked: false, expanded: false,
		source: undefined, showUsage: false, usage: undefined, usageError: undefined, usageLoading: false,
		onSignIn: vi.fn(), onSignOut: vi.fn(), onCancelLogin: vi.fn(), onSubmitCode: vi.fn(),
		onCodeChange: vi.fn(), onToggleExpanded: vi.fn(), onPreviewSource: vi.fn(),
		onSaveModels: vi.fn(async () => undefined), onSetDefaultAccount: vi.fn(),
		onRemoveAccount: vi.fn(async () => true), onRetryStatus: vi.fn(),
	};
}

it.each([en, zh])("explains the remote callback before starting and asks for user action after authorization", (copy) => {
	const props = fixture(copy);
	const view = render(createElement(ProviderCard, props));
	expect(screen.getByText(copy.remoteClaudeSignInHint)).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: copy.browserLogin }));
	expect(props.onSignIn).toHaveBeenCalledWith("browser");
	view.rerender(createElement(ProviderCard, {
		...props, providerStatus: { ...initialStatus, status: "signing-in", method: "browser", url: "https://example.com/authorize" },
	}));
	expect(screen.getByRole("status").textContent).toContain(copy.waitingForCallbackUrl);
	expect(screen.queryByText(copy.signInStepWait)).toBeNull();
	const input = screen.getByRole("textbox", { name: copy.callbackUrlLabel });
	expect(document.getElementById(input.getAttribute("aria-describedby")!)).toBe(screen.getByText(copy.remoteClaudeSignInHint));
	expect((screen.getByRole("button", { name: copy.finishSignIn }) as HTMLButtonElement).disabled).toBe(true);
	const url = "http://localhost:12345/callback?code=fixture-code&state=fixture-state";
	fireEvent.change(input, { target: { value: url } });
	expect(props.onCodeChange).toHaveBeenCalledWith(url);
	view.rerender(createElement(ProviderCard, {
		...props, codeInput: url, providerStatus: { ...initialStatus, status: "signing-in", method: "browser", url: "https://example.com/authorize" },
	}));
	fireEvent.click(screen.getByRole("button", { name: copy.finishSignIn }));
	expect(props.onSubmitCode).toHaveBeenCalledOnce();
	view.rerender(createElement(ProviderCard, {
		...props, providerStatus: { ...initialStatus, status: "signed-in", accounts: [], activeAccountId: "fixture-account" },
	}));
	expect(screen.getByRole("status").textContent).toContain(copy.signedIn);
	expect(screen.queryByText(copy.remoteClaudeSignInHint)).toBeNull();
});

it("preserves automatic waiting for local browser callbacks and remote device-code sign-in", () => {
	const props = fixture();
	const view = render(createElement(ProviderCard, {
		...props, remote: false, providerStatus: { ...initialStatus, status: "signing-in", method: "browser", url: "https://example.com/authorize" },
	}));
	expect(screen.getByText(en.signInStepWait)).toBeTruthy();
	expect(screen.queryByText(en.remoteClaudeSignInHint)).toBeNull();
	view.rerender(createElement(ProviderCard, {
		...props, definition: PROVIDERS.find((item) => item.slug === "codex")!,
		providerStatus: { ...initialStatus, provider: "codex", status: "signing-in", method: "device", url: "https://example.com/authorize", userCode: "fixture-device-code" },
	}));
	expect(screen.getByText(en.signInStepWait)).toBeTruthy();
	expect(screen.queryByRole("textbox")).toBeNull();
	expect(screen.queryByText(en.remoteClaudeSignInHint)).toBeNull();
});

it("automatically submits a matching pasted callback once while leaving unrelated input manual", () => {
	const props = fixture();
	const view = render(createElement(ProviderCard, {
		...props, providerStatus: { ...initialStatus, status: "signing-in", method: "browser",
			url: "https://claude.ai/oauth/authorize?state=pending-state&redirect_uri=http%3A%2F%2Flocalhost%3A53692%2Fcallback" },
	}));
	const input = screen.getByRole("textbox", { name: en.callbackUrlLabel });
	const paste = (text: string) => fireEvent.paste(input, { clipboardData: { getData: () => text } });
	paste("fixture-code");
	paste("http://localhost:53692/callback?code=fixture-code&state=stale-state");
	expect(props.onSubmitCode).not.toHaveBeenCalled();
	const callback = "http://localhost:53692/callback?code=fixture-code&state=pending-state";
	paste(callback);
	expect(props.onCodeChange).toHaveBeenCalledWith(callback);
	expect(props.onSubmitCode).toHaveBeenCalledWith(callback);
	paste(callback);
	expect(props.onSubmitCode).toHaveBeenCalledOnce();
	view.rerender(createElement(ProviderCard, {
		...props, busy: true, providerStatus: { ...initialStatus, status: "signing-in", method: "browser",
			url: "https://claude.ai/oauth/authorize?state=pending-state&redirect_uri=http%3A%2F%2Flocalhost%3A53692%2Fcallback" },
	}));
	expect(screen.getByRole("status").textContent).toContain(en.finishingSignIn);
});
