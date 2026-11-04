import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
	TOP_CONVERSATIONS,
	TOP_ERRORS,
	type UsageAnalysis,
	type UsageConversation,
	type UsageError,
	type UsageHour,
	type UsageTool,
} from "../../shared/usage-analysis.ts";
import { type UsageRange, usageBucket, usageWindow } from "../../shared/usage-range.ts";
import { canonical } from "../sessions/roots.ts";

/**
 * Usage & cost for any range, from omp's own statistics database (#714). `omp stats --json` answers only a rolling 24
 * hours and takes no range (omp 18.13.3: `--port --host --json --summary`), while the database it keeps holds every
 * request it ever counted. The server still runs `omp stats` first, because that run is what brings the database up to
 * date with the transcripts; this file only reads.
 *
 * The answer has the shape of `omp stats --json` (`OmpStats` of `web/src/lib/api.ts`), so the page reads either. Its
 * derived figures are omp's own formulas, which `tests/contract/stats-db.test.ts` holds equal to omp's answer for the
 * same window: a cache rate over input, a saving over what the input would have cost uncached, a speed over the
 * requests that recorded one.
 *
 * The database is opened read-only and never locked for writing: omp writes it while the page reads.
 */

/** The columns of `messages` the queries read; a database without one of them is not one this file understands. */
const COLUMNS = [
	"timestamp",
	"model",
	"provider",
	"folder",
	"agent_type",
	"stop_reason",
	"duration",
	"ttft",
	"input_tokens",
	"output_tokens",
	"cache_read_tokens",
	"cache_write_tokens",
	"total_tokens",
	"premium_requests",
	"cost_input",
	"cost_output",
	"cost_cache_read",
	"cost_cache_write",
	"cost_total",
	"cost_no_cache_input",
	"cost_unpriced",
] as const;

/**
 * Where omp keeps the database, as omp 18.13.3 decides it (measured by `tests/contract/stats-db.test.ts`): under its config
 * root, whatever agent folder `PI_CODING_AGENT_DIR` names; `XDG_DATA_HOME/omp` takes over when that folder exists and the
 * agent folder is the default one. The config root is a folder of the home: omp joins `PI_CONFIG_DIR` (else `.omp`) to
 * the home folder, so an absolute value lands under the home as well (omp 18.14.1, `packages/utils/src/dirs.ts`). omp
 * profiles are not followed: the server's own omp runs without one. A wrong guess is caught by `holdsLatest`, never shown
 * as figures.
 */
export function statsDbPath(agentDir: string, env: Record<string, string | undefined>, home: string): string {
	const configRoot = join(home, env.PI_CONFIG_DIR || ".omp");
	const xdg = env.XDG_DATA_HOME ? join(env.XDG_DATA_HOME, "omp") : null;
	if (xdg && resolve(agentDir) === resolve(configRoot, "agent") && existsSync(xdg)) return join(xdg, "stats.db");
	return join(configRoot, "stats.db");
}

/** A request's bucket of figures, as omp names them. */
export interface StatsBucket {
	totalRequests: number;
	successfulRequests: number;
	failedRequests: number;
	errorRate: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	cacheRate: number;
	cacheSavings: number;
	totalCost: number;
	unpricedRequests: number;
	totalPremiumRequests: number;
	avgDuration: number | null;
	avgTtft: number | null;
	avgTokensPerSecond: number | null;
	firstTimestamp: number;
	lastTimestamp: number;
}

export interface DbStats {
	overall: StatsBucket;
	byModel: (StatsBucket & { model: string; provider: string })[];
	byFolder: (StatsBucket & { folder: string })[];
	byAgentType: {
		agentType: string;
		totalRequests: number;
		totalInputTokens: number;
		totalOutputTokens: number;
		totalCacheReadTokens: number;
		totalCacheWriteTokens: number;
		totalCost: number;
	}[];
	timeSeries: { timestamp: number; requests: number; errors: number; tokens: number; cost: number }[];
	costSeries: {
		timestamp: number;
		model: string;
		provider: string;
		cost: number;
		unpricedRequests: number;
		costInput: number;
		costOutput: number;
		costCacheRead: number;
		costCacheWrite: number;
		requests: number;
	}[];
	modelSeries: { timestamp: number; model: string; provider: string; requests: number }[];
	modelPerformanceSeries: {
		timestamp: number;
		model: string;
		provider: string;
		requests: number;
		avgTtft: number | null;
		avgTokensPerSecond: number | null;
	}[];
	/** What omp's answer has no part for (`shared/usage-analysis.ts`), over the same window. */
	analysis: UsageAnalysis;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A request's tokens per second: only one that took time and wrote something has a speed (omp's rule). */
