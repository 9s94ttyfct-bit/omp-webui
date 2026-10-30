import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AwakeChild,
	awakeWorking,
	caffeinateArgv,
	KeepAwake,
	SLEEP_MIN_MS,
	SleepDetector,
	sleepBetween,
	spawnCaffeinate,
	workingIds,
} from "../../server/sleep.ts";
import { workCounts } from "../../shared/attention.ts";
import type { LiveInfo } from "../../shared/protocol.ts";
import { processExists } from "../support/poll.ts";

/** The temp dirs of the spawner tests (removed at the end of the file). */
const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Wait until a process is gone, or fail: SIGTERM is handled by the stub, and the system reaps it a moment later. */
async function untilGone(pid: number): Promise<void> {
	const deadline = performance.now() + 5000;
	while (processExists(pid)) {
		if (performance.now() > deadline) throw new Error(`process ${pid} is still there`);
		await Bun.sleep(20);
	}
}

/**
 * The two decisions of #647, on their own: whether `caffeinate` is running (the injected spawner sees every start and
 * stop, and nothing is really started), and whether a pair of clock readings is the Mac having been asleep.
 */

/** A child the fake spawner made: what was asked of it, and how to make it die on its own. */
interface FakeChild {
	stopped: number;
	died: boolean;
	/** The child went by itself (someone's `killall caffeinate`, a crash of it). */
	die(): void;
}

/** A stand-in for `caffeinate`: records every start and stop, nothing is really started, and a test can kill one. */
function fakeSpawner(): {
	spawn: (argv: string[]) => AwakeChild;
	argv: string[][];
	children: FakeChild[];
} {
	const argv: string[][] = [];
	const children: FakeChild[] = [];
	return {
		argv,
		children,
		spawn: (a) => {
			argv.push(a);
			const exits: (() => void)[] = [];
			const c: FakeChild = {
				stopped: 0,
				died: false,
				die() {
					if (c.died) return;
					c.died = true;
					for (const fn of exits) fn();
				},
			};
			children.push(c);
			return {
				pid: 4242,
				stop() {
					c.stopped++;
					c.die();
				},
				onExit: (fn) => void exits.push(fn),
			};
		},
	};
}

function keeper(opts: { platform?: NodeJS.Platform; enabled?: boolean } = {}) {
	const spawner = fakeSpawner();
	const reports: string[] = [];
	const awake = new KeepAwake({
		platform: opts.platform ?? "darwin",
		bin: "/usr/bin/caffeinate",
		spawn: spawner.spawn,
		pid: () => 777,
		report: (m) => reports.push(m),
	});
	if (opts.enabled === false) awake.setEnabled(false);
	return { awake, spawner, reports };
}

