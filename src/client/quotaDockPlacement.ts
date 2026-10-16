/** Viewport-bounded placement of the floating quota panel (pure, so it can be tested without a layout engine). */

export interface Placement {
	right: number;
	bottom: number;
	width: number;
	maxHeight: number;
}

export const PANEL_WIDTH = 320;
export const PANEL_MARGIN = 8;
export const PANEL_GAP = 8;
export const PANEL_MIN_HEIGHT = 120;
export const PANEL_MAX_HEIGHT = 560;

const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), Math.max(low, high));

/**
 * Anchor above the trigger with the right edges aligned, then bound the panel inside the viewport:
 * 8 px margins on every side, width min(320px, viewport - 16px), height capped (the panel scrolls inside).
 */
export function computePlacement(
	anchor: { top: number; right: number },
	viewport: { width: number; height: number },
): Placement {
	const width = Math.max(0, Math.min(PANEL_WIDTH, viewport.width - 2 * PANEL_MARGIN));
	const right = clamp(viewport.width - anchor.right, PANEL_MARGIN, viewport.width - PANEL_MARGIN - width);
	const bottom = clamp(
		viewport.height - anchor.top + PANEL_GAP,
		PANEL_MARGIN,
		viewport.height - PANEL_MARGIN - PANEL_MIN_HEIGHT,
	);
	const maxHeight = Math.max(
		0,
		Math.min(PANEL_MAX_HEIGHT, viewport.height * 0.7, viewport.height - bottom - PANEL_MARGIN),
	);
	return { right, bottom, width, maxHeight };
}

export const samePlacement = (a: Placement | undefined, b: Placement): boolean =>
	a !== undefined && a.right === b.right && a.bottom === b.bottom && a.width === b.width && a.maxHeight === b.maxHeight;
