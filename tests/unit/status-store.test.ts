import "./browser-globals.ts";
import { afterAll, beforeAll, beforeEach, expect, type Mock, spyOn, test } from "bun:test";
import type { LiveInfo, OmpFrame } from "../../shared/protocol.ts";
import { noticeToast } from "../../web/src/lib/notice.ts";
import { socket } from "../../web/src/lib/ws.ts";
import { onServer, useApp } from "../../web/src/store/app.ts";
import { initialLive } from "../../web/src/store/live.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/** What omp's `notice` frames and the todo tool do to the page (TUI parity). */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const info: LiveInfo = {
	liveId: "S1",
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
};

let rpc: Mock<typeof socket.rpc>;
const asked = () => rpc.mock.calls.map(([, command]) => String(command.type));
beforeEach(() => {
	rpc?.mockRestore();
	rpc = spyOn(socket, "rpc").mockImplementation((async () => ({ entries: [], leafId: null })) as typeof socket.rpc);
	useApp.setState({ lives: { S1: initialLive(info) }, toasts: [] });
});

const frame = (f: OmpFrame) => onServer({ t: "frame", liveId: "S1", frame: f });
const toasts = () => useApp.getState().toasts.map((t) => ({ level: t.level, text: t.text }));

test("info notices are shown like warnings and errors, worded with their source as the TUI words them", () => {
	frame({
		type: "notice",
		level: "info",
		message: "Claude session limit reset — low priority ended.",
		source: "usage",
	});
	frame({ type: "notice", level: "warning", message: "Low priority ended: the weekly Claude limit is reached." });
	frame({ type: "notice", level: "error", message: "disk full", source: "session-persistence" });
	expect(toasts()).toEqual([
		{ level: "info", text: "usage: Claude session limit reset — low priority ended." },
		{ level: "warning", text: "Low priority ended: the weekly Claude limit is reached." },
		{ level: "error", text: "session-persistence: disk full" },
	]);
});

test("omp's list of the tools it mounted is not a toast, an empty notice is none, and an unknown level reads as info", () => {
	frame({ type: "notice", level: "info", message: "xd://: mounted mcp__a_x, mcp__a_y", source: "xdev" });
	frame({ type: "notice", level: "info", message: "   " });
	frame({ type: "notice", level: "info" });
	expect(toasts()).toEqual([]);
	expect(noticeToast({ type: "notice", level: "debug", message: "hello" })).toEqual({ level: "info", text: "hello" });
	// Only the bookkeeping is left out: the same source with a problem to report is shown.
	expect(noticeToast({ type: "notice", level: "warning", message: "could not mount", source: "xdev" })).toEqual({
		level: "warning",
		text: "xdev: could not mount",
	});
});

test("a todo tool call that ends makes the page ask for the list again; other tools do not", async () => {
	frame({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: {} });
	await Promise.resolve();
	expect(asked()).not.toContain("get_state");
	frame({ type: "tool_execution_end", toolCallId: "t2", toolName: "todo", result: {} });
	await Promise.resolve();
	expect(asked()).toContain("get_state");
});

test("the list omp cleared, and a slash command's output, make the page read the state again", async () => {
	frame({ type: "todo_auto_clear" });
	// One read at a time: the next event's read goes out once this one has been answered.
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(asked().filter((type) => type === "get_state")).toHaveLength(1);
	frame({ type: "command_output", text: "Fast mode enabled" });
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(asked().filter((type) => type === "get_state")).toHaveLength(2);
});
