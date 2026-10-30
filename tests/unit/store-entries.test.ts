import "./browser-globals.ts";
import { afterAll, beforeAll, beforeEach, expect, type Mock, spyOn, test } from "bun:test";
import type { LiveInfo, SessionEntry, SessionSummary } from "../../shared/protocol.ts";
import type { Answer } from "../../web/src/lib/answer.ts";
import { api } from "../../web/src/lib/api.ts";
import { ReplyError, socket } from "../../web/src/lib/ws.ts";
import {
	attachLive,
	noteSavedEntries,
	onServer,
	refreshEntries,
	resubscribe,
	useApp,
} from "../../web/src/store/app.ts";
import { initialLive } from "../../web/src/store/live.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * What the page asks omp for to keep a conversation's entries: a long conversation is tens of megabytes, a goal run
 * appends to it several times a second, and every change of `entries` is work for every part of the page that reads
 * them. So: a refresh asks for what is new and nothing more, calls that arrive while one runs share the next, a
 * refresh that brings nothing changes nothing, and a conversation the page already holds is not fetched whole again.
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const FILE = "/x/s.jsonl";
const info: LiveInfo = {
	liveId: "L1",
	pid: 1,
	cwd: "/",
	sessionFile: FILE,
	sessionId: "s",
	args: [],
	startedAt: 0,
	streaming: false,
	exited: false,
	subscribers: 1,
	pausedAt: null,
	mode: "full",
};
const entry = (id: string, parentId: string | null): SessionEntry => ({
	type: "message",
	id,
	parentId,
	timestamp: "2026-01-05T10:00:00.000Z",
	message: { role: "user", content: [{ type: "text", text: id }] },
});

/** The commands the page sent, and the replies it still waits for (settle them by hand to order what happens). */
let sent: Record<string, unknown>[];
let waiting: ((reply: unknown) => void)[];
let rpc: Mock<typeof socket.rpc>;
let answer: (command: Record<string, unknown>) => unknown;

beforeEach(() => {
	rpc?.mockRestore();
	sent = [];
	waiting = [];
	answer = () => ({ entries: [], leafId: null });
	rpc = spyOn(socket, "rpc").mockImplementation(((_liveId: string, command: Record<string, unknown>) => {
		sent.push(command);
		const reply = Promise.withResolvers<unknown>();
		waiting.push(() => reply.resolve(answer(command)));
		return reply.promise;
	}) as typeof socket.rpc);
	// The session list has loaded and holds none of these files: a process that attaches to a conversation the page holds none
	// of reads it whole, as these tests say (the page that waits for its list to ask for the end first is the tests below).
	useApp.setState({ lives: { L1: initialLive(info) }, sessions: [], sessionsLoaded: true });
});

const settle = () => {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
};
/** Answer everything the page is waiting for now, and whatever it asks next, until it asks no more. */
async function drain(): Promise<void> {
	for (let i = 0; i < 20; i++) {
		await settle();
		const now = waiting.splice(0);
		if (!now.length) return;
		for (const reply of now) reply(undefined);
	}
}
const entriesCalls = () => sent.filter((c) => c.type === "get_entries");
const ids = () => useApp.getState().lives.L1.entries.map((e) => e.id);

test("refreshes asked for while one is running are one more pull, not one each", async () => {
	useApp.setState({ lives: { L1: { ...initialLive(info), entries: [entry("a", null)] } } });
	const first = refreshEntries("L1");
	const rest = [refreshEntries("L1"), refreshEntries("L1"), refreshEntries("L1"), refreshEntries("L1")];
	await drain();
	await Promise.all([first, ...rest]);
	expect(entriesCalls()).toHaveLength(2);
});

