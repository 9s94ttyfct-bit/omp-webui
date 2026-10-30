import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { type Build, buildInWorker, FamilyCache } from "../../server/family.ts";
import type { ViewRequest } from "../../server/history-request.ts";
import { SessionStore } from "../../server/sessions/store.ts";
import type { FamilyDocument, FamilyStatsDocument, SessionFileData } from "../../shared/protocol.ts";
import { seedFixtures } from "../support/fixtures.ts";

/**
 * `/api/family?view=` through the cache: a window of the history is built by the worker (from its indexes, not by reading
 * the files whole), kept per view and file version, revalidated by an ETag that covers what was asked for, and an entry
 * the file does not have is a 404 the page can tell. Real session files and the real worker, no omp.
 */

const dirs: string[] = [];
const stores: SessionStore[] = [];
afterEach(() => {
	for (const s of stores.splice(0)) s.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup() {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "ompw-family-view-")));
	dirs.push(dir);
	const fixtures = seedFixtures(dir);
	const store = new SessionStore(join(dir, "sessions"), join(dir, "index.db"));
	stores.push(store);
	await store.list();
	let builds = 0;
	const build: Build = (file, members, single, dedup, view) => {
		builds++;
		return buildInWorker(file, members, single, dedup, view);
	};
	const cache = new FamilyCache(store, { build });
	const ask = (file: string, view?: ViewRequest, headers: Record<string, string> = {}) =>
		cache.respond(
			new Request(`http://x/api/family?file=${file}`, { headers: { "accept-encoding": "gzip", ...headers } }),
			file,
			view,
		);
	return { fixtures, cache, ask, builds: () => builds };
}

const json = async <T>(res: Response): Promise<T> => JSON.parse(gunzipSync(await res.arrayBuffer()).toString());

test("a window is answered as the lineage's members with the window's entries in the viewed file's, gzip-compressed, with an ETag", async () => {
	const { fixtures, ask } = await setup();
	const res = await ask(fixtures.alpha, { kind: "tail" });
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type")).toBe("application/json");
	expect(res.headers.get("content-encoding")).toBe("gzip");
	expect(res.headers.get("etag")).toMatch(/^W\/"[^"]+"$/);
	expect(res.headers.get("cache-control")).toContain("no-cache");
	expect(res.headers.get("vary")).toContain("accept-encoding");
	const doc = await json<FamilyDocument>(res);
	expect(doc.file).toBe(fixtures.alpha);
	expect(doc.members.map((m) => m.file)).toEqual([fixtures.alpha, fixtures.beta]);
	const [alpha, beta] = doc.members.filter((m): m is SessionFileData => !("kept" in m));
	expect(alpha?.entries.map((e) => e.id)).toEqual([
		"f0000001",
		"f0000002",
		"f0000003",
		"f0000004",
		"f0000005",
		"f0000006",
		"f0000007",
	]);
	expect(alpha.tag).toBeTruthy();
	expect(alpha).toMatchObject({ head: "f0000007", total: 7 });
	expect(beta).toMatchObject({ entries: [], head: "f0000015" });
	expect(doc.view).toMatchObject({ kind: "tail", leaf: "f0000007", head: "f0000007", earlier: false, later: false });
	// The shared path of a family is not sent once for a window: there is nothing shared in it.
	expect(res.headers.get("x-family-dedup")).toBeNull();
});

test("the same window is answered from the cache, a current ETag with a 304 that builds nothing, and a client without gzip gets it plain", async () => {
	const { fixtures, ask, builds } = await setup();
	const first = await ask(fixtures.alpha, { kind: "tail", limit: 3 });
	const bytes = new Uint8Array(await first.arrayBuffer());
	const etag = first.headers.get("etag") as string;
	const second = await ask(fixtures.alpha, { kind: "tail", limit: 3 });
	expect(new Uint8Array(await second.arrayBuffer())).toEqual(bytes);
	expect(builds()).toBe(1);

	const same = await ask(fixtures.alpha, { kind: "tail", limit: 3 }, { "if-none-match": etag });
	expect(same.status).toBe(304);
	expect(await same.text()).toBe("");
	expect(same.headers.get("etag")).toBe(etag);
	expect(builds()).toBe(1);

	const plain = await ask(fixtures.alpha, { kind: "tail", limit: 3 }, { "accept-encoding": "identity" });
	expect(plain.headers.get("content-encoding")).toBeNull();
	expect(plain.headers.get("etag")).toBe(etag);
	expect(((await plain.json()) as FamilyDocument).view?.kind).toBe("tail");
	expect(builds()).toBe(1);

	// Asked at once, built once.
	const fresh = await setup();
	await Promise.all([1, 2, 3].map(() => fresh.ask(fresh.fixtures.alpha, { kind: "tail" })));
	expect(fresh.builds()).toBe(1);
});

