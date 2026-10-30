import "./browser-globals.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Goal } from "../../shared/goal.ts";
import type { LiveInfo } from "../../shared/protocol.ts";
import { initialLive, type LiveState } from "../../web/src/store/live.ts";
import { clearGoal, conversationKey, showGoal, useShownGoal } from "../../web/src/store/shown-goal.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * The one answer to "does the conversation on screen hold a goal": the header's Goal control, the ⋯ menu's row and the
 * command palette's entry read it, so they cannot offer a goal omp would refuse beside one it holds. It belongs to the
 * conversation it was published for, and is taken back when the page leaves it.
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const info = (liveId: string, sessionFile: string | null): LiveInfo => ({
	liveId,
	pid: 1,
	cwd: "/",
	sessionFile,
	sessionId: "a",
	args: [],
	startedAt: 0,
	streaming: false,
	exited: false,
	subscribers: 1,
	pausedAt: null,
	mode: "full",
});

const live = (liveId: string, sessionFile: string | null): LiveState => initialLive(info(liveId, sessionFile));
const goal = (status: Goal["status"]): Goal => ({ id: "g", objective: "Ship it", status });

test("the answer is the goal that is published, and a goal that ended is none", () => {
	showGoal(goal("active"), "file:/a.jsonl");
	expect(useShownGoal.getState().goal).toMatchObject({ id: "g", status: "active" });
	expect(useShownGoal.getState().of).toBe("file:/a.jsonl");

	// A goal that ended is not one omp holds: nothing is shown, and no new goal may be set beside it.
	showGoal(goal("complete"), "file:/a.jsonl");
	expect(useShownGoal.getState().goal).toBeNull();
});

test("the answer belongs to its conversation: another conversation's goal is not shown for this one", () => {
	showGoal(goal("active"), "file:/a.jsonl");
	// The page shows another conversation now: its own answer is not this one's.
	expect(conversationKey("/b.jsonl", undefined)).toBe("file:/b.jsonl");
	expect(useShownGoal.getState().of).toBe("file:/a.jsonl");
});

test("leaving a conversation takes its answer back, and leaves another conversation's alone", () => {
	showGoal(goal("active"), "file:/a.jsonl");
	clearGoal("file:/b.jsonl");
	expect(useShownGoal.getState().goal).toMatchObject({ id: "g" });

	clearGoal("file:/a.jsonl");
	expect(useShownGoal.getState().goal).toBeNull();
	expect(useShownGoal.getState().of).toBeNull();
});

test("a conversation is named by its process, or by its file when none runs", () => {
	expect(conversationKey("/a.jsonl", live("L1", "/a.jsonl"))).toBe("live:L1");
	expect(conversationKey("/a.jsonl", undefined)).toBe("file:/a.jsonl");
	expect(conversationKey(null, live("L1", null))).toBe("live:L1");
	expect(conversationKey(null, undefined)).toBeNull();
	// A process that ended is not running: the file names the conversation.
	expect(
		conversationKey("/a.jsonl", { ...live("L1", "/a.jsonl"), info: { ...info("L1", "/a.jsonl"), exited: true } }),
	).toBe("file:/a.jsonl");
});
