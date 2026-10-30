import "./browser-globals.ts";
import { afterAll, beforeAll, beforeEach, expect, type Mock, spyOn, test } from "bun:test";
import type { LiveInfo, ServerMessage, SessionEntry, SessionSummary } from "../../shared/protocol.ts";
import { keepDraft, readDraft } from "../../web/src/lib/drafts.ts";
import { noteServerTime, serverOffsetMs } from "../../web/src/lib/server-clock.ts";
import { ReplyError, socket } from "../../web/src/lib/ws.ts";
import {
	answerDialog,
	onServer,
	refreshEntries,
	setApprovalMode,
	useApp,
	viewFromHash,
	viewOfStep,
} from "../../web/src/store/app.ts";
import { initialLive } from "../../web/src/store/live.ts";
import { historyLog, installGlobals, location, restoreGlobals } from "./browser-globals.ts";

/** The app store's reactions to what the server sends and to the address bar. */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const A = "/sessions/a.jsonl";
const B = "/sessions/b.jsonl";
const C = "/sessions/c.jsonl";

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

const entry = (id: string): SessionEntry => ({
	type: "message",
	id,
	parentId: null,
	timestamp: "2026-01-01T00:00:00.000Z",
});

/** omp answers every call with an empty list unless a test says otherwise. */
let rpc: Mock<typeof socket.rpc>;
beforeEach(() => {
	rpc?.mockRestore();
	rpc = spyOn(socket, "rpc").mockImplementation((async () => ({ entries: [], leafId: null })) as typeof socket.rpc);
	historyLog.length = 0;
	location.hash = "";
	useApp.setState({ view: { kind: "new" }, lives: {}, toasts: [], sessions: [] });
});

function open(liveId: string, sessionFile: string | null): void {
	useApp.setState((s) => ({ lives: { ...s.lives, [liveId]: initialLive(info(liveId, sessionFile)) } }));
}

/** Everything already scheduled has run once this resolves (the stubbed calls answer at once). */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

// ------------------------------------------------------------------ entries

test("refreshEntries starts over with the full transcript when omp no longer knows the entry it resumes from", async () => {
	open("L70", A);
	useApp.setState((s) => ({ lives: { ...s.lives, L70: { ...s.lives.L70, entries: [entry("e1")] } } }));
	const calls: Record<string, unknown>[] = [];
	rpc.mockImplementation((async (_liveId: string, command: Record<string, unknown>) => {
		calls.push(command);
		// After a branch omp has no entry "e1" any more.
		if (command.since === "e1") throw new ReplyError("Unknown entry e1", "unknown_since");
		if (command.since) return { entries: [entry("n3")], leafId: "n3" };
		return { entries: [entry("n1"), entry("n2")], leafId: "n2" };
	}) as typeof socket.rpc);

	let first = false;
	void refreshEntries("L70").then(() => {
		first = true;
	});
	await settle();
	expect(first).toBe(true);
	expect(calls).toEqual([{ type: "get_entries", since: "e1" }, { type: "get_entries" }]);
	expect(useApp.getState().lives.L70.entries.map((e) => e.id)).toEqual(["n1", "n2"]);

	// The live is not wedged afterwards: the next refresh resumes from the new last entry.
	let second = false;
	void refreshEntries("L70").then(() => {
		second = true;
	});
	await settle();
	expect(second).toBe(true);
	expect(useApp.getState().lives.L70.entries.map((e) => e.id)).toEqual(["n1", "n2", "n3"]);
});

// ------------------------------------------------------------------ routing

test("a malformed #/s/ hash falls back to the new-chat view instead of throwing", () => {
	location.hash = "#/s/%";
	expect(viewFromHash()).toEqual({ kind: "new" });
	location.hash = "#/cli/%E0%A4%A";
	expect(viewFromHash()).toEqual({ kind: "new" });
});

test("a well-formed #/s/ hash still opens its conversation", () => {
	location.hash = `#/s/${encodeURIComponent("/tmp/a b.jsonl")}`;
	expect(viewFromHash()).toEqual({ kind: "chat", file: "/tmp/a b.jsonl", liveId: null });
});

