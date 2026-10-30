import "./browser-globals.ts";
import { afterAll, beforeAll, beforeEach, expect, type Mock, spyOn, test } from "bun:test";
import type { LiveInfo, LiveListing } from "../../shared/protocol.ts";
import { askingCount, attentionChanges } from "../../web/src/lib/attention.ts";
import { socket } from "../../web/src/lib/ws.ts";
import { attachLive, onServer, onViewChange, showLives, useApp } from "../../web/src/store/app.ts";
import { applyAttached, applyFrame, initialLive, type RpcState, withUiRequests } from "../../web/src/store/live.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/** What a process that said nothing of what the server keeps (a compaction, status lines, `!commands`) holds. */
const nothingHeld = { compacting: false, statuses: [], widgets: [], bashes: [] };

/**
 * A page lists the conversations another page runs with the dot they have (#592): it holds nothing of such a process, and
 * what it does reaches the page only in the `live` frame every page is told of, so the page goes by that: running, waiting
 * for an answer, open, with a toast and a count in the tab's title for a dialog nobody here looks at. And a setting
 * another page changed, which omp announces nothing about, is folded into what this page shows of the state (#593).
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const A = "/sessions/a.jsonl";
const B = "/sessions/b.jsonl";
const C = "/sessions/c.jsonl";

const info = (liveId: string, sessionFile: string | null, over: Partial<LiveInfo> = {}): LiveInfo => ({
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
	...over,
});

function settle(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

let request: Mock<typeof socket.request>;
let rpc: Mock<typeof socket.rpc>;
/** What the server holds: `list_lives` says it, `attach` replies with the process. */
let held: LiveInfo[];
const sent = (type: string) => request.mock.calls.filter(([m]) => m.t === type).length;
const toasts = () => useApp.getState().toasts.map((t) => t.text);
const live = (id: string) => useApp.getState().lives[id];

beforeEach(() => {
	request?.mockRestore();
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
	spyOn(socket, "post").mockImplementation(() => {});
	rpc = spyOn(socket, "rpc");
	rpc.mockClear();
	rpc.mockImplementation((async (_id: string, command: Record<string, unknown>) =>
		command.type === "get_state"
			? { isStreaming: false, isSettled: true, messageCount: 0, queuedMessageCount: 0 }
			: { entries: [], leafId: null }) as typeof socket.rpc);
	// The session list has loaded and holds none of these files: an attach reads the conversation whole rather than waiting
	// for a list that is never coming (see `listHolds`), which for a page that loads no list is `LIST_WAIT_MS` each.
	useApp.setState({
		view: { kind: "chat", file: A, liveId: null },
		lives: {},
		sessions: [],
		sessionsLoaded: true,
		toasts: [],
		finding: {},
	});
});

test("a process another page starts for a conversation this page does not show is listed, running, and nothing of it is read", async () => {
	onServer({ t: "live", info: info("L2", B, { streaming: true }) });
	await settle();
	expect(live("L2")?.streaming).toBe(true);
	expect(live("L2")?.entries).toEqual([]);
	expect(sent("attach")).toBe(0);
	expect(sent("list_lives")).toBe(0);
});

test("what the server says of the process as it changes is what the page lists: running, open, running again, gone", async () => {
	onServer({ t: "live", info: info("L2", B, { streaming: true }) });
	expect(live("L2")?.streaming).toBe(true);
	onServer({ t: "live", info: info("L2", B, { streaming: false }) });
	expect(live("L2")?.streaming).toBe(false);
	onServer({ t: "live", info: info("L2", B, { streaming: true }) });
	expect(live("L2")?.streaming).toBe(true);
	onServer({ t: "live", info: info("L2", B, { exited: true }) });
	expect(live("L2")?.info.exited).toBe(true);
	expect(live("L2")?.streaming).toBe(false);
});

test("a goal's run between two turns is listed as running, not as open for the moment between them", async () => {
	onServer({ t: "live", info: info("L2", B, { streaming: true }) });
	onServer({ t: "live", info: info("L2", B, { streaming: false, continuing: true }) });
	expect(live("L2")?.streaming).toBe(false);
	expect(live("L2")?.continuing).toBe(true);
	onServer({ t: "live", info: info("L2", B, { streaming: false }) });
	expect(live("L2")?.continuing).toBe(false);
});

test("a dialog that opens on a process another page runs counts in the tab's title and says so in a toast, once", async () => {
	onServer({ t: "live", info: info("L2", B, { streaming: true }) });
	expect(askingCount(useApp.getState().lives)).toBe(0);
	const before = useApp.getState().lives;
	onServer({ t: "live", info: info("L2", B, { streaming: true, asking: true }) });
	expect(live("L2")?.needsInput).toBe(true);
	expect(askingCount(useApp.getState().lives)).toBe(1);
	expect(attentionChanges(before, useApp.getState().lives).asking).toEqual(["L2"]);
	expect(toasts()).toHaveLength(1);
	// The server says it again (a page attached, a setting changed): nothing new.
	onServer({ t: "live", info: info("L2", B, { streaming: true, asking: true, subscribers: 1 }) });
	expect(toasts()).toHaveLength(1);
	// Answered on the other page.
	onServer({ t: "live", info: info("L2", B, { streaming: true }) });
	expect(live("L2")?.needsInput).toBe(false);
	expect(askingCount(useApp.getState().lives)).toBe(0);
});

test("a dialog on the conversation this page shows is not a toast: the page listens to that process and shows the dialog", async () => {
	held = [info("L3", A, { asking: true })];
	onServer({ t: "live", info: held[0] });
	await settle();
	expect(sent("attach")).toBe(1);
	expect(toasts()).toEqual([]);
});

