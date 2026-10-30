import "./browser-globals.ts";
import { afterAll, beforeAll, beforeEach, expect, type Mock, spyOn, test } from "bun:test";
import type { LiveInfo, SessionEntry } from "../../shared/protocol.ts";
import { socket } from "../../web/src/lib/ws.ts";
import { attachLive, onServer, onViewChange, showLives, useApp } from "../../web/src/store/app.ts";
import { initialLive, type LiveState } from "../../web/src/store/live.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * A page that stays open for days holds every conversation it ever opened: each `open` of the same conversation is a new
 * process with a new id, and omp's own entries of it are tens of megabytes. What a process that has ended leaves behind
 * is what the conversation shows without it (its saved file): the transcript it held is not kept for a process nobody
 * looks at (#357).
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const info = (liveId: string, extra: Partial<LiveInfo> = {}): LiveInfo => ({
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
	...extra,
});

const entry = (id: string, parentId: string | null): SessionEntry => ({
	type: "message",
	id,
	parentId,
	timestamp: "2026-01-05T10:00:00.000Z",
	message: { role: "user", content: [{ type: "text", text: id.repeat(50) }] },
});

/** A conversation that has been worked in for a long time. */
function worked(liveId: string, n = 3000): LiveState {
	const entries = Array.from({ length: n }, (_, i) => entry(`${liveId}-${i}`, i ? `${liveId}-${i - 1}` : null));
	return {
		...initialLive(info(liveId)),
		entries,
		leafId: entries.at(-1)?.id ?? null,
		overlay: [{ messageId: "m1", message: { role: "assistant", content: [] }, ended: true }],
		tools: { t1: { toolCallId: "t1", toolName: "bash", args: {}, done: true, result: "x".repeat(1000), startedAt: 1 } },
		subagents: { Scout: { id: "Scout", status: "completed", updatedAt: 1 } },
		commands: [{ name: "compact", source: "builtin" }],
		statuses: { mcp: "ready" },
		lastError: "the model said no",
		commandOutput: [{ kind: "command", seq: 1, at: 1, after: null, file: `/sessions/${liveId}.jsonl`, text: "ok" }],
	};
}

const heldTranscripts = () => Object.values(useApp.getState().lives).filter((l) => l.entries.length > 0).length;
const exit = (liveId: string) => onServer({ t: "live_exit", liveId, code: 0, stderr: "" });

let rpc: Mock<typeof socket.rpc>;
let post: Mock<typeof socket.post>;
let request: Mock<typeof socket.request>;
beforeEach(() => {
	rpc?.mockRestore();
	post?.mockRestore();
	request?.mockRestore();
	rpc = spyOn(socket, "rpc").mockImplementation((async () => ({ entries: [], leafId: null })) as typeof socket.rpc);
	post = spyOn(socket, "post").mockImplementation(() => {});
	request = spyOn(socket, "request").mockImplementation((async () => []) as typeof socket.request);
	useApp.setState({ view: { kind: "new" }, lives: {}, toasts: [], sessions: [], bash: {} });
});

test("processes that ended while the conversation they ran is not on screen do not keep its transcript", () => {
	const lives: Record<string, LiveState> = {};
	for (let i = 0; i < 10; i++) lives[`L${i}`] = worked(`L${i}`);
	useApp.setState({ lives });
	expect(heldTranscripts()).toBe(10);

	for (let i = 0; i < 10; i++) exit(`L${i}`);

	expect(heldTranscripts()).toBe(0);
	for (const live of Object.values(useApp.getState().lives)) {
		// Everything that is the transcript or built on it is gone ...
		expect(live.entries).toHaveLength(0);
		expect(live.overlay).toEqual([]);
		expect(live.tools).toEqual({});
		expect(live.subagents).toEqual({});
		expect(live.commands).toEqual([]);
		expect(live.statuses).toEqual({});
		expect(live.state).toBeNull();
		// ... and what the page still says of the process (that it ended, how, and what it last failed with) stays.
		expect(live.info.exited).toBe(true);
		expect(live.exited).toEqual({ code: 0, stderr: "", by: "omp" });
		expect(live.lastError).toBe("the model said no");
		expect(live.info.sessionFile).toBe(`/sessions/${live.info.liveId}.jsonl`);
		// What commands printed is kept by file, and is written from here: it must survive.
		expect(live.commandOutput).toHaveLength(1);
	}
});

test("the conversation on screen keeps its transcript when its process ends, until the page moves on", () => {
	useApp.setState({
		lives: { L1: worked("L1"), L2: worked("L2") },
		view: { kind: "chat", file: "/sessions/L1.jsonl", liveId: "L1" },
	});
	exit("L1");
	exit("L2");
	const { lives } = useApp.getState();
	expect(lives.L1.entries).toHaveLength(3000);
	expect(lives.L1.exited).not.toBeNull();
	expect(lives.L2.entries).toHaveLength(0);

	useApp.setState({ view: { kind: "usage" } });
	onViewChange();
	expect(useApp.getState().lives.L1.entries).toHaveLength(0);
	expect(useApp.getState().lives.L1.info.exited).toBe(true);
});

test("a record already let go of is not rebuilt: nothing that reads the store is told again", () => {
	useApp.setState({ lives: { L1: worked("L1") } });
	exit("L1");
	const released = useApp.getState().lives.L1;
	onViewChange();
	exit("L1");
	expect(useApp.getState().lives.L1).toBe(released);
});

test("a process that was reaped while the page was detached and offline is found gone when the server lists its processes", async () => {
	useApp.setState({
		lives: { L1: { ...worked("L1"), settled: true }, L2: { ...worked("L2"), settled: true } },
		view: { kind: "new" },
	});
	// Both are idle and off screen: the page lets go of them (see `maybeDetach`).
	onViewChange();
	expect(post.mock.calls.flatMap(([m]) => (m.t === "detach" ? [m.liveId] : []))).toEqual(["L1", "L2"]);
	// The server closed L1 meanwhile and still holds L2: it lists only what is running.
	request.mockImplementation((async () => [info("L2", { subscribers: 0 })]) as typeof socket.request);
	await showLives();
	const { lives } = useApp.getState();
	expect(lives.L1.info.exited).toBe(true);
	expect(lives.L1.entries).toHaveLength(0);
	expect(lives.L2.info.exited).toBe(false);
	expect(lives.L2.entries).toHaveLength(3000);
});

test("attaching to a process the server no longer has ends it, and lets go of what it held", async () => {
	useApp.setState({ lives: { L1: worked("L1") }, view: { kind: "new" } });
	request.mockRejectedValue(new Error("Live session not found"));
	expect(await attachLive("L1")).toBe(false);
	const live = useApp.getState().lives.L1;
	expect(live.info.exited).toBe(true);
	expect(live.entries).toHaveLength(0);
	// The server does not remember how it ended, so the page does not say: a crash of omp's must not be read as the
	// server's doing (#515).
	expect(live.exited?.by).toBe("unknown");
});

test("attaching to a process the server still knows ends it with the cause it knows", async () => {
	useApp.setState({ lives: { L1: worked("L1") }, view: { kind: "new" } });
	// The server kept the end: the idle reaper closed the process, and nobody was watching it (#515).
	request.mockImplementation((async () => ({
		...info("L1", { exited: true }),
		exit: { code: 0, stderr: "", by: "server", reason: "idle" },
	})) as typeof socket.request);
	expect(await attachLive("L1")).toBe(false);
	expect(useApp.getState().lives.L1.exited).toMatchObject({ by: "server", reason: "idle" });
});

test("a `live` frame that says how a process ended tells this page, which never saw the `live_exit` frame", () => {
	useApp.setState({ lives: { L1: worked("L1") }, view: { kind: "new" } });
	// The reaper closed a process nobody watched: the `live_exit` frame reached no page, but the `live` frame every
	// page is told of says how it ended (#515).
	onServer({
		t: "live",
		info: { ...info("L1", { exited: true }), exit: { code: 0, stderr: "", by: "server", reason: "idle" } },
	});
	expect(useApp.getState().lives.L1.exited).toMatchObject({ by: "server", reason: "idle" });
});

test("a cause the server names later replaces the placeholder of a cause it did not know", () => {
	useApp.setState({ lives: { L1: worked("L1") }, view: { kind: "new" } });
	// The page learns first that the process is gone, and only later what ended it.
	onServer({ t: "live", info: { ...info("L1", { exited: true }) } });
	expect(useApp.getState().lives.L1.exited?.by).toBe("unknown");
	onServer({
		t: "live",
		info: { ...info("L1", { exited: true }), exit: { code: null, signal: "SIGKILL", stderr: "", by: "omp" } },
	});
	expect(useApp.getState().lives.L1.exited).toMatchObject({ by: "omp", signal: "SIGKILL" });
});
