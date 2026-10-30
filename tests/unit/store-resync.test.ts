import "./browser-globals.ts";
import { afterAll, beforeAll, beforeEach, expect, type Mock, spyOn, test } from "bun:test";
import type { LiveInfo, OmpFrame } from "../../shared/protocol.ts";
import { blocks } from "../../web/src/lib/messages.ts";
import { socket } from "../../web/src/lib/ws.ts";
import { attachLive, onServer, useApp } from "../../web/src/store/app.ts";
import { initialLive } from "../../web/src/store/live.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * A page that attaches again (a reload, a second tab, a reconnect, coming back to a conversation) holds what it heard
 * before it was away, and the server then replays what it holds for it: the dialogs that still wait and the message in
 * flight, and says that is all (`attached`). What the page still holds beyond that was settled while it was away: a
 * dialog answered in another tab (#362), a half-written message that ended or whose start was never seen (#363).
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const info: LiveInfo = {
	liveId: "L1",
	pid: 1,
	cwd: "/",
	sessionFile: "/x/resync.jsonl",
	sessionId: "s",
	args: [],
	startedAt: 0,
	streaming: false,
	exited: false,
	subscribers: 1,
	pausedAt: null,
	mode: "full",
};

const frame = (f: OmpFrame) => onServer({ t: "frame", liveId: "L1", frame: f });
const attached = (dialogs: string[], message: string | null) =>
	onServer({
		t: "attached",
		liveId: "L1",
		dialogs,
		message,
		held: { compacting: false, statuses: [], widgets: [], bashes: [] },
	});
const live = () => useApp.getState().lives.L1;

const dialog = (id: string): OmpFrame => ({
	type: "extension_ui_request",
	method: "confirm",
	id,
	title: "Allow bash?",
	message: "echo hi",
});

const start = (messageId: string): OmpFrame => ({
	type: "message_start",
	messageId,
	message: { role: "assistant", content: [], timestamp: 5 },
});
const delta = (messageId: string, type: string, extra: Record<string, unknown> = {}): OmpFrame => ({
	type: "message_update",
	messageId,
	message: { role: "assistant" },
	assistantMessageEvent: { type, contentIndex: 0, ...extra },
});
const words = (messageId: string) => {
	const message = live().overlay.find((o) => o.messageId === messageId)?.message;
	return message ? blocks(message).map((b) => b.text) : undefined;
};

let rpc: Mock<typeof socket.rpc>;
let request: Mock<typeof socket.request>;
beforeEach(() => {
	rpc?.mockRestore();
	request?.mockRestore();
	rpc = spyOn(socket, "rpc").mockImplementation((async () => ({ entries: [], leafId: null })) as typeof socket.rpc);
	request = spyOn(socket, "request").mockImplementation((async () => info) as typeof socket.request);
	// The page shows another conversation. The session list has loaded and holds none of these files: an attach reads the
	// conversation whole rather than waiting for a list that is never coming (see `listHolds`, `LIST_WAIT_MS`).
	useApp.setState({
		lives: { L1: initialLive(info) },
		view: { kind: "new" },
		toasts: [],
		sessions: [],
		sessionsLoaded: true,
	});
});

test("a dialog that was settled while the page was away is gone once the server says what still waits", async () => {
	frame(dialog("d1"));
	expect(live().needsInput).toBe(true);
	// The page attaches again: the server replays nothing, because nothing waits any more.
	await attachLive("L1");
	attached([], null);
	expect(live().uiRequests).toEqual([]);
	expect(live().needsInput).toBe(false);
});

test("a dialog that still waits stays, and one that came while the page was away is shown, without a second toast for the first", async () => {
	frame(dialog("d1"));
	frame(dialog("d2"));
	expect(useApp.getState().toasts).toHaveLength(2);
	await attachLive("L1");
	// d2 was answered meanwhile; d1 is replayed, and d3 was raised meanwhile.
	frame(dialog("d1"));
	frame(dialog("d3"));
	attached(["d1", "d3"], null);
	expect(live().uiRequests.map((r) => r.id)).toEqual(["d1", "d3"]);
	expect(live().needsInput).toBe(true);
	// Only d3 is news: the page did not drop d1 and ask for it again.
	expect(useApp.getState().toasts).toHaveLength(3);
});

test("a message whose increments were missed is shown whole once the server replays the message in flight", async () => {
	frame(start("m1"));
	frame(delta("m1", "text_start"));
	frame(delta("m1", "text_delta", { delta: "The quick " }));
	// "brown fox " was sent while the connection was down.
	frame(delta("m1", "text_delta", { delta: "over the dog" }));
	expect(words("m1")).toEqual(["The quick over the dog"]);

	await attachLive("L1");
	// What the server replays: the start of the message, and its increments of the block as one.
	frame(start("m1"));
	frame(delta("m1", "text_start"));
	frame(delta("m1", "text_delta", { delta: "The quick brown fox over the dog" }));
	attached([], "m1");
	expect(words("m1")).toEqual(["The quick brown fox over the dog"]);
	// And it goes on from there.
	frame(delta("m1", "text_delta", { delta: " lazy" }));
	expect(words("m1")).toEqual(["The quick brown fox over the dog lazy"]);
});

test("a half-written message that ended while the page was away is not left under the transcript", () => {
	frame(start("m1"));
	frame(delta("m1", "text_delta", { delta: "Half of" }));
	// A message that did end stays until the entries have caught up with it.
	frame({
		type: "message_end",
		messageId: "m0",
		message: { role: "assistant", content: [{ type: "text", text: "done" }] },
	});
	expect(live().overlay.map((o) => [o.messageId, o.ended])).toEqual([
		["m1", false],
		["m0", true],
	]);
	attached([], null);
	expect(live().overlay.map((o) => o.messageId)).toEqual(["m0"]);
});

test("a message whose start the page never saw, and whose end it misses, is not kept: the page starts from the server's replay", async () => {
	// The page attached in the middle of the block: its overlay message is built from the increments alone.
	frame(delta("m7", "text_delta", { delta: "over the dog" }));
	expect(words("m7")).toEqual(["over the dog"]);
	await attachLive("L1");
	frame(start("m7"));
	frame(delta("m7", "text_delta", { delta: "The quick brown fox over the dog" }));
	attached([], "m7");
	expect(words("m7")).toEqual(["The quick brown fox over the dog"]);
	// It ended while the page was away again: nothing of it is held.
	attached([], null);
	expect(live().overlay).toEqual([]);
});