describe("keep awake: who is started, and who is stopped", () => {
	test("nothing works: nothing is started", () => {
		const { awake, spawner } = keeper();
		awake.setCount(false);
		expect(awake.holding).toBe(false);
		expect(spawner.argv).toEqual([]);
	});

	test("one conversation starts working: caffeinate runs for this server, from an argument list", () => {
		const { awake, spawner } = keeper();
		awake.setCount(true);
		expect(awake.holding).toBe(true);
		expect(spawner.argv).toEqual([["/usr/bin/caffeinate", "-i", "-w", "777"]]);
		// The command line is the argv, never a shell string: `-i` (idle sleep only), `-w` this server's pid.
		expect(caffeinateArgv("/usr/bin/caffeinate", 777)).toEqual(["/usr/bin/caffeinate", "-i", "-w", "777"]);
	});

	test("another conversation works on top of it, and the first ends: one child, ended only when nothing works", () => {
		const { awake, spawner } = keeper();
		awake.setCount(true);
		// A second start while one holds would be two `caffeinate`s nobody ends together.
		awake.setCount(true);
		expect(spawner.children.length).toBe(1);
		expect(spawner.children[0].stopped).toBe(0);
		awake.setCount(false);
		expect(awake.holding).toBe(false);
		expect(spawner.children[0].stopped).toBe(1);
	});

	test("work starts again after a quiet while: a second child, the first already stopped", () => {
		const { awake, spawner } = keeper();
		awake.setCount(true);
		awake.setCount(false);
		awake.setCount(true);
		expect(spawner.children.length).toBe(2);
		expect(spawner.children[0].stopped).toBe(1);
		expect(spawner.children[1].stopped).toBe(0);
	});

	test("the same count again changes nothing, however often it is said", () => {
		const { awake, spawner } = keeper();
		for (let i = 0; i < 5; i++) awake.setCount(true);
		expect(spawner.children.length).toBe(1);
		expect(spawner.children[0].stopped).toBe(0);
	});

	test("the setting off: work starts nothing, and what was running ends at once", () => {
		const { awake, spawner } = keeper();
		awake.setCount(true);
		expect(awake.holding).toBe(true);
		awake.setEnabled(false);
		expect(awake.holding).toBe(false);
		expect(spawner.children[0].stopped).toBe(1);
		// And nothing starts while it is off, however much works.
		awake.setCount(true);
		expect(spawner.children.length).toBe(1);
	});

	test("the setting on again while something works: it starts with what is working", () => {
		const { awake, spawner } = keeper({ enabled: false });
		awake.setCount(true);
		expect(spawner.argv).toEqual([]);
		awake.setEnabled(true);
		expect(awake.holding).toBe(true);
		expect(spawner.children.length).toBe(1);
	});

	test("the setting off and on with nothing working starts nothing", () => {
		const { awake, spawner } = keeper({ enabled: false });
		awake.setEnabled(true);
		expect(spawner.argv).toEqual([]);
	});

	test("a machine that is not a Mac: nothing is ever started, and the card may say it is not available", () => {
		const { awake, spawner } = keeper({ platform: "linux" });
		expect(awake.available).toBe(false);
		awake.setCount(true);
		expect(spawner.argv).toEqual([]);
		expect(awake.holding).toBe(false);
	});

	test("caffeinate cannot be started: the work goes on, and the failure is said once", () => {
		const reports: string[] = [];
		const awake = new KeepAwake({
			platform: "darwin",
			bin: "/usr/bin/caffeinate",
			spawn: () => null,
			pid: () => 1,
			report: (m) => reports.push(m),
		});
		awake.setCount(true);
		awake.setCount(false);
		awake.setCount(true);
		expect(awake.holding).toBe(false);
		expect(reports.length).toBe(1);
		expect(reports[0]).toContain("caffeinate");
	});

	test("a caffeinate that dies on its own is started again while something still works", () => {
		const { awake, spawner } = keeper();
		awake.setCount(true);
		expect(spawner.children.length).toBe(1);
		// Someone's `killall caffeinate`: the Mac would go unprotected until the count dropped otherwise.
		spawner.children[0].die();
		expect(spawner.children.length).toBe(2);
		expect(awake.holding).toBe(true);
	});

	test("a caffeinate that dies with nothing working is not started again", () => {
		const { awake, spawner } = keeper();
		awake.setCount(true);
		awake.setCount(false);
		// The one this keeper ended: its own exit must not start another.
		expect(spawner.children.length).toBe(1);
		expect(awake.holding).toBe(false);
	});

	test("a caffeinate that dies after the server stopped is not started again", () => {
		const { awake, spawner } = keeper();
		awake.setCount(true);
		awake.stop();
		spawner.children[0].die();
		expect(spawner.children.length).toBe(1);
	});

	test("a caffeinate that dies while the setting is off is not started again", () => {
		const { awake, spawner } = keeper();
		awake.setCount(true);
		awake.setEnabled(false);
		spawner.children[0].die();
		expect(spawner.children.length).toBe(1);
	});

	test("server exit: what holds the Mac awake ends, and a later count starts nothing", () => {
		const { awake, spawner } = keeper();
		awake.setCount(true);
		awake.stop();
		expect(spawner.children[0].stopped).toBe(1);
		awake.setCount(true);
		expect(spawner.children.length).toBe(1);
	});
});

