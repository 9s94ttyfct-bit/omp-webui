import { expect, test } from "bun:test";
import {
	attentionNotice,
	attentionOf,
	conversationTitle,
	factsOf,
	NOTICE_TEXT,
	noticeLang,
	type WorkFacts,
	workCounts,
} from "../../shared/attention.ts";
import type { LiveInfo } from "../../shared/protocol.ts";
import { en } from "../../web/src/i18n/chat.ts";
import { zh } from "../../web/src/i18n/zh-CN/chat.ts";

/**
 * When a conversation needs somebody who is elsewhere, and what is said to them (#627): the one rule the page (tab title,
 * a browser's notifications) and the server (the macOS app's notifications and menu bar icon) share.
 */

const idle: WorkFacts = { needsInput: false, streaming: false, continuing: false };
const running: WorkFacts = { ...idle, streaming: true };
const between: WorkFacts = { ...idle, continuing: true };
const asking: WorkFacts = { ...idle, needsInput: true };

test("a dialog that opens, and a run that ends, are what a conversation can tell; nothing else is", () => {
	expect(attentionOf(idle, asking)).toEqual(["asking"]);
	expect(attentionOf(running, idle)).toEqual(["finished"]);
	// A turn that stops at a dialog is asking; it finishes when the dialog is answered and the turn ends.
	expect(attentionOf(running, { ...running, needsInput: true })).toEqual(["asking"]);
	expect(attentionOf({ ...running, needsInput: true }, running)).toEqual([]);
	expect(attentionOf({ ...running, needsInput: true }, idle)).toEqual(["finished"]);
	// A dialog that was already open is not news again, and a second turn of work is not an end.
	expect(attentionOf(asking, asking)).toEqual([]);
	expect(attentionOf(running, running)).toEqual([]);
	expect(attentionOf(idle, idle)).toEqual([]);
	expect(attentionOf(idle, running)).toEqual([]);
});

test("the end of a goal's run is the end of the run, not of each turn between", () => {
	expect(attentionOf(running, between)).toEqual([]);
	expect(attentionOf(between, running)).toEqual([]);
	expect(attentionOf(between, idle)).toEqual(["finished"]);
});

test("a process seen for the first time is news only if it already asks: it has no run to have ended", () => {
	expect(attentionOf(undefined, asking)).toEqual(["asking"]);
	expect(attentionOf(undefined, idle)).toEqual([]);
	expect(attentionOf(undefined, running)).toEqual([]);
});

const info = (over: Partial<LiveInfo> = {}): LiveInfo => ({
	liveId: "a",
	pid: 1,
	cwd: "/p",
	sessionFile: "/s/a.jsonl",
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

test("the server's word about a process is the same three facts the page keeps", () => {
	expect(factsOf(info())).toEqual(idle);
	expect(factsOf(info({ streaming: true }))).toEqual(running);
	expect(factsOf(info({ continuing: true }))).toEqual(between);
	expect(factsOf(info({ asking: true, streaming: true }))).toEqual({
		needsInput: true,
		streaming: true,
		continuing: false,
	});
});

test("the menu bar counts what works and what waits: a process that waits is not also working, a paused or ended one is neither", () => {
	expect(workCounts([])).toEqual({ working: 0, asking: 0 });
	expect(
		workCounts([
			info({ liveId: "w", streaming: true }),
			info({ liveId: "g", continuing: true }),
			// Its turn is still open, but it is waiting for the person.
			info({ liveId: "q", streaming: true, asking: true }),
			info({ liveId: "d", asking: true }),
			info({ liveId: "p", streaming: true, pausedAt: 1 }),
			info({ liveId: "x", streaming: true, exited: true }),
			info({ liveId: "i" }),
		]),
	).toEqual({ working: 2, asking: 2 });
});

test("the words are the saved language, else the Mac's, else English", () => {
	expect(noticeLang("zh-CN", "en")).toBe("zh-CN");
	expect(noticeLang("en", "zh-CN")).toBe("en");
	expect(noticeLang(null, "zh-CN")).toBe("zh-CN");
	expect(noticeLang(undefined, null)).toBe("en");
	// Not a language of the app: the next one in line.
	expect(noticeLang("fr", "zh-CN")).toBe("zh-CN");
	expect(noticeLang("fr", "de")).toBe("en");
});

test("a conversation is named by its title, else its first prompt, else by having no name", () => {
	expect(conversationTitle({ title: "Fix the build", preview: "please fix" }, "/f", "en")).toBe("Fix the build");
	expect(conversationTitle({ title: null, preview: "please fix" }, "/f", "en")).toBe("please fix");
	expect(conversationTitle({ title: "", preview: "" }, "/f", "en")).toBe("Untitled session");
	expect(conversationTitle(null, "/f", "zh-CN")).toBe("未命名对话");
	// No file yet: a new conversation.
	expect(conversationTitle(null, null, "en")).toBe("New conversation");
	expect(conversationTitle(undefined, null, "zh-CN")).toBe("新对话");
});

test("a notice carries what a click needs and replaces the earlier one of its conversation", () => {
	expect(attentionNotice("asking", "L1", "/s/a.jsonl", "Fix the build", "en")).toEqual({
		id: "L1",
		kind: "asking",
		title: "Fix the build",
		body: "Needs your input",
		liveId: "L1",
		file: "/s/a.jsonl",
	});
	expect(attentionNotice("finished", "L2", null, "新对话", "zh-CN")).toEqual({
		id: "L2",
		kind: "finished",
		title: "新对话",
		body: "已完成",
		liveId: "L2",
		file: null,
	});
});

test("the server's words are the page's own: one thing said in two places stays one thing", () => {
	expect(NOTICE_TEXT.en).toEqual({
		asking: en.notifyAsking,
		finished: en.notifyFinished,
		untitled: en.untitledSession,
		fresh: en.newConversation,
	});
	expect(NOTICE_TEXT["zh-CN"]).toEqual({
		asking: zh.notifyAsking,
		finished: zh.notifyFinished,
		untitled: zh.untitledSession,
		fresh: zh.newConversation,
	});
});
