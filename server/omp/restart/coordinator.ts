import { readFileSync } from "node:fs";
import { CodedError } from "../../../shared/error-info.ts";
import type { ExitReason } from "../../../shared/exit.ts";
import type { OmpFrame } from "../../../shared/protocol.ts";
import {
	RESTART_TOOL,
	RESTART_TURN_END_MS,
	type RestartRefusal,
	refusalMessage,
	restartArgsOf,
	restartMessage,
} from "../../../shared/restart.ts";
import type { Live, LivePool } from "../../live.ts";
import type { RestartService } from "./install.ts";
import type { RestartRequest } from "./store.ts";

/**
 * The server's side of `restart_session` (`shared/restart.ts`): it turns the agent's call into a restart of the
 * conversation's omp, and the person's Force restart into the same.
 *
 * 1. The call ends without an error (`toolEnded`): a request is written down (`RestartStore`), every page is told that one
 *    waits (`LiveInfo.restartPending`), and the process's limit file is brought up to date. A call over the limit is refused
 *    at once (the extension refuses it already when its file is current).
 * 2. The main agent's turn ends (`turnEnded`), or `turnEndMs` after the call, which aborts the turn: the restart is made
 *    unless something the person would miss would be cut off (`refusal`). A refusal is told to the agent as a message.
 * 3. The process is ended with everything it started (`Live.endTree`), the session file is resumed in a new process in the
 *    mode it had, and the agent's `continue_with` is sent to it, unless the session file holds the request's id already.
 *
 * Each step is written down before it is taken, so a server that stops in the middle finishes the restart when it starts
 * again (`recover`). Delivery is at least once: a server that stops after omp took the message and before omp wrote it to
 * its session file sends it again. That window is small (omp writes the message as it takes it), and the message says
 * that doing it twice must be harmless.
 */

/** What the coordinator uses of the pool. */
export type RestartPool = Pick<LivePool, "get" | "open" | "announce" | "liveOfFile">;

/** How long each step is given. */
export interface RestartTimings {
	/** For the turn that asked to end by itself before it is aborted. */
	turnEndMs: number;
	/** For a turn that is aborted to say it ended before the process is ended anyway. */
	abortMs: number;
	/** For omp to end on its closed stdin, then on SIGTERM, then on SIGKILL. */
	closeMs: number;
	termMs: number;
	killMs: number;
	/** Between the attempts to start the conversation again. */
	reopenMs: readonly number[];
}

export const RESTART_TIMINGS: RestartTimings = {
	turnEndMs: RESTART_TURN_END_MS,
	abortMs: 5_000,
	closeMs: 1_500,
	termMs: 1_500,
	killMs: 3_000,
	reopenMs: [1_000, 3_000],
};