/** A `LiveInfo` as `awakeWorking` reads it: idle unless the test says otherwise. */
function info(over: Partial<LiveInfo> = {}): LiveInfo {
	return {
		liveId: "L",
		pid: 1,
		cwd: "/p",
		sessionFile: null,
		sessionId: null,
		args: [],
		startedAt: 0,
		streaming: false,
		exited: false,
		subscribers: 0,
		pausedAt: null,
		mode: "full",
		...over,
	};
}

describe("awakeWorking: what holds the Mac awake, which is not what the menu bar counts", () => {
	const usageWait = { attempt: 1, maxAttempts: 3, delayMs: 3_600_000, startedAt: 0, usageLimit: true, resumed: false };

	test("a turn that streams holds it", () => {
		expect(awakeWorking(info({ streaming: true }))).toBe(true);
	});

	test("a usage-limit wait does not, though omp reports it streaming for the whole backoff", () => {
		// omp says `isStreaming` true while it sleeps through the limit; the wait is hours, so nothing of it is being cut.
		expect(awakeWorking(info({ streaming: true, retry: usageWait }))).toBe(false);
		expect(workingIds([info({ liveId: "wait", streaming: true, retry: usageWait })])).toEqual([]);
		// `workCounts` still counts it: the menu bar shows a turn in hand.
		expect(workCounts([info({ streaming: true, retry: usageWait })])).toEqual({ working: 1, asking: 0 });
	});

	test("a goal conversation between two turns holds it, unless that is the usage-limit wait", () => {
		// `continuing` is what the server says of a goal run between two of its turns (`noteWork`), and `streaming` is false
		// between them: the run goes on by itself, so the Mac is held for it — unless the pause is the long wait.
		expect(awakeWorking(info({ continuing: true }))).toBe(true);
		expect(awakeWorking(info({ continuing: true, retry: usageWait }))).toBe(false);
	});

	test("a short backoff (a 5xx, a dropped stream) still counts: the turn is coming back in seconds", () => {
		expect(awakeWorking(info({ streaming: true, retry: { ...usageWait, usageLimit: false } }))).toBe(true);
		// And one that already resumed its turn is a turn again, whatever it waited for.
		expect(awakeWorking(info({ streaming: true, retry: { ...usageWait, resumed: true } }))).toBe(true);
	});

	test("nothing else: a dialog waiting for an answer, a paused or ended conversation", () => {
		expect(awakeWorking(info({ asking: true }))).toBe(false);
		expect(awakeWorking(info({ streaming: true, pausedAt: 1 }))).toBe(false);
		expect(awakeWorking(info({ streaming: true, exited: true }))).toBe(false);
	});

	test("a conversation held at the quota floor does not (#652): omp waits in a dialog until the window resets", () => {
		const warming = { state: "unknown" } as const;
		const hold = { provider: "anthropic", floor: 20, remaining: 0.05, since: 0, warming };
		expect(awakeWorking(info({ streaming: true, quotaHold: { ...hold, state: "held" } }))).toBe(false);
		expect(workingIds([info({ liveId: "held", streaming: true, quotaHold: { ...hold, state: "held" } })])).toEqual([]);
		// `workCounts` still counts it: the menu bar shows a turn in hand.
		expect(workCounts([info({ streaming: true, quotaHold: { ...hold, state: "held" } })])).toEqual({
			working: 1,
			asking: 0,
		});
		// Reached but a request is still in flight (armed), or the person said to go on (overridden): the conversation works.
		expect(awakeWorking(info({ streaming: true, quotaHold: { ...hold, state: "armed" } }))).toBe(true);
		expect(awakeWorking(info({ streaming: true, quotaHold: { ...hold, state: "overridden" } }))).toBe(true);
		expect(
			awakeWorking(info({ streaming: true, quotaHold: { ...hold, state: "unavailable", reason: "notLoaded" } })),
		).toBe(true);
	});

	test("one waiting and one working: only the working one keeps the Mac awake and gets a note", () => {
		const infos = [
			info({ liveId: "wait", streaming: true, retry: usageWait }),
			info({ liveId: "work", streaming: true }),
		];
		expect(workingIds(infos)).toEqual(["work"]);
	});
});

