import "./browser-globals.ts";
import { afterAll, beforeAll, beforeEach, expect, type Mock, spyOn, test } from "bun:test";
import type { Goal } from "../../shared/goal.ts";
import type { LiveInfo, ServerMessage } from "../../shared/protocol.ts";
import { socket } from "../../web/src/lib/ws.ts";
import { onServer, useApp } from "../../web/src/store/app.ts";
import { initialLive, type LiveState } from "../../web/src/store/live.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * One omp process serves a series of session files (`/new`, fork, branch, resume). omp leaves the previous goal and its
 * subagents behind; the page must not keep showing them for the conversation that replaced it.
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const A = "/sessions/a.jsonl";
const B = "/sessions/b.jsonl";

const info = (liveId: string, sessionFile: string | null): LiveInfo => ({
	liveId,
	pid: 1,
	cwd: "/",
	sessionFile,
	sessionId: null,
	args: [],
	startedAt: 0,
	streaming: false,
	exited: false,
	subscribers: 1,
	pausedAt: null,
	mode: "full",
});

const goal = (status: Goal["status"]): Goal => ({
	id: "g1",
	objective: "Ship it",
	status,
	tokenBudget: 5000,
	tokensUsed: 900,
});

/** What omp answers for the session it is on now; a test sets it before the process moves. */
let omp: { goal: Goal | null; subagents: unknown[] };
let rpc: Mock<typeof socket.rpc>;
beforeEach(() => {
	omp = { goal: null, subagents: [] };
	rpc?.mockRestore();
	rpc = spyOn(socket, "rpc").mockImplementation((async (_liveId: string, command: { type: string }) => {
		switch (command.type) {
			case "goal":
				return { goal: omp.goal, state: null };
			case "get_subagents":
				return { subagents: omp.subagents };
			case "get_available_commands":
				return { commands: [] };
			case "get_state":
				return { messageCount: 0, queuedMessageCount: 0, isStreaming: false, goal: null };
			default:
				return { entries: [], leafId: null };
		}
	}) as typeof socket.rpc);
	useApp.setState({ view: { kind: "new" }, lives: {}, toasts: [], sessions: [] });
});

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const moved = (liveId: string, to: string | null): ServerMessage => ({ t: "live", info: info(liveId, to) });

/** A process on `file` that is working for a goal with a subagent running: everything the old conversation had. */
function busyLive(liveId: string, file: string | null): void {
	const base: LiveState = initialLive(info(liveId, file));
	useApp.setState((s) => ({
		lives: {
			...s.lives,
			[liveId]: {
				...base,
				goal: goal("active"),
				subagents: {
					Scout: { id: "Scout", status: "running", startedAt: 1, updatedAt: 1 } as LiveState["subagents"][string],
				},
				queue: { steering: ["next"], followUp: [] },
				notices: [{ kind: "rules", sig: "x", rules: [] } as unknown as LiveState["notices"][number]],
				todoReminder: { todos: [], attempt: 1, maxAttempts: 3, resumed: false },
			},
		},
	}));
}

test("a process that moves to another session file shows nothing of the goal, subagents and queue it left", async () => {
	busyLive("L1", A);
	onServer(moved("L1", B));
	// What belonged to the old session is gone at once, before omp is asked.
	const live = useApp.getState().lives.L1;
	expect(live.goal).toBeNull();
	expect(Object.keys(live.subagents)).toEqual([]);
	expect(live.queue).toEqual({ steering: [], followUp: [] });
	expect(live.notices).toEqual([]);
	expect(live.todoReminder).toBeNull();
	await settle();
	// And omp is asked what the new session has.
	const asked = rpc.mock.calls.map(([, command]) => `${command.type}${command.op ? `:${command.op}` : ""}`);
	expect(asked).toEqual(expect.arrayContaining(["goal:get", "get_state", "get_subagents"]));
	expect(useApp.getState().lives.L1.goal).toBeNull();
});

test("a goal the new session restores (journaled in its file) is what is shown, and the old one is not", async () => {
	busyLive("L1", A);
	omp.goal = { ...goal("paused"), id: "g2", objective: "Another goal" };
	onServer(moved("L1", B));
	await settle();
	expect(useApp.getState().lives.L1.goal).toMatchObject({ id: "g2", status: "paused" });
});

test("a subagent the new session has (omp lists it) is shown; the old session's is not", async () => {
	busyLive("L1", A);
	omp.subagents = [{ id: "Mapper", status: "running" }];
	onServer(moved("L1", B));
	await settle();
	expect(Object.keys(useApp.getState().lives.L1.subagents)).toEqual(["Mapper"]);
});

test("the first file of a new chat is the same conversation: its goal and subagents stay", async () => {
	busyLive("L1", null);
	omp.goal = goal("active");
	onServer(moved("L1", A));
	expect(useApp.getState().lives.L1.goal).toMatchObject({ status: "active" });
	expect(Object.keys(useApp.getState().lives.L1.subagents)).toEqual(["Scout"]);
	await settle();
	expect(useApp.getState().lives.L1.goal).toMatchObject({ status: "active" });
});

test("an announce that leaves the session file as it was changes nothing", async () => {
	busyLive("L1", A);
	onServer(moved("L1", A));
	await settle();
	const live = useApp.getState().lives.L1;
	expect(live.goal).toMatchObject({ status: "active" });
	expect(Object.keys(live.subagents)).toEqual(["Scout"]);
	expect(rpc.mock.calls).toEqual([]);
});

test("the same session under another spelling of its file path is not a session change", async () => {
	// macOS: the temp directory is a symlink, and the server names the file both ways.
	const same = (file: string): LiveInfo => ({ ...info("L1", file), sessionId: "s-1" });
	useApp.setState((s) => ({
		lives: { ...s.lives, L1: { ...initialLive(same("/var/a.jsonl")), goal: goal("active") } },
	}));
	onServer({ t: "live", info: same("/private/var/a.jsonl") });
	await settle();
	expect(useApp.getState().lives.L1.goal).toMatchObject({ status: "active" });
	const asked = rpc.mock.calls.map(([, command]) => command.type);
	expect(asked).not.toContain("goal");
});
