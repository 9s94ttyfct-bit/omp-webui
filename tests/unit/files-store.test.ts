import { afterEach, beforeEach, expect, type Mock, spyOn, test } from "bun:test";
import type { FolderEntry, FolderListing } from "../../shared/folder.ts";
import type { FolderScope } from "../../web/src/lib/folder-api.ts";
import {
	closeDir,
	keyOf,
	loadDir,
	openDir,
	refreshAll,
	select,
	setFilter,
	setShowAll,
	toggleDir,
	useFiles,
} from "../../web/src/store/files.ts";

/** The Files tab's state: what is read when, what answers are dropped, and what is kept for each conversation. */

let fetches: Mock<typeof fetch>;
let n = 0;
/** A conversation of its own for each test. */
const fresh = (): FolderScope => ({ live: null, file: `/sessions/probe-${++n}.jsonl` });
const tree = (scope: FolderScope) => useFiles.getState().trees[keyOf(scope)];

const entry = (name: string, kind: "dir" | "file" = "file"): FolderEntry => ({ name, kind });
const listing = (path: string, entries: FolderEntry[], extra: Partial<FolderListing> = {}): FolderListing => ({
	root: "/p",
	path,
	entries,
	hiddenCount: 0,
	truncated: false,
	git: false,
	...extra,
});

interface Held {
	url: URL;
	init: RequestInit | undefined;
	answer: (res: Response) => void;
}
/** Every request the page makes is held until the test answers it. */
let held: Held[];
beforeEach(() => {
	held = [];
	fetches = spyOn(globalThis, "fetch").mockImplementation(((input: Request | string | URL, init?: RequestInit) => {
		const { promise, resolve } = Promise.withResolvers<Response>();
		held.push({ url: new URL(String(input), "http://x"), init, answer: resolve });
		return promise;
	}) as typeof fetch);
});
afterEach(() => fetches.mockRestore());

const ok = (body: unknown) => Response.json(body);
const refuse = (status: number, error: string) => Response.json({ error }, { status });

test("a folder is read once for the conversation it is asked for, and kept", async () => {
	const scope = fresh();
	const loading = loadDir(scope, "");
	expect(held[0].url.pathname).toBe("/api/folder/list");
	expect(held[0].url.searchParams.get("file")).toBe(scope.file);
	expect(held[0].url.searchParams.has("all")).toBe(false);
	expect(held[0].init?.method).toBeUndefined();
	held[0].answer(ok(listing("", [entry("src", "dir"), entry("a.ts")], { hiddenCount: 2, git: true })));
	await loading;
	expect(tree(scope).root).toBe("/p");
	expect(tree(scope).slots[""].listing).toEqual({
		entries: [entry("src", "dir"), entry("a.ts")],
		hiddenCount: 2,
		truncated: false,
		git: true,
		guarded: false,
		local: false,
	});
	expect(tree(scope).rootError).toBeNull();
});

test("whether this page may open folders in Finder is what the server said of the listing, and nothing else", async () => {
	const scope = fresh();
	const loading = loadDir(scope, "");
	held[0].answer(ok(listing("", [entry("src", "dir")], { local: true })));
	await loading;
	expect(tree(scope).slots[""].listing?.local).toBe(true);
	const guarded = fresh();
	const again = loadDir(guarded, "");
	held[1].answer(ok(listing("", [entry("src", "dir")], { guarded: true })));
	await again;
	expect(tree(guarded).slots[""].listing).toMatchObject({ guarded: true, local: false });
});

test("looking at git again is a POST that carries the CSRF header", async () => {
	const scope = fresh();
	const loading = loadDir(scope, "", true);
	expect(held[0].init?.method).toBe("POST");
	expect((held[0].init?.headers as Record<string, string> | undefined)?.["x-omp-webui"]).toBe("1");
	expect(held[0].url.searchParams.get("fresh")).toBe("1");
	held[0].answer(ok(listing("", [])));
	await loading;
});

test("an answer that has been overtaken by a newer one for the same folder is dropped", async () => {
	const scope = fresh();
	const older = loadDir(scope, "");
	const newer = loadDir(scope, "");
	held[1].answer(ok(listing("", [entry("new.ts")])));
	await newer;
	held[0].answer(ok(listing("", [entry("old.ts")])));
	await older;
	expect(tree(scope).slots[""].listing?.entries.map((e) => e.name)).toEqual(["new.ts"]);
});

