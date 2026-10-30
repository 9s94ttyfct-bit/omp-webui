import { afterAll, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { FamilyCache } from "../../server/family.ts";
import { parseSessionText } from "../../server/sessions/parse.ts";
import { SessionStore } from "../../server/sessions/store.ts";
import type { FamilyDocument, SessionEntry, SessionFileData } from "../../shared/protocol.ts";
import { writeBigSession } from "../support/big-session.ts";
import { restoreMembers } from "../support/family-restore.ts";

/**
 * omp's `fork` and `branch` write a new file with the whole path from the root copied (entry ids kept): a family of a
 * conversation and three of its forks holds that path four times, and the server sent it four times (a 50 MB
 * conversation and three forks: 210 MB of JSON, 81 MB of it gzipped, every time any member of the family was written to).
 *
 * A client that can put the shared entries back together asks for that (`x-family-dedup`), and is sent the shared path
 * once: each file says which entries it has (`order`), and the entries themselves are in that file or in an earlier
 * one. A client puts them back (`restoreMembers` of `tests/support/family-restore.ts`) and ends up with what it always had.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-family-dedup-"));
const stores: SessionStore[] = [];
afterAll(() => {
	for (const s of stores) s.close();
	rmSync(root, { recursive: true, force: true });
});

let cases = 0;
const STAMP = "2026-01-08T00:00:00.000Z";
const entry = (id: string, parentId: string | null, text: string): SessionEntry =>
	({
		type: "message",
		id,
		parentId,
		timestamp: STAMP,
		message: { role: "user", content: [{ type: "text", text }] },
	}) as SessionEntry;

/** A fork of `source`: its header names it as the parent, everything before `extra` is copied, `extra` is the fork's own work. */
function fork(source: string, n: number, extra: SessionEntry[]): string {
	const lines = readFileSync(source, "utf8").trimEnd().split("\n");
	const header = JSON.parse(lines[0] as string);
	const id = `01a00000-0000-7000-8000-0000000000f${n}`;
	lines[0] = JSON.stringify({ ...header, id, parentSession: source });
	const file = join(dirname(source), `2026-01-08T00-0${n}-00-000Z_${id}.jsonl`);
	writeFileSync(file, `${[...lines, ...extra.map((e) => JSON.stringify(e))].join("\n")}\n`);
	return file;
}

/** A conversation of about `bytes` with `forks` forks of it (the last a fork of the one before: it also carries that one's work). */
async function lineage(bytes: number, forks: number) {
	const dir = realpathSync(mkdirSync(join(root, `case-${cases++}`), { recursive: true }) as string);
	const base = realpathSync(writeBigSession(dir, bytes));
	const files = [base];
	const lastId = (file: string) => (parseSessionText(readFileSync(file, "utf8")).entries.at(-1) as SessionEntry).id;
	for (let n = 1; n <= forks; n++) {
		const parent = n === forks && forks > 1 ? (files.at(-1) as string) : base;
		files.push(
			fork(parent, n, [
				entry(`fork${n}-a`, lastId(parent), `work of fork ${n}`),
				entry(`fork${n}-b`, `fork${n}-a`, "more"),
			]),
		);
	}
	const store = new SessionStore(join(dir, "sessions"), join(dir, "index.db"));
	stores.push(store);
	await store.list();
	const cache = new FamilyCache(store);
	/** `have`: the tags of the files a client that views the family holds (`x-family-have`). */
	const ask = async (file: string, dedup = true, have: string[] = []) => {
		const res = await cache.respond(
			new Request("http://x/", {
				headers: {
					"accept-encoding": "gzip",
					...(dedup ? { "x-family-dedup": "1" } : {}),
					...(have.length ? { "x-family-have": have.join(",") } : {}),
				},
			}),
			file,
		);
		const bytes = new Uint8Array(await res.arrayBuffer());
		const sent: FamilyDocument = JSON.parse(gunzipSync(bytes).toString());
		return {
			status: res.status,
			etag: res.headers.get("etag"),
			said: res.headers.get("x-family-dedup"),
			bytes,
			sent,
			doc: sent as { file: string; members: SessionFileData[] },
		};
	};
	return { files, base, store, cache, ask };
}

const whole = (file: string) => parseSessionText(readFileSync(file, "utf8")).entries;

test("a family of a conversation and three forks of it is sent about as big as the conversation, not four times it", async () => {
	const { files, ask } = await lineage(3 * 1024 * 1024, 3);
	const { doc } = await ask(files[0] as string);
	const sent = JSON.stringify(doc).length;
	const base = readFileSync(files[0] as string).length;
	// The shared path once, and what each fork added.
	expect(sent).toBeLessThan(base * 1.2);
	// The conversation first, then its forks as the lineage lists them.
	expect(doc.members[0]?.file).toBe(files[0]);
	expect(doc.members.map((m) => m.file).sort()).toEqual([...files].sort());
	// The conversation is whole; a fork carries its own entries and says which entries its file has.
	expect(doc.members[0]?.entries.length).toBe(whole(files[0] as string).length);
	expect(doc.members[0]?.order).toBeUndefined();
	const own = doc.members.slice(1).flatMap((m) => m.entries.map((e) => e.id));
	expect(own.sort()).toEqual(["fork1-a", "fork1-b", "fork2-a", "fork2-b", "fork3-a", "fork3-b"]);
	for (const member of doc.members.slice(1)) expect(member.order).toEqual(whole(member.file).map((e) => e.id));
});

test("a client that does not ask for it is sent every file whole, as before", async () => {
	const { files, ask } = await lineage(1024 * 1024, 3);
	const { doc, said } = await ask(files[0] as string, false);
	// Nothing is said about the shared path, so the client cannot read the document as a shared one.
	expect(said).toBeNull();
	for (const member of doc.members) {
		expect(member.order).toBeUndefined();
		expect(member.entries).toEqual(whole(member.file));
	}
});

test("the page gets every file's entries back, as the files have them, from any file of the family", async () => {
	const { files, ask } = await lineage(1024 * 1024, 3);
	for (const requested of [files[0], files[2], files[3]] as string[]) {
		const { doc } = await ask(requested);
		const members = restoreMembers(doc.members);
		for (const m of members) {
			expect(m.entries, m.file).toEqual(whole(m.file));
			expect(m.order).toBeUndefined();
		}
		// What the tree is built from: a member's last entry is the head of its file, and an entry of two files is one object.
		expect(members.map((m) => m.entries.at(-1)?.id)).toEqual(members.map((m) => whole(m.file).at(-1)?.id));
		const shared = members[0]?.entries.at(5) as SessionEntry;
		expect(members[1]?.entries.at(5)).toBe(shared);
	}
});

test("a conversation with no fork is sent as it always was, and one transcript (/api/session) is never cut down", async () => {
	const { files, ask, store } = await lineage(512 * 1024, 1);
	const lone = await lineage(512 * 1024, 0);
	const { doc } = await ask(lone.files[0] as string);
	expect(doc.members).toHaveLength(1);
	expect(doc.members[0]?.order).toBeUndefined();
	expect(doc.members[0]?.entries).toEqual(whole(lone.files[0] as string));

	// A fork's own transcript, whole, for the page that asks for just that file.
	const forkFile = files[1] as string;
	const res = await new FamilyCache(store).respondSession(
		new Request("http://x/", { headers: { "accept-encoding": "gzip" } }),
		forkFile,
	);
	const single = JSON.parse(gunzipSync(await res.arrayBuffer()).toString()) as SessionFileData;
	expect(single.order).toBeUndefined();
	expect(single.entries).toEqual(whole(forkFile));
});

test("the shared path sent once and the whole path are two documents, each with its own ETag", async () => {
	const { files, ask } = await lineage(512 * 1024, 2);
	const deduped = await ask(files[0] as string);
	const whole_ = await ask(files[0] as string, false);
	// A client that keeps the ETag of one is not answered with the other.
	expect(deduped.etag).not.toBe(whole_.etag);
	expect(deduped.said).toBe("1");
	expect(whole_.said).toBeNull();
	expect(deduped.bytes.byteLength).toBeLessThan(whole_.bytes.byteLength);
});

test("a fork that is written to is sent again, and the other members with it", async () => {
	const { files, ask, cache } = await lineage(512 * 1024, 2);
	const first = await ask(files[0] as string);
	// A fork grows: the family is a new document, and the shared path is sent once again.
	const forkFile = files[1] as string;
	writeFileSync(forkFile, `${readFileSync(forkFile, "utf8")}${JSON.stringify(entry("fork1-c", "fork1-b", "later"))}\n`);
	const grown = await cache.respond(
		new Request("http://x/", { headers: { "accept-encoding": "gzip", "x-family-dedup": "1" } }),
		files[0] as string,
	);
	expect(grown.headers.get("etag")).not.toBe(first.etag);
	const doc = JSON.parse(gunzipSync(await grown.arrayBuffer()).toString()) as { members: SessionFileData[] };
	const members = restoreMembers(doc.members);
	for (const m of members) expect(m.entries, m.file).toEqual(whole(m.file));
});

/** The file as it is after omp wrote one more entry to it. */
function write(file: string, id: string): void {
	const last = whole(file).at(-1) as SessionEntry;
	writeFileSync(file, `${readFileSync(file, "utf8")}${JSON.stringify(entry(id, last.id, "later"))}\n`);
}

test("a write to one fork sends a tab that holds the family that fork only, and the page has every file as it is", async () => {
	// Every fork in turn (the last is a fork of the one before it, which it shares entries with) is written to while a
	// tab views the conversation. Each case has its own files.
	for (const written of [1, 2, 3]) {
		const { files, ask } = await lineage(3 * 1024 * 1024, 3);
		const first = await ask(files[0] as string);
		const held = new Map(restoreMembers(first.sent.members).flatMap((m) => (m.tag ? [[m.tag, m] as const] : [])));
		expect(held.size).toBe(files.length);

		write(files[written] as string, `late-${written}`);
		const next = await ask(files[0] as string, true, [...held.keys()]);

		// Only the fork that was written to is sent; the others are named.
		const sentFiles = next.sent.members.filter((m) => !("kept" in m)).map((m) => m.file);
		expect(sentFiles).toEqual([files[written]]);
		expect(next.sent.members.map((m) => m.file).sort()).toEqual([...files].sort());
		// The conversation was 3 MB: what the tab downloads is the fork's own work and the list of the entries of its file.
		expect(next.bytes.byteLength).toBeLessThan(first.bytes.byteLength / 20);
		// The fork's entries that a file before it has (held, and not sent) are not among the ones sent.
		const mine = next.sent.members.find((m) => !("kept" in m)) as SessionFileData;
		const before = next.sent.members
			.slice(0, next.sent.members.indexOf(mine))
			.flatMap((m) => whole(m.file).map((e) => e.id));
		expect(mine.entries.map((e) => e.id).filter((id) => before.includes(id))).toEqual([]);
		expect(mine.entries.map((e) => e.id)).toContain(`late-${written}`);

		// The page, with what it held, has every file as it is on disk, and the entries two files share are one object.
		const members = restoreMembers(next.sent.members, held);
		for (const m of members) expect(m.entries, m.file).toEqual(whole(m.file));
		expect(members.map((m) => m.tag)).not.toContain(undefined);
		for (const m of members.filter((m) => m.file !== files[written])) {
			expect(m).toBe(held.get(m.tag as string) as SessionFileData);
		}
		expect(members.find((m) => m.file === files[written])?.entries[5]).toBe(members[0]?.entries[5]);
	}
});

test("a write to the conversation itself sends it again, and the forks of it are the files the tab holds", async () => {
	const { files, ask } = await lineage(1024 * 1024, 3);
	const first = await ask(files[0] as string);
	const held = new Map(restoreMembers(first.sent.members).flatMap((m) => (m.tag ? [[m.tag, m] as const] : [])));
	write(files[0] as string, "late-base");
	const next = await ask(files[0] as string, true, [...held.keys()]);
	expect(next.sent.members.filter((m) => !("kept" in m)).map((m) => m.file)).toEqual([files[0]]);
	const members = restoreMembers(next.sent.members, held);
	for (const m of members) expect(m.entries, m.file).toEqual(whole(m.file));
});

test("files named by a client that did not ask for the shared path are ignored: it is sent every file whole", async () => {
	const { files, ask } = await lineage(512 * 1024, 2);
	const first = await ask(files[0] as string);
	const tags = restoreMembers(first.sent.members).flatMap((m) => (m.tag ? [m.tag] : []));
	write(files[1] as string, "late-1");
	const next = await ask(files[0] as string, false, tags);
	expect(next.said).toBeNull();
	for (const m of next.doc.members) expect(m.entries, m.file).toEqual(whole(m.file));
});

test("a fork rewritten in place, with its size and modification time kept, is sent again, not kept", async () => {
	// A restore that keeps times (`rsync -t`, `cp -p`, `touch -r`) leaves the file's size and modification time as they
	// were: only the change time and the inode of a file that was replaced tell it from the one a client holds.
	const { files, ask } = await lineage(512 * 1024, 3);
	// The fork's modification time is a whole millisecond, as a file system with coarse times gives it.
	const rewritten = files[1] as string;
	const mtimeMs = Date.UTC(2026, 0, 8, 0, 0, 0);
	utimesSync(rewritten, new Date(mtimeMs), new Date(mtimeMs));
	const first = await ask(files[0] as string);
	const held = new Map(restoreMembers(first.sent.members).flatMap((m) => (m.tag ? [[m.tag, m] as const] : [])));

	// The first fork is rewritten with the same text length, and its modification time is put back: what a restore
	// that keeps times (`rsync -t`, `cp -p`, `touch -r`) does.
	const text = readFileSync(rewritten, "utf8");
	writeFileSync(rewritten, text.replace("work of fork 1", "work of fork X"));
	utimesSync(rewritten, new Date(mtimeMs), new Date(mtimeMs));
	expect(statSync(rewritten).mtimeMs).toBe(mtimeMs);
	expect(statSync(rewritten).size).toBe(text.length);
	// Another fork is written to, so the family is asked for again.
	write(files[2] as string, "late-2");

	const next = await ask(files[0] as string, true, [...held.keys()]);
	const sentFiles = next.sent.members.filter((m) => !("kept" in m)).map((m) => m.file);
	// The rewritten fork is not the file the page holds: it is sent, with its new text.
	expect(sentFiles).toContain(rewritten);
	const again = next.sent.members.find((m) => !("kept" in m) && m.file === rewritten) as SessionFileData;
	expect(JSON.stringify(again.entries)).toContain("work of fork X");
	// The page, with what it held, has the fork as it is on disk.
	const members = restoreMembers(next.sent.members, held);
	for (const m of members) expect(m.entries, m.file).toEqual(whole(m.file));
});

test("the files a client names do not change what a client that names none is sent, nor its ETag", async () => {
	const { files, ask } = await lineage(512 * 1024, 2);
	const first = await ask(files[0] as string);
	const tags = restoreMembers(first.sent.members).flatMap((m) => (m.tag ? [m.tag] : []));
	write(files[1] as string, "late-1");
	const partial = await ask(files[0] as string, true, tags);
	const full = await ask(files[0] as string);
	// One document, however much of it a client is sent.
	expect(partial.etag).toBe(full.etag);
	expect(full.sent.members.every((m) => !("kept" in m))).toBe(true);
	expect(partial.bytes.byteLength).toBeLessThan(full.bytes.byteLength);
	for (const m of restoreMembers(full.sent.members)) expect(m.entries, m.file).toEqual(whole(m.file));
});
