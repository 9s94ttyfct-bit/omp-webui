import { describe, expect, test } from "bun:test";
import {
	type QuotaDeps,
	type QuotaHost,
	type QuotaRecord,
	QuotaTracker,
} from "../../server/omp/quota-floor/tracker.ts";
import type { OmpFrame, UsageReport } from "../../shared/protocol.ts";
import type { QuotaHoldReason } from "../../shared/quota-floor.ts";
import {
	type HoldFields,
	QUOTA_DIALOG_TITLE,
	QUOTA_SELF_RELEASE_MS,
	QUOTA_STATUS_KEY,
	warmVerdictText,
} from "../../shared/quota-hold.ts";

/**
 * One conversation's quota floor (#652) with a clock and a provider of its own: a floor reached holds the conversation (the hold
 * file the extension reads, and what pages are told), the reset lets it go, a turn that ends leaves nothing behind, "Continue
 * anyway" stands, and what the server keeps across its end brings the hold back.
 */

const HOUR = 3_600_000;
const T0 = 1_700_000_000_000;

interface World {
	now: number;
	/** What `omp usage` says. */
	left: number;
	resetsAt: number | null;
	/** `omp usage` does not answer. */
	failing: boolean;
	floor: number | null;
	provider: string | null;
	/** The conversation: a turn is open / works (not paused). */
	active: boolean;
	working: boolean;
	cannotHold: QuotaHoldReason | null;
	warmingOff: boolean;
	timers: { at: number; fn: () => void; live: boolean }[];
	file: HoldFields | null;
	writes: (HoldFields | null)[];
	answered: string[];
	changes: number;
	lookups: { provider: string; force: boolean }[];
	failWrite: boolean;
}

function world(over: Partial<World> = {}): World {
	return {
		now: T0,
		left: 0.5,
		resetsAt: T0 + HOUR,
		failing: false,
		floor: 20,
		provider: "anthropic",
		active: true,
		working: true,
		cannotHold: null,
		warmingOff: false,
		timers: [],
		file: null,
		writes: [],
		answered: [],
		changes: 0,
		lookups: [],
		failWrite: false,
		...over,
	};
}

const TIMINGS = { graceMs: 60_000, workingLookMs: 30_000, heldLookMs: 120_000 };

function make(w: World, restored?: QuotaRecord): QuotaTracker {
	const deps: QuotaDeps = {
		timings: TIMINGS,
		now: () => w.now,
		after: (ms, fn) => {
			const timer = { at: w.now + ms, fn, live: true };
			w.timers.push(timer);
			return () => {
				timer.live = false;
			};
		},
		floorOf: () => w.floor,
		reports: async (provider, force) => {
			w.lookups.push({ provider, force });
			if (w.failing) throw new Error("omp usage exited 1");
			const report: UsageReport = {
				provider,
				limits: [
					{
						id: "w",
						label: "5 hour",
						window: { label: "5 hour", ...(w.resetsAt === null ? {} : { resetsAt: w.resetsAt }) },
						amount: { remainingFraction: w.left },
					},
				],
			};
			return [report];
		},
		write: (hold) => {
			if (w.failWrite) throw new Error("disk full");
			w.file = hold;
			w.writes.push(hold);
		},
		report: () => {},
	};
	const host: QuotaHost = {
		provider: () => w.provider,
		model: () => "claude-opus-5",
		active: () => w.active,
		working: () => w.active && w.working,
		cannotHold: () => w.cannotHold,
		warmingOff: () => w.warmingOff,
		answer: (id) => w.answered.push(id),
		changed: () => {
			w.changes++;
		},
	};
	return new QuotaTracker(deps, host, restored);
}

/** The timer that is due first and still live, run now (time moves to it). */
async function tick(w: World): Promise<void> {
	const due = w.timers.filter((t) => t.live).sort((a, b) => a.at - b.at)[0];
	if (!due) throw new Error("no timer is waiting");
	due.live = false;
	w.now = Math.max(w.now, due.at);
	due.fn();
	// What the timer started (a look) settles.
	await Bun.sleep(0);
}

const dialog = (id: string): OmpFrame => ({
	type: "extension_ui_request",
	id,
	method: "select",
	title: QUOTA_DIALOG_TITLE,
});
const cancelled = (id: string): OmpFrame => ({ type: "extension_ui_request", id: "x", method: "cancel", targetId: id });

