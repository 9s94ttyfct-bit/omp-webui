import "./browser-globals.ts";
import { afterAll, beforeAll, beforeEach, expect, type Mock, spyOn, test } from "bun:test";
import type { LiveInfo, SessionEntry } from "../../shared/protocol.ts";
import { socket } from "../../web/src/lib/ws.ts";
import { noteSavedEntries, refreshEntries, useApp } from "../../web/src/store/app.ts";
import { initialLive, leaveSession } from "../../web/src/store/live.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * Read-only plan mode as the page knows it. omp 18.12 tells RPC clients nothing of it: `get_state` has no field for it and
 * there is no command to enter or leave it. A process started with `--plan-yolo` is in it from the start, and leaves it
 * when the model's plan is approved, which omp records as a hidden `plan-yolo-handoff` entry (see the contract test
 * tests/contract/plan-mode.test.ts, which pins that against the installed omp).
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const FILE = "/x/s.jsonl";
const info = (args: string[], file = FILE): LiveInfo => ({
	liveId: "L1",
	pid: 1,
	cwd: "/",
	sessionFile: file,
	sessionId: "s",
	args,
	startedAt: 0,
	streaming: false,
	exited: false,
	subscribers: 1,
	pausedAt: null,
	mode: "full",
});
const custom = (id: string, parentId: string | null, customType: string): SessionEntry => ({
	type: "custom_message",
	id,
	parentId,
	timestamp: "2026-01-05T10:00:00.000Z",
	customType,
	display: false,
	content: "hidden",
});
const user = (id: string, parentId: string | null): SessionEntry => ({
	type: "message",
	id,
	parentId,
	timestamp: "2026-01-05T10:00:00.000Z",
	message: { role: "user", content: [{ type: "text", text: id }] },
});

let omp: SessionEntry[];
let rpc: Mock<typeof socket.rpc>;

beforeEach(() => {
	rpc?.mockRestore();
	omp = [];
	// omp's side of `get_entries`: what it holds, from `since` on.
	rpc = spyOn(socket, "rpc").mockImplementation((async (_liveId: string, command: Record<string, unknown>) => {
		const from = command.since ? omp.findIndex((e) => e.id === command.since) + 1 : 0;
		return { entries: omp.slice(from), leafId: omp.at(-1)?.id ?? null };
	}) as typeof socket.rpc);
});

const start = (args: string[], file = FILE) => useApp.setState({ lives: { L1: initialLive(info(args, file)) } });
const planMode = () => useApp.getState().lives.L1.planMode;

test("a process started with --plan-yolo is in plan mode from the start, before any message", () => {
	start(["--plan-yolo", "--plan-yolo-into=anthropic/claude-haiku-5-5"]);
	expect(planMode()).toBe(true);
});

test("a process started without --plan-yolo is not, whatever else it was started with", () => {
	start(["--model=anthropic/claude-haiku-5-5", "--thinking=high"]);
	expect(planMode()).toBe(false);
});

test("it lasts through the turns of the plan, and ends with the hidden handoff entry", async () => {
	start(["--plan-yolo"]);
	omp = [custom("a", null, "plan-mode-context"), user("b", "a")];
	await refreshEntries("L1");
	expect(planMode()).toBe(true);

	// Other hidden entries are no end to it.
	omp.push(custom("c", "b", "system-prompt-digest"));
	await refreshEntries("L1");
	expect(planMode()).toBe(true);

	omp.push(custom("d", "c", "plan-yolo-handoff"));
	await refreshEntries("L1");
	expect(planMode()).toBe(false);

	// The work that follows does not bring it back.
	omp.push(user("e", "d"));
	await refreshEntries("L1");
	expect(planMode()).toBe(false);
});

test("a page that attaches after the handoff reads it from the whole conversation", async () => {
	start(["--plan-yolo"]);
	omp = [custom("a", null, "plan-mode-context"), custom("b", "a", "plan-yolo-handoff"), user("c", "b")];
	await refreshEntries("L1", true);
	expect(planMode()).toBe(false);
});

test("a handoff the page already held, from the file it fetched, ends it too: omp has nothing newer to send", async () => {
	// Its own file: what a page fetched of a file is remembered for the whole run (`noteSavedEntries`).
	start(["--plan-yolo"], "/x/held.jsonl");
	omp = [custom("a", null, "plan-mode-context"), custom("b", "a", "plan-yolo-handoff")];
	noteSavedEntries("/x/held.jsonl", omp);
	await refreshEntries("L1");
	expect(planMode()).toBe(false);
});

test("plan mode is the process's, not the session's: /new before the plan is approved keeps it, and the new session's entries do not end it", async () => {
	start(["--plan-yolo"]);
	omp = [custom("a", null, "plan-mode-context"), user("b", "a")];
	await refreshEntries("L1");
	// omp's /new: the page forgets the old session and reads the new one whole.
	useApp.setState((st) => ({ lives: { L1: leaveSession(st.lives.L1) } }));
	expect(planMode()).toBe(true);
	omp = [custom("n1", null, "plan-mode-context"), user("n2", "n1")];
	await refreshEntries("L1", true);
	expect(planMode()).toBe(true);
	// The plan of the new session is approved.
	omp.push(custom("n3", "n2", "plan-yolo-handoff"));
	await refreshEntries("L1");
	expect(planMode()).toBe(false);
});

test("after the plan is approved a new session is not in plan mode either", async () => {
	start(["--plan-yolo"]);
	omp = [custom("a", null, "plan-mode-context"), custom("b", "a", "plan-yolo-handoff")];
	await refreshEntries("L1");
	useApp.setState((st) => ({ lives: { L1: leaveSession(st.lives.L1) } }));
	omp = [user("n1", null)];
	await refreshEntries("L1", true);
	expect(planMode()).toBe(false);
});