/** Whether the session file `file` holds the request `id` (its message was taken by omp already). */
function sessionHolds(file: string, id: string): boolean {
	try {
		return readFileSync(file, "utf8").includes(id);
	} catch {
		return false;
	}
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class RestartCoordinator {
	/** The arguments of the calls under way, by process and call id (`tool_execution_end` does not carry them). */
	private readonly calls = new Map<string, unknown>();
	/** The timers that abort a turn that did not end, by process. */
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	/** The processes being restarted now: a second trigger joins nothing and is ignored. */
	private readonly busy = new Set<string>();
	/** Refusals owed to a paused conversation's agent, told when it runs again: request id by process. */
	private readonly owed = new Map<string, string>();
	timings: RestartTimings = RESTART_TIMINGS;

	constructor(
		readonly service: RestartService,
		private readonly pool: RestartPool,
	) {}

	private get store() {
		return this.service.store;
	}

	/** The file the process `liveId` reads its limit from, written now for the conversation in `session`. */
	limitFile(liveId: string, session: string | null): string {
		const file = this.service.fileFor(liveId);
		this.writeLimit(file, session);
		return file;
	}

	private writeLimit(file: string, session: string | null): void {
		try {
			this.service.writeLimit(file, session ? this.store.blockedUntil(session) : null);
		} catch (e) {
			console.warn(`omp-webui: could not write the restart limit ${file}: ${errorText(e)}`);
		}
	}

	/** A tool call began: the restart tool's arguments are kept until it ends. */
	toolStarted(live: Live, frame: OmpFrame): void {
		if (frame.toolName !== RESTART_TOOL) return;
		this.calls.set(`${live.info.liveId}:${String(frame.toolCallId)}`, frame.args);
	}

	/** A tool call ended: a restart call that did not fail is a request. */
	toolEnded(live: Live, frame: OmpFrame): void {
		if (frame.toolName !== RESTART_TOOL) return;
		const key = `${live.info.liveId}:${String(frame.toolCallId)}`;
		const raw = this.calls.get(key);
		this.calls.delete(key);
		if (frame.isError === true) return;
		const args = restartArgsOf(raw);
		if (!args) {
			console.warn(`omp-webui: ${live.info.liveId} called ${RESTART_TOOL} without a reason or continue_with`);
			return;
		}
		const session = live.info.sessionFile;
		const liveId = live.info.liveId;
		if (!session) {
			void this.tell(live, null, "noSession", args.reason);
			return;
		}
		const waiting = this.store.waiting(liveId);
		let record: RestartRequest;
		try {
			const blocked = this.store.blockedUntil(session, waiting?.id);
			if (blocked !== null) {
				record = this.store.create({
					by: "agent",
					liveId,
					session,
					cwd: live.info.cwd,
					mode: live.info.mode,
					reason: args.reason,
					continueWith: args.continueWith,
					force: args.force,
					state: "refused",
					refusal: "rateLimit",
				});
				void this.tell(live, record, "rateLimit", args.reason);
				return;
			}
			// A second call in the same turn says it again: the newest words are the ones sent.
			record = waiting
				? this.store.patch(waiting.id, args)
				: this.store.create({
						by: "agent",
						liveId,
						session,
						cwd: live.info.cwd,
						mode: live.info.mode,
						...args,
						state: "requested",
					});
		} catch (e) {
			console.error(`omp-webui: could not write down the restart ${liveId} asked for: ${errorText(e)}`);
			return;
		}
		this.writeLimit(this.service.fileFor(liveId), session);
		live.info.restartPending = { reason: record.reason, at: record.requestedAt };
		delete live.info.restartFailed;
		this.pool.announce(live);
		this.arm(liveId, this.timings.turnEndMs);
	}

	/** Abort the turn of `liveId` and make its restart after `ms`, if it is still waiting then. */
	private arm(liveId: string, ms: number): void {
		if (this.timers.has(liveId)) return;
		const timer = setTimeout(
			() => {
				this.timers.delete(liveId);
				const live = this.pool.get(liveId);
				const record = this.store.waiting(liveId);
				if (live && record && !live.info.exited) void this.trigger(live, record, true);
			},
			Math.max(0, ms),
		);
		timer.unref?.();
		this.timers.set(liveId, timer);
	}

	private disarm(liveId: string): void {
		clearTimeout(this.timers.get(liveId));
		this.timers.delete(liveId);
	}

	/** The main agent's turn has ended (`agent_end`, the last of the turn): a restart that waited for it is made now. */
	turnEnded(live: Live): void {
		const record = this.store.waiting(live.info.liveId);
		if (record) void this.trigger(live, record, false);
	}

	/** Make the restart `record` asked for, unless something would be cut off; `late`: the turn did not end in time. */
	private async trigger(live: Live, record: RestartRequest, late: boolean): Promise<void> {
		const liveId = live.info.liveId;
		if (this.busy.has(liveId)) return;
		this.busy.add(liveId);
		this.disarm(liveId);
		try {
			const why = await this.refusal(live, record);
			if (why) {
				this.store.move(record.id, "refused", { refusal: why });
				delete live.info.restartPending;
				this.pool.announce(live);
				await this.tell(live, this.store.get(record.id) ?? record, why, record.reason);
				return;
			}
			if (late) await live.abortTurn(this.timings.abortMs);
			await this.perform(live, record);
		} catch (e) {
			console.error(`omp-webui: the restart ${liveId} asked for failed: ${errorText(e)}`);
		} finally {
			this.busy.delete(liveId);
		}
	}

	/** Why the restart cannot be made now, or null when it can. */
	private async refusal(live: Live, record: RestartRequest): Promise<RestartRefusal | null> {
		if (live.info.pausedAt !== null) return "paused";
		if (live.waitsForPerson) return "asking";
		if (record.force) return null;
		const working = await live.workingSubagents();
		if (working === null) return "subagentsUnknown";
		return working > 0 ? "subagents" : null;
	}

	/**
	 * Tell the agent its restart was refused, as a message in the conversation (queued behind a turn that runs). A paused
	 * conversation is told when it runs again (`resumed`), and every page shows the refusal meanwhile.
	 */
	private async tell(live: Live, record: RestartRequest | null, why: RestartRefusal, reason: string): Promise<void> {
		const liveId = live.info.liveId;
		if (live.info.pausedAt !== null && record) {
			live.info.restartRefused = { why, reason, at: Date.now() };
			this.pool.announce(live);
			this.owed.set(liveId, record.id);
			return;
		}
		const id = record?.id ?? `r-${"0".repeat(16)}`;
		try {
			const sent = await live.rpc({
				type: "prompt",
				message: refusalMessage(id, why, reason),
				...(live.info.streaming ? { streamingBehavior: "followUp" } : {}),
			});
			if (!sent.success) throw new Error(sent.error ?? "omp did not take the message");
			if (record) this.store.patch(record.id, { notified: true });
		} catch (e) {
			console.error(`omp-webui: could not tell ${liveId} that its restart was refused: ${errorText(e)}`);
		}
	}

	/** A paused conversation runs again: a refusal it was owed is told now. */
	resumed(live: Live): void {
		const liveId = live.info.liveId;
		const id = this.owed.get(liveId);
		if (!id) return;
		this.owed.delete(liveId);
		const record = this.store.get(id);
		delete live.info.restartRefused;
		this.pool.announce(live);
		if (record?.refusal) void this.tell(live, record, record.refusal, record.reason);
	}

	/** End `live` and go on with the conversation in a new process; returns that process. Throws when it cannot be made. */
	private async perform(live: Live, record: RestartRequest): Promise<Live> {
		const why: ExitReason = record.by === "agent" ? "agentRestart" : "forceRestart";
		this.store.move(record.id, "restarting");
		delete live.info.restartPending;
		this.pool.announce(live);
		try {
			await live.endTree(why, this.timings);
		} catch (e) {
			const message = `omp did not end: ${errorText(e)}`;
			this.store.move(record.id, "failed", { error: message });
			if (!live.info.exited) {
				live.info.restartFailed = { message, at: Date.now() };
				this.pool.announce(live);
			}
			throw new Error(message);
		}
		return this.resumeAndDeliver(this.store.get(record.id) ?? record);
	}

	/** The old process is gone: start the conversation again and send it what the agent asked for. */
	private async resumeAndDeliver(record: RestartRequest): Promise<Live> {
		let live: Live;
		try {
			live = await this.reopen(record);
		} catch (e) {
			const message = `the conversation could not be started again: ${errorText(e)}`;
			this.store.move(record.id, "failed", { error: message });
			throw new Error(message);
		}
		const resumed =
			record.state === "restarting"
				? this.store.move(record.id, "resumed", { newLiveId: live.info.liveId })
				: this.store.patch(record.id, { newLiveId: live.info.liveId });
		if (resumed.by === "user") {
			live.info.restarted = { by: "user", at: Date.now() };
			this.pool.announce(live);
		}
		await this.deliver(live, resumed);
		return live;
	}

	/** The process that runs the conversation of `record` now: one that does already, else one started for it. */
	private async reopen(record: RestartRequest): Promise<Live> {
		let last: unknown;
		for (let attempt = 0; attempt <= this.timings.reopenMs.length; attempt++) {
			const running = this.pool.liveOfFile(record.session);
			if (running && !running.client.closing) return running;
			try {
				return await this.pool.open(
					{ kind: "resume", sessionFile: record.session, cwd: record.cwd, mode: record.mode },
					() => Promise.resolve(record.cwd),
				);
			} catch (e) {
				last = e;
				const wait = this.timings.reopenMs[attempt];
				if (wait === undefined) break;
				await Bun.sleep(wait);
			}
		}
		throw last;
	}

	/** Send `continue_with`, unless there is none or omp has it already (its session file holds the request's id). */
	private async deliver(live: Live, record: RestartRequest): Promise<void> {
		if (record.continueWith === null || sessionHolds(record.session, record.id)) {
			this.store.move(record.id, "delivered");
			return;
		}
		try {
			const sent = await live.rpc({
				type: "prompt",
				message: restartMessage(record.id, record.reason, record.continueWith),
				...(live.info.streaming ? { streamingBehavior: "followUp" } : {}),
			});
			if (!sent.success) throw new Error(sent.error ?? "omp did not take the message");
			this.store.move(record.id, "delivered");
		} catch (e) {
			const message = `the message could not be sent to the new process: ${errorText(e)}`;
			this.store.move(record.id, "failed", { error: message });
			throw new Error(message);
		}
	}

	/**
	 * A process ended. Its limit file goes. A restart that waited for its turn is made from here when omp ended on its own (a
	 * crash: the conversation is started again, as asked); one ended by the person or the server is not.
	 */
	exited(live: Live, endedBy: ExitReason | null): void {
		const liveId = live.info.liveId;
		this.disarm(liveId);
		this.owed.delete(liveId);
		for (const key of this.calls.keys()) if (key.startsWith(`${liveId}:`)) this.calls.delete(key);
		this.service.removeLimit(this.service.fileFor(liveId));
		if (this.busy.has(liveId)) return;
		const record = this.store.waiting(liveId);
		if (!record) return;
		try {
			if (endedBy !== null) {
				this.store.move(record.id, "failed", { error: `the process was ended (${endedBy}) before its turn ended` });
				return;
			}
			this.store.move(record.id, "restarting");
		} catch (e) {
			console.error(`omp-webui: could not write down the restart of ${liveId}: ${errorText(e)}`);
			return;
		}
		void this.resumeAndDeliver(this.store.get(record.id) ?? record).catch((e: unknown) =>
			console.error(`omp-webui: the restart ${liveId} asked for failed: ${errorText(e)}`),
		);
	}

	/**
	 * The person's Force restart: the turn that runs is aborted and the process restarted, whatever it is doing, on the same
	 * path as the agent's. A restart the agent asked for and that waits is the one made (its message is sent); otherwise none
	 * is. A paused conversation is refused: resume it first. Resolves to the process that runs the conversation then.
	 */
	async forceRestart(live: Live): Promise<Live> {
		const liveId = live.info.liveId;
		if (live.info.exited || live.client.closing) throw new Error("This conversation is not running");
		if (this.busy.has(liveId)) throw new CodedError("This conversation is being restarted already.", "restartBusy");
		if (live.info.pausedAt !== null)
			throw new CodedError("This conversation is paused; resume it first.", "restartPaused");
		const session = live.info.sessionFile;
		if (!session) throw new CodedError("This conversation has no session yet; send a message first.", "restartUnsaved");
		this.busy.add(liveId);
		this.disarm(liveId);
		try {
			const waiting = this.store.waiting(liveId);
			const record = waiting
				? this.store.patch(waiting.id, { force: true })
				: this.store.create({
						by: "user",
						liveId,
						session,
						cwd: live.info.cwd,
						mode: live.info.mode,
						reason: "",
						continueWith: null,
						force: true,
						state: "requested",
					});
			if (live.info.streaming) await live.abortTurn(this.timings.abortMs);
			return await this.perform(live, record);
		} finally {
			this.busy.delete(liveId);
		}
	}

	/**
	 * The server stops: a restart that waits for its turn is not made by the next server (the person quit while the agent
	 * worked, and nothing is started on their behalf). One under way is finished by the next server (`recover`).
	 */
	stopping(): void {
		for (const liveId of [...this.timers.keys()]) this.disarm(liveId);
		for (const record of this.store.open()) {
			if (record.state !== "requested") continue;
			try {
				this.store.move(record.id, "failed", { error: "the server stopped before the turn ended" });
			} catch {
				// left for the next server
			}
		}
	}

	/**
	 * A server that starts finishes what one before it left (a crash between two steps). A request that waited for its turn:
	 * made when its process is still here (one the server took over), at its turn's end or when its time is up; a process
	 * that is gone (its relay ended it with the server) is as good as ended. One under way: the conversation is started
	 * again, and its message sent unless the session file holds it already.
	 */
	async recover(): Promise<void> {
		for (const open of this.store.open()) {
			try {
				let record = open;
				if (record.state === "requested") {
					const live = this.pool.get(record.liveId);
					if (live && !live.info.exited && !live.client.closing) {
						live.info.restartPending = { reason: record.reason, at: record.requestedAt };
						this.pool.announce(live);
						if (live.info.streaming) this.arm(record.liveId, record.requestedAt + this.timings.turnEndMs - Date.now());
						else void this.trigger(live, record, false);
						continue;
					}
					record = this.store.move(record.id, "restarting");
				}
				await this.resumeAndDeliver(record);
			} catch (e) {
				console.error(`omp-webui: could not finish the restart ${open.id}: ${errorText(e)}`);
			}
		}
	}
}
