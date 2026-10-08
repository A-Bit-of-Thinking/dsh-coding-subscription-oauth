/** @vitest-environment jsdom */
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
	OpenCodeGoConnectionView,
	type GoSnapshot,
	type GoViewProps,
} from "../src/client/components/OpenCodeGoConnectionView.tsx";
import { buttonStyle, cardStyle } from "../src/client/styles.ts";

afterEach(cleanup);

function snapshot(revision = 2): GoSnapshot {
	return {
		credential: {
			selectedRef: "EXISTING_GO_KEY",
			configured: true,
			writable: false,
			requiresChoice: false,
			candidates: [
				{ ref: "EXISTING_GO_KEY", configured: true, writable: false },
				{ ref: "OPENCODE_GO_API_KEY", configured: false, writable: true },
			],
		},
		configuration: {
			revision,
			writable: true,
			ready: true,
			conflicts: [],
			models: [{ id: "deepseek-v4.1-flash" }],
		},
		call: { active: true, lastCall: "no-call", updatedAt: null },
	};
}

function props(): GoViewProps {
	const status = snapshot();
	return {
		status,
		t: (key) => key,
		onReload: vi.fn(async () => status),
		onSaveCredential: vi.fn(async () => status),
		onLoadModels: vi.fn(async () => ({
			models: [
				{ id: "deepseek-v4.1-flash" },
				{ id: "deepseek-v4-flash", reasoningEfforts: { high: "high" } },
				{ id: "gpt-5.6-luna" },
			],
		})),
		onApply: vi.fn(async () => status),
		onStartConversation: vi.fn(),
	};
}

it("starts folded with the existing card, heading, badge and accessible native manage button", () => {
	const input = props();
	render(createElement(OpenCodeGoConnectionView, input));
	const article = screen.getByRole("article", { name: "title" });
	const toggle = screen.getByRole("button", { name: "edit" });
	const details = document.getElementById(toggle.getAttribute("aria-controls")!);
	expect(screen.getByRole("heading", { level: 3, name: "title" })).toBeTruthy();
	expect(screen.getByRole("status").textContent).toBe("configured");
	expect(screen.getByText("model · 1")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "startConversation" }));
	expect(input.onStartConversation).toHaveBeenCalledOnce();
	expect(article.style.padding).toBe(cardStyle.padding);
	expect(toggle.style.borderRadius).toBe(`${buttonStyle.borderRadius}px`);
	expect(toggle.tagName).toBe("BUTTON");
	expect(toggle.getAttribute("type")).toBe("button");
	expect(toggle.getAttribute("aria-expanded")).toBe("false");
	expect(details?.hidden).toBe(true);
	expect(screen.queryByRole("button", { name: "apply" })).toBeNull();
	expect(screen.queryByLabelText("apiKey")).toBeNull();
	toggle.focus();
	expect(fireEvent.keyDown(toggle, { key: "Enter" })).toBe(true);
	fireEvent.click(toggle);
	expect(toggle.getAttribute("aria-expanded")).toBe("true");
	expect(details?.hidden).toBe(false);
	expect(document.activeElement).toBe(toggle);
	fireEvent.click(screen.getByRole("button", { name: "collapse" }));
	expect(details?.hidden).toBe(true);
	expect(document.activeElement).toBe(toggle);
	expect(input.onSaveCredential).not.toHaveBeenCalled();
	expect(input.onApply).not.toHaveBeenCalled();
});

it("opens the configured credential directly and respects source permissions", () => {
	const input = props();
	render(createElement(OpenCodeGoConnectionView, input));
	fireEvent.click(screen.getByRole("button", { name: "edit" }));
	expect((screen.getByLabelText("credential") as HTMLSelectElement).value).toBe("EXISTING_GO_KEY");
	expect((screen.getByLabelText("apiKey") as HTMLInputElement).disabled).toBe(true);
	fireEvent.change(screen.getByLabelText("credential"), { target: { value: "OPENCODE_GO_API_KEY" } });
	expect((screen.getByLabelText("apiKey") as HTMLInputElement).disabled).toBe(false);
	expect((screen.getByRole("button", { name: "fetchModels" }) as HTMLButtonElement).disabled).toBe(true);
});