const SPEED = "CASE WHEN duration > 0 AND output_tokens > 0 THEN output_tokens * 1000.0 / duration END";

/**
 * One pass over the window: the requests grouped by UTC hour, model, folder and agent type, with sums and counts (not
 * averages, which do not add up). Every figure of the answer is rolled up from these groups, so a month of 100k
 * requests is read once rather than once per table of the page.
 */
const GROUPS = `SELECT (timestamp / ${3_600_000}) * ${3_600_000} AS hour, model, provider, folder, agent_type AS agentType,
	COUNT(*) AS n, SUM(stop_reason = 'error') AS failed,
	SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cacheRead,
	SUM(cache_write_tokens) AS cacheWrite, SUM(total_tokens) AS tokens,
	SUM(cost_total) AS cost, SUM(cost_input) AS costInput, SUM(cost_output) AS costOutput,
	SUM(cost_cache_read) AS costCacheRead, SUM(cost_cache_write) AS costCacheWrite,
	SUM(cost_no_cache_input) AS uncachedCost, SUM(cost_unpriced) AS unpriced, SUM(premium_requests) AS premium,
	SUM(duration) AS durSum, COUNT(duration) AS durN, SUM(ttft) AS ttftSum, COUNT(ttft) AS ttftN,
	SUM(${SPEED}) AS speedSum, COUNT(${SPEED}) AS speedN, MIN(timestamp) AS first, MAX(timestamp) AS last
FROM messages WHERE timestamp >= $from AND timestamp <= $to GROUP BY 1, 2, 3, 4, 5`;

interface Group {
	hour: number;
	model: string;
	provider: string;
	folder: string;
	agentType: string;
	n: number;
	failed: number | null;
	input: number | null;
	output: number | null;
	cacheRead: number | null;
	cacheWrite: number | null;
	tokens: number | null;
	cost: number | null;
	costInput: number | null;
	costOutput: number | null;
	costCacheRead: number | null;
	costCacheWrite: number | null;
	uncachedCost: number | null;
	unpriced: number | null;
	premium: number | null;
	durSum: number | null;
	durN: number;
	ttftSum: number | null;
	ttftN: number;
	speedSum: number | null;
	speedN: number;
	first: number;
	last: number;
}

/** The sums of groups, added up; read out as omp's figures by `bucket`. */
class Sum {
	n = 0;
	failed = 0;
	input = 0;
	output = 0;
	cacheRead = 0;
	cacheWrite = 0;
	tokens = 0;
	cost = 0;
	costInput = 0;
	costOutput = 0;
	costCacheRead = 0;
	costCacheWrite = 0;
	uncached = 0;
	unpriced = 0;
	premium = 0;
	durSum = 0;
	durN = 0;
	ttftSum = 0;
	ttftN = 0;
	speedSum = 0;
	speedN = 0;
	first = Number.POSITIVE_INFINITY;
	last = 0;

	add(g: Group): void {
		this.n += g.n;
		this.failed += g.failed ?? 0;
		this.input += g.input ?? 0;
		this.output += g.output ?? 0;
		this.cacheRead += g.cacheRead ?? 0;
		this.cacheWrite += g.cacheWrite ?? 0;
		this.tokens += g.tokens ?? 0;
		this.cost += g.cost ?? 0;
		this.costInput += g.costInput ?? 0;
		this.costOutput += g.costOutput ?? 0;
		this.costCacheRead += g.costCacheRead ?? 0;
		this.costCacheWrite += g.costCacheWrite ?? 0;
		this.uncached += g.uncachedCost ?? 0;
		this.unpriced += g.unpriced ?? 0;
		this.premium += g.premium ?? 0;
		this.durSum += g.durSum ?? 0;
		this.durN += g.durN;
		this.ttftSum += g.ttftSum ?? 0;
		this.ttftN += g.ttftN;
		this.speedSum += g.speedSum ?? 0;
		this.speedN += g.speedN;
		this.first = Math.min(this.first, g.first);
		this.last = Math.max(this.last, g.last);
	}

