import { afterAll, afterEach, expect, test } from "bun:test";
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineCursor } from "../../server/sessions/lines.ts";
import { emptyUsage, parseSessionText, summarize, withDependents } from "../../server/sessions/parse.ts";
import { SessionStore } from "../../server/sessions/store.ts";
import { SubagentIndex } from "../../server/sessions/subagents.ts";
import { writeBigSession } from "../support/big-session.ts";

/**
 * omp rewrites a transcript by writing a temporary file and renaming it over the original. A read of a large transcript
 * takes several chunks: when the rename comes between two of them, the read must not be made of both files (the seam
 * is garbled, and the offset it saved as "read up to here" is then wrong for good). Totals are those of the file as it is.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-race-"));
const restore: (() => void)[] = [];
afterEach(() => {
	for (const fn of restore.splice(0)) fn();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

let cases = 0;
function agentDir(): string {
	const dir = join(root, `case-${cases++}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** The same entries with an early one 200 KB longer: every byte after it moves. */
function enlarged(text: string): string {
	const lines = text.split("\n");
	const entry = JSON.parse(lines[5] as string);
	entry.message.content[0].text += " padding".repeat(25_000);
	lines[5] = JSON.stringify(entry);
	return lines.join("\n");
}

function replaceAtomically(file: string, text: string): void {
	writeFileSync(`${file}.rewrite`, text);
	renameSync(`${file}.rewrite`, file);
}

/** After `lines` lines have been handed out by any cursor, `act` runs, once: the read is in its later chunks by then. */
function afterLines(lines: number, act: () => void): void {
	const next = LineCursor.prototype.next;
	let handed = 0;
	let acted = false;
	LineCursor.prototype.next = function (this: LineCursor) {
		if (!acted && ++handed > lines) {
			acted = true;
			act();
		}
		return next.call(this);
	};
	restore.push(() => {
		LineCursor.prototype.next = next;
	});
}

/** One more request, as omp appends it. */
const request = (id: string, parentId: string): string =>
	`${JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-08T00:00:00.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "more" }],
			provider: "anthropic",
			model: "claude-haiku-5-5",
			usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 100, cost: { total: 0.001 } },
			stopReason: "stop",
		},
	})}\n`;

const SIZE = 10 * 1024 * 1024;
/** More lines than fit the first chunk (4 MB of ~6 KB entries), fewer than the file has. */
const RACE_AT = 1000;

function wholeFileSummary(file: string) {
	const own = summarize(file, parseSessionText(readFileSync(file, "utf8")), statSync(file), 0);
	if (!own) throw new Error("no header");
	return withDependents(own, { subagents: { count: 0, usage: emptyUsage() }, advisor: emptyUsage() });
}

test("a conversation replaced while its summary is read ends with the summary of the file as it is", async () => {
	const dir = agentDir();
	const file = writeBigSession(dir, SIZE);
	const rewritten = enlarged(readFileSync(file, "utf8"));
	const store = new SessionStore(join(dir, "sessions"), join(dir, "index.db"));
	try {
		afterLines(RACE_AT, () => replaceAtomically(file, rewritten));
		await store.refresh(true);
		// Whatever the first read made of it, the ones that follow (the file changed) are those of the file now.
		for (let i = 0; i < 3; i++) await store.refresh(true);
		expect(readFileSync(file, "utf8")).toBe(rewritten);
		expect(await store.get(file)).toEqual(wholeFileSummary(file));

		// And it goes on from there as a conversation does: appended entries are folded into the right totals.
		appendFileSync(file, request("after-1", "b0000000"));
		await store.refresh(true);
		expect(await store.get(file)).toEqual(wholeFileSummary(file));
	} finally {
		store.close();
	}
}, 60_000);

test("a transcript replaced while a subagent's usage is read ends with the usage of the file as it is", async () => {
	const dir = agentDir();
	const parent = writeBigSession(dir, 1024);
	const transcript = join(parent.replace(/\.jsonl$/, ""), "Scout.jsonl");
	mkdirSync(parent.replace(/\.jsonl$/, ""), { recursive: true });
	const source = writeBigSession(join(dir, "src"), SIZE);
	const text = readFileSync(source, "utf8");
	writeFileSync(transcript, text);
	const rewritten = enlarged(text);
	const index = new SubagentIndex();
	afterLines(RACE_AT, () => replaceAtomically(transcript, rewritten));
	await index.scan(parent);
	for (let i = 0; i < 3; i++) await index.scan(parent);

	const requests = async () => (await index.scan(parent)).subagents[0]?.usage;
	const whole = async () => (await new SubagentIndex().scan(parent)).subagents[0]?.usage;
	expect(await requests()).toEqual(await whole());

	for (const n of [1, 2, 3]) appendFileSync(transcript, request(`after-${n}`, "b0000000"));
	expect(await requests()).toEqual(await whole());
}, 60_000);

test("the full-text index of a conversation replaced while it is being indexed is that of the file as it is", async () => {
	// Indexing a library is seconds of work in its own thread, in pieces: the file is replaced in the middle of it. The
	// piece it happens in is up to the timing; whichever it is, what is found afterwards is what a fresh index finds.
	const dir = agentDir();
	const file = writeBigSession(dir, 40 * 1024 * 1024);
	const original = readFileSync(file, "utf8");
	const rewritten = enlarged(original);
	const probe = (JSON.parse(rewritten.split("\n")[1200] as string).message.content[0].text as string).split(" ");
	const words = [probe[0], probe[7], "padding"] as string[];

	const raced = new SessionStore(join(dir, "sessions"), join(dir, "index.db"));
	const freshDir = agentDir();
	const fresh = new SessionStore(join(freshDir, "sessions"), join(freshDir, "index.db"));
	try {
		await raced.list();
		// Indexing is under way (a few MB in), not done.
		await Bun.sleep(300);
		replaceAtomically(file, rewritten);
		// The server has not been told yet (no scan has run): the worker reads on, chunk after chunk, while the path names the new file.
		await Bun.sleep(1500);
		const copy = writeBigSession(freshDir, 1024);
		writeFileSync(copy, rewritten);
		await raced.indexed();
		await fresh.indexed();
		const hits = async (store: SessionStore, at: string) =>
			Promise.all(words.map(async (w) => (await store.search(w, 200, at)).map((h) => [h.entryId, h.snippet, h.more])));
		expect(await hits(raced, file)).toEqual(await hits(fresh, copy));
	} finally {
		raced.close();
		fresh.close();
	}
}, 120_000);
