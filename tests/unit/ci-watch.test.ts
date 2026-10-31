import { expect, test } from "bun:test";
import type { CiAnswer, CiRun, CiRuns, CiScope } from "../../shared/ci.ts";
import { type CiView, CiWatcher } from "../../web/src/lib/ci-watch.ts";

/**
 * The page's side of the CI tab (`web/src/lib/ci-watch.ts`): one loop per folder and list, shared by the badge and the tab,
 * that asks again when the server says the next look is due, never while the page is hidden (unless a run's end is to be
 * notified), at once when the page comes back, and not at all once nothing watches. Time and the page are stand-ins.
 */

const run = (id: number, state: CiRun["state"]): CiRun => ({
	id,
	workflow: "CI",
	title: "t",
	branch: "main",
	event: "push",
	sha: "s",
	state,
	createdAt: "2026-10-01T10:00:00Z",
	updatedAt: "2026-10-01T10:00:00Z",
	url: `https://github.com/o/r/actions/runs/${id}`,
});

const answer = (runs: CiRun[], nextMs: number): CiAnswer<CiRuns> => ({
	ok: true,
	value: { scope: "branch", branch: "main", runs },
	nextMs,
});

function harness(answers: CiAnswer<CiRuns>[], background = false) {
	const asked: { cwd: string; scope: CiScope; fresh: boolean }[] = [];
	const timers = new Map<number, { fn: () => void; ms: number }>();
	let nextTimer = 1;
	let visible = true;
	const visibility = new Set<() => void>();
	const focus = new Set<() => void>();
	const finished: number[][] = [];
	let pending = Promise.resolve();
	const watcher = new CiWatcher({
		ask: (body) => {
			asked.push(body);
			// The last scripted answer is the server's from then on; none at all is a server that cannot be reached.
			const got = answers.length > 1 ? answers.shift() : answers[0];
			const p = got ? Promise.resolve(got) : Promise.reject(new Error("offline"));
			pending = p.then(
				() => {},
				() => {},
			);
			return p;
		},
		env: {
			visible: () => visible,
			onVisibility: (fn) => {
				visibility.add(fn);
				return () => visibility.delete(fn);
			},
			onFocus: (fn) => {
				focus.add(fn);
				return () => focus.delete(fn);
			},
		},
		setTimer: (fn, ms) => {
			const id = nextTimer++;
			timers.set(id, { fn, ms });
			return id;
		},
		clearTimer: (id) => timers.delete(id as number),
		background: () => background,
		onFinished: (_cwd, runs) => finished.push(runs.map((r) => r.id)),
	});
	/** Let the answers that are asked for arrive (a microtask or two). */
	const settle = async () => {
		await pending;
		await Promise.resolve();
	};
	return {
		watcher,
		asked,
		finished,
		settle,
		timers: () => [...timers.values()].map((t) => t.ms),
		/** The timer that is set fires. */
		fire: () => {
			const [id, timer] = [...timers.entries()][0] ?? [];
			if (id === undefined || !timer) throw new Error("no timer is set");
			timers.delete(id);
			timer.fn();
		},
		hide: () => {
			visible = false;
			for (const fn of visibility) fn();
		},
		show: () => {
			visible = true;
			for (const fn of visibility) fn();
		},
		focus: () => {
			for (const fn of focus) fn();
		},
		listening: () => visibility.size + focus.size,
	};
}

test("the badge and the tab share one loop: one ask, then the next when the server says it is due (10 s, then 60 s)", async () => {
	const h = harness([answer([run(1, "running")], 10_250), answer([run(1, "success")], 60_250)]);
	const badge: CiView[] = [];
	const tab: CiView[] = [];
	const stopBadge = h.watcher.watch("/r", "branch", (v) => badge.push(v));
	const stopTab = h.watcher.watch("/r", "branch", (v) => tab.push(v));
	await h.settle();
	expect(h.asked).toEqual([{ cwd: "/r", scope: "branch", fresh: false }]);
	expect(badge.at(-1)?.answer).toEqual(answer([run(1, "running")], 10_250));
	expect(tab.at(-1)).toEqual(badge.at(-1) as CiView);
	expect(h.timers()).toEqual([10_250]);

	h.fire();
	await h.settle();
	expect(h.asked).toHaveLength(2);
	// Every run finished: the next look is a minute away.
	expect(h.timers()).toEqual([60_250]);
	stopBadge();
	stopTab();
});

