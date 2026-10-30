import { LANGS } from "./prefs.ts";
import type { LiveInfo } from "./protocol.ts";

/**
 * When a conversation needs somebody who is not looking at it, and what is said to them. The page decides it for the tab title
 * and for the notifications of a browser; the server decides it for the macOS app, whose notifications come from the
 * app itself (`server/shell-events.ts`) so that nothing depends on a page that may not be there, and for Web Push. All of them
 * decide it here, and who is "not looking" is `isLookingAt`: the same rule in every channel.
 */

/** What of a conversation decides it: a turn is running or a goal's run is between two of its turns, and a dialog waits. */
export interface WorkFacts {
	/** A dialog (a tool approval, a question) waits for the user's answer. */
	needsInput: boolean;
	streaming: boolean;
	/** A turn of an active goal ended and the next one has not begun: the run is not over (`LiveInfo.continuing`). */
	continuing: boolean;
}

/** omp is at work on the conversation: a turn is running, or a goal run is between two of its turns. */
export function working(s: Pick<WorkFacts, "streaming" | "continuing">): boolean {
	return s.streaming || s.continuing;
}

/** What the server says of a process (`LiveInfo`): the same three things, `asking` being the dialog. */
export function factsOf(info: Pick<LiveInfo, "streaming" | "asking" | "continuing">): WorkFacts {
	return { needsInput: info.asking === true, streaming: info.streaming, continuing: info.continuing === true };
}

export type AttentionKind = "asking" | "finished";

/**
 * What changed for a process that is still running, between what was known of it (`before`: undefined for one not seen yet)
 * and what is now: it started waiting for an answer, and/or its run ended (a turn, or a goal's whole run, which is many
 * turns; not a process that died, which the caller leaves out). A process first seen already asking is news; one first seen
 * finished is not: there was no run to end.
 */
export function attentionOf(before: WorkFacts | undefined, now: WorkFacts): AttentionKind[] {
	const kinds: AttentionKind[] = [];
	if (now.needsInput && !before?.needsInput) kinds.push("asking");
	if (before && working(before) && !working(now)) kinds.push("finished");
	return kinds;
}

/**
 * What a window shows of the conversations: the one on screen, by its process and by its file (a view may know only one of
 * the two), or none (`null`: another page is on screen).
 */
export interface Shown {
	liveId: string | null;
	file: string | null;
}

/**
 * Whether somebody is looking at a conversation, which is the only time a notification of it is not wanted: their window
 * (a tab, the app's window) is the one in use AND this conversation is the one on screen in it. A window in use that shows
 * another conversation or another page is not looking at it; nor is a window that shows it while the person is elsewhere
 * (the tab hidden, the window behind another, another app in front). `focused`: the window is in use; `shown`: what it shows.
 */
export function isLookingAt(
	focused: boolean,
	shown: Shown | null | undefined,
	conversation: { liveId: string; file: string | null },
): boolean {
	if (!focused || !shown) return false;
	if (shown.liveId !== null && shown.liveId === conversation.liveId) return true;
	return shown.file !== null && conversation.file !== null && shown.file === conversation.file;
}

/** How many conversations work and how many wait for an answer: what the macOS app's menu bar icon says. */
export interface WorkCounts {
	working: number;
	asking: number;
}

/**
 * Counted from what the server lists: a process that ended, or is paused (frozen: it does nothing until resumed), counts for
 * neither; one that waits for an answer counts as waiting, not as working, though its turn is still open.
 */
export function workCounts(
	infos: Iterable<Pick<LiveInfo, "exited" | "pausedAt" | "streaming" | "asking" | "continuing">>,
): WorkCounts {
	const counts: WorkCounts = { working: 0, asking: 0 };
	for (const info of infos) {
		if (info.exited || info.pausedAt !== null) continue;
		const facts = factsOf(info);
		if (facts.needsInput) counts.asking++;
		else if (working(facts)) counts.working++;
	}
	return counts;
}

// ------------------------------------------------------------------ the words

export type NoticeLang = (typeof LANGS)[number];

/**
 * The words of a notification, in the interface languages: the same as `chat.notifyAsking`, `notifyFinished`,
 * `untitledSession` and `newConversation` of the page (`tests/unit/attention-text.test.ts` holds the two to each other),
 * for the server, which has no page's strings to ask.
 */
export const NOTICE_TEXT: Record<NoticeLang, { asking: string; finished: string; untitled: string; fresh: string }> = {
	en: { asking: "Needs your input", finished: "Finished", untitled: "Untitled session", fresh: "New conversation" },
	"zh-CN": { asking: "需要你的输入", finished: "已完成", untitled: "未命名对话", fresh: "新对话" },
};

/** The language words are in: the one the person saved (`ompw.lang`), else the one the app's Mac prefers, else English. */
export function noticeLang(stored: string | null | undefined, fallback?: string | null): NoticeLang {
	return LANGS.find((l) => l === stored) ?? LANGS.find((l) => l === fallback) ?? "en";
}

/** What names a conversation: its saved title, else its first prompt, else that it has no name (and whether it has a file). */
export function conversationTitle(
	named: { title?: string | null; preview?: string | null } | null | undefined,
	file: string | null,
	lang: NoticeLang,
): string {
	return named?.title || named?.preview || (file ? NOTICE_TEXT[lang].untitled : NOTICE_TEXT[lang].fresh);
}

/** A notification as the macOS app shows it, and what a click on it opens. */
export interface AttentionNotice {
	/** Showing another with the same id replaces it: one per conversation. */
	id: string;
	kind: AttentionKind;
	title: string;
	body: string;
	/** What a click opens: the conversation's process, and its saved file when it has one. */
	liveId: string;
	file: string | null;
}

export function attentionNotice(
	kind: AttentionKind,
	liveId: string,
	file: string | null,
	title: string,
	lang: NoticeLang,
): AttentionNotice {
	return { id: liveId, kind, title, body: NOTICE_TEXT[lang][kind], liveId, file };
}
