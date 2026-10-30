import "./browser-globals.ts";
import { afterAll, beforeAll, beforeEach, expect, type Mock, spyOn, test } from "bun:test";
import type { LiveAttached } from "../../shared/protocol.ts";
import { socket } from "../../web/src/lib/ws.ts";
import { attachLive, useApp } from "../../web/src/store/app.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * A page that attaches to a paused conversation cannot ask omp which subagents run: omp is frozen and refuses every read.
 * The server tells it the registry omp had when it was frozen, in the reply to the attach (#598), and the Agents tab shows
 * those as running, as a page that was there when the conversation was paused does.
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const scout = {
	id: "Scout",
	agent: "explore",
	index: 0,
	status: "running",
	parentToolCallId: "call_task",
	progress: { id: "Scout", status: "running", toolCount: 3, durationMs: 4000 },
};

const attached = (over: Partial<LiveAttached> = {}): LiveAttached => ({
	liveId: "L9",
	pid: 9,
	cwd: "/work",
	sessionFile: null,
	sessionId: null,
	args: [],
	startedAt: 0,
	streaming: true,
	exited: false,
	subscribers: 1,
	pausedAt: 1000,
	mode: "full",
	...over,
});

let request: Mock<typeof socket.request>;
let rpc: Mock<typeof socket.rpc>;

/** The server's answer to the attach; every read of omp is refused, as a frozen omp's are. */
const attaching = (answer: LiveAttached): void => {
	request.mockImplementation((async (msg: { t: string }) => {
		if (msg.t === "attach") return answer;
		throw new Error("unexpected request");
	}) as typeof socket.request);
	rpc.mockImplementation((async () => {
		throw new Error("The conversation is paused");
	}) as typeof socket.rpc);
};

beforeEach(() => {
	request?.mockRestore();
	rpc?.mockRestore();
	request = spyOn(socket, "request");
	rpc = spyOn(socket, "rpc");
	useApp.setState({ view: { kind: "new" }, lives: {}, finding: {}, toasts: [] });
});

const subagents = () => useApp.getState().lives.L9?.subagents ?? {};

test("the subagents a paused conversation had running when it was frozen are running on a page that attaches to it", async () => {
	attaching(attached({ subagents: [scout] }));
	expect(await attachLive("L9")).toBe(true);
	expect(subagents().Scout).toMatchObject({
		id: "Scout",
		status: "running",
		agent: "explore",
		parentToolCallId: "call_task",
		progress: { toolCount: 3, durationMs: 4000 },
	});
});

test("a paused conversation that had none running shows none, and one that says nothing leaves what the page held", async () => {
	attaching(attached({ subagents: [] }));
	expect(await attachLive("L9")).toBe(true);
	expect(subagents()).toEqual({});

	// The page held Scout as running when the conversation was paused; the server's word about a frozen omp that could
	// not list (no `subagents`) changes nothing.
	attaching(attached({ subagents: [scout] }));
	await attachLive("L9");
	expect(subagents().Scout?.status).toBe("running");
	attaching(attached());
	await attachLive("L9", true);
	expect(subagents().Scout?.status).toBe("running");
});
