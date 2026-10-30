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
	DEFAULT_INSTRUCTION,
	INSTRUCTION_MAX,
	type InstructionProblem,
	instructionText,
	type UnattendedSettings,
} from "../../../shared/unattended.ts";

/**
 * What the person set for unattended mode (#646), in `<data dir>/unattended.json`: the instruction the main agent is told
 * (their own text, or none: the shipped one stands), and the conversations the mode is on for, by session key, so that it
 * holds when a conversation is resumed — by this server, by a later one, or after a restart — without a page saying it again.
 * It travels with Move to another computer (a `webui` data file: `server/migrate/layout.ts`).
 *
 * The file, not this object, is the truth, as for the other stores of the data dir: it is read again when it looks different
 * from what this store last wrote. A file that cannot be read is kept aside (`unattended.json.damaged`, never written over)
 * and the defaults stand: the instruction as it ships, the mode off everywhere.
 *
 * At most `MAX_SESSIONS` conversations are remembered, the newest changes last: the ones dropped are the longest untouched.
 */
const MAX_SESSIONS = 500;
/** A file this large is not this store's. */
const MAX_FILE_BYTES = 1024 * 1024;

/** A change the store refuses: the instruction is empty (restoring the default is a separate act) or too long. */
export class InstructionError extends Error {
	constructor(
		readonly problem: InstructionProblem,
		message: string,
	) {
		super(message);
	}
}

export class UnattendedStore {
	private readonly file: string;
	/** The person's own instruction; null: the shipped one. */
	private custom: string | null = null;
	private sessions: string[] = [];
	/** How the file looked when this store last read or wrote it. */
	private seen = "";

	constructor(private readonly dataDir: string) {
		this.file = join(dataDir, "unattended.json");
		this.read();
		this.seen = this.stamp();
	}

	private read(): void {
		const problem = this.load();
		if (problem) this.keepAside(problem);
	}

	/** Take the file's state. What is wrong with it when it cannot be taken; null when it was, or when there is no file (yet). */
	private load(): Error | null {
		this.custom = null;
		this.sessions = [];
		let info: Stats;
		try {
			info = statSync(this.file);
		} catch (e) {
			return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : (e as Error);
		}
		if (!info.isFile()) return new Error("it is not a regular file");
		if (info.size > MAX_FILE_BYTES) return new Error("it is far larger than these settings can be");
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.file, "utf8"));
		} catch {
			return new Error("it is not JSON");
		}
		if (!isRecord(parsed)) return new Error("it is not an object");
		if (typeof parsed.instruction === "string") {
			const text = instructionText(parsed.instruction);
			if (text && text.length <= INSTRUCTION_MAX) this.custom = text;
		}
		if (Array.isArray(parsed.sessions))
			this.sessions = [...new Set(parsed.sessions.filter((s): s is string => typeof s === "string" && s !== ""))].slice(
				-MAX_SESSIONS,
			);
		return null;
	}

	private keepAside(why: unknown): void {
		this.custom = null;
		this.sessions = [];
		let aside = `${this.file}.damaged`;
		for (let n = 0; existsSync(aside); n++) aside = `${this.file}.${Date.now()}${n ? `-${n}` : ""}.damaged`;
		try {
			renameSync(this.file, aside);
			console.warn(
				`omp-webui: ${this.file} could not be read (${why instanceof Error ? why.message : String(why)}); it was moved to ${aside}, and the defaults are used`,
			);
		} catch {
			// Nothing to move: it went while this was read.
		}
	}

	private writeFile(): void {
		mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
		const tmp = `${this.file}.${process.pid}.tmp`;
		const body = { ...(this.custom ? { instruction: this.custom } : {}), sessions: this.sessions };
		writeFileSync(tmp, `${JSON.stringify(body, null, "\t")}\n`, { mode: 0o600 });
		chmodSync(tmp, 0o600);
		renameSync(tmp, this.file);
		this.seen = this.stamp();
	}

	private stamp(): string {
		try {
			const st = statSync(this.file);
			return `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
		} catch {
			return "";
		}
	}

	private fresh(): void {
		const now = this.stamp();
		if (now === this.seen) return;
		this.seen = now;
		this.read();
	}

	/** The instruction the main agent is told while the mode is on. */
	instruction(): string {
		this.fresh();
		return this.custom ?? instructionText(DEFAULT_INSTRUCTION);
	}

	/** The instruction as the page shows it. */
	settings(): UnattendedSettings {
		this.fresh();
		return { instruction: this.instruction(), shipped: DEFAULT_INSTRUCTION, custom: this.custom !== null };
	}

	/** Set the instruction to `text`, or back to the shipped one (null). The text that equals the shipped one is the shipped one. */
	setInstruction(text: string | null): UnattendedSettings {
		this.fresh();
		if (text === null) this.custom = null;
		else {
			const clean = instructionText(text);
			if (!clean) throw new InstructionError("empty", "The instruction needs some text");
			if (clean.length > INSTRUCTION_MAX)
				throw new InstructionError("tooLong", `The instruction is at most ${INSTRUCTION_MAX} characters`);
			this.custom = clean === instructionText(DEFAULT_INSTRUCTION) ? null : clean;
		}
		this.writeFile();
		return this.settings();
	}

	/** Whether the mode is on for the conversation in `key`. */
	isOn(key: string): boolean {
		this.fresh();
		return this.sessions.includes(key);
	}

	/** Turn the mode on or off for the conversation in `key`. */
	setOn(key: string, on: boolean): void {
		this.fresh();
		const had = this.sessions.includes(key);
		if (on === had) return;
		this.sessions = on ? [...this.sessions, key].slice(-MAX_SESSIONS) : this.sessions.filter((s) => s !== key);
		this.writeFile();
	}

	/** The conversation moved to another session file: the mode goes along. */
	carry(from: string, to: string): void {
		this.fresh();
		if (!this.sessions.includes(from) || this.sessions.includes(to)) return;
		this.sessions = [...this.sessions, to].slice(-MAX_SESSIONS);
		this.writeFile();
	}
}
