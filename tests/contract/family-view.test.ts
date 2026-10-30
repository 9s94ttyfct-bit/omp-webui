import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { parseSessionText } from "../../server/sessions/parse.ts";
import type { FamilyDocument, FamilyStatsDocument, SessionEntry, SessionFileData } from "../../shared/protocol.ts";
import { sumEntries, usageByModel } from "../../web/src/lib/totals.ts";
import { activeMs } from "../../web/src/lib/turn-stats.ts";
import { pathTo, turns, writeSession } from "../support/history-fixtures.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";

/**
 * `/api/family?view=` against the real server: a long conversation (thousands of entries) answered as windows of its
 * history, the way the page asks for them, with the ETags, the codes and the encodings of every other answer of the family.
 * No omp is started.
 */

let s: TestServer;
let conversation: string;
let fork: string;
let entries: SessionEntry[];
let forkOwn: SessionEntry[];
let ids: string[];
const authed = () => ({ "x-omp-webui-token": s.accessToken });

beforeAll(async () => {
	s = await startTestServer();
	// 800 turns of a prompt, two tool steps and an answer: 4,800 entries.
	entries = turns(800, { steps: 2 });
	ids = entries.map((e) => e.id);
	conversation = realpathSync(
		writeSession(s.agentDir, "view-long", entries, { title: "Fixture long: a long conversation" }),
	);
	// A fork made at the end of turn 400, which went on with two turns of its own.
	const copied = entries.slice(0, entries.findIndex((e) => e.id === "f400") + 1);
	forkOwn = turns(2, { prefix: "k", parent: "f400", at: 100_000, steps: 1 });
	fork = realpathSync(writeSession(s.agentDir, "view-fork", [...copied, ...forkOwn], { parentSession: conversation }));
	await pollUntil(
		async () => {
			const sessions: { file: string }[] = await (await fetch(`${s.url}/api/sessions`, { headers: authed() })).json();
			return sessions.some((x) => x.file === conversation) && sessions.some((x) => x.file === fork);
		},
		"the server to index the conversations",
		30_000,
	);
}, 60_000);
afterAll(async () => {
	await s?.stop();
});

function url(file: string, params: Record<string, string | number> = {}): string {
	const q = new URLSearchParams({
		file,
		...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
	});
	return `${s.url}/api/family?${q}`;
}

async function get(file: string, params: Record<string, string | number> = {}, headers: Record<string, string> = {}) {
	const res = await fetch(url(file, params), { headers: { ...authed(), "accept-encoding": "gzip", ...headers } });
	return res;
}

interface Window {
	res: Response;
	doc: FamilyDocument;
	own: SessionFileData;
	ids: string[];
}

async function window(file: string, params: Record<string, string | number>): Promise<Window> {
	const res = await get(file, params);
	expect(res.status).toBe(200);
	const doc: FamilyDocument = await res.json();
	const own = doc.members.find((m) => m.file === file) as SessionFileData;
	return { res, doc, own, ids: own.entries.map((e) => e.id) };
}

test("the end of a long conversation is answered as a window of two hundred entries, with what the page needs of every file", async () => {
	const tail = await window(conversation, { view: "tail" });
	expect(tail.doc.file).toBe(conversation);
	expect(tail.ids.length).toBeGreaterThanOrEqual(200);
	expect(tail.ids.length).toBeLessThan(220);
	expect(tail.ids.at(-1)).toBe("f799");
	expect(tail.own.entries[0]?.id).toMatch(/^u\d+$/);
	expect(tail.doc.view).toMatchObject({ kind: "tail", leaf: "f799", head: "f799", earlier: true, later: false });
	expect(tail.doc.view?.above?.prompts).toHaveLength(100);
	expect(tail.doc.view?.above?.prompts.at(-1)).toBe(`prompt ${Number(tail.ids[0]?.slice(1)) - 1}`);
	expect(tail.own).toMatchObject({ head: "f799", total: 4800, lastPrompt: "prompt 799" });
	expect(tail.own.header).toMatchObject({ type: "session", title: "Fixture long: a long conversation" });
	// The fork is named, with its own end, and sends no entries.
	const other = tail.doc.members.find((m) => m.file === fork) as SessionFileData;
	expect(other).toMatchObject({
		entries: [],
		head: "kf1",
		total: entries.findIndex((e) => e.id === "f400") + 1 + forkOwn.length,
		lastPrompt: "prompt 1",
	});
	expect(tail.doc.members.map((m) => m.file)).toEqual([conversation, fork]);
	// Versions: the conversation goes on after turn 400, and its fork went another way from there.
	expect(tail.doc.view?.versions).toEqual([]);
	// Far smaller than the lineage whole.
	const sent = (await (await get(conversation, { view: "tail" })).arrayBuffer()).byteLength;
	expect(sent).toBeLessThan(200_000);
});