test("a run that was at work and is finished at the next look is told once; the first look tells nothing", async () => {
	const h = harness([
		answer([run(2, "running"), run(1, "success")], 10_000),
		answer([run(2, "failure"), run(1, "success")], 60_000),
		answer([run(2, "failure"), run(1, "success")], 60_000),
	]);
	const stop = h.watcher.watch("/r", "branch", () => {});
	await h.settle();
	expect(h.finished).toEqual([]);
	h.fire();
	await h.settle();
	expect(h.finished).toEqual([[2]]);
	h.fire();
	await h.settle();
	expect(h.finished).toEqual([[2]]);
	stop();
});

test("hidden, nothing is asked and no timer is kept; back on screen it asks at once", async () => {
	const h = harness([answer([], 60_000)]);
	const stop = h.watcher.watch("/r", "all", () => {});
	await h.settle();
	expect(h.timers()).toEqual([60_000]);
	h.hide();
	expect(h.timers()).toEqual([]);
	h.focus();
	expect(h.asked).toHaveLength(1);
	h.show();
	await h.settle();
	expect(h.asked).toHaveLength(2);
	expect(h.timers()).toEqual([60_000]);
	// The window getting the focus looks too.
	h.focus();
	await h.settle();
	expect(h.asked).toHaveLength(3);
	stop();
});

test("a run's end to be notified keeps the branch's list looked at while the page is hidden", async () => {
	const h = harness([answer([run(1, "running")], 10_000)], true);
	const stop = h.watcher.watch("/r", "branch", () => {});
	await h.settle();
	h.hide();
	expect(h.timers()).toEqual([10_000]);
	h.fire();
	await h.settle();
	expect(h.asked).toHaveLength(2);
	expect(h.timers()).toEqual([10_000]);
	stop();
});

test("Refresh asks for a fresh look; the last to stop watching ends the loop and its listeners", async () => {
	const h = harness([answer([], 60_000)]);
	const views: CiView[] = [];
	const stop = h.watcher.watch("/r", "branch", (v) => views.push(v));
	await h.settle();
	h.watcher.refresh("/r", "branch");
	expect(views.at(-1)?.loading).toBe(true);
	await h.settle();
	expect(h.asked.map((a) => a.fresh)).toEqual([false, true]);
	expect(views.at(-1)?.loading).toBe(false);
	expect(h.watcher.view("/r", "branch")).not.toBeNull();
	stop();
	expect(h.timers()).toEqual([]);
	expect(h.listening()).toBe(0);
	expect(h.watcher.view("/r", "branch")).toBeNull();
	h.watcher.refresh("/r", "branch");
	expect(h.asked).toHaveLength(2);
});

test("a server that cannot be reached is a problem, asked about again in a minute; a wait is kept within bounds", async () => {
	const h = harness([]);
	const views: CiView[] = [];
	const stop = h.watcher.watch("/r", "branch", (v) => views.push(v));
	await h.settle();
	expect(views.at(-1)?.answer).toEqual({ ok: false, problem: "failed", message: "offline", nextMs: 60_000 });
	expect(h.timers()).toEqual([60_000]);
	stop();

	const quick = harness([answer([], 5), answer([], 10 ** 9)]);
	const stopQuick = quick.watcher.watch("/q", "branch", () => {});
	await quick.settle();
	expect(quick.timers()).toEqual([1000]);
	quick.fire();
	await quick.settle();
	expect(quick.timers()).toEqual([15 * 60_000]);
	stopQuick();
});
