import "./browser-globals.ts";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { CiRun } from "../../shared/ci.ts";
import { PREF } from "../../shared/prefs.ts";
import { useNotify } from "../../web/src/lib/attention.ts";
import { ciNotifyPossible, ciNotifyWanted, notifyFinished } from "../../web/src/lib/ci-runs.ts";
import { CI_NOTE_LIMITS, onShellEvent, SHELL_EVENT, type ShellEvent } from "../../web/src/lib/shell-notify.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * The CI tab's bell in the macOS app (audit A-015): the app's web view has no `Notification` that shows anything, so the end
 * of a run of the folder's branch is asked of the app's notification bridge (`macos/notifications.swift`), in the one shape
 * that bridge takes (`{ type: "show", tag: "ci:<run>", title, body, open: { panel: "ci" } }`, text cut to its limits), and a
 * click on it comes back as `{ type: "open-panel", panel: "ci" }`. The bridge's own side is tests/unit/macos-notify.test.ts.
 * The shell is a stand-in that records what it was sent; `Notification` fails the test if anything reaches for it.
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

type Message = Record<string, unknown>;
type Listener = (e: { detail: unknown }) => void;

let sent: Message[];
let listeners: Set<Listener>;
let page: { visibilityState: "visible" | "hidden"; focused: boolean; hasFocus(): boolean };
const globals = globalThis as Record<string, unknown>;
const original = { document: globals.document, Notification: globals.Notification, window: globals.window };

const run = (over: Partial<CiRun> = {}): CiRun => ({
	id: 4242,
	workflow: "CI",
	title: "Fix the parser",
	branch: "main",
	event: "push",
	sha: "a".repeat(40),
	state: "failure",
	createdAt: "2026-10-31T10:00:00Z",
	updatedAt: "2026-10-31T10:05:00Z",
	url: "https://github.com/o/r/actions/runs/4242",
	...over,
});

/** The page inside the macOS app (`ompwNotify`), or in its window onto another Mac (`ompwView` only). */
function shell(kind: "app" | "remote"): void {
	const handler = {
		postMessage: async (message: Message) => {
			sent.push(message);
			return { permission: "granted" };
		},
	};
	globals.window = {
		focus: () => {},
		webkit: { messageHandlers: kind === "app" ? { ompwNotify: handler } : { ompwView: handler } },
		addEventListener: (type: string, fn: Listener) => {
			if (type === SHELL_EVENT) listeners.add(fn);
		},
		removeEventListener: (type: string, fn: Listener) => {
			if (type === SHELL_EVENT) listeners.delete(fn);
		},
	};
}

beforeEach(() => {
	sent = [];
	listeners = new Set();
	page = {
		visibilityState: "hidden",
		focused: false,
		hasFocus() {
			return this.focused;
		},
	};
	globals.document = page;
	// WebKit's `Notification` in the app: present, and of no use. Nothing may use it.
	globals.Notification = new Proxy(
		{},
		{
			get(_, key) {
				throw new Error(`the page reached for Notification.${String(key)} inside the app`);
			},
		},
	);
	shell("app");
	localStorage.setItem(PREF.ciNotify, "on");
	useNotify.setState({ enabled: true, permission: "granted" });
});
afterEach(() => {
	for (const [k, v] of Object.entries(original)) {
		if (v === undefined) delete globals[k];
		else globals[k] = v;
	}
});

test("the bell is offered in the macOS app, and not in its window onto another Mac", () => {
	expect(ciNotifyPossible()).toBe(true);
	expect(ciNotifyWanted()).toBe(true);
	shell("remote");
	expect(ciNotifyPossible()).toBe(false);
	expect(ciNotifyWanted()).toBe(false);
});

test("a run's end is asked of the app's bridge, in the one shape it takes", () => {
	notifyFinished("/p", [run(), run({ id: 7, state: "success", workflow: "Release", title: "v1", branch: "dev" })]);
	expect(sent).toEqual([
		{ type: "show", tag: "ci:4242", title: "CI failed: CI", body: "main · Fix the parser", open: { panel: "ci" } },
		{ type: "show", tag: "ci:7", title: "CI passed: Release", body: "dev · v1", open: { panel: "ci" } },
	]);
});

test("its text is cut to what the bridge takes, never over", () => {
	notifyFinished("/p", [run({ workflow: "W".repeat(500), title: "🙂".repeat(1000) })]);
	const [message] = sent as { title: string; body: string }[];
	expect(Array.from(message.title).length).toBe(CI_NOTE_LIMITS.title);
	expect(Array.from(message.body).length).toBe(CI_NOTE_LIMITS.body);
	expect(message.title.endsWith("…")).toBe(true);
	expect(message.body.endsWith("…")).toBe(true);
});

test("nothing is asked while somebody looks at the window, the bell is off, or macOS does not allow notifications", () => {
	page.visibilityState = "visible";
	page.focused = true;
	notifyFinished("/p", [run()]);
	page.visibilityState = "hidden";
	localStorage.setItem(PREF.ciNotify, "off");
	notifyFinished("/p", [run()]);
	localStorage.setItem(PREF.ciNotify, "on");
	useNotify.setState({ enabled: true, permission: "denied" });
	notifyFinished("/p", [run()]);
	useNotify.setState({ enabled: false, permission: "granted" });
	notifyFinished("/p", [run()]);
	expect(sent).toEqual([]);
});

test("a click on it comes back as the CI tab to open; any other panel is not an event", () => {
	const heard: ShellEvent[] = [];
	const stop = onShellEvent((e) => heard.push(e));
	for (const fn of listeners) {
		fn({ detail: { type: "open-panel", panel: "ci" } });
		fn({ detail: { type: "open-panel", panel: "files" } });
		fn({ detail: { type: "open-panel" } });
	}
	stop();
	expect(heard).toEqual([{ type: "open-panel", panel: "ci" }]);
	expect(listeners.size).toBe(0);
});
