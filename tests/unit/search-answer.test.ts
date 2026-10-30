import "./browser-globals.ts";
import { afterAll, afterEach, beforeAll, beforeEach, expect, type Mock, spyOn, test } from "bun:test";
import { api } from "../../web/src/lib/api.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/** A search answers with its hits, and says how far the server's index is while it is still being built. */

beforeAll(installGlobals);
afterAll(restoreGlobals);

let fetchSpy: Mock<typeof fetch>;
beforeEach(() => {
	fetchSpy = spyOn(globalThis, "fetch");
});
afterEach(() => fetchSpy.mockRestore());

const answer = (hits: unknown[], headers: Record<string, string> = {}) =>
	fetchSpy.mockResolvedValue(
		new Response(JSON.stringify(hits), { headers: { "content-type": "application/json", ...headers } }),
	);

test("a complete answer has no indexing progress", async () => {
	answer([{ file: "/s/a.jsonl", entryId: "e1" }]);
	const found = await api.search("zebra");
	expect(found.hits).toHaveLength(1);
	expect(found.indexing).toBeNull();
});

test("an answer from a library that is still being indexed says how far it is", async () => {
	answer([], { "x-search-index": "120/4000" });
	expect((await api.search("zebra")).indexing).toEqual({ indexed: 120, total: 4000 });
});

test("a header that is not a count is ignored", async () => {
	answer([], { "x-search-index": "soon" });
	expect((await api.search("zebra")).indexing).toBeNull();
});

test("a search that named a conversation says how much of it the answer is from (#509)", async () => {
	answer([{ file: "/s/a.jsonl", entryId: "e1" }], { "x-search-file": "1024/4096" });
	const found = await api.search("zebra", "/s/a.jsonl");
	expect(found.file).toEqual({ indexed: 1024, total: 4096 });
});

test("a search whose conversation is wholly in the index says nothing about it", async () => {
	answer([{ file: "/s/a.jsonl", entryId: "e1" }]);
	expect((await api.search("zebra", "/s/a.jsonl")).file).toBeNull();
});

test("an error answer throws", async () => {
	fetchSpy.mockResolvedValue(new Response(JSON.stringify({ error: "Unknown session file" }), { status: 404 }));
	await expect(api.search("zebra", "/etc/hostname")).rejects.toThrow("Unknown session file");
});
