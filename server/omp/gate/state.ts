import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { GuardConfig, GuardWord } from "../../../shared/guard.ts";
import type { GuardRules } from "../../../shared/guard-policy.ts";
import { RISK_LOADED_SUFFIX, RISK_SUFFIX } from "../../../shared/risk-confirm.ts";

/**
 * The server's word to one process's gate: whether "Confirm risky commands" is armed (the setting is on and the turn is
 * remote-driven; see `Live.syncRisk`), the places the gate treats as protected besides the built-in ones, and what the
 * guard does (`guard`, see `shared/guard.ts`), the ports an omp-webui may serve its API on (`ports`, so that only their
 * `/api/` is protected) and the addresses this server answers on besides the loopback (`hosts`, `OMP_WEBUI_HOST`: the
 * same API, reached on that address). Written whole and moved into place, and only when it changes: omp reads it before
 * each tool call, and never half of it. A file that is gone or no longer says what the server wrote (an agent that
 * changed it, a cleaner of the temp dir) is written again, so that what the gate reads is the server's word and nobody's
 * else: each look compares the file's content, not its size or time, which an agent that overwrote it could put back.
 */
export class RiskState {
	/** The server's word to the gate (`<overlay>.risk`). */
	readonly file: string;
	/** The note the gate leaves when it has started in the process (`<overlay>.risk.loaded`, see `RISK_LOADED_SUFFIX`). */
	readonly loadedFile: string;
	/** What was last written. */
	private written: string | null = null;
	private seenLoaded: boolean;

	constructor(
		overlayFile: string,
		/** The app's data folder, omp's agent folder, the folder of the overlays: nothing in them is changed unasked. */
		private readonly protect: readonly string[],
		/**
		 * The gate had been seen to start when an earlier server wrote this conversation down (`ParkedRecord.gated`): a
		 * process this server takes over keeps that fact, whatever became of its note (a cleaner of the temp folder).
		 */
		seen = false,
	) {
		this.file = `${overlayFile}${RISK_SUFFIX}`;
		this.loadedFile = `${overlayFile}${RISK_LOADED_SUFFIX}`;
		this.seenLoaded = seen;
	}

	/**
	 * Whether the process's gate said it started: the extension was read and ran, not just named on the command line. Once
	 * seen it stays so: the gate does not unload because a cleaner of the temp folder took its note, and a long-lived
	 * conversation must not be refused for that. (A Live is one process with its own overlay, so the note is never an old one's.)
	 */
	get loaded(): boolean {
		if (!this.seenLoaded) this.seenLoaded = existsSync(this.loadedFile);
		return this.seenLoaded;
	}

	/**
	 * Whether the file says `text` now. Looked at before it is read: whatever sits at the path that is not a regular file of
	 * that size (a pipe that would block the server's one thread, a device, a huge file) is not the word and is not read.
	 */
	private says(text: string): boolean {
		try {
			const stat = statSync(this.file);
			if (!stat.isFile() || stat.size !== Buffer.byteLength(text)) return false;
			return readFileSync(this.file, "utf8") === text;
		} catch {
			return false;
		}
	}

	/** Throws when the word cannot be written: the caller must not let a remote message through then. */
	set(armed: boolean, guard?: GuardWord, ports?: readonly number[], hosts?: readonly string[]): void {
		const text = JSON.stringify({
			armed,
			protect: this.protect,
			...(guard ? { guard } : {}),
			...(ports && ports.length > 0 ? { ports } : {}),
			...(hosts && hosts.length > 0 ? { hosts } : {}),
		});
		// Written again when it is not as it was left: gone (a cleaner of the temp dir) or changed behind the server's back.
		if (this.written === text && this.says(text)) return;
		// The folder may be gone too: omp still reads the file where it was told to.
		mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
		const tmp = `${this.file}.tmp`;
		try {
			// Exclusive: a pipe put at the path of the new file would block the write for ever.
			writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
			rmSync(tmp, { force: true });
			writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
		}
		renameSync(tmp, this.file);
		this.written = text;
	}
}

/** What the guard needs of the app, for the word it tells each process (see `LivePool.gate`). */
export interface GuardHooks {
	/** The settings in force now. */
	config(): GuardConfig;
	/** The file the gate appends its decisions to. */
	log: string;
	/** What the person tuned (the reviewer's rules, the threshold of each category): told to every gate with the rest. Absent: nothing is tuned. */
	rules?(): GuardRules;
	/** The app's own folders (its data folder): a call that names one is refused, whoever would approve it. */
	own: readonly string[];
	/**
	 * Whether the macOS app, with no page open on the conversation, will tell the person that a conversation asks: it is
	 * reading the server's events and notifications are on (`ShellEvents.reaches`). Absent: only an open page counts.
	 */
	reachable?(): boolean;
}

/** What the pool needs of the gate (`LivePool.setGate`). */
export interface RiskGate {
	/** The extension omp is started with (`--extension`). */
	extension: string;
	/** The places the gate treats as protected besides the built-in ones. */
	protect: readonly string[];
	/** Whether "Confirm risky commands from remote pages" is on now. */
	confirm(): boolean;
	/**
	 * The ports an omp-webui may serve its API on, once the server has bound its own (see `apiPorts`): the gate protects
	 * the `/api/` of these and no other loopback port's.
	 */
	ports?(): readonly number[] | undefined;
	/**
	 * The addresses this server answers on besides the loopback (`OMP_WEBUI_HOST`, when it is one address or name of a
	 * network: see `boundHosts`): the gate protects their `/api/` as it does the loopback's. Absent, or empty, where the
	 * server is bound to the loopback or to every address.
	 */
	hosts?(): readonly string[] | undefined;
	/** "Guard dangerous commands": absent where the app has none (the gate then asks as #608 does and nothing more). */
	guard?: GuardHooks;
	/**
	 * Make sure the gate's files are as the server has them, before a process is started with them: files deleted or
	 * changed since the server started are written again. False when they cannot be: that process starts without the gate.
	 */
	ensure(): boolean;
}

/**
 * The time omp gives the gate's `tool_call` handler in a process that has it, in ms (the overlay says so, see
 * `ProcessOverlay`). A reviewer model is asked inside it (`review.ts` stays well under it), and omp's own 30 s would leave
 * one slow model no room for the next of the chain. A handler that outlasts it still fails closed: omp refuses the call.
 */
export const GATE_HANDLER_MS = 120_000;