test("opening a folder reads it, once; opening it again does not read it again", async () => {
	const scope = fresh();
	const opening = openDir(scope, "src");
	expect(held[0].url.searchParams.get("path")).toBe("src");
	held[0].answer(ok(listing("src", [entry("a.ts")])));
	await opening;
	expect(tree(scope).open).toEqual(["src"]);
	expect(tree(scope).focused).toBe("src");
	await toggleDir(scope, "src");
	expect(tree(scope).open).toEqual([]);
	await toggleDir(scope, "src");
	expect(tree(scope).open).toEqual(["src"]);
	expect(held).toHaveLength(1);
});

test("closing a folder leaves what is open inside it open for when it is opened again", async () => {
	const scope = fresh();
	void openDir(scope, "a");
	void openDir(scope, "a/b");
	closeDir(scope, "a");
	expect(tree(scope).open).toEqual(["a/b"]);
});

test("a folder that is gone is closed with what was below it; the root that is gone is the tab's error", async () => {
	const scope = fresh();
	const loads = [openDir(scope, "a"), openDir(scope, "a/b"), openDir(scope, "keep")];
	for (const h of held)
		h.answer(h.url.searchParams.get("path") === "a" ? refuse(404, "Not found") : ok(listing("", [])));
	await Promise.all(loads);
	expect(tree(scope).open).toEqual(["keep"]);
	expect(tree(scope).slots.a).toBeUndefined();

	const lost = loadDir(scope, "");
	held[3].answer(refuse(404, "The conversation's folder is not there"));
	await lost;
	expect(tree(scope).rootError).toEqual({ message: "The conversation's folder is not there", status: 404 });
});

test("another failure is the folder's own: it says so, and the rest of the tree stays", async () => {
	const scope = fresh();
	const root = loadDir(scope, "");
	held[0].answer(ok(listing("", [entry("sealed", "dir")])));
	await root;
	const opening = openDir(scope, "sealed");
	held[1].answer(refuse(403, "No permission"));
	await opening;
	expect(tree(scope).slots.sealed).toEqual({ error: "No permission" });
	expect(tree(scope).slots[""].listing?.entries).toHaveLength(1);
	expect(tree(scope).open).toEqual(["sealed"]);
});

test("reading everything again reads the root and the folders that can be seen, not the ones inside a closed folder", async () => {
	const scope = fresh();
	void openDir(scope, "a");
	void openDir(scope, "a/b");
	void openDir(scope, "z/y");
	closeDir(scope, "a");
	held.length = 0;
	const refreshing = refreshAll(scope);
	expect(held.map((h) => h.url.searchParams.get("path"))).toEqual([""]);
	expect(held.every((h) => h.init?.method === "POST")).toBe(true);
	held[0].answer(ok(listing("", [])));
	await refreshing;
	expect(tree(scope).reads).toBe(1);
});

test("showing everything reads every listing again with `all`, and drops answers asked for without it", async () => {
	const scope = fresh();
	const before = loadDir(scope, "");
	const showing = setShowAll(scope, true);
	expect(held[1].url.searchParams.get("all")).toBe("1");
	held[1].answer(ok(listing("", [entry(".env"), entry("a.ts")])));
	await showing;
	held[0].answer(ok(listing("", [entry("a.ts")])));
	await before;
	expect(tree(scope).showAll).toBe(true);
	expect(tree(scope).slots[""].listing?.entries.map((e) => e.name)).toEqual([".env", "a.ts"]);
	// Asking for what it already is changes nothing.
	const count = held.length;
	await setShowAll(scope, true);
	expect(held).toHaveLength(count);
});

test("the file being previewed and the filter are kept with the tree; only the last few conversations are", () => {
	const scope = fresh();
	select(scope, "src/a.ts");
	setFilter(scope, "app");
	expect(tree(scope).selected).toBe("src/a.ts");
	expect(tree(scope).filter).toBe("app");
	const others = Array.from({ length: 4 }, fresh);
	for (const o of others) select(o, "x");
	expect(tree(scope)).toBeUndefined();
	expect(tree(others[0])).toBeDefined();
	expect(useFiles.getState().order).toHaveLength(4);
});

test("a conversation is told by its file, or by its process when it has none yet", () => {
	expect(keyOf({ live: "l1", file: "/s/a.jsonl" })).toBe("/s/a.jsonl");
	expect(keyOf({ live: "l1", file: null })).toBe("l1");
	expect(keyOf({ live: null, file: null })).toBe("");
});
