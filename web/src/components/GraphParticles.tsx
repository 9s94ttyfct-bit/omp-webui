import { useEffect, useRef } from "react";
import type { AgentGraph } from "../lib/agent-graph.ts";
import { edgeCurve, marksOf, type PulseMarks, pointsAlong, pulsesBetween, type Spot } from "../lib/graph-pulses.ts";
import { MOTION, useLiveMotion } from "../lib/live-motion.ts";

/** Keyframes per particle: enough for the curve to look like one at any zoom, few enough to cost nothing to build. */
const STEPS = 16;
/** How far apart, in their run, the particles of one pulse leave. */
const STAGGER = 0.18;

/**
 * The particles of the agent graph (live animations, v0.15.0): a dot or a few that run along a line when an agent starts
 * another, writes to one or hands back a result (`pulsesBetween`). Each is an element moved by a Web Animation of its
 * `transform` and `opacity` (the compositor runs it), of a fixed length, removed when it ends: nothing runs while nothing
 * moves, there is no frame loop to stop, and no particle is started while the page is hidden (one already on its way is
 * dropped when it is hidden). Drawn in the graph's own coordinates, inside the element the zoom scales.
 */
export function GraphParticles({ graph, spots }: { graph: AgentGraph; spots: ReadonlyMap<string, Spot> }) {
	const level = useLiveMotion();
	const layer = useRef<HTMLDivElement>(null);
	const marks = useRef<PulseMarks | null>(null);

	useEffect(() => {
		const prev = marks.current;
		marks.current = marksOf(graph);
		const el = layer.current;
		if (!level || !el || document.visibilityState === "hidden") return;
		const { particles, particleMs, particlePx } = MOTION[level];
		for (const pulse of pulsesBetween(prev, graph)) {
			const from = spots.get(pulse.edge.from);
			const to = spots.get(pulse.edge.to);
			if (!from || !to) continue;
			const half = particlePx / 2;
			const frames = pointsAlong(edgeCurve(from, to, pulse.edge.kind, graph.nodeH), STEPS, pulse.reverse).map(
				(p, i) => ({
					transform: `translate(${(p.x - half).toFixed(1)}px, ${(p.y - half).toFixed(1)}px)`,
					opacity: i === 0 || i === STEPS ? 0 : 1,
				}),
			);
			for (let k = 0; k < particles; k++) {
				const dot = document.createElement("span");
				dot.className = "graph-particle";
				dot.dataset.testid = "graph-particle";
				dot.dataset.kind = pulse.kind;
				dot.style.width = dot.style.height = `${particlePx}px`;
				el.append(dot);
				const run = dot.animate(frames, {
					duration: particleMs,
					delay: k * particleMs * STAGGER,
					easing: "ease-in-out",
					fill: "backwards",
				});
				run.onfinish = run.oncancel = () => dot.remove();
			}
		}
	}, [graph, spots, level]);

	// A hidden page draws nothing: what is on its way is dropped, not kept for when the page is shown again.
	useEffect(() => {
		const el = layer.current;
		const dropAll = () => {
			for (const run of el?.getAnimations({ subtree: true }) ?? []) run.cancel();
		};
		const drop = () => {
			if (document.visibilityState === "hidden") dropAll();
		};
		document.addEventListener("visibilitychange", drop);
		return () => {
			document.removeEventListener("visibilitychange", drop);
			dropAll();
		};
	}, []);

	return <div ref={layer} className="pointer-events-none absolute inset-0" aria-hidden data-testid="graph-particles" />;
}
