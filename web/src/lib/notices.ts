import type { SessionEntry } from "@shared/protocol.ts";
import { appended, extension } from "./lineage.ts";
import { type AgentMessage, type ContentBlock, messageOf, textOf } from "./messages.ts";

/**
 * What omp's terminal shows for the records it writes about itself (advisor notes, rule injections, fallbacks,
 * background jobs, IRC messages), read from the same data: the `details` of custom messages, the rule
 * attributes of reminders, and the events omp emits while it works.
 */

function record(v: unknown): Record<string, unknown> | null {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v !== "" ? v : undefined;
}

/** The text of a message's `content`, which is a string or content blocks. */
export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	return Array.isArray(content) ? textOf({ role: "custom", content: content as ContentBlock[] }) : "";
}

// ---------------------------------------------------------------- advisor

export const SEVERITIES = ["blocker", "concern", "nit", "note"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface AdvisorNote {
	note: string;
	severity: Severity;
	/** The advisor that wrote it, when it is not the default one. */
	advisor?: string;
}

const ADVISORY = /<advisory\b([^>]*)>([\s\S]*?)<\/advisory>/g;

/**
 * The notes of an `advisor` custom message: `details.notes`, else read back out of the `<advisory>`
 * wrapper omp also saves as the message text (older sessions have no details).
 */
export function advisorNotes(details: unknown, content: unknown): AdvisorNote[] {
	const out: AdvisorNote[] = [];
	const listed = record(details)?.notes;
	if (Array.isArray(listed)) {
		for (const item of listed) {
			const r = record(item);
			const note = str(r?.note)?.trim();
			if (!r || !note) continue;
			const advisor = str(r.advisor);
			out.push({
				note,
				severity: SEVERITIES.find((x) => x === r.severity) ?? "note",
				...(advisor && advisor !== "default" ? { advisor } : {}),
			});
		}
	}
	if (out.length > 0) return out;
	const text = contentText(content);
	for (const m of text.matchAll(ADVISORY)) {
		const note = m[2].trim();
		const level = /\bseverity="([^"]*)"/.exec(m[1])?.[1];
		if (note) out.push({ note, severity: SEVERITIES.find((x) => x === level) ?? "note" });
	}
	if (out.length === 0) {
		const bare = text.replace(/<\/?advisory\b[^>]*>/g, "").trim();
		if (bare) out.push({ note: bare, severity: "note" });
	}
	return out;
}

// ---------------------------------------------------------------- rules (TTSR)

export interface RuleReminder {
	name: string;
	/** The rule's own instruction, without omp's boilerplate around it. */
	text: string;
}

const RULE_BLOCK = /<system-(reminder|interrupt)\b([^>]*\breason="rule_violation"[^>]*)>([\s\S]*?)<\/system-\1>/g;

/** omp's preamble before the rule text: the reminder's first paragraph, or the interrupt's lines up to "MUST comply:". */
function ruleText(inner: string): string {
	const body = inner.trim();
	if (/^User-defined rule matched/.test(body)) return body.replace(/^[\s\S]*?\n\s*\n/, "").trim();
	return body.replace(/^Output interrupted:[\s\S]*?MUST comply:\s*/, "").trim();
}

/**
 * The rules an injected reminder applies. Empty unless the whole message is made of rule reminders:
 * any other text in it means it is not one, and shows as the agent's message it is.
 */
export function ruleReminders(text: string): RuleReminder[] {
	const out: RuleReminder[] = [];
	for (const m of text.matchAll(RULE_BLOCK)) {
		const name = /\brule="([^"]*)"/.exec(m[2])?.[1];
		if (name) out.push({ name, text: ruleText(m[3]) });
	}
	if (out.length === 0 || text.replace(RULE_BLOCK, "").trim() !== "") return [];
	return out;
}

// ---------------------------------------------------------------- typed custom messages

export interface JobInfo {
	id: string;
	type?: string;
	label?: string;
	durationMs?: number;
	artifactError?: string;
}

export interface DaemonInfo {
	name: string;
	failed: boolean;
	exitCode?: number;
	durationMs?: number;
}

export type IrcMode = "incoming" | "relay" | "autoreply" | "workpool";

export type CustomNote =
	| { kind: "advisor"; notes: AdvisorNote[] }
	/** Finished background jobs; `result` is what they returned (the model's copy, minus omp's wrapper). */
	| { kind: "jobs"; jobs: JobInfo[]; result: string }
	/** Supervised processes that ended; `text` is omp's own sentence, shown when it listed none. */
	| { kind: "daemons"; daemons: DaemonInfo[]; text: string }
	| {
			kind: "irc";
			mode: IrcMode;
			from?: string;
			to?: string;
			pool?: string;
			body: string;
			reply: boolean;
	  };

