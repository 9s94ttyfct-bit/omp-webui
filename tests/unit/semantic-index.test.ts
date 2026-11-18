import { afterAll, afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RawSemanticHit, SemanticIndex, type SemanticRuntime } from "../../server/semantic-index.ts";
import { SessionStore } from "../../server/sessions/store.ts";
import { removeScratch } from "../support/scratch.ts";

/**
 * Semantic search's worker against a stand-in for `llama-server`: it embeds what the full-text index holds, finds a
 * conversation by a word it never says, keeps its vectors across a restart, and forgets a conversation the full-text index
 * forgot. The stand-in's "model" knows three topics, one dimension each: what it says of a text is which topics it names.
 */

const TOPICS: RegExp[] = [/fruit|apple|orchard|harvest/i, /engine|car|vehicle|gearbox/i, /violin|cello|orchestra/i];
const WIDTH = 768;

function vectorOf(text: string): number[] {
	const v: number[] = new Array(WIDTH).fill(0);
	TOPICS.forEach((re, i) => {
		if (re.test(text)) v[i] = 1;
	});
	// Text of no topic: a direction of its own, far from all of them.
	if (!v.some((x) => x !== 0)) v[WIDTH - 1] = 1;
	return v;
}

const root = mkdtempSync(join(tmpdir(), "ompw-semantic-"));
const embedded: string[] = [];
const fake = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(req) {
		if (req.headers.get("authorization") !== "Bearer k") return new Response("no", { status: 401 });
		const body = (await req.json()) as { input: string[] };
		embedded.push(...body.input);
		return Response.json({ data: body.input.map((t, index) => ({ index, embedding: vectorOf(t) })) });
	},
});
const holds: boolean[] = [];
/** The times the model server was asked for (each would load it if it were not running). */
let ensured = 0;
const runtime: SemanticRuntime = {
	ensure: async () => {
		ensured++;
		return { url: `http://127.0.0.1:${fake.port}`, key: "k" };
	},
	hold: (on) => holds.push(on),
};

const opened: { close(): void }[] = [];
afterEach(() => {
	for (const o of opened.splice(0).reverse()) o.close();
});
afterAll(() => {
	fake.stop(true);
	removeScratch(root);
});

let n = 0;
function library(texts: Record<string, string>) {
	const dir = join(root, `lib-${++n}`);
	const bucket = join(dir, "sessions", "-tmp-semantic");
	mkdirSync(bucket, { recursive: true });
	mkdirSync(join(dir, "data"), { recursive: true });
	const files: Record<string, string> = {};
	Object.entries(texts).forEach(([name, text], i) => {
		const id = `01a00000-0000-7000-8000-${(i + 1).toString(16).padStart(12, "0")}`;
		const file = join(bucket, `2026-01-07T00-00-00-000Z_${id}.jsonl`);
		const lines = [
			{ type: "session", version: 3, id, timestamp: "2026-01-07T00:00:00.000Z", cwd: "/tmp/semantic" },
			{
				type: "message",
				id: `m${i}`,
				parentId: null,
				timestamp: "2026-01-07T00:00:00.000Z",
				message: { role: "user", content: [{ type: "text", text }] },
			},
		];
		writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
		files[name] = file;
	});
	return { sessions: join(dir, "sessions"), data: join(dir, "data"), files };
}

async function store(sessions: string, data: string): Promise<SessionStore> {
	const s = new SessionStore(sessions, join(data, "index.db"));
	opened.push(s);
	await s.indexed();
	return s;
}

function semantic(data: string, ftsPath: string): SemanticIndex {
	const index = new SemanticIndex({ dbPath: join(data, "semantic", "index.db"), ftsPath, runtime });
	opened.push(index);
	return index;
}

async function until(ok: () => boolean, ms = 20_000): Promise<void> {
	const end = Date.now() + ms;
	while (!ok()) {
		if (Date.now() > end) throw new Error("timed out");
		await Bun.sleep(50);
	}
}

const filesOf = (hits: RawSemanticHit[]) => hits.map((h) => h.file);

const TEXTS = {
	fruit: "We planned the apple harvest for the north slope this week.",
	cars: "The gearbox of the old car makes a grinding noise in third.",
	music: "Tuning the cello before the orchestra rehearsal took an hour.",
	short: "ok",
};

test("finds a conversation by what it is about, keeps its vectors, and forgets what the full-text index forgot", async () => {
	mkdirSync(root, { recursive: true });
	const lib = library(TEXTS);
	const fts = await store(lib.sessions, lib.data);
	const first = semantic(lib.data, fts.searchDbPath);
	await until(() => first.progress.total === 4 && first.progress.indexed === 4);

	// "orchard" is said in no conversation: the fruit one is found by its meaning, and nothing of no topic comes up.
	const hits = await first.search("orchard", 10);
	expect(filesOf(hits)).toEqual([lib.files.fruit]);
	expect(hits[0]?.snippet).toContain("apple harvest");
	expect(filesOf(await first.search("vehicle", 10))).toEqual([lib.files.cars]);
	// A message too short to say anything is never embedded.
	expect(embedded.some((t) => t.endsWith("ok"))).toBe(false);
	// The server was held while embedding, and let go after.
	expect(holds.at(-1)).toBe(false);

	// Started again on the same files: nothing is embedded again but the query.
	first.close();
	opened.splice(opened.indexOf(first), 1);
	const before = embedded.length;
	const second = semantic(lib.data, fts.searchDbPath);
	await until(() => second.progress.indexed === 4);
	expect(filesOf(await second.search("orchestra", 10))).toEqual([lib.files.music]);
	expect(embedded.length).toBe(before + 1);

	// The fruit conversation is deleted while the server is stopped: once the full-text index forgets it, so does this one.
	fts.close();
	opened.splice(opened.indexOf(fts), 1);
	rmSync(lib.files.fruit as string);
	const again = await store(lib.sessions, lib.data);
	expect(again.searchDbPath).toBe(fts.searchDbPath);
	await until(() => second.progress.total === 3 && second.progress.indexed === 3);
	expect(await second.search("orchard", 10)).toEqual([]);
}, 30_000);

test("nothing is embedded while a conversation works; what was written meanwhile is, once none does", async () => {
	const lib = library({ music: TEXTS.music, cars: TEXTS.cars });
	const fts = await store(lib.sessions, lib.data);
	const index = semantic(lib.data, fts.searchDbPath);
	await until(() => index.progress.total === 2 && index.progress.indexed === 2 && !index.progress.running);

	// A conversation works, and says something new: the full-text index has it, the model is not asked for it.
	index.pause(true);
	const line = {
		type: "message",
		id: "m-new",
		parentId: "m0",
		timestamp: "2026-01-07T00:01:00.000Z",
		message: { role: "user", content: [{ type: "text", text: "The orchard needs pruning before the apple harvest." }] },
	};
	appendFileSync(lib.files.music as string, `${JSON.stringify(line)}\n`);
	await fts.indexed();
	await until(() => index.progress.total === 3);
	const asked = ensured;
	await Bun.sleep(6000); // more than one look at the full-text index
	expect(index.progress.indexed).toBe(2);
	expect(ensured).toBe(asked);
	// A search is answered all the same, from what is indexed.
	expect(filesOf(await index.search("fruit", 10))).toEqual([]);
	expect(index.progress.indexed).toBe(2);

	// The conversation stops: what it wrote is embedded at once, and found.
	index.pause(false);
	await until(() => index.progress.indexed === 3, 3000);
	expect(filesOf(await index.search("fruit", 10))).toEqual([lib.files.music]);
}, 30_000);