test("every caller still gets an answer no older than its asking", async () => {
	useApp.setState({ lives: { L1: { ...initialLive(info), entries: [entry("a", null)] } } });
	// omp's side: the entries it has, answered from `since` on.
	const omp = [entry("a", null)];
	answer = (c) => ({ entries: omp.slice(omp.findIndex((e) => e.id === c.since) + 1), leafId: omp.at(-1)?.id ?? null });
	const first = refreshEntries("L1");
	await settle();
	// An entry is written after the first pull was asked: the caller that asked for it after that must see it.
	omp.push(entry("b", "a"));
	const late = refreshEntries("L1");
	waiting.shift()?.(undefined);
	await first;
	await settle();
	for (const reply of waiting.splice(0)) reply(undefined);
	await late;
	expect(ids()).toEqual(["a", "b"]);
});

test("a pull that brings nothing leaves the conversation's state as it was", async () => {
	useApp.setState({ lives: { L1: { ...initialLive(info), entries: [entry("a", null)], leafId: "a" } } });
	const before = useApp.getState();
	answer = () => ({ entries: [], leafId: "a" });
	const done = refreshEntries("L1");
	await drain();
	await done;
	const after = useApp.getState();
	expect(after).toBe(before);
	expect(after.lives.L1.entries).toBe(before.lives.L1.entries);
});

test("a pull that brings entries adds them after what the page has", async () => {
	useApp.setState({ lives: { L1: { ...initialLive(info), entries: [entry("a", null)], leafId: "a" } } });
	answer = (c) => (c.since === "a" ? { entries: [entry("b", "a")], leafId: "b" } : { entries: [], leafId: "a" });
	const done = refreshEntries("L1");
	await drain();
	await done;
	expect(ids()).toEqual(["a", "b"]);
	expect(useApp.getState().lives.L1.leafId).toBe("b");
});

/** The `retryRecovery` omp wrote on an entry's message, if it did. */
function recoveryOf(e: SessionEntry | undefined): unknown {
	const m = e?.message;
	return typeof m === "object" && m !== null && "retryRecovery" in m ? m.retryRecovery : undefined;
}

/** What a page that was away holds, and what omp holds by now: a failed turn a retry got past, marked in place. */
const recovery = {
	kind: "auto-retry",
	status: "recovered",
	attempt: 1,
	recovery: "wait",
	note: "rate-limited; waited",
};
const failed = (extra: Record<string, unknown> = {}): SessionEntry => ({
	...entry("a1", "u1"),
	message: { role: "assistant", content: [], stopReason: "error", errorMessage: "usage limit", ...extra },
});
const retried = (): SessionEntry => ({
	...entry("a2", "a1"),
	message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
});

test("attaching again reads everything omp holds: an entry omp rewrote while the page was away is shown as omp has it", async () => {
	const away = [entry("u1", null), failed()];
	useApp.setState({ lives: { L1: { ...initialLive(info), entries: away, leafId: "a1" } } });
	// omp, as measured on 18.12.2: the retry succeeded, `a1` was rewritten in place, `a2` came after it.
	const omp = [entry("u1", null), failed({ retryRecovery: recovery }), retried()];
	answer = (c) => {
		const from = typeof c.since === "string" ? omp.findIndex((e) => e.id === c.since) + 1 : 0;
		return { entries: omp.slice(from), leafId: "a2" };
	};
	const attached = spyOn(socket, "request").mockResolvedValue(info);
	const done = attachLive("L1");
	await drain();
	await done;
	attached.mockRestore();
	// `since: "a1"` would have brought `a2` alone and left the failure as the page last saw it.
	expect(entriesCalls()).toEqual([{ type: "get_entries" }]);
	const shown = useApp.getState().lives.L1.entries;
	expect(shown.map((e) => e.id)).toEqual(["u1", "a1", "a2"]);
	expect(recoveryOf(shown[1])).toEqual(recovery);
	expect(useApp.getState().lives.L1.leafId).toBe("a2");
});

test("a refresh while the page is attached still asks only for what came after (frames keep it current)", async () => {
	useApp.setState({
		lives: { L1: { ...initialLive(info), entries: [entry("a", null), entry("b", "a")], leafId: "b" } },
	});
	const done = refreshEntries("L1");
	await drain();
	await done;
	expect(entriesCalls()).toEqual([{ type: "get_entries", since: "b" }]);
});

