import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	type Stats,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../../shared/guards.ts";
import {
	type AnswerInput,
	cleanOptions,
	cleanText,
	QUESTION_LIMITS,
	type Question,
	type QuestionCounts,
	type QuestionDraft,
	type QuestionDrop,
	type QuestionDropWhy,
	type QuestionList,
	type QuestionSource,
} from "../../../shared/unattended.ts";

/**
 * The questions of unattended mode (#646): what the agents filed for the person, and what the person did with them. Kept in
 * `<data dir>/questions.json`, so that they survive a reload and a restart, travel with Move to another computer (the file
 * is a `webui` data file: `server/migrate/layout.ts`), and are the same for a page on this computer and one through the
 * tunnel. Private to the person (`0600`), as every file the server keeps there.
 *
 * Bounded, because what a model files is not trusted to be small: each field is cut to its limit
 * (`QUESTION_LIMITS`), a conversation may have `openPerConversation` open at once, and the file keeps `kept` in all — the
 * oldest answered or dismissed ones go first, and only when everything is open the oldest open one. A file larger than
 * `MAX_FILE_BYTES` is not read (it is kept aside as damaged, like one that is not JSON).
 *
 * The file, not this object, is the truth, as for the other stores of the data dir: another server on the same data dir may
 * write it. It is read again before every look and every change when it looks different from what this store last wrote,
 * and the revision only ever goes up. A file that cannot be read is kept aside (`questions.json.damaged`, never written
 * over) and the list starts empty: a damaged file never stops a conversation, and never loses what it held without a trace.
 * Within a readable file, an entry that is not a question is dropped and the rest stand.
 */

/**
 * A file this large is not a questions file. The bounds above put the largest honest one, 200 questions at every field's
 * limit in non-ASCII text, at about 16 MB: this stays well above that, so the store never sets its own file aside.
 */
const MAX_FILE_BYTES = 32 * 1024 * 1024;

/**
 * How many questions that could not be kept are remembered (#650): enough for a conversation that hit the limit a few times
 * while the person was away, and not a list that grows with a runaway agent's every attempt (it is kept in memory only).
 */
const DROPS_KEPT = 50;

const STATES: Record<Question["state"], true> = { open: true, answered: true, dismissed: true };
const SOURCES: Record<QuestionSource, true> = { tool: true, ask: true };

/**
 * What a filed question is, or why it was not: `empty` (no text), `duplicate` (the same call, or the same open question), `full`
 * (the conversation has its `openPerConversation` open), `unwritable` (the list could not be written to the data folder).
 * `drop` is the entry the list now holds for it, null when the same question already failed the same way.
 */
export type FileResult =
	| { ok: true; question: Question }
	| { ok: false; why: "empty" | "duplicate" | "full" | "unwritable"; drop?: QuestionDrop };

/** A change the store refuses (an id it does not hold, a question already settled). */
export class QuestionError extends Error {
	constructor(
		readonly problem: "unknown" | "settled" | "noAnswer",
		message: string,
	) {
		super(message);
	}
}

