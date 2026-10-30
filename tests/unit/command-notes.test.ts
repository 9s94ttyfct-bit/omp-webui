import { expect, test } from "bun:test";
import type { LiveInfo, OmpFrame, SessionEntry } from "../../shared/protocol.ts";
import {
	commandText,
	loadCommandNotes,
	type NoteStorage,
	rememberCommandNotes,
	saveCommandNotes,
} from "../../web/src/lib/command-notes.ts";
import { type CommandNote, noticeOf, withLiveNotices } from "../../web/src/lib/notices.ts";
import { indexTree } from "../../web/src/lib/tree.ts";
import { segmentTranscript } from "../../web/src/lib/turns.ts";
import { applyFrame, initialLive, type LiveState } from "../../web/src/store/live.ts";

/**
 * What a command prints is placed where the command was run, and kept by the conversation's file. The page's
 * `localStorage` is a Map here, and the frames are the ones omp sends.
 */

const info: LiveInfo = {
	liveId: "L1",
	pid: 1,
	cwd: "/",
	sessionFile: "/sessions/a.jsonl",
	sessionId: "a",
	args: [],
	startedAt: 0,
	streaming: false,
	exited: false,
	subscribers: 1,
	pausedAt: null,
	mode: "full",
};

const entry = (id: string): SessionEntry =>
	({
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content: [{ type: "text", text: id }], attribution: "user" },
	}) as SessionEntry;

const output = (text: string): OmpFrame => ({ type: "command_output", text });

const note = (
	seq: number,
	after: string | null,
	text: string,
	file: string | null = "/sessions/a.jsonl",
): CommandNote => ({
	kind: "command",
	seq,
	at: seq,
	after,
	file,
	text,
});

/** A browser's localStorage: what a page wrote is what the next one reads. */
function memory(): NoteStorage & { values: Map<string, string> } {
	const values = new Map<string, string>();
	return {
		values,
		getItem: (k) => values.get(k) ?? null,
		setItem: (k, v) => void values.set(k, v),
	};
}

const live = (entries: SessionEntry[]): LiveState => ({ ...initialLive(info), entries });

test("a command's output is placed after the entry saved last when it came, with the file it belongs to", () => {
	const s = [output("one"), output("two")].reduce(applyFrame, live([entry("e1"), entry("e2")]));
	expect(s.commandOutput).toMatchObject([
		{ kind: "command", seq: 1, after: "e2", file: "/sessions/a.jsonl", text: "one" },
		{ kind: "command", seq: 2, after: "e2", file: "/sessions/a.jsonl", text: "two" },
	]);
	// A conversation with nothing saved yet: the output is before whatever is saved next.
	expect(applyFrame(live([]), output("first")).commandOutput[0].after).toBeNull();
});

test("what a command prints loses the terminal's escape sequences", () => {
	expect(commandText({ type: "command_output", text: "Used \u001b[38;2;0;180;255m11%\u001b[39m of the window" })).toBe(
		"Used 11% of the window",
	);
	expect(commandText({ type: "command_output", message: "said it" })).toBe("said it");
});

test("a note stays between the entries it was printed between, and a conversation with nothing saved shows it first", () => {
	const path = [entry("e1"), entry("e2"), entry("e3")];
	const rows = withLiveNotices(path, [note(1, "e1", "after one"), note(2, null, "before all")]);
	expect(
		rows.map((e) => (noticeOf(e)?.kind === "command" ? `note:${(noticeOf(e) as CommandNote).text}` : e.id)),
	).toEqual(["note:before all", "e1", "note:after one", "e2", "e3"]);
});

test("a note for an entry that is not on the branch shown is left out, and notes are named apart from other notices", () => {
	const path = [entry("e1")];
	const rows = withLiveNotices(path, [
		note(1, "elsewhere", "another branch's"),
		note(1, "e1", "mine"),
		{ kind: "fallbackDone", model: "m", seq: 1, at: 3, after: "e1" },
	]);
	expect(rows.map((e) => e.id)).toEqual(["e1", "live-notice-cmd-1", "live-notice-1"]);
});

