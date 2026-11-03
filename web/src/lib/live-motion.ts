import { ANIMATION_INTENSITIES, PREF } from "@shared/prefs.ts";
import { type RefObject, useLayoutEffect, useSyncExternalStore } from "react";
import { type LiveState, newestMessage } from "../store/live.ts";
import { onPrefsChanged, setPref } from "./prefs.ts";

/**
 * Live animations (v0.15.0; caret and glow v0.17.0): motion that follows what the agent does. A caret that breathes at the
 * end of the reply being written and a glow on the turn's running time, a moving bar on a running tool card, particles along the agent graph's lines when agents start one
 * another, write to one another or hand back a result, and a short burst when a turn or a goal ends well.
 *
 * Off unless the person turns them on (`ompw.animations`), at the intensity they chose (`ompw.animationIntensity`), and off
 * whatever those say while the system asks for reduced motion. Every effect exists only while what it follows runs: an
 * element that is there for the run, with a CSS animation, or a Web Animation of a fixed length on an element removed when
 * it ends. Nothing loops by itself, and nothing is left when the agent is idle (`tests/e2e/live-motion.spec.ts`).
 */

export type AnimationIntensity = (typeof ANIMATION_INTENSITIES)[number];

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** The intensity a stored value names; anything else (not set, a value from another version) is `normal`. */
export const intensityOf = (v: string | null): AnimationIntensity =>
	ANIMATION_INTENSITIES.find((m) => m === v) ?? "normal";

/** The animations that run: none unless they were turned on, and none while the system asks for reduced motion. */
export function motionLevel(
	enabled: string | null,
	intensity: string | null,
	reduced: boolean,
): AnimationIntensity | null {
	return enabled === "on" && !reduced ? intensityOf(intensity) : null;
}

/** What each intensity does with what is drawn by script (the CSS ones read `[data-motion]`, see index.css). */
export const MOTION: Readonly<
	Record<
		AnimationIntensity,
		{
			/** Particles sent along an agent graph line per message, and how long one takes, and its size (graph pixels). */
			particles: number;
			particleMs: number;
			particlePx: number;
			/** Pieces of a turn's burst, how long it lasts and how far they fly (CSS pixels); a goal's has half as many again. */
			burst: number;
			burstMs: number;
			burstPx: number;
		}
	>
> = {
	subtle: { particles: 1, particleMs: 1400, particlePx: 5, burst: 8, burstMs: 900, burstPx: 36 },
	normal: { particles: 2, particleMs: 1100, particlePx: 6, burst: 14, burstMs: 1100, burstPx: 56 },
	lively: { particles: 3, particleMs: 900, particlePx: 7, burst: 22, burstMs: 1400, burstPx: 84 },
};

const reducedNow = (): boolean => typeof matchMedia === "function" && matchMedia(REDUCED_MOTION_QUERY).matches;

/** The level now, from the preferences and the system. */
export const liveMotion = (): AnimationIntensity | null =>
	motionLevel(localStorage.getItem(PREF.animations), localStorage.getItem(PREF.animationIntensity), reducedNow());

/**
 * The CSS live animations whose element is made again while what they follow goes on: the caret is a pseudo-element of
 * the reply's last block, a new one each time a block starts or that block's element is drawn anew (every few hundred ms
 * while a reply streams), and the running time's glow is drawn anew with its line. A new element's animation would start
 * over (the caret back at full opacity), so the breathing jumps instead of going on (#40).
 */
const ON_THE_BEAT: ReadonlySet<string> = new Set(["live-caret", "live-glow"]);

/**
 * Put every such animation under `root` (and its pseudo-elements) on the document timeline's beat: started at the
 * timeline's origin, so a new one is where the one before it was. Reading the animations makes the browser compute
 * styles now, which the frame would do anyway; one already on the beat is left alone.
 */
export function keepOnBeat(root: Element): void {
	if (typeof root.getAnimations !== "function") return;
	for (const animation of root.getAnimations({ subtree: true })) {
		if (animation.startTime === 0) continue;
		const name = (animation as Partial<CSSAnimation>).animationName;
		if (name && ON_THE_BEAT.has(name)) animation.startTime = 0;
	}
}

