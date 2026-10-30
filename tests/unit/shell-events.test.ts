import { expect, test } from "bun:test";
import { QuestionStore } from "../../server/omp/unattended/questions.ts";
import { ShellEvents, type ShellMessage, type ShellState } from "../../server/shell-events.ts";
import type { AttentionNotice } from "../../shared/attention.ts";
import type { LiveInfo } from "../../shared/protocol.ts";
import { tempDir } from "../support/temp-dirs.ts";

/** A message without what makes it one of a run (`epoch`, `seq`): what most of the tests look at. */
type Plain = ({ t: "state" } & ShellState) | ({ t: "attention" } & AttentionNotice);

/**
 * What the macOS app is told on its own (#627): the state of the menu bar icon, and the notifications that used to be the
 * page's. The stream is read as the app reads it, line by line; the server's processes, its preferences and its titles are
 * stand-ins the test moves. That the route is refused to a page that is not on this computer, and what a real omp makes of
 * it, is `tests/contract/shell-events.test.ts`.
 */

const info = (liveId: string, over: Partial<LiveInfo> = {}): LiveInfo => ({
	liveId,
	pid: 1,
	cwd: "/p",
	sessionFile: `/sessions/${liveId}.jsonl`,
	sessionId: null,
	args: [],
	startedAt: 0,
	streaming: false,
	exited: false,
	subscribers: 0,
	pausedAt: null,
	mode: "full",
	...over,
});

interface World {
	events: ShellEvents;
	/** The processes the server holds: what a change is made to, then announced. */
	lives: Map<string, LiveInfo>;
	prefs: { notify: boolean; lang: string | null; menuIcon: boolean };
	titles: Map<string, { title?: string | null; preview?: string | null }>;
	/** Change a process and announce it, as the pool does. */
	announce(liveId: string, over: Partial<LiveInfo>): void;
}

function world(
	extra: {
		named?: (file: string) => Promise<{ title?: string | null } | null>;
		titleWaitMs?: number;
		heartbeatMs?: number;
		changed?: () => void;
		questions?: () => number;
	} = {},
): World {
	const lives = new Map<string, LiveInfo>();
	const prefs = { notify: true, lang: null as string | null, menuIcon: true };
	const titles = new Map<string, { title?: string | null; preview?: string | null }>();
	const events = new ShellEvents({
		lives: () => lives.values(),
		named: extra.named ?? (async (file) => titles.get(file) ?? null),
		prefs: () => prefs,
		questions: extra.questions ?? (() => 0),
		titleWaitMs: extra.titleWaitMs,
		heartbeatMs: extra.heartbeatMs,
		changed: extra.changed,
	});
	return {
		events,
		lives,
		prefs,
		titles,
		announce(liveId, over) {
			const next = { ...(lives.get(liveId) ?? info(liveId)), ...over };
			if (over.asking === false) delete next.asking;
			lives.set(liveId, next);
			events.note(next);
		},
	};
}

/** An app reading the stream: the lines so far, as parsed messages, and a way to wait for the next. */
function reader(w: World, query = "", remote?: { validUntil: number }) {
	const res = w.events.serve(new Request(`http://127.0.0.1/api/shell/events${query}`), remote);
	const body = res.body?.getReader();
	if (!body) throw new Error("no body");
	const decoder = new TextDecoder();
	let buffer = "";
	const seen: (Plain | "ping")[] = [];
	/** The same, as the server wrote them: with the epoch of its run and the number of each notice, which `seen` leaves out. */
	const full: (ShellMessage | "ping")[] = [];
	const next = async (): Promise<Plain | "ping"> => {
		for (;;) {
			const at = buffer.indexOf("\n");
			if (at >= 0) {
				const text = buffer.slice(0, at);
				buffer = buffer.slice(at + 1);
				const raw = text === "" ? "ping" : (JSON.parse(text) as ShellMessage);
				full.push(raw);
				const message =
					raw === "ping"
						? raw
						: (Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "epoch" && key !== "seq")) as Plain);
				seen.push(message);
				return message;
			}
			const { value, done } = await body.read();
			if (done) throw new Error("the stream ended");
			buffer += decoder.decode(value);
		}
	};
	/** The next message that is not a heartbeat. */
	const message = async (): Promise<Plain> => {
		for (;;) {
			const got = await next();
			if (got !== "ping") return got;
		}
	};
	return { res, next, message, seen, full, cancel: () => body.cancel() };
}

