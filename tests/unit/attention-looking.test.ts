import "./browser-globals.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { isLookingAt } from "../../shared/attention.ts";
import type { LiveInfo } from "../../shared/protocol.ts";
import { shownConversation } from "../../web/src/lib/attention.ts";
import type { View } from "../../web/src/store/app.ts";
import { initialLive } from "../../web/src/store/live.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

beforeAll(installGlobals);
afterAll(restoreGlobals);

/**
 * The one rule of #655, which the browser page, the macOS app and Web Push each apply: a notification of a conversation is not
 * wanted only when the person's window is the one in use AND that conversation is the one on screen in it.
 */

const conversation = { liveId: "a", file: "/sessions/a.jsonl" };

test("looking needs both: the window in use and this conversation on screen", () => {
	// The window in use shows it, by its process, by its file alone, or by both.
	expect(isLookingAt(true, { liveId: "a", file: "/sessions/a.jsonl" }, conversation)).toBe(true);
	expect(isLookingAt(true, { liveId: "a", file: null }, conversation)).toBe(true);
	expect(isLookingAt(true, { liveId: null, file: "/sessions/a.jsonl" }, conversation)).toBe(true);

	// The window in use shows another conversation, or another page.
	expect(isLookingAt(true, { liveId: "b", file: "/sessions/b.jsonl" }, conversation)).toBe(false);
	expect(isLookingAt(true, null, conversation)).toBe(false);
	expect(isLookingAt(true, undefined, conversation)).toBe(false);

	// It shows this conversation and the person is elsewhere: another app in front, the tab behind, the window not the key one.
	expect(isLookingAt(false, { liveId: "a", file: "/sessions/a.jsonl" }, conversation)).toBe(false);
	expect(isLookingAt(false, null, conversation)).toBe(false);
});

test("two conversations that have no file are not one: an unsaved process matches by its process alone", () => {
	const unsaved = { liveId: "n", file: null };
	expect(isLookingAt(true, { liveId: "n", file: null }, unsaved)).toBe(true);
	// Another unsaved conversation is on screen: both have no file, which is not a match.
	expect(isLookingAt(true, { liveId: "m", file: null }, unsaved)).toBe(false);
	// A view that names no process and no file shows nothing of anybody.
	expect(isLookingAt(true, { liveId: null, file: null }, unsaved)).toBe(false);
	expect(isLookingAt(true, { liveId: null, file: null }, conversation)).toBe(false);
});

test("a saved conversation is the one on screen after its process was started again: by its file", () => {
	// The view still names the old process; the file is the same one the new process runs.
	expect(
		isLookingAt(true, { liveId: "old", file: "/sessions/a.jsonl" }, { liveId: "new", file: "/sessions/a.jsonl" }),
	).toBe(true);
	// A different file under the same process id is not it.
	expect(isLookingAt(true, { liveId: null, file: "/sessions/c.jsonl" }, conversation)).toBe(false);
});

const info = (liveId: string, sessionFile: string | null, exited = false): LiveInfo => ({
	liveId,
	pid: 1,
	cwd: "/p",
	sessionFile,
	sessionId: null,
	args: [],
	startedAt: 0,
	streaming: false,
	exited,
	subscribers: 1,
	pausedAt: null,
	mode: "full",
});

test("what a view shows: only a conversation, named by its process and file; a saved one opened from the list finds its process", () => {
	const lives = {
		a: initialLive(info("a", "/sessions/a.jsonl")),
		gone: initialLive(info("gone", "/sessions/g.jsonl", true)),
	};
	const chat = (liveId: string | null, file: string | null): View => ({ kind: "chat", liveId, file });

	expect(shownConversation({ kind: "usage" }, lives)).toBeNull();
	expect(shownConversation({ kind: "settings" }, lives)).toBeNull();
	expect(shownConversation(chat("a", "/sessions/a.jsonl"), lives)).toEqual({ liveId: "a", file: "/sessions/a.jsonl" });
	// Opened from the list by its file: the process that runs it now is the one it is notified under.
	expect(shownConversation(chat(null, "/sessions/a.jsonl"), lives)).toEqual({ liveId: "a", file: "/sessions/a.jsonl" });
	// A file whose process has exited has none to name.
	expect(shownConversation(chat(null, "/sessions/g.jsonl"), lives)).toEqual({
		liveId: null,
		file: "/sessions/g.jsonl",
	});
	// A new conversation that has no file yet.
	expect(shownConversation(chat("n", null), lives)).toEqual({ liveId: "n", file: null });
});
