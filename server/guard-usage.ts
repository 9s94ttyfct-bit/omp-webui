import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { finite, isRecord, usageCost } from "../shared/guards.ts";
import { agentTypesOf, entryKey } from "./omp/stats-db.ts";
import { SessionFile } from "./sessions/lines.ts";

/**
 * What "Guard dangerous commands" spent, for Usage & cost › By agent type (#689). The reviewer's requests are `model_usage`
 * entries (`"purpose":"guard"`) in the transcript of the agent whose call was reviewed. `omp stats` counts every
 * `model_usage` entry under the agent type of its transcript (a conversation's: `main`, a subagent's: `subagent`, an
 * advisor's: `advisor`), so the guard's share is already in those buckets and in the totals: it is taken out of the bucket
 * it is in and shown as a `guard` bucket of its own, and the totals stay as omp says.
 *
 * `omp stats --json` covers a window (its `overall.firstTimestamp` to `lastTimestamp`); the guard's requests are counted
 * over the same one. Only transcripts written to since the window began are read, each from where the last read stopped.
 *
 * Only the requests omp counted are moved (#706): omp's database is asked, by entry id and time, which it holds and under
 * what agent type. A transcript omp never ingested a stretch of, or one it has not synced yet, has requests that are in no
 * bucket of omp's answer, and they stay out of the guard's.
 */

export type TranscriptKind = "main" | "subagent" | "advisor";