test("older windows put above the end reach the root of the path, and the entries are the file's own lines", async () => {
	let page = await window(conversation, { view: "tail", limit: 150 });
	let path = page.ids;
	let steps = 0;
	while (page.doc.view?.earlier && steps < 40) {
		const before = path[0] as string;
		page = await window(conversation, { view: "before", at: before, limit: 150 });
		expect(page.own.entries.at(-1)?.id).toBe(ids[ids.indexOf(before) - 1] as string);
		expect(page.doc.view?.later).toBe(true);
		expect(page.own.entries[0]?.id).toMatch(/^u\d+$/);
		path = [...page.ids, ...path];
		steps++;
	}
	expect(steps).toBeGreaterThan(20);
	expect(path).toEqual(ids.slice(ids.length - path.length));
	// A window is the lines of the file, as it holds them.
	const lines = readFileSync(conversation, "utf8").trim().split("\n");
	const fileEntries = lines.map((l) => JSON.parse(l)).filter((e) => typeof e.id === "string");
	const mid = await window(conversation, { view: "around", at: "u400", limit: 60 });
	expect(mid.own.entries).toEqual(mid.ids.map((id) => fileEntries.find((e) => e.id === id)));
});

test("a window around an entry, and the windows after it, reach the end; the path of a window is always one chain", async () => {
	const around = await window(conversation, { view: "around", at: "u100", limit: 80 });
	expect(around.ids).toContain("u100");
	expect(around.doc.view).toMatchObject({ kind: "around", leaf: "f799", earlier: true, later: true });
	let page = around;
	const got = [...around.ids];
	let pages = 0;
	while (page.doc.view?.later && pages < 80) {
		page = await window(conversation, {
			view: "after",
			at: page.ids.at(-1) as string,
			leaf: around.doc.view?.leaf as string,
			limit: 80,
		});
		expect(page.own.entries[0]?.parentId).toBe(got.at(-1) as string);
		expect(page.doc.view?.above).toBeUndefined();
		got.push(...page.ids);
		pages++;
	}
	expect(page.doc.view?.later).toBe(false);
	expect(got).toEqual(ids.slice(ids.indexOf(got[0] as string)));
	for (const w of [around, page])
		expect(w.own.entries.every((e, i) => i === 0 || e.parentId === w.own.entries[i - 1]?.id)).toBe(true);
});

test("the fork is another path of the same tree: its own window, and the other versions of the entries it shares", async () => {
	const tail = await window(fork, { view: "tail" });
	expect(tail.doc.members.map((m) => m.file)).toEqual([conversation, fork]);
	expect(tail.ids.at(-1)).toBe("kf1");
	expect(tail.ids).toEqual(pathTo([...entries, ...forkOwn], "kf1").slice(-tail.ids.length));
	// The turn it went on with from the end of turn 400 is a version of turn 401, which the conversation went on with.
	const group = tail.doc.view?.versions.find((g) => g.parent === "f400");
	expect(group?.entries.map((e) => e.id)).toEqual(["u401"]);
	expect(group?.leads.u401).toEqual({ leaf: "f799", files: [conversation] });
	expect(group?.leads.ku0).toEqual({ leaf: "kf1", files: [fork] });
	const own = tail.doc.members.find((m) => m.file === conversation) as SessionFileData;
	expect(own).toMatchObject({ entries: [], head: "f799", total: 4800 });
	// Asked for the window that holds the point they part at, from the conversation: the fork's turn is the other version.
	const around = await window(conversation, { view: "around", at: "f400", limit: 40 });
	const there = around.doc.view?.versions.find((g) => g.parent === "f400");
	expect(there?.entries.map((e) => e.id)).toEqual(["ku0"]);
});