test("a conversation the page already fetched over HTTP is continued from its last entry, not fetched whole over the socket", async () => {
	const saved = [entry("a", null), entry("b", "a"), entry("c", "b")];
	noteSavedEntries(FILE, saved);
	answer = (c) => (c.since === "c" ? { entries: [entry("d", "c")], leafId: "d" } : { entries: [], leafId: null });
	const attached = spyOn(socket, "request").mockResolvedValue(info);
	const done = attachLive("L1");
	await drain();
	await done;
	attached.mockRestore();
	expect(entriesCalls()).toEqual([{ type: "get_entries", since: "c" }]);
	expect(ids()).toEqual(["a", "b", "c", "d"]);
	// The same entry objects: the page does not hold the conversation twice.
	expect(useApp.getState().lives.L1.entries[0]).toBe(saved[0]);
});

/** The list's row for a conversation file: the page asks the server for the file's end only when the list holds the file. */
const row = (file: string) => ({ file }) as SessionSummary;
/** What the server answers for the end of `file`: the entries of its last window. */
const endOf = (file: string, entries: SessionEntry[]) =>
	({
		file,
		members: [{ file, header: null, entries, subagents: [], advisors: [] }],
		view: {
			kind: "tail",
			leaf: entries.at(-1)?.id ?? null,
			head: entries.at(-1)?.id ?? null,
			earlier: true,
			later: false,
			versions: [],
		},
	}) as Answer;

test("a process that attaches to a conversation the page holds none of, which the list holds, continues from its end", async () => {
	useApp.setState({ sessions: [row("/x/seed-held.jsonl")], sessionsLoaded: true });
	const asked = spyOn(api, "history").mockResolvedValue(
		endOf("/x/seed-held.jsonl", [entry("a", null), entry("b", "a")]),
	);
	answer = (c) => (c.since === "b" ? { entries: [entry("c", "b")], leafId: "c" } : { entries: [], leafId: null });
	const attached = spyOn(socket, "request").mockResolvedValue({ ...info, sessionFile: "/x/seed-held.jsonl" });
	useApp.setState({ lives: { L1: initialLive({ ...info, sessionFile: "/x/seed-held.jsonl" }) } });
	const done = attachLive("L1");
	await drain();
	await done;
	attached.mockRestore();
	expect(asked).toHaveBeenCalledTimes(1);
	expect(asked.mock.calls[0]).toEqual(["/x/seed-held.jsonl", { kind: "tail" }]);
	asked.mockRestore();
	// Not the whole conversation over the socket: the process says what came after the end the page was given.
	expect(entriesCalls()).toEqual([{ type: "get_entries", since: "b" }]);
	expect(ids()).toEqual(["a", "b", "c"]);
});

test("a page whose list has not loaded yet waits for it before it asks for the end, and asks when the list holds the file", async () => {
	useApp.setState({ sessions: [], sessionsLoaded: false });
	const asked = spyOn(api, "history").mockResolvedValue(endOf("/x/seed-wait.jsonl", [entry("a", null)]));
	answer = (c) => (c.since === "a" ? { entries: [entry("b", "a")], leafId: "b" } : { entries: [], leafId: null });
	const attached = spyOn(socket, "request").mockResolvedValue({ ...info, sessionFile: "/x/seed-wait.jsonl" });
	useApp.setState({ lives: { L1: initialLive({ ...info, sessionFile: "/x/seed-wait.jsonl" }) } });
	const done = attachLive("L1");
	await settle();
	expect(asked).not.toHaveBeenCalled();
	useApp.setState({ sessions: [row("/x/seed-wait.jsonl")], sessionsLoaded: true });
	await drain();
	await done;
	attached.mockRestore();
	expect(asked).toHaveBeenCalledTimes(1);
	asked.mockRestore();
	expect(entriesCalls()).toEqual([{ type: "get_entries", since: "a" }]);
	expect(ids()).toEqual(["a", "b"]);
});

