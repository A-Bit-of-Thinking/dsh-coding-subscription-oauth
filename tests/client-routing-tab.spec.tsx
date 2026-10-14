/** @vitest-environment jsdom */
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RoutingTab } from "../src/client/components/RoutingTab.tsx";
import { en } from "../src/client/locales.ts";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../src/client/api.ts", async (original) => ({
	...(await original<typeof import("../src/client/api.ts")>()),
	jsonRequest: mocks.request,
}));

const t = ((key: keyof typeof en) => en[key]) as never;
const value = { enabled: false, usageEnabled: false, guidanceEnabled: false, enforcePolicy: false, policyJson: "" };
const snapshot = (overrides: Record<string, unknown> = {}, revision = 5, writable = true) => ({
	revision,
	writable,
	value: { ...value, ...overrides },
});
const failure = (status: number, code: string) =>
	Object.assign(new Error(code), { name: "PluginRequestError", status, code });

afterEach(() => {
	cleanup();
	vi.resetAllMocks();
});

const toggle = (label: string) => screen.getByRole("switch", { name: label });

it("loads everything off, saves only the changed key with the expected revision", async () => {
	mocks.request.mockResolvedValueOnce(snapshot());
	render(createElement(RoutingTab, { t }));
	await waitFor(() => expect(screen.getByText(en.routingFlagEnabled)).toBeTruthy());
	expect((screen.getByText(en.routingSave).closest("button") as HTMLButtonElement).disabled).toBe(true);
	fireEvent.click(toggle(en.routingFlagEnabled));
	mocks.request.mockResolvedValueOnce(snapshot({ enabled: true }, 6));
	fireEvent.click(screen.getByText(en.routingSave));
	await waitFor(() => expect(screen.getByText(en.routingSaved)).toBeTruthy());
	expect(mocks.request).toHaveBeenLastCalledWith("/plugins/dsh-grok-build/routing/settings", "PATCH", {
		expectedRevision: 5,
		patch: { enabled: true },
	});
});

it("keeps the user's edits and reloads the revision after a conflict", async () => {
	mocks.request.mockResolvedValueOnce(snapshot());
	render(createElement(RoutingTab, { t }));
	await waitFor(() => expect(screen.getByLabelText(en.routingPolicyLabel)).toBeTruthy());
	const policy = screen.getByLabelText(en.routingPolicyLabel) as HTMLTextAreaElement;
	fireEvent.change(policy, { target: { value: "MY_UNSAVED_POLICY_TEXT" } });
	mocks.request.mockRejectedValueOnce(failure(409, "SETTINGS_CONFLICT")).mockResolvedValueOnce(snapshot({}, 9));
	fireEvent.click(screen.getByText(en.routingSave));
	await waitFor(() => expect(screen.getByText(en.routingConflict)).toBeTruthy());
	expect((screen.getByLabelText(en.routingPolicyLabel) as HTMLTextAreaElement).value).toBe("MY_UNSAVED_POLICY_TEXT");
	mocks.request.mockResolvedValueOnce(snapshot({ policyJson: "MY_UNSAVED_POLICY_TEXT" }, 10));
	fireEvent.click(screen.getByText(en.routingSave));
	await waitFor(() => expect(mocks.request).toHaveBeenLastCalledWith(expect.any(String), "PATCH", expect.objectContaining({ expectedRevision: 9 })));
});

it("explains a rejected policy without losing the draft", async () => {
	mocks.request.mockResolvedValueOnce(snapshot());
	render(createElement(RoutingTab, { t }));
	await waitFor(() => expect(screen.getByLabelText(en.routingPolicyLabel)).toBeTruthy());
	fireEvent.change(screen.getByLabelText(en.routingPolicyLabel), { target: { value: "{bad" } });
	mocks.request.mockRejectedValueOnce(failure(400, "policy_invalid"));
	fireEvent.click(screen.getByText(en.routingSave));
	await waitFor(() => expect(screen.getByText(en.routingPolicyRejected)).toBeTruthy());
	expect((screen.getByLabelText(en.routingPolicyLabel) as HTMLTextAreaElement).value).toBe("{bad");
});

it("shows a read-only host as disabled controls", async () => {
	mocks.request.mockResolvedValueOnce(snapshot({}, 0, false));
	render(createElement(RoutingTab, { t }));
	await waitFor(() => expect(screen.getAllByText(en.routingReadOnly).length).toBeGreaterThan(0));
	expect((toggle(en.routingFlagEnabled) as HTMLButtonElement).disabled).toBe(true);
	expect((screen.getByLabelText(en.routingPolicyLabel) as HTMLTextAreaElement).disabled).toBe(true);
});

it("offers a retry when the first load fails and never renders server text", async () => {
	mocks.request.mockRejectedValueOnce(Object.assign(new Error("SERVER_SECRET_TEXT"), { status: 500 }));
	render(createElement(RoutingTab, { t }));
	await waitFor(() => expect(screen.getByText(en.routingLoadFailed)).toBeTruthy());
	expect(document.body.textContent).not.toContain("SERVER_SECRET_TEXT");
	mocks.request.mockResolvedValueOnce(snapshot());
	fireEvent.click(screen.getByText(en.routingRetry));
	await waitFor(() => expect(screen.getByText(en.routingFlagEnabled)).toBeTruthy());
});