test("what a command printed after a reply is a row of its own, between the turn and what follows, not a step of the turn", () => {
	const reply = (id: string, parentId: string): SessionEntry =>
		({
			type: "message",
			id,
			parentId,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: { role: "assistant", content: [{ type: "text", text: id }] },
		}) as SessionEntry;
	const path = [entry("u1"), reply("a1", "u1"), entry("u2")];
	const rows = withLiveNotices(path, [note(1, "a1", "printed")]);
	const segments = segmentTranscript(rows, indexTree(path));
	expect(
		segments.map((s) => (s.kind === "prompt" ? `prompt:${s.entry.id}` : `turn:${s.turn.rows.map((r) => r.id)}`)),
	).toEqual(["prompt:u1", "turn:a1", "prompt:live-notice-cmd-1", "prompt:u2"]);
	// Another notice (a rule applied) still belongs to the turn it came in.
	const inTurn = withLiveNotices(path, [{ kind: "fallbackDone", model: "m", seq: 1, at: 3, after: "a1" }]);
	expect(segmentTranscript(inTurn, indexTree(path)).map((s) => s.kind)).toEqual(["prompt", "turn", "prompt"]);
});

test("notes are kept by file, in order, and found again", () => {
	const storage = memory();
	saveCommandNotes("/sessions/a.jsonl", [note(1, "e1", "one"), note(2, "e2", "two")], storage);
	saveCommandNotes("/sessions/b.jsonl", [note(1, null, "other", "/sessions/b.jsonl")], storage);
	expect(loadCommandNotes("/sessions/a.jsonl", storage)).toEqual([note(1, "e1", "one"), note(2, "e2", "two")]);
	expect(loadCommandNotes("/sessions/b.jsonl", storage).map((n) => n.text)).toEqual(["other"]);
	expect(loadCommandNotes("/sessions/none.jsonl", storage)).toEqual([]);
	expect(loadCommandNotes(null, storage)).toEqual([]);
});

test("saving a file keeps only that file's notes of the list, the latest of them, each cut at a length", () => {
	const storage = memory();
	const many = Array.from({ length: 40 }, (_, i) => note(i + 1, `e${i}`, `n${i}`));
	saveCommandNotes("/sessions/a.jsonl", [...many, note(41, null, "x".repeat(30_000), "/sessions/b.jsonl")], storage);
	const kept = loadCommandNotes("/sessions/a.jsonl", storage);
	expect(kept).toHaveLength(30);
	expect(kept[0].text).toBe("n10");
	expect(kept.at(-1)?.text).toBe("n39");
	expect(loadCommandNotes("/sessions/b.jsonl", storage)).toEqual([]);
	saveCommandNotes("/sessions/b.jsonl", [note(1, null, "x".repeat(30_000), "/sessions/b.jsonl")], storage);
	expect(loadCommandNotes("/sessions/b.jsonl", storage)[0].text).toHaveLength(20_000);
});

test("only the latest 40 files are kept", () => {
	const storage = memory();
	for (let i = 0; i < 45; i++) saveCommandNotes(`/f${i}`, [note(1, null, `n${i}`, `/f${i}`)], storage);
	expect(loadCommandNotes("/f0", storage)).toEqual([]);
	expect(loadCommandNotes("/f4", storage)).toEqual([]);
	expect(loadCommandNotes("/f5", storage)).toHaveLength(1);
	expect(loadCommandNotes("/f44", storage)).toHaveLength(1);
});

test("a note taken out of the page's list is taken out of what is kept, and the last one leaves its file", () => {
	const storage = memory();
	const one = [note(1, "e1", "one")];
	rememberCommandNotes(one, [], storage);
	expect(loadCommandNotes("/sessions/a.jsonl", storage)).toHaveLength(1);
	rememberCommandNotes([], one, storage);
	expect(loadCommandNotes("/sessions/a.jsonl", storage)).toEqual([]);
});

test("what is not what was written is not trusted: damaged storage reads as nothing, damaged notes are dropped", () => {
	const storage = memory();
	storage.setItem("ompw.commandOutput", "{not json");
	expect(loadCommandNotes("/sessions/a.jsonl", storage)).toEqual([]);
	storage.setItem("ompw.commandOutput", JSON.stringify({ "/sessions/a.jsonl": [] }));
	expect(loadCommandNotes("/sessions/a.jsonl", storage)).toEqual([]);
	storage.setItem(
		"ompw.commandOutput",
		JSON.stringify([
			["/sessions/a.jsonl", [{ at: 1, after: "e1", text: "kept" }, { at: "x", after: 3, text: 4 }, null]],
			[7, []],
		]),
	);
	expect(loadCommandNotes("/sessions/a.jsonl", storage).map((n) => n.text)).toEqual(["kept"]);
});

test("a storage that refuses a write does not stop the page", () => {
	const refusing: NoteStorage = {
		getItem: () => null,
		setItem: () => {
			throw new DOMException("full", "QuotaExceededError");
		},
	};
	expect(() => saveCommandNotes("/sessions/a.jsonl", [note(1, null, "x")], refusing)).not.toThrow();
});
