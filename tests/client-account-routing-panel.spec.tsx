/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { AccountRoutingPanel } from "../src/client/components/AccountRoutingPanel.tsx";
import { en } from "../src/client/locales.ts";
import { failure, NOW, row, snapshot, t } from "./client-quota-fixtures.ts";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../src/client/api.ts", async (original) => ({
	...(await original<typeof import("../src/client/api.ts")>()),
	jsonRequest: mocks.request,
}));

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.resetAllMocks();
});

async function openPanel(view: Record<string, unknown>) {
	mocks.request.mockResolvedValueOnce(view);
	render(createElement(AccountRoutingPanel, { t }));
	fireEvent.click(screen.getByText(en.routingShow));
	await waitFor(() => expect(screen.getAllByText(/Claude|Codex/u).length).toBeGreaterThan(0));
}

it("renders accounts that have no numeric slot, with name and default mark", async () => {
	await openPanel(
		snapshot([
			row({ isDefault: true }),
			row({ route: "route-b", name: "Codex · Perso", label: "Perso", family: "codex" }),
		]),
	);
	expect(screen.getByText(`Claude · compte 1 ${en.quotaDefaultMark}`)).toBeTruthy();
	expect(screen.getByText("Codex · Perso")).toBeTruthy();
	expect(mocks.request).toHaveBeenCalledWith("/plugins/dsh-grok-build/routing", "GET", undefined);
	expect(screen.getAllByRole("progressbar").length).toBeGreaterThanOrEqual(2);
	expect(screen.getAllByText(/42 % used/u).length).toBeGreaterThan(0);
});

it("explains every state without numbers (never a mute 'unknown')", async () => {
	const states: Array<[Record<string, unknown>, string]> = [
		[{ state: "not-read", windows: [] }, en.quotaStateNotRead],
		[{ state: "unknown", windows: [] }, en.quotaStateNotRead],
		[{ state: "unsupported", windows: [] }, en.quotaStateUnsupported],
		[{ state: "disabled", windows: [] }, en.quotaStateDisabled],
		[{ state: "error", windows: [], errorCode: "RATE_LIMIT" }, `Read failed: ${en.quotaErrRateLimit}`],
		[{ state: "error", windows: [], errorCode: "NO_WINDOWS" }, `Read failed: ${en.quotaErrNoWindows}`],
		[{ state: "error", windows: [], errorCode: "SOMETHING_NEW" }, `Read failed: ${en.quotaErrUnknown}`],
	];
	for (const [quota, expected] of states) {
		await openPanel(snapshot([row({ quota })]));
		expect(screen.getByText(expected), expected).toBeTruthy();
		expect(document.body.textContent).not.toMatch(/\bunknown\b(?! cause)/iu);
		cleanup();
		vi.resetAllMocks();
	}
});

it("flags a stale reading with its failure cause", async () => {
	await openPanel(
		snapshot([
			row({
				quota: {
					state: "stale",
					errorCode: "TIMEOUT",
					fetchedAt: NOW - 600_000,
					windows: [{ id: "five_hour", usedPercent: 10 }],
				},
			}),
		]),
	);
	expect(screen.getByText(`Showing older values; the last read failed: ${en.quotaErrTimeout}`)).toBeTruthy();
});

it("renames an account inline with Enter and shows the new name", async () => {
	await openPanel(snapshot());
	fireEvent.click(screen.getByText(en.quotaRename));
	const input = screen.getByLabelText("Name of Claude · compte 1") as HTMLInputElement;
	fireEvent.change(input, { target: { value: "  Pro  " } });
	mocks.request.mockResolvedValueOnce(snapshot([row({ name: "Claude · Pro", label: "Pro" })]));
	fireEvent.keyDown(input, { key: "Enter" });
	await waitFor(() => expect(screen.getByText("Claude · Pro")).toBeTruthy());
	expect(mocks.request).toHaveBeenLastCalledWith("/plugins/dsh-grok-build/routing/accounts/label", "POST", {
		route: "route-a",
		label: "Pro",
	});
	expect(screen.queryByLabelText("Name of Claude · compte 1")).toBeNull();
});

it("clearing the field sends null (back to the automatic name)", async () => {
	await openPanel(snapshot([row({ name: "Claude · Pro", label: "Pro" })]));
	fireEvent.click(screen.getByText(en.quotaRename));
	const input = screen.getByLabelText("Name of Claude · Pro") as HTMLInputElement;
	expect(input.value).toBe("Pro");
	fireEvent.change(input, { target: { value: "   " } });
	mocks.request.mockResolvedValueOnce(snapshot());
	fireEvent.click(screen.getByText(en.quotaRenameSave));
	await waitFor(() => expect(screen.getByText("Claude · compte 1")).toBeTruthy());
	expect(mocks.request).toHaveBeenLastCalledWith(expect.any(String), "POST", { route: "route-a", label: null });
});