test("what was asked for is part of the ETag: a view, its parameters, and the lineage whole are different documents", async () => {
	const { fixtures, ask, builds } = await setup();
	const views: (ViewRequest | undefined)[] = [
		undefined,
		{ kind: "tail" },
		{ kind: "tail", limit: 2 },
		{ kind: "tail", leaf: "f0000006" },
		{ kind: "before", at: "f0000004" },
		{ kind: "before", at: "f0000004", limit: 2 },
		{ kind: "before", at: "f0000003" },
		{ kind: "after", at: "f0000002" },
		{ kind: "after", at: "f0000002", leaf: "f0000006" },
		{ kind: "around", at: "f0000004" },
		{ kind: "stats" },
	];
	const etags: string[] = [];
	for (const view of views) etags.push((await ask(fixtures.alpha, view)).headers.get("etag") as string);
	expect(new Set(etags).size).toBe(views.length);
	expect(builds()).toBe(views.length);
	// The lineage whole, the end of the conversation and its figures are kept under their own: asking them again builds nothing.
	const paged = (view: ViewRequest | undefined) =>
		view?.kind === "before" || view?.kind === "after" || view?.kind === "around";
	for (const view of views.filter((v) => !paged(v))) await ask(fixtures.alpha, view);
	expect(builds()).toBe(views.length);
	// The windows a reader pages in are not kept (one per page of a long conversation is megabytes nobody asks for again): asked
	// again they are built again, to the same document; a client that holds one is told so with a 304 that builds nothing.
	const pagedViews = views.filter(paged);
	for (const view of pagedViews) await ask(fixtures.alpha, view);
	expect(builds()).toBe(views.length + pagedViews.length);
	for (const [i, view] of views.entries()) {
		const res = await ask(fixtures.alpha, view, { "if-none-match": etags[i] as string });
		expect(res.status).toBe(304);
	}
	expect(builds()).toBe(views.length + pagedViews.length);
	// The lineage whole is still the lineage whole.
	const whole = await json<{ members: { entries: unknown[] }[] }>(await ask(fixtures.alpha));
	expect(whole.members[0]?.entries).toHaveLength(7);
	expect(whole.members[1]?.entries).toHaveLength(5);
});

test("a write to any member of the family gives a window a new ETag and a new body; the entries it had are still there", async () => {
	const { fixtures, ask, builds } = await setup();
	const first = await ask(fixtures.alpha, { kind: "tail" });
	const etag = first.headers.get("etag") as string;
	const before = await json<FamilyDocument>(first);
	// The conversation is written to.
	appendFileSync(
		fixtures.alpha,
		`${JSON.stringify({ type: "message", id: "f0000008", parentId: "f0000007", timestamp: "2026-01-05T10:08:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "more" }], provider: "anthropic", model: "claude-haiku-5-5" } })}\n`,
	);
	const grown = await ask(fixtures.alpha, { kind: "tail" }, { "if-none-match": etag });
	expect(grown.status).toBe(200);
	expect(grown.headers.get("etag")).not.toBe(etag);
	const after = await json<FamilyDocument>(grown);
	expect(after.view).toMatchObject({ leaf: "f0000008", head: "f0000008" });
	const was = (before.members[0] as { entries: { id: string }[] }).entries.map((e) => e.id);
	const now = (after.members[0] as { entries: { id: string }[]; total: number }).entries.map((e) => e.id);
	expect(now).toEqual([...was, "f0000008"]);
	expect(builds()).toBe(2);
	// The family's other member written to: the window is another document of the conversation too.
	appendFileSync(
		fixtures.beta,
		`${JSON.stringify({ type: "label", id: "f00000ff", parentId: "f0000015", timestamp: "2026-01-05T11:00:00.000Z" })}\n`,
	);
	const beta = await ask(fixtures.alpha, { kind: "tail" }, { "if-none-match": grown.headers.get("etag") as string });
	expect(beta.status).toBe(200);
	expect((await json<FamilyDocument>(beta)).members[1]).toMatchObject({ head: "f00000ff", total: 6 });
});

test("an entry the file does not have is a 404 that says so, and nothing is kept for it", async () => {
	const { fixtures, ask, builds } = await setup();
	for (const view of [
		{ kind: "before", at: "missing" },
		{ kind: "after", at: "missing" },
		{ kind: "around", at: "missing" },
		{ kind: "tail", leaf: "missing" },
	] as const) {
		const res = await ask(fixtures.alpha, view);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: string; code: string };
		expect(body.code).toBe("unknown_entry");
		expect(body.error).toContain("missing");
	}
	expect(builds()).toBe(4);
	// An entry of the other file is not an entry of this one.
	expect((await ask(fixtures.alpha, { kind: "before", at: "f0000014" })).status).toBe(404);
	expect((await ask(fixtures.beta, { kind: "before", at: "f0000014" })).status).toBe(200);
	// The next window asked for is answered, by a worker that went on.
	expect((await ask(fixtures.alpha, { kind: "tail" })).status).toBe(200);
});

test("the figures of the file are a document of their own, the file's and not the family's", async () => {
	const { fixtures, ask } = await setup();
	const res = await ask(fixtures.alpha, { kind: "stats" });
	expect(res.status).toBe(200);
	const doc = await json<FamilyStatsDocument>(res);
	expect(doc.file).toBe(fixtures.alpha);
	expect(doc.stats.through).toBe("f0000007");
	expect(doc.stats.byModel).toHaveLength(1);
	expect(doc.stats.usage.cost).toBeCloseTo(0.012345 + 0.004321 + 0.001, 9);
	expect(Object.keys(doc).sort()).toEqual(["file", "stats"]);
});

test("a client that asks to be sent the shared path once, or names the files it holds, is still sent the window as it is", async () => {
	const { fixtures, ask } = await setup();
	const res = await ask(fixtures.beta, { kind: "tail" }, { "x-family-dedup": "1", "x-family-have": "whatever" });
	expect(res.headers.get("x-family-dedup")).toBeNull();
	const doc = await json<FamilyDocument>(res);
	for (const m of doc.members) expect(m).not.toHaveProperty("order");
	expect(doc.members.some((m) => "kept" in m)).toBe(false);
	expect((doc.members[1] as { entries: unknown[] }).entries).toHaveLength(5);
});