const IRC_MODES: Record<string, IrcMode> = {
	"irc:incoming": "incoming",
	"irc:autoreply": "autoreply",
	"irc:workpool": "workpool",
	"irc:relay": "relay",
};

/** How an IRC custom message reads, from its type; undefined for any other message. */
export function ircMode(customType: unknown): IrcMode | undefined {
	return typeof customType === "string" && Object.hasOwn(IRC_MODES, customType) ? IRC_MODES[customType] : undefined;
}

function jobOf(v: unknown): JobInfo | null {
	const r = record(v);
	if (!r) return null;
	const meta = record(r.meta);
	return {
		id: str(r.jobId) ?? "unknown",
		type: str(r.type),
		label: str(r.label),
		durationMs: typeof r.durationMs === "number" ? r.durationMs : undefined,
		artifactError: str(meta?.artifactError),
	};
}

function daemonOf(v: unknown): DaemonInfo | null {
	const r = record(v);
	const name = str(r?.name);
	if (!r || !name) return null;
	const exitCode = typeof r.exitCode === "number" ? r.exitCode : undefined;
	const { startedAt, exitedAt } = r;
	return {
		name,
		failed: r.state === "failed" || (exitCode !== undefined && exitCode !== 0),
		exitCode,
		durationMs: typeof startedAt === "number" && typeof exitedAt === "number" ? exitedAt - startedAt : undefined,
	};
}

/**
 * The typed form of a custom message (a `custom_message` entry, or a `custom` message from the live stream),
 * or null when omp has no card for its type (the caller shows the plain note).
 */
export function classifyCustom(customType: unknown, details: unknown, content: unknown): CustomNote | null {
	const d = record(details);
	if (customType === "advisor") {
		const notes = advisorNotes(details, content);
		return notes.length ? { kind: "advisor", notes } : null;
	}
	if (customType === "async-result") {
		// Several jobs finished together (`jobs`), or one described by the details themselves.
		const listed = Array.isArray(d?.jobs) && d.jobs.length > 0 ? d.jobs : str(d?.jobId) ? [d] : [];
		const jobs = listed.map(jobOf).filter((j): j is JobInfo => j !== null);
		const topError = str(record(d?.meta)?.artifactError);
		if (topError && jobs[0] && !jobs[0].artifactError) jobs[0].artifactError = topError;
		// omp wraps the result in <system-notice> and a "has completed. Resume your work…" sentence for the model.
		const result = contentText(content)
			.replace(/<\/?system-notice>/g, "")
			.replace(/^.*\bhas completed\. Resume your work using the result below\.\s*$/gm, "")
			.trim();
		return jobs.length ? { kind: "jobs", jobs, result } : null;
	}
	if (customType === "launch-completion") {
		const listed = Array.isArray(d?.daemons) ? d.daemons : [];
		const daemons = listed.map(daemonOf).filter((x): x is DaemonInfo => x !== null);
		const text = contentText(content).trim();
		return daemons.length || text ? { kind: "daemons", daemons, text } : null;
	}
	const mode = ircMode(customType);
	if (!mode) return null;
	const own = mode === "incoming" ? str(d?.message) : str(d?.body);
	// The saved text wraps the message in <irc> and an "Incoming IRC message from …" line for the model.
	const wrapped = contentText(content)
		.replace(/<\/?irc>/g, "")
		.replace(/^\s*Incoming IRC message from .*:\s*$/m, "")
		.trim();
	return {
		kind: "irc",
		mode,
		from: str(d?.from),
		to: str(d?.to),
		pool: str(d?.pool),
		body: own ?? str(d?.body) ?? str(d?.message) ?? wrapped,
		reply: str(d?.replyTo) !== undefined,
	};
}

// ---------------------------------------------------------------- live notices

interface Placed {
	/** Counts up from 1 for the process; names the notice. */
	seq: number;
	at: number;
	/** The last saved entry of the conversation when it arrived: the notice belongs right after it. */
	after: string | null;
}

