import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { UNATTENDED_SUFFIX, type UnattendedSettings, waitingQuestionsBlock } from "../../../shared/unattended.ts";
import { installUnattendedExtension, unattendedPaths } from "./install.ts";
import { QuestionStore } from "./questions.ts";
import { UnattendedStore } from "./store.ts";

/**
 * What the pool needs of unattended mode (#646), as `GuidanceHooks` is what it needs of the model guidance: the extension omp
 * is started with, the file it reads, the conversations the mode is on for, the instruction, and the questions.
 *
 * `LivePool.unattended` is null where the app has none (a server that started without a data dir): a conversation then
 * has no mode, and the routes are not there.
 */
export interface UnattendedHooks {
	/** The extension omp is started with (`--extension`). */
	readonly extension: string;
	/** Make sure the extension's files are as the server has them, before a process is started with it. False when they cannot be. */
	ensure(): boolean;
	/** The file the conversation `liveId`'s omp reads its instruction from (`overlay`: its settings overlay, whose folder goes with it). */
	fileFor(liveId: string, overlay: string | null): string;
	/** Write the text, or take the file away when there is none (a process that reads it is then not unattended). */
	write(file: string, text: string | null): void;
	/** The instruction the main agent is told while the mode is on. */
	instruction(): string;
	/**
	 * The instruction with the questions the conversation in `session` filed that still wait under it, but `answering` (the
	 * one whose answer is on its way); see `UnattendedService.textFor`.
	 */
	textFor(session: string | null, answering?: string): string;
	/** Whether the mode is on for the conversation in `key` (a session key), and set it. */
	isOn(key: string): boolean;
	setOn(key: string, on: boolean): void;
	/** The conversation moved to another session file. */
	carry(from: string, to: string): void;
	readonly questions: QuestionStore;
}

/**
 * The unattended mode of this server: the settings and the conversations it is on for (`store.ts`), the questions
 * (`questions.ts`), and the extension omp is started with (`install.ts`, `extension.ts`), as one thing the pool and the
 * routes ask.
 *
 * A conversation's instruction file is written beside its settings overlay, in the temp folder the overlays are made in
 * (`server/omp/approval.ts`), because it is that process's alone and goes with it. A process that has no overlay (modes are
 * not managed, as in some tests) gets a file under `<data dir>/unattended/live/`, a path that follows from the process's id:
 * a conversation taken over by the next server is then told the same file.
 */
export class UnattendedService implements UnattendedHooks {
	readonly questions: QuestionStore;
	private readonly store: UnattendedStore;
	private readonly fallback: string;

	constructor(private readonly dataDir: string) {
		this.store = new UnattendedStore(dataDir);
		this.questions = new QuestionStore(dataDir);
		this.fallback = join(dataDir, "unattended", "live");
	}

	get extension(): string {
		return unattendedPaths(this.dataDir).extension;
	}

	ensure(): boolean {
		try {
			installUnattendedExtension(this.dataDir);
			return true;
		} catch (e) {
			console.warn(`omp-webui: could not set up unattended mode for a conversation: ${(e as Error).message}`);
			return false;
		}
	}

	fileFor(liveId: string, overlay: string | null): string {
		return overlay ? `${overlay}${UNATTENDED_SUFFIX}` : join(this.fallback, `${liveId}${UNATTENDED_SUFFIX}`);
	}

	write(file: string, text: string | null): void {
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

	instruction(): string {
		return this.store.instruction();
	}

	/**
	 * What the conversation in `session` (its session file; null while omp has named none) is told: the instruction, and
	 * under it the questions it filed that still wait (#694), newest first. `answering`: a question whose answer is being
	 * sent; the turn the answer starts must not be told it still waits.
	 */
	textFor(session: string | null, answering?: string): string {
		const base = this.instruction();
		if (!session) return base;
		const waiting = this.questions
			.list()
			.questions.filter((q) => q.state === "open" && q.session === session && q.id !== answering);
		const block = waitingQuestionsBlock(waiting);
		return block ? `${base}\n\n${block}` : base;
	}

	isOn(key: string): boolean {
		return this.store.isOn(key);
	}

	setOn(key: string, on: boolean): void {
		this.store.setOn(key, on);
	}

	carry(from: string, to: string): void {
		this.store.carry(from, to);
	}

	/** The instruction as the page shows it. */
	settings(): UnattendedSettings {
		return this.store.settings();
	}

	/** Set the instruction (null: the shipped text again). Throws `InstructionError` for what it refuses. */
	setInstruction(text: string | null): UnattendedSettings {
		return this.store.setInstruction(text);
	}
}
