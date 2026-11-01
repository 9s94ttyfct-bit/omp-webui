import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../../shared/guards.ts";
import { isMode, type Mode } from "../../../shared/offline.ts";
import {
	RESTART_ID,
	RESTART_MAX,
	RESTART_REFUSALS,
	RESTART_WINDOW_MS,
	type RestartBy,
	type RestartRefusal,
} from "../../../shared/restart.ts";

/**
 * The restarts asked for (`shared/restart.ts`), one record each, kept in `<data dir>/restart/requests/<id>.json` so that a
 * server that stops in the middle of one (a crash, a quit) finds it and finishes it when it starts again (see
 * `RestartCoordinator.recover`), and so that the limit of `RESTART_MAX` an hour holds across a server's restart.
 *
 * A record moves through its states in one direction only (`NEXT`):
 *
 * - `requested`: the agent called the tool; the server waits for its turn to end (the person's Force restart skips it).
 * - `restarting`: the old process is being ended.
 * - `resumed`: the conversation runs in the new process (`newLiveId`); `continueWith`, when there is one, is still to be sent.
 * - `delivered`: done (the message was sent, or found in the session file, or there was none).
 * - `refused`: not made (`refusal` says why); `notified` once the agent was told.
 * - `failed`: could not be made (`error`): the old process did not end, or the conversation could not be started again.
 *
 * Settled records are kept for a day, for the limit and for whoever looks into what happened, then dropped.
 */

export type RestartState = "requested" | "restarting" | "resumed" | "delivered" | "refused" | "failed";

export interface RestartRequest {
	version: 1;
	id: string;
	by: RestartBy;
	/** The process that asked, which is the one ended. */
	liveId: string;
	/** Its session file (as the server keys it), which the new process resumes. */
	session: string;
	/** The folder it ran in, where the new process runs. */
	cwd: string;
	/** Full or Light: the new process runs in the mode the old one had. */
	mode: Mode;
	/** The agent's reason ("" for the person's own restart). */
	reason: string;
	/** What the new process is sent; null: nothing (the person's restart, where the agent asked for none). */
	continueWith: string | null;
	/** Running subagents end with the process. */
	force: boolean;
	state: RestartState;
	refusal?: RestartRefusal;
	/** A refused request's message reached the agent. */
	notified?: boolean;
	error?: string;
	/** The process that runs the conversation after the restart. */
	newLiveId?: string;
	requestedAt: number;
	restartingAt?: number;
	resumedAt?: number;
	settledAt?: number;
}

/** Where each state may go. */
const NEXT: Readonly<Record<RestartState, readonly RestartState[]>> = {
	requested: ["restarting", "refused", "failed"],
	restarting: ["resumed", "failed"],
	resumed: ["delivered", "failed"],
	delivered: [],
	refused: [],
	failed: [],
};

/** The states a server that starts finishes (see `RestartCoordinator.recover`). */
export const OPEN_STATES: readonly RestartState[] = ["requested", "restarting", "resumed"];

const SETTLED: readonly RestartState[] = ["delivered", "refused", "failed"];

/** How long a settled record is kept. */
export const KEEP_SETTLED_MS = 24 * 60 * 60_000;

/** A move the state machine does not allow (a bug, or a record another server moved meanwhile). */
export class RestartStateError extends Error {}

const STATES = Object.keys(NEXT) as RestartState[];
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const optionalCount = (v: unknown): boolean => v === undefined || isCount(v);

/** A record as read from disk, or null when it is not one (a damaged file is left out, not the server). */
export function requestOf(v: unknown): RestartRequest | null {
	if (!isRecord(v) || v.version !== 1) return null;
	const { id, by, liveId, session, cwd, mode, reason, continueWith, force, state, refusal, error, newLiveId } = v;
	if (typeof id !== "string" || !RESTART_ID.test(id)) return null;
	if (by !== "agent" && by !== "user") return null;
	if (typeof liveId !== "string" || typeof session !== "string" || !session || typeof cwd !== "string") return null;
	if (!isMode(mode) || typeof reason !== "string" || typeof force !== "boolean") return null;
	if (continueWith !== null && typeof continueWith !== "string") return null;
	if (!STATES.includes(state as RestartState)) return null;
	if (refusal !== undefined && !RESTART_REFUSALS.includes(refusal as RestartRefusal)) return null;
	if (error !== undefined && typeof error !== "string") return null;
	if (newLiveId !== undefined && typeof newLiveId !== "string") return null;
	if (v.notified !== undefined && typeof v.notified !== "boolean") return null;
	if (!isCount(v.requestedAt) || !optionalCount(v.restartingAt) || !optionalCount(v.resumedAt)) return null;
	if (!optionalCount(v.settledAt)) return null;
	return v as unknown as RestartRequest;
}