	bucket(): StatsBucket {
		const inputCost = this.costInput + this.costCacheRead + this.costCacheWrite;
		return {
			totalRequests: this.n,
			successfulRequests: this.n - this.failed,
			failedRequests: this.failed,
			errorRate: this.n ? this.failed / this.n : 0,
			totalInputTokens: this.input,
			totalOutputTokens: this.output,
			totalCacheReadTokens: this.cacheRead,
			totalCacheWriteTokens: this.cacheWrite,
			cacheRate: this.input + this.cacheRead ? this.cacheRead / (this.input + this.cacheRead) : 0,
			cacheSavings: this.uncached > 0 ? 1 - inputCost / this.uncached : 0,
			totalCost: this.cost,
			unpricedRequests: this.unpriced,
			totalPremiumRequests: this.premium,
			avgDuration: this.durN ? this.durSum / this.durN : null,
			avgTtft: this.ttftN ? this.ttftSum / this.ttftN : null,
			avgTokensPerSecond: this.speedN ? this.speedSum / this.speedN : null,
			firstTimestamp: this.n ? this.first : 0,
			lastTimestamp: this.last,
		};
	}
}

/** The groups added up by `key`, in the order keys were first met. */
function rollUp(groups: readonly Group[], key: (g: Group) => string): Map<string, { first: Group; sum: Sum }> {
	const out = new Map<string, { first: Group; sum: Sum }>();
	for (const g of groups) {
		const k = key(g);
		let at = out.get(k);
		if (!at) {
			at = { first: g, sum: new Sum() };
			out.set(k, at);
		}
		at.sum.add(g);
	}
	return out;
}

const byCostDesc = <T extends { totalCost: number }>(a: T, b: T) => b.totalCost - a.totalCost;

/** The names of `table`'s columns; empty when there is no such table. */
function columnsOf(db: Database, table: string): Set<string> {
	return new Set(
		db
			.query<{ name: string }, []>(`PRAGMA table_info(${table})`)
			.all()
			.map((c) => c.name),
	);
}

/** Open the database read-only, or null when it is not there, cannot be read, or lacks a column the queries use. */
function open(path: string): Database | null {
	if (!existsSync(path)) return null;
	let db: Database;
	try {
		db = new Database(path, { readonly: true });
	} catch {
		return null;
	}
	try {
		const have = columnsOf(db, "messages");
		if (COLUMNS.every((c) => have.has(c))) return db;
	} catch {
		// Not a database, or one omp is in the middle of creating.
	}
	db.close();
	return null;
}

/**
 * The time zone `asked` names, as `Intl` spells it, or UTC when it names none: the hours of the day are the page's, and
 * a name the server's `Intl` does not know (a typo, an older time zone database) is no reason to fail the figures.
 */
export function timeZoneOr(asked: string | null | undefined): string {
	if (!asked) return "UTC";
	try {
		return new Intl.DateTimeFormat("en-US", { timeZone: asked }).resolvedOptions().timeZone;
	} catch {
		return "UTC";
	}
}

/** A part of `analysisOf`, or null when its query fails: one part the database cannot answer leaves the others. */
function part<T>(read: () => T): T | null {
	try {
		return read();
	} catch {
		return null;
	}
}

type Window = { $from: number; $to: number };

/**
 * The requests of each transcript in the window, by model and agent type; the conversations are made of them by
 * `conversationOf`.
 */
const BY_FILE = `SELECT session_file AS file, folder, model, agent_type AS agentType, COUNT(*) AS n,
	SUM(total_tokens) AS tokens, SUM(cost_total) AS cost, MAX(timestamp) AS last
FROM messages WHERE timestamp >= $from AND timestamp <= $to GROUP BY 1, 2, 3, 4`;

