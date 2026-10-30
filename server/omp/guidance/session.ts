import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isRecord } from "../../../shared/guards.ts";
import { GUIDANCE_SUFFIX, guidanceTextOf, type SessionGuidance } from "../../../shared/model-guidance.ts";
import type { GuidanceStore } from "./store.ts";

/**
 * The guidance one conversation carries, and the file its omp reads it from.
 *
 * What it is kept by: the conversation, not the process. A new conversation is given one when it starts (the template
 * or the text the person picked in New chat); the choice is kept under the conversation's session key in the app's data
 * dir (`model-guidance-sessions.json`), as the conversation's permission mode and preset are, so that it holds when the
 * conversation is resumed — by this server, by a later one, or after a restart — without the page having to say it again.
 *
 * Where the text reaches omp: the file named after the conversation's live id, beside the process's settings overlay
 * (`<overlay>.guidance.md`, in the same temp folder: `ApprovalStore`). The extension (`extension.ts`) is told its path in
 * `OMPW_GUIDANCE_FILE`, and reads it at every turn, so a change of the conversation's guidance (another template, its
 * own text, or none) reaches the next turn of the running process without a restart. So does an edit of the template it
 * uses: when a template is saved, renamed, deleted or restored, the server rewrites the files of the running processes
 * that use it (`LivePool.followGuidanceTemplates`); a conversation that made the text its own is not touched. A process
 * that is not running has no file: when it starts again the server writes the conversation's guidance fresh, from the
 * template as it is then.
 *
 * What a conversation keeps: the template it picked by id, and the text that template stood for when it was picked. The
 * id is what the session shows and what a page changes to another template; the text is what the extension reads, and it
 * keeps working when the template is edited (the next turn carries the edit), deleted, or the whole store is restored to
 * the shipped templates while the conversation is open.
 */

/** One conversation's choice, as it is written down. */
export interface KeptGuidance {
	/** The template the person picked; absent when they typed text instead. */
	template?: string;
	/** The text the conversation carries, as the template stood for it when it was picked (or as it was typed). */
	text: string;
}

const FILE = "model-guidance-sessions.json";
const MAX_REMEMBERED = 500;

/** A conversation's key: its session file, and the session's key written down as the approval store writes it. */
type Choice = KeptGuidance;

/**
 * The store of what each conversation carries, and the writing of the files its processes read.
 *
 * The file's truth is shared, as the data dir's other stores are: it is read again before every look and every change, so
 * that another server on the same data dir (a second copy of the app) does not undo this one's choices.
 */
export class GuidanceSessions {
	private readonly file: string;
	private choices = new Map<string, Choice>();
	private stamp = "";

	constructor(
		private readonly dataDir: string,
		private readonly store: GuidanceStore,
	) {
		this.file = join(dataDir, FILE);
		this.read();
	}

	private read(): void {
		let text: string;
		try {
			text = readFileSync(this.file, "utf8");
		} catch {
			// No file: no conversation has been given guidance yet.
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			// A file that cannot be read says nothing: what is in memory (or nothing) stands, and the next change writes it.
			return;
		}
		if (!isRecord(parsed) || !isRecord(parsed.sessions)) return;
		const next = new Map<string, Choice>();
		for (const [key, raw] of Object.entries(parsed.sessions)) {
			if (!isRecord(raw) || typeof raw.text !== "string") continue;
			next.set(key, {
				...(typeof raw.template === "string" && raw.template ? { template: raw.template } : {}),
				text: raw.text,
			});
		}
		this.choices = next;
	}

	/** The file's current shape, so that a change another server made is not written over. */
	private refresh(): void {
		let now: string;
		try {
			now = readFileSync(this.file, "utf8");
		} catch {
			now = "";
		}
		if (now === this.stamp) return;
		this.stamp = now;
		this.read();
	}

	private save(): void {
		const sessions: Record<string, Choice> = {};
		for (const [key, choice] of this.choices) sessions[key] = choice;
		mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
		const tmp = `${this.file}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify({ sessions }, null, "\t")}\n`, { mode: 0o600 });
		chmodSync(tmp, 0o600);
		renameSync(tmp, this.file);
		try {
			this.stamp = readFileSync(this.file, "utf8");
		} catch {
			this.stamp = "";
		}
	}

	/** What the conversation in `key` carries, as it was kept; null when the person gave it none. */
	kept(key: string): KeptGuidance | null {
		this.refresh();
		const choice = this.choices.get(key);
		if (!choice) return null;
		// A template edited since shows its new text: what the conversation carries is what the template says now, unless
		// the template is gone, and then the text it stood for when it was picked.
		const template = choice.template ? this.store.list().find((t) => t.id === choice.template) : undefined;
		const text = template ? template.text : choice.text;
		return { ...(choice.template ? { template: choice.template } : {}), text };
	}

	/** Keep what the conversation in `key` carries from now on (null: none). */
	remember(key: string, choice: KeptGuidance | null): void {
		this.refresh();
		this.choices.delete(key);
		if (choice) this.choices.set(key, choice);
		// Only the newest are kept, as the approval store's own choices are: the ones dropped are the longest untouched.
		while (this.choices.size > MAX_REMEMBERED) {
			const oldest = this.choices.keys().next();
			if (oldest.done) break;
			this.choices.delete(oldest.value);
		}
		this.save();
	}

	/** The conversation moved to another session file: what it was given goes along. */
	carry(from: string, to: string): void {
		this.refresh();
		const choice = this.choices.get(from);
		if (!choice || this.choices.has(to)) return;
		this.choices.set(to, choice);
		this.save();
	}

	/**
	 * How many conversations other than `except` (a session key; null leaves none out) use each template, by template id:
	 * the Guidance tab asks before it saves into a template others use. A conversation whose session file is gone (deleted,
	 * or moved and carried to its new key) is not counted: it is a choice nobody can open again.
	 */
	usersByTemplate(except: string | null): Record<string, number> {
		this.refresh();
		const users: Record<string, number> = {};
		for (const [key, choice] of this.choices) {
			if (!choice.template || key === except || !existsSync(key)) continue;
			users[choice.template] = (users[choice.template] ?? 0) + 1;
		}
		return users;
	}

	/** The text a conversation carries, from a template id or text a page gave, as the store has them now. */
	textOf(guidance: SessionGuidance | null | undefined): string {
		return guidanceTextOf(this.store.list(), guidance);
	}
}

/**
 * The file the conversation's omp reads its guidance from: beside its settings overlay, so that it is removed with it.
 * `overlay` null: the conversation has no settings overlay (no approval store), and `fallback` (a folder of the server's
 * own, in the data dir) is used instead. Either way the path follows from what the process is, not from when it started, so
 * a paused conversation taken over by the next server is told the same file (`LivePool.attach`).
 */
export function guidanceFileFor(liveId: string, overlay: string | null, fallback: string): string {
	return overlay ? `${overlay}${GUIDANCE_SUFFIX}` : join(fallback, `${liveId}${GUIDANCE_SUFFIX}`);
}

/**
 * Write the text `liveId`'s omp must carry, or take the file away when there is none. `file` exists only for a process
 * the server started with the extension: writing one for a process that does not read it would be a file nobody reads.
 */
export function writeGuidanceFile(file: string, text: string | null): void {
	const clean = text === null ? "" : text.replace(/^\s+|\s+$/g, "");
	if (!clean) {
		rmSync(file, { force: true });
		return;
	}
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, `${clean}\n`, { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, file);
}
