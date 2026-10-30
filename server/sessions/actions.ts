import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../config.ts";
import { type LivePool, refusal } from "../live.ts";
import { hasCommand } from "../omp/loaded.ts";
import { availableModels } from "../omp/models.ts";
import { RpcClient } from "../omp/rpc-client.ts";
import { withTimeout } from "../omp/run.ts";
import { leaseHolders } from "./lease.ts";

/** The conversation is working, waiting for an answer or paused: omp would refuse to delete it, and ending it to try would cut it off. */
export class SessionBusyError extends Error {}

/** Another omp process has the conversation open for writing (a terminal's): renaming or deleting it from here would go wrong under it. */
export class SessionOpenElsewhereError extends Error {}

/** A conversation as the actions on it need it. */
export interface SessionTarget {
	file: string;
	/** The session id (the one in its header), which names its write lease. */
	id: string;
	/** Where an omp is run for it. */
	cwd: string;
}

/** How long omp is given to remove the files after it has answered `/session delete`. */
const DELETE_SETTLE_MS = 3000;

/** An omp started for a rename or a delete says it is ready within this, or is killed (#319). */
const START_MS = 60_000;

/**
 * Session management done by omp itself: renames and deletes go through an
 * omp process (the session's live one, or a short-lived one), never by
 * editing omp's files directly.
 */
export class SessionActions {
	constructor(
		private readonly cfg: Config,
		private readonly pool: LivePool,
		/** How long a short-lived omp gets to say it is ready. */
		private readonly startMs = START_MS,
		/**
		 * The flags an omp must be started with for the conversation in `file`: a profile's conversation runs with its
		 * own profile (its auth, settings and images are there), a `--session-dir` one with the directory it is kept in.
		 */
		private readonly flagsFor: (file: string) => string[] = () => [],
	) {}

	/**
	 * Run `fn` against an omp process bound to `file`: the session's live process,
	 * or a short-lived one. `after` decides how that process ends.
	 */
	private async withSession<T>(
		file: string,
		cwd: string,
		fn: (c: RpcClient) => Promise<T>,
		after: "keep" | "kill" = "keep",
	): Promise<T> {
		const live = this.pool.list().find((l) => !l.exited && l.sessionFile === file);
		const existing = live ? this.pool.get(live.liveId) : undefined;
		if (existing) {
			// One still starting is not ready for commands yet. A paused (frozen) process is run for this only, and
			// frozen again after: renaming a conversation must not end its pause.
			await existing.client.ready;
			const out = await existing.whileRunning(() => fn(existing.client));
			if (after === "kill") existing.client.proc.kill("SIGKILL");
			return out;
		}
		return this.spawned(["--resume", file, ...this.flagsFor(file)], cwd, fn, after);
	}

	/**
	 * Run `fn` against a short-lived omp started with `args`, which `after` ends: killed outright, or closed (it drains
	 * and exits). For a conversation, `args` resume it with what it was started with that matters to `fn` (see `flagsFor`).
	 */
	private async spawned<T>(
		args: string[],
		cwd: string,
		fn: (c: RpcClient) => Promise<T>,
		after: "keep" | "kill",
	): Promise<T> {
		const open = (extra: string[]) =>
			new RpcClient({
				bin: this.cfg.ompBin,
				args: [...args, ...extra],
				cwd: existsSync(cwd) ? cwd : this.cfg.sessionsDir,
				onFrame: () => {},
				onExit: () => {},
			});
		// An omp that does not say it is ready is killed, not waited for for ever (the request would wait with it).
		const started = async (c: RpcClient): Promise<void> => {
			try {
				await withTimeout(c.ready, this.startMs, "omp did not start in time");
			} catch (e) {
				c.kill("SIGKILL");
				throw e;
			}
		};
		let client = open([]);
		try {
			await started(client);
		} catch (e) {
			// The saved model may not be restorable here; any available model will do for metadata work.
			if (!/Could not restore model/i.test((e as Error).message)) throw e;
			const models = (await availableModels(this.cfg.ompBin)) as { provider: string; id: string }[];
			if (!models[0]) throw e;
			client = open(["--model", `${models[0].provider}/${models[0].id}`]);
			await started(client);
		}
		try {
			return await fn(client);
		} finally {
			if (after === "kill") client.proc.kill("SIGKILL");
			else client.close();
		}
	}

	/**
	 * omp's `/pin <session id>`, which toggles the pin of that session (`<agent dir>/session-pins.json`, the list omp's
	 * resume picker puts first; see `SessionPins`). Run by a short-lived omp of its own on a new session in the directory
	 * the conversation is kept in, where `/pin` looks the id up; a new session is not written before its first message,
	 * and `/pin` adds none. (`--no-session` would also leave `--session-dir` unread, and with it any conversation kept
	 * outside omp's own sessions dir.) It never resumes the conversation: an omp resumed on it may write on starting (a
	 * note that no eval kernel was restored, when the history used eval), and while another process holds the
	 * conversation's write claim (its process here, or a terminal's) omp saves that write to a fresh sibling file, which
	 * `/pin` then pins instead (#686). The server's agent dir, and none of the flags the conversation was started with: a
	 * `--profile` would point omp at the profile's own `session-pins.json`, which the sidebar does not read. Killed once
	 * omp has answered, which is after it has written the file.
	 */
	async togglePin(target: SessionTarget): Promise<void> {
		await this.spawned(
			["--session-dir", dirname(target.file)],
			target.cwd,
			async (c) => {
				// A line omp does not know goes to the model as a prompt: look for the command first.
				const catalog = await c.call<{ commands?: unknown }>({ type: "get_available_commands" }, 30_000);
				if (!hasCommand(catalog?.commands, "pin")) throw new Error("This omp has no /pin command");
				const r = await c.call<{ agentInvoked?: boolean }>({ type: "prompt", message: `/pin ${target.id}` }, 30_000);
				if (r?.agentInvoked) throw new Error("omp did not treat /pin as a command");
			},
			"kill",
		);
	}

