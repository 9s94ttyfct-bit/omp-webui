import { expect, test } from "bun:test";
import {
	flushDrafts,
	forgetDraft,
	hydrateDrafts,
	keepDraft,
	MAX_DRAFTS,
	MAX_PERSISTED_IMAGE_CHARS,
	moveDraft,
	PERSIST_DELAY_MS,
	readDraft,
} from "../../web/src/lib/drafts.ts";

/** Unsent composer contents are kept per conversation, up to a limit, and follow a conversation to its file. */

const text = (t: string) => ({ text: t, images: [] });

test("an empty draft is forgotten; forgetting a key drops only that one", () => {
	keepDraft("k1", text("a"));
	keepDraft("k2", text("b"));
	keepDraft("k1", text(""));
	expect(readDraft("k1")).toBeUndefined();
	forgetDraft("k2");
	expect(readDraft("k2")).toBeUndefined();
});

test("only the newest MAX_DRAFTS are kept, and writing a draft makes it the newest", () => {
	for (let i = 0; i < MAX_DRAFTS; i++) keepDraft(`cap${i}`, text(`d${i}`));
	// The oldest is written again: it is no longer the one to go.
	keepDraft("cap0", text("again"));
	keepDraft("cap-extra", text("x"));
	expect(readDraft("cap1")).toBeUndefined();
	expect(readDraft("cap0")?.text).toBe("again");
	expect(readDraft("cap-extra")?.text).toBe("x");
	expect(readDraft(`cap${MAX_DRAFTS - 1}`)?.text).toBe(`d${MAX_DRAFTS - 1}`);
	for (let i = 0; i <= MAX_DRAFTS; i++) forgetDraft(`cap${i}`);
	forgetDraft("cap-extra");
});

test("a draft follows its conversation to the new key; nothing to move leaves the target alone", () => {
	keepDraft("live-1", { text: "typed before the file existed", images: [] });
	keepDraft("/s/file.jsonl", text("old"));
	moveDraft("live-1", "/s/file.jsonl");
	expect(readDraft("live-1")).toBeUndefined();
	expect(readDraft("/s/file.jsonl")?.text).toBe("typed before the file existed");

	moveDraft("live-2", "/s/file.jsonl");
	expect(readDraft("/s/file.jsonl")?.text).toBe("typed before the file existed");
	forgetDraft("/s/file.jsonl");
});

// ---------------------------------------------------------------------------------- the mirror in session storage

/** A session storage of the tab: what a reload keeps. `limit` makes a write that is longer fail, as a full one does. */
function tabStorage(limit = Number.POSITIVE_INFINITY) {
	const data = new Map<string, string>();
	return {
		data,
		getItem: (k: string) => data.get(k) ?? null,
		setItem: (k: string, v: string) => {
			if (v.length > limit) throw new DOMException("full", "QuotaExceededError");
			data.set(k, v);
		},
		removeItem: (k: string) => void data.delete(k),
	};
}

const picture = (chars: number, id = "p") => ({
	type: "image" as const,
	data: "A".repeat(chars),
	mimeType: "image/png",
	name: "dot.png",
	id,
});

/** What a reload does: a new page reads the storage the old one left. */
function reload(storage: ReturnType<typeof tabStorage>, keys: string[]) {
	for (const k of keys) forgetDraft(k);
	hydrateDrafts(storage);
}

test("a draft is mirrored once typing pauses; a flush writes it at once; a reload brings it back with its pictures", async () => {
	const storage = tabStorage();
	hydrateDrafts(storage);
	keepDraft("m/a", { text: "typed", images: [picture(100)] });
	// Not on every key: nothing is written until the delay has passed, or the page says it is going.
	expect(storage.data.size).toBe(0);
	await Bun.sleep(PERSIST_DELAY_MS + 100);
	expect(storage.data.size).toBe(1);

	keepDraft("m/b", text("second"));
	flushDrafts();
	reload(storage, ["m/a", "m/b"]);
	expect(readDraft("m/a")).toEqual({ text: "typed", images: [picture(100)] });
	expect(readDraft("m/b")?.text).toBe("second");
	forgetDraft("m/a");
	forgetDraft("m/b");
});

