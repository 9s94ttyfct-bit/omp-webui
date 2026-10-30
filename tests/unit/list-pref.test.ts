import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ListPref } from "../../server/sessions/actions.ts";

/**
 * The web UI's own lists (archived conversations, favorite models) are kept in one small file each: a change must
 * never leave the file half written, and a file that is not readable must not be what the next change overwrites.
 */

let dir: string;
let warned: ReturnType<typeof spyOn>;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompw-listpref-"));
	warned = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
	warned.mockRestore();
	rmSync(dir, { recursive: true, force: true });
});

const ITEMS = ["/s/a.jsonl", "/s/b.jsonl", "/s/c.jsonl"];

test("a change is a whole file or none: a reader that opened the list before it still reads all of the old one", () => {
	const archived = new ListPref(dir, "archived");
	archived.set(ITEMS, true);
	const file = join(dir, "archived.json");
	const before = readFileSync(file, "utf8");

	// What a second process (or a crash in the middle of the write) is: someone holding the file while it is changed.
	const fd = openSync(file, "r");
	try {
		archived.set(["/s/d.jsonl"], true);
		const buf = Buffer.alloc(1024);
		const n = readSync(fd, buf, 0, buf.length, 0);
		expect(buf.toString("utf8", 0, n)).toBe(before);
	} finally {
		closeSync(fd);
	}
	expect(archived.list()).toEqual(["/s/d.jsonl", ...ITEMS]);
	// Nothing is left beside it, and it stays private.
	expect(readdirSync(dir)).toEqual(["archived.json"]);
	expect(statSync(file).mode & 0o777).toBe(0o600);
});

test("a file that was cut off is kept aside, not written over by the next change", () => {
	const archived = new ListPref(dir, "archived");
	archived.set(ITEMS, true);
	const file = join(dir, "archived.json");
	const whole = readFileSync(file);
	const cut = whole.subarray(0, whole.length - 14);
	writeFileSync(file, cut);

	// Nothing is listed from it; and the change that follows does not destroy what it held.
	expect(archived.list()).toEqual([]);
	expect(archived.set(["/s/d.jsonl"], true)).toEqual(["/s/d.jsonl"]);
	expect(readFileSync(`${file}.damaged`).equals(cut)).toBe(true);
	expect(new ListPref(dir, "archived").list()).toEqual(["/s/d.jsonl"]);
});

test("a file that is empty or not a list is damaged too", () => {
	const archived = new ListPref(dir, "archived");
	for (const text of ["", '{"a":1}', "not json"]) {
		writeFileSync(join(dir, "archived.json"), text);
		expect(archived.list()).toEqual([]);
		expect(readFileSync(join(dir, "archived.json.damaged"), "utf8")).toBe(text);
		expect(existsSync(join(dir, "archived.json"))).toBe(false);
	}
});

test("a list that cannot be read at all is an error, not an empty list that the next change replaces", () => {
	const file = join(dir, "archived.json");
	// A directory where the file should be: reading it fails with something other than "no such file".
	mkdirSync(file);
	const archived = new ListPref(dir, "archived");
	expect(() => archived.list()).toThrow();
	expect(() => archived.set(["/s/a.jsonl"], true)).toThrow();
	expect(statSync(file).isDirectory()).toBe(true);
});

test("a pipe where the file should be is an error at once, never opened: a read of it would stop the server", () => {
	const file = join(dir, "favorite-models.json");
	expect(Bun.spawnSync(["mkfifo", file]).exitCode).toBe(0);
	const loved = new ListPref(dir, "favorite-models");
	expect(() => loved.list()).toThrow("is not a file");
	expect(() => loved.set(["a/model"], true)).toThrow("is not a file");
	expect(statSync(file).isFIFO()).toBe(true);
});

test("a list that does not exist yet is empty", () => {
	const archived = new ListPref(dir, "archived");
	expect(archived.list()).toEqual([]);
	expect(archived.set(["/s/a.jsonl"], true)).toEqual(["/s/a.jsonl"]);
	expect(archived.set(["/s/a.jsonl"], false)).toEqual([]);
});
