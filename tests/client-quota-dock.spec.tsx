/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QUOTA_POLL_MS, QuotaDock } from "../src/client/components/QuotaDock.tsx";
import { formatClock } from "../src/client/quotaModel.ts";
import { en } from "../src/client/locales.ts";
import { registerQuotaDock } from "../src/client/quotaDockSlot.ts";
import { failure, NOW, row, snapshot, t } from "./client-quota-fixtures.ts";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../src/client/api.ts", async (original) => ({
	...(await original<typeof import("../src/client/api.ts")>()),
	jsonRequest: mocks.request,
}));

const GET = ["/plugins/dsh-grok-build/routing", "GET", undefined];
const getCalls = () => mocks.request.mock.calls.filter((call) => call[0] === GET[0] && call[1] === "GET").length;
const flush = async (ms = 0) => {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
};
const quota = (overrides: Record<string, unknown>) => ({
	state: "fresh",
	fetchedAt: NOW - 3 * 60_000,
	windows: [{ id: "five_hour", usedPercent: 42 }],
	...overrides,
});

beforeEach(() => {
	vi.useFakeTimers({
		toFake: [
			"setInterval",
			"clearInterval",
			"setTimeout",
			"clearTimeout",
			"Date",
			"requestAnimationFrame",
			"cancelAnimationFrame",
		],
	});
	vi.setSystemTime(NOW);
	localStorage.clear();
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.resetAllMocks();
	// The visibility tests override the getter on the document instance: restore the prototype getter.
	Reflect.deleteProperty(document, "visibilityState");
});

async function mountDock(first: unknown = snapshot([row({ isDefault: true })])) {
	// First call = mount read; later calls (open, poll) repeat the same outcome unless a test queues another.
	if (first instanceof Error) mocks.request.mockRejectedValue(first);
	else mocks.request.mockResolvedValue(first);
	const view = render(createElement(QuotaDock, { t }));
	await flush();
	return view;
}
const trigger = () => screen.getByRole("button", { name: /Account quotas/u });
const openDock = async () => {
	fireEvent.click(trigger());
	await flush();
};
const refreshButton = () => screen.getByRole("button", { name: en.quotaRefresh });

it("renders nothing when routing is disabled", async () => {
	const { container } = await mountDock(snapshot([row()], { enabled: false }));
	expect(container.textContent).toBe("");
	expect(screen.queryByRole("button")).toBeNull();
	expect(getCalls()).toBe(1);
});

it("renders nothing (no error) when the server refuses the owner check", async () => {
	const { container } = await mountDock(failure(403));
	expect(container.textContent).toBe("");
	expect(screen.queryByRole("alert")).toBeNull();
});

it("renders nothing (no error) when the route does not exist (404 at mount)", async () => {
	const { container } = await mountDock(failure(404));
	expect(container.textContent).toBe("");
	expect(screen.queryByRole("button")).toBeNull();
	expect(screen.queryByRole("alert")).toBeNull();
});

it("shows a neutral button and opens/closes with aria-expanded", async () => {
	await mountDock(
		snapshot([
			row({ isDefault: true }),
			row({
				route: "r2",
				name: "Codex · compte 1",
				quota: { state: "fresh", windows: [{ id: "five_hour", usedPercent: 80 }] },
			}),
		]),
	);
	expect(trigger().getAttribute("aria-label")).toBe(en.quotaButtonAria);
	expect(trigger().hasAttribute("data-tone")).toBe(false);
	expect(trigger().hasAttribute("data-stale")).toBe(false);
	expect(trigger().hasAttribute("title")).toBe(false);
	expect(trigger().textContent).toBe("Quotas");
	expect(trigger().getAttribute("aria-expanded")).toBe("false");
	expect(screen.queryByRole("dialog")).toBeNull();
	await openDock();
	expect(trigger().getAttribute("aria-expanded")).toBe("true");
	const dialog = screen.getByRole("dialog", { name: en.quotaPopupTitle });
	expect(dialog.textContent).toContain(`Claude · compte 1${en.quotaDefaultMark}`);
	expect(dialog.textContent).toContain("Codex · compte 1");
	expect(dialog.textContent).toContain("42 % used");
	expect(dialog.textContent).toContain("Last read ");
	expect(screen.getAllByRole("progressbar").length).toBeGreaterThanOrEqual(3);
	expect(screen.getByRole("progressbar", { name: "5 h · 42 % used" })).toBeTruthy();
	fireEvent.click(trigger());
	expect(screen.queryByRole("dialog")).toBeNull();
});