test("a burst of changes is one write, and what was forgotten is gone after a reload", async () => {
	const storage = tabStorage();
	let writes = 0;
	const counted = {
		...storage,
		setItem: (k: string, v: string) => {
			writes++;
			storage.setItem(k, v);
		},
	};
	hydrateDrafts(counted);
	for (const t of ["h", "he", "hel", "hell", "hello"]) keepDraft("burst", text(t));
	await Bun.sleep(PERSIST_DELAY_MS + 100);
	expect(writes).toBe(1);

	forgetDraft("burst");
	flushDrafts();
	expect(storage.data.has("ompw.drafts")).toBe(false);
	reload(storage, []);
	expect(readDraft("burst")).toBeUndefined();
});

test("what a reload finds is read leniently: junk, wrong shapes and half a picture are left out", () => {
	const storage = tabStorage();
	storage.data.set(
		"ompw.drafts",
		JSON.stringify([
			["ok", { text: "kept", images: [picture(4), { type: "image", data: 5 }] }],
			["no-text", { images: [] }],
			["empty", { text: "", images: [] }],
			[7, { text: "x", images: [] }],
			"nonsense",
		]),
	);
	hydrateDrafts(storage);
	expect(readDraft("ok")).toEqual({ text: "kept", images: [picture(4)] });
	expect(readDraft("no-text")).toBeUndefined();
	expect(readDraft("empty")).toBeUndefined();
	forgetDraft("ok");

	storage.data.set("ompw.drafts", "{not json");
	hydrateDrafts(storage);
	storage.data.set("ompw.drafts", JSON.stringify({ not: "a list" }));
	hydrateDrafts(storage);
});

test("pictures are mirrored within a cap, the newest draft first; a draft that does not fit keeps its text", () => {
	const storage = tabStorage();
	hydrateDrafts(storage);
	const big = Math.floor(MAX_PERSISTED_IMAGE_CHARS * 0.6);
	keepDraft("cap/old", { text: "old text", images: [picture(big, "old")] });
	keepDraft("cap/new", { text: "new text", images: [picture(big, "new")] });
	flushDrafts();
	reload(storage, ["cap/old", "cap/new"]);
	expect(readDraft("cap/new")?.images).toEqual([picture(big, "new")]);
	expect(readDraft("cap/old")).toEqual({ text: "old text", images: [] });

	// One picture over the whole cap is dropped; its text stays.
	keepDraft("cap/huge", { text: "huge text", images: [picture(MAX_PERSISTED_IMAGE_CHARS + 1)] });
	flushDrafts();
	reload(storage, ["cap/old", "cap/new", "cap/huge"]);
	expect(readDraft("cap/huge")).toEqual({ text: "huge text", images: [] });
	for (const k of ["cap/old", "cap/new", "cap/huge"]) forgetDraft(k);
});

test("a storage that is full keeps the text of the drafts; one that is blocked keeps the page working", () => {
	const full = tabStorage(2000);
	hydrateDrafts(full);
	keepDraft("full/a", { text: "words survive", images: [picture(5000)] });
	flushDrafts();
	reload(full, ["full/a"]);
	expect(readDraft("full/a")).toEqual({ text: "words survive", images: [] });
	forgetDraft("full/a");

	const blocked = {
		getItem: () => {
			throw new DOMException("blocked", "SecurityError");
		},
		setItem: () => {
			throw new DOMException("blocked", "SecurityError");
		},
		removeItem: () => {
			throw new DOMException("blocked", "SecurityError");
		},
	};
	hydrateDrafts(blocked);
	keepDraft("blocked/a", text("still here"));
	expect(() => flushDrafts()).not.toThrow();
	expect(readDraft("blocked/a")?.text).toBe("still here");
	forgetDraft("blocked/a");
});

// ---------------------------------------------------------------------------------- attached text files (#617)

const file = (chars: number, id = "f") => ({
	type: "text" as const,
	name: "notes.md",
	bytes: chars,
	text: "x".repeat(chars),
	id,
});

