import { expect, test } from "bun:test";
import {
	type AutoInstaller,
	BrowserAutoUpdater,
	type BrowserUse,
	CHECK_EVERY_MS,
	type Clock,
	checkDue,
	compareVersions,
	FIRST_CHECK_MS,
	IDLE_POLL_MS,
	isNewer,
	nextLookIn,
	QUIET_MS,
	switchNow,
} from "../../server/browser/autoupdate.ts";
import type { BrowserAutoCheck } from "../../shared/browser.ts";

/**
 * When the built-in browser's automatic update looks for a newer version, whether what it finds is newer, and when a
 * downloaded Chrome for Testing is switched to: the decisions alone, and the timer that follows them on a clock of the
 * test's own. Downloading and switching themselves are `browser-install.test.ts`'s.
 */

const HOUR = 60 * 60_000;

test("Chrome for Testing's versions are ordered by their numbers", () => {
	expect(isNewer("131.0.6778.85", "131.0.6778.9")).toBe(true);
	expect(isNewer("131.0.6778.9", "131.0.6778.85")).toBe(false);
	expect(isNewer("131.0.6778.85", "131.0.6778.85")).toBe(false);
	expect(isNewer("132.0.0.0", "131.9.9999.99")).toBe(true);
	expect(compareVersions("131.0.6778.85", "131.0.6778.85")).toBe(0);
	expect(compareVersions("131.0.6778", "131.0.6778.1")).toBeLessThan(0);
});

test("a check is due at the first look and then only once 24 hours have passed", () => {
	expect(checkDue(null, 5)).toBe(true);
	expect(checkDue(1_000, 1_000 + CHECK_EVERY_MS - 1)).toBe(false);
	expect(checkDue(1_000, 1_000 + CHECK_EVERY_MS)).toBe(true);
});

test("Chrome for Testing is switched only when nothing uses it, and not right after something did", () => {
	const now = 10 * HOUR;
	const idle: BrowserUse = { engine: true, connections: 0, watchers: 0, lastUse: now - QUIET_MS };
	expect(switchNow(idle, now)).toBe(true);
	// An engine that does not run disturbs nobody, whatever used it a moment ago.
	expect(switchNow({ engine: false, connections: 0, watchers: 0, lastUse: now }, now)).toBe(true);
	// A conversation's CDP connection is open.
	expect(switchNow({ ...idle, connections: 1 }, now)).toBe(false);
	// A Browser tab shows one of its pages.
	expect(switchNow({ ...idle, watchers: 1 }, now)).toBe(false);
	// An agent let go of it a moment ago, and may be back with its next call.
	expect(switchNow({ ...idle, lastUse: now - QUIET_MS + 1 }, now)).toBe(false);
});

test("the next look is a minute away while a version waits, else when the next check is due", () => {
	const at = 100 * HOUR;
	expect(nextLookIn(at, at, false)).toBe(CHECK_EVERY_MS);
	expect(nextLookIn(at, at + HOUR, false)).toBe(CHECK_EVERY_MS - HOUR);
	expect(nextLookIn(at, at + HOUR, true)).toBe(IDLE_POLL_MS);
	// A check due in less than a minute is not pushed back by the minute of waiting.
	expect(nextLookIn(at, at + CHECK_EVERY_MS - 1_000, true)).toBe(1_000);
	// Never checked (nothing installed, or the switch is off): a day from now, not at once again.
	expect(nextLookIn(null, at, false)).toBe(CHECK_EVERY_MS);
	expect(nextLookIn(at, at + CHECK_EVERY_MS + HOUR, false)).toBe(CHECK_EVERY_MS);
});

/** A clock whose timers fire only when the test moves time on to them. */
function testClock() {
	let now = 0;
	let id = 0;
	const timers = new Map<number, { at: number; fn: () => void }>();
	const clock: Clock = {
		now: () => now,
		set: (fn, ms) => {
			timers.set(++id, { at: now + ms, fn });
			return id;
		},
		clear: (t) => timers.delete(t as number),
	};
	return {
		clock,
		now: () => now,
		/** How far away the one timer set is. */
		pending(): number {
			expect(timers.size).toBe(1);
			const [{ at }] = [...timers.values()];
			return at - now;
		},
		/** How many timers are set. */
		timers: () => timers.size,
		/** Moves time on to the timer, fires it, and waits for the look it starts. */
		async fire(updater: BrowserAutoUpdater): Promise<void> {
			const [[key, { at, fn }]] = [...timers.entries()];
			timers.delete(key);
			now = at;
			fn();
			await updater.look();
		},
	};
}

