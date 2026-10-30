import type { OmpFrame } from "@shared/protocol.ts";
import { useSyncExternalStore } from "react";

/**
 * How long the user's own `!commands` ran (#657). omp saves one as a `bashExecution` message that says what ran, what it
 * printed and when it was written, but not when it began, so a command's length is known only to a page that heard the
 * server say it ended (`bash_ended` names the command, when it ended and how long it ran, on the server's clock, which
 * is the clock of omp's own `timestamp`). The page keeps the lengths of the last commands it heard in this browser, so that
 * loading the page again still shows them, and matches one to a saved message by its command line and the time it was
 * written. A command this browser never heard end (run while no page of it was listening) has no length.
 */

const KEY = "ompw.bashTimes";
/** Commands remembered; the oldest go first. */
const MAX_RUNS = 200;
/** Characters of a command line kept and compared: a longer one is cut the same way on both sides. */
const MAX_COMMAND = 200;
/** How far (ms) the end the server saw may be from the time omp wrote the message: both are read off one clock a moment apart. */
const MATCH_MS = 10_000;

/** The part of `Storage` this needs: tests give it a Map. */
export interface RunStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

/** A command that ran: its line (cut), when it ended and how long it ran. */
export type Run = readonly [command: string, endedAt: number, ms: number];

const isRun = (v: unknown): v is Run =>
	Array.isArray(v) &&
	v.length === 3 &&
	typeof v[0] === "string" &&
	typeof v[1] === "number" &&
	typeof v[2] === "number" &&
	Number.isFinite(v[1]) &&
	Number.isFinite(v[2]) &&
	v[2] >= 0;

/** What was kept, oldest first; whatever does not read as what `remember` wrote is dropped, not trusted. */
export function readRuns(storage: RunStorage): Run[] {
	try {
		const raw: unknown = JSON.parse(storage.getItem(KEY) ?? "[]");
		return Array.isArray(raw) ? raw.filter(isRun) : [];
	} catch {
		return [];
	}
}

/** `runs` with one more at the end, the oldest dropped past the limit. */
export function withRun(runs: readonly Run[], command: string, endedAt: number, ms: number): Run[] {
	return [...runs, [command.slice(0, MAX_COMMAND), endedAt, ms] as const].slice(-MAX_RUNS);
}

/** How long the command ran that was written at `timestamp`: the run of that command line that ended nearest to it, within `MATCH_MS`. */
export function runMs(runs: readonly Run[], command: string, timestamp: number): number | undefined {
	const line = command.slice(0, MAX_COMMAND);
	let best: Run | undefined;
	for (const run of runs) {
		if (run[0] !== line) continue;
		if (
			Math.abs(run[1] - timestamp) <= MATCH_MS &&
			(!best || Math.abs(run[1] - timestamp) < Math.abs(best[1] - timestamp))
		)
			best = run;
	}
	return best?.[2];
}

let held: Run[] | null = null;
const listeners = new Set<() => void>();

const kept = (): Run[] => {
	held ??= readRuns(localStorage);
	return held;
};

/**
 * What a `bash_ended` frame says of the command's length (the server names the command, when it ended and how long it ran
 * on its own clock, `bashEnded` in `shared/held-state.ts`); null for a frame that says only which command ended.
 */
export function bashTookOf(frame: OmpFrame): { command: string; endedAt: number; durationMs: number } | null {
	const { command, endedAt, durationMs } = frame;
	return typeof command === "string" && typeof endedAt === "number" && typeof durationMs === "number"
		? { command, endedAt, durationMs }
		: null;
}

/** The server said a `!command` ended (`bash_ended`): remember how long it ran, and tell the messages that show it. */
export function noteBashEnded(frame: OmpFrame): void {
	const took = bashTookOf(frame);
	if (!took) return;
	// What another tab of this browser kept meanwhile is read first: both hear the same endings, and the last write must hold both.
	held = withRun(readRuns(localStorage), took.command, took.endedAt, took.durationMs);
	try {
		localStorage.setItem(KEY, JSON.stringify(held));
	} catch {
		// Storage is full or refused: the length is shown for as long as the page runs.
	}
	for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

/**
 * How long the `!command` a saved message holds ran, or undefined (not a command of this browser, or not run yet). The
 * message itself is not drawn again for it: only the small component that reads this is.
 */
export function useBashDuration(command: string | undefined, timestamp: number | undefined): number | undefined {
	return useSyncExternalStore(
		subscribe,
		() => (command !== undefined && timestamp !== undefined ? runMs(kept(), command, timestamp) : undefined),
		() => undefined,
	);
}