it("rejects an invalid name locally without calling the server; Escape cancels", async () => {
	await openPanel(snapshot());
	fireEvent.click(screen.getByText(en.quotaRename));
	const input = screen.getByLabelText("Name of Claude · compte 1");
	fireEvent.change(input, { target: { value: "x".repeat(41) } });
	fireEvent.keyDown(input, { key: "Enter" });
	expect(screen.getByRole("alert").textContent).toBe(en.quotaRenameInvalid);
	expect(mocks.request).toHaveBeenCalledTimes(1);
	fireEvent.keyDown(input, { key: "Escape" });
	expect(screen.queryByLabelText("Name of Claude · compte 1")).toBeNull();
	expect(mocks.request).toHaveBeenCalledTimes(1);
});

it("shows a safe message when the server refuses the rename and keeps the draft", async () => {
	await openPanel(snapshot());
	fireEvent.click(screen.getByText(en.quotaRename));
	const input = screen.getByLabelText("Name of Claude · compte 1") as HTMLInputElement;
	fireEvent.change(input, { target: { value: "Work" } });
	mocks.request.mockRejectedValueOnce(failure(404, "SERVER_SECRET_TEXT"));
	fireEvent.click(screen.getByText(en.quotaRenameSave));
	await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(en.quotaRenameNotFound));
	expect(document.body.textContent).not.toContain("SERVER_SECRET_TEXT");
	expect(input.value).toBe("Work");
	mocks.request.mockRejectedValueOnce(failure(403));
	fireEvent.click(screen.getByText(en.quotaRenameSave));
	await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(en.quotaRenameForbidden));
	mocks.request.mockRejectedValueOnce(failure(500));
	fireEvent.click(screen.getByText(en.quotaRenameSave));
	await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(en.quotaRenameFailed));
	mocks.request.mockRejectedValueOnce(failure(400));
	fireEvent.click(screen.getByText(en.quotaRenameSave));
	await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(en.quotaRenameInvalid));
});

it("refreshes through POST and keeps the last view when the refresh fails", async () => {
	await openPanel(snapshot());
	mocks.request.mockRejectedValueOnce(failure(500));
	fireEvent.click(screen.getByText(en.routingRefresh));
	await waitFor(() => expect(screen.getByText(en.quotaRefreshFailed, { exact: false })).toBeTruthy());
	expect(screen.getByText("Claude · compte 1")).toBeTruthy();
	expect(mocks.request).toHaveBeenLastCalledWith("/plugins/dsh-grok-build/routing/usage", "POST", {});
});

it("renders the 'routes are off' state and never offers a refresh when enabled is false", async () => {
	mocks.request.mockResolvedValueOnce(snapshot([row()], { enabled: false }));
	render(createElement(AccountRoutingPanel, { t }));
	fireEvent.click(screen.getByText(en.routingShow));
	await waitFor(() => expect(screen.getByText(en.routingOff)).toBeTruthy());
	expect(screen.queryByText(en.routingRefresh)).toBeNull();
	expect(screen.queryByText(en.quotaRename)).toBeNull();
});

it("with quota reading off (usageEnabled false): hint, no refresh button, accounts still shown", async () => {
	await openPanel(snapshot([row()], { usageEnabled: false }));
	expect(screen.getByText(en.quotaReadOnlyHint)).toBeTruthy();
	expect(screen.queryByText(en.routingRefresh)).toBeNull();
	expect(screen.getByText("Claude · compte 1")).toBeTruthy();
});

it("gives every progress bar an accessible name", async () => {
	await openPanel(snapshot());
	expect(screen.getByRole("progressbar", { name: "5 h window · 42 % used" })).toBeTruthy();
	expect(screen.getByRole("progressbar", { name: "Weekly window · 12 % used" })).toBeTruthy();
});

it("shows the next automatic read only when the server provides one", async () => {
	await openPanel(
		snapshot([
			row({
				quota: {
					state: "fresh",
					fetchedAt: Date.now(),
					nextRefreshAt: Date.now() + 600_000,
					windows: [{ id: "five_hour", usedPercent: 5 }],
				},
			}),
		]),
	);
	expect(screen.getAllByText(/Next automatic read around/u)).toHaveLength(1);
	cleanup();
	vi.resetAllMocks();
	await openPanel(snapshot());
	expect(screen.queryByText(/Next automatic read around/u)).toBeNull();
});

