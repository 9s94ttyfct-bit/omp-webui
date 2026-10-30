import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, realpathSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { type Build, buildInWorker, FamilyCache } from "../../server/family.ts";
import { parseSessionText } from "../../server/sessions/parse.ts";
import { SessionStore } from "../../server/sessions/store.ts";
import { FIXTURE, seedFixtures } from "../support/fixtures.ts";

/**
 * `/api/family` answers: the gzip-compressed JSON of a conversation's whole lineage, built off the request
 * thread, kept per member file version, revalidated with an ETag. Real session files, no omp.
 */

const dirs: string[] = [];
const stores: SessionStore[] = [];
afterEach(() => {
	for (const s of stores.splice(0)) s.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Fixture sessions (alpha and beta are one lineage; gamma has a subagent) and a cache over them. The store has
 * scanned the files, as it has by the time a page asks for a conversation: the sidebar loads the list first.
 */
async function setup(limitBytes?: number) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "ompw-family-")));
	dirs.push(dir);
	const fixtures = seedFixtures(dir);
	const store = new SessionStore(join(dir, "sessions"), join(dir, "index.db"));
	stores.push(store);
	await store.list();
	let builds = 0;
	// The real build, counted: how often the cache had to do the work.
	const build: Build = (file, members, single) => {
		builds++;
		return buildInWorker(file, members, single);
	};
	const cache = new FamilyCache(store, { build, limitBytes });
	const ask = (file: string, headers: Record<string, string> = {}) =>
		cache.respond(
			new Request(`http://x/api/family?file=${file}`, { headers: { "accept-encoding": "gzip", ...headers } }),
			file,
		);
	const askSession = (file: string, headers: Record<string, string> = {}) =>
		cache.respondSession(
			new Request(`http://x/api/session?file=${file}`, { headers: { "accept-encoding": "gzip", ...headers } }),
			file,
		);
	return { dir, fixtures, store, cache, ask, askSession, builds: () => builds };
}

const json = async (res: Response) => JSON.parse(gunzipSync(await res.arrayBuffer()).toString());

/** What a page has always been given of one transcript: its header and entries, and its subagents and advisors. */
async function read(store: SessionStore, file: string) {
	const parsed = parseSessionText(await Bun.file(file).text());
	return { file, header: parsed.header, entries: parsed.entries, ...(await store.transcripts(file)) };
}

test("answers with every conversation of the lineage, gzip-compressed, with an ETag", async () => {
	const { fixtures, store, ask } = await setup();
	const res = await ask(fixtures.alpha);

	expect(res.status).toBe(200);
	expect(res.headers.get("content-type")).toBe("application/json");
	expect(res.headers.get("content-encoding")).toBe("gzip");
	expect(res.headers.get("vary")).toContain("accept-encoding");
	expect(res.headers.get("cache-control")).toContain("no-cache");
	expect(res.headers.get("etag")).toMatch(/^W\/"[^"]+"$/);

	// The same document the conversation page always got: the requested file and every member, in lineage order.
	const members = await store.family(fixtures.alpha);
	expect(members).toEqual([fixtures.alpha, fixtures.beta]);
	// A client that did not ask for the shared path to be sent once is sent every file whole.
	expect(await json(res)).toEqual({
		file: fixtures.alpha,
		members: JSON.parse(JSON.stringify(await Promise.all(members.map((f) => read(store, f))))),
	});
});

test("a second request is answered from the cache, byte for byte, without building again", async () => {
	const { fixtures, ask, builds } = await setup();
	const first = await ask(fixtures.alpha);
	const bytes = new Uint8Array(await first.arrayBuffer());
	const second = await ask(fixtures.alpha);

	expect(builds()).toBe(1);
	expect(second.headers.get("etag")).toBe(first.headers.get("etag"));
	expect(new Uint8Array(await second.arrayBuffer())).toEqual(bytes);
});

