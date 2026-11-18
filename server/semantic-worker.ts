import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { dropGroupAndOther } from "./private.ts";
import { ROWS_PER_FILE } from "./search-index.ts";
import { DIMENSIONS, DOCUMENT_PROMPT, MODEL, QUERY_PROMPT } from "./semantic/assets.ts";
import type { Endpoint } from "./semantic/runtime.ts";
import { passages, quantize, score, shorten } from "./semantic/vectors.ts";
import type { RawSemanticHit, SemanticJob, SemanticProgress, SemanticReply } from "./semantic-index.ts";

/**
 * Worker thread of `semantic-index.ts`: embeds the messages of the full-text index, passage by passage, and answers searches by
 * scoring every stored vector against the query's. See that file for what it covers and why it lives here.
 *
 * What it has embedded is kept by the full-text index's numbers: per file (`fid`), the `epoch` its rows were read under and how
 * many of them (`seq`), and per passage the message's row id there (`msg`), the passage's number in it and where it begins.
 * Every `POLL_MS` it reads the full-text index's `files`: a file that went, or whose rows were dropped and written again (its
 * epoch moved), loses its vectors here; one that has more rows than were embedded has the rest embedded.
 */

/** How often the full-text index is looked at for what changed. */
const POLL_MS = 5000;
/** Messages read and embedded at a time (their passages go to the server in one request). */
const BATCH_MESSAGES = 24;
/** After embedding failed (the server stopped, or does not answer), it is tried again this much later. */
const RETRY_MS = 30_000;
/** How long one request to the server may take: a batch is a few seconds of work on a processor. */
const EMBED_MS = 180_000;
const PROGRESS_MS = 500;
/**
 * Below this cosine a passage is not near the query in any way that reads as related. EmbeddingGemma's scores (512
 * dimensions, one byte each) sit high, and a short query scores lower than a long one: over 18,000 real messages, a query
 * about nothing in them ("what to cook tonight") found its best at 0.73 and queries about something there 0.79 to 0.87,
 * while on a few one-line conversations "car repair" found the one about a car's gearbox at 0.74 and the others at 0.63 at
 * most. A floor that keeps the short queries' answers lets the best few of a large library's near misses through.
 */
const MIN_SCORE = 0.72;
/** The passage a hit shows: its start, on one line. */
const SNIPPET_CHARS = 160;
/** What the index was made with: an index made with another model, or other dimensions, is made again. */
const MADE_WITH = `${MODEL.sha256}:${DIMENSIONS}`;

let db: Database;
let ftsPath = "";
let opened = false;
let closed = false;

/** What has been embedded of each file of the full-text index. */
const own = new Map<number, { epoch: number; seq: number }>();

// Every stored vector, in memory (a search scores all of them): row `i` is `vecs[i * DIMENSIONS …]` times `scales[i]`.
let count = 0;
let vecs = new Int8Array(0);
let scales = new Float32Array(0);
let msgs = new Float64Array(0);
let starts = new Int32Array(0);

const post = (reply: SemanticReply) => self.postMessage(reply);
const fidOf = (msg: number): number => Math.floor(msg / ROWS_PER_FILE);

function grow(need: number): void {
	if (need <= scales.length) return;
	const cap = Math.max(need, Math.ceil(scales.length * 1.5), 1024);
	const v = new Int8Array(cap * DIMENSIONS);
	v.set(vecs);
	vecs = v;
	const s = new Float32Array(cap);
	s.set(scales);
	scales = s;
	const m = new Float64Array(cap);
	m.set(msgs);
	msgs = m;
	const st = new Int32Array(cap);
	st.set(starts);
	starts = st;
}

function keep(msg: number, start: number, q: Int8Array, scale: number): void {
	grow(count + 1);
	vecs.set(q, count * DIMENSIONS);
	scales[count] = scale;
	msgs[count] = msg;
	starts[count] = start;
	count++;
}

/** The vectors of `fid` leave memory: the others close up behind them. */
function forgetInMemory(fid: number): void {
	let to = 0;
	for (let i = 0; i < count; i++) {
		if (fidOf(msgs[i] as number) === fid) continue;
		if (to !== i) {
			vecs.copyWithin(to * DIMENSIONS, i * DIMENSIONS, (i + 1) * DIMENSIONS);
			scales[to] = scales[i] as number;
			msgs[to] = msgs[i] as number;
			starts[to] = starts[i] as number;
		}
		to++;
	}
	count = to;
}