/** `value` as a question, or null: the fields it must have are there, and every text is held to its limit. */
function questionOf(value: unknown): Question | null {
	if (!isRecord(value)) return null;
	const { id, session, state, source } = value;
	if (typeof id !== "string" || !id || id.length > 80) return null;
	if (typeof session !== "string" || session.length > 4_096) return null;
	if (typeof state !== "string" || !Object.hasOwn(STATES, state)) return null;
	if (typeof source !== "string" || !Object.hasOwn(SOURCES, source)) return null;
	const question = cleanText(value.question, QUESTION_LIMITS.title);
	if (!question) return null;
	const asked = value.askedAt;
	if (typeof asked !== "number" || !Number.isFinite(asked)) return null;
	const options = cleanOptions(value.options);
	const out: Question = {
		id,
		session,
		title: cleanText(value.title, QUESTION_LIMITS.title),
		source: source as QuestionSource,
		question,
		context: cleanText(value.context, QUESTION_LIMITS.context),
		options,
		askedAt: asked,
		state: state as Question["state"],
	};
	const cwd = cleanText(value.cwd, 4_096);
	if (cwd) out.cwd = cwd;
	const rec = value.recommended;
	if (typeof rec === "number" && Number.isInteger(rec) && rec >= 0 && rec < options.length) out.recommended = rec;
	if (value.multi === true) out.multi = true;
	const meanwhile = cleanText(value.meanwhile, QUESTION_LIMITS.meanwhile);
	if (meanwhile) out.meanwhile = meanwhile;
	if (typeof value.call === "string" && value.call.length <= 200) out.call = value.call;
	if (typeof value.settledAt === "number" && Number.isFinite(value.settledAt)) out.settledAt = value.settledAt;
	if (isRecord(value.answer)) {
		const chosen = Array.isArray(value.answer.options)
			? value.answer.options.flatMap((o) => (typeof o === "string" ? [cleanText(o, QUESTION_LIMITS.label)] : []))
			: [];
		out.answer = {
			options: chosen.slice(0, QUESTION_LIMITS.options),
			text: cleanText(value.answer.text, QUESTION_LIMITS.answer),
		};
	}
	return out;
}

/** The questions a stored value holds, in order, dropping what is not a question and repeating ids; at most `kept`. */
function questionsOf(value: unknown): Question[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const out: Question[] = [];
	for (const raw of value) {
		const q = questionOf(raw);
		if (!q || seen.has(q.id)) continue;
		seen.add(q.id);
		out.push(q);
		if (out.length >= QUESTION_LIMITS.kept) break;
	}
	return out;
}

export class QuestionStore {
	private readonly path: string;
	private rev = 0;
	private questions: Question[] = [];
	/** How the file looked when this store last read or wrote it: what says whether it must be read again. */
	private seen = "";
	/**
	 * The questions that could not be kept (#650), newest last: what the Questions list says of them. Kept in memory only —
	 * there is nothing to write for a question that is not there — so a restart forgets them, as it forgets the failure.
	 */
	private dropped: QuestionDrop[] = [];
	private dropSeq = 0;
	private readonly listeners = new Set<(counts: QuestionCounts) => void>();

	constructor(
		private readonly dataDir: string,
		private readonly now: () => number = Date.now,
	) {
		this.path = join(dataDir, "questions.json");
		this.read();
		this.seen = this.stamp();
	}