export interface GuardRequest {
	/** The id of its `model_usage` entry: with its time, how omp's database names it. */
	id: string;
	at: number;
	/** The agent type it is taken out of: its transcript's (`transcriptKind`) until it is known which omp counted it under (`counted`). */
	kind: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

/**
 * The agent type `omp stats` gives a transcript: an advisor's by its name, a subagent's by living in an artifacts folder
 * (named after the transcript beside it, `<stem>/` next to `<stem>.jsonl`: a conversation's, or a subagent's own for the
 * ones it started), anything else a conversation's.
 */
export function transcriptKind(path: string): TranscriptKind {
	if (basename(path).startsWith("__advisor")) return "advisor";
	try {
		if (statSync(`${dirname(path)}.jsonl`).isFile()) return "subagent";
	} catch {
		// Not an artifacts folder.
	}
	return "main";
}

/** One transcript line as a guard request, or null when it is not one. */
export function guardRequestOf(line: string, kind: TranscriptKind): GuardRequest | null {
	if (!line.includes('"purpose":"guard"') || !line.includes('"model_usage"')) return null;
	let obj: unknown;
	try {
		obj = JSON.parse(line);
	} catch {
		return null;
	}
	if (!isRecord(obj) || obj.type !== "model_usage" || obj.purpose !== "guard" || !isRecord(obj.usage)) return null;
	// omp tells entries by id: one without is not one it counts.
	if (typeof obj.id !== "string" || obj.id === "") return null;
	const at = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : Number.NaN;
	if (!Number.isFinite(at)) return null;
	const u = obj.usage;
	return {
		id: obj.id,
		at,
		kind,
		input: finite(u.input),
		output: finite(u.output),
		cacheRead: finite(u.cacheRead),
		cacheWrite: finite(u.cacheWrite),
		cost: usageCost(u),
	};
}

interface Read {
	size: number;
	mtimeMs: number;
	upto: number;
	tail: string;
	requests: GuardRequest[];
}

/** Every `.jsonl` under `root`, at any depth (conversations, their subagents and advisors). */
function transcripts(root: string, out: string[] = []): string[] {
	let names: import("node:fs").Dirent[];
	try {
		names = readdirSync(root, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const d of names) {
		const path = join(root, d.name);
		if (d.isDirectory()) transcripts(path, out);
		else if (d.isFile() && d.name.endsWith(".jsonl")) out.push(path);
	}
	return out;
}

export class GuardUsageIndex {
	private readonly reads = new Map<string, Read>();

	constructor(private readonly root: string) {}

	/** The guard's requests from `from` on, in transcripts written to since then. */
	async since(from: number): Promise<GuardRequest[]> {
		const out: GuardRequest[] = [];
		const seen = new Set<string>();
		for (const path of transcripts(this.root)) {
			let st: { size: number; mtimeMs: number };
			try {
				st = statSync(path);
			} catch {
				continue;
			}
			// Every transcript there is stays known, whatever the window: a 24-hour ask must not drop the reads a 30-day one
			// is made of (#714). Only a transcript that is gone is forgotten.
			seen.add(path);
			if (st.mtimeMs < from) continue;
			const read = await this.read(path, st);
			for (const r of read?.requests ?? []) if (r.at >= from) out.push(r);
		}
		for (const path of this.reads.keys()) if (!seen.has(path)) this.reads.delete(path);
		return out;
	}

	private async read(path: string, st: { size: number; mtimeMs: number }): Promise<Read | null> {
		const prior = this.reads.get(path);
		if (prior && prior.size === st.size && prior.mtimeMs === st.mtimeMs) return prior;
		const open = SessionFile.open(path);
		if (!open) return null;
		try {
			// A transcript only grows at its end: read on from where the last read stopped while what it read is still there.
			const goOn = prior && open.size >= prior.upto && open.windowHash(prior.upto) === prior.tail;
			const requests = goOn ? [...prior.requests] : [];
			const kind = transcriptKind(path);
			const lines = open.lines(goOn ? prior.upto : 0);
			let upto = goOn ? prior.upto : 0;
			for (;;) {
				const line = await lines.next();
				// A line the writer is still in the middle of is read once it is whole.
				if (!line?.terminated) break;
				const r = guardRequestOf(line.text, kind);
				if (r) requests.push(r);
				upto = line.end;
			}
			const read: Read = { size: open.size, mtimeMs: open.mtimeMs, upto, tail: open.windowHash(upto), requests };
			this.reads.set(path, read);
			return read;
		} finally {
			open.close();
		}
	}
}

type Bucket = Record<string, unknown>;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * `omp stats --json` (`body`) with the guard's requests of its window as a `guard` agent type, taken out of the type omp
 * counted them under. The text as it was when there is nothing to move, or it is not the shape expected.
 *
 * `window` is the range the page asked for (#714), and bounds the guard's requests as it bounds every other figure of the
 * answer; without one, the answer's own first and last request do (omp's 24 hours).
 */
export function withGuardBucket(
	body: string,
	requests: readonly GuardRequest[],
	window?: { from: number; to: number },
): string {
	let stats: unknown;
	try {
		stats = JSON.parse(body);
	} catch {
		return body;
	}
	if (!isRecord(stats) || !isRecord(stats.overall) || !Array.isArray(stats.byAgentType)) return body;
	const from = window ? window.from : num(stats.overall.firstTimestamp);
	const to = window ? window.to : num(stats.overall.lastTimestamp);
	const inWindow = requests.filter((r) => r.at >= from && (to === 0 || r.at <= to));
	if (!inWindow.length) return body;
	const byAgentType = stats.byAgentType.filter(isRecord).map((b) => ({ ...b }));
	const guard: Bucket = {
		agentType: "guard",
		totalRequests: 0,
		// omp gives no success or error counts by agent type (null): nor does this.
		successfulRequests: null,
		failedRequests: null,
		errorRate: null,
		totalInputTokens: 0,
		totalOutputTokens: 0,
		totalCacheReadTokens: 0,
		totalCacheWriteTokens: 0,
		cacheRate: null,
		totalCost: 0,
		avgDuration: null,
		avgTtft: null,
		avgTokensPerSecond: null,
		firstTimestamp: Math.min(...inWindow.map((r) => r.at)),
		lastTimestamp: Math.max(...inWindow.map((r) => r.at)),
	};
	const add = (b: Bucket, r: GuardRequest, sign: 1 | -1) => {
		const put = (k: string, v: number) => {
			b[k] = Math.max(0, num(b[k]) + sign * v);
		};
		put("totalRequests", 1);
		put("totalInputTokens", r.input);
		put("totalOutputTokens", r.output);
		put("totalCacheReadTokens", r.cacheRead);
		put("totalCacheWriteTokens", r.cacheWrite);
		put("totalCost", r.cost);
	};
	const changed = new Set<Bucket>([guard]);
	for (const r of inWindow) {
		add(guard, r, 1);
		const from = byAgentType.find((b) => (b.agentType ?? "main") === r.kind);
		if (from) {
			add(from, r, -1);
			changed.add(from);
		}
	}
	// omp's cache rate (cache reads of what was read: `cacheRead / (input + cacheRead)`), again for the buckets that changed.
	for (const b of changed) {
		const read = num(b.totalInputTokens) + num(b.totalCacheReadTokens);
		b.cacheRate = read > 0 ? num(b.totalCacheReadTokens) / read : null;
	}
	const kept = byAgentType.filter((b) => num(b.totalRequests) > 0);
	return JSON.stringify({ ...stats, byAgentType: [...kept, guard] });
}

/**
 * The requests of `requests` that omp counted (#706), each marked with the agent type omp counted it under (`under`, from
 * `agentTypesOf`). A `model_usage` entry omp never ingested (a stretch of a transcript it did not sync) is in no bucket of
 * its answer, so taking it out of one took a request that was never there and gave the guard one the totals do not hold.
 * An entry copied into a fork is in two transcripts and one row of omp's: one request.
 */
export function counted(requests: readonly GuardRequest[], under: ReadonlyMap<string, string>): GuardRequest[] {
	const seen = new Set<string>();
	const out: GuardRequest[] = [];
	for (const r of requests) {
		const key = entryKey(r.id, r.at);
		const kind = under.get(key);
		if (kind === undefined || seen.has(key)) continue;
		seen.add(key);
		out.push({ ...r, kind });
	}
	return out;
}

const indexes = new Map<string, GuardUsageIndex>();

/**
 * `body` with the guard's bucket, from the transcripts under `root` (one index per root, kept for the next ask). `dbPath`: the
 * database omp's figures in `body` are from (see `agentTypesOf`): only the requests it holds are moved (#706).
 */
export async function addGuardUsage(
	body: string,
	root: string,
	window?: { from: number; to: number },
	dbPath?: string,
): Promise<string> {
	let from: number;
	try {
		const stats: unknown = JSON.parse(body);
		from = window ? window.from : isRecord(stats) && isRecord(stats.overall) ? num(stats.overall.firstTimestamp) : 0;
	} catch {
		return body;
	}
	let index = indexes.get(root);
	if (!index) {
		index = new GuardUsageIndex(root);
		indexes.set(root, index);
	}
	const requests = await index.since(from);
	// `dbPath`: omp's database that `body` was made from. Without one (or when it cannot be read) there is no telling what omp
	// counted, and every request of the window is taken for counted.
	const under = dbPath ? agentTypesOf(dbPath, requests) : null;
	return withGuardBucket(body, under ? counted(requests, under) : requests, window);
}