describe("the real spawner: the child lives while it is wanted, and goes when it is ended", () => {
	/** A stand-in for `caffeinate` that stays until it is signalled, as the real one does (`-w` is a poll of its own). */
	async function stub(): Promise<{ bin: string; report: string[] }> {
		const dir = mkdtempSync(join(tmpdir(), "ompw-caff-"));
		dirs.push(dir);
		const bin = join(dir, "caffeinate-stub");
		writeFileSync(bin, "#!/bin/sh\ntrap 'exit 0' TERM\nwhile :; do sleep 0.05; done\n");
		chmodSync(bin, 0o755);
		return { bin, report: [] };
	}

	test("nothing is killed while it is wanted: the child is still there well past the kill grace", async () => {
		const { bin, report } = await stub();
		// `STOP_GRACE_MS` is 2 s: a child that lived 3 s was not on a timer from its start.
		const child = spawnCaffeinate([bin], (m) => report.push(m));
		expect(child).not.toBeNull();
		expect(child?.pid).toBeGreaterThan(0);
		await Bun.sleep(3000);
		expect(processExists(child?.pid as number)).toBe(true);
		child?.stop();
		await untilGone(child?.pid as number);
		expect(processExists(child?.pid as number)).toBe(false);
		expect(report).toEqual([]);
	});

	test("a program that cannot be started is reported, not thrown", () => {
		const report: string[] = [];
		expect(spawnCaffeinate([join(tmpdir(), "ompw-no-such-caffeinate")], (m) => report.push(m))).toBeNull();
		expect(report.length).toBe(1);
	});
});

/**
 * Clock readings a test makes up: the wall clock, the monotonic clock that stops across a sleep, and the one that counts
 * through it. `at(wall, mono)` is a machine where nothing slept, so the counting clock agrees with the wall clock.
 */
const at = (wall: number, mono: number, continuous = wall) => ({ wall, mono, continuous });

describe("a sleep, from the clocks", () => {
	test("a second's tick is no sleep", () => {
		expect(sleepBetween(at(1_000_000, 5_000), at(1_001_000, 6_000))).toBeNull();
	});

	test("a late tick (a busy machine, a long garbage collection) is no sleep", () => {
		// Every clock went on for the whole gap: the machine was awake, the timer was simply late.
		expect(sleepBetween(at(1_000_000, 5_000), at(1_060_000, 65_000))).toBeNull();
	});

	test("a wall-clock step (a time zone, an NTP correction of a second or two) is no sleep", () => {
		const before = at(1_000_000, 5_000);
		expect(sleepBetween(before, at(1_000_000 + SLEEP_MIN_MS - 1, 5_000 + SLEEP_MIN_MS - 1))).toBeNull();
	});

	test("the machine was away: the wall clock and the counting clock went on, the other did not", () => {
		const from = 1_700_000_000_000;
		// `continuous` is the same scale as the wall clock here: it counts the sleep the other monotonic clock did not.
		const before = at(from, 20_000);
		const after = { wall: from + 98 * 60_000, mono: 20_950, continuous: from + 98 * 60_000 };
		expect(sleepBetween(before, after)).toEqual({ from, to: after.wall });
	});

	test("a wall clock moved forward is no sleep: the counting clock did not move", () => {
		// A manual change of the time, a virtual machine resumed from a snapshot: `Date.now()` jumps, nothing slept, and
		// `hrtime` (which counts sleeps) says so.
		const from = 1_700_000_000_000;
		expect(sleepBetween(at(from, 20_000), { wall: from + 90 * 60_000, mono: 20_500, continuous: 20_500 })).toBeNull();
		// A jump of hours is caught the same way.
		expect(sleepBetween(at(from, 20_000), { wall: from + 6 * 3_600_000, mono: 21_000, continuous: 21_000 })).toBeNull();
	});

	test("a short sleep of exactly the floor is one", () => {
		const before = at(1_700_000_000_000, 20_000);
		expect(
			sleepBetween(before, {
				wall: before.wall + SLEEP_MIN_MS,
				mono: before.mono + 100,
				continuous: before.continuous + SLEEP_MIN_MS,
			}),
		).not.toBeNull();
	});

	test("a monotonic clock that went backwards counts as none of the wall time", () => {
		const before = at(1_700_000_000_000, 90_000);
		expect(
			sleepBetween(before, { wall: before.wall + 60_000, mono: 1_000, continuous: before.continuous + 60_000 }),
		).not.toBeNull();
	});
});

