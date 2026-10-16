/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QUOTA_POLL_MS, QuotaDock } from "../src/client/components/QuotaDock.tsx";
import { en } from "../src/client/locales.ts";
import { PANEL_STORAGE_KEY } from "../src/client/quotaDockPlacement.ts";
import { QUOTA_DOCK_CSS } from "../src/client/quotaDockStyles.ts";
import { row, snapshot, t } from "./client-quota-fixtures.ts";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../src/client/api.ts", async (original) => ({
	...(await original<typeof import("../src/client/api.ts")>()),
	jsonRequest: mocks.request,
}));
const initialViewport = { width: window.innerWidth, height: window.innerHeight };
const viewport = (width: number, height: number) => {
	Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
	Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
};
const capture = vi.fn();
const release = vi.fn();
beforeEach(() => {
	localStorage.clear();
	mocks.request.mockResolvedValue(
		snapshot([
			row({
				quota: {
					state: "fresh",
					fetchedAt: Date.now(),
					nextRefreshAt: Date.now() + 600_000,
					windows: [{ id: "five_hour", usedPercent: 42 }],
				},
			}),
		]),
	);
	vi.stubGlobal(
		"PointerEvent",
		class extends MouseEvent {
			readonly pointerId: number;
			constructor(type: string, init: PointerEventInit = {}) {
				super(type, init);
				this.pointerId = init.pointerId ?? 1;
			}
		},
	);
	Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: capture });
	Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", { configurable: true, value: release });
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
	mocks.request.mockReset();
	capture.mockClear();
	release.mockClear();
	Reflect.deleteProperty(HTMLElement.prototype, "setPointerCapture");
	Reflect.deleteProperty(HTMLElement.prototype, "releasePointerCapture");
	viewport(initialViewport.width, initialViewport.height);
});
const flush = async () => {
	await act(async () => {
		await Promise.resolve();
	});
};
const trigger = () => screen.getByRole("button", { name: en.quotaButtonAria });
const header = () => screen.getByRole("group", { name: en.quotaMoveResize });
const panel = () => screen.getByRole("dialog") as HTMLElement;
async function open() {
	fireEvent.click(trigger());
	await flush();
}
async function mount() {
	const mounted = render(createElement(QuotaDock, { t }));
	await flush();
	await open();
	return mounted;
}
function geometry() {
	const { left, top, width, height } = panel().style;
	return { left: parseFloat(left), top: parseFloat(top), width: parseFloat(width), height: parseFloat(height) };
}
function drag(target: Element, dx: number, dy: number) {
	fireEvent.pointerDown(target, { pointerId: 1, button: 0, clientX: 20, clientY: 20 });
	fireEvent.pointerMove(document, { pointerId: 1, clientX: 20 + dx, clientY: 20 + dy });
	fireEvent.pointerUp(document.body, { pointerId: 1, clientX: 20 + dx, clientY: 20 + dy });
}

it("drags with pointer capture, saves on release, and restores across close and remount", async () => {
	const mounted = await mount();
	const before = geometry();
	drag(header(), 80, 40);
	const moved = geometry();
	expect(moved.left).toBe(before.left + 80);
	expect(moved.top).toBe(before.top + 40);
	expect(capture).toHaveBeenCalledWith(1);
	expect(release).toHaveBeenCalledWith(1);
	expect(JSON.parse(localStorage.getItem(PANEL_STORAGE_KEY) ?? "null")).toEqual(moved);
	expect(screen.getByRole("dialog")).toBeTruthy(); // release outside is not an outside click
	fireEvent.click(trigger());
	await open();
	expect(geometry()).toEqual(moved);
	mounted.unmount();
	await mount();
	expect(geometry()).toEqual(moved);
});

it("resizes using eight handles, respects minimum/maximum and restores the saved size", async () => {
	const mounted = await mount();
	expect(panel().querySelectorAll("[data-edge]")).toHaveLength(8);
	const handle = () => panel().querySelector('[data-edge="se"]')!;
	drag(handle(), -9999, -9999);
	expect(geometry().width).toBe(300);
	expect(geometry().height).toBe(220);
	drag(handle(), 9999, 9999);
	const expanded = geometry();
	expect(expanded.left + expanded.width).toBe(window.innerWidth - 8);
	expect(expanded.top + expanded.height).toBe(window.innerHeight - 8);
	mounted.unmount();
	await mount();
	expect(geometry()).toEqual(expanded);
});

it("clamps saved geometry on open and on viewport resize, even for very small screens", async () => {
	localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify({ left: 800, top: 600, width: 700, height: 500 }));
	viewport(500, 400);
	await mount();
	expect(geometry()).toEqual({ left: 8, top: 8, width: 484, height: 384 });
	viewport(280, 180);
	await act(async () => {
		window.dispatchEvent(new Event("resize"));
		await new Promise((resolve) => requestAnimationFrame(resolve));
	});
	expect(geometry()).toEqual({ left: 8, top: 8, width: 264, height: 164 });
});