	/**
	 * Whether another omp process (a terminal's: the server's own are known) holds the write lease of the conversation: the
	 * short-lived omp that would rename it would save the new name to a copy of the conversation (omp moves a process that
	 * cannot take the lease to a fresh sibling file), and the one that would delete it would remove the file under the
	 * process that owns it. `ours` is the server's own process on the conversation, which may hold the lease itself.
	 */
	private async refuseWhenHeldElsewhere(target: SessionTarget, what: string): Promise<void> {
		const live = this.pool.list().find((l) => !l.exited && l.sessionFile === target.file);
		const ours = live ? (this.pool.get(live.liveId)?.client.pid ?? null) : null;
		const others = (await leaseHolders(target.id)).filter((pid) => pid !== ours);
		if (others.length)
			throw new SessionOpenElsewhereError(
				`This conversation is open for writing in another omp process (${others.join(", ")}), most likely a terminal: ${what}`,
			);
	}

	async rename(target: SessionTarget, title: string): Promise<void> {
		await this.refuseWhenHeldElsewhere(
			target,
			"renaming it here would save the new name to a copy of it. Rename it there, or close that omp first.",
		);
		await this.withSession(target.file, target.cwd, (c) => c.call({ type: "set_session_name", name: title }, 30_000));
	}

	/**
	 * omp's `/session delete`: removes the transcript and its artifacts. Refused up front while the conversation's
	 * process is busy (omp does not delete a session that is streaming, and would still answer as if it had), and
	 * while another omp process has it open for writing (omp deletes it all the same, under that process). A
	 * graceful shutdown afterwards would record a `session_exit` and recreate the file, so the process that performed
	 * the delete is killed outright (it has no other work) — but only once the file is gone: a delete omp did not
	 * carry out leaves a conversation that runs running.
	 */
	async delete(target: SessionTarget): Promise<void> {
		const { file, cwd } = target;
		const holding = this.pool.list().find((l) => !l.exited && l.sessionFile === file)?.holding;
		if (holding) throw new SessionBusyError(refusal(holding));
		await this.refuseWhenHeldElsewhere(
			target,
			"deleting it here would remove the file under that process. Close that omp first.",
		);
		await this.withSession(
			file,
			cwd,
			async (c) => {
				const r = await c.call<{ agentInvoked?: boolean }>({ type: "prompt", message: "/session delete" }, 30_000);
				if (r?.agentInvoked) throw new Error("omp did not treat /session delete as a command");
				for (let waited = 0; existsSync(file); waited += 50) {
					if (waited >= DELETE_SETTLE_MS) throw new Error("omp did not delete the session");
					await Bun.sleep(50);
				}
			},
			"kill",
		);
	}
}

/**
 * An ordered list preference of the web UI (favorite models, archived conversations), kept as JSON in its own data
 * dir — never in omp's files. Newest additions come first. A list is replaced as a whole file (written beside it and
 * renamed over it), so a crash or a kill never leaves half of it; a file that is nevertheless cut off or no list is
 * kept as `<name>.json.damaged` instead of being read as an empty list that the next change would write over. What is
 * not a regular file there (a pipe, a device, a folder) is an error and is never opened: reading is synchronous, and a
 * pipe nobody writes to would stop the whole server.
 */
export class ListPref {
	private readonly file: string;
	private readonly listeners = new Set<(list: string[]) => void>();
	constructor(dataDir: string, name: string) {
		this.file = join(dataDir, `${name}.json`);
	}
	/** Called with the new list whenever `set` changes it (a change made by any page: the others are told). */
	onChange(listener: (list: string[]) => void): void {
		this.listeners.add(listener);
	}
	list(): string[] {
		const info = statSync(this.file, { throwIfNoEntry: false });
		if (!info) return [];
		if (!info.isFile()) throw new Error(`${this.file} is not a file`);
		let text: string;
		try {
			text = readFileSync(this.file, "utf8");
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw e;
		}
		let v: unknown;
		try {
			v = JSON.parse(text);
		} catch {
			v = null;
		}
		if (!Array.isArray(v)) {
			const aside = `${this.file}.damaged`;
			renameSync(this.file, aside);
			console.warn(`omp-webui: ${this.file} is not a list (cut off?); it was moved to ${aside}`);
			return [];
		}
		return v.filter((x): x is string => typeof x === "string");
	}
	/** Add or remove each item; returns the new list. */
	set(items: string[], on: boolean): string[] {
		const drop = new Set(items);
		const before = this.list();
		const next = before.filter((f) => !drop.has(f));
		if (on) next.unshift(...items);
		const tmp = `${this.file}.${process.pid}.tmp`;
		try {
			writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
			renameSync(tmp, this.file);
		} catch (e) {
			rmSync(tmp, { force: true });
			throw e;
		}
		if (next.length !== before.length || next.some((f, i) => f !== before[i]))
			for (const listener of this.listeners) listener(next);
		return next;
	}
}
