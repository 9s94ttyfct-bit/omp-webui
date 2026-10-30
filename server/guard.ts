import {
	chmodSync,
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	type Stats,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	applyRulesPatch,
	DEFAULT_GUARD_CONFIG,
	decisionMatches,
	GUARD_LOG_DIR,
	GUARD_LOG_FILE,
	type GuardConfig,
	type GuardDecision,
	type GuardLogPage,
	type GuardLogQuery,
	parseDecision,
	parseGuardConfig,
	parseGuardPatch,
	parseRulesPatch,
} from "../shared/guard.ts";
import { type GuardRules, parseRules } from "../shared/guard-policy.ts";

/**
 * "Guard dangerous commands" (Settings › Safety), on the server's side: the settings, and the log of what the guard decided.
 * What the guard does is the gate's (`server/omp/gate/extension.ts`, inside omp); this is what tells it what to do
 * (`Live.guardWord`) and what a page reads of it.
 */

/**
 * The settings, kept in `<data dir>/guard.json`: the mode, the reviewer and the switch, and beside them what the person
 * tuned (`GuardRules`: the reviewer's rules, the threshold of each category, their own benchmark cases), each only when it
 * is not the default. The server's memory is the truth and the file is where it is kept across restarts: it is not a place
 * to edit. A file that is gone, or that says something else than the server wrote (an agent that got to it, another tool)
 * is written again from memory at the next look (`verify`), so that the guard cannot be turned off, or its rules loosened,
 * by changing a file. A file that cannot be read when the server starts is the default: the guard on.
 */
export class GuardSettings {
	readonly file: string;
	private config: GuardConfig;
	private tuned: GuardRules;
	/** How the file looked when this server last wrote it (or found it): its modification time and size, "" for none. */
	private stamp = "";

	constructor(dataDir: string) {
		this.file = process.env.OMP_WEBUI_GUARD_CONFIG || join(dataDir, "guard.json");
		({ config: this.config, rules: this.tuned } = this.read());
		this.stamp = this.look();
	}

	private look(): string {
		try {
			const stat = statSync(this.file);
			return `${stat.mtimeMs}:${stat.size}`;
		} catch {
			return "";
		}
	}

	private read(): { config: GuardConfig; rules: GuardRules } {
		try {
			const raw: unknown = JSON.parse(readFileSync(this.file, "utf8"));
			return { config: parseGuardConfig(raw), rules: parseRules(raw) };
		} catch {
			return { config: { ...DEFAULT_GUARD_CONFIG }, rules: {} };
		}
	}

	/** What the file holds for these settings: the basics, then the rules that are not the default. */
	private text(config: GuardConfig, rules: GuardRules): string {
		return `${JSON.stringify({ ...config, ...rules }, null, 2)}\n`;
	}

	get(): GuardConfig {
		return { ...this.config };
	}

	/** What the person tuned: the reviewer's rules, the threshold of each category, their own benchmark cases. */
	rules(): GuardRules {
		return structuredClone(this.tuned);
	}

	private write(config: GuardConfig, rules: GuardRules): void {
		mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
		writeFileSync(`${this.file}.tmp`, this.text(config, rules), { mode: 0o600 });
		renameSync(`${this.file}.tmp`, this.file);
		chmodSync(this.file, 0o600);
		this.stamp = this.look();
	}

	/** Apply a change a page asked for. Throws `GuardConfigError` for one that is not acceptable, and when it cannot be kept. */
	set(patch: unknown): GuardConfig {
		const next = { ...this.config, ...parseGuardPatch(patch) };
		this.write(next, this.tuned);
		this.config = next;
		return this.get();
	}

	/** Apply a change to the rules a page asked for. Throws `GuardConfigError` for one that is not acceptable, and when it cannot be kept. */
	setRules(patch: unknown): GuardRules {
		const next = applyRulesPatch(this.tuned, parseRulesPatch(patch));
		this.write(this.config, next);
		this.tuned = next;
		return this.rules();
	}

	/** Look at the file, and write it again from memory when it is not what this server left. True when it had to be. */
	verify(): boolean {
		const stamp = this.look();
		if (stamp === this.stamp) return false;
		const mine = this.text(this.config, this.tuned);
		const found = this.read();
		const same = stamp !== "" && this.text(found.config, found.rules) === mine;
		const nothing = stamp === "" && mine === this.text(DEFAULT_GUARD_CONFIG, {});
		if (same || nothing) {
			this.stamp = stamp;
			return false;
		}
		try {
			this.write(this.config, this.tuned);
		} catch (e) {
			console.warn(`omp-webui: could not write the guard's settings again: ${(e as Error).message}`);
			return false;
		}
		console.warn("omp-webui: the guard's settings file was changed outside Settings; it was written again.");
		return true;
	}

	/**
	 * Take the file as the server's own, for a file the person put there on purpose: the one an import (Move to another
	 * computer) wrote. Not for one an agent could have changed, which `verify` writes over. Returns what is in force now.
	 */
	reload(): GuardConfig {
		({ config: this.config, rules: this.tuned } = this.read());
		this.stamp = this.look();
		return this.get();
	}
}