it("uses a fresh query revision for new edits and applies the enabled model set", async () => {
	const input = props();
	const view = render(createElement(OpenCodeGoConnectionView, input));
	view.rerender(createElement(OpenCodeGoConnectionView, { ...input, status: snapshot(9) }));
	fireEvent.click(screen.getByRole("button", { name: "edit" }));
	fireEvent.click(screen.getByRole("button", { name: "fetchModels" }));
	await waitFor(() => expect(input.onLoadModels).toHaveBeenCalled());
	const flash = await screen.findByRole("checkbox", { name: /deepseek-v4-flash/i });
	fireEvent.click(flash);
	view.rerender(createElement(OpenCodeGoConnectionView, { ...input, status: snapshot(10) }));
	fireEvent.click(screen.getByRole("button", { name: "apply" }));
	await waitFor(() =>
		expect(input.onApply).toHaveBeenCalledWith(
			expect.objectContaining({
				expectedRevision: 9,
				credentialRef: "EXISTING_GO_KEY",
				models: expect.arrayContaining([
					{ id: "deepseek-v4.1-flash" },
					expect.objectContaining({ id: "deepseek-v4-flash" }),
				]),
			}),
		),
	);
});

it("also starts folded when unconfigured, despite a previous successful request", () => {
	const input = props();
	const base = snapshot();
	render(createElement(OpenCodeGoConnectionView, {
		...input,
		status: { ...base, configuration: { ...base.configuration, ready: false } },
		call: { active: true, lastCall: "success", updatedAt: 10 },
	}));
	expect(screen.getByRole("button", { name: "edit" }).getAttribute("aria-expanded")).toBe("false");
	expect(screen.queryByRole("combobox")).toBeNull();
	expect(screen.queryByText("configured")).toBeNull();
	expect(screen.queryByRole("button", { name: "startConversation" })).toBeNull();
	expect(screen.getByText("status.success")).toBeTruthy();
});

it("requires explicit credential choice when multiple unbound sources exist", () => {
	const input = props();
	const base = snapshot();
	render(createElement(OpenCodeGoConnectionView, {
		...input,
		status: {
			...base,
			credential: { ...base.credential, requiresChoice: true },
			configuration: { ...base.configuration, ready: false },
		},
	}));
	fireEvent.click(screen.getByRole("button", { name: "edit" }));
	expect((screen.getByLabelText("credential") as HTMLSelectElement).value).toBe("");
	expect((screen.getByRole("button", { name: "apply" }) as HTMLButtonElement).disabled).toBe(true);
});

it("retains failed credential input when folded and displays errors and a later cancelled call", async () => {
	const input = {
		...props(),
		onSaveCredential: vi.fn(async () => { throw new Error("storage blocked"); }),
	};
	const base = snapshot();
	const view = render(createElement(OpenCodeGoConnectionView, {
		...input,
		status: { ...base, configuration: { ...base.configuration, ready: false } },
	}));
	fireEvent.click(screen.getByRole("button", { name: "edit" }));
	fireEvent.change(screen.getByLabelText("credential"), { target: { value: "OPENCODE_GO_API_KEY" } });
	fireEvent.change(screen.getByLabelText("apiKey"), { target: { value: "fixture-only" } });
	fireEvent.click(screen.getByRole("button", { name: "saveKey" }));
	await screen.findByText("storage blocked");
	const apiKey = screen.getByLabelText("apiKey");
	fireEvent.click(screen.getByRole("button", { name: "collapse" }));
	expect(screen.getByRole("alert").textContent).toContain("storage blocked");
	expect(screen.queryByRole("button", { name: "saveKey" })).toBeNull();
	expect(document.querySelector("article")?.getAttribute("data-unsaved")).toBe("true");
	fireEvent.click(screen.getByRole("button", { name: "reload" }));
	await waitFor(() => expect(input.onReload).toHaveBeenCalledOnce());
	view.rerender(createElement(OpenCodeGoConnectionView, {
		...input,
		status: snapshot(10),
		call: { active: true, lastCall: "failure", streamStatus: "cancelled", updatedAt: 10 },
	}));
	expect(screen.getByText("status.cancelled")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "edit" }));
	expect(screen.getByLabelText("apiKey")).toBe(apiKey);
	expect((apiKey as HTMLInputElement).value).toBe("fixture-only");
	expect((screen.getByLabelText("credential") as HTMLSelectElement).value).toBe("OPENCODE_GO_API_KEY");
	expect(input.onSaveCredential).toHaveBeenCalledOnce();
	expect(input.onApply).not.toHaveBeenCalled();
});

