import "./browser-globals.ts";
import { afterAll, beforeAll, beforeEach, expect, type Mock, spyOn, test } from "bun:test";
import type { LiveInfo } from "../../shared/protocol.ts";
import { slimAnswer } from "../../shared/slim.ts";
import { socket } from "../../web/src/lib/ws.ts";
import { onServer, refreshState, useApp } from "../../web/src/store/app.ts";
import { initialLive } from "../../web/src/store/live.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * A routine state read carries the whole system prompt and every tool's schema — tens of KB over the connection and
 * parsed on the browser's main thread — for a page that reads neither of them: it wants the tool names alone, to know
 * whether an interview is under way (#467). The read is therefore slim: the client asks for it, and the server strips
 * what the page does not read. A consumer that reads a tool's schema (the guided goal's contract tests) asks without
 * `slim` and gets the whole answer.
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const info = (liveId: string): LiveInfo => ({
	liveId,
	pid: 1,
	cwd: "/",
	sessionFile: null,
	sessionId: null,
	args: [],
	startedAt: 0,
	streaming: false,
	exited: false,
	subscribers: 1,
	pausedAt: null,
	mode: "full",
});

/** What omp answers to `get_state`: the whole prompt, and every tool with its schema. */
const fullState = () => ({
	isStreaming: false,
	isCompacting: false,
	steeringMode: "one-at-a-time",
	followUpMode: "one-at-a-time",
	interruptMode: "immediate",
	messageCount: 4,
	queuedMessageCount: 0,
	thinkingLevel: "high",
	systemPrompt: ["RFC 2119 keywords: MUST, SHOULD.", "You are omp's trusted coding assistant."],
	dumpTools: [
		{
			name: "read",
			description: "Read a file.",
			parameters: { type: "object", properties: { path: { type: "string" } } },
		},
		{
			name: "propose_goal",
			description: "Propose a goal.",
			parameters: { type: "object", properties: { objective: {} } },
		},
	],
});

let rpc: Mock<typeof socket.rpc>;
let act: Mock<typeof socket.act>;
/** The `slim` flag of every read that went out, in order. */
let slimFlags: (boolean | undefined)[] = [];
let L = "";
let seq = 0;

beforeEach(() => {
	rpc?.mockRestore();
	act?.mockRestore();
	slimFlags = [];
	rpc = spyOn(socket, "rpc").mockImplementation((async (
		_id: string,
		_command: Record<string, unknown>,
		slim?: boolean,
	) => {
		slimFlags.push(slim);
		return fullState();
	}) as typeof socket.rpc);
	act = spyOn(socket, "act").mockImplementation((async (
		_id: string,
		_command: Record<string, unknown>,
		slim?: boolean,
	) => {
		slimFlags.push(slim);
		return fullState();
	}) as typeof socket.act);
	L = `L${++seq}`;
	useApp.setState({ lives: { [L]: initialLive(info(L)) }, view: { kind: "new" } });
});

test("the page's own state read is slim: it asks for the answer without the prompt and the schemas", async () => {
	await refreshState(L);
	expect(slimFlags).toEqual([true]);
	// A read that follows something the user did is slim as well.
	await refreshState(L, true);
	expect(slimFlags).toEqual([true, true]);
});

test("what the server strips is what the page does not read: the prompt goes, the tool names stay", () => {
	const slim = slimAnswer(fullState()) as Record<string, unknown>;
	expect(slim.systemPrompt).toBeUndefined();
	expect(slim.dumpTools).toEqual([{ name: "read" }, { name: "propose_goal" }]);
	// Everything else is the answer omp gave.
	expect(slim.messageCount).toBe(4);
	expect(slim.thinkingLevel).toBe("high");
});

test("the whole answer is still there for a consumer that reads it: only a slim one is stripped", () => {
	const whole = fullState();
	expect(slimAnswer(whole)).not.toBe(whole);
	// A consumer that asks without `slim` gets omp's answer as it is: the schemas are in it.
	const schemas = (whole.dumpTools as { parameters?: unknown }[]).map((t) => t.parameters);
	expect(schemas.every((s) => s !== undefined)).toBe(true);
});

test("an answer that is not a state is left as it is", () => {
	expect(slimAnswer(null)).toBeNull();
	expect(slimAnswer([1, 2])).toEqual([1, 2]);
	expect(slimAnswer("text")).toBe("text");
	// A state without tools keeps everything else.
	expect(slimAnswer({ messageCount: 2 })).toEqual({ messageCount: 2 });
	// A tool that cannot be named is kept whole rather than lost.
	const odd = slimAnswer({ dumpTools: [{ description: "no name" }] }) as { dumpTools: unknown[] };
	expect(odd.dumpTools).toEqual([{ description: "no name" }]);
});

test("the page can still tell an interview is under way from the names alone", async () => {
	// What the page reads of the tools: the name of the goal tool (see `lib/goal.ts`).
	await refreshState(L);
	const held = useApp.getState().lives[L]?.state;
	expect(held?.dumpTools?.some((t) => t.name === "propose_goal")).toBe(true);
});

test("a frame of the conversation does not change what the read asks for", async () => {
	onServer({
		t: "frame",
		liveId: L,
		frame: { type: "goal_updated", goal: { id: "g", objective: "Do it", status: "active" } },
	});
	await refreshState(L);
	expect(slimFlags).toEqual([true]);
});