it("keeps a stale trigger neutral and shows the last failure beside known numbers", async () => {
	await mountDock(snapshot([row({ quota: quota({ state: "stale", errorCode: "TIMEOUT" }) })]));
	expect(trigger().textContent).toBe("Quotas");
	expect(trigger().hasAttribute("data-stale")).toBe(false);
	expect(trigger().hasAttribute("data-tone")).toBe(false);
	await openDock();
	expect(screen.getByRole("alert").textContent).toBe(`Last read failed: ${en.quotaErrTimeout}`);
	expect(screen.getByRole("progressbar")).toBeTruthy();
	expect(document.body.textContent).not.toMatch(/out of date|older values/iu);
});

it("moves focus into the panel only after its first positioned render, on every opening", async () => {
	const original = HTMLElement.prototype.focus;
	const seen: Array<{ visibility: string; element: string }> = [];
	const spy = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement) {
		const panel = this.closest<HTMLElement>(".dsh-coding-oauth-quota-panel");
		if (panel !== null)
			seen.push({ visibility: panel.style.visibility, element: this.getAttribute("aria-label") ?? "" });
		original.call(this);
	});
	try {
		await mountDock();
		await openDock();
		// jsdom ignores visibility for focus(), so assert on what the panel looked like when focus() ran.
		expect(seen).toEqual([{ visibility: "", element: en.quotaToggleDetails }]);
		expect((document.activeElement as HTMLElement).getAttribute("aria-label")).toBe(en.quotaToggleDetails);
		await flush(QUOTA_POLL_MS * 2); // later re-measures/polls do not steal focus again
		expect(seen).toHaveLength(1);
		fireEvent.click(trigger()); // close
		await openDock(); // reopen: focus again, still after positioning
		expect(seen).toHaveLength(2);
		expect(seen[1]?.visibility).toBe("");
	} finally {
		spy.mockRestore();
	}
});

it("closes on Escape (focus back on the button) and on outside click", async () => {
	await mountDock();
	await openDock();
	fireEvent.keyDown(document, { key: "Escape" });
	await flush();
	expect(screen.queryByRole("dialog")).toBeNull();
	expect(document.activeElement).toBe(trigger());
	await openDock();
	fireEvent.mouseDown(document.body);
	expect(screen.queryByRole("dialog")).toBeNull();
	await openDock();
	fireEvent.mouseDown(screen.getByRole("dialog"));
	expect(screen.getByRole("dialog")).toBeTruthy();
});

it("can be minimized and restored without closing; the toggle keeps one stable name", async () => {
	await mountDock();
	await openDock();
	const toggle = screen.getByRole("button", { name: en.quotaToggleDetails });
	expect(toggle.getAttribute("aria-expanded")).toBe("true");
	fireEvent.click(toggle);
	expect(screen.getByRole("button", { name: en.quotaToggleDetails })).toBe(toggle);
	expect(toggle.getAttribute("aria-expanded")).toBe("false");
	expect(document.getElementById("dsh-coding-oauth-quota-body")?.hasAttribute("hidden")).toBe(true);
	fireEvent.click(toggle);
	expect(toggle.getAttribute("aria-expanded")).toBe("true");
	expect(document.getElementById("dsh-coding-oauth-quota-body")?.hasAttribute("hidden")).toBe(false);
	fireEvent.click(screen.getByRole("button", { name: en.quotaClose }));
	expect(screen.queryByRole("dialog")).toBeNull();
});