/** Let what the announcements started finish: the titles are asked for and the messages written through promises only, no clock. */
const settle = async () => {
	for (let turn = 0; turn < 10; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
};

/** A state message as the server says it: the counts given, the menu bar icon wanted, no question open, no run finished. */
const st = (working: number, asking: number, paused: number, over: Partial<ShellState> = {}) => ({
	t: "state" as const,
	working,
	asking,
	paused,
	menuIcon: true,
	questions: 0,
	finished: 0,
	...over,
});

test("the response begins with how many conversations work and wait, as newline-delimited JSON", async () => {
	const w = world();
	w.lives.set("a", info("a", { streaming: true }));
	w.lives.set("b", info("b", { streaming: true, asking: true }));
	w.lives.set("c", info("c"));
	const app = reader(w);
	expect(app.res.headers.get("content-type")).toBe("application/x-ndjson");
	expect(app.res.headers.get("cache-control")).toBe("no-store");
	expect(await app.message()).toEqual(st(1, 1, 0));
	expect(w.events.listeners).toBe(1);
	await app.cancel();
});

test("a paused conversation is counted as paused, not as working, and resuming it counts it as working again", async () => {
	const w = world();
	w.lives.set("a", info("a", { streaming: true }));
	const app = reader(w);
	expect(await app.message()).toEqual(st(1, 0, 0));
	w.announce("a", { pausedAt: 1 });
	expect(await app.message()).toEqual(st(0, 0, 1));
	w.announce("a", { pausedAt: null });
	expect(await app.message()).toEqual(st(1, 0, 0));
	await app.cancel();
});

test("turning the menu bar icon off or on in Settings tells the app once, and a change that is none tells it nothing", async () => {
	const w = world();
	const app = reader(w);
	expect(await app.message()).toEqual(st(0, 0, 0));
	w.prefs.menuIcon = false;
	w.events.prefsChanged();
	expect(await app.message()).toEqual(st(0, 0, 0, { menuIcon: false }));
	w.events.prefsChanged();
	await settle();
	expect(app.seen).toHaveLength(2);
	await app.cancel();
});

test("how many unattended questions are open is told when one is filed, answered or dismissed, and not when nothing changes (#705)", async () => {
	const dir = tempDir("ompw-shell-questions-");
	const store = new QuestionStore(dir);
	const w = world({ questions: () => store.counts().open });
	store.onChange(() => w.events.questionsChanged());
	const ask = (session: string, question: string) =>
		store.file(
			{ session, title: session },
			"tool",
			{ question, context: "", options: [] },
			`call-${session}-${question}`,
		);
	const app = reader(w);
	expect(await app.message()).toEqual(st(0, 0, 0));

	ask("/sessions/a.jsonl", "Which db?");
	expect(await app.message()).toEqual(st(0, 0, 0, { questions: 1 }));
	ask("/sessions/b.jsonl", "Which logger?");
	expect(await app.message()).toEqual(st(0, 0, 0, { questions: 2 }));
	// A question that is the same as an open one is not filed again: nothing changed, nothing is told.
	ask("/sessions/a.jsonl", "Which db?");
	await settle();
	expect(app.seen).toHaveLength(3);

	const [newest, older] = store.list().questions;
	store.answer(newest?.id, { options: [], text: "sqlite" });
	expect(await app.message()).toEqual(st(0, 0, 0, { questions: 1 }));
	store.dismiss(older?.id);
	expect(await app.message()).toEqual(st(0, 0, 0, { questions: 0 }));

	// An app that comes later is told how many are open now, as it is told the other counts.
	ask("/sessions/c.jsonl", "Which port?");
	await app.message();
	const later = reader(w);
	expect(await later.message()).toEqual(st(0, 0, 0, { questions: 1 }));
	await app.cancel();
	await later.cancel();
});

test("a run that ended is counted, with notifications on or off and whether or not an app reads, and told even when no other count changes (#705)", async () => {
	const w = world();
	w.prefs.notify = false;
	// Nobody reads yet: the run is counted all the same.
	w.announce("a", { streaming: true });
	w.announce("a", { streaming: false });
	const app = reader(w);
	expect(await app.message()).toEqual(st(0, 0, 0, { finished: 1 }));

	// A conversation that asks and is answered, and one that is paused or ended, are no run that finished.
	w.announce("b", { streaming: true });
	expect(await app.message()).toEqual(st(1, 0, 0, { finished: 1 }));
	w.announce("b", { asking: true });
	expect(await app.message()).toEqual(st(0, 1, 0, { finished: 1 }));
	w.announce("b", { asking: false });
	expect(await app.message()).toEqual(st(1, 0, 0, { finished: 1 }));
	w.announce("b", { pausedAt: 1 });
	expect(await app.message()).toEqual(st(0, 0, 1, { finished: 1 }));
	// The turn of a paused conversation ends: working, waiting and paused are as they were, and the run is told still.
	w.announce("b", { streaming: false });
	expect(await app.message()).toEqual(st(0, 0, 1, { finished: 2 }));
	// The process is gone: no run ended.
	w.lives.delete("b");
	w.events.note(info("b", { exited: true }));
	expect(await app.message()).toEqual(st(0, 0, 0, { finished: 2 }));
	await settle();
	expect(app.seen.some((m) => m !== "ping" && m.t === "attention")).toBe(false);
	await app.cancel();
});

test("a conversation that starts to ask, and one whose run ends, are told with the words of the page's own notifications", async () => {
	const w = world();
	w.titles.set("/sessions/a.jsonl", { title: "Fix the build", preview: "please" });
	w.lives.set("a", info("a"));
	const app = reader(w);
	expect(await app.message()).toEqual(st(0, 0, 0));

	w.announce("a", { streaming: true });
	expect(await app.message()).toEqual(st(1, 0, 0));
	w.announce("a", { asking: true });
	expect(await app.message()).toEqual(st(0, 1, 0));
	expect(await app.message()).toEqual({
		t: "attention",
		id: "a",
		kind: "asking",
		title: "Fix the build",
		body: "Needs your input",
		liveId: "a",
		file: "/sessions/a.jsonl",
	});
	// Answered, and the turn goes on: working again, and nothing to tell.
	w.announce("a", { asking: false });
	expect(await app.message()).toEqual(st(1, 0, 0));
	w.announce("a", { streaming: false });
	expect(await app.message()).toEqual(st(0, 0, 0, { finished: 1 }));
	expect(await app.message()).toMatchObject({
		t: "attention",
		kind: "finished",
		body: "Finished",
		title: "Fix the build",
	});
	await app.cancel();
});

test("the title is the conversation's first prompt without one, and says it has no name or no file", async () => {
	const w = world();
	w.titles.set("/sessions/p.jsonl", { title: null, preview: "what is this" });
	w.titles.set("/sessions/n.jsonl", { title: "", preview: "" });
	const app = reader(w);
	await app.message();
	for (const [id, over] of [
		["p", {}],
		["n", {}],
		["f", { sessionFile: null }],
	] as const) {
		w.announce(id, { ...over, asking: true });
		await app.message(); // the state
		const note = await app.message();
		expect(note).toMatchObject({ t: "attention", liveId: id });
	}
	const titles = app.seen.flatMap((m) => (m !== "ping" && m.t === "attention" ? [m.title] : []));
	expect(titles).toEqual(["what is this", "Untitled session", "New conversation"]);
	await app.cancel();
});

test("what is said is in the language the person saved, else the app's own (?lang=), else English", async () => {
	const w = world();
	w.titles.set("/sessions/a.jsonl", { title: "T" });
	const bodies = async (query: string, lang: string | null) => {
		w.prefs.lang = lang;
		const app = reader(w, query);
		await app.message();
		w.announce("a", { streaming: true });
		await app.message();
		w.announce("a", { streaming: false });
		await app.message();
		const note = await app.message();
		await app.cancel();
		return note.t === "attention" ? note.body : "not a notice";
	};
	expect(await bodies("", null)).toBe("Finished");
	expect(await bodies("?lang=zh-CN", null)).toBe("已完成");
	expect(await bodies("?lang=zh-CN", "en")).toBe("Finished");
	expect(await bodies("?lang=en", "zh-CN")).toBe("已完成");
	expect(await bodies("?lang=fr", null)).toBe("Finished");
});

test("with notifications off the app still hears how many work and wait, and is told nothing to show; turning them on is at once", async () => {
	const w = world();
	w.prefs.notify = false;
	const app = reader(w);
	await app.message();
	w.announce("a", { asking: true });
	expect(await app.message()).toEqual(st(0, 1, 0));
	await settle();
	expect(app.seen.some((m) => m !== "ping" && m.t === "attention")).toBe(false);
	w.prefs.notify = true;
	w.announce("a", { asking: false });
	await app.message();
	w.announce("a", { asking: true });
	await app.message();
	expect(await app.message()).toMatchObject({ t: "attention", kind: "asking" });
	await app.cancel();
});

test("a conversation that was already asking or working when the app began to read is not news; its next change is", async () => {
	const w = world();
	w.lives.set("a", info("a", { asking: true, streaming: true }));
	w.lives.set("b", info("b", { streaming: true }));
	// An announcement of what they already are says nothing.
	w.events.note(w.lives.get("a") as LiveInfo);
	const app = reader(w);
	expect(await app.message()).toEqual(st(1, 1, 0));
	w.announce("a", { subscribers: 1 });
	w.announce("b", { subscribers: 1 });
	await settle();
	expect(app.seen).toHaveLength(1);
	// `b` finishes: that is news.
	w.announce("b", { streaming: false });
	await app.message();
	expect(await app.message()).toMatchObject({ t: "attention", kind: "finished", liveId: "b" });
	await app.cancel();
});

test("a process first announced already asking is news; one that ended is not told of, and is forgotten", async () => {
	const w = world();
	const app = reader(w);
	await app.message();
	w.announce("new", { asking: true, streaming: true });
	await app.message();
	expect(await app.message()).toMatchObject({ t: "attention", kind: "asking", liveId: "new" });
	// It died: no end of a run to tell of, and it counts for nothing.
	w.lives.delete("new");
	w.events.note(info("new", { exited: true, streaming: false }));
	expect(await app.message()).toEqual(st(0, 0, 0));
	await settle();
	expect(app.seen).toHaveLength(4);
	// The same id again (a fresh process) is compared with nothing: a finish without a run is no finish.
	w.announce("new", { streaming: false });
	await settle();
	expect(app.seen).toHaveLength(4);
	await app.cancel();
});

test("notices keep the order things happened in, even when one title is slow to come", async () => {
	const slow = Promise.withResolvers<{ title: string }>();
	const w = world({ named: (file) => (file.includes("slow") ? slow.promise : Promise.resolve({ title: "quick" })) });
	const app = reader(w);
	await app.message();
	w.announce("slow", { asking: true });
	await app.message();
	w.announce("fast", { asking: true });
	await app.message();
	await settle();
	// The second is waiting for the first, not passing it.
	expect(app.seen.filter((m) => m !== "ping" && m.t === "attention")).toHaveLength(0);
	slow.resolve({ title: "slow one" });
	const first = await app.message();
	const second = await app.message();
	expect([first, second].map((m) => (m.t === "attention" ? `${m.liveId}:${m.title}` : m.t))).toEqual([
		"slow:slow one",
		"fast:quick",
	]);
	await app.cancel();
});

test("a title that does not come in time, or cannot be read, does not hold a notification back", async () => {
	// A real, short wait: the deadline is a timer of the server's own, which is what is under test.
	const w = world({ named: () => new Promise<null>(() => {}), titleWaitMs: 30 });
	const app = reader(w);
	await app.message();
	w.announce("a", { asking: true });
	await app.message();
	expect(await app.message()).toMatchObject({ t: "attention", title: "Untitled session" });
	await app.cancel();

	const broken = world({ named: () => Promise.reject(new Error("index is being rebuilt")) });
	const again = reader(broken);
	await again.message();
	broken.announce("b", { asking: true });
	await again.message();
	expect(await again.message()).toMatchObject({ t: "attention", title: "Untitled session" });
	await again.cancel();
});

test("nothing is built or kept for an app that is not reading, and nothing is replayed to one that comes later", async () => {
	const w = world();
	w.announce("a", { streaming: true });
	w.announce("a", { asking: true });
	w.announce("a", { asking: false });
	w.announce("a", { streaming: false });
	await settle();
	expect(w.events.listeners).toBe(0);
	const app = reader(w);
	expect(await app.message()).toEqual(st(0, 0, 0, { finished: 1 }));
	await settle();
	expect(app.seen).toHaveLength(1);
	await app.cancel();
});

test("an app that goes is let go: no reader is left, and the next one is told the state afresh", async () => {
	const w = world();
	const first = reader(w);
	await first.message();
	await first.cancel();
	expect(w.events.listeners).toBe(0);
	w.announce("a", { asking: true });
	const second = reader(w);
	expect(await second.message()).toEqual(st(0, 1, 0));
	await second.cancel();
});

test("an app that reads is somebody to tell the person only while notifications are on, and the guard is told when the first comes and the last goes", async () => {
	let changed = 0;
	const w = world({ changed: () => changed++ });
	expect(w.events.reaches()).toBe(false);
	const first = reader(w);
	await first.message();
	expect(w.events.reaches()).toBe(true);
	expect(changed).toBe(1);
	// A second app changes nothing the guard would act on, and one of two leaving does not either.
	const second = reader(w);
	await second.message();
	expect(changed).toBe(1);
	await first.cancel();
	expect(w.events.reaches()).toBe(true);
	expect(changed).toBe(1);
	// Told nothing to show (notifications off): nobody would see the question.
	w.prefs.notify = false;
	expect(w.events.reaches()).toBe(false);
	w.prefs.notify = true;
	await second.cancel();
	expect(w.events.reaches()).toBe(false);
	expect(changed).toBe(2);
});

test("a quiet response says it is alive with an empty line, and stops when nobody reads", async () => {
	const w = world({ heartbeatMs: 10 });
	const app = reader(w);
	await app.message();
	expect(await app.next()).toBe("ping");
	expect(await app.next()).toBe("ping");
	await app.cancel();
	expect(w.events.listeners).toBe(0);
});

test("a reader that does not read is dropped once it is far behind, instead of holding every message for ever", async () => {
	const w = world();
	// Opened and never read from.
	w.events.serve(new Request("http://127.0.0.1/api/shell/events"));
	expect(w.events.listeners).toBe(1);
	for (let i = 0; i < 100; i++) {
		w.announce("a", { asking: true });
		w.announce("a", { asking: false });
	}
	await settle();
	expect(w.events.listeners).toBe(0);
});

/** The epoch the server said its first state in. */
const epochOf = (app: ReturnType<typeof reader>): string => {
	const first = app.full[0];
	if (first === undefined || first === "ping" || first.t !== "state") throw new Error("no state yet");
	return first.epoch;
};

test("notices are numbered, and an app that comes back is sent the ones it missed in the epoch it read, right after the state", async () => {
	const w = world();
	w.titles.set("/sessions/a.jsonl", { title: "Alpha" });
	w.titles.set("/sessions/b.jsonl", { title: "Beta" });
	w.titles.set("/sessions/c.jsonl", { title: "Gamma" });
	// Before any app has read nothing is kept: there is nobody to have missed it.
	w.announce("early", { asking: true });
	await settle();

	const first = reader(w);
	await first.message();
	const epoch = epochOf(first);
	w.announce("a", { asking: true });
	await first.message();
	await first.message();
	expect(first.full.at(-1)).toMatchObject({ t: "attention", seq: 1, liveId: "a" });
	await first.cancel();

	// While nobody reads, notices are still kept.
	w.announce("b", { asking: true });
	await settle();
	w.announce("c", { asking: true });
	await settle();

	const back = reader(w, `?lang=zh-CN&epoch=${epoch}&since=1`);
	expect(await back.message()).toEqual(st(0, 4, 0));
	expect(await back.message()).toMatchObject({ t: "attention", liveId: "b", title: "Beta", body: "需要你的输入" });
	expect(await back.message()).toMatchObject({ t: "attention", liveId: "c", title: "Gamma" });
	expect(back.full.filter((m) => m !== "ping" && m.t === "attention").map((m) => (m as { seq: number }).seq)).toEqual([
		2, 3,
	]);
	await back.cancel();

	// Up to date, another run of the server, or no word of where it was: nothing is sent again.
	for (const query of [
		`?epoch=${epoch}&since=3`,
		`?epoch=another&since=0`,
		"",
		`?epoch=${epoch}`,
		`?epoch=${epoch}&since=x`,
	]) {
		const app = reader(w, query);
		await app.message();
		await settle();
		expect(
			app.seen.filter((m) => m !== "ping" && m.t === "attention"),
			query,
		).toEqual([]);
		await app.cancel();
	}
});

test("only the last twenty notices are kept, oldest first, and one for a conversation that asked again is a notice of its own", async () => {
	const w = world();
	const first = reader(w);
	await first.message();
	const epoch = epochOf(first);
	await first.cancel();
	for (let i = 0; i < 25; i++) {
		w.announce("a", { asking: true });
		w.announce("a", { asking: false });
		await settle();
	}
	const back = reader(w, `?epoch=${epoch}&since=0`);
	// The state, then the twenty notices the app missed.
	for (let i = 0; i < 21; i++) await back.message();
	const seqs = back.full.filter((m) => m !== "ping" && m.t === "attention").map((m) => (m as { seq: number }).seq);
	expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 6));
	await back.cancel();
});

