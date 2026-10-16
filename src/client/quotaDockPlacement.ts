/** Pure viewport bounds for the floating quota panel. All coordinates are CSS pixels. */
export interface Placement {
	left: number;
	top: number;
	width: number;
	height: number;
}
export interface Viewport {
	width: number;
	height: number;
}
export type ResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export const PANEL_STORAGE_KEY = "dsh-coding-oauth.quota-panel-geometry.v1";
export const PANEL_MARGIN = 8;
export const PANEL_WIDTH = 360;
export const PANEL_MIN_WIDTH = 300;
export const PANEL_MIN_HEIGHT = 220;
export const PANEL_MAX_HEIGHT = 560;
const clamp = (n: number, min: number, max: number): number => Math.min(Math.max(n, min), max);

export function boundPlacement(value: Placement, viewport: Viewport): Placement {
	const maxWidth = Math.max(0, viewport.width - PANEL_MARGIN * 2);
	const maxHeight = Math.max(0, viewport.height - PANEL_MARGIN * 2);
	const width = clamp(value.width, Math.min(PANEL_MIN_WIDTH, maxWidth), maxWidth);
	const height = clamp(value.height, Math.min(PANEL_MIN_HEIGHT, maxHeight), maxHeight);
	return {
		left: clamp(value.left, PANEL_MARGIN, Math.max(PANEL_MARGIN, viewport.width - PANEL_MARGIN - width)),
		top: clamp(value.top, PANEL_MARGIN, Math.max(PANEL_MARGIN, viewport.height - PANEL_MARGIN - height)),
		width,
		height,
	};
}

export function computePlacement(anchor: { top: number; right: number }, viewport: Viewport): Placement {
	const width = Math.min(PANEL_WIDTH, Math.max(0, viewport.width - 16));
	const height = Math.min(PANEL_MAX_HEIGHT, viewport.height * 0.8);
	return boundPlacement({ left: anchor.right - width, top: anchor.top - 8 - height, width, height }, viewport);
}

/** Keep the opposite edge fixed when resizing from the north or west. */
export function resizePlacement(
	start: Placement,
	edge: ResizeEdge,
	dx: number,
	dy: number,
	viewport: Viewport,
): Placement {
	let { left, top, width, height } = start;
	const minWidth = Math.min(PANEL_MIN_WIDTH, Math.max(0, viewport.width - 16));
	const minHeight = Math.min(PANEL_MIN_HEIGHT, Math.max(0, viewport.height - 16));
	if (edge.includes("e")) width = clamp(width + dx, minWidth, viewport.width - 8 - left);
	if (edge.includes("s")) height = clamp(height + dy, minHeight, viewport.height - 8 - top);
	if (edge.includes("w")) {
		left = clamp(left + dx, 8, left + width - minWidth);
		width = start.left + start.width - left;
	}
	if (edge.includes("n")) {
		top = clamp(top + dy, 8, top + height - minHeight);
		height = start.top + start.height - top;
	}
	return boundPlacement({ left, top, width, height }, viewport);
}

export function parsePlacement(value: unknown): Placement | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const row = value as Record<string, unknown>;
	const values = [row["left"], row["top"], row["width"], row["height"]];
	if (!values.every((n) => typeof n === "number" && Number.isFinite(n))) return undefined;
	if ((row["width"] as number) <= 0 || (row["height"] as number) <= 0) return undefined;
	return {
		left: row["left"] as number,
		top: row["top"] as number,
		width: row["width"] as number,
		height: row["height"] as number,
	};
}

export const samePlacement = (a: Placement | undefined, b: Placement): boolean =>
	a !== undefined && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