it("bounds the panel inside the viewport (8 px margins) and re-measures on resize, one frame at a time", async () => {
	const width = window.innerWidth;
	const height = window.innerHeight;
	const setViewport = (w: number, h: number): void => {
		Object.defineProperty(window, "innerWidth", { configurable: true, value: w });
		Object.defineProperty(window, "innerHeight", { configurable: true, value: h });
	};
	// A trigger near the left edge: the old right-anchored 320 px panel would have started at x < 0.
	const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
		top: 560,
		right: 60,
		left: 20,
		bottom: 580,
		width: 40,
		height: 20,
		x: 20,
		y: 560,
		toJSON: () => ({}),
	});
	setViewport(400, 600);
	try {
		await mountDock();
		await openDock();
		const panel = screen.getByRole("dialog") as HTMLElement;
		expect(panel.style.visibility).toBe("");
		expect(panel.style.width).toBe("360px");
		expect(panel.style.left).toBe("8px");
		expect(panel.style.top).toBe("72px");
		expect(panel.style.height).toBe("480px");

		const raf = vi.spyOn(window, "requestAnimationFrame");
		for (let i = 0; i < 5; i++) window.dispatchEvent(new Event("scroll"));
		window.dispatchEvent(new Event("resize"));
		expect(raf).toHaveBeenCalledTimes(1); // coalesced: no continuous re-render
		setViewport(300, 600);
		await flush(40); // a fake animation frame fires at the next 16 ms boundary
		expect(panel.style.width).toBe("284px"); // min(320px, viewport - 16px)
		expect(panel.style.left).toBe("8px");
		const after = raf.mock.calls.length;
		await flush(100);
		expect(raf.mock.calls.length).toBe(after); // nothing keeps scheduling frames
	} finally {
		rect.mockRestore();
		setViewport(width, height);
	}
});

it("refreshes with POST, disables the button while pending and announces a current snapshot", async () => {
	await mountDock();
	await openDock();
	let resolve: (value: unknown) => void = () => undefined;
	mocks.request.mockImplementationOnce(
		() =>
			new Promise((done) => {
				resolve = done;
			}),
	);
	fireEvent.click(refreshButton());
	await flush();
	const busy = screen.getByRole("button", { name: en.quotaRefreshing }) as HTMLButtonElement;
	expect(busy.disabled).toBe(true);
	expect(mocks.request).toHaveBeenLastCalledWith("/plugins/dsh-grok-build/routing/usage", "POST", {});
	await act(async () => resolve(snapshot([row({ isDefault: true })]))); // same fetchedAt as before
	await flush();
	expect((refreshButton() as HTMLButtonElement).disabled).toBe(false);
	expect(screen.getByRole("status").textContent).toBe(en.quotaRefreshCurrent);
});

it("shows fresh numbers after a refresh that really read the provider", async () => {
	await mountDock();
	await openDock();
	mocks.request.mockResolvedValueOnce(
		snapshot([row({ quota: { state: "fresh", fetchedAt: NOW, windows: [{ id: "five_hour", usedPercent: 91 }] } })]),
	);
	fireEvent.click(refreshButton());
	await flush();
	expect(screen.queryByRole("status")).toBeNull();
	expect(screen.getByRole("dialog").textContent).toContain("91 % used");
	expect(screen.getByRole("dialog").textContent).toContain("Last read ");
});

it("reports a failed refresh without echoing server text", async () => {
	await mountDock();
	await openDock();
	mocks.request.mockRejectedValueOnce(failure(500, "SERVER_SECRET_TEXT"));
	fireEvent.click(refreshButton());
	await flush();
	expect(screen.getByRole("alert").textContent).toBe(en.quotaRefreshFailed);
	expect(document.body.textContent).not.toContain("SERVER_SECRET_TEXT");
});

it("a refresh answered 200 but with a provider error shows the cause, never 'read recently'", async () => {
	await mountDock(); // fresh, fetchedAt = NOW - 3 min
	await openDock();
	mocks.request.mockResolvedValueOnce(
		snapshot([row({ quota: { state: "error", errorCode: "RATE_LIMIT", fetchedAt: NOW - 3 * 60_000, windows: [] } })]),
	);
	fireEvent.click(refreshButton());
	await flush();
	const text = screen.getByRole("dialog").textContent ?? "";
	expect(text).not.toContain(en.quotaRefreshCurrent);
	expect(text).toContain(`Read failed: ${en.quotaErrRateLimit}`);
	expect(text).toContain(en.quotaRefreshProviderError);
});

it("a stale reading with a new error code after a refresh shows the cause, not 'read recently'", async () => {
	const stale = (errorCode?: string) =>
		snapshot([
			row({
				quota: quota({
					state: "stale",
					fetchedAt: NOW - 600_000,
					windows: [{ id: "five_hour", usedPercent: 10 }],
					...(errorCode === undefined ? {} : { errorCode }),
				}),
			}),
		]);
	await mountDock(stale());
	await openDock();
	mocks.request.mockResolvedValueOnce(stale("TIMEOUT")); // HTTP 200, fetchedAt unchanged, new errorCode
	fireEvent.click(refreshButton());
	await flush();
	const text = screen.getByRole("dialog").textContent ?? "";
	expect(text).not.toContain(en.quotaRefreshCurrent);
	expect(text).toContain(`Last read failed: ${en.quotaErrTimeout}`);
	expect(screen.getByRole("status").textContent).toBe(en.quotaRefreshProviderError);
});

