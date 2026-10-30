import { type PointerEvent, type RefObject, useLayoutEffect, useMemo, useState } from "react";
import { type AgentGraph, minimapSize, NODE_W } from "../lib/agent-graph.ts";

/**
 * The whole agent graph in miniature (#736), for a graph the canvas shows only a part of: each agent a small mark in the
 * colour of its status, the part the canvas shows as a frame, and a press or drag on it moves the canvas there. It is for
 * a pointer; the canvas itself is what the keyboard scrolls.
 */

/** The least a mark is drawn, in pixels of the minimap: a graph of hundreds of agents in 180 pixels would be a line. */
const MARK = 3;

export function Minimap({
	graph,
	scale,
	box,
	fills,
	onPan,
}: {
	graph: AgentGraph;
	/** The canvas's scale. */
	scale: number;
	/** The canvas's scroll box: what it shows is the frame. */
	box: RefObject<HTMLDivElement | null>;
	/** The class that colours the mark of each card (by its id). */
	fills: ReadonlyMap<string, string>;
	/** Put the canvas's top left at this point, in pixels of the canvas. */
	onPan: (left: number, top: number) => void;
}) {
	const [view, setView] = useState({ left: 0, top: 0, w: 0, h: 0 });
	useLayoutEffect(() => {
		const el = box.current;
		if (!el) return;
		const read = () => setView({ left: el.scrollLeft, top: el.scrollTop, w: el.clientWidth, h: el.clientHeight });
		read();
		el.addEventListener("scroll", read, { passive: true });
		const observer = new ResizeObserver(read);
		observer.observe(el);
		return () => {
			el.removeEventListener("scroll", read);
			observer.disconnect();
		};
	}, [box]);

	// The minimap is as large as the canvas has room for (see `minimapSize`); the canvas is measured in a layout effect,
	// so that the first thing painted is already that size.
	const { w: mapW, h: mapH } = minimapSize({ w: view.w, h: view.h });
	// The graph is drawn at the largest size that fits the minimap, centred.
	const k = Math.min(mapW / graph.width, mapH / graph.height);
	const offX = (mapW - graph.width * k) / 2;
	const offY = (mapH - graph.height * k) / 2;
	const marks = useMemo(() => {
		const w = Math.max(NODE_W, MARK / k);
		const h = Math.max(graph.nodeH, MARK / k);
		return [...graph.nodes, ...graph.summaries].map((n) => (
			<rect key={n.id || "main"} x={n.x} y={n.y} width={w} height={h} rx={h / 4} className={fills.get(n.id)} />
		));
	}, [graph, fills, k]);

	const go = (e: PointerEvent<SVGSVGElement>) => {
		const el = box.current;
		if (!el) return;
		const at = e.currentTarget.getBoundingClientRect();
		const x = (e.clientX - at.left - offX) / k;
		const y = (e.clientY - at.top - offY) / k;
		onPan(x * scale - el.clientWidth / 2, y * scale - el.clientHeight / 2);
	};

	return (
		<div
			aria-hidden
			data-testid="agents-minimap"
			className="absolute right-14 bottom-3 rounded-lg border border-border bg-surface p-1 shadow-sm"
		>
			<svg
				aria-hidden
				width={mapW}
				height={mapH}
				className="block touch-none cursor-pointer"
				onPointerDown={(e) => {
					e.currentTarget.setPointerCapture(e.pointerId);
					go(e);
				}}
				onPointerMove={(e) => {
					if (e.buttons) go(e);
				}}
			>
				<g transform={`translate(${offX} ${offY}) scale(${k})`}>
					{marks}
					<rect
						x={view.left / scale}
						y={view.top / scale}
						width={view.w / scale}
						height={view.h / scale}
						className="fill-accent/10 stroke-accent"
						strokeWidth={1.5 / k}
						data-testid="agents-minimap-view"
					/>
				</g>
			</svg>
		</div>
	);
}
