import { finite, isRecord, usageCost } from "../../shared/guards.ts";
import { interviewLabel, parseInterviewPrompt } from "../../shared/guided-goal.ts";
import type { SessionEntry, SessionSummary, UsageTotals } from "../../shared/protocol.ts";

/**
 * Pure parsing of omp's documented session JSONL format (omp docs: session.md).
 * Files may start with a fixed-width `type: "title"` slot, then the
 * `type: "session"` header, then SessionEntry records.
 */

export interface ParsedSession {
	header: Record<string, unknown> | null;
	titleSlot: Record<string, unknown> | null;
	entries: SessionEntry[];
}

/** One transcript line as an object, or null for a blank line, malformed JSON (omp's loader skips those too) or a non-object. */
export function parseLine(line: string): Record<string, unknown> | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	let obj: unknown;
	try {
		obj = JSON.parse(trimmed);
	} catch {
		return null;
	}
	return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : null;
}

export function parseSessionText(text: string): ParsedSession {
	let header: Record<string, unknown> | null = null;
	let titleSlot: Record<string, unknown> | null = null;
	const entries: SessionEntry[] = [];
	for (const line of text.split("\n")) {
		const obj = parseLine(line);
		if (!obj) continue;
		if (obj.type === "title" && !header) {
			titleSlot = obj;
			continue;
		}
		if (obj.type === "session" && !header) {
			header = obj;
			continue;
		}
		if (typeof obj.id === "string") entries.push(obj as SessionEntry);
	}
	return { header: withTitleSlot(header, titleSlot), titleSlot, entries };
}

export function emptyUsage(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: 0,
		requests: 0,
	};
}

interface RawUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: { total?: number };
}

export function addUsage(into: UsageTotals, u: RawUsage | undefined | null): void {
	// Usage is an object: a string, a number or a list in its place is not a request that spent anything.
	if (!isRecord(u)) return;
	const input = finite(u.input);
	const output = finite(u.output);
	const cacheRead = finite(u.cacheRead);
	const cacheWrite = finite(u.cacheWrite);
	into.input += input;
	into.output += output;
	into.cacheRead += cacheRead;
	into.cacheWrite += cacheWrite;
	// A total that is not a number is no total: the parts make it, as when the request has none.
	into.totalTokens +=
		typeof u.totalTokens === "number" && Number.isFinite(u.totalTokens)
			? u.totalTokens
			: input + output + cacheRead + cacheWrite;
	into.cost += usageCost(u);
	into.requests += 1;
}

/** Whether every figure of `totals` is a number (the ones an older version summed from malformed usage were not, and were kept). */
export function isSoundUsage(totals: unknown): totals is UsageTotals {
	if (typeof totals !== "object" || totals === null) return false;
	const t = totals as Record<string, unknown>;
	return ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost", "requests"].every(
		(k) => typeof t[k] === "number" && Number.isFinite(t[k]),
	);
}

export function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		totalTokens: a.totalTokens + b.totalTokens,
		cost: a.cost + b.cost,
		requests: a.requests + b.requests,
	};
}

export interface TranscriptUsage {
	usage: UsageTotals;
	/** The header's timestamp, when it has a readable one. */
	startedAt: number | null;
	/** The providers its requests went to (assistant messages and `model_usage` entries), in the order first used. */
	providers: string[];
	/** How long the agent worked in it (#692): each prompt's turn lasts until the last entry written before the next one. */
	activeMs: number;
}

/** The working clock of a transcript: the turns that are over (`total`), and the one still open (`start` to `end`). */
export interface ActiveClock {
	total: number;
	start: number | null;
	end: number;
}

/**
 * What reading a transcript line by line adds up to (see `foldUsageLine`). A transcript only grows at its end, so one
 * that grew is read on from where the fold stopped: its new lines are folded into a copy of this.
 */
export interface UsageFold extends Omit<TranscriptUsage, "activeMs"> {
	sawHeader: boolean;
	clock: ActiveClock;
}

export function newUsageFold(): UsageFold {
	return {
		usage: emptyUsage(),
		startedAt: null,
		providers: [],
		sawHeader: false,
		clock: { total: 0, start: null, end: 0 },
	};
}

/** The working time a fold's clock has counted, the open turn up to its last entry. */
export function activeMsOf(fold: UsageFold): number {
	const { total, start, end } = fold.clock;
	return total + (start !== null ? Math.max(0, end - start) : 0);
}

/** A fold that goes on from `fold` without changing it. */
export function copyUsageFold(fold: UsageFold): UsageFold {
	return {
		usage: { ...fold.usage },
		startedAt: fold.startedAt,
		providers: [...fold.providers],
		sawHeader: fold.sawHeader,
		clock: { ...fold.clock },
	};
}

