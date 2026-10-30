import "./browser-globals.ts";
import { afterAll, beforeAll, beforeEach, expect, type Mock, spyOn, test } from "bun:test";
import type { LiveInfo, LiveListing } from "../../shared/protocol.ts";
import { socket } from "../../web/src/lib/ws.ts";
import { onConnected, onServer, onViewChange, openLive, useApp } from "../../web/src/store/app.ts";
import { initialLive } from "../../web/src/store/live.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * A page that shows a conversation by its file listens to the process that runs it (#591): when it shows it, when a
 * process starts for it, and when the connection is back; a view that holds a process that is over is pointed at the one
 * that runs the conversation now; one it asked for and no longer shows is let go.
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
	subscribers: 0,
	pausedAt: null,
	mode: "full",
});

/** Everything already scheduled has run once this resolves (the stubbed calls answer at once). */
function settle(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

let request: Mock<typeof socket.request>;
let post: Mock<typeof socket.post>;
/** What the server holds: `list_lives` says it, `attach` replies with the process. */
let held: LiveInfo[];
const sent = (type: string) => request.mock.calls.filter(([m]) => m.t === type).length;

beforeEach(() => {
	request?.mockRestore();
	post?.mockRestore();
	held = [];
	request = spyOn(socket, "request").mockImplementation((async (msg: { t: string; liveId?: string }) => {
		if (msg.t === "list_lives") return held.map((i): LiveListing => ({ ...i, busy: false, holding: null }));
		if (msg.t === "attach") {
			const found = held.find((i) => i.liveId === msg.liveId);
			if (!found) throw new Error("Live session not found");
			return found;
		}
		return undefined;
	}) as typeof socket.request);
	post = spyOn(socket, "post").mockImplementation(() => {});
	spyOn(socket, "rpc").mockImplementation((async (_id: string, command: Record<string, unknown>) =>
		command.type === "get_state"
			? { isStreaming: false, isSettled: true, messageCount: 0, queuedMessageCount: 0 }
			: { entries: [], leafId: null }) as typeof socket.rpc);
	// The session list has loaded and holds none of these files: a process that attaches reads its conversation whole (a page
	// whose list has not loaded waits for it before asking the server for the end, see `store-entries.test.ts`).
	useApp.setState({ view: { kind: "new" }, lives: {}, sessions: [], sessionsLoaded: true });
});

test("showing a conversation by its file attaches the process that runs it", async () => {
	held = [info("L1", A)];
	useApp.setState({ view: { kind: "chat", file: A, liveId: null } });
	onViewChange();
	await settle();
	expect(sent("attach")).toBe(1);
	expect(useApp.getState().lives.L1?.info.sessionFile).toBe(A);
});

test("showing a conversation nothing runs asks the server and attaches nothing", async () => {
	useApp.setState({ view: { kind: "chat", file: A, liveId: null } });
	onViewChange();
	await settle();
	expect(sent("list_lives")).toBe(1);
	expect(sent("attach")).toBe(0);
});

test("a process that starts for the conversation on screen is attached; one for another conversation is listed, not attached", async () => {
	useApp.setState({ view: { kind: "chat", file: A, liveId: null } });
	held = [info("L2", B), info("L3", A)];
	onServer({ t: "live", info: held[0] });
	await settle();
	expect(sent("attach")).toBe(0);
	onServer({ t: "live", info: held[1] });
	await settle();
	expect(sent("attach")).toBe(1);
	expect(Object.keys(useApp.getState().lives).sort()).toEqual(["L2", "L3"]);
});

test("a view that names a process that is running does not go looking for the file's process", async () => {
	held = [info("L4", A)];
	useApp.setState({ view: { kind: "chat", file: A, liveId: "L4" }, lives: { L4: initialLive(info("L4", A)) } });
	onViewChange();
	onServer({ t: "live", info: held[0] });
	await settle();
	expect(sent("list_lives")).toBe(0);
	expect(sent("attach")).toBe(0);
});

test("a view that holds a process that has ended is pointed at the one that now runs the conversation", async () => {
	held = [info("L6", A)];
	useApp.setState({
		view: { kind: "chat", file: A, liveId: "L-ended", leaf: "e1" },
		lives: { "L-ended": initialLive({ ...info("L-ended", A), exited: true }) },
	});
	onViewChange();
	await settle();
	await settle();
	expect(useApp.getState().view).toEqual({ kind: "chat", file: A, liveId: "L6", leaf: "e1" });
	// It is the one on screen now: the page keeps listening to it.
	expect(post).not.toHaveBeenCalledWith({ t: "detach", liveId: "L6" });
});

test("a connection that comes back attaches the process of the conversation on screen, which started while the page was away", async () => {
	held = [info("L7", A)];
	useApp.setState({ view: { kind: "chat", file: A, liveId: null } });
	onConnected();
	await settle();
	expect(sent("attach")).toBe(1);
	expect(useApp.getState().lives.L7?.info.sessionFile).toBe(A);
});

test("a connection that comes back finds the process that took over from the one the page showed, which ended while it was away", async () => {
	// The page shows the conversation through P; P ended and another page resumed it as Q while the connection was out.
	held = [info("Q1", A)];
	useApp.setState({ view: { kind: "chat", file: A, liveId: "P1" }, lives: { P1: initialLive(info("P1", A)) } });
	onConnected();
	await settle();
	await settle();
	expect(useApp.getState().lives.P1?.info.exited).toBe(true);
	expect(useApp.getState().lives.Q1?.info.sessionFile).toBe(A);
	expect(useApp.getState().view).toEqual({ kind: "chat", file: A, liveId: "Q1" });
});

test("a view that holds a process that has ended is pointed at the one another page resumed the conversation with, which this page only listed", async () => {
	const ended = { ...initialLive(info("L1", A)), info: { ...info("L1", A), exited: true } };
	useApp.setState({ view: { kind: "chat", file: B, liveId: null }, lives: { L1: ended } });
	held = [info("P", A)];
	onServer({ t: "live", info: held[0] });
	expect(sent("attach")).toBe(0);
	useApp.setState({ view: { kind: "chat", file: A, liveId: "L1" } });
	onViewChange();
	await settle();
	expect(sent("attach")).toBe(1);
	const view = useApp.getState().view;
	expect(view.kind === "chat" && view.liveId).toBe("P");
});

test("a process asked for and no longer shown by the time it answers is let go once it has nothing going on", async () => {
	held = [info("L5", A)];
	useApp.setState({ view: { kind: "chat", file: A, liveId: null } });
	onViewChange();
	// The page moves on before the server has answered.
	useApp.setState({ view: { kind: "chat", file: B, liveId: null } });
	await settle();
	await settle();
	expect(sent("attach")).toBe(1);
	expect(post).toHaveBeenCalledWith({ t: "detach", liveId: "L5" });
});

/** The page's own open of a conversation answers with a `live` frame first: that one is not a process to go and find (#591). Only for the file it opens (#602). */
test("a process that starts for the conversation on screen is attached while the page opens another conversation", async () => {
	useApp.setState({ view: { kind: "chat", file: A, liveId: null } });
	held = [info("L8", A)];
	const answer = Promise.withResolvers<LiveInfo>();
	request.mockImplementation((async (msg: { t: string; liveId?: string }) => {
		if (msg.t === "open") return answer.promise;
		if (msg.t === "attach") return held.find((i) => i.liveId === msg.liveId);
		return [];
	}) as typeof socket.request);
	const opened = openLive({ kind: "resume", sessionFile: B });
	onServer({ t: "live", info: held[0] });
	await settle();
	expect(sent("attach")).toBe(1);
	expect(useApp.getState().lives.L8?.info.sessionFile).toBe(A);
	answer.resolve(info("L9", B));
	await opened;
});

test("a process that starts for the conversation the page is opening is left to the open", async () => {
	useApp.setState({ view: { kind: "chat", file: A, liveId: null } });
	held = [info("L10", A)];
	const answer = Promise.withResolvers<LiveInfo>();
	request.mockImplementation((async (msg: { t: string }) =>
		msg.t === "open" ? answer.promise : []) as typeof socket.request);
	const opened = openLive({ kind: "resume", sessionFile: A });
	onServer({ t: "live", info: held[0] });
	await settle();
	expect(sent("attach")).toBe(0);
	answer.resolve(held[0]);
	await opened;
	// Once the open is over, a frame for the file is a process to attach again.
	useApp.setState({ lives: {} });
	onServer({ t: "live", info: info("L11", A) });
	await settle();
	expect(sent("attach")).toBe(1);
});