test("a request that shows the current ETag gets a 304 without a body, and nothing is built for it", async () => {
	const { fixtures, store, ask, builds } = await setup();
	const etag = (await ask(fixtures.alpha)).headers.get("etag") as string;
	expect(builds()).toBe(1);

	const same = await ask(fixtures.alpha, { "if-none-match": etag });
	expect(same.status).toBe(304);
	expect(await same.text()).toBe("");
	expect(same.headers.get("etag")).toBe(etag);
	expect(same.headers.get("cache-control")).toContain("no-cache");
	// One of several tags, or a tag in the other (strong) form, matches too.
	expect((await ask(fixtures.alpha, { "if-none-match": `W/"other", ${etag}` })).status).toBe(304);
	expect((await ask(fixtures.alpha, { "if-none-match": etag.replace(/^W\//, "") })).status).toBe(304);
	expect((await ask(fixtures.alpha, { "if-none-match": 'W/"stale"' })).status).toBe(200);

	// A browser that kept the ETag across a server restart: the cache is empty, the answer is still a 304.
	let rebuilt = 0;
	const fresh = new FamilyCache(store, {
		build: (file, members) => {
			rebuilt++;
			return buildInWorker(file, members);
		},
	});
	const afterRestart = await fresh.respond(
		new Request("http://x/", { headers: { "accept-encoding": "gzip", "if-none-match": etag } }),
		fixtures.alpha,
	);
	expect(afterRestart.status).toBe(304);
	expect(rebuilt).toBe(0);
});

test("a change to any member of the lineage — its content or only its modification time — gives a new ETag and a new body", async () => {
	const { fixtures, ask, builds } = await setup();
	const before = (await ask(fixtures.alpha)).headers.get("etag") as string;

	// beta is a branch of alpha: the lineage of alpha includes it.
	appendFileSync(
		fixtures.beta,
		`${JSON.stringify({ type: "message", id: "f00000ff", parentId: "f0000015", message: { role: "user", content: [{ type: "text", text: "later" }] } })}\n`,
	);
	const grown = await ask(fixtures.alpha, { "if-none-match": before });
	expect(grown.status).toBe(200);
	const afterAppend = grown.headers.get("etag") as string;
	expect(afterAppend).not.toBe(before);
	const beta = (await json(grown)).members.find((m: { file: string }) => m.file === fixtures.beta);
	expect(beta.entries.at(-1).id).toBe("f00000ff");
	expect(builds()).toBe(2);

	utimesSync(fixtures.beta, new Date(), new Date(Date.now() + 60_000));
	const touched = await ask(fixtures.alpha, { "if-none-match": afterAppend });
	expect(touched.status).toBe(200);
	expect(touched.headers.get("etag")).not.toBe(afterAppend);
	expect(builds()).toBe(3);
});

test("a change to a subagent transcript of a member changes the ETag too", async () => {
	const { fixtures, ask } = await setup();
	const before = (await ask(fixtures.gamma)).headers.get("etag") as string;
	appendFileSync(join(fixtures.gamma.replace(/\.jsonl$/, ""), `${FIXTURE.subagentId}.jsonl`), "\n");
	const after = await ask(fixtures.gamma, { "if-none-match": before });
	expect(after.status).toBe(200);
	expect(after.headers.get("etag")).not.toBe(before);
});

test("concurrent requests for one lineage share one build", async () => {
	const { fixtures, ask, builds } = await setup();
	const answers = await Promise.all([ask(fixtures.alpha), ask(fixtures.alpha), ask(fixtures.alpha)]);
	expect(builds()).toBe(1);
	expect(new Set(answers.map((r) => r.headers.get("etag"))).size).toBe(1);
	const [one, two] = await Promise.all([json(answers[0]), json(answers[1])]);
	expect(two).toEqual(one);
});

test("a client that does not take gzip gets the plain document, with the same ETag, from the same cached body", async () => {
	const { fixtures, ask, builds } = await setup();
	const gzip = await ask(fixtures.alpha);
	const plain = await ask(fixtures.alpha, { "accept-encoding": "identity" });

	expect(plain.status).toBe(200);
	expect(plain.headers.get("content-encoding")).toBeNull();
	expect(plain.headers.get("etag")).toBe(gzip.headers.get("etag"));
	expect(await plain.json()).toEqual(await json(gzip));
	expect(builds()).toBe(1);
});

test("the cache holds no more than its byte limit: the least recently asked-for lineage goes first", async () => {
	// Sizes of the two bodies, then a cache that can hold the larger one but not both.
	const probe = await setup();
	const [a, g] = await Promise.all([probe.ask(probe.fixtures.alpha), probe.ask(probe.fixtures.gamma)]);
	const limit = Math.max((await a.arrayBuffer()).byteLength, (await g.arrayBuffer()).byteLength);

	const { fixtures, ask, builds } = await setup(limit);
	await ask(fixtures.alpha);
	await ask(fixtures.gamma);
	expect(builds()).toBe(2);
	await ask(fixtures.gamma);
	expect(builds()).toBe(2);
	await ask(fixtures.alpha);
	expect(builds()).toBe(3);

	// A body bigger than the limit is served but never kept.
	const tiny = await setup(1);
	await tiny.ask(tiny.fixtures.alpha);
	await tiny.ask(tiny.fixtures.alpha);
	expect(tiny.builds()).toBe(2);
});

test("a member that cannot be read fails the request; nothing partial is answered or kept", async () => {
	const { fixtures, ask } = await setup();
	await ask(fixtures.alpha);
	rmSync(fixtures.beta);
	await expect(ask(fixtures.alpha)).rejects.toThrow();
});

/**
 * `/api/session` (one transcript: a subagent's, in the page) used to be read, parsed, serialized and gzipped on the server's
 * thread, which stopped every other request for as long as that took (0.7 s for 58 MB, 4 s for 300 MB). It is answered like the
 * family: built by the worker, kept per file version, revalidated with an ETag.
 */

test("one transcript is answered as the document of that file, with its subagents, built off the request thread", async () => {
	const { fixtures, store, askSession, builds } = await setup();
	const res = await askSession(fixtures.gamma);
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type")).toBe("application/json");
	expect(res.headers.get("content-encoding")).toBe("gzip");
	expect(res.headers.get("etag")).toMatch(/^W\/"[^"]+"$/);
	const expected = JSON.parse(JSON.stringify(await read(store, fixtures.gamma)));
	expect(expected.subagents.length).toBeGreaterThan(0);
	expect(await json(res)).toEqual(expected);
	expect(builds()).toBe(1);
});

test("a second request for a transcript is answered from the cache, and a current ETag gets a 304 without building", async () => {
	const { fixtures, askSession, builds } = await setup();
	const first = await askSession(fixtures.alpha);
	const bytes = new Uint8Array(await first.arrayBuffer());
	const etag = first.headers.get("etag") as string;
	const second = await askSession(fixtures.alpha);
	expect(new Uint8Array(await second.arrayBuffer())).toEqual(bytes);
	expect(builds()).toBe(1);

	const same = await askSession(fixtures.alpha, { "if-none-match": etag });
	expect(same.status).toBe(304);
	expect(await same.text()).toBe("");
	expect(builds()).toBe(1);

	// A transcript that grows is a new document; a client that does not take gzip gets it plain.
	appendFileSync(
		fixtures.alpha,
		`${JSON.stringify({ type: "message", id: "f00000fe", parentId: null, message: { role: "user", content: [{ type: "text", text: "later" }] } })}\n`,
	);
	const grown = await askSession(fixtures.alpha, { "if-none-match": etag, "accept-encoding": "identity" });
	expect(grown.status).toBe(200);
	expect(grown.headers.get("content-encoding")).toBeNull();
	expect(grown.headers.get("etag")).not.toBe(etag);
	expect((await grown.json()).entries.at(-1).id).toBe("f00000fe");
	expect(builds()).toBe(2);
});

test("the family and the transcript of the same file are two documents: neither is served for the other", async () => {
	const { fixtures, ask, askSession, builds } = await setup();
	const family = await ask(fixtures.alpha);
	const session = await askSession(fixtures.alpha);
	expect(session.headers.get("etag")).not.toBe(family.headers.get("etag"));
	expect(builds()).toBe(2);
	expect(Object.keys(await json(family))).toEqual(["file", "members"]);
	expect(Object.keys(await json(session)).sort()).toEqual(["advisors", "entries", "file", "header", "subagents"]);
	// Both are kept: asking again builds nothing.
	await ask(fixtures.alpha);
	await askSession(fixtures.alpha);
	expect(builds()).toBe(2);
});