describe("the floor is reached: a hold", () => {
	test("a turn that begins is looked at at once; below the floor it is armed, and the extension is told by the file", async () => {
		const w = world({ left: 0.1 });
		const t = make(w);
		t.onWork();
		await Bun.sleep(0);
		expect(w.lookups).toEqual([{ provider: "anthropic", force: false }]);
		expect(t.state()).toBe("armed");
		expect(t.info()).toMatchObject({
			state: "armed",
			provider: "anthropic",
			floor: 20,
			remaining: 0.1,
			window: "5 hour",
			resetsAt: T0 + HOUR,
			since: T0,
			warming: { state: "unknown" },
		});
		// The extension reads: the reset, the time the server looks again (a grace after it), the time it lets go alone.
		expect(w.file).toEqual({
			provider: "anthropic",
			resetsAt: T0 + HOUR,
			resumeAt: T0 + HOUR + 60_000,
			expiresAt: T0 + HOUR + 60_000 + QUOTA_SELF_RELEASE_MS,
			since: T0,
		});
		expect(w.changes).toBeGreaterThan(0);
	});

	test("above the floor nothing is held and no file is written", async () => {
		const w = world({ left: 0.5 });
		const t = make(w);
		t.onWork();
		await Bun.sleep(0);
		expect(t.info()).toBeUndefined();
		expect(t.state()).toBeNull();
		expect(w.file).toBeNull();
	});

	test("a provider with no floor is never looked at; one that is not known yet is not either", async () => {
		const noFloor = world({ left: 0.01, floor: null });
		make(noFloor).onWork();
		await Bun.sleep(0);
		expect(noFloor.lookups).toEqual([]);
		const unknown = world({ left: 0.01, provider: null });
		make(unknown).onWork();
		await Bun.sleep(0);
		expect(unknown.lookups).toEqual([]);
	});

	test("the extension's dialog makes it held; its end makes it armed again; none of it reaches a page", async () => {
		const w = world({ left: 0.1 });
		const t = make(w);
		t.onWork();
		await Bun.sleep(0);
		expect(t.onFrame(dialog("d1"))).toBe(true);
		expect(t.state()).toBe("held");
		expect(t.held).toBe(true);
		// A cancel of a dialog that is not the extension's is not the tracker's.
		expect(t.onFrame(cancelled("other"))).toBe(false);
		expect(t.state()).toBe("held");
		expect(t.onFrame(cancelled("d1"))).toBe(true);
		expect(t.state()).toBe("armed");
		// Other dialogs and frames go on to the pages.
		expect(t.onFrame({ type: "extension_ui_request", id: "d9", method: "select", title: "Run this command?" })).toBe(
			false,
		);
		expect(t.onFrame({ type: "agent_start" })).toBe(false);
	});

	test("a dialog that opens when nothing holds is answered at once, so that the wait ends as it begins", async () => {
		const w = world({ left: 0.5 });
		const t = make(w);
		t.onWork();
		await Bun.sleep(0);
		expect(t.onFrame(dialog("late"))).toBe(true);
		expect(w.answered).toEqual(["late"]);
		expect(t.state()).toBeNull();
	});

	test("a process that cannot be held is told so and is not written a file", async () => {
		const w = world({ left: 0.1, cannotHold: "trustedExtension" });
		const t = make(w);
		t.onWork();
		await Bun.sleep(0);
		expect(t.info()).toMatchObject({ state: "unavailable", reason: "trustedExtension" });
		expect(w.file).toBeNull();
		expect(t.held).toBe(false);
	});
});

