import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The conversations that are in a guided-goal interview (shared/guided-goal.ts), by session file, kept in the data dir.
 *
 * An interview is the conversation holding the `propose_goal` host tool, and a host tool lives only in the omp
 * process that was given it. The interview itself is plain conversation, so nothing keeps that process busy while
 * the user thinks about an answer: it is closed as surplus when nobody watches, it ends with the server, and
 * `release` closes it for the terminal. Rather than hold processes open for as long as an answer may take, the
 * server remembers which conversations were interviewing and gives the tool back when one is resumed.
 * A conversation leaves the list when the interview ends (the tool is taken away) or a goal is created.
 */

/** Conversations kept; the oldest go first. An interview left open forever costs a line, not a process. */
const MAX_INTERVIEWS = 200;

export class InterviewStore {
	private readonly file: string;

	constructor(dataDir: string) {
		this.file = join(dataDir, "interviews.json");
	}

	private read(): string[] {
		try {
			const v: unknown = JSON.parse(readFileSync(this.file, "utf8"));
			return Array.isArray(v) ? v.filter((f): f is string => typeof f === "string") : [];
		} catch {
			return [];
		}
	}

	private save(files: string[]): void {
		writeFileSync(`${this.file}.tmp`, JSON.stringify(files), { mode: 0o600 });
		renameSync(`${this.file}.tmp`, this.file);
	}

	has(sessionFile: string): boolean {
		return this.read().includes(sessionFile);
	}

	/** Mark this conversation as interviewing (re-adding moves it to the newest end). */
	add(sessionFile: string): void {
		const files = this.read().filter((f) => f !== sessionFile);
		files.push(sessionFile);
		this.save(files.slice(-MAX_INTERVIEWS));
	}

	remove(sessionFile: string): void {
		const files = this.read();
		if (files.includes(sessionFile)) this.save(files.filter((f) => f !== sessionFile));
	}
}
