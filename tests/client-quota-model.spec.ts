import { expect, it } from "vitest";
import { computePlacement } from "../src/client/quotaDockPlacement.ts";
import { parseRoutingView, refreshOutcome, validateLabel } from "../src/client/quotaModel.ts";
import { NOW, row, snapshot } from "./client-quota-fixtures.ts";

const view = (accounts = [row()]) => {
	const parsed = parseRoutingView(snapshot(accounts));
	if (parsed === undefined) throw new Error("fixture must parse");
	return parsed;
};

it("validateLabel: trim, 1-40 code points, empty clears", () => {
	expect(validateLabel("  Pro  ")).toEqual({ ok: true, label: "Pro" });
	expect(validateLabel("   ")).toEqual({ ok: true, label: null });
	expect(validateLabel("")).toEqual({ ok: true, label: null });
	expect(validateLabel("😀".repeat(40))).toEqual({ ok: true, label: "😀".repeat(40) }); // 40 code points, 80 units
	expect(validateLabel("😀".repeat(41))).toEqual({ ok: false });
	expect(validateLabel("你好 compte")).toEqual({ ok: true, label: "你好 compte" });
	expect(validateLabel("a\u00a0b")).toEqual({ ok: true, label: "a\u00a0b" }); // no-break space is allowed
});

it("validateLabel rejects exactly the server class: Cc, Cf, Zl, Zp and Bidi_Control", () => {
	const forbidden = [
		"a\u0000b", // Cc
		"a\u0007b",
		"a\u007fb",
		"a\u0085b",
		"a\u200bb", // Cf zero-width space
		"a\u00adb", // Cf soft hyphen
		"a\ufeffb", // Cf BOM inside the text
		"a\u200eb", // Cf + Bidi_Control
		"a\u061cb", // Cf + Bidi_Control
		"a\u2028b", // Zl
		"a\u2029b", // Zp
		"a\u202eb", // bidi override
		"a\u2066b", // bidi isolate
	];
	for (const label of forbidden) expect(validateLabel(label), JSON.stringify(label)).toEqual({ ok: false });
});

it("refreshOutcome tells a provider failure from a current snapshot", () => {
	const old = view([
		row({ quota: { state: "stale", fetchedAt: NOW - 600_000, windows: [{ id: "five_hour", usedPercent: 10 }] } }),
	]);
	const same = (quota: Record<string, unknown>) => view([row({ quota: { fetchedAt: NOW - 600_000, ...quota } })]);
	const windows = [{ id: "five_hour", usedPercent: 10 }];
	expect(refreshOutcome(old, same({ state: "stale", windows }))).toBe("current");
	expect(refreshOutcome(old, same({ state: "fresh", windows }))).toBe("current");
	expect(refreshOutcome(old, same({ state: "stale", windows, errorCode: "TIMEOUT" }))).toBe("provider-error");
	expect(refreshOutcome(old, same({ state: "error", windows: [], errorCode: "AUTH" }))).toBe("provider-error");
	expect(refreshOutcome(old, same({ state: "error", windows: [] }))).toBe("provider-error");
	expect(refreshOutcome(old, same({ state: "not-read", windows: [] }))).toBe("nothing");
	expect(refreshOutcome(old, same({ state: "fresh", fetchedAt: NOW, windows }))).toBe("updated");
	// an error code that was already there before the refresh is not new, but numbers did not advance either
	const failing = same({ state: "stale", windows, errorCode: "TIMEOUT" });
	expect(refreshOutcome(failing, failing)).toBe("current");
	expect(refreshOutcome(undefined, view([row({ quota: { state: "not-read", windows: [] } })]))).toBe("nothing");
});

it("computePlacement keeps the panel inside the viewport with 8 px margins", () => {
	// near the left edge: the panel is shifted right instead of leaving the screen
	expect(computePlacement({ top: 560, right: 60 }, { width: 400, height: 600 })).toEqual({
		right: 72,
		bottom: 48,
		width: 320,
		maxHeight: 420,
	});
	// roomy viewport: right edges aligned, height capped at 560
	expect(computePlacement({ top: 900, right: 1000 }, { width: 1200, height: 1000 })).toEqual({
		right: 200,
		bottom: 108,
		width: 320,
		maxHeight: 560,
	});
	// narrow viewport: width min(320, 100vw - 16)
	const narrow = computePlacement({ top: 500, right: 100 }, { width: 300, height: 600 });
	expect(narrow.width).toBe(284);
	expect(narrow.right).toBe(8);
	// trigger near the top: the panel keeps at least 120 px and never extends above the top margin
	const top = computePlacement({ top: 20, right: 500 }, { width: 1000, height: 600 });
	expect(top.bottom + top.maxHeight + 8).toBeLessThanOrEqual(600);
	expect(top.maxHeight).toBeGreaterThanOrEqual(120);
});