test("a draft of attached files alone is a draft; it is mirrored and comes back with them", () => {
	keepDraft("files/only", { text: "", images: [], files: [file(10)] });
	expect(readDraft("files/only")?.files).toEqual([file(10)]);
	moveDraft("files/only", "files/moved");
	expect(readDraft("files/only")).toBeUndefined();
	expect(readDraft("files/moved")?.files).toEqual([file(10)]);
	forgetDraft("files/moved");

	const storage = tabStorage();
	hydrateDrafts(storage);
	keepDraft("files/a", { text: "typed", images: [picture(5)], files: [file(10, "a"), file(20, "b")] });
	keepDraft("files/none", text("no files"));
	flushDrafts();
	reload(storage, ["files/a", "files/none"]);
	expect(readDraft("files/a")).toEqual({ text: "typed", images: [picture(5)], files: [file(10, "a"), file(20, "b")] });
	// A draft without files is mirrored as it was before files existed.
	expect(JSON.stringify(JSON.parse(storage.data.get("ompw.drafts") ?? "[]")[1])).not.toContain('"files":');
	expect(readDraft("files/none")).toEqual(text("no files"));
	for (const k of ["files/a", "files/none"]) forgetDraft(k);

	keepDraft("files/empty", { text: "", images: [], files: [] });
	expect(readDraft("files/empty")).toBeUndefined();
});

test("what a reload finds of attached files is checked: a file of another shape is left out", () => {
	const storage = tabStorage();
	storage.data.set(
		"ompw.drafts",
		JSON.stringify([
			[
				"parse/ok",
				{
					text: "t",
					images: [],
					files: [
						file(3),
						{ ...file(3), type: "image" },
						{ ...file(3), name: 1 },
						{ ...file(3), text: null },
						{ ...file(3), id: undefined },
						{ ...file(3), bytes: -1 },
						{ ...file(3), bytes: "3" },
						{ ...file(3), bytes: null },
						null,
						"nonsense",
					],
				},
			],
			["parse/only-bad", { text: "", images: [], files: [{ type: "text" }] }],
			["parse/not-a-list", { text: "kept", images: [], files: { not: "a list" } }],
			["parse/older", { text: "no files key", images: [] }],
		]),
	);
	hydrateDrafts(storage);
	expect(readDraft("parse/ok")).toEqual({ text: "t", images: [], files: [file(3)] });
	expect(readDraft("parse/only-bad")).toBeUndefined();
	expect(readDraft("parse/not-a-list")).toEqual(text("kept"));
	expect(readDraft("parse/older")).toEqual(text("no files key"));
	for (const k of ["parse/ok", "parse/not-a-list", "parse/older"]) forgetDraft(k);
});

test("attached files share the mirror's cap with pictures: newest first, one by one, text stays", () => {
	const storage = tabStorage();
	hydrateDrafts(storage);
	const big = Math.floor(MAX_PERSISTED_IMAGE_CHARS * 0.6);
	keepDraft("size/old", { text: "old text", images: [], files: [file(big, "old")] });
	keepDraft("size/new", { text: "new text", images: [picture(big, "new")], files: [file(10, "tiny")] });
	flushDrafts();
	reload(storage, ["size/old", "size/new"]);
	// The newer draft takes its picture and its small file; what is left does not hold the older draft's file.
	expect(readDraft("size/new")?.images).toEqual([picture(big, "new")]);
	expect(readDraft("size/new")?.files).toEqual([file(10, "tiny")]);
	expect(readDraft("size/old")).toEqual(text("old text"));

	// A file over the whole cap is left out, the one beside it that fits stays; the text stays.
	keepDraft("size/huge", {
		text: "huge text",
		images: [],
		files: [file(MAX_PERSISTED_IMAGE_CHARS + 1, "huge"), file(5, "small")],
	});
	flushDrafts();
	reload(storage, ["size/old", "size/new", "size/huge"]);
	expect(readDraft("size/huge")).toEqual({ text: "huge text", images: [], files: [file(5, "small")] });
	for (const k of ["size/old", "size/new", "size/huge"]) forgetDraft(k);

	// A storage that is full keeps the words alone, as for pictures.
	const full = tabStorage(2000);
	hydrateDrafts(full);
	keepDraft("size/full", { text: "words survive", images: [], files: [file(5000)] });
	flushDrafts();
	reload(full, ["size/full"]);
	expect(readDraft("size/full")).toEqual(text("words survive"));
	forgetDraft("size/full");
});