test("every view carries an ETag that covers what was asked for, and a request that shows it is answered with a 304 and no body", async () => {
	const views: Record<string, string | number>[] = [
		{ view: "tail" },
		{ view: "tail", limit: 30 },
		{ view: "tail", leaf: "f700" },
		{ view: "before", at: "u700" },
		{ view: "after", at: "u100" },
		{ view: "around", at: "u300", limit: 50 },
		{ view: "stats" },
	];
	const seen = new Set<string>();
	for (const params of views) {
		const first = await get(conversation, params);
		expect(first.status).toBe(200);
		const etag = first.headers.get("etag") as string;
		expect(etag).toMatch(/^W\/"[^"]+"$/);
		expect(seen.has(etag)).toBe(false);
		seen.add(etag);
		await first.arrayBuffer();
		const again = await get(conversation, params, { "if-none-match": etag });
		expect(again.status).toBe(304);
		expect(await again.text()).toBe("");
		expect(again.headers.get("etag")).toBe(etag);
		expect(again.headers.get("cache-control")).toContain("no-cache");
		// Every response still goes through the server's header pass.
		expect(again.headers.get("content-security-policy")).toBeTruthy();
		expect((await get(conversation, params, { "if-none-match": 'W/"stale"' })).status).toBe(200);
	}
	// The lineage whole has an ETag of its own.
	const whole = (await get(conversation)).headers.get("etag") as string;
	expect(seen.has(whole)).toBe(false);
});

test("a request that is not one, or names an entry the file does not have, is told so", async () => {
	const malformed: Record<string, string>[] = [
		{ view: "sideways" },
		{ view: "before" },
		{ view: "after", at: "" },
		{ view: "around" },
		{ view: "tail", limit: "many" },
	];
	for (const params of malformed) {
		const res = await get(conversation, params);
		expect(res.status).toBe(400);
		expect(typeof (await res.json()).error).toBe("string");
	}
	const missing: Record<string, string>[] = [
		{ view: "before", at: "nope" },
		{ view: "after", at: "nope" },
		{ view: "around", at: "nope" },
		{ view: "tail", leaf: "nope" },
		{ view: "after", at: "u1", leaf: "nope" },
		{ view: "before", at: "ku0" },
	];
	for (const params of missing) {
		const res = await get(conversation, params);
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.code).toBe("unknown_entry");
		expect(body.error).toContain(String(params.leaf ?? params.at));
	}
	// The file itself.
	expect((await get("/etc/hosts", { view: "tail" })).status).toBe(404);
	expect((await get(`${conversation}.missing`, { view: "tail" })).status).toBe(404);
	// An entry that is the fork's is found in the fork.
	expect((await get(fork, { view: "before", at: "ku0" })).status).toBe(200);
});

test("gzip and plain answers are the same document, and a client that takes no gzip gets it plain", async () => {
	const params = { view: "around", at: "u500", limit: 40 };
	const zipped = await get(conversation, params);
	expect(zipped.status).toBe(200);
	const plain = await get(conversation, params, { "accept-encoding": "identity" });
	expect(plain.status).toBe(200);
	expect(plain.headers.get("etag")).toBe(zipped.headers.get("etag"));
	expect(await plain.json()).toEqual(await zipped.json());
	// What goes over the wire: compressed for one, not for the other.
	const raw = async (encoding: string) => {
		const curl = Bun.spawn(
			[
				"curl",
				"-s",
				"-H",
				`x-omp-webui-token: ${s.accessToken}`,
				"-H",
				`accept-encoding: ${encoding}`,
				"-i",
				url(conversation, params),
			],
			{ stdout: "pipe" },
		);
		return Buffer.from(await new Response(curl.stdout).arrayBuffer());
	};
	const gz = await raw("gzip");
	expect(gz.subarray(0, 400).toString("latin1").toLowerCase()).toContain("content-encoding: gzip");
	const body = gz.subarray(gz.indexOf("\r\n\r\n") + 4);
	expect(JSON.parse(gunzipSync(body).toString()).view.kind).toBe("around");
	const identity = await raw("identity");
	expect(identity.subarray(0, 400).toString("latin1").toLowerCase()).not.toContain("content-encoding");
	expect(JSON.parse(identity.subarray(identity.indexOf("\r\n\r\n") + 4).toString()).view.kind).toBe("around");
});