it("a refresh of a never-read account does not claim the quotas were read recently", async () => {
	await mountDock(snapshot([row({ quota: { state: "not-read", windows: [] } })]));
	await openDock();
	fireEvent.click(refreshButton());
	await flush();
	expect(screen.getByRole("dialog").textContent).not.toContain(en.quotaRefreshCurrent);
	expect(screen.queryByRole("status")).toBeNull();
});

it("polls the cached GET every 60 s only while open and stops on close", async () => {
	await mountDock();
	expect(getCalls()).toBe(1);
	await flush(QUOTA_POLL_MS * 3); // closed: no polling
	expect(getCalls()).toBe(1);
	await openDock(); // immediate read on open
	expect(getCalls()).toBe(2);
	await flush(QUOTA_POLL_MS);
	expect(getCalls()).toBe(3);
	await flush(QUOTA_POLL_MS);
	expect(getCalls()).toBe(4);
	fireEvent.keyDown(document, { key: "Escape" });
	await flush(QUOTA_POLL_MS * 3);
	expect(getCalls()).toBe(4);
	expect(mocks.request.mock.calls.every((call) => call[1] === "GET")).toBe(true);
});

it("closes and stops polling when routing is switched off while the panel is open", async () => {
	await mountDock();
	await openDock();
	mocks.request.mockResolvedValue(snapshot([row()], { enabled: false })); // next poll sees the switch
	await flush(QUOTA_POLL_MS);
	expect(screen.queryByRole("dialog")).toBeNull();
	expect(screen.queryByRole("button")).toBeNull();
	const calls = getCalls();
	await flush(QUOTA_POLL_MS * 5);
	expect(getCalls()).toBe(calls);
	// Routing comes back (e.g. a later mount-time style read): the panel must not reopen by itself.
	mocks.request.mockResolvedValue(snapshot());
	await flush(QUOTA_POLL_MS * 5);
	expect(screen.queryByRole("dialog")).toBeNull();
	expect(getCalls()).toBe(calls);
});

it("keeps the panel but stops polling and hides Refresh when quota reading is switched off while open", async () => {
	await mountDock();
	await openDock();
	expect(refreshButton()).toBeTruthy();
	mocks.request.mockResolvedValue(snapshot([row()], { usageEnabled: false }));
	await flush(QUOTA_POLL_MS);
	expect(screen.getByRole("dialog").textContent).toContain(en.quotaReadOnlyHint);
	expect(screen.queryByRole("button", { name: en.quotaRefresh })).toBeNull();
	const calls = getCalls();
	await flush(QUOTA_POLL_MS * 5);
	expect(getCalls()).toBe(calls);
	expect(mocks.request.mock.calls.every((call) => call[1] === "GET")).toBe(true);
});

it("with quota reading off from the start: one read on open, hint, no Refresh, no polling", async () => {
	await mountDock(snapshot([row()], { usageEnabled: false }));
	expect(trigger()).toBeTruthy();
	await openDock();
	expect(getCalls()).toBe(2);
	expect(screen.getByRole("dialog").textContent).toContain(en.quotaReadOnlyHint);
	expect(screen.queryByRole("button", { name: en.quotaRefresh })).toBeNull();
	await flush(QUOTA_POLL_MS * 5);
	expect(getCalls()).toBe(2);
});

it("skips poll ticks while the tab is hidden", async () => {
	await mountDock();
	await openDock();
	const before = getCalls();
	Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
	await flush(QUOTA_POLL_MS * 2);
	expect(getCalls()).toBe(before);
	Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
	document.dispatchEvent(new Event("visibilitychange"));
	await flush();
	expect(getCalls()).toBe(before + 1);
});

