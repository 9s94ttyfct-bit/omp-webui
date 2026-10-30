import "./browser-globals.ts";
import { afterAll, afterEach, beforeAll, beforeEach, expect, type Mock, spyOn, test, vi } from "bun:test";
import type { LiveListing } from "../../shared/protocol.ts";
import { socket } from "../../web/src/lib/ws.ts";
import { attachLiveForFile, FIND_MS, findViewedProcess, onServer, useApp } from "../../web/src/store/app.ts";
import { initialLive } from "../../web/src/store/live.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * A page that opens a conversation does not know, until the server has answered, whether a process runs it (#598): a
 * tool call nobody answered is not shown as stopped meanwhile. `finding` says so, from the question until the process
 * it names has been attached, and not a moment longer. The socket is stubbed; nothing here reaches omp.
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

/** The file of the test: one of its own, for the page remembers what the server answered of each file it asked about. */
let FILE = "";
let files = 0;

const listing = (over: Partial<LiveListing> = {}): LiveListing => ({
	liveId: "L9",
	pid: 9,
	cwd: "/work",
	sessionFile: FILE,
	sessionId: null,
	args: [],
	startedAt: 0,
	streaming: true,
	exited: false,
	busy: true,
	holding: "working",
	subscribers: 1,
	pausedAt: null,
	mode: "full",
	...over,
});

let request: Mock<typeof socket.request>;
/** What the page asked the server, in order. */
const asked: string[] = [];
/** Answer the page's requests with `answer`, noting each. */
const answers = (answer: (msg: { t: string }) => Promise<unknown>): void => {
	request.mockImplementation((async (msg: { t: string }) => {
		asked.push(msg.t);
		return answer(msg);
	}) as typeof socket.request);
};

afterEach(() => {
	vi.useRealTimers();
});

beforeEach(() => {
	FILE = `/agent/sessions/work/f${++files}.jsonl`;
	request?.mockRestore();
	asked.length = 0;
	request = spyOn(socket, "request");
	useApp.setState({ view: { kind: "chat", file: FILE, liveId: null }, lives: {}, finding: {}, toasts: [] });
});

const finding = () => useApp.getState().finding[FILE] === true;

test("the page is finding the process from the question to the answer, and a conversation nothing runs is found not to be running", async () => {
	const gate = Promise.withResolvers<LiveListing[]>();
	answers(() => gate.promise);
	const lookup = attachLiveForFile(FILE);
	expect(finding()).toBe(true);
	gate.resolve([listing({ sessionFile: "/agent/sessions/work/another.jsonl" })]);
	await lookup;
	expect(finding()).toBe(false);
	expect(asked).toEqual(["list_lives"]);
	expect(useApp.getState().lives).toEqual({});
});

test("it goes on being found while the process it names is attached, and is over when the attach is", async () => {
	const gate = Promise.withResolvers<never>();
	const attaching = Promise.withResolvers<void>();
	answers(async (msg) => {
		if (msg.t === "list_lives") return [listing()];
		attaching.resolve();
		return gate.promise;
	});
	const lookup = attachLiveForFile(FILE);
	await attaching.promise;
	expect(asked).toEqual(["list_lives", "attach"]);
	expect(finding()).toBe(true);
	// The server no longer has the process by the time it is attached: the page knows the conversation does not run.
	gate.reject(new Error("Live session not found"));
	await lookup;
	expect(finding()).toBe(false);
});

test("a server that does not answer leaves nothing found for good", async () => {
	answers(async () => {
		throw new Error("no answer");
	});
	await attachLiveForFile(FILE);
	expect(finding()).toBe(false);
});

test("a second look at the same file while one is out asks nothing more", async () => {
	const gate = Promise.withResolvers<LiveListing[]>();
	answers(() => gate.promise);
	const first = attachLiveForFile(FILE);
	await attachLiveForFile(FILE);
	expect(asked).toEqual(["list_lives"]);
	expect(finding()).toBe(true);
	gate.resolve([]);
	await first;
	expect(finding()).toBe(false);
});

