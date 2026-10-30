import "./browser-globals.ts";
import { afterAll, beforeAll, beforeEach, expect, type Mock, spyOn, test } from "bun:test";

import type { LiveInfo, OmpFrame } from "../../shared/protocol.ts";
import { socket } from "../../web/src/lib/ws.ts";
import { attachLive, onServer, onViewChange, useApp } from "../../web/src/store/app.ts";
import { initialLive, type RpcState } from "../../web/src/store/live.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * The page stops listening to a process nobody looks at, so that the server may close it when it is idle. "Idle" is
 * omp's word, not the first `agent_end`: a goal's next turn starts a moment after the terminal `agent_end` of the
 * last, and a turn woken by background work does too. A page that has detached sees none of it: no streaming dot, no
 * "needs input" toast for an approval raised in the next turn, no notification when it is done (#359).
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const info = (liveId: string): LiveInfo => ({
	liveId,
	pid: 1,
	cwd: "/",
	sessionFile: `/sessions/${liveId}.jsonl`,
	sessionId: liveId,
	args: [],
	startedAt: 0,
	streaming: false,
	exited: false,
	subscribers: 1,
	pausedAt: null,
	mode: "full",
});

const state = (extra: Partial<RpcState> = {}): RpcState => ({
	isStreaming: false,
	isCompacting: false,
	steeringMode: "one-at-a-time",
	followUpMode: "one-at-a-time",
	interruptMode: "immediate",
	messageCount: 4,
	queuedMessageCount: 0,
	sessionId: "s",
	sessionName: "Named",
	isSettled: true,
	...extra,
});

const frame = (liveId: string, f: OmpFrame) => onServer({ t: "frame", liveId, frame: f });
/** Everything already scheduled has run once this resolves (the stubbed calls answer at once). */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

let rpc: Mock<typeof socket.rpc>;
let post: Mock<typeof socket.post>;
let request: Mock<typeof socket.request>;
/** What omp answers to `get_state`. */
let omp: RpcState;
/** The process of the test: a new one each time, because what the page let go of is remembered by id for the life of the module. */
let G = "";
let seq = 0;
const detaches = () => post.mock.calls.flatMap(([m]) => (m.t === "detach" ? [m.liveId] : []));

beforeEach(() => {
	rpc?.mockRestore();
	post?.mockRestore();
	request?.mockRestore();

	omp = state();
	rpc = spyOn(socket, "rpc").mockImplementation((async (_id: string, command: Record<string, unknown>) => {
		if (command.type === "get_state") return omp;
		if (command.type === "get_entries") return { entries: [], leafId: null };
		if (command.type === "goal") return { goal: null };
		return undefined;
	}) as typeof socket.rpc);
	post = spyOn(socket, "post").mockImplementation(() => {});
	request = spyOn(socket, "request").mockImplementation((async () => info(G)) as typeof socket.request);
	// A goal runs in G; the page shows another conversation.
	G = `G${++seq}`;
	useApp.setState({
		lives: { [G]: { ...initialLive(info(G)), streaming: true } },
		view: { kind: "chat", file: "/sessions/other.jsonl", liveId: null },
		bash: {},
		toasts: [],
	});
});

test("the first terminal agent_end of a goal is not the end: the page stays attached through the turns that follow", async () => {
	frame(G, { type: "agent_start" });
	frame(G, { type: "goal_updated", goal: { id: "g", objective: "ship it", status: "active" } });
	// omp, as measured: the continuation starts 2 ms after the terminal agent_end, and get_state says so.
	omp = state({ isStreaming: true, isSettled: false });
	frame(G, { type: "agent_end", isTerminal: true });
	await settle();
	expect(detaches()).toEqual([]);

	// The continuation turn raises a dialog: the page is still there to hear it.
	frame(G, { type: "agent_start" });
	frame(G, { type: "extension_ui_request", method: "confirm", id: "d1", title: "Allow bash?", message: "ls" });
	expect(useApp.getState().lives[G].needsInput).toBe(true);
	frame(G, { type: "extension_ui_request", method: "cancel", id: "c1", targetId: "d1" });
	omp = state({ isSettled: false });
	frame(G, { type: "agent_end", isTerminal: true });
	await settle();
	expect(detaches()).toEqual([]);

	// omp says nothing will wake the session: now it is let go of.
	omp = state();
	frame(G, { type: "session_settled" });
	await settle();
	expect(detaches()).toEqual([G]);
});

test("an idle-looking process is not let go of while omp reports it is not settled (a retry wait, background work)", async () => {
	omp = state({ isStreaming: false, isSettled: false });
	frame(G, { type: "agent_start" });
	frame(G, { type: "agent_end", isTerminal: true });
	await settle();
	// What the page's own view says is not enough: not streaming, no dialog, nothing running a `!command`.
	const live = useApp.getState().lives[G];
	expect(live.streaming).toBe(false);
	expect(live.settled).toBe(false);
	onViewChange();
	expect(detaches()).toEqual([]);
});

test("a process that is idle when the page attaches to it is let go of when the page moves on; a busy one is not", async () => {
	const H = `${G}-busy`;
	useApp.setState({ lives: { [G]: initialLive(info(G)), [H]: initialLive(info(H)) } });
	request.mockImplementation((async (msg: { liveId: string }) => info(msg.liveId)) as typeof socket.request);
	omp = state({ isSettled: true });
	await attachLive(G);
	omp = state({ isStreaming: false, isSettled: false });
	await attachLive(H);
	expect(useApp.getState().lives[G].settled).toBe(true);
	expect(useApp.getState().lives[H].settled).toBe(false);
	onViewChange();
	expect(detaches()).toEqual([G]);
});