it("keeps the conversation intact when GET fails: short message and manual retry", async () => {
	await mountDock(failure(500, "SERVER_SECRET_TEXT"));
	expect(trigger().getAttribute("aria-label")).toBe(en.quotaButtonAria);
	await openDock();
	expect(screen.getByRole("alert").textContent).toContain(en.quotaLoadFailed);
	expect(document.body.textContent).not.toContain("SERVER_SECRET_TEXT");
	mocks.request.mockResolvedValueOnce(snapshot());
	fireEvent.click(screen.getByRole("button", { name: en.routingRetry }));
	await flush();
	expect(screen.queryByRole("alert")).toBeNull();
	expect(screen.getByRole("dialog").textContent).toContain("Claude · compte 1");
});

it("keeps the last good numbers when a later poll fails", async () => {
	await mountDock();
	await openDock();
	mocks.request.mockRejectedValueOnce(failure(500));
	await flush(QUOTA_POLL_MS);
	expect(screen.getByRole("alert").textContent).toContain(en.quotaLoadFailed);
	expect(screen.getByRole("dialog").textContent).toContain("Claude · compte 1");
});

it("shows explicit text for accounts without numbers", async () => {
	await mountDock(
		snapshot([
			row({ quota: { state: "not-read", windows: [] } }),
			row({ route: "r2", name: "Kimi · compte 1", quota: { state: "unsupported", windows: [] } }),
		]),
	);
	await openDock();
	const text = screen.getByRole("dialog").textContent ?? "";
	expect(text).toContain(en.quotaStateNotRead);
	expect(text).toContain(en.quotaStateUnsupported);
	expect(text).not.toContain("Last read ");
});

it("announces the next automatic read only when the server gives a future one", async () => {
	await mountDock(
		snapshot([
			row({ quota: quota({ nextRefreshAt: NOW + 10 * 60_000 }) }),
			row({ route: "r2", name: "Codex · compte 1", quota: quota({}) }),
			row({ route: "r3", name: "Kimi · compte 1", quota: quota({ nextRefreshAt: NOW - 60_000 }) }),
		]),
	);
	await openDock();
	const text = screen.getByRole("dialog").textContent ?? "";
	expect(text.match(/next around/gu)).toHaveLength(1);
});

it("registers on conversation.composer.dock and swallows slot failures", () => {
	const registered: Array<{ options: Record<string, unknown>; component: unknown }> = [];
	const slots = {
		inject: (key: string, callback: () => unknown) => {
			expect(key).toBe("conversation.composer.dock");
			const dispose = callback() as () => void;
			return dispose;
		},
		register: (options: object, component: unknown) => {
			registered.push({ options: options as Record<string, unknown>, component });
			return () => undefined;
		},
	};
	const dispose = registerQuotaDock(slots, t);
	expect(registered).toHaveLength(1);
	expect(registered[0]?.options["name"]).toBe("conversation.composer.dock");
	expect(registered[0]?.component).toBe(QuotaDock);
	dispose();
	const broken = {
		inject: () => {
			throw new Error("no such slot");
		},
		register: () => () => undefined,
	};
	expect(() => registerQuotaDock(broken, t)()).not.toThrow();
});

