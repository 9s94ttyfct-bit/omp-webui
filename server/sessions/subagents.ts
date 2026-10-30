import type { Database, Statement } from "bun:sqlite";
import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AdvisorFile, SubagentFile, UsageTotals } from "../../shared/protocol.ts";
import { SessionFile, SLICE_MS, yieldToLoop } from "./lines.ts";
import {
	activeMsOf,
	addTotals,
	copyUsageFold,
	emptyUsage,
	foldUsageLine,
	isSoundUsage,
	newUsageFold,
	type UsageFold,
} from "./parse.ts";

/**
 * The subagent and advisor transcripts of a session, with what each spent.
 *
 * omp keeps a session's artifacts in the directory its file name names (`X.jsonl` → `X/`). A subagent's
 * transcript is `X/<Id>.jsonl`, and it has an artifacts directory of its own (`X/<Id>/`) for the subagents
 * it starts: those are named after their parent (`X/<Id>/<Id>.<Child>.jsonl`). An advisor is not a subagent:
 * it is a passive reviewer whose requests omp writes to `__advisor.jsonl` (`__advisor.<name>.jsonl` for a named
 * one) in the directory of the session it reviews, or of the subagent it reviews. Its requests are in no other
 * transcript, so they are counted from there, apart from the subagents'. The other folders omp puts there
 * (`local/`, `url-search/`) are neither.
 *
 * Reading a transcript is the expensive part, and a running subagent's file changes while its parent's does
 * not, so what each file spent is cached by its modification time and size (and kept in the database across
 * restarts). A transcript only grows at its end, so one that grew is read on from where the last read stopped,
 * not from its first byte: a subagent that has been running for hours costs what it wrote since, not what it is.
 */

/** Deeper than omp lets agents nest; stops a symlinked directory from being followed forever. */
const MAX_DEPTH = 8;

/** What a transcript under the artifacts directory is: a subagent's, or an advisor's. */
interface Found {
	id: string;
	/** For an advisor, the subagent it reviews (empty: the session's own). */
	agent: string;
	advisor: boolean;
}

interface Cached {
	owner: string;
	mtimeMs: number;
	size: number;
	startedAt: number;
	usage: UsageTotals;
	/** The providers its requests went to; undefined for a row kept by a version that did not keep them (read again when asked). */
	providers?: string[];
	/** How long the agent worked in it (#692); undefined for a row kept by a version that did not count it (read again when asked). */
	activeMs?: number;
	/** Where this read stopped, kept in memory only: a transcript read for the first time in this process is read whole. */
	fold?: { upto: number; tail: string; state: UsageFold };
}

interface Row {
	file: string;
	owner: string;
	mtime: number;
	size: number;
	started: number;
	usage: string;
	providers: string | null;
	active: number | null;
}

export class SubagentIndex {
	/** Transcripts read from disk, rather than answered from the cache, so far. */
	parsed = 0;
	/** Bytes of transcripts read from disk so far: what each read covered, from where the transcript was read on. */
	bytesRead = 0;
	private readonly cache = new Map<string, Cached>();
	/** The transcripts cached for each session file, to find the ones that went away. */
	private readonly byOwner = new Map<string, Set<string>>();
	private readonly reading = new Map<string, Promise<Cached | null>>();
	private readonly save: Statement | null;
	private readonly drop: Statement | null;