function addProvider(providers: string[], provider: unknown): void {
	if (typeof provider === "string" && provider && !providers.includes(provider)) providers.push(provider);
}

/** An entry's own `timestamp` (it comes before the message, near the start of the line), or NaN. */
const STAMP = /"timestamp":"([^"]{10,40})"/;
function lineStamp(line: string): number {
	const m = STAMP.exec(line.length > 512 ? line.slice(0, 512) : line);
	return m ? Date.parse(m[1] as string) : Number.NaN;
}

/**
 * Count what one transcript line spent, into `fold`: the same records as `summarize` (assistant messages and `model_usage`
 * entries), decoding only the header and the lines that mention usage, so a large file costs little. A line the writer has
 * not finished adds nothing.
 *
 * It also keeps the transcript's working clock (#692), as `activeMs` in `web/src/lib/turn-stats.ts` does for a conversation:
 * a subagent's prompts are the task it was given and what it was told after (`user` messages, which omp writes on the
 * agent's behalf), so every one begins a turn; any other entry moves the turn's end on to its time.
 */
export function foldUsageLine(fold: UsageFold, line: string): void {
	const mentionsUsage = line.includes('"usage"');
	const mayPrompt = line.includes('"role":"user"');
	if (fold.sawHeader && !mentionsUsage && !mayPrompt) {
		const at = lineStamp(line);
		if (fold.clock.start !== null && Number.isFinite(at)) fold.clock.end = Math.max(fold.clock.end, at);
		return;
	}
	if (!mentionsUsage && !mayPrompt && !line.includes('"session"')) return;
	let obj: Record<string, unknown>;
	try {
		obj = JSON.parse(line);
	} catch {
		return; // a line the writer has not finished
	}
	if (!obj || typeof obj !== "object") return;
	if (!fold.sawHeader && obj.type === "session") {
		fold.sawHeader = true;
		const at = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : Number.NaN;
		if (Number.isFinite(at)) fold.startedAt = at;
		return;
	}
	if (typeof obj.id !== "string") return;
	const entry = obj as SessionEntry;
	const at = Date.parse(entry.timestamp);
	const m = entry.type === "message" ? messageOf(entry) : undefined;
	const clock = fold.clock;
	if (m?.role === "user") {
		if (clock.start !== null) clock.total += Math.max(0, clock.end - clock.start);
		clock.start = Number.isFinite(at) ? at : null;
		clock.end = clock.start ?? 0;
		return;
	}
	if (clock.start !== null && Number.isFinite(at)) clock.end = Math.max(clock.end, at);
	if (entry.type === "model_usage") {
		addUsage(fold.usage, entry.usage as RawUsage);
		addProvider(fold.providers, entry.provider);
		return;
	}
	if (m?.role !== "assistant") return;
	addUsage(fold.usage, m.usage);
	if (m.usage) addProvider(fold.providers, m.provider);
}

/** What one transcript spent (see `foldUsageLine`), from its whole text. */
export function transcriptUsage(text: string): TranscriptUsage {
	const fold = newUsageFold();
	for (const line of text.split("\n")) foldUsageLine(fold, line);
	return { usage: fold.usage, startedAt: fold.startedAt, providers: fold.providers, activeMs: activeMsOf(fold) };
}

/**
 * Plain text of a message's content (string or content blocks). A file can hold what omp never wrote, so only a text block
 * whose `text` is a string counts: a number, an object or a list in its place was indexed as `5` or `[object Object]`.
 */
export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block) {
			if (typeof block.text === "string") parts.push(block.text);
		}
	}
	return parts.join("\n");
}

export interface MessageView {
	role: string;
	content?: unknown;
	usage?: RawUsage;
	provider?: string;
	model?: string;
	attribution?: string;
}

export function messageOf(entry: SessionEntry): MessageView | null {
	if (entry.type !== "message") return null;
	const m = entry.message as MessageView | undefined;
	return m && typeof m === "object" && typeof m.role === "string" ? m : null;
}

/** Text that full-text search indexes for an entry, or null when not searchable. */
export function searchableText(entry: SessionEntry): { role: string; text: string } | null {
	if (entry.type === "custom_message") {
		const text = contentText(entry.content);
		return text ? { role: "custom", text } : null;
	}
	const m = messageOf(entry);
	if (!m || (m.role !== "user" && m.role !== "assistant")) return null;
	const text = contentText(m.content).trim();
	return text ? { role: m.role, text } : null;
}

/**
 * What a summary is made of that only grows with the transcript: the entries fold into it one at a time, so a
 * transcript that grew by a few entries is summarized by folding those few, not by reading all of it again.
 */
export interface SummaryAcc {
	usage: UsageTotals;
	models: Set<string>;
	messageCount: number;
	userMessageCount: number;
	preview: string;
	/** The first title a `title_change` entry gave: the title when the header has none. */
	entryTitle: string | null;
}