it("keeps protocol, model selection and conflict confirmation across folding and refresh", async () => {
	const input = props();
	const base = snapshot();
	const status = { ...base, configuration: { ...base.configuration, conflicts: ["baseURL"] } };
	const view = render(createElement(OpenCodeGoConnectionView, { ...input, status }));
	fireEvent.click(screen.getByRole("button", { name: "edit" }));
	fireEvent.click(screen.getByRole("button", { name: "fetchModels" }));
	await screen.findByText("directoryLoaded");
	fireEvent.change(screen.getByLabelText("protocol"), { target: { value: "openai-responses" } });
	fireEvent.click(screen.getByRole("checkbox", { name: "gpt-5.6-luna" }));
	fireEvent.click(screen.getByRole("checkbox", { name: "confirmConflict" }));
	fireEvent.click(screen.getByRole("button", { name: "collapse" }));
	view.rerender(createElement(OpenCodeGoConnectionView, { ...input, status: { ...status } }));
	fireEvent.click(screen.getByRole("button", { name: "edit" }));
	expect((screen.getByLabelText("protocol") as HTMLSelectElement).value).toBe("openai-responses");
	expect((screen.getByRole("checkbox", { name: "gpt-5.6-luna" }) as HTMLInputElement).checked).toBe(true);
	expect((screen.getByRole("checkbox", { name: "confirmConflict" }) as HTMLInputElement).checked).toBe(true);
	view.rerender(createElement(OpenCodeGoConnectionView, {
		...input,
		status: { ...status, configuration: { ...status.configuration, revision: 10 } },
	}));
	expect((screen.getByRole("checkbox", { name: "confirmConflict" }) as HTMLInputElement).checked).toBe(false);
	expect((screen.getByRole("button", { name: "apply" }) as HTMLButtonElement).disabled).toBe(true);
	expect(screen.getByText("configurationChanged")).toBeTruthy();
});

it("keeps a pending credential action single-flight while details are folded and reopened", async () => {
	let finish!: (status: GoSnapshot) => void;
	const saving = new Promise<GoSnapshot>((resolve) => { finish = resolve; });
	const input = { ...props(), onSaveCredential: vi.fn(() => saving) };
	render(createElement(OpenCodeGoConnectionView, input));
	fireEvent.click(screen.getByRole("button", { name: "edit" }));
	fireEvent.click(screen.getByRole("button", { name: "reuse" }));
	fireEvent.click(screen.getByRole("button", { name: "collapse" }));
	fireEvent.click(screen.getByRole("button", { name: "edit" }));
	const reuse = screen.getByRole("button", { name: "reuse" }) as HTMLButtonElement;
	expect(reuse.disabled).toBe(true);
	fireEvent.click(reuse);
	expect(input.onSaveCredential).toHaveBeenCalledOnce();
	finish(snapshot());
	await screen.findByText("credentialSaved");
	await waitFor(() => expect(reuse.disabled).toBe(false));
});

it("keeps load errors and retry accessible even before the connection is expanded", async () => {
	const input = props();
	render(createElement(OpenCodeGoConnectionView, { ...input, status: undefined, loadError: "read failed" }));
	expect(screen.getByRole("alert").textContent).toContain("read failed");
	fireEvent.click(screen.getByRole("button", { name: "reload" }));
	await waitFor(() => expect(input.onReload).toHaveBeenCalledOnce());
	expect(screen.getByRole("button", { name: "edit" }).getAttribute("aria-expanded")).toBe("false");
});

it("keeps the model list inside the card instead of a floating datalist", async () => {
	const input = props();
	const base = snapshot();
	render(createElement(OpenCodeGoConnectionView, {
		...input,
		status: { ...base, configuration: { ...base.configuration, ready: false } },
	}));
	fireEvent.click(screen.getByRole("button", { name: "edit" }));
	fireEvent.click(screen.getByRole("button", { name: "fetchModels" }));
	await screen.findByRole("group", { name: "model" });
	expect(document.querySelector("datalist")).toBeNull();
});