	constructor(db: Database | null = null) {
		this.save = null;
		this.drop = null;
		if (!db) return;
		// One row per transcript file, a subagent's or an advisor's alike (the table's name is from when there were no others).
		db.run(
			"CREATE TABLE IF NOT EXISTS subagent_usage (file TEXT PRIMARY KEY, owner TEXT NOT NULL, mtime REAL, size INTEGER, started REAL, usage TEXT)",
		);
		// The providers of each transcript (#688) and its working time (#692): columns an older table does not have yet.
		const columns = db.query<{ name: string }, []>("PRAGMA table_info(subagent_usage)").all();
		if (!columns.some((c) => c.name === "providers")) db.run("ALTER TABLE subagent_usage ADD COLUMN providers TEXT");
		if (!columns.some((c) => c.name === "active")) db.run("ALTER TABLE subagent_usage ADD COLUMN active REAL");
		this.save = db.prepare(
			"INSERT OR REPLACE INTO subagent_usage (file, owner, mtime, size, started, usage, providers, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		);
		this.drop = db.prepare("DELETE FROM subagent_usage WHERE file = ?");
		for (const r of db
			.query<Row, []>("SELECT file, owner, mtime, size, started, usage, providers, active FROM subagent_usage")
			.all()) {
			const usage: unknown = JSON.parse(r.usage);
			// What an older version summed from malformed usage is not a total: that file is read again.
			if (!isSoundUsage(usage)) {
				this.drop.run(r.file);
				continue;
			}
			this.remember(r.file, {
				owner: r.owner,
				mtimeMs: r.mtime,
				size: r.size,
				startedAt: r.started,
				usage,
				providers: providersOf(r.providers),
				activeMs: typeof r.active === "number" && Number.isFinite(r.active) ? r.active : undefined,
			});
		}
	}

	private remember(path: string, c: Cached): void {
		this.cache.set(path, c);
		const owned = this.byOwner.get(c.owner) ?? new Set<string>();
		owned.add(path);
		this.byOwner.set(c.owner, owned);
	}

	private forget(path: string): void {
		const c = this.cache.get(path);
		if (!c) return;
		this.cache.delete(path);
		this.byOwner.get(c.owner)?.delete(path);
		this.drop?.run(path);
	}

	/** Every subagent transcript of `sessionFile`, nested ones included, oldest modification first, with their providers. */
	async list(sessionFile: string): Promise<SubagentFile[]> {
		return (await this.scan(sessionFile, true)).subagents;
	}

	/**
	 * Every transcript under `sessionFile`'s artifacts directory in one pass: its subagents (nested ones included)
	 * and its advisors (a subagent's own ones too), each oldest modification first. `providers`: a transcript kept by a
	 * version that did not keep its providers or working time is read again for them (only the conversation a page shows asks).
	 */
	async scan(sessionFile: string, providers = false): Promise<{ subagents: SubagentFile[]; advisors: AdvisorFile[] }> {
		const found = new Map<string, Found>();
		collect(sessionFile, found, 0, "");
		const subagents: SubagentFile[] = [];
		const advisors: AdvisorFile[] = [];
		for (const [path, f] of found) {
			let st: { mtimeMs: number; size: number };
			try {
				st = statSync(path);
			} catch {
				continue;
			}
			let c = this.cache.get(path);
			if (c?.mtimeMs !== st.mtimeMs || c.size !== st.size || (providers && (!c.providers || c.activeMs === undefined)))
				c = (await this.read(path, sessionFile, st)) ?? undefined;
			if (!c) continue;
			const of = {
				file: path,
				size: st.size,
				modifiedAt: st.mtimeMs,
				startedAt: c.startedAt,
				usage: c.usage,
				providers: c.providers ?? [],
				activeMs: c.activeMs ?? 0,
			};
			if (f.advisor) advisors.push({ id: f.id, agent: f.agent, ...of });
			else subagents.push({ id: f.id, ...of });
		}
		for (const path of [...(this.byOwner.get(sessionFile) ?? [])]) if (!found.has(path)) this.forget(path);
		return {
			subagents: subagents.sort((a, b) => a.modifiedAt - b.modifiedAt),
			advisors: advisors.sort((a, b) => a.modifiedAt - b.modifiedAt),
		};
	}

	/** Forget the sessions that are not in `keep` (deleted, or moved away). */
	prune(keep: Set<string>): void {
		for (const owner of [...this.byOwner.keys()]) if (!keep.has(owner)) this.forgetSession(owner);
	}

	/** Forget the transcripts of the session `owner` (deleted, or moved away). */
	forgetSession(owner: string): void {
		for (const path of [...(this.byOwner.get(owner) ?? [])]) this.forget(path);
		this.byOwner.delete(owner);
	}

	/** Read one transcript. Callers asking for the same file while it is read wait for that read. */
	private read(path: string, owner: string, st: { mtimeMs: number; size: number }): Promise<Cached | null> {
		const key = `${path}\0${st.mtimeMs}\0${st.size}`;
		let pending = this.reading.get(key);
		if (!pending) {
			pending = this.parse(path, owner).finally(() => this.reading.delete(key));
			this.reading.set(key, pending);
		}
		return pending;
	}

	private async parse(path: string, owner: string): Promise<Cached | null> {
		// Opened once: all of the read, and what it is recorded as, is of this file, however the path is replaced meanwhile.
		const open = SessionFile.open(path);
		if (!open) return null; // removed since it was listed
		try {
			const prior = this.cache.get(path)?.fold;
			let state = newUsageFold();
			let from = 0;
			// What the last read took in is still what the file starts with: read on from there, not from the first byte.
			if (prior && open.size >= prior.upto && open.windowHash(prior.upto) === prior.tail) {
				state = copyUsageFold(prior.state);
				from = prior.upto;
			}
			this.parsed++;
			const lines = open.lines(from);
			let upto = from;
			let sliceBegan = performance.now();
			for (;;) {
				const line = await lines.next();
				if (!line) break;
				// The writer may be in the middle of this line: it is read once it is whole.
				if (!line.terminated && !isJson(line.text)) break;
				foldUsageLine(state, line.text);
				upto = line.end;
				// A transcript read whole for the first time is megabytes: the event loop gets its turn in between.
				if (performance.now() - sliceBegan > SLICE_MS) {
					await yieldToLoop();
					sliceBegan = performance.now();
				}
			}
			this.bytesRead += upto - from;
			const c: Cached = {
				owner,
				mtimeMs: open.mtimeMs,
				size: open.size,
				startedAt: state.startedAt ?? open.mtimeMs,
				usage: state.usage,
				providers: [...state.providers],
				activeMs: activeMsOf(state),
				fold: { upto, tail: open.windowHash(upto), state },
			};
			this.forget(path);
			this.remember(path, c);
			this.save?.run(
				path,
				owner,
				c.mtimeMs,
				c.size,
				c.startedAt,
				JSON.stringify(c.usage),
				JSON.stringify(c.providers),
				c.activeMs ?? null,
			);
			return c;
		} finally {
			open.close();
		}
	}
}

/** The providers a row keeps (a JSON list of names), or undefined when it keeps none: a row of a version before them. */
function providersOf(text: string | null): string[] | undefined {
	if (text === null) return undefined;
	try {
		const list: unknown = JSON.parse(text);
		return Array.isArray(list) && list.every((p) => typeof p === "string") ? list : undefined;
	} catch {
		return undefined;
	}
}

function isJson(text: string): boolean {
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
}

/** The advisor an artifacts-directory file is the transcript of (`default` for the one without a name), or null if it is no advisor's. */
function advisorName(file: string): string | null {
	if (file === "__advisor.jsonl") return "default";
	if (!file.startsWith("__advisor.") || !file.endsWith(".jsonl")) return null;
	return file.slice("__advisor.".length, -".jsonl".length) || "default";
}

/**
 * The transcripts under `sessionFile`'s artifacts directory, as path → what they are, following each subagent's own
 * directory. `agent` is the subagent whose directory this is (empty for the session's).
 */
function collect(sessionFile: string, into: Map<string, Found>, depth: number, agent: string): void {
	if (depth > MAX_DEPTH) return;
	const dir = sessionFile.replace(/\.jsonl$/, "");
	// Most sessions have no artifacts directory; looking is cheaper than failing to read it.
	if (!existsSync(dir)) return;
	let items: Dirent[];
	try {
		items = readdirSync(dir, { withFileTypes: true });
	} catch {
		return; // removed since the check
	}
	for (const it of items) {
		if (!it.isFile() || !it.name.endsWith(".jsonl") || it.name.startsWith(".")) continue;
		const path = join(dir, it.name);
		const advisor = advisorName(it.name);
		if (advisor !== null) {
			into.set(path, { id: advisor, agent, advisor: true });
			continue;
		}
		if (it.name.startsWith("__")) continue;
		const id = it.name.slice(0, -".jsonl".length);
		into.set(path, { id, agent: "", advisor: false });
		collect(path, into, depth + 1, id);
	}
}

/** How many subagents there are and what they spent together. */
export function sumSubagents(list: SubagentFile[]): { count: number; usage: UsageTotals } {
	return { count: list.length, usage: list.reduce((sum, s) => addTotals(sum, s.usage), emptyUsage()) };
}

/** What the advisors spent together. */
export function sumAdvisors(list: AdvisorFile[]): UsageTotals {
	return list.reduce((sum, a) => addTotals(sum, a.usage), emptyUsage());
}
