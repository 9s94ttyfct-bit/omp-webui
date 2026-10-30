import "./browser-globals.ts";
import { afterAll, beforeAll, beforeEach, expect, type Mock, spyOn, test } from "bun:test";
import type { LiveInfo } from "../../shared/protocol.ts";
import { socket } from "../../web/src/lib/ws.ts";
import { attachLive, onServer, useApp } from "../../web/src/store/app.ts";
import { initialLive } from "../../web/src/store/live.ts";
import { noteTurnFrame, useTurnClocks } from "../../web/src/store/turn-clock.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * The page times a turn from the frames it sees. After a reconnect it cannot know which turn boundaries it missed,
 * and a process that has gone has no turn: in both cases the clock from before must not go on counting.
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const info: LiveInfo = {
	liveId: "LC1",
	pid: 1,
	cwd: "/",
	sessionFile: "/sessions/a.jsonl",
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
let request: Mock<typeof socket.request>;
beforeEach(() => {
	rpc?.mockRestore();
	request?.mockRestore();
	rpc = spyOn(socket, "rpc").mockImplementation((async () => ({ entries: [], leafId: null })) as typeof socket.rpc);
	request = spyOn(socket, "request").mockImplementation((async () => info) as typeof socket.request);
	useApp.setState({ lives: { LC1: initialLive(info) } });
	useTurnClocks.setState({}, true);
	noteTurnFrame("LC1", { type: "agent_start" }, []);
});

test("a turn is being timed before the page attaches again", () => {
	expect(useTurnClocks.getState().LC1).toBeDefined();
});

test("attaching again forgets the clock: the turn is one the page opened in the middle of", async () => {
	expect(await attachLive("LC1")).toBe(true);
	expect(useTurnClocks.getState().LC1).toBeUndefined();
	// A turn that starts afterwards is timed from its start as usual.
	noteTurnFrame("LC1", { type: "agent_start" }, []);
	expect(useTurnClocks.getState().LC1).toBeDefined();
});

test("a process that exits has no clock", () => {
	onServer({ t: "live_exit", liveId: "LC1", code: 0, stderr: "" });
	expect(useTurnClocks.getState().LC1).toBeUndefined();
});
