import "./browser-globals.ts";
import { afterAll, beforeAll, beforeEach, expect, type Mock, spyOn, test } from "bun:test";
import { bashEnded, bashStarted } from "../../shared/held-state.ts";
import type { LiveInfo } from "../../shared/protocol.ts";
import { socket } from "../../web/src/lib/ws.ts";
import { onServer, runBash, useApp } from "../../web/src/store/app.ts";
import { initialLive } from "../../web/src/store/live.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * User `!commands` the process is running: one entry each, from the moment the server says it runs (`bash_started`, to every
 * page that listens to the process, the one that sent it too) until it says omp answered (`bash_ended`) — so that the page
 * that did not send one shows it and its Stop as the page that did (#587).
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const info: LiveInfo = {
	liveId: "L1",
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

interface Outcome {
	exitCode?: number;
	cancelled?: boolean;
}
/** The reply to one `bash` command, still to come: omp answers when the command exits. */
interface PendingReply {
	promise: Promise<Outcome>;
	resolve(outcome: Outcome): void;
	reject(error: Error): void;
}
/** The pending reply of each `bash` command, by its command line. */
let replies: Map<string, PendingReply>;
let rpc: Mock<typeof socket.rpc>;

beforeEach(() => {
	rpc?.mockRestore();
	replies = new Map();
	rpc = spyOn(socket, "rpc").mockImplementation(((_liveId: string, command: Record<string, unknown>) => {
		if (command.type !== "bash") return Promise.resolve({ entries: [], leafId: null });
		const reply = Promise.withResolvers<Outcome>();
		replies.set(String(command.command), reply);
		return reply.promise;
	}) as typeof socket.rpc);
	useApp.setState({ lives: { L1: initialLive(info) }, bash: {}, toasts: [] });
});

const settle = () => {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
};
const commands = () => (useApp.getState().bash.L1 ?? []).map((r) => r.command);
const said = (frame: ReturnType<typeof bashStarted>) => onServer({ t: "frame", liveId: "L1", frame });

test("commands the server says run are listed in the order it said so, each leaving when it says omp answered it", () => {
	said(bashStarted({ id: "bash-1", command: "sleep 4", startedAt: Date.now() }));
	said(bashStarted({ id: "bash-2", command: "echo second", startedAt: Date.now() }));
	expect(commands()).toEqual(["sleep 4", "echo second"]);
	expect(useApp.getState().bash.L1.every((r) => r.startedAt > 0)).toBe(true);

	said(bashEnded("bash-2"));
	expect(commands()).toEqual(["sleep 4"]);

	said(bashEnded("bash-1"));
	expect(useApp.getState().bash.L1).toBeUndefined();
});

test("a page that did not send the command lists it too, and the one that sent it lists it once, however often the server says it", () => {
	runBash("L1", "make");
	// Nothing is listed on the sender's say: the server's word is what lists it, for every page alike.
	expect(commands()).toEqual([]);
	const run = { id: "bash-1", command: "make", startedAt: Date.now() };
	said(bashStarted(run));
	said(bashStarted(run));
	expect(commands()).toEqual(["make"]);
});

test("the same command line twice is two entries, not one", () => {
	said(bashStarted({ id: "bash-1", command: "make", startedAt: Date.now() }));
	said(bashStarted({ id: "bash-2", command: "make", startedAt: Date.now() }));
	expect(commands()).toEqual(["make", "make"]);
	const ids = useApp.getState().bash.L1.map((r) => r.id);
	expect(new Set(ids).size).toBe(2);
});

test("a page that attaches to a process that runs commands holds exactly the ones the server names", () => {
	said(bashStarted({ id: "bash-1", command: "gone while away", startedAt: Date.now() }));
	said(bashStarted({ id: "bash-2", command: "still running", startedAt: Date.now() }));
	onServer({
		t: "attached",
		liveId: "L1",
		dialogs: [],
		message: null,
		held: { compacting: false, statuses: [], widgets: [], bashes: ["bash-2"] },
	});
	expect(commands()).toEqual(["still running"]);
});

test("a process that ends takes the commands it was running with it", () => {
	said(bashStarted({ id: "bash-1", command: "sleep 4", startedAt: Date.now() }));
	onServer({ t: "live_exit", liveId: "L1", code: 0, stderr: "", by: "omp" });
	expect(useApp.getState().bash.L1).toBeUndefined();
});

test("a command omp answers with a failing exit says so, and one that fails to run says why", async () => {
	runBash("L1", "false");
	replies.get("false")?.resolve({ exitCode: 1 });
	await settle();
	runBash("L1", "boom");
	replies.get("boom")?.reject(new Error("This conversation is paused; resume it to continue."));
	await settle();
	expect(useApp.getState().toasts.map((t) => t.text)).toEqual([
		"Command exited with 1",
		"This conversation is paused; resume it to continue.",
	]);
});