/** A new request's id: what its messages carry (`RESTART_ID`). */
export const newRestartId = (): string => `r-${randomBytes(8).toString("hex")}`;

export class RestartStore {
	private readonly dir: string;
	private readonly records = new Map<string, RestartRequest>();

	constructor(
		dataDir: string,
		private readonly now: () => number = Date.now,
	) {
		this.dir = join(dataDir, "restart", "requests");
		let names: string[] = [];
		try {
			names = readdirSync(this.dir).filter((n) => n.endsWith(".json"));
		} catch {
			// none yet
		}
		for (const name of names) {
			let record: RestartRequest | null = null;
			try {
				record = requestOf(JSON.parse(readFileSync(join(this.dir, name), "utf8")));
			} catch {
				// unreadable: left out
			}
			if (record && name === `${record.id}.json`) this.records.set(record.id, record);
		}
		this.prune();
	}

	get(id: string): RestartRequest | undefined {
		return this.records.get(id);
	}

	/** Every record, oldest first. */
	list(): RestartRequest[] {
		return [...this.records.values()].sort((a, b) => a.requestedAt - b.requestedAt);
	}

	/** The records a server that starts has to finish. */
	open(): RestartRequest[] {
		return this.list().filter((r) => OPEN_STATES.includes(r.state));
	}

	/** The request of `liveId` that waits for its turn to end, if there is one. */
	waiting(liveId: string): RestartRequest | undefined {
		return this.list().find((r) => r.liveId === liveId && r.state === "requested");
	}

	/** Write a new request down (`requested`, or `restarting` for the person's own) and return it. Throws when it cannot be written. */
	create(fields: Omit<RestartRequest, "version" | "id" | "requestedAt">): RestartRequest {
		this.prune();
		const record: RestartRequest = { version: 1, id: newRestartId(), requestedAt: this.now(), ...fields };
		this.write(record);
		return record;
	}

	/** Change what a request says without moving it (its arguments, `notified`). */
	patch(id: string, patch: Partial<Omit<RestartRequest, "version" | "id" | "state">>): RestartRequest {
		const record = this.records.get(id);
		if (!record) throw new RestartStateError(`No restart ${id}`);
		const next = { ...record, ...patch };
		this.write(next);
		return next;
	}

	/** Move a request to `state`, with what goes with it; refused when the machine does not allow the move. */
	move(id: string, state: RestartState, patch: Partial<Omit<RestartRequest, "version" | "id" | "state">> = {}) {
		const record = this.records.get(id);
		if (!record) throw new RestartStateError(`No restart ${id}`);
		if (!NEXT[record.state].includes(state))
			throw new RestartStateError(`A restart cannot go from ${record.state} to ${state}`);
		const at = this.now();
		const stamps: Partial<RestartRequest> =
			state === "restarting" ? { restartingAt: at } : state === "resumed" ? { resumedAt: at } : { settledAt: at };
		const next: RestartRequest = { ...record, ...patch, ...stamps, state };
		this.write(next);
		return next;
	}

	/**
	 * When the agent of the conversation in `session` may ask for its next restart, or null when it may now: the restarts it
	 * asked for in the last `RESTART_WINDOW_MS` that were not refused count (`except`: one that is being asked for again).
	 */
	blockedUntil(session: string, except?: string): number | null {
		const since = this.now() - RESTART_WINDOW_MS;
		const times = this.list()
			.filter(
				(r) =>
					r.by === "agent" &&
					r.session === session &&
					r.state !== "refused" &&
					r.id !== except &&
					r.requestedAt > since,
			)
			.map((r) => r.requestedAt)
			.sort((a, b) => b - a);
		if (times.length < RESTART_MAX) return null;
		return (times[RESTART_MAX - 1] as number) + RESTART_WINDOW_MS;
	}

	private write(record: RestartRequest): void {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		const file = join(this.dir, `${record.id}.json`);
		const temporary = `${file}.${process.pid}.tmp`;
		writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
		chmodSync(temporary, 0o600);
		renameSync(temporary, file);
		this.records.set(record.id, record);
	}

	/** Drop the settled records older than `KEEP_SETTLED_MS`. */
	private prune(): void {
		const before = this.now() - KEEP_SETTLED_MS;
		for (const r of [...this.records.values()]) {
			if (!SETTLED.includes(r.state) || (r.settledAt ?? r.requestedAt) > before) continue;
			this.records.delete(r.id);
			rmSync(join(this.dir, `${r.id}.json`), { force: true });
		}
	}
}
