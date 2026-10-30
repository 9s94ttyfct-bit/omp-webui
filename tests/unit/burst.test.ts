import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import { burst } from "../../server/burst.ts";

/**
 * The session list is announced to the pages after a burst of file changes: after a moment without a change, or a while after
 * the first one of the burst whatever follows. Without the second, writers that never pause for that moment (several
 * conversations or subagents at work) kept the sidebar from changing for as long as they wrote.
 */

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

/** Fire times (ms since the start, to the nearest 10: the fake clock is a millisecond out) for events at the given times. */
function firings(events: number[], quietMs = 400, maxWaitMs = 1500, until = 20_000): number[] {
	const fired: number[] = [];
	const began = Date.now();
	const touched = burst(() => fired.push(Math.round((Date.now() - began) / 10) * 10), quietMs, maxWaitMs);
	let at = 0;
	for (const event of events) {
		vi.advanceTimersByTime(event - at);
		at = event;
		touched();
	}
	vi.advanceTimersByTime(until - at);
	return fired;
}

test("one change is announced after 400 ms without another", () => {
	expect(firings([0])).toEqual([400]);
});

test("changes 450 ms apart are announced one by one", () => {
	expect(firings([0, 450, 900, 1350])).toEqual([400, 850, 1300, 1750]);
});

test("changes 300 ms apart, which a debounce that restarts on each of them never announces, are announced at most 1.8 s apart", () => {
	const events = Array.from({ length: 30 }, (_, i) => i * 300);
	const fired = firings(events);
	// 30 changes over 8.7 s, then quiet: announced 1.5 s after the first change of each burst (the next burst starts with the
	// next change, at most 300 ms later), and at the end.
	expect(fired.length).toBeGreaterThanOrEqual(5);
	expect(fired[0]).toBeLessThanOrEqual(1500);
	for (let i = 1; i < fired.length; i++)
		expect((fired[i] as number) - (fired[i - 1] as number)).toBeLessThanOrEqual(1800);
	// Nothing is left unannounced: the last announcement is after the last change.
	expect(fired.at(-1) as number).toBeGreaterThanOrEqual(8700);
});

test("many writers whose changes are 200 ms apart are announced as well", () => {
	const events = Array.from({ length: 100 }, (_, i) => i * 200);
	const fired = firings(events);
	expect(fired.length).toBeGreaterThanOrEqual(12);
	for (let i = 1; i < fired.length; i++)
		expect((fired[i] as number) - (fired[i - 1] as number)).toBeLessThanOrEqual(1700);
});

test("the wait for a burst starts at its first change, and a quiet moment ends it early", () => {
	// 0, 100, 200: quiet after 600 (200 + 400), not at the 1.5 s maximum; a later change is a burst of its own.
	expect(firings([0, 100, 200, 5000])).toEqual([600, 5400]);
});