function openDatabase(path: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const conn = new Database(path, { create: true });
	try {
		// Passages of every conversation, as vectors: for its owner only.
		dropGroupAndOther(path);
		conn.run("PRAGMA journal_mode = WAL");
		for (const side of ["-wal", "-shm"]) dropGroupAndOther(`${path}${side}`);
		conn.run("PRAGMA synchronous = NORMAL");
		conn.run("PRAGMA busy_timeout = 5000");
		conn.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
		conn.run(
			"CREATE TABLE IF NOT EXISTS files (fid INTEGER PRIMARY KEY, epoch INTEGER NOT NULL, seq INTEGER NOT NULL)",
		);
		conn.run(
			"CREATE TABLE IF NOT EXISTS vecs (msg INTEGER NOT NULL, chunk INTEGER NOT NULL, start INTEGER NOT NULL, scale REAL NOT NULL, vec BLOB NOT NULL, PRIMARY KEY (msg, chunk)) WITHOUT ROWID",
		);
		const made = conn.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'made'").get()?.value;
		if (made !== MADE_WITH) {
			conn.run("DELETE FROM vecs");
			conn.run("DELETE FROM files");
			conn.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('made', ?)", [MADE_WITH]);
		}
		own.clear();
		for (const r of conn
			.query<{ fid: number; epoch: number; seq: number }, []>("SELECT fid, epoch, seq FROM files")
			.all())
			own.set(r.fid, { epoch: r.epoch, seq: r.seq });
		count = 0;
		const rows = conn
			.query<{ msg: number; start: number; scale: number; vec: Uint8Array }, []>(
				"SELECT msg, start, scale, vec FROM vecs ORDER BY msg, chunk",
			)
			.all();
		grow(rows.length);
		for (const r of rows) {
			if (r.vec.byteLength !== DIMENSIONS) continue;
			keep(r.msg, r.start, new Int8Array(r.vec.buffer, r.vec.byteOffset, DIMENSIONS), r.scale);
		}
		db = conn;
	} catch (e) {
		conn.close();
		throw e;
	}
}

/** The full-text index, read-only, for one pass (it may be set aside and made again between two: a fresh open sees that). */
function openFts(): Database | null {
	if (!existsSync(ftsPath)) return null;
	try {
		const fts = new Database(ftsPath, { readonly: true });
		fts.run("PRAGMA busy_timeout = 5000");
		return fts;
	} catch {
		return null;
	}
}

/** Everything embedded goes: the full-text index it was read from is another one now. */
function wipe(): void {
	db.run("DELETE FROM vecs");
	db.run("DELETE FROM files");
	own.clear();
	count = 0;
}

/** The vectors of `fid` go; with `epoch`, it is to be embedded again from its first row under that epoch. */
function drop(fid: number, epoch?: number): void {
	db.transaction(() => {
		db.run("DELETE FROM vecs WHERE msg >= ? AND msg < ?", [fid * ROWS_PER_FILE, (fid + 1) * ROWS_PER_FILE]);
		if (epoch === undefined) db.run("DELETE FROM files WHERE fid = ?", [fid]);
		else db.run("INSERT OR REPLACE INTO files (fid, epoch, seq) VALUES (?, ?, 0)", [fid, epoch]);
	})();
	forgetInMemory(fid);
	if (epoch === undefined) own.delete(fid);
	else own.set(fid, { epoch, seq: 0 });
}

let lastProgress = 0;
function report(progress: SemanticProgress, force = false): void {
	const now = performance.now();
	if (!force && now - lastProgress < PROGRESS_MS) return;
	lastProgress = now;
	post({ t: "progress", progress });
}

// The server, as the other side gives it (`need`): asked for when there is something to embed.
let asked = 0;
const answers = new Map<number, (e: Endpoint | null, error?: string) => void>();
function need(): Promise<Endpoint> {
	const id = ++asked;
	const { promise, resolve, reject } = Promise.withResolvers<Endpoint>();
	answers.set(id, (endpoint, error) => (endpoint ? resolve(endpoint) : reject(new Error(error ?? "no server"))));
	post({ t: "need", id });
	return promise;
}

/** The vectors of `texts`, in order; null for one the model answered no number for. */
async function embed(endpoint: Endpoint, texts: string[]): Promise<(Float32Array | null)[]> {
	const res = await fetch(`${endpoint.url}/v1/embeddings`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.key}` },
		body: JSON.stringify({ input: texts, model: "embeddinggemma" }),
		signal: AbortSignal.timeout(EMBED_MS),
	});
	if (!res.ok) throw new Error(`llama-server answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
	const body = (await res.json()) as { data?: { index?: number; embedding?: (number | null)[] }[] };
	const out: (Float32Array | null)[] = texts.map(() => null);
	for (const [k, d] of (body.data ?? []).entries()) {
		const at = typeof d.index === "number" ? d.index : k;
		if (at >= 0 && at < out.length && Array.isArray(d.embedding)) out[at] = shorten(d.embedding);
	}
	return out;
}

