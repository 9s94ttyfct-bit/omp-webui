import "./browser-globals.ts";
import { afterAll, beforeAll, beforeEach, expect, type Mock, spyOn, test } from "bun:test";

import type { LiveInfo, OmpFrame } from "../../shared/protocol.ts";
import { socket } from "../../web/src/lib/ws.ts";
import { onServer, refreshState, useApp } from "../../web/src/store/app.ts";
import { initialLive, type RpcState } from "../../web/src/store/live.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * omp's state is big (its system prompt and every tool's schema) and a goal turn produces several frames within
 * milliseconds, so the page reads it once per burst, not once per frame (#389): `goal_updated` says what changed
 * (the goal itself), and reads that overlap are shared by the callers that came after the first.
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

/** A `get_state` omp has not answered yet. */
interface Pending {
	user: boolean;
	answer(s: RpcState): void;
}

let rpc: Mock<typeof socket.rpc>;
let act: Mock<typeof socket.act>;
let pending: Pending[] = [];
let asked = 0;
let L = "";
let seq = 0;

const frame = (f: OmpFrame) => onServer({ t: "frame", liveId: L, frame: f });
/** Everything already scheduled has run once this resolves. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
	rpc?.mockRestore();
	act?.mockRestore();

	pending = [];
	asked = 0;
	const hold = (user: boolean) =>
		new Promise<RpcState>((resolve) => {
			asked++;
			pending.push({ user, answer: resolve });
		});
	rpc = spyOn(socket, "rpc").mockImplementation((async (_id: string, command: Record<string, unknown>) => {
		if (command.type === "get_state") return hold(false);
		if (command.type === "get_entries") return { entries: [], leafId: null };
		return undefined;
	}) as typeof socket.rpc);
	act = spyOn(socket, "act").mockImplementation((async (_id: string, command: Record<string, unknown>) =>
		command.type === "get_state" ? hold(true) : undefined) as typeof socket.act);
	L = `L${++seq}`;
	useApp.setState({ lives: { [L]: initialLive(info(L)) }, view: { kind: "new" } });
});

test("goal_updated frames do not read omp's state: the frame carries the goal", async () => {
	for (let tokens = 1; tokens <= 3; tokens++) {
		frame({ type: "goal_updated", goal: { id: "g", objective: "Do it", status: "active", tokensUsed: tokens } });
	}
	await settle();
	expect(asked).toBe(0);
	expect(useApp.getState().lives[L]?.goal?.tokensUsed).toBe(3);
});

test("a burst of reads while one runs is one more read, asked after the last of them", async () => {
	const first = refreshState(L);
	const second = refreshState(L);
	const third = refreshState(L);
	await settle();
	// Only the first is with omp: the others wait for it and share the read that follows.
	expect(asked).toBe(1);
	pending[0].answer(state({ messageCount: 2 }));
	expect((await first)?.messageCount).toBe(2);
	await settle();
	expect(asked).toBe(2);
	pending[1].answer(state({ messageCount: 6 }));
	// What was asked for during the first read is answered by the one that started after it.
	expect((await second)?.messageCount).toBe(6);
	expect((await third)?.messageCount).toBe(6);
	expect(useApp.getState().lives[L]?.state?.messageCount).toBe(6);
	// Nothing is left over: the next read goes out at once.
	void refreshState(L);
	await settle();
	expect(asked).toBe(3);
});

test("a read the user's action asks for is a user read even when it joins one the page made by itself", async () => {
	void refreshState(L);
	const mine = refreshState(L, true);
	await settle();
	pending[0].answer(state());
	await settle();
	// A paused conversation answers only a user's request: the shared read carries that.
	expect(pending.map((p) => p.user)).toEqual([false, true]);
	pending[1].answer(state({ messageCount: 8 }));
	expect((await mine)?.messageCount).toBe(8);
});

test("a read that fails answers null for everyone who waited on it, and the next one goes out", async () => {
	rpc.mockImplementation((async () => {
		asked++;
		throw new Error("paused");
	}) as typeof socket.rpc);
	const [a, b] = [refreshState(L), refreshState(L)];
	expect(await a).toBeNull();
	expect(await b).toBeNull();
	expect(asked).toBe(2);
	void refreshState(L);
	await settle();
	expect(asked).toBe(3);
});

test("an answer to a read asked during a turn that comes after its end does not bring the turn back, and the next read decides (#680)", async () => {
	frame({ type: "agent_start" });
	const during = refreshState(L);
	await settle();
	// omp ends the turn before the page has the answer, which it took while the turn ran.
	frame({ type: "agent_end", messages: [], isTerminal: true });
	frame({ type: "session_settled" });
	pending[0].answer(state({ isStreaming: true, isSettled: false }));
	await during;
	expect(useApp.getState().lives[L]?.streaming).toBe(false);
	expect(useApp.getState().lives[L]?.settled).toBe(true);
	// A read asked after the end says what omp is now (the frames may have asked for reads of their own: all get the answer).
	let done = false;
	const after = refreshState(L).finally(() => {
		done = true;
	});
	for (let answered = 1; !done; ) {
		await settle();
		while (answered < pending.length) pending[answered++].answer(state({ isStreaming: false, isSettled: true }));
	}
	await after;
	expect(useApp.getState().lives[L]?.streaming).toBe(false);
});

test("an answer with no turn boundary since it was asked shows a turn the page missed the start of (#680)", async () => {
	const started = refreshState(L);
	await settle();
	pending[0].answer(state({ isStreaming: true, isSettled: false }));
	await started;
	expect(useApp.getState().lives[L]?.streaming).toBe(true);
});

test("a turn that starts while a read is on its way is not ended by that read's older answer (#680)", async () => {
	const before = refreshState(L);
	await settle();
	frame({ type: "agent_start" });
	pending[0].answer(state({ isStreaming: false, isSettled: true }));
	await before;
	expect(useApp.getState().lives[L]?.streaming).toBe(true);
	expect(useApp.getState().lives[L]?.settled).toBe(false);
});
