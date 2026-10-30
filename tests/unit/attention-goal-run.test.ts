import "./browser-globals.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { LiveInfo, OmpFrame } from "../../shared/protocol.ts";
import { attentionChanges } from "../../web/src/lib/attention.ts";
import { applyFrame, initialLive, type LiveState } from "../../web/src/store/live.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * "Finished" (the tab's ✓ mark, the system notification) says a run is over. A goal run is many turns, each its own
 * `agent_start` … `agent_end` with the next one ~1 ms behind (omp 18.12.3, observed), and one `session_settled` at the end.
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const info: LiveInfo = {
	liveId: "L1",
	pid: 1,
	cwd: "/",
	sessionFile: "/sessions/a.jsonl",
	sessionId: "a",
	args: [],
	startedAt: 0,
	streaming: false,
	exited: false,
	subscribers: 1,
	pausedAt: null,
	mode: "full",
};

const goal = (status: string, tokensUsed = 0) => ({ id: "g", objective: "Ship it", status, tokensUsed });
const frame = (f: OmpFrame): OmpFrame => f;
const updated = (status: string, tokensUsed?: number) =>
	frame({ type: "goal_updated", goal: goal(status, tokensUsed) });
const start = frame({ type: "agent_start" });
const end = frame({ type: "agent_end", isTerminal: true, yielded: true });
const settled = frame({ type: "session_settled" });

/** The frames, one by one through the store's reducer; the index of each frame after which something finished. */
function finishedAfter(frames: OmpFrame[]): number[] {
	const out: number[] = [];
	let live: LiveState = initialLive(info);
	frames.forEach((f, i) => {
		const next = applyFrame(live, f);
		if (attentionChanges({ L1: live }, { L1: next }).finished.length) out.push(i);
		live = next;
	});
	return out;
}

test("a goal run of four turns is one finished run, at its end: not one per turn", () => {
	// The order omp sent for a goal that took four turns and then completed.
	const run = [
		updated("active"),
		start,
		updated("active", 12),
		updated("active", 24),
		end,
		start,
		updated("active", 36),
		end,
		start,
		updated("active", 48),
		end,
		start,
		updated("complete", 60),
		end,
		settled,
	];
	expect(finishedAfter(run)).toEqual([13]);
});

test("a goal omp stops continuing is finished when omp says the session is settled", () => {
	// A turn with no tool activity: omp waits for the user, the goal is still active.
	expect(finishedAfter([updated("active"), start, end, settled])).toEqual([3]);
	// Several turns first: still only the one, at the end.
	expect(finishedAfter([updated("active"), start, end, start, end, start, end, settled])).toEqual([7]);
});

test("a goal paused or dropped between two turns ends the run there", () => {
	expect(finishedAfter([updated("active"), start, end, updated("paused"), settled])).toEqual([3]);
	expect(finishedAfter([updated("active"), start, end, updated("dropped"), settled])).toEqual([3]);
	// A budget spent ends the run with its last turn: nothing is continued for it.
	expect(finishedAfter([updated("active"), start, updated("budget-limited", 1640), end, settled])).toEqual([3]);
});

test("a turn without a goal is finished when it ends, and the settled frame after it adds nothing", () => {
	expect(finishedAfter([start, end, settled])).toEqual([1]);
	// A goal that is not active does not hold the run open either.
	expect(finishedAfter([updated("paused"), start, end, settled])).toEqual([2]);
});

test("a turn that ends non-terminal (omp goes on by itself) is not finished", () => {
	const retry = frame({ type: "agent_end", isTerminal: false, yielded: false });
	expect(finishedAfter([start, retry, start, end, settled])).toEqual([3]);
});