test("Settings' pages are #/settings/<page>; an unknown page is Settings at the page last shown", () => {
	useApp.getState().setView({ kind: "settings", page: "safety" });
	expect(historyLog).toEqual(["push #/settings/safety"]);
	expect(viewFromHash()).toEqual({ kind: "settings", page: "safety" });
	location.hash = "#/settings/nope";
	expect(viewFromHash()).toEqual({ kind: "settings" });
	location.hash = "#/settings";
	expect(viewFromHash()).toEqual({ kind: "settings" });
});

// A subagent full screen is a route of its own on the conversation's address: reload and Back/Forward keep it.

test("a conversation's subagent full screen is #/s/<file>/agent/<id>, and the address opens it again", () => {
	const file = "/tmp/a b.jsonl";
	const view = { kind: "chat", file, liveId: null, agent: "Features.Quota Pill" } as const;
	useApp.getState().setView(view);
	const hash = `#/s/${encodeURIComponent(file)}/agent/${encodeURIComponent("Features.Quota Pill")}`;
	expect(historyLog).toEqual([`push ${hash}`]);
	expect(viewFromHash()).toEqual(view);
});

test("a conversation that has no file yet has its subagent full screen under its process: #/live/<id>/agent/<id>", () => {
	useApp.getState().setView({ kind: "chat", file: null, liveId: "L9", agent: "Scout" });
	expect(historyLog).toEqual(["push #/live/L9/agent/Scout"]);
	expect(viewFromHash()).toEqual({ kind: "chat", file: null, liveId: "L9", agent: "Scout" });
});

test("leaving the full screen is the conversation's own address again, and an address with no agent names none", () => {
	location.hash = `#/s/${encodeURIComponent(A)}/agent/Scout`;
	expect(viewFromHash()).toMatchObject({ kind: "chat", file: A, agent: "Scout" });
	location.hash = `#/s/${encodeURIComponent(A)}/agent/`;
	expect(viewFromHash()).toEqual({ kind: "chat", file: A, liveId: null });
	location.hash = `#/s/${encodeURIComponent(A)}`;
	expect(viewFromHash()).toEqual({ kind: "chat", file: A, liveId: null });
});

test("a malformed agent in the address falls back to the new-chat view instead of throwing", () => {
	location.hash = `#/s/${encodeURIComponent(A)}/agent/%`;
	expect(viewFromHash()).toEqual({ kind: "new" });
});

test("switching subagents replaces the address, so Back leaves the full screen in one step", () => {
	const st = useApp.getState();
	st.setView({ kind: "chat", file: A, liveId: null });
	st.setView({ kind: "chat", file: A, liveId: null, agent: "One" });
	st.setView({ kind: "chat", file: A, liveId: null, agent: "Two" }, { replace: true });
	const base = `#/s/${encodeURIComponent(A)}`;
	expect(historyLog).toEqual([`push ${base}`, `push ${base}/agent/One`, `replace ${base}/agent/Two`]);
});

test("the full screen stays with its conversation when its process names its first session file", () => {
	open("L1", null);
	useApp.setState({ view: { kind: "chat", file: null, liveId: "L1", agent: "Scout" } });
	onServer(moved("L1", B));
	expect(useApp.getState().view).toEqual({ kind: "chat", file: B, liveId: "L1", agent: "Scout" });
});

test("the full screen ends when its process moves to another session, whose subagents these are not", () => {
	open("L1", A);
	useApp.setState({ view: { kind: "chat", file: A, liveId: "L1", agent: "Scout" } });
	onServer(moved("L1", B));
	const view = useApp.getState().view;
	expect(view).toMatchObject({ kind: "chat", file: B, liveId: "L1", from: A });
	expect(view).not.toHaveProperty("agent");
});

// A step through the history (Back, Forward) shows what the address says, which is only the file and the subagent: stepping
// into or out of a full screen must not rebuild the conversation under it from that.

const shown = { kind: "chat", file: A, liveId: "L1", leaf: "branch-1", focus: "e7", focusAt: 5 } as const;

test("leaving a full screen by Back keeps the conversation as the page shows it, its process, branch and focus", () => {
	const now = { ...shown, agent: "Scout" } as const;
	expect(viewOfStep(now, { kind: "chat", file: A, liveId: null })).toEqual(shown);
});

test("coming back into a full screen by Forward keeps the conversation as it is, and names the subagent of the address", () => {
	expect(viewOfStep(shown, { kind: "chat", file: A, liveId: null, agent: "Scout" })).toEqual({
		...shown,
		agent: "Scout",
	});
});