describe("the reset: the hold is let go", () => {
	test("held, the quota is looked at at the reset and a grace after it, and above the floor the hold, its file and its dialogs are gone", async () => {
		const w = world({ left: 0.1 });
		const t = make(w);
		t.onWork();
		await Bun.sleep(0);
		t.onFrame(dialog("d1"));
		t.onFrame(dialog("d2"));
		// The window stays low until its reset; the slow look (every 120 s) finds it so and holds on.
		const resumeAt = T0 + HOUR + 60_000;
		w.lookups.length = 0;
		await tick(w);
		expect(w.now).toBe(T0 + 120_000);
		expect(t.state()).toBe("held");
		while (w.timers.some((x) => x.live && x.at < resumeAt)) await tick(w);
		// The window refills at its reset. The next look is the one at the reset's grace, whatever the slow interval says.
		w.left = 0.9;
		expect(t.state()).toBe("held");
		await tick(w);
		expect(w.now).toBe(resumeAt);
		// The look at the reset asks the provider itself: a figure from before the reset says nothing of it.
		expect(w.lookups.at(-1)).toEqual({ provider: "anthropic", force: true });
		expect(t.state()).toBeNull();
		expect(t.info()).toBeUndefined();
		expect(w.file).toBeNull();
		// Both of the extension's open waits were answered: it goes on at once, not at its next look at the file.
		expect(w.answered.sort()).toEqual(["d1", "d2"]);
	});

	test("the reset passes and the provider still says low: it is held on, and looked at at the working interval until it does not", async () => {
		const w = world({ left: 0.1 });
		const t = make(w);
		t.onWork();
		await Bun.sleep(0);
		t.onFrame(dialog("d1"));
		const resumeAt = T0 + HOUR + 60_000;
		while (w.now < resumeAt) await tick(w);
		expect(t.state()).toBe("held");
		const at = w.now;
		await tick(w);
		expect(w.now - at).toBe(30_000);
		expect(t.state()).toBe("held");
		w.left = 0.9;
		await tick(w);
		expect(t.state()).toBeNull();
		expect(w.answered).toEqual(["d1"]);
	});

	test("a look that cannot be made leaves the hold as it is; omp usage not answering never holds, and never releases", async () => {
		const w = world({ left: 0.1 });
		const t = make(w);
		t.onWork();
		await Bun.sleep(0);
		w.failing = true;
		await tick(w);
		expect(t.state()).toBe("armed");
		const fresh = world({ left: 0.1, failing: true });
		const none = make(fresh);
		none.onWork();
		await Bun.sleep(0);
		expect(none.state()).toBeNull();
		expect(fresh.file).toBeNull();
	});

	test("a hold with no reset time is looked at slowly, never lets itself go, and ends when the provider is above the floor", async () => {
		const w = world({ left: 0.1, resetsAt: null });
		const t = make(w);
		t.onWork();
		await Bun.sleep(0);
		expect(w.file).toMatchObject({ resetsAt: null, resumeAt: null, expiresAt: null });
		t.onFrame(dialog("d1"));
		await tick(w);
		expect(w.now).toBe(T0 + 120_000);
		expect(t.state()).toBe("held");
		w.left = 0.8;
		await tick(w);
		expect(t.state()).toBeNull();
	});

	test("the floor taken away ends it at the next look; so does a floor that is set to something the provider is above", async () => {
		const w = world({ left: 0.1 });
		const t = make(w);
		t.onWork();
		await Bun.sleep(0);
		t.onFrame(dialog("d1"));
		w.floor = null;
		t.refresh();
		await Bun.sleep(0);
		expect(t.state()).toBeNull();
		expect(w.file).toBeNull();
		expect(w.answered).toEqual(["d1"]);
	});
});

describe("work and idleness", () => {
	test("a turn that ends leaves no hold behind, and the next one looks again", async () => {
		const w = world({ left: 0.1 });
		const t = make(w);
		t.onWork();
		await Bun.sleep(0);
		t.onFrame(dialog("d1"));
		w.active = false;
		w.working = false;
		t.onWork();
		expect(t.state()).toBeNull();
		expect(w.file).toBeNull();
		expect(w.answered).toEqual(["d1"]);
		// Nothing is looked at while nothing works.
		expect(w.timers.filter((x) => x.live)).toEqual([]);
		w.active = true;
		w.working = true;
		w.lookups.length = 0;
		t.onWork();
		await Bun.sleep(0);
		expect(w.lookups.length).toBe(1);
		expect(t.state()).toBe("armed");
	});

	test("a pause keeps the hold (omp is frozen where it waits) and looks at nothing; resuming looks at once", async () => {
		const w = world({ left: 0.1 });
		const t = make(w);
		t.onWork();
		await Bun.sleep(0);
		t.onFrame(dialog("d1"));
		w.working = false;
		t.onWork();
		expect(t.state()).toBe("held");
		expect(w.file).not.toBeNull();
		w.lookups.length = 0;
		// A look that the pause did not stop is refused: a frozen conversation spends nothing and nothing is spent on asking.
		await t.look(false);
		expect(w.lookups).toEqual([]);
		w.working = true;
		t.onWork();
		await Bun.sleep(0);
		expect(w.lookups.length).toBe(1);
		expect(t.state()).toBe("held");
	});

	test("while it works the quota is looked at at the working interval, and N looks at once are one", async () => {
		const w = world({ left: 0.5 });
		const t = make(w);
		t.onWork();
		await Bun.sleep(0);
		expect(w.lookups.length).toBe(1);
		await tick(w);
		expect(w.now - T0).toBe(30_000);
		expect(w.lookups.length).toBe(2);
		// Two calls while one is under way look once.
		w.lookups.length = 0;
		await Promise.all([t.look(false), t.look(false)]);
		expect(w.lookups.length).toBe(1);
	});
});