/** An installer that answers what the test says, and counts what it was asked. */
function testInstaller(answer: () => BrowserAutoCheck["result"], download?: string) {
	const calls: string[] = [];
	let waiting: string | null = null;
	const result = (r: BrowserAutoCheck["result"], version: string | null): BrowserAutoCheck => ({
		at: 0,
		result: r,
		version,
		error: r === "failed" ? "The download stalled" : null,
	});
	const inst: AutoInstaller = {
		get waiting() {
			return waiting;
		},
		async autoUpdate() {
			calls.push("check");
			const r = answer();
			if (r === "waiting") waiting = download ?? null;
			return result(r, r === "waiting" ? waiting : null);
		},
		async switchToNext() {
			calls.push(`switch:${waiting}`);
			const version = waiting;
			waiting = null;
			return result("updated", version);
		},
	};
	return { inst, calls };
}

test("the first look comes a minute after start, then one a day; none while the switch is off or nothing is installed", async () => {
	const t = testClock();
	const { inst, calls } = testInstaller(() => "upToDate");
	let wanted = true;
	let installed = true;
	const asked: string[] = [];
	const updater = new BrowserAutoUpdater({
		clock: t.clock,
		wanted: () => wanted,
		installer: async () => {
			asked.push("installer");
			return installed ? inst : null;
		},
		use: () => ({ engine: false, connections: 0, watchers: 0, lastUse: 0 }),
		log: () => {},
	});
	updater.start();
	expect(t.pending()).toBe(FIRST_CHECK_MS);
	expect(calls).toEqual([]);
	await t.fire(updater);
	expect(calls).toEqual(["check"]);
	expect(t.pending()).toBe(CHECK_EVERY_MS);
	await t.fire(updater);
	expect(calls).toEqual(["check", "check"]);

	// Off: nothing is looked up, and nothing of the browser is loaded for it.
	wanted = false;
	await t.fire(updater);
	expect(calls).toEqual(["check", "check"]);
	expect(asked).toEqual(["installer", "installer"]);
	expect(t.pending()).toBe(CHECK_EVERY_MS);

	// Turned on again: a look soon, and the check it missed is made.
	wanted = true;
	updater.wake();
	expect(t.pending()).toBeLessThan(FIRST_CHECK_MS);
	await t.fire(updater);
	expect(calls).toEqual(["check", "check", "check"]);

	// Turned on and off within the day: a look soon, but no check before one is due.
	updater.wake();
	await t.fire(updater);
	expect(calls).toEqual(["check", "check", "check"]);

	// Uninstalled: no check.
	installed = false;
	await t.fire(updater);
	expect(calls).toEqual(["check", "check", "check"]);

	updater.stop();
	updater.wake();
	expect(t.timers()).toBe(0);
});

test("a failed check is logged once and tried again at the next check, not sooner", async () => {
	const t = testClock();
	let fail = true;
	const { inst, calls } = testInstaller(() => (fail ? "failed" : "upToDate"));
	const logged: string[] = [];
	const updater = new BrowserAutoUpdater({
		clock: t.clock,
		wanted: () => true,
		installer: async () => inst,
		use: () => ({ engine: false, connections: 0, watchers: 0, lastUse: 0 }),
		log: (line) => logged.push(line),
	});
	updater.start();
	await t.fire(updater);
	expect(calls).toEqual(["check"]);
	expect(logged).toEqual(["omp-webui: browser: automatic update failed: The download stalled"]);
	expect(t.pending()).toBe(CHECK_EVERY_MS);
	fail = false;
	await t.fire(updater);
	expect(calls).toEqual(["check", "check"]);
	expect(logged).toHaveLength(1);
});

test("a downloaded Chrome for Testing waits while the browser is used, and is switched to at the first quiet look", async () => {
	const t = testClock();
	const { inst, calls } = testInstaller(() => "waiting", "200.0.1.0");
	const use: BrowserUse = { engine: true, connections: 1, watchers: 0, lastUse: 0 };
	const updater = new BrowserAutoUpdater({
		clock: t.clock,
		wanted: () => true,
		installer: async () => inst,
		use: () => use,
		log: () => {},
	});
	updater.start();
	await t.fire(updater);
	// A conversation is connected: it waits, and looks again in a minute (without checking again).
	expect(calls).toEqual(["check"]);
	expect(t.pending()).toBe(IDLE_POLL_MS);
	await t.fire(updater);
	expect(calls).toEqual(["check"]);

	// The conversation let go of it: still not for the next few minutes.
	use.connections = 0;
	use.lastUse = t.now();
	await t.fire(updater);
	expect(calls).toEqual(["check"]);
	use.watchers = 1;
	for (let i = 0; i < QUIET_MS / IDLE_POLL_MS; i++) await t.fire(updater);
	expect(calls).toEqual(["check"]);

	// The Browser tab stopped showing its page too, and nothing used it since: switched, once.
	use.watchers = 0;
	use.lastUse = t.now();
	while (t.now() - use.lastUse < QUIET_MS) await t.fire(updater);
	expect(calls).toEqual(["check", "switch:200.0.1.0"]);
	expect(inst.waiting).toBeNull();
	// Nothing waits any more: the next look is the next day's check.
	expect(t.pending()).toBe(CHECK_EVERY_MS - (t.now() - FIRST_CHECK_MS));
});