describe("the detector: which conversations the sleep caught", () => {
	/** A detector on clocks a test moves, with the working ids it is told each tick. */
	function detector() {
		const clock = { wall: 1_700_000_000_000, mono: 10_000, continuous: 1_700_000_000_000 };
		let working: string[] = [];
		const woke: { from: number; to: number; working: string[] }[] = [];
		const d = new SleepDetector({
			read: () => ({ ...clock }),
			working: () => working,
			woke: (note) => woke.push(note),
		});
		return {
			d,
			woke,
			/** A tick of `ms` of awake time: every clock advances. */
			tick(ms = 1000) {
				clock.wall += ms;
				clock.mono += ms;
				clock.continuous += ms;
				d.tick();
			},
			setWorking(ids: string[]) {
				working = ids;
			},
			/** The machine sleeps for `ms`: the wall clock goes on, and so does the clock that counts sleeps. */
			sleep(ms: number) {
				clock.wall += ms;
				clock.continuous += ms;
				d.tick();
			},
			/** The wall clock alone is moved by `ms` (a manual change, an NTP correction, a VM resumed): nobody slept. */
			jump(ms: number) {
				clock.wall += ms;
				d.tick();
			},
		};
	}

	test("awake ticks report nothing", () => {
		const { tick, setWorking, woke } = detector();
		setWorking(["a"]);
		for (let i = 0; i < 10; i++) tick();
		expect(woke).toEqual([]);
	});

	test("a sleep reports its window with what was working at the last tick before it", () => {
		const { tick, setWorking, sleep, woke } = detector();
		setWorking(["a", "b"]);
		tick();
		setWorking(["a", "b", "c"]);
		tick();
		const from = 1_700_000_000_000 + 2000;
		sleep(45 * 60_000);
		expect(woke).toEqual([{ from, to: from + 45 * 60_000, working: ["a", "b", "c"] }]);
	});

	test("a conversation that had stopped before the sleep is not one it caught", () => {
		const { tick, setWorking, sleep, woke } = detector();
		setWorking(["a"]);
		tick();
		setWorking([]);
		tick();
		sleep(60_000);
		expect(woke.map((n) => n.working)).toEqual([[]]);
	});

	test("a conversation that was working at the tick before the sleep is caught, though it is not listed after it", () => {
		// The tick after the sleep is later than any wake: an omp that ended during the sleep is gone by then, and the
		// note belongs to what was running when the machine went away.
		const { tick, setWorking, sleep, woke } = detector();
		setWorking(["a"]);
		tick();
		setWorking([]);
		sleep(10 * 60_000);
		expect(woke[0].working).toEqual(["a"]);
	});

	test("a wall clock moved forward is not a sleep: the clocks never come back together", () => {
		// A manual change of the time, an NTP correction, a virtual machine resumed from a snapshot: `Date.now()` jumps
		// while nothing slept, and every working conversation would otherwise be told it was interrupted.
		const { tick, setWorking, jump, woke } = detector();
		setWorking(["a"]);
		tick();
		jump(90 * 60_000);
		for (let i = 0; i < 5; i++) tick();
		expect(woke).toEqual([]);
	});

	test("a sleep right after a wall clock jump is still a sleep", () => {
		const { tick, setWorking, jump, sleep, woke } = detector();
		setWorking(["a"]);
		tick();
		jump(60 * 60_000);
		tick();
		sleep(40 * 60_000);
		expect(woke.length).toBe(1);
	});

	test("two sleeps are two windows", () => {
		const { tick, setWorking, sleep, woke } = detector();
		setWorking(["a"]);
		tick();
		sleep(40 * 60_000);
		tick();
		sleep(90 * 60_000);
		expect(woke.length).toBe(2);
	});
});