describe("Continue anyway", () => {
	test("lets the conversation go at once, stands through a turn that ends, and ends when the provider is above the floor", async () => {
		const w = world({ left: 0.1 });
		const t = make(w);
		t.onWork();
		await Bun.sleep(0);
		t.onFrame(dialog("d1"));
		t.setOverride(true);
		expect(t.state()).toBe("overridden");
		expect(w.file).toBeNull();
		expect(w.answered).toEqual(["d1"]);
		// A dialog that comes after it is answered at once too.
		expect(t.onFrame(dialog("d2"))).toBe(true);
		expect(w.answered).toEqual(["d1", "d2"]);
		// The turn ends and another begins: still the person's word, while the provider is still at the floor.
		w.active = false;
		w.working = false;
		t.onWork();
		expect(t.info()).toBeUndefined();
		w.active = true;
		w.working = true;
		t.onWork();
		await Bun.sleep(0);
		expect(t.state()).toBe("overridden");
		expect(w.file).toBeNull();
		// The provider above the floor: the choice was for the stretch below it.
		w.left = 0.9;
		await tick(w);
		expect(t.state()).toBeNull();
		w.left = 0.1;
		await tick(w);
		expect(t.state()).toBe("armed");
	});

	test("hold again puts the file back; continuing when nothing is held is nothing", async () => {
		const w = world({ left: 0.1 });
		const t = make(w);
		t.onWork();
		await Bun.sleep(0);
		t.setOverride(true);
		expect(w.file).toBeNull();
		t.setOverride(false);
		expect(t.state()).toBe("armed");
		expect(w.file).not.toBeNull();
		const idle = make(world({ left: 0.9 }));
		idle.setOverride(true);
		expect(idle.state()).toBeNull();
	});
});