/**
 * The tools called in the window. omp records `is_error` and `result_chars` once the result is in, so a call still
 * waiting for its result (or one omp read no result for) counts as a call and not in the error share or the size.
 */
const TOOLS = `SELECT tool_name AS tool, COUNT(*) AS calls, SUM(is_error = 1) AS errors, COUNT(is_error) AS settled,
	SUM(result_chars) AS resultChars, COUNT(result_chars) AS resultN
FROM tool_calls WHERE timestamp >= $from AND timestamp <= $to GROUP BY 1 ORDER BY calls DESC, tool`;

const ERRORS = `SELECT provider, model, error_message AS message, COUNT(*) AS count, MAX(timestamp) AS lastTimestamp
FROM messages WHERE stop_reason = 'error' AND timestamp >= $from AND timestamp <= $to
GROUP BY 1, 2, 3 ORDER BY count DESC, lastTimestamp DESC LIMIT ${TOP_ERRORS}`;

/**
 * The requests by UTC quarter of an hour. Every time zone's offset is a whole number of quarters, so each quarter lies in
 * one local hour, which a whole UTC hour does not in India or Nepal; and the local hour is taken at the quarter's own
 * date, so a range across a change to summer time puts each request in the hour its clock said.
 */
const QUARTER = 900_000;
const QUARTERS = `SELECT timestamp / ${QUARTER} AS quarter, COUNT(*) AS n, SUM(cost_total) AS cost
FROM messages WHERE timestamp >= $from AND timestamp <= $to GROUP BY 1`;

/**
 * The conversation a transcript is of: a subagent's or an advisor's transcript is kept in the folder named after the one
 * that started it (`<stem>/<agent>.jsonl` beside `<stem>.jsonl`, nested for a subagent's own subagents), so the
 * conversation is the outermost transcript up that chain. `isTranscript` is asked of each folder once.
 */
function conversationOf(file: string, isTranscript: (path: string) => boolean): string {
	let at = file;
	for (;;) {
		const dir = dirname(at);
		if (dir === dirname(dir) || !isTranscript(`${dir}.jsonl`)) return at;
		at = `${dir}.jsonl`;
	}
}

/** Where a conversation's requests were made: one of its transcripts, with the folder omp filed it under. */
interface Place {
	folder: string;
	last: number;
}

/**
 * The costliest conversations of the window. A conversation moved to another project folder ("Change folder") leaves
 * omp's rows of its old transcripts where they were, under the old path; its file name (`<time>_<id>.jsonl`) stays, so
 * the transcripts of one name are one conversation, shown at the path it is at now.
 */
