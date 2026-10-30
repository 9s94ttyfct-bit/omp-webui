import "./browser-globals.ts";
import { afterAll, beforeAll, beforeEach, expect, type Mock, spyOn, test } from "bun:test";
import type { LiveAttached } from "../../shared/protocol.ts";
import { socket } from "../../web/src/lib/ws.ts";
import { attachLive, openLive, useApp } from "../../web/src/store/app.ts";
import { applyFrame, type LiveState, type RpcState } from "../../web/src/store/live.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * A page that attaches to a paused conversation cannot ask omp for its state: omp is frozen and refuses every read. The
 * server tells it the settings the session panel shows, as omp had them when it was frozen (#619), and the page keeps
 * them like a state it read: a setting changed meanwhile folds into them, and a state omp does answer replaces them.
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const PANEL = {
	model: { id: "claude-opus-5-5", provider: "anthropic", api: "anthropic-messages", name: "Opus 5.5" },
	steeringMode: "all",
	followUpMode: "one-at-a-time",
	interruptMode: "wait",
	autoCompactionEnabled: false,
	fastModeEnabled: true,
	slowModeSupported: true,
	slowModeEnabled: false,
	slowModeScope: "session",
} as const;

const attached = (over: Partial<LiveAttached> = {}): LiveAttached => ({
	liveId: "L9",
	pid: 9,
	cwd: "/work",
	sessionFile: null,
	sessionId: null,
	args: [],
	startedAt: 0,
	streaming: false,
	exited: false,
	subscribers: 1,
	pausedAt: 1000,
	mode: "full",
	...over,
});

let request: Mock<typeof socket.request>;
let rpc: Mock<typeof socket.rpc>;

/** The server's answer to the attach or open; every read of omp is refused, as a frozen omp's are. */
const attaching = (answer: LiveAttached, refuse = true): void => {
	request.mockImplementation((async (msg: { t: string }) => {
		if (msg.t === "attach" || msg.t === "open") return answer;
		throw new Error("unexpected request");
	}) as typeof socket.request);
	rpc.mockImplementation((async () => {
		throw new Error(refuse ? "The conversation is paused" : "no answer");
	}) as typeof socket.rpc);
};

beforeEach(() => {
	request?.mockRestore();
	rpc?.mockRestore();
	request = spyOn(socket, "request");
	rpc = spyOn(socket, "rpc");
	useApp.setState({ view: { kind: "new" }, lives: {}, finding: {}, toasts: [] });
});

const held = (): LiveState => {
	const live = useApp.getState().lives.L9;
	if (!live) throw new Error("the page holds no L9");
	return live;
};

test("the settings a paused conversation had when it was frozen are what a page that attaches holds as omp's state", async () => {
	attaching(attached({ state: PANEL }));
	expect(await attachLive("L9")).toBe(true);
	expect(held().state).toEqual(PANEL);
	// They are the page's state, not a part of what it says of the process.
	expect(held().info).not.toHaveProperty("state");
});

test("opening a paused conversation holds them too, and a page that held an older state takes the server's over it", async () => {
	attaching(attached());
	await attachLive("L9");
	const lives = useApp.getState().lives;
	useApp.setState({
		lives: {
			...lives,
			L9: {
				...held(),
				state: { steeringMode: "one-at-a-time", fastModeEnabled: false, todoPhases: [{ name: "Build", tasks: [] }] },
			},
		},
	});
	attaching(attached({ state: PANEL }));
	await openLive({ kind: "resume", sessionFile: "/work/s.jsonl" });
	// What the server kept is newer, and what it does not carry (the todo list) stays.
	expect(held().state).toMatchObject({ ...PANEL, todoPhases: [{ name: "Build", tasks: [] }] });
});

test("a conversation that runs, or that says nothing of its state, leaves the page with none of it", async () => {
	attaching(attached({ pausedAt: null }));
	expect(await attachLive("L9")).toBe(true);
	expect(held().state).toBeNull();
	attaching(attached());
	expect(await attachLive("L9", true)).toBe(true);
	expect(held().state).toBeNull();
});

test("a setting changed while the conversation is paused (the server tells every page) shows in what the page holds, and a state omp answers replaces it", async () => {
	attaching(attached({ state: PANEL }));
	await attachLive("L9");
	const frame = { type: "settings_changed", settings: { steeringMode: "one-at-a-time", autoCompactionEnabled: true } };
	expect(applyFrame(held(), frame).state).toMatchObject({
		...PANEL,
		steeringMode: "one-at-a-time",
		autoCompactionEnabled: true,
	});

	// omp runs for the user's action and gives its whole state: that is what the page holds then.
	const whole = {
		...PANEL,
		isStreaming: false,
		isCompacting: false,
		messageCount: 4,
		queuedMessageCount: 0,
	} as RpcState;
	attaching(attached());
	rpc.mockImplementation((async (_id: string, command: { type: string }) => {
		if (command.type === "get_state") return whole;
		throw new Error("The conversation is paused");
	}) as unknown as typeof socket.rpc);
	await attachLive("L9", true);
	expect(held().state).toMatchObject({ messageCount: 4 });
});
