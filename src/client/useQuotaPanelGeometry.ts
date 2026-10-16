/** Pointer/keyboard geometry for the quota popup. Storage is optional and never blocks the UI. */
import {
	type KeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import {
	boundPlacement,
	computePlacement,
	PANEL_STORAGE_KEY,
	type Placement,
	parsePlacement,
	type ResizeEdge,
	resizePlacement,
	samePlacement,
} from "./quotaDockPlacement.ts";

const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });
type Gesture = { pointer: number; x: number; y: number; start: Placement; edge?: ResizeEdge; capture: HTMLElement };

export function useQuotaPanelGeometry(open: boolean, trigger: RefObject<HTMLButtonElement>) {
	const [placement, setPlacement] = useState<Placement>();
	const [active, setActive] = useState(false);
	const saved = useRef<Placement>();
	const loaded = useRef(false);
	const current = useRef<Placement>();
	const gesture = useRef<Gesture>();
	const update = useCallback((next: Placement) => {
		current.current = next;
		setPlacement((previous) => (samePlacement(previous, next) ? previous : next));
	}, []);
	const persist = useCallback((next: Placement) => {
		saved.current = next;
		try {
			localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify(next));
		} catch {
			/* Storage may be denied or full. */
		}
	}, []);
	const measure = useCallback(() => {
		const rect = trigger.current?.getBoundingClientRect();
		if (rect === undefined || gesture.current !== undefined) return;
		update(
			saved.current === undefined ? computePlacement(rect, viewport()) : boundPlacement(saved.current, viewport()),
		);
	}, [trigger, update]);

	useLayoutEffect(() => {
		if (!open) {
			setPlacement(undefined);
			return;
		}
		if (!loaded.current) {
			loaded.current = true;
			try {
				saved.current = parsePlacement(JSON.parse(localStorage.getItem(PANEL_STORAGE_KEY) ?? "null"));
			} catch {
				/* Invalid or inaccessible storage: use the anchor. */
			}
		}
		measure();
		let frame: number | undefined;
		const schedule = () => {
			if (frame !== undefined) return;
			frame = requestAnimationFrame(() => {
				frame = undefined;
				measure();
			});
		};
		window.addEventListener("resize", schedule);
		window.addEventListener("scroll", schedule, true);
		return () => {
			window.removeEventListener("resize", schedule);
			window.removeEventListener("scroll", schedule, true);
			if (frame !== undefined) cancelAnimationFrame(frame);
		};
	}, [open, measure]);

	useEffect(() => {
		if (!open) return;
		const move = (event: PointerEvent) => {
			const drag = gesture.current;
			if (drag === undefined || event.pointerId !== drag.pointer) return;
			event.preventDefault();
			const dx = event.clientX - drag.x;
			const dy = event.clientY - drag.y;
			update(
				drag.edge === undefined
					? boundPlacement({ ...drag.start, left: drag.start.left + dx, top: drag.start.top + dy }, viewport())
					: resizePlacement(drag.start, drag.edge, dx, dy, viewport()),
			);
		};
		const finish = (event: PointerEvent) => {
			const drag = gesture.current;
			if (drag === undefined || event.pointerId !== drag.pointer) return;
			if (event.type === "pointerup") move(event);
			gesture.current = undefined;
			setActive(false);
			try {
				drag.capture.releasePointerCapture(event.pointerId);
			} catch {
				/* Capture may already be released. */
			}
			if (current.current !== undefined) persist(current.current);
		};
		document.addEventListener("pointermove", move, { passive: false });
		document.addEventListener("pointerup", finish);
		document.addEventListener("pointercancel", finish);
		return () => {
			document.removeEventListener("pointermove", move);
			document.removeEventListener("pointerup", finish);
			document.removeEventListener("pointercancel", finish);
			const drag = gesture.current;
			gesture.current = undefined;
			if (drag !== undefined) {
				try {
					drag.capture.releasePointerCapture(drag.pointer);
				} catch {
					/* Unmounted capture target. */
				}
			}
			setActive(false);
		};
	}, [open, persist, update]);

	const start = (event: ReactPointerEvent<HTMLElement>, edge?: ResizeEdge) => {
		if (event.button !== 0 || gesture.current !== undefined || current.current === undefined) return;
		if (edge === undefined && (event.target as Element).closest("button")) return;
		event.preventDefault();
		event.currentTarget.focus();
		try {
			event.currentTarget.setPointerCapture(event.pointerId);
		} catch {
			/* Document listeners still support a mouse without capture. */
		}
		gesture.current = {
			pointer: event.pointerId,
			x: event.clientX,
			y: event.clientY,
			start: current.current,
			capture: event.currentTarget,
			...(edge === undefined ? {} : { edge }),
		};
		setActive(true);
	};
	const reset = () => {
		saved.current = undefined;
		try {
			localStorage.removeItem(PANEL_STORAGE_KEY);
		} catch {
			/* Reset still works for this mount. */
		}
		measure();
	};
	const keyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (event.target !== event.currentTarget || current.current === undefined) return;
		const delta = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] }[event.key];
		if (delta === undefined) return;
		event.preventDefault();
		const [dx = 0, dy = 0] = delta;
		const next = event.shiftKey
			? resizePlacement(current.current, dx === 0 ? "s" : "e", dx, dy, viewport())
			: boundPlacement(
					{ ...current.current, left: current.current.left + dx, top: current.current.top + dy },
					viewport(),
				);
		update(next);
		persist(next);
	};
	return { placement, active, gesture, start, reset, keyDown };
}