function conversations(db: Database, window: Window): UsageConversation[] {
	const rows = db
		.query<
			{
				file: string;
				folder: string;
				model: string;
				agentType: string;
				n: number;
				tokens: number | null;
				cost: number | null;
				last: number;
			},
			Window
		>(BY_FILE)
		.all(window);
	// A transcript is one on disk or one omp counted requests of, in or out of the window: a moved or deleted
	// conversation's subagents still belong to it.
	const counted = db.query<{ one: number }, [string]>("SELECT 1 AS one FROM messages WHERE session_file = ? LIMIT 1");
	const known = new Map<string, boolean>();
	const isTranscript = (p: string) => {
		let at = known.get(p);
		if (at === undefined) {
			at = existsSync(p) || counted.get(p) !== null;
			known.set(p, at);
		}
		return at;
	};
	const roots = new Map<string, string>();
	const byName = new Map<
		string,
		Omit<UsageConversation, "models"> & { byModel: Map<string, number>; places: Map<string, Place> }
	>();
	for (const r of rows) {
		let root = roots.get(r.file);
		if (root === undefined) {
			root = conversationOf(r.file, isTranscript);
			roots.set(r.file, root);
		}
		// A subagent's transcript whose conversation omp holds nothing of is a conversation of its own, by its whole path:
		// subagents' file names (`__advisor.jsonl`, `0-Scout.jsonl`) are the same in every conversation.
		const name = root === r.file && r.agentType !== "main" ? root : basename(root);
		let c = byName.get(name);
		if (!c) {
			c = {
				file: root,
				folder: r.folder,
				requests: 0,
				tokens: 0,
				cost: 0,
				subagentCost: 0,
				advisorCost: 0,
				lastTimestamp: 0,
				byModel: new Map(),
				places: new Map(),
			};
			byName.set(name, c);
		}
		const cost = r.cost ?? 0;
		c.requests += r.n;
		c.tokens += r.tokens ?? 0;
		c.cost += cost;
		if (r.agentType === "subagent") c.subagentCost += cost;
		else if (r.agentType === "advisor") c.advisorCost += cost;
		c.byModel.set(r.model, (c.byModel.get(r.model) ?? 0) + cost);
		c.lastTimestamp = Math.max(c.lastTimestamp, r.last);
		const place = c.places.get(root);
		if (place) place.last = Math.max(place.last, r.last);
		else c.places.set(root, { folder: r.folder, last: r.last });
	}
	return [...byName.values()]
		.sort((a, b) => b.cost - a.cost || b.requests - a.requests || b.lastTimestamp - a.lastTimestamp)
		.slice(0, TOP_CONVERSATIONS)
		.map(({ byModel, places, ...c }) => {
			// Where it is now: the transcript on disk (the latest used, should two be), else the one used last.
			const [file, place] = [...places].sort(
				([a, x], [b, y]) => Number(existsSync(b)) - Number(existsSync(a)) || y.last - x.last,
			)[0] ?? [c.file, { folder: c.folder, last: 0 }];
			return {
				...c,
				file: canonical(file),
				folder: place.folder,
				models: [...byModel].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([m]) => m),
			};
		});
}

function tools(db: Database, window: Window): UsageTool[] {
	return db
		.query<
			{
				tool: string;
				calls: number;
				errors: number | null;
				settled: number;
				resultChars: number | null;
				resultN: number;
			},
			Window
		>(TOOLS)
		.all(window)
		.map((r) => ({
			tool: r.tool,
			calls: r.calls,
			errors: r.errors ?? 0,
			errorRate: r.settled ? (r.errors ?? 0) / r.settled : null,
			avgResultChars: r.resultN ? (r.resultChars ?? 0) / r.resultN : null,
		}));
}

function hours(db: Database, window: Window, timeZone: string): UsageHour[] {
	const out = Array.from({ length: 24 }, (_, hour) => ({ hour, requests: 0, cost: 0 }));
	const clock = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" });
	const rows = db.query<{ quarter: number; n: number; cost: number | null }, Window>(QUARTERS).all(window);
	for (const r of rows) {
		const hour = Number(clock.formatToParts(r.quarter * QUARTER).find((p) => p.type === "hour")?.value) % 24;
		const at = out[hour];
		if (!at) continue;
		at.requests += r.n;
		at.cost += r.cost ?? 0;
	}
	return out;
}

/**
 * The parts of the page that omp's answer has none for, over `window`. The columns and the table they read came after
 * the ones `COLUMNS` names, so each part asks for its own and is null without them.
 */
function analysisOf(db: Database, window: { from: number; to: number }, timeZone: string): UsageAnalysis {
	const at: Window = { $from: window.from, $to: window.to };
	const messages = columnsOf(db, "messages");
	const calls = columnsOf(db, "tool_calls");
	return {
		conversations: messages.has("session_file") ? part(() => conversations(db, at)) : null,
		tools: ["tool_name", "timestamp", "is_error", "result_chars"].every((c) => calls.has(c))
			? part(() => tools(db, at))
			: null,
		errors: messages.has("error_message") ? part(() => db.query<UsageError, Window>(ERRORS).all(at)) : null,
		hours: part(() => hours(db, at, timeZone)),
		timeZone,
	};
}

/**
 * Whether the database holds the request at `timestamp`: the last one `omp stats --json` counted. A database that does
 * not is not the one that omp read (another agent folder, a profile, a moved data root), and its figures would be
 * someone else's: the caller then shows omp's own answer instead.
 */
export function holdsLatest(path: string, timestamp: number): boolean {
	const db = open(path);
	if (!db) return false;
	try {
		return db.query("SELECT 1 FROM messages WHERE timestamp = ? LIMIT 1").get(timestamp) !== null;
	} finally {
		db.close();
	}
}

