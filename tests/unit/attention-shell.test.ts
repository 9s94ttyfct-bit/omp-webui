import "./browser-globals.ts";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { LiveInfo } from "../../shared/protocol.ts";
import { setNotifications, startAttention, useNotify } from "../../web/src/lib/attention.ts";
import { SHELL_EVENT, type ShellPermission } from "../../web/src/lib/shell-notify.ts";
import { useApp } from "../../web/src/store/app.ts";
import { initialLive, type LiveState, withUiRequests } from "../../web/src/store/live.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * In the macOS app the page shows no notification: the app does, from what the server streams to it (the page may not even
 * exist while the app runs in the background). What the page keeps is the tab title, the permission it shows in Settings
 * (asked of the shell through `window.webkit.messageHandlers.ompwNotify`: `status` and `request`) and the click on a
 * notification, which comes back as an event that opens the conversation. The shell is a stand-in that records what it was
 * sent and answers what a test tells it to; `Notification` is one that fails the test if anything reaches for it.
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
const setLives = (lives: Record<string, LiveState>) => useApp.setState({ lives });

type Message = Record<string, unknown>;
type Listener = (e: { detail: unknown }) => void;

/** What the shell was sent, in order, and what it answers: `permission` for every message, `refuse` for none of them. */
let sent: Message[];
let permission: ShellPermission;
let refuse: boolean;
let listeners: Set<Listener>;
let page: {
	title: string;
	visibilityState: "visible" | "hidden";
	focused: boolean;
	onVisibility: (() => void) | undefined;
	addEventListener(type: string, fn: () => void): void;
	removeEventListener(): void;
	hasFocus(): boolean;
};

const globals = globalThis as Record<string, unknown>;
const original = { document: globals.document, Notification: globals.Notification, window: globals.window };