test("a step between two subagents of the conversation changes the subagent only", () => {
	const now = { ...shown, agent: "One" } as const;
	expect(viewOfStep(now, { kind: "chat", file: A, liveId: null, agent: "Two" })).toEqual({ ...shown, agent: "Two" });
});

test("a step to another conversation or page, or between two views with no full screen, is what the address says", () => {
	const next = { kind: "chat", file: B, liveId: null } as const;
	expect(viewOfStep({ ...shown, agent: "Scout" }, next)).toBe(next);
	expect(viewOfStep(shown, { kind: "chat", file: A, liveId: null })).toEqual({ kind: "chat", file: A, liveId: null });
	const usage = { kind: "usage" } as const;
	expect(viewOfStep({ ...shown, agent: "Scout" }, usage)).toBe(usage);
	expect(viewOfStep(usage, next)).toBe(next);
});

// ------------------------------------------------------------------ a process moving to another session file

const moved = (liveId: string, to: string | null): ServerMessage => ({ t: "live", info: info(liveId, to) });

test("the view follows its process to a new session file when it only names the old file (opened from the sidebar)", () => {
	open("L1", A);
	useApp.setState({ view: { kind: "chat", file: A, liveId: null } });
	onServer(moved("L1", B));
	expect(useApp.getState().view).toEqual({ kind: "chat", file: B, liveId: "L1", from: A });
	// The old address no longer shows the conversation, so it is replaced rather than left in the history.
	expect(historyLog).toEqual([`replace #/s/${encodeURIComponent(B)}`]);
});

test("the view follows its process when it names the process", () => {
	open("L1", A);
	useApp.setState({ view: { kind: "chat", file: null, liveId: "L1" } });
	onServer(moved("L1", B));
	expect(useApp.getState().view).toMatchObject({ kind: "chat", file: B, liveId: "L1" });
});

test("a view that names only its process takes the file the process already had when the page came to hold it (#722)", () => {
	// omp 18.13 names the file as the process starts, before the page's start is answered: no frame changes it after.
	open("L1", A);
	useApp.setState({ view: { kind: "chat", file: null, liveId: "L1" } });
	onServer(moved("L1", A));
	expect(useApp.getState().view).toEqual({ kind: "chat", file: A, liveId: "L1" });
	expect(historyLog).toEqual([`replace #/s/${encodeURIComponent(A)}`]);
});

test("a view of another conversation or page stays put when a process moves", () => {
	for (const view of [
		{ kind: "chat", file: C, liveId: null },
		{ kind: "chat", file: C, liveId: "L2" },
		{ kind: "usage" },
		{ kind: "new" },
	] as const) {
		open("L1", A);
		useApp.setState({ view });
		onServer(moved("L1", B));
		expect(useApp.getState().view).toEqual(view);
	}
	expect(historyLog).toEqual([]);
});

test("a draft kept under a process follows it to its first session file, whichever page is open", () => {
	open("L1", null);
	useApp.setState({ view: { kind: "usage" } });
	keepDraft("L1", { text: "unsent", images: [] });
	onServer(moved("L1", B));
	expect(readDraft("L1")).toBeUndefined();
	expect(readDraft(B)?.text).toBe("unsent");
});

test("the view stays when omp reports no file for the process", () => {
	open("L1", A);
	useApp.setState({ view: { kind: "chat", file: A, liveId: null } });
	onServer(moved("L1", null));
	expect(useApp.getState().view).toEqual({ kind: "chat", file: A, liveId: null });
});

// ------------------------------------------------------------------ dialogs in conversations that are not open

const dialog = (liveId: string, id: string): ServerMessage => ({
	t: "frame",
	liveId,
	frame: { type: "extension_ui_request", method: "confirm", id, title: "Allow bash?", message: "echo hi" },
});

test("a dialog for a conversation that is not open raises a toast that opens it", () => {
	open("L1", A);
	open("L2", B);
	useApp.setState({
		sessions: [
			{ file: A, title: "Background chat", preview: "" },
			{ file: B, title: "Open chat", preview: "" },
		] as SessionSummary[],
		view: { kind: "chat", file: B, liveId: "L2" },
	});
	onServer(dialog("L1", "d1"));

	const { toasts, lives } = useApp.getState();
	expect(lives.L1.needsInput).toBe(true);
	expect(lives.L2.needsInput).toBe(false);
	expect(toasts).toHaveLength(1);
	expect(toasts[0].text).toContain("Background chat");
	expect(toasts[0].action).toBeDefined();

	toasts[0].action?.run();
	expect(useApp.getState().view).toEqual({ kind: "chat", file: A, liveId: "L1" });
});

