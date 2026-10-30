import { existsSync, type FSWatcher, readFileSync, rmSync, watch } from "node:fs";
import { join } from "node:path";
import { burst } from "../burst.ts";
import { ListPref, type SessionTarget } from "./actions.ts";
import type { SessionStore } from "./store.ts";

/**
 * omp's own list of pinned sessions: `<agent dir>/session-pins.json`, the session ids that its resume picker puts first
 * (`/pin` toggles one, from the terminal or from the composer). The sidebar's pins are this list, so a pin made on either
 * side shows on the other. It is read here, never written: a change is omp's own `/pin` (`SessionActions.togglePin`), which
 * keeps omp's lock and format.
 */
const FILE = "session-pins.json";

/** What the file's changes are held for before they are announced: a write is often a few events (a rename, a touch). */
const QUIET_MS = 100;
const MAX_WAIT_MS = 500;

/** What `SessionPins` needs of the session store. */
type Sessions = Pick<SessionStore, "get" | "list">;
/** What it needs of the session actions. */
interface Toggle {
	togglePin(target: SessionTarget): Promise<void>;
}

export class SessionPins {
	private readonly file: string;
	private readonly listeners = new Set<() => void>();
	private watcher: FSWatcher | null = null;
	/** Changes are made one after another: two toggles of one session would otherwise both see the old state. */
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly agentDir: string,
		private readonly dataDir: string,
		private readonly sessions: Sessions,
		private readonly actions: Toggle,
	) {
		this.file = join(agentDir, FILE);
		this.watch();
	}

	/** `fn` runs when omp's pin list changes (anywhere: this server, a conversation's process, a terminal). */
	onChange(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private watch(): void {
		if (!existsSync(this.agentDir)) return;
		const changed = burst(
			() => {
				for (const fn of this.listeners) fn();
			},
			QUIET_MS,
			MAX_WAIT_MS,
		);
		try {
			// The directory, not the file: omp may replace the file, and one that does not exist yet is created in it.
			this.watcher = watch(this.agentDir, { persistent: false }, (_event, name) => {
				if (name === FILE) changed();
			});
		} catch {
			// Without a watcher the pins are read again whenever the page asks for them (every list change).
		}
	}

	close(): void {
		this.watcher?.close();
	}

	/** The ids in the file, in omp's order (the oldest pin first); null when it is there but is no list of ids. */
	private read(): string[] | null {
		let text: string;
		try {
			text = readFileSync(this.file, "utf8");
		} catch (e) {
			return (e as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
		}
		try {
			const v: unknown = JSON.parse(text);
			return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
		} catch {
			return null;
		}
	}

	/** The session files that are pinned, the newest pin first. A pin of a session that is gone is not listed. */
	async list(): Promise<string[]> {
		const ids = this.read();
		if (!ids?.length) return [];
		const byId = new Map<string, string>();
		for (const s of await this.sessions.list()) byId.set(s.id, s.file);
		return ids.toReversed().flatMap((id) => byId.get(id) ?? []);
	}

	/** Pin or unpin `file`, as omp does; returns the pinned files. */
	set(file: string, on: boolean): Promise<string[]> {
		const run = this.queue.then(() => this.apply(file, on));
		this.queue = run.catch(() => {});
		return run.then(() => this.list());
	}

	private async apply(file: string, on: boolean): Promise<void> {
		const session = await this.sessions.get(file);
		if (!session) throw new Error("Unknown session file");
		const before = this.read();
		// What is there is not a list of ids (omp may be in the middle of writing it): not a state to toggle from.
		if (before === null) throw new Error(`omp's ${FILE} cannot be read; the pin was not changed`);
		if (before.includes(session.id) === on) return;
		await this.actions.togglePin({ file, id: session.id, cwd: session.cwd });
		if (this.read()?.includes(session.id) !== on)
			throw new Error(`omp did not ${on ? "pin" : "unpin"} the conversation`);
	}

	/**
	 * Pins that earlier versions kept in this server's data dir (`pins.json`, by file) go into omp's list, oldest first, and
	 * the old file is removed. One that cannot be moved now (omp is not installed, the list is being written) stays for the
	 * next start.
	 */
	async adoptLegacy(): Promise<void> {
		const legacy = new ListPref(this.dataDir, "pins");
		const files = legacy.list();
		if (files.length) {
			const byFile = new Map<string, string>();
			for (const s of await this.sessions.list()) byFile.set(s.file, s.id);
			for (const file of files.toReversed()) {
				if (byFile.has(file)) await this.set(file, true);
			}
		}
		rmSync(join(this.dataDir, "pins.json"), { force: true });
	}
}