/** Something omp announced while it worked that the transcript has no entry for (yet). */
export type LiveNotice = Placed &
	(
		| {
				kind: "rules";
				/** What the transcript looked like when it arrived: a rule that arrives with the same one joins this row. */
				sig: string;
				rules: { name: string; text: string }[];
		  }
		| { kind: "fallback"; from: string; to: string; role?: string; reason?: string }
		| { kind: "fallbackDone"; model: string; role?: string }
		| { kind: "irc"; message: AgentMessage }
		/**
		 * What a command (`/context`) printed, in the conversation it was run in: kept with the file's name, so that it is
		 * found again when the page is loaded anew (see `command-notes.ts`).
		 */
		| { kind: "command"; text: string; file: string | null }
		/**
		 * omp's deadline for a dialog ran out and omp went on without the user: `chosen` is what it answered for an `ask` (the
		 * recommended option of each question), empty for any other dialog (omp took it as cancelled, an approval as denied).
		 * An `ask` has no title of its own: `title` is null.
		 */
		| { kind: "dialogTimeout"; title: string | null; chosen: { question: string; answer: string }[] }
		/** The user sent a message while tools waited for approval: each was denied, as the terminal does, and the message goes on. */
		| { kind: "approvalDenied"; tools: string[] }
	);

/** What a command printed, placed where it was run. */
export type CommandNote = Extract<LiveNotice, { kind: "command" }>;

export function noticeOf(e: SessionEntry): LiveNotice | null {
	return e.type === "live_notice" ? (e.notice as LiveNotice) : null;
}