let running = false;
let again = false;
let retryAt = 0;
let troubled = false;
let busy = false;

function setBusy(on: boolean): void {
	if (busy === on) return;
	busy = on;
	post({ t: "busy", on });
}

/** One pass over the full-text index, again while something asked for one meanwhile. */
async function pass(): Promise<void> {
	if (running) {
		again = true;
		return;
	}
	running = true;
	try {
		do {
			again = false;
			await syncOnce();
		} while (again && !closed);
	} catch (e) {
		post({ t: "error", id: null, message: e instanceof Error ? e.message : String(e) });
	} finally {
		running = false;
		if (!closed) setBusy(false);
	}
}

type FtsFile = { fid: number; epoch: number; seq: number };

async function syncOnce(): Promise<void> {
	if (closed) return;
	const fts = openFts();
	if (!fts) {
		report({ indexed: 0, total: 0 }, true);
		return;
	}
	try {
		const id = fts.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'id'").get()?.value;
		// An index without an id is one of a server of an earlier version, which the next start gives one.
		if (!id) return;
		const seen = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'fts'").get()?.value;
		if (seen !== id) {
			wipe();
			db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('fts', ?)", [id]);
		}
		// A file being forgotten is renamed to end in "\0gone" until its rows are deleted: it is gone.
		const listed = fts
			.query<FtsFile, []>("SELECT fid, epoch, seq FROM files WHERE instr(file, char(0)) = 0 ORDER BY fid")
			.all();
		const there = new Map(listed.map((f) => [f.fid, f]));
		for (const [fid, mine] of [...own]) {
			const f = there.get(fid);
			if (!f) drop(fid);
			else if (f.epoch !== mine.epoch || f.seq < mine.seq) drop(fid, f.epoch);
		}
		const progress = (): SemanticProgress => {
			let indexed = 0;
			let total = 0;
			for (const f of listed) {
				total += f.seq;
				const mine = own.get(f.fid);
				if (mine && mine.epoch === f.epoch) indexed += Math.min(mine.seq, f.seq);
			}
			return { indexed, total };
		};
		report(progress(), true);
		const work = listed.filter((f) => {
			const mine = own.get(f.fid);
			return f.seq > (mine && mine.epoch === f.epoch ? mine.seq : 0);
		});
		if (work.length === 0 || Date.now() < retryAt) return;
		setBusy(true);
		let endpoint: Endpoint;
		try {
			endpoint = await need();
		} catch (e) {
			trouble(e);
			return;
		}
		for (const f of work) {
			if (!own.has(f.fid) || own.get(f.fid)?.epoch !== f.epoch) drop(f.fid, f.epoch);
			for (;;) {
				if (closed) return;
				const mine = own.get(f.fid);
				if (!mine) break;
				// The file's rows as they are now, in one read: its epoch and length, and the next messages under them.
				const batch = fts.transaction(() => {
					const now = fts.query<FtsFile, [number]>("SELECT fid, epoch, seq FROM files WHERE fid = ?").get(f.fid);
					if (!now) return null;
					const first = f.fid * ROWS_PER_FILE;
					const rows = fts
						.query<{ rowid: number; text: string }, [number, number, number]>(
							"SELECT rowid, text FROM fts WHERE rowid >= ? AND rowid < ? ORDER BY rowid LIMIT ?",
						)
						.all(first + mine.seq, first + now.seq, BATCH_MESSAGES);
					return { now, rows };
				})();
				if (!batch) {
					drop(f.fid);
					break;
				}
				if (batch.now.epoch !== mine.epoch || batch.now.seq < mine.seq) {
					drop(f.fid, batch.now.epoch);
					continue;
				}
				if (mine.seq >= batch.now.seq) break;
				const items = batch.rows.flatMap((r) =>
					passages(r.text).map((p, chunk) => ({ msg: r.rowid, chunk, start: p.start, text: p.text })),
				);
				let vectors: (Float32Array | null)[] = [];
				if (items.length) {
					try {
						vectors = await embed(
							endpoint,
							items.map((i) => DOCUMENT_PROMPT + i.text),
						);
					} catch {
						// The server may have been stopped and started again (another port): asked for once more.
						try {
							endpoint = await need();
							vectors = await embed(
								endpoint,
								items.map((i) => DOCUMENT_PROMPT + i.text),
							);
						} catch (e) {
							trouble(e);
							return;
						}
					}
				}
				if (closed) return;
				// Dropped or embedded again meanwhile (a search does not change it, a pass does not run twice): written as read.
				if (own.get(f.fid) !== mine) continue;
				const last = batch.rows.at(-1);
				const seq = last ? last.rowid - f.fid * ROWS_PER_FILE + 1 : batch.now.seq;
				const kept: { msg: number; start: number; q: Int8Array; scale: number }[] = [];
				db.transaction(() => {
					const put = db.query("INSERT OR REPLACE INTO vecs (msg, chunk, start, scale, vec) VALUES (?, ?, ?, ?, ?)");
					items.forEach((item, k) => {
						const v = vectors[k];
						if (!v) return;
						const { q, scale } = quantize(v);
						put.run(item.msg, item.chunk, item.start, scale, new Uint8Array(q.buffer, q.byteOffset, q.length));
						kept.push({ msg: item.msg, start: item.start, q, scale });
					});
					db.run("INSERT OR REPLACE INTO files (fid, epoch, seq) VALUES (?, ?, ?)", [f.fid, mine.epoch, seq]);
				})();
				for (const k of kept) keep(k.msg, k.start, k.q, k.scale);
				mine.seq = seq;
				if (troubled) {
					troubled = false;
					post({ t: "trouble", message: null });
				}
				report(progress());
			}
		}
		report(progress(), true);
	} finally {
		fts.close();
	}
}