describe("what the extension tells, and what the server keeps", () => {
	const verdict = (over: object = {}) =>
		warmVerdictText({ at: T0, state: "on", pings: 6, warmCost: 0.3, rebuildCost: 1.7, ...over });
	const status = (text: string): OmpFrame => ({
		type: "extension_ui_request",
		id: "s",
		method: "setStatus",
		statusKey: QUOTA_STATUS_KEY,
		statusText: text,
	});

	test("the cache decision is consumed, and said; a status of another key goes on to the pages", async () => {
		const w = world({ left: 0.1 });
		const t = make(w);
		t.onWork();
		await Bun.sleep(0);
		expect(t.onFrame(status(verdict()))).toBe(true);
		expect(t.info()?.warming).toEqual({ state: "on", pings: 6, warmCost: 0.3, rebuildCost: 1.7 });
		expect(t.onFrame(status(verdict({ state: "lapse", why: "cost", pings: 66, warmCost: 9.9 })))).toBe(true);
		expect(t.info()?.warming).toMatchObject({ state: "lapse", why: "cost", pings: 66 });
		// Nonsense under the key is consumed and changes nothing.
		expect(t.onFrame(status("not json"))).toBe(true);
		expect(t.info()?.warming.state).toBe("lapse");
		expect(
			t.onFrame({ type: "extension_ui_request", id: "s", method: "setStatus", statusKey: "other", statusText: "x" }),
		).toBe(false);
	});

	test("what the refreshes cost while held is counted from omp's own frames; a failed refresh is a lapse", async () => {
		const w = world({ left: 0.1 });
		const t = make(w);
		t.onWork();
		await Bun.sleep(0);
		t.onFrame(status(verdict()));
		expect(t.onFrame({ type: "cache_warming_end", outcome: "hit", usage: { cost: { total: 0.05 } } })).toBe(false);
		expect(t.onFrame({ type: "cache_warming_end", outcome: "hit", usage: { cost: { total: 0.07 } } })).toBe(false);
		expect(t.info()?.warming).toMatchObject({ state: "on", refreshes: 2 });
		expect(t.info()?.warming.spent).toBeCloseTo(0.12);
		t.onFrame({
			type: "cache_warming_end",
			outcome: "miss",
			usage: { cost: { total: 1 } },
			warmingStopReason: "refresh missed the cache",
		});
		expect(t.info()?.warming).toMatchObject({ state: "lapse", why: "omp", refreshes: 3 });
		// A refresh with no hold is nobody's to count.
		const none = make(world({ left: 0.9 }));
		none.onFrame({ type: "cache_warming_end", outcome: "hit", usage: { cost: { total: 3 } } });
		expect(none.info()).toBeUndefined();
	});

	test("warming off for the conversation is said so, whatever was decided", async () => {
		const w = world({ left: 0.1, warmingOff: true });
		const t = make(w);
		t.onWork();
		await Bun.sleep(0);
		expect(t.info()?.warming).toEqual({ state: "off" });
	});

	test("a verdict that comes when nothing is held is not kept, and a hold that ends takes its verdict and its costs with it", async () => {
		const w = world({ left: 0.1 });
		const t = make(w);
		t.onWork();
		await Bun.sleep(0);
		t.onFrame(status(verdict()));
		t.onFrame({ type: "cache_warming_end", outcome: "hit", usage: { cost: { total: 0.05 } } });
		w.left = 0.9;
		await tick(w);
		expect(t.info()).toBeUndefined();
		expect(t.onFrame(status(verdict()))).toBe(true);
		w.left = 0.1;
		await tick(w);
		expect(t.info()?.warming).toEqual({ state: "unknown" });
	});

	test("a hold is kept across a server: the record names the hold, the waits and the verdict, and the next server finds it held", async () => {
		const w = world({ left: 0.1 });
		const t = make(w);
		t.onWork();
		await Bun.sleep(0);
		t.onFrame(dialog("d1"));
		t.onFrame(status(verdict()));
		const record = t.record();
		expect(record).toMatchObject({
			hold: { provider: "anthropic", floor: 20, resetsAt: T0 + HOUR },
			override: false,
			held: true,
			dialogs: ["d1"],
			verdict: { state: "on" },
		});
		// The record is JSON: it goes to a file.
		const next = world({ left: 0.1, now: T0 + 1_000 });
		const found = make(next, JSON.parse(JSON.stringify(record)) as QuotaRecord);
		expect(found.state()).toBe("held");
		expect(found.info()).toMatchObject({ state: "held", since: T0, warming: { state: "on", pings: 6 } });
		// It writes the file again (the process's folder may have been cleaned) and looks at the quota, which is still low.
		found.resume();
		await Bun.sleep(0);
		expect(next.file).toMatchObject({ provider: "anthropic", since: T0 });
		expect(next.lookups).toEqual([{ provider: "anthropic", force: true }]);
		expect(found.state()).toBe("held");
		// The dialog it was waiting in is known by its id: its end is its own.
		expect(found.onFrame(cancelled("d1"))).toBe(true);
		expect(found.state()).toBe("armed");
	});

	test("a record that says the window has reset while no server ran: the first look releases it", async () => {
		const w = world({ left: 0.1 });
		const t = make(w);
		t.onWork();
		await Bun.sleep(0);
		t.onFrame(dialog("d1"));
		const record = t.record() as QuotaRecord;
		const later = world({ left: 0.9, now: T0 + 2 * HOUR });
		const found = make(later, record);
		found.resume();
		await Bun.sleep(0);
		expect(found.state()).toBeNull();
		expect(later.file).toBeNull();
		expect(later.answered).toEqual(["d1"]);
	});

	test("nothing held, nothing to keep", () => {
		expect(make(world()).record()).toBeUndefined();
	});

	test("a file that cannot be written does not hold up the conversation, and does not pretend it is held", async () => {
		const w = world({ left: 0.1, failWrite: true });
		const t = make(w);
		t.onWork();
		await Bun.sleep(0);
		expect(w.file).toBeNull();
		// It is armed, not held: no dialog came.
		expect(t.state()).toBe("armed");
	});
});

describe("the end", () => {
	test("an ended conversation looks at nothing more", async () => {
		const w = world({ left: 0.1 });
		const t = make(w);
		t.onWork();
		await Bun.sleep(0);
		t.end();
		w.lookups.length = 0;
		t.onWork();
		await t.look(false);
		t.refresh();
		await Bun.sleep(0);
		expect(w.lookups).toEqual([]);
		expect(w.timers.filter((x) => x.live)).toEqual([]);
	});
});