export function newAcc(): SummaryAcc {
	return {
		usage: emptyUsage(),
		models: new Set(),
		messageCount: 0,
		userMessageCount: 0,
		preview: "",
		entryTitle: null,
	};
}

/** The accumulator a `summary` was built from; `entryTitle` is what a summary does not show on its own. */
export function accFromSummary(s: SessionSummary, entryTitle: string | null): SummaryAcc {
	return {
		usage: { ...s.usage },
		models: new Set(s.models),
		messageCount: s.messageCount,
		userMessageCount: s.userMessageCount,
		preview: s.preview,
		entryTitle,
	};
}

export function foldEntry(acc: SummaryAcc, e: SessionEntry): void {
	if (e.type === "title_change" && typeof e.title === "string" && !acc.entryTitle) acc.entryTitle = e.title;
	if (e.type === "model_usage") {
		addUsage(acc.usage, e.usage as RawUsage);
		// A request omp made on the side (the guard's reviewer, a judge): its model was used too.
		if (typeof e.provider === "string" && typeof e.model === "string") acc.models.add(`${e.provider}/${e.model}`);
		return;
	}
	const m = messageOf(e);
	if (!m) return;
	acc.messageCount++;
	if (m.role === "user" && m.attribution !== "agent") {
		acc.userMessageCount++;
		if (!acc.preview) {
			const text = contentText(m.content).trim();
			// A guided goal's first message is the web UI's instructions: the conversation is named by what the user said.
			const interview = parseInterviewPrompt(text);
			acc.preview = (interview ? interview.rough || interviewLabel(interview.language) : text).slice(0, 240);
		}
	}
	if (m.role === "assistant") {
		if (m.usage) addUsage(acc.usage, m.usage);
		if (m.provider && m.model) acc.models.add(`${m.provider}/${m.model}`);
	}
}

/** The header with the title slot's title merged in, as `parseSessionText` hands it out. */
export function withTitleSlot(
	header: Record<string, unknown> | null,
	titleSlot: Record<string, unknown> | null,
): Record<string, unknown> | null {
	if (header && titleSlot && typeof titleSlot.title === "string" && titleSlot.title.trim()) {
		return { ...header, title: titleSlot.title.trim(), titleSource: titleSlot.source ?? header.titleSource };
	}
	return header;
}

/**
 * A session file's summary with only its own requests in `usage`: its subagents and advisors write files of their
 * own. `withDependents` adds them, which is the shape clients get. The summary shares nothing with `acc`, which goes
 * on folding the entries that follow.
 */
export function buildSummary(
	file: string,
	h: Record<string, unknown> | null,
	acc: SummaryAcc,
	stat: { mtimeMs: number; size: number },
	subagentCount: number,
): SessionSummary | null {
	if (!h || typeof h.id !== "string") return null;
	const headerTitle = typeof h.title === "string" && h.title.trim() ? h.title.trim() : null;
	const cwd = typeof h.cwd === "string" ? h.cwd : "";
	return {
		file,
		id: h.id,
		title: headerTitle ?? acc.entryTitle,
		preview: acc.preview,
		cwd,
		project: cwd.split("/").filter(Boolean).pop() ?? cwd,
		createdAt: typeof h.timestamp === "string" ? h.timestamp : new Date(stat.mtimeMs).toISOString(),
		modifiedAt: stat.mtimeMs,
		size: stat.size,
		messageCount: acc.messageCount,
		userMessageCount: acc.userMessageCount,
		parentSession: typeof h.parentSession === "string" ? h.parentSession : null,
		models: [...acc.models],
		usage: { ...acc.usage },
		subagentUsage: emptyUsage(),
		advisorUsage: emptyUsage(),
		subagentCount,
	};
}

export function summarize(
	file: string,
	parsed: ParsedSession,
	stat: { mtimeMs: number; size: number },
	subagentCount: number,
): SessionSummary | null {
	const acc = newAcc();
	for (const e of parsed.entries) foldEntry(acc, e);
	return buildSummary(file, parsed.header, acc, stat, subagentCount);
}

/** What the files beside a session's own spent: its subagents and its advisors (kept apart: an advisor is no subagent). */
export interface Dependents {
	subagents: { count: number; usage: UsageTotals };
	advisor: UsageTotals;
}

/** The summary as clients get it: `own`'s requests, and in `usage` those of its subagents and advisors added to them. */
export function withDependents(own: SessionSummary, spent: Dependents): SessionSummary {
	return {
		...own,
		usage: addTotals(addTotals(own.usage, spent.subagents.usage), spent.advisor),
		subagentUsage: spent.subagents.usage,
		subagentCount: spent.subagents.count,
		advisorUsage: spent.advisor,
	};
}