test("the figures of the file are the ones the page adds up from its entries", async () => {
	const res = await get(conversation, { view: "stats" });
	expect(res.status).toBe(200);
	const { file, stats }: FamilyStatsDocument = await res.json();
	expect(file).toBe(conversation);
	const parsed = parseSessionText(readFileSync(conversation, "utf8")).entries;
	expect(stats.through).toBe("f799");
	expect(stats.usage).toEqual(sumEntries(parsed));
	expect(stats.byModel).toEqual(usageByModel(parsed));
	expect(stats.clock.total + (stats.clock.start !== null ? stats.clock.end - stats.clock.start : 0)).toBe(
		activeMs(parsed),
	);
	expect(stats.byModel).toHaveLength(1);
});

test("a conversation that is written to is a new document, of which only the end differs, and the whole mode is as it was", async () => {
	const before = await window(conversation, { view: "tail" });
	const etag = before.res.headers.get("etag") as string;
	const stats = ((await (await get(conversation, { view: "stats" })).json()) as FamilyStatsDocument).stats;
	const more = turns(3, { prefix: "g", parent: "f799", at: 200_000, steps: 1 });
	appendFileSync(conversation, `${more.map((e) => JSON.stringify(e)).join("\n")}\n`);

	const stale = await get(conversation, { view: "tail" }, { "if-none-match": etag });
	expect(stale.status).toBe(200);
	expect(stale.headers.get("etag")).not.toBe(etag);
	const after: FamilyDocument = await stale.json();
	const own = after.members.find((m) => m.file === conversation) as SessionFileData;
	expect(after.view).toMatchObject({ leaf: "gf2", head: "gf2" });
	expect(own).toMatchObject({ head: "gf2", total: 4800 + more.length, lastPrompt: "prompt 2" });
	const now = own.entries.map((e) => e.id);
	expect(now.slice(-more.length)).toEqual(more.map((e) => e.id));
	// What was there is still there, and byte for byte: the window slid down the path.
	const kept = now.slice(now.indexOf(before.ids.at(-1) as string) - 20, now.indexOf(before.ids.at(-1) as string) + 1);
	expect(kept).toEqual(before.ids.slice(-21));
	expect(own.entries.filter((e) => before.ids.includes(e.id))).toEqual(
		before.own.entries.filter((e) => now.includes(e.id)),
	);
	// The figures go on from where they were.
	const grown = ((await (await get(conversation, { view: "stats" })).json()) as FamilyStatsDocument).stats;
	expect(grown.through).toBe("gf2");
	expect(grown.usage.cost).toBeGreaterThan(stats.usage.cost);
	const parsed = parseSessionText(readFileSync(conversation, "utf8")).entries;
	expect(grown.usage).toEqual(sumEntries(parsed));
	expect(grown.clock.total + (grown.clock.start !== null ? grown.clock.end - grown.clock.start : 0)).toBe(
		activeMs(parsed),
	);

	// The whole mode, as before: every entry of every file.
	const whole: FamilyDocument = await (await get(conversation)).json();
	expect(whole.view).toBeUndefined();
	expect(whole.members.map((m) => m.file)).toEqual([conversation, fork]);
	expect((whole.members[0] as SessionFileData).entries).toHaveLength(4800 + more.length);
	expect((whole.members[1] as SessionFileData).entries).toHaveLength(
		entries.findIndex((e) => e.id === "f400") + 1 + forkOwn.length,
	);
	expect((whole.members[0] as SessionFileData).head).toBeUndefined();
	const session = await (
		await fetch(`${s.url}/api/session?file=${encodeURIComponent(conversation)}`, { headers: authed() })
	).json();
	expect(session.entries).toHaveLength(4800 + more.length);
});