/** The shell says something on its own. */
const say = (detail: unknown) => {
	for (const fn of [...listeners]) fn({ detail });
};
/** Let the answers to what was sent arrive: every promise they pass through settles before the next turn of the event loop. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

let stop: () => void = () => {};
beforeEach(() => {
	sent = [];
	permission = "granted";
	refuse = false;
	listeners = new Set();
	page = {
		title: "omp",
		visibilityState: "visible",
		focused: true,
		onVisibility: undefined,
		addEventListener(type, fn) {
			if (type === "visibilitychange") this.onVisibility = fn;
		},
		removeEventListener() {},
		hasFocus() {
			return this.focused;
		},
	};
	globals.document = page;
	// A page in the app has `Notification` in WebKit's sense: present, and of no use. Nothing may use it.
	globals.Notification = new Proxy(
		{},
		{
			get(_, key) {
				throw new Error(`the page reached for Notification.${String(key)} inside the app`);
			},
		},
	);
	globals.window = {
		focus: () => {},
		webkit: {
			messageHandlers: {
				ompwNotify: {
					postMessage: async (message: Message) => {
						sent.push(message);
						if (refuse) throw new Error("not allowed");
						return { permission };
					},
				},
			},
		},
		addEventListener: (type: string, fn: Listener) => {
			if (type === SHELL_EVENT) listeners.add(fn);
		},
		removeEventListener: (type: string, fn: Listener) => {
			if (type === SHELL_EVENT) listeners.delete(fn);
		},
	};
	useNotify.setState({ enabled: false, permission: "default" });
	useApp.setState({ lives: {}, sessions: [], toasts: [], view: { kind: "usage" } });
});
afterEach(() => {
	stop();
	stop = () => {};
	for (const [k, v] of Object.entries(original)) {
		if (v === undefined) delete globals[k];
		else globals[k] = v;
	}
});

test("the page asks the shell what macOS allows when it starts, and again when the shell says it may have changed", async () => {
	permission = "denied";
	stop = startAttention();
	// What macOS allows is asked first, then what the page shows (nothing: another page is on screen).
	expect(sent).toEqual([{ type: "status" }, { type: "viewing", liveId: null, file: null }]);
	await settle();
	expect(useNotify.getState().permission).toBe("denied");

	// The person allowed it in System Settings and came back to the app.
	say({ type: "permission", permission: "granted" });
	expect(useNotify.getState().permission).toBe("granted");
	// Nothing else the shell says changes it; a window parked in the background is not an event of the protocol any more.
	say({ type: "permission", permission: "sometimes" });
	say({ type: "parked", on: true });
	say({ type: "somethingelse" });
	say(null);
	expect(useNotify.getState().permission).toBe("granted");

	stop();
	expect(listeners.size).toBe(0);
});

test("a shell that does not answer cannot show notifications", async () => {
	refuse = true;
	stop = startAttention();
	await settle();
	expect(useNotify.getState().permission).toBe("unsupported");
	await setNotifications(true);
	expect(useNotify.getState()).toEqual({ enabled: false, permission: "unsupported" });
});

test("turning notifications on asks the shell, which asks macOS; the answer decides whether they are on", async () => {
	permission = "granted";
	await setNotifications(true);
	expect(sent).toEqual([{ type: "request" }]);
	expect(useNotify.getState()).toEqual({ enabled: true, permission: "granted" });
	expect(localStorage.getItem("ompw.notify")).toBe("on");

	// Off needs no question, and the permission is as it was.
	await setNotifications(false);
	expect(sent).toHaveLength(1);
	expect(useNotify.getState()).toEqual({ enabled: false, permission: "granted" });
	expect(localStorage.getItem("ompw.notify")).toBe("off");

	// Denied in System Settings since: the shell says so, and they stay off.
	permission = "denied";
	await setNotifications(true);
	expect(sent).toHaveLength(2);
	expect(useNotify.getState()).toEqual({ enabled: false, permission: "denied" });
	expect(localStorage.getItem("ompw.notify")).toBe("off");

	// Not decided: macOS prompts, and the person's choice is the answer.
	permission = "default";
	await setNotifications(true);
	expect(useNotify.getState()).toEqual({ enabled: false, permission: "default" });
});

test("inside the app the page notifies nobody, whatever the window's focus and visibility, with notifications on and allowed", async () => {
	const a = initialLive(info("a", "/sessions/a.jsonl"));
	const unsaved = initialLive(info("n", null));
	useApp.setState({ lives: { a, n: unsaved } });
	stop = startAttention();
	await setNotifications(true);
	await settle();
	expect(useNotify.getState()).toEqual({ enabled: true, permission: "granted" });
	sent = [];

	const windows = [
		{ focused: true, visibilityState: "visible" },
		{ focused: false, visibilityState: "visible" },
		{ focused: true, visibilityState: "hidden" },
		{ focused: false, visibilityState: "hidden" },
	] as const;
	for (const { focused, visibilityState } of windows) {
		page.focused = focused;
		page.visibilityState = visibilityState;
		// A dialog opens, is answered, and the replies end: one in a saved conversation, one in an unsaved one.
		setLives({ a: asking(a), n: unsaved });
		setLives({ a: streaming(answered(a)), n: streaming(unsaved) });
		setLives({ a: streaming(answered(a), false), n: streaming(unsaved, false) });
		setLives({ a, n: unsaved });
	}
	await settle();
	expect(sent).toEqual([]);
});

test("the tab title still counts the dialogs waiting and marks a turn that ended unseen, as in a browser", () => {
	const a = initialLive(info("a"));
	useApp.setState({ lives: { a: streaming(a) } });
	stop = startAttention();
	expect(page.title).toBe("omp");

	setLives({ a: asking(streaming(a)) });
	expect(page.title).toBe("(1) omp");

	// The turn ends while the window is in use: nothing to mark.
	setLives({ a: streaming(answered(a), false) });
	expect(page.title).toBe("omp");

	// One that ends while the window is hidden is marked until it is shown again.
	setLives({ a: streaming(a) });
	page.visibilityState = "hidden";
	setLives({ a: streaming(a, false) });
	expect(page.title).toBe("✓ omp");
	page.visibilityState = "visible";
	page.onVisibility?.();
	expect(page.title).toBe("omp");

	stop();
	expect(page.title).toBe("omp");
});

test("clicking a notification opens its conversation, by the process while it is there and by its file after", () => {
	const a = initialLive(info("a", "/sessions/a.jsonl"));
	useApp.setState({ lives: { a } });
	stop = startAttention();

	say({ type: "open", liveId: "a", file: "/sessions/a.jsonl" });
	expect(useApp.getState().view).toEqual({ kind: "chat", file: "/sessions/a.jsonl", liveId: "a" });

	// The app was started again since: the process is gone, the file is not.
	useApp.setState({ view: { kind: "usage" } });
	say({ type: "open", liveId: "gone", file: "/sessions/gone.jsonl" });
	expect(useApp.getState().view).toEqual({ kind: "chat", file: "/sessions/gone.jsonl", liveId: null });

	// Neither is there: the window came forward, and that is all.
	useApp.setState({ view: { kind: "usage" } });
	say({ type: "open", liveId: "gone", file: null });
	say({ type: "open", liveId: null, file: null });
	say({ type: "open" });
	expect(useApp.getState().view).toEqual({ kind: "usage" });
});

test("the page tells the shell which conversation it shows, once and whenever that changes, and not what changes nothing", async () => {
	const a = initialLive(info("a", "/sessions/a.jsonl"));
	const b = initialLive(info("b", "/sessions/b.jsonl"));
	useApp.setState({ lives: { a, b } });
	stop = startAttention();
	await settle();
	const views = () => sent.filter((m) => m.type === "viewing");
	expect(views()).toEqual([{ type: "viewing", liveId: null, file: null }]);

	useApp.setState({ view: { kind: "chat", file: "/sessions/a.jsonl", liveId: "a" } });
	expect(views().at(-1)).toEqual({ type: "viewing", liveId: "a", file: "/sessions/a.jsonl" });
	// A streamed token changes the store and not what is shown: the shell is not told again.
	const told = views().length;
	setLives({ a: streaming(a), b });
	setLives({ a: streaming(a), b: streaming(b) });
	expect(views()).toHaveLength(told);

	// A saved conversation named by its file alone is told with the process that runs it.
	useApp.setState({ view: { kind: "chat", file: "/sessions/b.jsonl", liveId: null } });
	expect(views().at(-1)).toEqual({ type: "viewing", liveId: "b", file: "/sessions/b.jsonl" });
	useApp.setState({ view: { kind: "settings" } });
	expect(views().at(-1)).toEqual({ type: "viewing", liveId: null, file: null });

	// Once stopped, nothing more is said.
	stop();
	const stopped = sent.length;
	useApp.setState({ view: { kind: "chat", file: "/sessions/a.jsonl", liveId: "a" } });
	expect(sent).toHaveLength(stopped);
});

test("a window onto another Mac tells the app what it shows and opens what a click names; it asks for no permission and posts nothing itself", async () => {
	const a = initialLive(info("a", "/sessions/a.jsonl"));
	useApp.setState({ lives: { a } });
	const seen: Message[] = [];
	// The window of another Mac has `ompwView` and no `ompwNotify`: the app's notifications are its own, from its own stream.
	(globals.window as Record<string, unknown>).webkit = {
		messageHandlers: {
			ompwView: {
				postMessage: async (message: Message) => {
					seen.push(message);
				},
			},
		},
	};
	useNotify.setState({ enabled: true, permission: "granted" });
	stop = startAttention();
	await settle();
	expect(seen).toEqual([{ type: "viewing", liveId: null, file: null }]);
	expect(sent).toEqual([]);

	useApp.setState({ view: { kind: "chat", file: "/sessions/a.jsonl", liveId: "a" } });
	expect(seen.at(-1)).toEqual({ type: "viewing", liveId: "a", file: "/sessions/a.jsonl" });
	// What the page does with a click of the app is what it does in the app's own window; the permission event is none of its business.
	useApp.setState({ view: { kind: "usage" } });
	say({ type: "permission", permission: "denied" });
	expect(useNotify.getState().permission).not.toBe("denied");
	say({ type: "open", liveId: "a", file: "/sessions/a.jsonl" });
	expect(useApp.getState().view).toEqual({ kind: "chat", file: "/sessions/a.jsonl", liveId: "a" });

	// A dialog and a reply that ends, with the window behind: the page posts no notification (the Notification of the page is the
	// stand-in that fails the test when touched).
	page.focused = false;
	setLives({ a: asking(a) });
	setLives({ a: streaming(answered(a)) });
	setLives({ a: streaming(answered(a), false) });
	await settle();
});