/** `keepOnBeat` after every render of the element `ref` holds while `on`, before the browser draws it. */
export function useOnBeat(ref: RefObject<Element | null>, on: boolean): void {
	useLayoutEffect(() => {
		if (on && ref.current) keepOnBeat(ref.current);
	});
}

const changed = new Set<() => void>();
const tell = () => {
	for (const fn of changed) fn();
};

export function setAnimations(on: boolean): void {
	setPref(PREF.animations, on ? "on" : "off");
	tell();
}

export function setAnimationIntensity(level: AnimationIntensity): void {
	setPref(PREF.animationIntensity, level);
	tell();
}

function subscribe(fn: () => void): () => void {
	changed.add(fn);
	const stop = onPrefsChanged((keys) => {
		if (keys.includes(PREF.animations) || keys.includes(PREF.animationIntensity)) fn();
	});
	const list = typeof matchMedia === "function" ? matchMedia(REDUCED_MOTION_QUERY) : null;
	list?.addEventListener("change", fn);
	return () => {
		changed.delete(fn);
		stop();
		list?.removeEventListener("change", fn);
	};
}

/** The animations that run now (null: none); the component draws again only when that changes. */
export function useLiveMotion(): AnimationIntensity | null {
	return useSyncExternalStore(subscribe, liveMotion, () => null);
}

/** The stored choices as Settings shows them, and whether the system's reduced motion overrides them. */
export function useAnimationSettings(): { on: boolean; intensity: AnimationIntensity; reduced: boolean } {
	const on = useSyncExternalStore(
		subscribe,
		() => localStorage.getItem(PREF.animations) === "on",
		() => false,
	);
	const intensity = useSyncExternalStore(
		subscribe,
		() => intensityOf(localStorage.getItem(PREF.animationIntensity)),
		() => "normal" as const,
	);
	const reduced = useSyncExternalStore(subscribe, reducedNow, () => false);
	return { on, intensity, reduced };
}

/** Whether the conversation's last turn ended well: its newest message is a reply that stopped by itself, and nothing failed. */
export function endedWell(live: Pick<LiveState, "overlay" | "entries" | "lastError" | "exited" | "retry">): boolean {
	if (live.lastError || live.exited || live.retry) return false;
	const last = newestMessage(live);
	return last?.role === "assistant" && last.stopReason === "stop";
}

/** What the celebration watches of a conversation, render to render. */
export interface TurnMark {
	streaming: boolean;
	/** An active goal's next turn is coming (`LiveState.continuing`): the run is not over. */
	continuing: boolean;
	goalId: string | null;
	goalStatus: string | null;
	/** `endedWell` of the conversation as it is now. */
	well: boolean;
}

/**
 * What ended between two looks at a conversation, worth a burst: its goal was completed, or a turn (not one of a goal run
 * that goes on) ended well. Nothing for the first look: what had ended before the page saw it is not news.
 */
export function celebrationFor(prev: TurnMark | null, next: TurnMark): "goal" | "turn" | null {
	if (!prev) return null;
	if (next.goalId && prev.goalId === next.goalId && prev.goalStatus !== "complete" && next.goalStatus === "complete")
		return "goal";
	if (prev.streaming && !next.streaming && !next.continuing && next.well) return "turn";
	return null;
}

/** One piece of a burst: where it flies to (from the burst's middle) and how it turns, the same for every burst. */
export function burstPieces(n: number, reach: number): { dx: number; dy: number; turn: number; colour: number }[] {
	return Array.from({ length: n }, (_, i) => {
		// A fan over the top half, from left to right, each a little off its even place, alternately nearer and farther.
		const share = n === 1 ? 0.5 : i / (n - 1);
		const angle = Math.PI * (1.08 + 0.84 * share) + ((i * 37) % 11) * 0.012;
		const far = reach * (i % 2 ? 0.72 : 1) * (0.9 + ((i * 53) % 7) * 0.03);
		return {
			dx: Math.round(Math.cos(angle) * far),
			dy: Math.round(Math.sin(angle) * far),
			turn: (i % 2 ? -1 : 1) * (90 + ((i * 29) % 5) * 45),
			colour: i % 3,
		};
	});
}