	/** Call `listener` with the counts after every change this store makes (not after one that is only read from the file). */
	onChange(listener: (counts: QuestionCounts) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private read(): void {
		const problem = this.load();
		if (problem) this.keepAside(problem);
	}

	/** Take the file's state. What is wrong with it when it cannot be taken; null when it was, or when there is no file (yet). */
	private load(): Error | null {
		let info: Stats;
		try {
			info = statSync(this.path);
		} catch (e) {
			// No file yet: there is nothing to take, and nothing is written until something is filed.
			this.questions = [];
			return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : (e as Error);
		}
		// Not a file (a folder, a pipe): reading it could stop the whole server, and it is no questions file.
		if (!info.isFile()) return new Error("it is not a regular file");
		if (info.size > MAX_FILE_BYTES) return new Error("it is far larger than a list of questions can be");
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.path, "utf8"));
		} catch {
			return new Error("it is not JSON");
		}
		if (!isRecord(parsed) || !Array.isArray(parsed.questions)) return new Error("it does not hold a list of questions");
		this.rev = Number.isInteger(parsed.rev) && (parsed.rev as number) >= 0 ? (parsed.rev as number) : 0;
		this.questions = questionsOf(parsed.questions);
		return null;
	}

	/**
	 * What cannot be read is kept beside the store, so that nothing it held is lost without a trace. An earlier damaged copy is
	 * never written over: a later one is named with the time (it still ends in `.damaged`, which Move to another computer
	 * ignores). A pipe or a device is renamed too, and never opened: reading one nobody writes to would stop the server.
	 */
	private keepAside(why: unknown): void {
		this.questions = [];
		let aside = `${this.path}.damaged`;
		for (let n = 0; existsSync(aside); n++) aside = `${this.path}.${Date.now()}${n ? `-${n}` : ""}.damaged`;
		try {
			renameSync(this.path, aside);
			console.warn(
				`omp-webui: ${this.path} could not be read (${why instanceof Error ? why.message : String(why)}); it was moved to ${aside}, and the list of questions starts empty`,
			);
		} catch {
			// Nothing to move: it went while this was read.
		}
	}

	/** Written whole and moved into place: a crash mid-write leaves the old file, never half of one. */
	private writeFile(): void {
		mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
		const tmp = `${this.path}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify({ rev: this.rev, questions: this.questions }, null, "\t")}\n`, {
			mode: 0o600,
		});
		chmodSync(tmp, 0o600);
		renameSync(tmp, this.path);
		this.seen = this.stamp();
	}

	/** How the file looks, "" for none: a file written or replaced by anyone else looks different. */
	private stamp(): string {
		try {
			const st = statSync(this.path);
			return `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
		} catch {
			return "";
		}
	}

	/** Take the file again when somebody else changed it. */
	private fresh(): void {
		const now = this.stamp();
		if (now === this.seen) return;
		this.seen = now;
		this.read();
	}

	private changed(): void {
		this.rev++;
		this.writeFile();
		const counts = this.counts();
		for (const fn of this.listeners) fn(counts);
	}

	/** How many are open, and in which conversations: what every page is told on a change. */
	counts(): QuestionCounts {
		this.fresh();
		const byConversation: Record<string, number> = {};
		let open = 0;
		for (const q of this.questions) {
			if (q.state !== "open") continue;
			open++;
			if (q.session) byConversation[q.session] = (byConversation[q.session] ?? 0) + 1;
		}
		return { rev: this.rev, open, byConversation };
	}

	/** Every question, the open ones first (newest first), then the settled ones (the latest first), and what could not be kept. */
	list(): QuestionList {
		const counts = this.counts();
		const open = this.questions.filter((q) => q.state === "open").sort((a, b) => b.askedAt - a.askedAt);
		const done = this.questions
			.filter((q) => q.state !== "open")
			.sort((a, b) => (b.settledAt ?? b.askedAt) - (a.settledAt ?? a.askedAt));
		return {
			...counts,
			questions: [...open, ...done].map((q) => structuredClone(q)),
			dropped: this.dropped.map((d) => ({ ...d })),
		};
	}

	/**
	 * A question that could not be kept (#650): it is remembered for the list, and the counts are told again (the list the
	 * pages read holds it), so a page that shows the questions says so without being asked. Nothing is written: a question
	 * that is not in the list has nothing to write. The same question of the same conversation failing the same way is one
	 * entry, however often a runaway agent files it; only what is new is answered (the caller then tells the conversation).
	 */
	private recordDrop(session: string, why: QuestionDropWhy, question: string): QuestionDrop | null {
		const text = question.slice(0, QUESTION_LIMITS.title);
		if (this.dropped.some((d) => d.session === session && d.why === why && d.question === text)) return null;
		const drop: QuestionDrop = { seq: ++this.dropSeq, session, why, question: text, at: this.now() };
		this.dropped.push(drop);
		// The whole run is worth no more than a page can show, and the oldest go first.
		if (this.dropped.length > DROPS_KEPT) this.dropped = this.dropped.slice(-DROPS_KEPT);
		this.rev++;
		const counts = this.counts();
		for (const fn of this.listeners) fn(counts);
		return drop;
	}

	get(id: unknown): Question | undefined {
		this.fresh();
		const q = typeof id === "string" ? this.questions.find((x) => x.id === id) : undefined;
		return q ? structuredClone(q) : undefined;
	}

	/**
	 * File a question a conversation asked. `call` names what filed it (the tool call's or the dialog's id): the same call is
	 * never filed twice, and neither is a question the conversation still has open with the same words. What cannot be kept
	 * is recorded as dropped, with why, and the caller is told the reason to say it in the conversation.
	 */
	file(
		from: { session: string; cwd?: string; title?: string },
		source: QuestionSource,
		draft: QuestionDraft,
		call?: string,
	): FileResult {
		this.fresh();
		if (!draft.question) {
			const drop = this.recordDrop(from.session, "empty", "");
			return { ok: false, why: "empty", ...(drop ? { drop } : {}) };
		}
		if (
			this.questions.some(
				(q) =>
					q.session === from.session &&
					((call && q.call === call && q.question === draft.question) ||
						(q.state === "open" && q.question === draft.question && q.context === draft.context)),
			)
		)
			return { ok: false, why: "duplicate" };
		const openHere = this.questions.filter((q) => q.state === "open" && q.session === from.session).length;
		if (openHere >= QUESTION_LIMITS.openPerConversation) {
			const drop = this.recordDrop(from.session, "full", draft.question);
			return { ok: false, why: "full", ...(drop ? { drop } : {}) };
		}
		const q: Question = {
			id: `q${this.now().toString(36)}${Math.trunc(Math.random() * 1e8).toString(36)}`,
			session: from.session,
			...(from.cwd ? { cwd: cleanText(from.cwd, 4_096) } : {}),
			title: cleanText(from.title, QUESTION_LIMITS.title),
			source,
			question: draft.question,
			context: draft.context,
			options: draft.options,
			...(draft.recommended !== undefined ? { recommended: draft.recommended } : {}),
			...(draft.multi ? { multi: true } : {}),
			...(draft.meanwhile ? { meanwhile: draft.meanwhile } : {}),
			askedAt: this.now(),
			state: "open",
			...(call ? { call: call.slice(0, 200) } : {}),
		};
		// A list that cannot be written keeps nothing: the question would be on screen and gone at the next read, so it is
		// taken back out and said to be unwritable (#650).
		const before = this.questions;
		const rev = this.rev;
		this.questions = [...before, q];
		this.trim();
		try {
			this.changed();
		} catch (e) {
			this.questions = before;
			this.rev = rev;
			const drop = this.recordDrop(from.session, "unwritable", draft.question);
			console.error(`omp-webui: could not write the questions file: ${(e as Error).message}`);
			return { ok: false, why: "unwritable", ...(drop ? { drop } : {}) };
		}
		return { ok: true, question: structuredClone(q) };
	}

	/** Over `kept`: the oldest settled go first, then (only when all are open) the oldest open. */
	private trim(): void {
		while (this.questions.length > QUESTION_LIMITS.kept) {
			let victim = -1;
			let at = Number.POSITIVE_INFINITY;
			for (const [i, q] of this.questions.entries()) {
				if (q.state === "open") continue;
				const when = q.settledAt ?? q.askedAt;
				if (when < at) {
					at = when;
					victim = i;
				}
			}
			if (victim < 0) {
				at = Number.POSITIVE_INFINITY;
				for (const [i, q] of this.questions.entries()) {
					if (q.askedAt < at) {
						at = q.askedAt;
						victim = i;
					}
				}
			}
			if (victim < 0) return;
			this.questions.splice(victim, 1);
		}
	}

	/** The question `id`, marked answered with `answer`. One that is settled already is refused: an answer is sent once. */
	answer(id: unknown, answer: AnswerInput): Question {
		return this.settle(id, "answered", answer);
	}

	/** The question `id`, dismissed: the person has no answer for it, and the agent is told nothing. */
	dismiss(id: unknown): Question {
		return this.settle(id, "dismissed");
	}

	private settle(id: unknown, state: "answered" | "dismissed", answer?: AnswerInput): Question {
		this.fresh();
		const q = typeof id === "string" ? this.questions.find((x) => x.id === id) : undefined;
		if (!q) throw new QuestionError("unknown", "That question is not in the list any more");
		if (q.state !== "open") throw new QuestionError("settled", "That question is answered or dismissed already");
		q.state = state;
		q.settledAt = this.now();
		if (answer) q.answer = { options: [...answer.options], text: answer.text };
		this.changed();
		return structuredClone(q);
	}
}