test("a file the loaded list does not hold (a new chat omp has not written) is not asked for: the process is asked for everything", async () => {
	useApp.setState({ sessions: [row("/x/other.jsonl")], sessionsLoaded: true });
	const asked = spyOn(api, "history").mockRejectedValue(new Error("404"));
	answer = () => ({ entries: [entry("a", null)], leafId: "a" });
	const attached = spyOn(socket, "request").mockResolvedValue({ ...info, sessionFile: "/x/seed-new.jsonl" });
	useApp.setState({ lives: { L1: initialLive({ ...info, sessionFile: "/x/seed-new.jsonl" }) } });
	const done = attachLive("L1");
	await drain();
	await done;
	attached.mockRestore();
	expect(asked).not.toHaveBeenCalled();
	asked.mockRestore();
	expect(entriesCalls()).toEqual([{ type: "get_entries" }]);
});

test("when the server cannot answer for the end, the process is asked for everything, as before", async () => {
	useApp.setState({ sessions: [row("/x/seed-down.jsonl")], sessionsLoaded: true });
	const asked = spyOn(api, "history").mockRejectedValue(new Error("down"));
	answer = () => ({ entries: [entry("a", null)], leafId: "a" });
	const attached = spyOn(socket, "request").mockResolvedValue({ ...info, sessionFile: "/x/seed-down.jsonl" });
	useApp.setState({ lives: { L1: initialLive({ ...info, sessionFile: "/x/seed-down.jsonl" }) } });
	const done = attachLive("L1");
	await drain();
	await done;
	attached.mockRestore();
	asked.mockRestore();
	expect(entriesCalls()).toEqual([{ type: "get_entries" }]);
	expect(ids()).toEqual(["a"]);
});

test("when omp does not know the entry the page continues from, the page asks for everything", async () => {
	noteSavedEntries(FILE, [entry("gone", null)]);
	answer = (c) => {
		if (c.since === "gone") throw new ReplyError("unknown", "unknown_since");
		return { entries: [entry("a", null)], leafId: "a" };
	};
	rpc.mockImplementation(((_liveId: string, command: Record<string, unknown>) => {
		sent.push(command);
		try {
			return Promise.resolve(answer(command));
		} catch (e) {
			return Promise.reject(e);
		}
	}) as typeof socket.rpc);
	const attached = spyOn(socket, "request").mockResolvedValue(info);
	await attachLive("L1");
	attached.mockRestore();
	expect(entriesCalls()).toEqual([{ type: "get_entries", since: "gone" }, { type: "get_entries" }]);
	expect(ids()).toEqual(["a"]);
});

// ------------------------------------------------------------------ what a page that was away has to read again (#360)

/** omp's side: the entries it has, answered from `since` on. */
function ompHolding(held: SessionEntry[]) {
	answer = (c) => {
		const from = typeof c.since === "string" ? held.findIndex((e) => e.id === c.since) + 1 : 0;
		return { entries: held.slice(from), leafId: held.at(-1)?.id ?? null };
	};
}

const REV_FILE = "/x/revision.jsonl";
/** The process as the server describes it when the page attaches: `revision` says whether anything of it could have been rewritten since. */
const at = (revision: number | undefined): LiveInfo => ({ ...info, sessionFile: REV_FILE, revision });

async function attach(revision: number | undefined): Promise<void> {
	const attached = spyOn(socket, "request").mockResolvedValue(at(revision));
	const done = attachLive("L1");
	await drain();
	await done;
	attached.mockRestore();
}

test("a page that attaches again finds the revision it last saw: it reads only what came after its last entry", async () => {
	useApp.setState({ lives: { L1: initialLive(at(5)) } });
	const omp = [entry("a", null), entry("b", "a")];
	ompHolding(omp);
	await attach(5);
	expect(ids()).toEqual(["a", "b"]);
	const held = useApp.getState().lives.L1.entries;
	sent.length = 0;

	// The page leaves (detach), omp appends an entry meanwhile, the page comes back: nothing could have been rewritten.
	omp.push(entry("c", "b"));
	await attach(5);
	expect(entriesCalls()).toEqual([{ type: "get_entries", since: "b" }]);
	expect(ids()).toEqual(["a", "b", "c"]);
	// The entries it already had are the same objects, so what is derived from them stays valid (see lib/lineage.ts).
	expect(useApp.getState().lives.L1.entries[0]).toBe(held[0]);
});