/** The key of an entry in `agentTypesOf`: its id and time, which is how omp itself tells one entry from another across the files that hold it (`idx_messages_entry_timestamp`). */
export const entryKey = (id: string, at: number): string => `${id}\0${at}`;

/**
 * The agent type omp counted each of `entries` under (#706), by the entry's id and time, keyed by `entryKey`. An entry the
 * database has no row for is not in the answer: omp never counted it (a stretch of a transcript it did not ingest, or an
 * entry it does not read as a request), so it is in no bucket of omp's figures. The row is found by id and time, not by file:
 * omp keeps one row for an entry that was copied into a fork, and the path it names is the one it walked, which the server's
 * canonical path need not equal. Null when the database cannot be used: that says nothing of what omp counted.
 */
export function agentTypesOf(path: string, entries: readonly { id: string; at: number }[]): Map<string, string> | null {
	const db = open(path);
	if (!db) return null;
	try {
		const find = db.query<{ agent_type: string | null }, [string, number]>(
			"SELECT agent_type FROM messages WHERE entry_id = ? AND timestamp = ? LIMIT 1",
		);
		const out = new Map<string, string>();
		for (const e of entries) {
			const row = find.get(e.id, e.at);
			if (row) out.set(entryKey(e.id, e.at), row.agent_type ?? "main");
		}
		return out;
	} catch {
		return null;
	} finally {
		db.close();
	}
}

/**
 * omp's figures for the requests from `from` to `to` (both inclusive, milliseconds), with the charts in `bucket` steps
 * (UTC hours or UTC days, as omp's own series are) and the hours of the day in `timeZone`. Null when the database cannot
 * be used.
 */
export function statsFromDb(
	path: string,
	window: { from: number; to: number },
	bucket: "hour" | "day",
	timeZone = "UTC",
): DbStats | null {
	const db = open(path);
	if (!db) return null;
	let groups: Group[];
	let analysis: UsageAnalysis;
	try {
		groups = db.query<Group, { $from: number; $to: number }>(GROUPS).all({ $from: window.from, $to: window.to });
		analysis = analysisOf(db, window, timeZone);
	} catch {
		return null;
	} finally {
		db.close();
	}
	const step = bucket === "hour" ? HOUR : DAY;
	const stepOf = (t: number) => Math.floor(t / step) * step;
	const dayOf = (t: number) => Math.floor(t / DAY) * DAY;
	const all = new Sum();
	for (const g of groups) all.add(g);
	const byModel = [...rollUp(groups, (g) => `${g.provider}\0${g.model}`).values()]
		.map(({ first, sum }) => ({ model: first.model, provider: first.provider, ...sum.bucket() }))
		.sort(byCostDesc);
	const byFolder = [...rollUp(groups, (g) => g.folder).values()]
		.map(({ first, sum }) => ({ folder: first.folder, ...sum.bucket() }))
		.sort(byCostDesc);
	const byAgentType = [...rollUp(groups, (g) => g.agentType).values()]
		.map(({ first, sum }) => ({
			agentType: first.agentType,
			totalRequests: sum.n,
			totalInputTokens: sum.input,
			totalOutputTokens: sum.output,
			totalCacheReadTokens: sum.cacheRead,
			totalCacheWriteTokens: sum.cacheWrite,
			totalCost: sum.cost,
		}))
		.sort(byCostDesc);
	const timeSeries = [...rollUp(groups, (g) => String(stepOf(g.hour))).values()]
		.map(({ first, sum }) => ({
			timestamp: stepOf(first.hour),
			requests: sum.n,
			errors: sum.failed,
			tokens: sum.tokens,
			cost: sum.cost,
		}))
		.sort((a, b) => a.timestamp - b.timestamp);
	const byTimeAndModel = (a: { timestamp: number; model: string; provider: string }, b: typeof a) =>
		a.timestamp - b.timestamp || a.model.localeCompare(b.model) || a.provider.localeCompare(b.provider);
	// omp's cost chart is by UTC day whatever the range: a day's cost is what a budget is read against.
	const costSeries = [...rollUp(groups, (g) => `${dayOf(g.hour)}\0${g.provider}\0${g.model}`).values()]
		.map(({ first, sum }) => ({
			timestamp: dayOf(first.hour),
			model: first.model,
			provider: first.provider,
			cost: sum.cost,
			unpricedRequests: sum.unpriced,
			costInput: sum.costInput,
			costOutput: sum.costOutput,
			costCacheRead: sum.costCacheRead,
			costCacheWrite: sum.costCacheWrite,
			requests: sum.n,
		}))
		.sort(byTimeAndModel);
	const modelPerformanceSeries = [...rollUp(groups, (g) => `${stepOf(g.hour)}\0${g.provider}\0${g.model}`).values()]
		.map(({ first, sum }) => {
			const b = sum.bucket();
			return {
				timestamp: stepOf(first.hour),
				model: first.model,
				provider: first.provider,
				requests: sum.n,
				avgTtft: b.avgTtft,
				avgTokensPerSecond: b.avgTokensPerSecond,
			};
		})
		.sort(byTimeAndModel);
	const modelSeries = modelPerformanceSeries.map(({ timestamp, model, provider, requests }) => ({
		timestamp,
		model,
		provider,
		requests,
	}));
	return {
		overall: all.bucket(),
		byModel,
		byFolder,
		byAgentType,
		timeSeries,
		costSeries,
		modelSeries,
		modelPerformanceSeries,
		analysis,
	};
}

