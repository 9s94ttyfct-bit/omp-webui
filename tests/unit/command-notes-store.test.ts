import "./browser-globals.ts";
import { afterAll, beforeAll, beforeEach, expect, type Mock, spyOn, test } from "bun:test";
import type { LiveInfo } from "../../shared/protocol.ts";
import { loadCommandNotes, saveCommandNotes } from "../../web/src/lib/command-notes.ts";
import type { CommandNote } from "../../web/src/lib/notices.ts";
import { socket } from "../../web/src/lib/ws.ts";
import { attachLive, onServer, useApp } from "../../web/src/store/app.ts";
import { initialLive } from "../../web/src/store/live.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/** What commands printed, in the app store: seeded for a process the page has not seen, and tied to the file once there is one. */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const FILE = "/sessions/seeded.jsonl";

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

let request: Mock<typeof socket.request>;
let rpc: Mock<typeof socket.rpc>;
beforeEach(() => {
	request?.mockRestore();
	rpc?.mockRestore();
	rpc = spyOn(socket, "rpc").mockImplementation((async () => ({ entries: [], leafId: null })) as typeof socket.rpc);
	useApp.setState({ view: { kind: "new" }, lives: {}, toasts: [], sessions: [] });
});

test("a process the page has not seen shows what its conversation's commands printed before", async () => {
	const kept: CommandNote = { kind: "command", seq: 1, at: 5, after: "e1", file: FILE, text: "Context window: 11%" };
	saveCommandNotes(FILE, [kept]);
	request = spyOn(socket, "request").mockImplementation((async () => info("L-seed", FILE)) as typeof socket.request);
	expect(await attachLive("L-seed")).toBe(true);
	expect(useApp.getState().lives["L-seed"].commandOutput).toEqual(loadCommandNotes(FILE));
	expect(useApp.getState().lives["L-seed"].commandOutput).toEqual([kept]);
});

test("a process the page already knows keeps what it has: a reattach does not read the file's notes again", async () => {
	const own: CommandNote = { kind: "command", seq: 1, at: 9, after: null, file: FILE, text: "printed just now" };
	useApp.setState({ lives: { "L-known": { ...initialLive(info("L-known", FILE)), commandOutput: [own] } } });
	saveCommandNotes(FILE, [{ ...own, text: "kept earlier" }]);
	request = spyOn(socket, "request").mockImplementation((async () => info("L-known", FILE)) as typeof socket.request);
	await attachLive("L-known");
	expect(useApp.getState().lives["L-known"].commandOutput).toEqual([own]);
});

test("what a command printed before the conversation had a file belongs to the file once it has one, and only then", () => {
	useApp.setState({ lives: { "L-new": initialLive(info("L-new", null)) } });
	onServer({ t: "frame", liveId: "L-new", frame: { type: "command_output", text: "before the first message" } });
	expect(useApp.getState().lives["L-new"].commandOutput).toMatchObject([{ after: null, file: null }]);

	onServer({ t: "live", info: info("L-new", FILE) });
	const [note] = useApp.getState().lives["L-new"].commandOutput;
	expect(note).toMatchObject({ text: "before the first message", file: FILE });

	// A conversation that moves on to another file (a branch) leaves what was printed in the first with the first.
	onServer({ t: "live", info: info("L-new", "/sessions/branch.jsonl") });
	expect(useApp.getState().lives["L-new"].commandOutput[0].file).toBe(FILE);
});