test("a page that attaches again finds another revision: it reads everything omp holds", async () => {
	useApp.setState({ lives: { L1: initialLive(at(5)) } });
	const omp = [entry("a", null), failed()];
	ompHolding(omp);
	await attach(5);
	sent.length = 0;

	// While the page was away omp got a failure past with a retry: it rewrote the entry in place, and the revision moved.
	omp[1] = failed({ retryRecovery: recovery });
	omp.push(retried());
	await attach(6);
	expect(entriesCalls()).toEqual([{ type: "get_entries" }]);
	const shown = useApp.getState().lives.L1.entries;
	expect(shown.map((e) => e.id)).toEqual(["a", "a1", "a2"]);
	expect(recoveryOf(shown[1])).toEqual(recovery);

	// And the page knows the new revision from then on.
	sent.length = 0;
	await attach(6);
	expect(entriesCalls()).toEqual([{ type: "get_entries", since: "a2" }]);
});

test("a server that does not say what the revision is leaves nothing to compare: the page reads everything", async () => {
	useApp.setState({ lives: { L1: initialLive(at(undefined)) } });
	ompHolding([entry("a", null)]);
	await attach(undefined);
	sent.length = 0;
	await attach(undefined);
	expect(entriesCalls()).toEqual([{ type: "get_entries" }]);
});

/** The connection is back: the page attaches again to what it was listening to, and the server describes the process as `revision`. */
async function reconnect(revision: number): Promise<void> {
	const attached = spyOn(socket, "request").mockResolvedValue(at(revision));
	resubscribe();
	await drain();
	attached.mockRestore();
}

test("a page whose connection was lost reads everything omp holds even at the revision it last saw: a rewrite nothing announced is shown", async () => {
	useApp.setState({ lives: { L1: initialLive(at(5)) } });
	const omp = [entry("u1", null), failed()];
	ompHolding(omp);
	await attach(5);
	sent.length = 0;

	// The connection is down while omp gets a failure past with a retry and marks the entry in place. The revision the
	// server describes is the one the page saw: `since` its last entry would never bring the entry again.
	omp[1] = failed({ retryRecovery: recovery });
	omp.push(retried());
	await reconnect(5);
	expect(entriesCalls()).toEqual([{ type: "get_entries" }]);
	const shown = useApp.getState().lives.L1.entries;
	expect(shown.map((e) => e.id)).toEqual(["u1", "a1", "a2"]);
	expect(recoveryOf(shown[1])).toEqual(recovery);

	// On a connection that stays up, coming back to the conversation is incremental again.
	sent.length = 0;
	await attach(5);
	expect(entriesCalls()).toEqual([{ type: "get_entries", since: "a2" }]);
});

test("the frames of a process keep the page's revision current: what they were stamped with is the revision it has seen", async () => {
	useApp.setState({ lives: { L1: initialLive(at(5)) } });
	const omp = [entry("a", null)];
	ompHolding(omp);
	await attach(5);
	// A turn runs while the page is attached: its frames carry the revision they moved the process to.
	onServer({ t: "frame", liveId: "L1", frame: { type: "agent_start" }, rev: 6 });
	omp.push(entry("b", "a"));
	onServer({ t: "frame", liveId: "L1", frame: { type: "agent_end", isTerminal: true }, rev: 7 });
	await drain();
	expect(useApp.getState().lives.L1.revision).toBe(7);
	sent.length = 0;
	// It attaches again after the turn: the server's revision is the one of the last frame it saw.
	await attach(7);
	expect(entriesCalls()).toEqual([{ type: "get_entries", since: "b" }]);
	expect(ids()).toEqual(["a", "b"]);
});

test("a frame stamped with a revision does not make a page that has not read the conversation yet believe it is current", async () => {
	useApp.setState({ lives: { L1: initialLive(at(5)) } });
	onServer({ t: "frame", liveId: "L1", frame: { type: "agent_start" }, rev: 9 });
	expect(useApp.getState().lives.L1.revision).toBeNull();
});
