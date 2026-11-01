import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
	type AnimationIntensity,
	burstPieces,
	celebrationFor,
	MOTION,
	type TurnMark,
	useLiveMotion,
} from "../lib/live-motion.ts";

/** The pieces' colours, in turn. */
const COLOURS = ["var(--accent)", "var(--success)", "var(--warning)"];
/** A goal's burst has this many times a turn's pieces, and flies this much farther. */
const GOAL_MORE = 1.5;
/** A turn that ends this soon after its goal was completed is the same news: one burst. */
const SAME_NEWS_MS = 3000;

interface Burst {
	key: number;
	kind: "turn" | "goal";
	level: AnimationIntensity;
}

/**
 * The short burst at the end of a turn or a goal that ended well, with live animations on (v0.15.0): a ring and a fan of
 * pieces from the bottom of the transcript, each a Web Animation of `transform` and `opacity` of a fixed length. The
 * element is there for the burst alone and goes when its last piece lands. Only an end this page saw happen is
 * celebrated (`celebrationFor`), and not while the page is hidden. Its props are plain values, so a streamed token, which
 * draws the chat again, does not draw it.
 */
export const LiveCelebration = memo(function LiveCelebration({
	liveId,
	streaming,
	continuing,
	goalId,
	goalStatus,
	well,
}: TurnMark & { liveId: string }) {
	const level = useLiveMotion();
	const [burst, setBurst] = useState<Burst | null>(null);
	const seen = useRef<{ liveId: string; mark: TurnMark } | null>(null);
	/** When the last goal was celebrated (`performance.now()`); none yet. */
	const goalAt = useRef(Number.NEGATIVE_INFINITY);

	useEffect(() => {
		const mark = { streaming, continuing, goalId, goalStatus, well };
		const prev = seen.current?.liveId === liveId ? seen.current.mark : null;
		seen.current = { liveId, mark };
		if (!level || document.visibilityState === "hidden") return;
		const kind = celebrationFor(prev, mark);
		if (!kind) return;
		const now = performance.now();
		if (kind === "goal") goalAt.current = now;
		else if (now - goalAt.current < SAME_NEWS_MS) return;
		setBurst((b) => ({ key: (b?.key ?? 0) + 1, kind, level }));
	}, [liveId, streaming, continuing, goalId, goalStatus, well, level]);

	// Another conversation, or the animations turned off: a burst on its way goes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `liveId` is the trigger.
	useEffect(() => setBurst(null), [liveId, level]);

	return burst ? <Pieces key={burst.key} burst={burst} onDone={() => setBurst(null)} /> : null;
});

function Pieces({ burst, onDone }: { burst: Burst; onDone: () => void }) {
	const box = useRef<HTMLDivElement>(null);
	const done = useRef(onDone);
	done.current = onDone;
	useLayoutEffect(() => {
		const el = box.current;
		if (!el) return;
		const { burst: n, burstMs, burstPx } = MOTION[burst.level];
		const more = burst.kind === "goal" ? GOAL_MORE : 1;
		const runs: Animation[] = [];
		const ring = document.createElement("span");
		ring.className = "live-burst-ring";
		el.append(ring);
		runs.push(
			ring.animate(
				[
					{ transform: "scale(0.4)", opacity: 0.7 },
					{ transform: `scale(${(2.2 * more).toFixed(2)})`, opacity: 0 },
				],
				{ duration: burstMs * 0.7, easing: "ease-out" },
			),
		);
		for (const p of burstPieces(Math.round(n * more), burstPx * more)) {
			const piece = document.createElement("span");
			piece.className = "live-burst-piece";
			piece.style.background = COLOURS[p.colour];
			el.append(piece);
			runs.push(
				piece.animate(
					[
						{ transform: "translate(0, 0) rotate(0deg) scale(0.6)", opacity: 1 },
						{ transform: `translate(${p.dx}px, ${p.dy}px) rotate(${p.turn / 2}deg) scale(1)`, opacity: 1, offset: 0.6 },
						// They fall a little as they fade, as something thrown up does.
						{
							transform: `translate(${p.dx * 1.1}px, ${p.dy + burstPx * 0.35}px) rotate(${p.turn}deg) scale(0.8)`,
							opacity: 0,
						},
					],
					{ duration: burstMs, easing: "cubic-bezier(0.2, 0.7, 0.3, 1)" },
				),
			);
		}
		let live = true;
		void Promise.allSettled(runs.map((r) => r.finished)).then(() => {
			if (live) done.current();
		});
		return () => {
			live = false;
			for (const r of runs) r.cancel();
		};
	}, [burst]);
	return (
		<div
			ref={box}
			className="pointer-events-none absolute bottom-10 left-1/2 z-10 h-0 w-0"
			aria-hidden
			data-testid="live-celebration"
			data-kind={burst.kind}
			data-motion={burst.level}
		/>
	);
}
