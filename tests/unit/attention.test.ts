import "./browser-globals.ts";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { LiveInfo } from "../../shared/protocol.ts";
import {
	askingCount,
	attentionChanges,
	setNotifications,
	startAttention,
	tabTitle,
	useNotify,
} from "../../web/src/lib/attention.ts";
import { useApp } from "../../web/src/store/app.ts";
import { initialLive, type LiveState, withUiRequests } from "../../web/src/store/live.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * Telling someone elsewhere that a conversation needs them: the tab title and the system notifications. The page's
 * `document` and `Notification` are small stand-ins; the store is the real one.
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const info = (liveId: string, sessionFile: string | null = `/sessions/${liveId}.jsonl`): LiveInfo => ({
	liveId,
	pid: 1,
	cwd: "/p",
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
const asking = (s: LiveState): LiveState => withUiRequests(s, [{ id: "d1", method: "confirm", title: "Allow?" }]);
const answered = (s: LiveState): LiveState => withUiRequests(s, []);
const streaming = (s: LiveState, on = true): LiveState => ({ ...s, streaming: on });
const died = (s: LiveState): LiveState => ({
	...s,
	streaming: false,
	exited: { code: 1, stderr: "", by: "omp" },
	info: { ...s.info, exited: true },
});

test("the title counts the conversations waiting for an answer and marks a finished reply", () => {
	expect(tabTitle("omp", 0, false)).toBe("omp");
	expect(tabTitle("omp", 2, false)).toBe("(2) omp");
	expect(tabTitle("omp", 0, true)).toBe("✓ omp");
	expect(tabTitle("omp", 1, true)).toBe("(1) ✓ omp");
});

test("a process asking for an answer, and one whose reply ended, are what changed; a process that died is neither", () => {
	const a = initialLive(info("a"));
	const b = initialLive(info("b"));
	expect(attentionChanges({ a, b }, { a: asking(a), b })).toEqual({ asking: ["a"], finished: [] });
	// A dialog that was already pending, and a second one, are not news.
	expect(attentionChanges({ a: asking(a) }, { a: asking(a) })).toEqual({ asking: [], finished: [] });
	expect(attentionChanges({ a: streaming(a) }, { a: streaming(a, false), b })).toEqual({ asking: [], finished: ["a"] });
	expect(attentionChanges({ a: streaming(a, false) }, { a: streaming(a, false) }).finished).toEqual([]);
	// Streaming that stops because the process went away is not a finished reply.
	expect(attentionChanges({ a: streaming(a) }, { a: died(streaming(a)) })).toEqual({ asking: [], finished: [] });
	expect(askingCount({ a: asking(a), b: asking(b), c: died(asking(initialLive(info("c")))) })).toBe(2);
});

// ------------------------------------------------------------------ the page

interface Page {
	title: string;
	visibilityState: "visible" | "hidden";
	/** Whether the window is the one in use (`document.hasFocus()`). */
	focused: boolean;
	listeners: Map<string, () => void>;
	addEventListener(type: string, fn: () => void): void;
	removeEventListener(type: string): void;
	hasFocus(): boolean;
}
let page: Page;
const globals = globalThis as Record<string, unknown>;
const original = { document: globals.document, Notification: globals.Notification, window: globals.window };

class FakeNotification {
	static permission: NotificationPermission = "granted";
	static asked = 0;
	static answer: NotificationPermission = "granted";
	static shown: FakeNotification[] = [];
	static requestPermission = async () => {
		FakeNotification.asked++;
		FakeNotification.permission = FakeNotification.answer;
		return FakeNotification.answer;
	};
	onclick: (() => void) | null = null;
	closed = false;
	constructor(
		readonly title: string,
		readonly options: NotificationOptions,
	) {
		FakeNotification.shown.push(this);
	}
	close() {
		this.closed = true;
	}
}

/** The tab is shown or hidden, as the browser reports it. */
const show = (state: "visible" | "hidden") => {
	page.visibilityState = state;
	page.listeners.get("visibilitychange")?.();
};

let stop: () => void = () => {};
beforeEach(() => {
	page = {
		title: "omp",
		visibilityState: "visible",
		focused: true,
		listeners: new Map(),
		addEventListener(type, fn) {
			this.listeners.set(type, fn);
		},
		removeEventListener(type) {
			this.listeners.delete(type);
		},
		hasFocus() {
			return this.focused;
		},
	};
	globals.document = page;
	globals.Notification = FakeNotification;
	globals.window = { focus: () => {} };
	FakeNotification.permission = "granted";
	FakeNotification.asked = 0;
	FakeNotification.answer = "granted";
	FakeNotification.shown = [];
	useNotify.setState({ enabled: false, permission: "granted" });
	useApp.setState({ lives: {}, sessions: [], toasts: [], view: { kind: "usage" } });
	stop = startAttention();
});
afterEach(() => {
	stop();
	for (const [k, v] of Object.entries(original)) {
		if (v === undefined) delete globals[k];
		else globals[k] = v;
	}
});

const setLives = (lives: Record<string, LiveState>) => useApp.setState({ lives });

test("the title counts the conversations waiting for an answer, visible or not, and goes back when they are answered", () => {
	const a = initialLive(info("a"));
	const b = initialLive(info("b"));
	setLives({ a, b });
	expect(page.title).toBe("omp");
	setLives({ a: asking(a), b });
	expect(page.title).toBe("(1) omp");
	setLives({ a: asking(a), b: asking(b) });
	expect(page.title).toBe("(2) omp");
	setLives({ a: answered(a), b: asking(b) });
	expect(page.title).toBe("(1) omp");
	// The process that was asking goes away: nothing waits any more.
	setLives({ a, b: died(b) });
	expect(page.title).toBe("omp");
});

test("a reply that ends while the tab is hidden marks the title until the tab is shown; one that ends in view does not", () => {
	const a = initialLive(info("a"));
	setLives({ a: streaming(a) });
	setLives({ a });
	expect(page.title).toBe("omp");

	show("hidden");
	setLives({ a: streaming(a) });
	expect(page.title).toBe("omp");
	setLives({ a });
	expect(page.title).toBe("✓ omp");
	// While it waits for an answer too, both show.
	setLives({ a: asking(a) });
	expect(page.title).toBe("(1) ✓ omp");

	show("visible");
	expect(page.title).toBe("(1) omp");
	setLives({ a });
	expect(page.title).toBe("omp");
});

test("stopping puts the title back as it was", () => {
	const a = initialLive(info("a"));
	setLives({ a: asking(a) });
	expect(page.title).toBe("(1) omp");
	stop();
	expect(page.title).toBe("omp");
	setLives({ a: asking(a), b: asking(initialLive(info("b"))) });
	expect(page.title).toBe("omp");
	stop = startAttention();
	expect(page.title).toBe("(2) omp");
});

test("notifications: only when turned on and allowed, one per conversation", async () => {
	const a = initialLive(info("a"));
	useApp.setState({ lives: { a } });
	show("hidden");

	// Off: the title changes, nothing is shown.
	setLives({ a: asking(a) });
	expect(FakeNotification.shown).toEqual([]);
	setLives({ a });

	await setNotifications(true);
	expect(useNotify.getState()).toEqual({ enabled: true, permission: "granted" });
	setLives({ a: asking(a) });
	expect(FakeNotification.shown).toHaveLength(1);
	expect(FakeNotification.shown[0].options.tag).toBe("a");
	expect(FakeNotification.shown[0].options.body).toBe("Needs your input");
	expect(FakeNotification.shown[0].title).toBe("Untitled session");

	setLives({ a: streaming(answered(a)) });
	setLives({ a: streaming(answered(a), false) });
	expect(FakeNotification.shown).toHaveLength(2);
	expect(FakeNotification.shown[1].options.body).toBe("Finished");
	// The newer one has the older one's tag: the browser replaces it.
	expect(FakeNotification.shown[1].options.tag).toBe(FakeNotification.shown[0].options.tag);

	// Turned off again.
	await setNotifications(false);
	setLives({ a });
	setLives({ a: asking(a) });
	expect(FakeNotification.shown).toHaveLength(2);
});

/** `a` finishes a reply with the page and the store as a test has set them: how many notifications that made. */
function finishedNotices(a: LiveState): number {
	const before = FakeNotification.shown.length;
	setLives({ a: streaming(a) });
	setLives({ a });
	return FakeNotification.shown.length - before;
}

test("a conversation you are looking at is not notified of: only when the window is in use and that conversation is on screen", async () => {
	const a = initialLive(info("a", "/sessions/a.jsonl"));
	const b = initialLive(info("b", "/sessions/b.jsonl"));
	useApp.setState({ lives: { a, b } });
	await setNotifications(true);
	const open = (liveId: string | null, file: string | null) =>
		useApp.setState({ view: { kind: "chat", file, liveId } });

	// On screen in a window that is in use, by its process or by its file alone: nothing, for the reply and for a question.
	open("a", "/sessions/a.jsonl");
	expect(finishedNotices(a)).toBe(0);
	setLives({ a: asking(a), b });
	setLives({ a, b });
	open(null, "/sessions/a.jsonl");
	expect(finishedNotices(a)).toBe(0);
	expect(FakeNotification.shown).toHaveLength(0);

	// The window is in use, and another conversation, or another page, is on screen: this one is told.
	open("b", "/sessions/b.jsonl");
	expect(finishedNotices(a)).toBe(1);
	useApp.setState({ view: { kind: "usage" } });
	expect(finishedNotices(a)).toBe(1);
	useApp.setState({ view: { kind: "settings" } });
	setLives({ a: asking(a), b });
	expect(FakeNotification.shown.at(-1)?.options.body).toBe("Needs your input");
	setLives({ a, b });

	// The conversation is on screen but the window is not the one in use: the tab is hidden, or another application has the focus.
	open("a", "/sessions/a.jsonl");
	const before = FakeNotification.shown.length;
	page.focused = false;
	expect(finishedNotices(a)).toBe(1);
	page.focused = true;
	show("hidden");
	expect(finishedNotices(a)).toBe(1);
	show("visible");
	expect(finishedNotices(a)).toBe(0);
	expect(FakeNotification.shown).toHaveLength(before + 2);
});

test("clicking a notification opens the conversation", async () => {
	const a = initialLive(info("a", "/sessions/a.jsonl"));
	useApp.setState({ lives: { a }, view: { kind: "usage" } });
	await setNotifications(true);
	show("hidden");
	setLives({ a: asking(a) });
	FakeNotification.shown[0].onclick?.();
	expect(FakeNotification.shown[0].closed).toBe(true);
	expect(useApp.getState().view).toEqual({ kind: "chat", file: "/sessions/a.jsonl", liveId: "a" });
});

test("turning notifications on asks the browser once; refused, they stay off", async () => {
	FakeNotification.permission = "default";
	FakeNotification.answer = "denied";
	useNotify.setState({ enabled: false, permission: "default" });
	await setNotifications(true);
	expect(FakeNotification.asked).toBe(1);
	expect(useNotify.getState()).toEqual({ enabled: false, permission: "denied" });
	expect(localStorage.getItem("ompw.notify")).toBe("off");

	FakeNotification.permission = "default";
	FakeNotification.answer = "granted";
	await setNotifications(true);
	expect(useNotify.getState()).toEqual({ enabled: true, permission: "granted" });
	expect(localStorage.getItem("ompw.notify")).toBe("on");
	// Already allowed: no second question.
	await setNotifications(false);
	await setNotifications(true);
	expect(FakeNotification.asked).toBe(2);

	// A browser without notifications cannot turn them on.
	delete globals.Notification;
	await setNotifications(true);
	expect(useNotify.getState()).toEqual({ enabled: false, permission: "unsupported" });
});