/** Whether two model names are one model: `provider/model` and its thinking level (`:high`) are not told apart. */
function sameModel(a: string, b: string): boolean {
	const x = a.split(":")[0];
	const y = b.split(":")[0];
	return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

/** Identifies an IRC message across its live card, the streamed message and the saved entry. */
export function ircKey(customType: unknown, details: unknown, timestamp: unknown): string {
	return `${String(customType)}|${str(record(details)?.id) ?? String(timestamp ?? "")}`;
}

/** The rules the saved reminder at this entry applies; empty for anything else. */
function savedRules(e: SessionEntry): string[] {
	const m = messageOf(e);
	if (m?.attribution !== "agent" || (m.role !== "user" && m.role !== "developer")) return [];
	return ruleReminders(textOf(m)).map((r) => r.name);
}

/**
 * The branch with the live notices placed where they happened: each right after the saved entry it followed.
 * A notice whose saved record has since arrived (the reminder of a rule, the model switch of a fallback, the
 * IRC message) gives way to it, or takes its place when it knows more (a fallback's reason). One for an
 * entry that is not on this branch belongs to another branch or session and is left out.
 * `streamed` are the `ircKey`s of IRC messages still arriving, which a live card must not repeat.
 */
export function withLiveNotices(path: SessionEntry[], notices: LiveNotice[], streamed: string[] = []): SessionEntry[] {
	return placeNotices(path, notices, streamed).rows;
}

/** A notice that is on screen as a live row and may give way to the saved record of what it announced. */
type Waiting =
	| { kind: "irc"; key: string }
	| { kind: "rules"; notice: Extract<LiveNotice, { kind: "rules" }>; found: Set<string> }
	| { kind: "fallback"; to: string };

interface NoticePlacement {
	rows: SessionEntry[];
	/** What may still resolve: with the entries added, the saved records that would make one give way. */
	waiting: Waiting[];
	/** Anchors of the notices left out because their entry is not on this path: the entry may yet come. */
	absent: Set<string>;
	/** A notice with no anchor sits at the end, wherever that is now: the rows cannot be kept as the path grows. */
	floating: boolean;
}

/** `withLiveNotices`, and what is needed to go on from its result when the path grows (see `LiveRows`). */
function placeNotices(path: SessionEntry[], notices: LiveNotice[], streamed: string[]): NoticePlacement {
	const waiting: Waiting[] = [];
	const absent = new Set<string>();
	let floating = false;
	if (notices.length === 0) return { rows: path, waiting, absent, floating };
	const position = new Map(path.map((e, i) => [e.id, i]));
	const known = new Set<string>();
	for (const e of path) {
		if (e.type === "custom_message" && ircMode(e.customType)) known.add(ircKey(e.customType, e.details, e.timestamp));
	}
	for (const key of streamed) known.add(key);

	const replaced = new Set<string>();
	/** The rows to put after the entry at an index (-1: before the first). */
	const after = new Map<number, SessionEntry[]>();
	const place = (index: number, n: LiveNotice) => {
		const row: SessionEntry = {
			type: "live_notice",
			id: n.kind === "command" ? `live-notice-cmd-${n.seq}` : `live-notice-${n.seq}`,
			parentId: null,
			timestamp: new Date(n.at).toISOString(),
			notice: n,
		};
		after.set(index, [...(after.get(index) ?? []), row]);
	};
	for (const n of notices) {
		// An output with no entry before it was printed before the first: the conversation had nothing saved yet. Any other
		// notice with no entry before it belongs to what is being written now, at the end.
		if (n.after === null && n.kind !== "command") floating = true;
		const from = n.after === null ? (n.kind === "command" ? -1 : path.length - 1) : (position.get(n.after) ?? -2);
		if (from === -2) {
			if (n.after !== null) absent.add(n.after);
			continue;
		}
		if (n.kind === "irc") {
			const key = ircKey(n.message.customType, n.message.details, n.message.timestamp);
			if (!known.has(key)) {
				place(from, n);
				waiting.push({ kind: "irc", key });
			}
		} else if (n.kind === "rules") {
			const found = new Set(path.slice(from + 1).flatMap(savedRules));
			if (!n.rules.every((r) => found.has(r.name))) {
				place(from, n);
				waiting.push({ kind: "rules", notice: n, found });
			}
		} else if (n.kind === "fallback") {
			const saved = path.findIndex(
				(e, i) =>
					i > from &&
					!replaced.has(e.id) &&
					e.type === "model_change" &&
					e.resolvedModelIsFallback === true &&
					sameModel(String(e.model), n.to),
			);
			if (saved < 0) {
				place(from, n);
				waiting.push({ kind: "fallback", to: n.to });
			} else {
				replaced.add(path[saved].id);
				place(saved - 1, n);
			}
		} else place(from, n);
	}

	const out = [...(after.get(-1) ?? [])];
	path.forEach((e, i) => {
		if (!replaced.has(e.id)) out.push(e);
		out.push(...(after.get(i) ?? []));
	});
	return { rows: out, waiting, absent, floating };
}

/**
 * `withLiveNotices` for a path that grows: while the notices stay as they were and none of those still on screen is
 * answered by what was saved since, the rows are the rows before and the entries added after them (that is where the
 * original would put them), found by looking at the added entries only. Anything else (a notice came or went, one was
 * answered, the path is another) is placed from the start, as `withLiveNotices` does.
 */
export class LiveRows {
	private last: { path: SessionEntry[]; notices: LiveNotice[]; streamed: string; placed: NoticePlacement } | null =
		null;

	rows(path: SessionEntry[], notices: LiveNotice[], streamed: string[] = []): SessionEntry[] {
		// Nothing to place: the path is the rows (and the one the path's own chain of appends made, which must stay the only one).
		if (notices.length === 0) {
			this.last = null;
			return path;
		}
		const key = streamed.join("\n");
		const last = this.last;
		if (last && last.notices === notices && last.streamed === key && !last.placed.floating) {
			const from = extension(last.path, path);
			if (from === path.length) return last.placed.rows;
			if (from !== null && !this.answered(last.placed, path, from)) {
				const rows = appended(last.placed.rows, path.slice(from));
				this.last = { path, notices, streamed: key, placed: { ...last.placed, rows } };
				return rows;
			}
		}
		const placed = placeNotices(path, notices, streamed);
		this.last = { path, notices, streamed: key, placed };
		return placed.rows;
	}

	/** Whether the entries from `from` on answer a notice still on screen, or hold the entry a left out notice follows. */
	private answered({ waiting, absent }: NoticePlacement, path: SessionEntry[], from: number): boolean {
		for (let i = from; i < path.length; i++) {
			const e = path[i];
			if (absent.has(e.id)) return true;
			for (const w of waiting) {
				if (w.kind === "irc") {
					if (
						e.type === "custom_message" &&
						ircMode(e.customType) &&
						ircKey(e.customType, e.details, e.timestamp) === w.key
					)
						return true;
				} else if (w.kind === "rules") {
					for (const name of savedRules(e)) w.found.add(name);
					if (w.notice.rules.every((r) => w.found.has(r.name))) return true;
				} else if (
					e.type === "model_change" &&
					e.resolvedModelIsFallback === true &&
					sameModel(String(e.model), w.to)
				) {
					return true;
				}
			}
		}
		return false;
	}
}

/** Rows that stay on screen when a finished turn folds its steps: they say something the reader must not miss. */
export function isPinned(e: SessionEntry): boolean {
	if (e.type === "custom_message") return e.customType === "advisor" && advisorNotes(e.details, e.content).length > 0;
	if (e.type === "model_change") return e.resolvedModelIsFallback === true;
	const live = noticeOf(e);
	return (
		live?.kind === "fallback" ||
		live?.kind === "fallbackDone" ||
		live?.kind === "dialogTimeout" ||
		live?.kind === "approvalDenied"
	);
}

/** Advisor notes of a turn's rows that block (the work summary says so). */
export function blockerCount(rows: SessionEntry[]): number {
	let n = 0;
	for (const e of rows) {
		if (e.type !== "custom_message" || e.customType !== "advisor") continue;
		n += advisorNotes(e.details, e.content).filter((x) => x.severity === "blocker").length;
	}
	return n;
}
