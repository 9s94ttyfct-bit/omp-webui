/**
 * The Mac's sleep, as it concerns the page: what a conversation the sleep interrupted says in its transcript (#647).
 *
 * The noticing itself is the server's (`server/sleep.ts`: the clocks, the window, and what a frame says followed), and is
 * kept out of here on purpose: the first page load carries every byte of this module, and it needs the names alone.
 */

/** What a conversation that was working when the Mac slept did next: the line under its transcript says which. */
export const SLEEP_THEN = ["retried", "error", "toolTimeout"] as const;
export type SleepThen = (typeof SLEEP_THEN)[number];

/** A window the Mac was asleep in (#647): `from` the last tick before it, `to` the first one after, epoch ms. */
export interface SleepNote {
	from: number;
	to: number;
	/** What came of a turn it cut, once omp said so. */
	followed?: SleepThen;
}

export const sleepThenOf = (v: unknown): SleepThen | undefined => SLEEP_THEN.find((t) => t === v);