it("keeps the focus on the field while saving and after a failure (no disabled controls)", async () => {
	await openPanel(snapshot());
	fireEvent.click(screen.getByText(en.quotaRename));
	const input = screen.getByLabelText("Name of Claude · compte 1") as HTMLInputElement;
	expect(document.activeElement).toBe(input);
	fireEvent.change(input, { target: { value: "Work" } });
	let reject: (error: unknown) => void = () => undefined;
	mocks.request.mockImplementationOnce(
		() =>
			new Promise((_done, fail) => {
				reject = fail;
			}),
	);
	const save = screen.getByText(en.quotaRenameSave) as HTMLButtonElement;
	fireEvent.click(save);
	await waitFor(() => expect(input.readOnly).toBe(true));
	expect(input.disabled).toBe(false);
	expect(save.disabled).toBe(false);
	expect(screen.getByText(en.quotaRenameSaving).getAttribute("aria-disabled")).toBe("true");
	expect(document.activeElement).toBe(input);
	fireEvent.click(screen.getByText(en.quotaRenameSaving)); // ignored while sending
	fireEvent.keyDown(input, { key: "Enter" });
	expect(mocks.request).toHaveBeenCalledTimes(2);
	save.focus(); // a mouse click moved the focus to the button
	await act(async () => reject(failure(500)));
	await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(en.quotaRenameFailed));
	expect(input.readOnly).toBe(false);
	expect(document.activeElement).toBe(input);
	expect(input.value).toBe("Work");
});

it("puts the focus back on the Rename button after a successful rename and after Cancel", async () => {
	await openPanel(snapshot());
	fireEvent.click(screen.getByText(en.quotaRename));
	const input = screen.getByLabelText("Name of Claude · compte 1");
	fireEvent.change(input, { target: { value: "Pro" } });
	mocks.request.mockResolvedValueOnce(snapshot([row({ name: "Claude · Pro", label: "Pro" })]));
	fireEvent.keyDown(input, { key: "Enter" });
	await waitFor(() => expect(screen.getByText("Claude · Pro")).toBeTruthy());
	expect(document.activeElement).toBe(screen.getByText(en.quotaRename));
	fireEvent.click(screen.getByText(en.quotaRename));
	fireEvent.click(screen.getByText(en.quotaRenameCancel));
	expect(document.activeElement).toBe(screen.getByText(en.quotaRename));
});

it("ignores Enter and Escape while an IME composition is in progress", async () => {
	await openPanel(snapshot());
	fireEvent.click(screen.getByText(en.quotaRename));
	const input = screen.getByLabelText("Name of Claude · compte 1");
	fireEvent.change(input, { target: { value: "你好" } });
	fireEvent.keyDown(input, { key: "Enter", isComposing: true });
	fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
	fireEvent.keyDown(input, { key: "Escape", isComposing: true });
	expect(mocks.request).toHaveBeenCalledTimes(1); // only the initial GET
	expect(screen.getByLabelText("Name of Claude · compte 1")).toBeTruthy();
	mocks.request.mockResolvedValueOnce(snapshot([row({ name: "Claude · 你好", label: "你好" })]));
	fireEvent.keyDown(input, { key: "Enter" });
	await waitFor(() => expect(screen.getByText("Claude · 你好")).toBeTruthy());
});

it("clears 'Name saved.' when the next edit starts", async () => {
	await openPanel(snapshot());
	fireEvent.click(screen.getByText(en.quotaRename));
	fireEvent.change(screen.getByLabelText("Name of Claude · compte 1"), { target: { value: "Pro" } });
	mocks.request.mockResolvedValueOnce(snapshot([row({ name: "Claude · Pro", label: "Pro" })]));
	fireEvent.click(screen.getByText(en.quotaRenameSave));
	await waitFor(() => expect(screen.getByText(en.quotaRenamed)).toBeTruthy());
	fireEvent.click(screen.getByText(en.quotaRename));
	expect(screen.queryByText(en.quotaRenamed)).toBeNull();
});

it("clears 'Name saved.' after a delay", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	mocks.request.mockResolvedValueOnce(snapshot());
	render(createElement(AccountRoutingPanel, { t }));
	fireEvent.click(screen.getByText(en.routingShow));
	await act(async () => {
		await vi.advanceTimersByTimeAsync(0);
	});
	fireEvent.click(screen.getByText(en.quotaRename));
	fireEvent.change(screen.getByLabelText("Name of Claude · compte 1"), { target: { value: "Pro" } });
	mocks.request.mockResolvedValueOnce(snapshot([row({ name: "Claude · Pro", label: "Pro" })]));
	fireEvent.click(screen.getByText(en.quotaRenameSave));
	await act(async () => {
		await vi.advanceTimersByTimeAsync(0);
	});
	expect(screen.getByText(en.quotaRenamed)).toBeTruthy();
	await act(async () => {
		await vi.advanceTimersByTimeAsync(6000);
	});
	expect(screen.queryByText(en.quotaRenamed)).toBeNull();
});