it("double-click and the accessible reset action clear storage and restore anchoring", async () => {
	await mount();
	const anchored = geometry();
	drag(header(), 70, 20);
	fireEvent.doubleClick(header());
	expect(localStorage.getItem(PANEL_STORAGE_KEY)).toBeNull();
	expect(geometry()).toEqual(anchored);
	fireEvent.keyDown(header(), { key: "ArrowRight" });
	expect(geometry().left).toBe(anchored.left + 16);
	fireEvent.click(screen.getByRole("button", { name: en.quotaResetPosition }));
	expect(localStorage.getItem(PANEL_STORAGE_KEY)).toBeNull();
	expect(geometry()).toEqual(anchored);
});

it("supports keyboard movement/resizing, focus trapping, and excludes titlebar buttons from dragging", async () => {
	await mount();
	const anchored = geometry();
	fireEvent.keyDown(header(), { key: "ArrowRight" });
	fireEvent.keyDown(header(), { key: "ArrowDown" });
	fireEvent.keyDown(header(), { key: "ArrowRight", shiftKey: true });
	const changed = geometry();
	expect(changed.left).toBe(anchored.left + 16);
	expect(changed.top).toBe(anchored.top + 16);
	expect(changed.width).toBe(anchored.width + 16);
	expect(JSON.parse(localStorage.getItem(PANEL_STORAGE_KEY) ?? "null")).toEqual(changed);
	fireEvent.pointerDown(screen.getByRole("button", { name: en.quotaToggleDetails }), { button: 0, pointerId: 1 });
	expect(capture).not.toHaveBeenCalled();
	header().focus();
	fireEvent.keyDown(header(), { key: "Tab", shiftKey: true });
	expect(document.activeElement).toBe(screen.getByRole("button", { name: en.quotaRefresh }));
	fireEvent.keyDown(document.activeElement!, { key: "Tab" });
	expect(document.activeElement).toBe(header());
});

it.each([
	"{",
	"null",
	"[]",
	'{"left":20,"top":20,"width":-1,"height":200}',
	'{"left":"20","top":20,"width":360,"height":300}',
	'{"left":0,"top":0,"width":1e999,"height":300}',
])("ignores invalid geometry %s", async (value) => {
	localStorage.setItem(PANEL_STORAGE_KEY, value);
	await mount();
	expect(geometry().width).toBe(360);
	expect(geometry().left).toBe(8);
});

it("survives denied reads/writes/removal of localStorage and still remembers within this mount", async () => {
	vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
		throw new Error("blocked");
	});
	vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
		throw new Error("full");
	});
	vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
		throw new Error("blocked");
	});
	await mount();
	drag(header(), 60, 20);
	const moved = geometry();
	fireEvent.click(trigger());
	await open();
	expect(geometry()).toEqual(moved);
	fireEvent.doubleClick(header());
	expect(geometry().left).toBe(8);
});

it("keeps the panel open during an outside pointer release but still closes on a new outside press", async () => {
	await mount();
	fireEvent.pointerDown(header(), { pointerId: 3, button: 0, clientX: 20, clientY: 20 });
	fireEvent.mouseDown(document.body);
	expect(screen.getByRole("dialog")).toBeTruthy();
	fireEvent.pointerMove(document.body, { pointerId: 3, clientX: 9999, clientY: 9999 });
	fireEvent.pointerUp(document.body, { pointerId: 3, clientX: 9999, clientY: 9999 });
	expect(screen.getByRole("dialog")).toBeTruthy();
	expect(geometry().left + geometry().width).toBe(window.innerWidth - 8);
	expect(geometry().top + geometry().height).toBe(window.innerHeight - 8);
	fireEvent.mouseDown(document.body);
	expect(screen.queryByRole("dialog")).toBeNull();
});

it("stops polling while minimized and resumes on restore", async () => {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	await mount();
	const before = mocks.request.mock.calls.length;
	fireEvent.click(screen.getByRole("button", { name: en.quotaToggleDetails }));
	await act(async () => {
		await vi.advanceTimersByTimeAsync(QUOTA_POLL_MS * 2);
	});
	expect(mocks.request.mock.calls.length).toBe(before);
	fireEvent.click(screen.getByRole("button", { name: en.quotaToggleDetails }));
	await act(async () => {
		await vi.advanceTimersByTimeAsync(QUOTA_POLL_MS);
	});
	expect(mocks.request.mock.calls.length).toBe(before + 1);
});

it("declares larger type, spacing, an internally scrollable body and all resize cursors", async () => {
	await mount();
	expect(QUOTA_DOCK_CSS).toMatch(/quota-panel\s*\{[^}]*font-size: 13px/su);
	expect(QUOTA_DOCK_CSS).toMatch(/quota-account-toggle\s*\{[^}]*font-size: 14px/su);
	expect(QUOTA_DOCK_CSS).toMatch(/quota-schedule\s*\{[^}]*font-size: 13px/su);
	expect(QUOTA_DOCK_CSS).toMatch(/quota-account\s*\{[^}]*padding: 13px/su);
	expect(QUOTA_DOCK_CSS).toMatch(/quota-body\s*\{[^}]*overflow-y: auto/su);
	for (const cursor of ["grab", "grabbing", "ew-resize", "ns-resize", "nwse-resize", "nesw-resize"])
		expect(QUOTA_DOCK_CSS).toContain(`cursor: ${cursor}`);
});