test("a dialog for the conversation on screen raises no toast", () => {
	open("L1", A);
	useApp.setState({ view: { kind: "chat", file: A, liveId: null } });
	onServer(dialog("L1", "d1"));
	expect(useApp.getState().toasts).toEqual([]);
	expect(useApp.getState().lives.L1.needsInput).toBe(true);
});

test("a dialog the server replays on re-attach does not raise a second toast", () => {
	open("L1", A);
	onServer(dialog("L1", "d1"));
	onServer(dialog("L1", "d1"));
	expect(useApp.getState().toasts).toHaveLength(1);
});

test("answering the last dialog clears the need for input", () => {
	open("L1", A);
	onServer(dialog("L1", "d1"));
	onServer(dialog("L1", "d2"));
	answerDialog("L1", { id: "d1", confirmed: true });
	expect(useApp.getState().lives.L1.needsInput).toBe(true);
	answerDialog("L1", { id: "d2", confirmed: true });
	expect(useApp.getState().lives.L1.needsInput).toBe(false);
});

test("a process that exits no longer needs input", () => {
	open("L1", A);
	onServer(dialog("L1", "d1"));
	onServer({ t: "live_exit", liveId: "L1", code: 0, stderr: "" });
	expect(useApp.getState().lives.L1.needsInput).toBe(false);
	expect(useApp.getState().lives.L1.uiRequests).toEqual([]);
});

test("a process ended by a signal keeps the signal for the page, with no exit code", () => {
	open("L1", A);
	onServer({ t: "live_exit", liveId: "L1", code: null, signal: "SIGKILL", stderr: "" });
	expect(useApp.getState().lives.L1.exited).toEqual({ code: null, signal: "SIGKILL", stderr: "", by: "omp" });
	// One that ended by itself has none.
	open("L2", B);
	onServer({ t: "live_exit", liveId: "L2", code: 3, stderr: "boom" });
	expect(useApp.getState().lives.L2.exited).toEqual({ code: 3, stderr: "boom", by: "omp" });
});

test("a process the server ended says so, and why the server ended it", () => {
	open("L1", A);
	onServer({ t: "live_exit", liveId: "L1", code: 0, stderr: "", by: "server", reason: "idle" });
	expect(useApp.getState().lives.L1.exited).toEqual({ code: 0, stderr: "", by: "server", reason: "idle" });
});

test("a hello gives the page the server's clock: a time the server stamps is read on the page's from then on", () => {
	try {
		// The server's clock is ten minutes ahead of this page's as the connection opens.
		onServer({ t: "hello", ompVersion: "18.12.0", serverVersion: "0.11.0", time: Date.now() + 600_000 });
		expect(Math.abs(serverOffsetMs() - 600_000)).toBeLessThan(1000);
		const startedAt = Date.now() + 600_000;
		const held = {
			...info("L1", A),
			retry: { attempt: 1, maxAttempts: 3, delayMs: 60_000, startedAt, usageLimit: false, resumed: false },
		};
		const wait = initialLive(held).retry;
		// It began just now, as this page's clock has it.
		expect(wait?.phase === "waiting" && Math.abs(wait.startedAt - Date.now()) < 1000).toBe(true);
	} finally {
		noteServerTime(0, 0);
	}
});

// ------------------------------------------------------------------ approval mode

test("the reply to an approval mode change that lands after a resume notes the moment omp ran again (#602)", async () => {
	useApp.setState((s) => ({ lives: { ...s.lives, L90: initialLive({ ...info("L90", A), pausedAt: 5 }) } }));
	// The server resumed the conversation while the change was on its way: the reply says it runs, the announce is yet to come.
	const request = spyOn(socket, "request").mockImplementation((async () => ({
		...info("L90", A),
		approvalMode: "yolo",
		resumedAt: Date.now(),
	})) as typeof socket.request);
	try {
		await setApprovalMode("L90", "yolo");
	} finally {
		request.mockRestore();
	}
	const live = useApp.getState().lives.L90;
	expect(live.info.approvalMode).toBe("yolo");
	expect(live.info.pausedAt).toBeNull();
	expect(live.resumedAt).toBeGreaterThan(0);
});