/**
 * What `/api/stats` answers for `range`: the database's figures for its window, when the database is the one omp read
 * (it holds the last request of omp's own answer, `ompBody`); else omp's answer as it is, with `window` null so the
 * page says it shows omp's last 24 hours. A database with no request of omp's 24 hours to check against is taken as it
 * is: there is nothing it could disagree with. The hours of the day are in `timeZone` (see `timeZoneOr`).
 */
export function statsForRange(
	ompBody: string,
	range: UsageRange,
	dbPath: string,
	now: number,
	timeZone = "UTC",
): { body: string; window: { from: number; to: number } | null } {
	let latest = 0;
	try {
		const parsed = JSON.parse(ompBody) as { overall?: { lastTimestamp?: unknown } };
		if (typeof parsed.overall?.lastTimestamp === "number") latest = parsed.overall.lastTimestamp;
	} catch {
		// Not omp's JSON: the database alone, if it can be read.
	}
	// The read blocks the server for a few hundred milliseconds over a long history: a page that asks again (a reload,
	// a second tab, the kept answer and then the refreshed one with nothing new) is answered from the last read while the
	// database is unchanged.
	const key = `${dbPath}\0${range}\0${timeZone}\0${latest}\0${signature(dbPath)}`;
	if (lastRead && lastRead.key === key && now - lastRead.at < READ_KEPT_MS) return lastRead.answer;
	const answer = readRange(ompBody, range, dbPath, now, latest, timeZone);
	lastRead = { key, at: now, answer };
	return answer;
}

/** How long an unchanged database's answer for a range is reused: the windows end "now", which moves. */
const READ_KEPT_MS = 10_000;
let lastRead: {
	key: string;
	at: number;
	answer: { body: string; window: { from: number; to: number } | null };
} | null = null;

/** What changes when omp writes the database: its size and time, and its write-ahead log's. */
function signature(path: string): string {
	const of = (p: string) => {
		try {
			const st = statSync(p);
			return `${st.size}:${st.mtimeMs}`;
		} catch {
			return "-";
		}
	};
	return `${of(path)}/${of(`${path}-wal`)}`;
}

function readRange(
	ompBody: string,
	range: UsageRange,
	dbPath: string,
	now: number,
	latest: number,
	timeZone: string,
): { body: string; window: { from: number; to: number } | null } {
	if (latest > 0 && !holdsLatest(dbPath, latest)) return { body: ompBody, window: null };
	const window = usageWindow(range, now);
	const stats = statsFromDb(dbPath, window, usageBucket(range), timeZone);
	return stats ? { body: JSON.stringify(stats), window } : { body: ompBody, window: null };
}