// ------------------------------------------------------------------ the app of another Mac (#656)

const later = (ms: number) => ({ validUntil: Date.now() + ms });

test("the app of another Mac asked for the stream, so it is sent notices whatever Settings says here; this computer's own app is not", async () => {
	const w = world();
	w.prefs.notify = false;
	w.lives.set("a", info("a"));
	w.titles.set("/sessions/a.jsonl", { title: "Fix the build" });
	const mine = reader(w);
	expect(await mine.message()).toMatchObject({ t: "state" });
	// Nobody abroad reads: with Settings off, nothing is built, and the guard has nobody to ask through.
	w.announce("a", { streaming: true });
	w.announce("a", { asking: true });
	await settle();
	expect(w.events.reaches()).toBe(false);

	const abroad = reader(w, "", later(60_000));
	expect(await abroad.message()).toMatchObject({ t: "state" });
	expect(w.events.reaches()).toBe(true);
	w.announce("a", { asking: false });
	w.announce("a", { streaming: false });
	const finished = await abroad.message();
	// Skip the states: the notice of the run that ended is what it is told.
	let note = finished;
	while (note.t !== "attention") note = await abroad.message();
	expect(note).toMatchObject({ kind: "finished", title: "Fix the build", liveId: "a" });
	// This computer's own reader, with Settings off, got no notice: only the states.
	await settle();
	expect(mine.seen.filter((m) => m !== "ping" && m.t === "attention")).toEqual([]);

	// The app of the other Mac goes: nobody is reached while Settings is off.
	await abroad.cancel();
	expect(w.events.reaches()).toBe(false);
	await mine.cancel();
});

test("remote readers end when remote access changes, and not this computer's; the stream of one ends when its Access token does", async () => {
	const w = world();
	const mine = reader(w);
	const abroad = reader(w, "", later(60_000));
	await mine.message();
	await abroad.message();
	expect(w.events.listeners).toBe(2);
	w.events.closeRemote();
	expect(w.events.listeners).toBe(1);
	await expect(abroad.next()).rejects.toThrow("the stream ended");
	w.announce("x", { streaming: true });
	expect(await mine.message()).toMatchObject({ t: "state", working: 1 });
	await mine.cancel();

	// The token's end: a reader let in for 30 ms is let go after them.
	const brief = reader(w, "", later(30));
	await brief.message();
	expect(w.events.listeners).toBe(1);
	await expect(brief.next()).rejects.toThrow("the stream ended");
	expect(w.events.listeners).toBe(0);
	// A token that has already run out ends the stream at once.
	const gone = reader(w, "", { validUntil: Date.now() - 1000 });
	await gone.message();
	await expect(gone.next()).rejects.toThrow("the stream ended");
	expect(w.events.listeners).toBe(0);
});