function trouble(e: unknown): void {
	retryAt = Date.now() + RETRY_MS;
	troubled = true;
	post({ t: "trouble", message: e instanceof Error ? e.message : String(e) });
}

/** The `max` conversations whose passages are closest to `q`, one passage each, best first. */
async function search(q: string, max: number, endpoint: Endpoint): Promise<RawSemanticHit[]> {
	const [query] = await embed(endpoint, [QUERY_PROMPT + q]);
	if (!query || closed) return [];
	const best = new Map<number, { score: number; i: number }>();
	for (let i = 0; i < count; i++) {
		const s = score(query, vecs, i, scales[i] as number);
		if (s < MIN_SCORE) continue;
		const fid = fidOf(msgs[i] as number);
		const was = best.get(fid);
		if (!was || s > was.score) best.set(fid, { score: s, i });
	}
	const top = [...best.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, max);
	if (top.length === 0) return [];
	const fts = openFts();
	if (!fts) return [];
	try {
		// One read of the full-text index: a file whose rows were dropped and written again since its vectors were made (its
		// epoch moved; the next pass embeds it again) holds other text under the same row ids, which this score is not for.
		fts.run("BEGIN");
		const hits: RawSemanticHit[] = [];
		for (const [fid, { score: s, i }] of top) {
			const now = fts
				.query<{ file: string; epoch: number }, [number]>("SELECT file, epoch FROM files WHERE fid = ?")
				.get(fid);
			const row = fts
				.query<{ text: string; entry_id: string; role: string; ts: string }, [number]>(
					"SELECT text, entry_id, role, ts FROM fts WHERE rowid = ?",
				)
				.get(msgs[i] as number);
			if (!now || now.epoch !== own.get(fid)?.epoch || now.file.includes("\0") || !row) continue;
			const file = now.file;
			const start = starts[i] as number;
			const snippet = row.text
				.slice(start, start + SNIPPET_CHARS * 2)
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, SNIPPET_CHARS);
			hits.push({ file, entryId: row.entry_id, role: row.role, snippet, timestamp: row.ts, score: s });
		}
		return hits;
	} finally {
		if (fts.inTransaction) fts.run("COMMIT");
		fts.close();
	}
}

let timer: ReturnType<typeof setInterval> | undefined;

self.onmessage = async (event: MessageEvent<SemanticJob>) => {
	const job = event.data;
	try {
		switch (job.t) {
			case "open": {
				ftsPath = job.ftsPath;
				try {
					openDatabase(job.dbPath);
				} catch {
					// The vectors are made again from the conversations: a file that cannot be opened is started over.
					for (const side of ["", "-wal", "-shm"]) rmSync(`${job.dbPath}${side}`, { force: true });
					openDatabase(job.dbPath);
				}
				opened = true;
				void pass();
				timer = setInterval(() => void pass(), POLL_MS);
				return;
			}
			case "endpoint":
				answers.get(job.id)?.(job.endpoint, job.error);
				answers.delete(job.id);
				return;
			case "search": {
				if (!opened) throw new Error("The semantic index is not open");
				post({ t: "result", id: job.id, hits: await search(job.q, job.max, job.endpoint) });
				return;
			}
			case "close":
				closed = true;
				clearInterval(timer);
				try {
					if (opened) db.close();
				} catch {
					// nothing more to do with it
				}
				Atomics.store(job.done, 0, 1);
				Atomics.notify(job.done, 0);
				return;
		}
	} catch (e) {
		post({
			t: "error",
			id: job.t === "search" ? job.id : null,
			message: e instanceof Error ? e.message : String(e),
		});
	}
};