it("shows three independent account boxes with name, chevron and keyboard toggles", async () => {
	const accounts = [
		row({ isDefault: true, quota: quota({ nextRefreshAt: NOW + 600_000 }) }),
		row({ route: "r2", family: "codex", name: "Codex · account 1", isDefault: true }),
		row({ route: "r3", name: "Claude · account 2" }),
	];
	await mountDock(snapshot(accounts));
	await openDock();
	const boxes = screen.getAllByRole("region");
	expect(boxes).toHaveLength(3);
	const first = screen.getByRole("button", { name: /Claude · compte 1/u });
	const second = screen.getByRole("button", { name: /Codex · account 1/u });
	const third = screen.getByRole("button", { name: "Claude · account 2" });
	for (const button of [first, second, third]) expect(button.getAttribute("aria-expanded")).toBe("true");
	expect(first.textContent).toContain(en.quotaDefaultMark);
	expect(second.textContent).toContain(en.quotaDefaultMark);
	expect(third.textContent).not.toContain(en.quotaDefaultMark);
	fireEvent.click(screen.getByText("Claude · compte 1", { exact: true }));
	expect(first.getAttribute("aria-expanded")).toBe("false");
	expect(second.getAttribute("aria-expanded")).toBe("true");
	expect(third.getAttribute("aria-expanded")).toBe("true");
	expect(screen.getAllByRole("progressbar")).toHaveLength(4);
	fireEvent.keyDown(first, { key: "Enter" });
	expect(first.getAttribute("aria-expanded")).toBe("true");
	fireEvent.keyDown(first, { key: " " });
	expect(first.getAttribute("aria-expanded")).toBe("false");
	const arrow = second.querySelector("svg");
	if (arrow === null) throw new Error("missing account chevron");
	fireEvent.click(arrow);
	expect(second.getAttribute("aria-expanded")).toBe("false");
	expect(third.getAttribute("aria-expanded")).toBe("true");
	fireEvent.click(third);
	expect(screen.queryByRole("progressbar")).toBeNull();
	const schedule = screen.getByText(/Last read .* · next around /u);
	expect(screen.getAllByText(/Last read /u)).toHaveLength(1);
	expect(screen.getAllByRole("button", { name: en.quotaRefresh })).toHaveLength(1);
	expect(schedule.closest("section")).toBeNull();
	expect(refreshButton().closest("section")).toBeNull();
	expect(schedule.closest("[hidden]")).toBeNull();
	expect(refreshButton().closest("[hidden]")).toBeNull();
	for (const box of boxes) {
		expect(box.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
		expect(box.textContent).not.toMatch(/Last read|next around|out of date/iu);
		const controlled = box.querySelector("button")?.getAttribute("aria-controls");
		expect(document.getElementById(controlled ?? "")?.hidden).toBe(true);
	}
	fireEvent.click(third);
	fireEvent.click(trigger());
	mocks.request.mockResolvedValue(snapshot([accounts[2]!, accounts[0]!, accounts[1]!]));
	await openDock();
	for (const name of [/Claude · compte 1/u, /Codex · account 1/u]) {
		expect(screen.getByRole("button", { name }).getAttribute("aria-expanded")).toBe("false");
	}
	expect(screen.getByRole("button", { name: "Claude · account 2" }).getAttribute("aria-expanded")).toBe("true");
	expect(screen.getAllByRole("progressbar")).toHaveLength(2);
	expect(screen.getByRole("button", { name: /Claude · compte 1/u }).getAttribute("aria-expanded")).toBe("false");
	expect(document.body.textContent).not.toMatch(/out of date/iu);
});

it("shows one combined schedule using latest fetch and nearest future refresh", async () => {
	await mountDock(
		snapshot([
			row({ quota: quota({ fetchedAt: NOW - 60_000, nextRefreshAt: NOW + 600_000 }) }),
			row({ route: "r2", quota: quota({ fetchedAt: NOW - 120_000, nextRefreshAt: NOW + 300_000 }) }),
			row({ route: "r3", quota: quota({ fetchedAt: NOW - 180_000, nextRefreshAt: NOW - 1 }) }),
		]),
	);
	await openDock();
	expect(screen.getAllByText(/Last read /u)).toHaveLength(1);
	const schedule = screen.getByText(/Last read /u).textContent;
	expect(schedule).toBe(`Last read ${formatClock(NOW - 60_000)} · next around ${formatClock(NOW + 300_000)}`);
	expect(document.body.textContent).not.toMatch(/out of date|Updated .*ago/iu);
});

it("treats stale without an error as normal with larger metrics in a separate block after the bar", async () => {
	await mountDock(
		snapshot([
			row({
				quota: quota({
					state: "stale",
					windows: [
						{ id: "five_hour", usedPercent: 42, resetsAt: NOW + 3_600_000 },
						{ id: "seven_day", usedPercent: 12 },
					],
				}),
			}),
		]),
	);
	await openDock();
	expect(screen.queryByRole("alert")).toBeNull();
	expect(document.body.textContent).not.toMatch(/out of date|older values|Updated/iu);
	const bars = screen.getAllByRole("progressbar");
	for (const bar of bars) {
		const line = bar.parentElement;
		expect(line?.getAttribute("data-quota-window")).toBe("true");
		expect(line?.style.display).toBe("grid");
		expect(line?.style.whiteSpace).toBe("nowrap");
		expect(line?.style.fontSize).toBe("13px");
		const metrics = line?.querySelector<HTMLElement>("[data-quota-metrics]");
		expect(metrics?.style.display).toBe("block");
		expect(metrics?.style.fontSize).toBe("13px");
		expect(bar.nextElementSibling).toBe(metrics);
	}
	expect(bars[0]?.parentElement?.textContent).toContain("reset ");
	expect(bars[1]?.parentElement?.textContent).not.toContain("reset");
	expect(screen.getAllByText(/^reset /u)).toHaveLength(1);
});