test("the same word of the server again is no news of the work: what the page knows of a process stands", () => {
	onServer({ t: "live", info: info("L2", B) });
	onServer({ t: "frame", liveId: "L2", frame: { type: "agent_start" } });
	expect(live("L2")?.streaming).toBe(true);
	// A page attached and a setting changed: the announcement says the same of the work as before.
	onServer({ t: "live", info: info("L2", B, { subscribers: 1 }) });
	expect(live("L2")?.streaming).toBe(true);
});

test("the end of a turn another page ran is a finished turn here too, for the title's mark and the notification", async () => {
	onServer({ t: "live", info: info("L2", B, { streaming: true }) });
	const before = useApp.getState().lives;
	onServer({ t: "live", info: info("L2", B, { streaming: false }) });
	expect(attentionChanges(before, useApp.getState().lives).finished).toEqual(["L2"]);
});

test("a page that was away asks the server for the processes when it connects, and lists the ones that work or wait", async () => {
	held = [
		info("L2", B, { streaming: true }),
		info("L4", C, { asking: true }),
		info("L5", "/sessions/d.jsonl"),
		info("L6", null, { streaming: true }),
		info("L7", A, { streaming: true }),
	];
	await showLives();
	expect(live("L2")?.streaming).toBe(true);
	expect(live("L4")?.needsInput).toBe(true);
	// Idle is listed too (open); a process with no conversation file has nothing to list; the one of the conversation on
	// screen is looked for by `attachLiveForFile`, which reads it too.
	expect(live("L5")?.streaming).toBe(false);
	expect(live("L6")).toBeUndefined();
	expect(live("L7")).toBeUndefined();
	expect(sent("attach")).toBe(0);
});

test("what happened to a listed process while the page was disconnected is listed when it connects again", async () => {
	onServer({ t: "live", info: info("L2", B, { streaming: true }) });
	held = [info("L2", B, { streaming: false, asking: true })];
	await showLives();
	expect(live("L2")?.streaming).toBe(false);
	expect(live("L2")?.needsInput).toBe(true);
	// One that ended meanwhile is found out.
	held = [];
	await showLives();
	expect(live("L2")?.info.exited).toBe(true);
});

test("showing a listed conversation listens to its process and reads it; what the page was told it waits for is what the dialogs say", async () => {
	onServer({ t: "live", info: info("L2", B, { streaming: true, asking: true }) });
	held = [info("L2", B, { streaming: true, asking: true })];
	useApp.setState({ view: { kind: "chat", file: B, liveId: null } });
	onViewChange();
	await settle();
	expect(sent("attach")).toBe(1);
	// The dialog was answered between the announcement and the attach: the server lists none.
	onServer({ t: "attached", liveId: "L2", dialogs: [], message: null, held: nothingHeld });
	expect(live("L2")?.needsInput).toBe(false);
	expect(live("L2")?.uiRequests).toEqual([]);
});

test("a process the page opened and let go of is listed by the server's word too", async () => {
	held = [info("L2", B, { streaming: false })];
	await attachLive("L2");
	// Idle and off screen: the page lets it go.
	useApp.setState({ view: { kind: "chat", file: C, liveId: null } });
	onViewChange();
	await settle();
	onServer({ t: "live", info: info("L2", B, { streaming: true }) });
	expect(live("L2")?.streaming).toBe(true);
});

test("applying what the server says of the dialogs leaves a process that listens to none alone, and corrects one that was listed as asking", () => {
	const listed = withUiRequests(initialLive(info("L2", B)), []);
	expect(applyAttached(listed, [], null, nothingHeld)).toBe(listed);
	expect(applyAttached({ ...listed, needsInput: true }, [], null, nothingHeld).needsInput).toBe(false);
});

test("a setting another page changed is folded into the state this page holds, and into none it does not hold yet", () => {
	const state = { steeringMode: "one-at-a-time", autoCompactionEnabled: true } as unknown as RpcState;
	const shown = { ...initialLive(info("L2", B)), state };
	const next = applyFrame(shown, { type: "settings_changed", settings: { steeringMode: "all" } });
	expect(next.state as unknown).toEqual({ steeringMode: "all", autoCompactionEnabled: true });
	expect(
		applyFrame(initialLive(info("L2", B)), { type: "settings_changed", settings: { steeringMode: "all" } }).state,
	).toBeNull();
});

test("the thinking level another page chose is the one this page shows", () => {
	const shown = initialLive(info("L2", B));
	expect(applyFrame(shown, { type: "thinking_level_changed", thinkingLevel: "low" }).thinking).toBe("low");
	expect(
		applyFrame(shown, { type: "thinking_level_changed", thinkingLevel: "auto", configured: "auto" }).thinking,
	).toBe("auto");
});

test("a paused conversation that is asking is listed as asking, and stays so when another page resumes it, read of nothing", async () => {
	held = [info("L2", B, { pausedAt: 5, asking: true })];
	await showLives();
	expect(live("L2")?.needsInput).toBe(true);
	expect(askingCount(useApp.getState().lives)).toBe(1);
	onServer({ t: "live", info: info("L2", B, { asking: true }) });
	expect(live("L2")?.needsInput).toBe(true);
	expect(rpc).not.toHaveBeenCalled();
});

test("a process the page only lists that moves to another session file is read of nothing: showing it reads it", async () => {
	onServer({ t: "live", info: info("L2", B, { streaming: true, sessionId: "s1" }) });
	onServer({ t: "live", info: info("L2", C, { streaming: true, sessionId: "s2" }) });
	await settle();
	expect(live("L2")?.info.sessionFile).toBe(C);
	expect(live("L2")?.streaming).toBe(true);
	expect(rpc).not.toHaveBeenCalled();
	expect(sent("attach")).toBe(0);
});