test("looking for one file does not stop another from being looked for", async () => {
	const gate = Promise.withResolvers<LiveListing[]>();
	answers(() => gate.promise);
	const first = attachLiveForFile(FILE);
	const second = attachLiveForFile("/agent/sessions/work/other.jsonl");
	expect(Object.keys(useApp.getState().finding).sort()).toEqual([FILE, "/agent/sessions/work/other.jsonl"].sort());
	gate.resolve([]);
	await Promise.all([first, second]);
	expect(useApp.getState().finding).toEqual({});
});

test("a page loaded on a conversation does not know about its process from the first picture, and goes on not knowing for as long as it waits for the connection", () => {
	vi.useFakeTimers();
	findViewedProcess();
	expect(finding()).toBe(true);
	vi.advanceTimersByTime(FIND_MS - 1);
	expect(finding()).toBe(true);
	// Nothing came of the wait: the page says what the file says.
	vi.advanceTimersByTime(1);
	expect(finding()).toBe(false);
});

test("a page that is not on a conversation's file has nothing to find out", () => {
	vi.useFakeTimers();
	useApp.setState({ view: { kind: "new" } });
	findViewedProcess();
	expect(useApp.getState().finding).toEqual({});
	useApp.setState({ view: { kind: "chat", file: null, liveId: "L1" } });
	findViewedProcess();
	expect(useApp.getState().finding).toEqual({});
});

test("a lookup that starts when the connection is made is given its own wait, and ends it when the server has answered", async () => {
	vi.useFakeTimers();
	findViewedProcess();
	vi.advanceTimersByTime(FIND_MS + 1);
	expect(finding()).toBe(false);
	const gate = Promise.withResolvers<LiveListing[]>();
	answers(() => gate.promise);
	const lookup = attachLiveForFile(FILE);
	expect(finding()).toBe(true);
	vi.advanceTimersByTime(FIND_MS - 1);
	expect(finding()).toBe(true);
	gate.resolve([]);
	await lookup;
	expect(finding()).toBe(false);
	// The wait of the lookup is over with it: nothing is left to end later.
	vi.advanceTimersByTime(FIND_MS * 2);
	expect(finding()).toBe(false);
});

test("a process the page already holds for the file ends the wait without asking the server", async () => {
	vi.useFakeTimers();
	answers(async () => []);
	useApp.setState({
		lives: { L9: initialLive({ ...listing(), subscribers: 1 }) },
	});
	findViewedProcess();
	expect(finding()).toBe(true);
	await attachLiveForFile(FILE);
	expect(finding()).toBe(false);
	expect(asked).toEqual([]);
});

test("a page that has the server's answer for a file does not stop knowing while it asks again (a reconnect, a view replaced)", async () => {
	answers(async () => []);
	await attachLiveForFile(FILE);
	expect(finding()).toBe(false);
	const gate = Promise.withResolvers<LiveListing[]>();
	answers(() => gate.promise);
	const again = attachLiveForFile(FILE);
	expect(finding()).toBe(false);
	expect(asked).toEqual(["list_lives", "list_lives"]);
	gate.resolve([]);
	await again;
	expect(finding()).toBe(false);
});

test("a failed lookup is no answer: the next one makes the page not know, as the first did", async () => {
	answers(async () => {
		throw new Error("no answer");
	});
	await attachLiveForFile(FILE);
	const gate = Promise.withResolvers<LiveListing[]>();
	answers(() => gate.promise);
	const again = attachLiveForFile(FILE);
	expect(finding()).toBe(true);
	gate.resolve([]);
	await again;
});

test("a process another page starts for a file is listed; showing the conversation listens to it without asking which one runs it", async () => {
	answers(async (msg) => (msg.t === "attach" ? listing() : []));
	await attachLiveForFile(FILE);
	// The page is on another conversation; a page elsewhere starts a turn on this file: the answer the server gave is stale.
	useApp.setState({ view: { kind: "new" } });
	onServer({ t: "live", info: listing() });
	expect(useApp.getState().lives.L9?.info.sessionFile).toBe(FILE);
	asked.length = 0;
	await attachLiveForFile(FILE);
	expect(finding()).toBe(false);
	// It listens to the process it already knows (and reads it); it does not ask the server which one runs the file.
	expect(asked[0]).toBe("attach");
	expect(asked).not.toContain("list_lives");
});
