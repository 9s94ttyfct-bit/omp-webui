import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react";
import { useT } from "../i18n/index.ts";
import {
	commitStoredWidth,
	currentLayout,
	LIMITS,
	type PanelKind,
	setStoredWidth,
	useLayout,
} from "../lib/panel-widths.ts";
import { cx } from "./ui.tsx";

const STEP = 16;
const BIG_STEP = 64;

/**
 * The drag handle between a column and the conversation: a focusable vertical separator whose value is the width of
 * the column it resizes. Pointer drag, arrow keys (Shift: bigger steps; Home/End: the bounds), double-click or Enter
 * for the default size. `direction` is which way the handle moves for the column to grow: +1 for the sidebar (the
 * handle is on its right edge), -1 for the side panel (on its left edge).
 */
export function ResizeHandle({ kind, label, className }: { kind: PanelKind; label: string; className?: string }) {
	const t = useT();
	const { width, max } = useLayout();
	const { min } = LIMITS[kind];
	const direction = kind === "sidebar" ? 1 : -1;
	const drag = useRef<{ x: number; width: number; moved: boolean } | null>(null);
	const [dragging, setDragging] = useState(false);

	const resize = (px: number, persist = true) => {
		const { max: limit } = currentLayout();
		setStoredWidth(kind, Math.min(limit[kind], Math.max(min, px)), persist);
	};
	const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
		if (e.button !== 0) return;
		// No text selection while dragging.
		e.preventDefault();
		e.currentTarget.setPointerCapture(e.pointerId);
		drag.current = { x: e.clientX, width: currentLayout().width[kind], moved: false };
		setDragging(true);
	};
	const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
		const start = drag.current;
		// Drawn as it goes; kept once, where the drag ends.
		if (!start) return;
		start.moved = true;
		resize(start.width + direction * (e.clientX - start.x), false);
	};
	const endDrag = () => {
		if (drag.current?.moved) commitStoredWidth(kind);
		drag.current = null;
		setDragging(false);
	};
	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		const step = e.shiftKey ? BIG_STEP : STEP;
		const now = currentLayout().width[kind];
		let next: number | null = null;
		if (e.key === "ArrowRight") next = now + direction * step;
		else if (e.key === "ArrowLeft") next = now - direction * step;
		else if (e.key === "Home") next = min;
		else if (e.key === "End") next = currentLayout().max[kind];
		else if (e.key === "Enter") {
			e.preventDefault();
			setStoredWidth(kind, null);
			return;
		}
		if (next === null) return;
		e.preventDefault();
		resize(next);
	};

	return (
		// biome-ignore lint/a11y/useSemanticElements: a focusable separator with a value (WAI-ARIA window splitter) is not an <hr>
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label={label}
			aria-valuenow={Math.round(width[kind])}
			aria-valuemin={min}
			aria-valuemax={Math.round(max[kind])}
			tabIndex={0}
			title={t("shell.resizeHint")}
			data-testid={kind === "sidebar" ? "resize-sidebar" : "resize-panel"}
			data-dragging={dragging ? "true" : undefined}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={endDrag}
			onPointerCancel={endDrag}
			onLostPointerCapture={endDrag}
			onDoubleClick={() => setStoredWidth(kind, null)}
			onKeyDown={onKeyDown}
			className={cx(
				// The line and grip come from `.resize-handle` (index.css), shared with every palette.
				"resize-handle absolute inset-y-0 z-10 w-1.5 cursor-col-resize touch-none outline-none",
				className,
			)}
		/>
	);
}