/** The most of the log read at once: a page shows the last of it. */
const TAIL_BYTES = 2 * 1024 * 1024;
/** The log is moved aside (`decisions.jsonl.1`, replacing the one before) when it is longer than this. */
const ROTATE_BYTES = 8 * 1024 * 1024;

/** What `GuardLog.tail` hands out. */
export interface GuardTail {
	/** Newest first. */
	decisions: GuardDecision[];
	/** How many decisions the part that was read held (the log may hold more: it is read from its end). */
	total: number;
}

/**
 * The decisions the gates wrote down: one JSON line each, appended by every omp process that has a gate, to
 * `<data dir>/guard/decisions.jsonl`. Read from the end for the Settings log and for a conversation's tool cards, and
 * followed (`poll`) so that pages hear of a decision as it is made.
 */
export class GuardLog {
	readonly file: string;
	/** Where `poll` has read to: only whole lines are taken, so a line being written is read when it is whole. */
	private offset: number;
	/** What `readTail` parsed, and how the file looked then. */
	private cached: { stamp: string; all: GuardDecision[] } | null = null;

	constructor(dataDir: string) {
		this.file = join(dataDir, GUARD_LOG_DIR, GUARD_LOG_FILE);
		this.offset = this.size();
	}

	private size(): number {
		try {
			return statSync(this.file).size;
		} catch {
			return 0;
		}
	}

	/** `length` bytes of the file from `start`, as text. */
	private slice(start: number, length: number): string {
		const fd = openSync(this.file, "r");
		try {
			const buffer = Buffer.alloc(length);
			const n = readSync(fd, buffer, 0, length, start);
			return buffer.toString("utf8", 0, n);
		} finally {
			closeSync(fd);
		}
	}

	private parse(text: string): GuardDecision[] {
		const out: GuardDecision[] = [];
		for (const line of text.split("\n")) {
			if (line === "") continue;
			try {
				const decision = parseDecision(JSON.parse(line));
				if (decision) out.push(decision);
			} catch {
				// Not a line the gate wrote: left out.
			}
		}
		return out;
	}

	/** The decisions written down, oldest first: what the last 2 MB of the log holds, parsed once for as long as the file does not change. */
	private readTail(): GuardDecision[] {
		let stat: Stats;
		try {
			stat = statSync(this.file);
		} catch {
			this.cached = null;
			return [];
		}
		if (stat.size === 0) return [];
		const stamp = `${stat.mtimeMs}:${stat.size}`;
		if (this.cached?.stamp === stamp) return this.cached.all;
		const start = Math.max(0, stat.size - TAIL_BYTES);
		let text: string;
		try {
			text = this.slice(start, stat.size - start);
		} catch {
			return [];
		}
		// The first line of a part cut from the middle is not whole.
		if (start > 0) text = text.slice(text.indexOf("\n") + 1);
		const all = this.parse(text);
		this.cached = { stamp, all };
		return all;
	}

	/** The newest `limit` decisions, newest first. */
	tail(limit: number, only?: (d: GuardDecision) => boolean): GuardTail {
		const all = this.readTail().filter(only ?? (() => true));
		return { decisions: all.slice(-limit).reverse(), total: all.length };
	}

	/** A page of the decisions that match `query`, newest first. */
	query(query: GuardLogQuery): GuardLogPage {
		const all = this.readTail();
		const found = all.filter((d) => decisionMatches(d, query)).reverse();
		// A cursor that is not there any more (the log was moved aside) ends the list: asking again would only repeat the newest page.
		const at = query.before ? found.findIndex((d) => d.id === query.before) : -1;
		if (query.before && at < 0) return { decisions: [], total: all.length, matched: found.length, next: null };
		const start = at + 1;
		const decisions = found.slice(start, start + query.limit);
		const last = decisions[decisions.length - 1];
		return {
			decisions,
			total: all.length,
			matched: found.length,
			next: last && start + decisions.length < found.length ? last.id : null,
		};
	}

	/** The decisions written since the last call (the first call: since the server started). */
	poll(): GuardDecision[] {
		const size = this.size();
		if (size < this.offset) this.offset = 0;
		let decisions: GuardDecision[] = [];
		if (size > this.offset) {
			try {
				const text = this.slice(this.offset, size - this.offset);
				const whole = text.slice(0, text.lastIndexOf("\n") + 1);
				this.offset += Buffer.byteLength(whole);
				decisions = this.parse(whole);
			} catch {
				// Read again at the next look.
			}
		}
		if (this.offset > ROTATE_BYTES) this.rotate();
		return decisions;
	}

	/** Move the log aside once it is long, replacing the one moved aside before; the gates go on appending to a new file. */
	private rotate(): void {
		try {
			renameSync(this.file, `${this.file}.1`);
			this.offset = 0;
		} catch {
			// Not moved: tried again at the next look.
		}
	}

	/** What the gates decided about the agent whose transcript is `file`, newest first. */
	ofFile(file: string, limit: number): GuardDecision[] {
		return this.tail(limit, (d) => d.file === file).decisions;
	}

	/** What the gates decided about the agent whose session is `session`, newest first. */
	ofSession(session: string, limit: number): GuardDecision[] {
		return this.tail(limit, (d) => d.session === session).decisions;
	}
}
