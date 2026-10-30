import type {
	CompactPhase,
	CompactQueued,
	CompactQueueRecord,
	CompactWhere,
	HeldPrompt,
	StepUnavailable,
} from "../../shared/compact-queue.ts";
import { COMPACT_STEP_DIALOG_TITLE } from "../../shared/compact-step.ts";
import { isRecord } from "../../shared/guards.ts";
import type { RpcResponse } from "./rpc-client.ts";

/**
 * A compact the person asked for while the agent was working (#651), held until it can be sent without losing work, and
 * the messages that were queued behind it. See `shared/compact-queue.ts` for what is held and why the follow-ups are held too.
 *
 * The order is the whole point: omp is told `compact`, and only when it has answered, and the turn the compact is made in has
 * ended, are the held messages sent, first to last. Nothing that was waiting for the turn to end reaches omp before the
 * compact does, and nothing that was waiting for the compact reaches it before the turn is over.
 *
 * omp's `compact` command ends the run it finds in progress (it aborts the model request and the tools that run) and carries
 * on after it, so a compact sent anywhere inside a step loses the work of that step. There are two points at which nothing
 * is in flight:
 *
 * - `turn`, the turn's own end (`agent_end`): the compact goes there, and the messages follow it at once.
 * - `step`, the moment between a step's tools and the next model request. No frame says where that is in time for a command
 *   to arrive first, since omp starts the next request the moment the tool results are in, so the process's extension
 *   (`server/omp/compact-step/`) holds omp there, in a dialog this queue takes (`frame`), while a compact is wanted. What
 *   the compact finds in progress is that dialog: omp closes it and ends the run, which is complete (every tool call has
 *   returned and its result is in the conversation), makes the summary and carries the turn on by itself. The messages
 *   then wait for the end of that turn (`following`), as they waited for the turn's end before the compact began.
 *   A turn that ends before it comes to a boundary is compacted at its end: the request is the same, only earlier.
 */

/** What the queue needs of the process it belongs to. */
export interface CompactHost {
	/** Send omp a command (not through this queue). `user`: it answers a click, so a frozen conversation runs for it (see `Live.rpc`). */
	send(command: Record<string, unknown>, options?: { user?: boolean }): Promise<RpcResponse>;
	/** A turn is under way. */
	working(): boolean;
	/** The process is frozen: it can end no turn, and is sent nothing. */
	paused(): boolean;
	/** What the queue holds changed: every page is told (`LiveInfo.compactQueued`) and a kept conversation's record is written again. */
	changed(): void;
	/** The queued compact is over: how it came out, for the pages to say. */
	ended(outcome: CompactOutcome): void;
	/** Why this process cannot be held between two steps (see `StepUnavailable`), or null when it can. Asked when a compact between steps is queued. */
	stepUnavailable(): Promise<StepUnavailable | null>;
	/** What the process's extension is told: a compact waits for a step boundary (`at` names the request), or none does (null). Called when that changes. */
	arm(at: number | null): void;
	/** Answer the extension's dialog `id` with "go on": nothing is compacted at this boundary. */
	letGo(id: string): void;
	/** Ask omp for its state and take it as the truth: it knows whether a turn runs, whatever frame it did not send. */
	refresh(): Promise<void>;
}

/** How a queued compact ended: `ok` is omp's answer to the compact; `returned` the held messages the server could not send, for the person to have back. */
export interface CompactOutcome {
	ok: boolean;
	error?: string;
	/** The request was cancelled (nothing was compacted); `ok` is true. */
	cancelled?: boolean;
	/** A compact between steps that failed ended the turn at the boundary, and omp does not go on with a turn whose summary failed. */
	stopped?: boolean;
	returned?: string[];
}

interface Queue {
	at: number;
	phase: CompactPhase;
	where: CompactWhere;
	stepUnavailable?: StepUnavailable;
	instructions?: string;
	held: HeldPrompt[];
}

/** omp refuses a compact while it compacts by itself: it is tried again when that is over. */
const IN_PROGRESS = /already in progress/i;
/** What omp says when there is nothing to summarize: it still carries the turn on, as after a summary (a failed summary it does not). */
const NOTHING_TO_COMPACT = /nothing to compact|already compacted/i;
/** How long after a compact between steps has been answered the turn it carried on is waited for. It starts within milliseconds. */
const RESUME_MS = 3000;

function answered(command: string, data: unknown): RpcResponse {
	return { type: "response", command, success: true, data };
}

/** The pictures of a command, as records. */
function imagesOf(v: unknown): Record<string, unknown>[] {
	return Array.isArray(v) ? v.filter(isRecord) : [];
}

export class CompactQueue {
	private state: Queue | null = null;
	/** omp compacts by itself (`auto_compaction_start` … `auto_compaction_end`). */
	private autoCompacting = false;
	/** The follow-ups are being taken out of omp's queue: the compact is not sent before they are held. */
	private taking: Promise<Error | null> | null = null;
	/** A send of the compact is being decided or made: one at a time. */
	private firing = false;
	/** The request the extension is told waits for a step boundary; null when it is told none does. */
	private armed: number | null = null;
	/** The extension's dialogs that are open: its holds at a step boundary. */
	private readonly dialogs = new Set<string>();
	/** How many turns have begun (`agent_start`): the turn a compact between steps carries on is told from the one it was made in by this. */
	private starts = 0;
	/** Told when a turn begins, by the wait for the one a compact between steps carries on. */
	private onStart: (() => void) | null = null;
	/** The messages held behind a compact between steps are being sent. */
	private releasing = false;

	constructor(
		private readonly host: CompactHost,
		private readonly resumeMs = RESUME_MS,
	) {}

	/** Something is queued (or runs): a command a page sends may have to be held (see `intercept`). */
	get active(): boolean {
		return this.state !== null;
	}

	/** What the pages are told; undefined when nothing is queued. */
	get info(): CompactQueued | undefined {
		const s = this.state;
		if (!s) return undefined;
		return {
			at: s.at,
			phase: s.phase,
			where: s.where,
			...(s.stepUnavailable ? { stepUnavailable: s.stepUnavailable } : {}),
			...(s.instructions ? { instructions: s.instructions } : {}),
			held: s.held.map((h) => h.message),
		};
	}

	/** What a kept (paused) conversation's record says; a compact that already runs is not kept. */
	get record(): CompactQueueRecord | undefined {
		const s = this.state;
		if (!s || s.phase === "running") return undefined;
		return {
			at: s.at,
			...(s.instructions ? { instructions: s.instructions } : {}),
			held: s.held.map((h) => ({ ...h })),
			...(s.where === "step" ? { where: s.where } : {}),
			...(s.phase === "following" ? { following: true as const } : {}),
		};
	}

	/** A conversation taken over from a record: it waits as it did (`rearm` tells its extension). */
	restore(record: CompactQueueRecord | undefined): void {
		if (!record) return;
		this.state = {
			at: record.at,
			phase: record.following ? "following" : "queued",
			where: record.where ?? "turn",
			...(record.instructions ? { instructions: record.instructions } : {}),
			held: record.held.map((h) => ({ ...h })),
		};
	}

	/** The request the extension is to be told of, as the queue stands: a compact that waits for a step boundary. */
	private wanted(): number | null {
		const s = this.state;
		return s?.phase === "queued" && s.where === "step" ? s.at : null;
	}

	private setArmed(at: number | null): void {
		if (this.armed === at) return;
		this.armed = at;
		this.host.arm(at);
	}

	/** Tell the process's extension what is wanted as the queue stands: for a process that was taken over (its file may be a former server's), and after `restore`. */
	rearm(): void {
		this.armed = this.wanted();
		this.host.arm(this.armed);
	}

	/**
	 * Ask for a compact at `asked`: the end of the turn, or between two steps where the process can be held there (it is the end
	 * of the turn, with the reason in `info`, where it cannot). A second ask replaces the note and the place of the first. When no
	 * turn is under way there is nothing to wait for: it is sent now. Throws when omp could not be asked for its queue (nothing is
	 * held then, and what was sent meanwhile has been given to omp as it was).
	 */
	async queue(instructions: string | undefined, asked: CompactWhere = "turn"): Promise<void> {
		const queued = this.state;
		if (queued) {
			if (queued.phase === "running") throw new Error("A compact is already running");
			queued.instructions = instructions;
			// After a compact between steps the messages wait for the turn that went on; this is a new compact before them.
			if (queued.phase === "following") {
				queued.phase = "queued";
				queued.at = Date.now();
			}
			queued.where = "turn";
			delete queued.stepUnavailable;
			this.setArmed(null);
			this.host.changed();
			await this.place(queued, asked);
			return;
		}
		const s: Queue = {
			at: Date.now(),
			phase: "queued",
			where: "turn",
			held: [],
			...(instructions ? { instructions } : {}),
		};
		this.state = s;
		this.host.changed();
		if (!this.host.working()) {
			void this.run();
			return;
		}
		const taking = this.take(s);
		this.taking = taking;
		const failure = await taking;
		if (this.taking === taking) this.taking = null;
		if (!failure) {
			await this.place(s, asked);
			return;
		}
		// Nothing is waiting for a compact that was never queued: what was held meanwhile goes to omp as it was sent.
		await this.release(s);
		if (this.state === s) this.state = null;
		this.host.changed();
		throw failure;
	}

	/** Give a queued compact the place asked for, if it can have it, else the reason it cannot. A turn that ended meanwhile has sent it (`run`) and is none of this. */
	private async place(s: Queue, asked: CompactWhere): Promise<void> {
		if (asked !== "step") return;
		let why: StepUnavailable | null;
		try {
			why = await this.host.stepUnavailable();
		} catch {
			why = "notLoaded";
		}
		if (this.state !== s || s.phase !== "queued") return;
		if (why) s.stepUnavailable = why;
		else {
			s.where = "step";
			this.setArmed(s.at);
		}
		this.host.changed();
	}

	/** Take back the request: what is held goes to omp now, as it would have. One that already runs cannot be taken back. */
	async cancel(): Promise<void> {
		const s = this.state;
		if (!s) return;
		if (s.phase === "running") throw new Error("The compact has already started");
		// Nothing waits for a compact any more: what is held is for the turn that goes on, and goes with its end.
		if (s.phase === "following") return;
		if (this.taking) await this.taking;
		if (this.state !== s) return;
		// A compact that was sent while the follow-ups were still being taken out is not taken back.
		if (s.phase !== "queued") throw new Error("The compact has already started");
		this.setArmed(null);
		const returned = await this.release(s);
		if (this.state === s) this.state = null;
		this.host.changed();
		if (returned.length > 0) this.host.ended({ ok: true, cancelled: true, returned });
	}

	/**
	 * Stop was pressed: the request is dropped with the messages behind it, and they are handed back to be put in the
	 * message box, as Stop does with omp's own queue (nothing that was waiting for the turn starts one afterwards). A compact
	 * that already runs goes on: Stop ends it in omp, and what it did not send is not held any more.
	 *
	 * The request is dropped at once (no turn end can send the compact after Stop), but the messages are read only once
	 * the follow-ups still being taken out of omp's queue (`take`) are held: those are no longer in omp's queue for Stop to
	 * hand back, and would otherwise be lost.
	 */
	async withdraw(): Promise<HeldPrompt[]> {
		const s = this.state;
		if (!s) return [];
		if (s.phase !== "running") {
			this.state = null;
			this.setArmed(null);
		}
		this.host.changed();
		if (this.taking) await this.taking;
		const held = s.held.splice(0);
		if (this.state === s) this.host.changed();
		return held;
	}

	/** The process moved to another conversation (`new_session`, `switch_session`, a fork…): what waited was for the one it left. A handoff is the same conversation in a new file, and keeps it. */
	moved(command: string): void {
		if (command === "handoff" || !this.state) return;
		this.state = null;
		this.setArmed(null);
		this.host.changed();
	}

	/** The process is gone: what waited is gone with it, and the pages are told by its end, not by a change. */
	gone(): void {
		this.state = null;
		this.armed = null;
		this.dialogs.clear();
	}

	/** The process runs again (a resume): a compact that could not be sent while it was frozen is sent if the turn is over. */
	resumed(): void {
		if (this.state?.phase === "queued") void this.run();
	}

	/**
	 * A command a page sent while a compact waits, or null to let omp have it. The messages that would be queued behind
	 * the compact, or start a turn before it, are held; a held follow-up can be removed or sent ahead; a command that omp
	 * runs at once (a slash command, a steer) is omp's.
	 */
	async intercept(command: Record<string, unknown>, options: { user?: boolean }): Promise<RpcResponse | null> {
		const s = this.state;
		if (!s) return null;
		const type = String(command.type);
		switch (type) {
			case "prompt":
			case "follow_up": {
				const message = command.message;
				if (typeof message !== "string") return null;
				// omp runs a slash command at once, and a steer is the person's way of not waiting.
				if (type === "prompt" && (message.trimStart().startsWith("/") || command.streamingBehavior === "steer"))
					return null;
				const images = imagesOf(command.images);
				s.held.push(images.length > 0 ? { message, images } : { message });
				this.host.changed();
				return answered(type, { held: true });
			}
			case "remove_queued_message": {
				if (command.queue !== "followUp") return null;
				const at = s.held.findIndex((h) => h.message === command.message);
				if (at < 0) return null;
				const [taken] = s.held.splice(at, 1);
				this.host.changed();
				return answered(type, { removed: true, images: taken.images ?? [] });
			}
			case "promote_queued_message": {
				const at = s.held.findIndex((h) => h.message === command.message);
				if (at < 0) return null;
				const [taken] = s.held.splice(at, 1);
				this.host.changed();
				const sent = await this.host.send(
					{ type: "steer", message: taken.message, ...(taken.images ? { images: taken.images } : {}) },
					options,
				);
				if (!sent.success && this.state === s) {
					s.held.splice(at, 0, taken);
					this.host.changed();
				}
				return sent.success ? answered(type, {}) : sent;
			}
			default:
				return null;
		}
	}

	/**
	 * A frame omp sent: where the turn ends, when it compacts by itself, and the extension's hold at a step boundary. True when
	 * the frame was the extension's dialog (or its end), which no page is shown.
	 */
	frame(frame: { type: string; [key: string]: unknown }): boolean {
		switch (frame.type) {
			case "extension_ui_request":
				return this.dialog(frame);
			case "agent_start":
				this.starts++;
				this.onStart?.();
				return false;
			case "auto_compaction_start":
				this.autoCompacting = true;
				return false;
			case "auto_compaction_end":
			case "session_settled":
				this.autoCompacting = false;
				break;
			case "agent_end":
				// A turn omp carries on (`isTerminal: false`) is not over.
				if (frame.isTerminal === false) return false;
				break;
			default:
				return false;
		}
		const phase = this.state?.phase;
		if (phase === "queued") void this.run();
		else if (phase === "following") void this.releaseFollowing();
		return false;
	}

	/** The extension's hold: a boundary where a wanted compact is sent, or let go; its end, which says that omp ended the run for the compact. */
	private dialog(frame: { [key: string]: unknown }): boolean {
		if (frame.method === "select" && frame.title === COMPACT_STEP_DIALOG_TITLE) {
			const id = String(frame.id);
			this.dialogs.add(id);
			const s = this.state;
			// Not the time, or no compact to make: the conversation goes on (a compact running, or a turn end already sending it, is neither).
			if (s?.phase === "queued" && s.where === "step" && !this.host.paused() && !this.autoCompacting) void this.run(id);
			else this.passed(id);
			return true;
		}
		if (frame.method === "cancel" && this.dialogs.delete(String(frame.targetId))) {
			// omp closed the hold because the compact ended the run: the resumed turn is not to be held again.
			if (this.state?.phase === "running") this.setArmed(null);
			return true;
		}
		return false;
	}

	/** Let go the extension's dialog `id`: nothing is compacted at its boundary. */
	private passed(id: string | undefined): void {
		if (id === undefined || !this.dialogs.delete(id)) return;
		this.host.letGo(id);
	}

	/** Take the follow-ups out of omp's queue (it would send them before the turn ends), and hold them in the order they were queued. */
	private async take(s: Queue): Promise<Error | null> {
		const taken: HeldPrompt[] = [];
		try {
			const state = await this.host.send({ type: "get_state" }, { user: true });
			if (!state.success) return new Error(state.error ?? "omp did not answer");
			const queued =
				isRecord(state.data) && isRecord(state.data.queuedMessages) && Array.isArray(state.data.queuedMessages.followUp)
					? state.data.queuedMessages.followUp.filter((m): m is string => typeof m === "string")
					: [];
			for (const message of queued) {
				const removed = await this.host.send(
					{ type: "remove_queued_message", message, queue: "followUp" },
					{ user: true },
				);
				// One omp had sent already is not taken back: it was ahead of the compact when it was sent.
				if (!removed.success || !isRecord(removed.data) || removed.data.removed !== true) continue;
				const images = imagesOf(removed.data.images);
				taken.push(images.length > 0 ? { message, images } : { message });
			}
			return null;
		} catch (e) {
			return e instanceof Error ? e : new Error(String(e));
		} finally {
			// Held on its own queue even when that was dropped meanwhile: a Stop (`withdraw`) waits for them and hands them back.
			if (taken.length > 0) {
				s.held.unshift(...taken);
				if (this.state === s) this.host.changed();
			}
		}
	}

	/** Send the compact when the turn is over (or, with `hold`, at the step boundary that dialog is) and nothing else is going on; otherwise wait for the next end. */
	private async run(hold?: string): Promise<void> {
		if (this.firing) {
			this.passed(hold);
			return;
		}
		this.firing = true;
		try {
			await this.fire(hold);
		} finally {
			this.firing = false;
		}
	}

	private async fire(hold?: string): Promise<void> {
		const s = this.state;
		if (s?.phase !== "queued") return this.passed(hold);
		if (this.taking) await this.taking;
		if (this.state !== s || s.phase !== "queued") return this.passed(hold);
		if (hold === undefined) {
			// A frozen omp ends no turn; one that compacts by itself would refuse; a turn that began again (a goal's next one) is not over.
			if (this.host.paused() || this.autoCompacting || this.host.working()) return;
			// The turn is over: no boundary is waited for any more, and it is the end of the turn that compacts.
			s.where = "turn";
			this.setArmed(null);
		} else if (this.host.paused() || this.autoCompacting) return this.passed(hold);
		s.phase = "running";
		this.host.changed();
		const startsBefore = this.starts;
		let outcome: CompactOutcome;
		try {
			// The hold stands until omp has taken the compact: it ends the run that waits in it, and a hold that was taken away first
			// would end the wait before that (the extension looks at its file every 100 ms).
			const r = await this.host.send(
				{ type: "compact", ...(s.instructions ? { customInstructions: s.instructions } : {}) },
				{ user: true },
			);
			outcome = r.success ? { ok: true } : { ok: false, error: r.error ?? "omp could not compact" };
		} catch (e) {
			outcome = { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
		// Cleared meanwhile (the process went, or moved to another conversation): what was held was for the one it left.
		if (this.state !== s) return;
		if (!outcome.ok && IN_PROGRESS.test(outcome.error ?? "")) {
			s.phase = "queued";
			this.host.changed();
			// omp refused before it touched the run: the extension's dialog still waits, and the boundary goes on.
			this.passed(hold);
			return;
		}
		if (hold !== undefined) {
			await this.afterBoundary(s, outcome, startsBefore);
			return;
		}
		const returned = await this.release(s);
		if (this.state === s) this.state = null;
		this.host.changed();
		this.host.ended(returned.length > 0 ? { ...outcome, returned } : outcome);
	}

	/**
	 * omp has answered a compact made at a step boundary. It ended the turn there and, once the summary is committed, carries the
	 * turn on by itself (also when there was nothing to summarize); a summary that failed leaves the turn ended. The messages
	 * held behind the compact go after the turn that went on, or at once after one that did not.
	 */
	private async afterBoundary(s: Queue, answer: CompactOutcome, startsBefore: number): Promise<void> {
		this.setArmed(null);
		const resumes = answer.ok || NOTHING_TO_COMPACT.test(answer.error ?? "");
		const outcome = resumes ? answer : { ...answer, stopped: true };
		if (resumes && s.held.length === 0) {
			this.state = null;
			this.host.changed();
			this.host.ended(outcome);
			return;
		}
		if (!resumes) {
			// omp knows the turn is over, though no frame said it.
			await this.host.refresh().catch(() => {});
			if (this.state !== s) return;
			const returned = await this.release(s);
			if (this.state === s) this.state = null;
			this.host.changed();
			this.host.ended(returned.length > 0 ? { ...outcome, returned } : outcome);
			return;
		}
		s.phase = "following";
		this.host.changed();
		this.host.ended(outcome);
		const began = await this.turnBegan(startsBefore);
		if (this.state !== s || s.phase !== "following" || began) return;
		// No turn came (omp is set not to carry on, or it did not): ask it, and send the messages if it is idle.
		await this.host.refresh().catch(() => {});
		if (this.state === s) await this.releaseFollowing();
	}

	/** Whether a turn has begun since `startsBefore` turns had: at once if one did, else when one does, or false when none did within the wait. */
	private async turnBegan(startsBefore: number): Promise<boolean> {
		if (this.starts > startsBefore) return true;
		const wait = Promise.withResolvers<boolean>();
		this.onStart = () => wait.resolve(true);
		const timer = setTimeout(() => wait.resolve(false), this.resumeMs);
		timer.unref?.();
		try {
			return await wait.promise;
		} finally {
			clearTimeout(timer);
			this.onStart = null;
		}
	}

	/** The turn a compact between steps carried on is over: the messages held for its end are sent. */
	private async releaseFollowing(): Promise<void> {
		const s = this.state;
		// A turn that began again (a goal's next one) is not over.
		if (s?.phase !== "following" || this.releasing || this.host.working()) return;
		this.releasing = true;
		try {
			const returned = await this.release(s);
			if (this.state === s) this.state = null;
			this.host.changed();
			if (returned.length > 0) this.host.ended({ ok: true, returned });
		} finally {
			this.releasing = false;
		}
	}

	/**
	 * Send the held messages to omp, first to last, each once the one before has been taken. A message sent meanwhile joins
	 * the end. One omp refuses stops it: that message and the ones behind it are returned, for the person to have back.
	 * Always as a follow-up: that is a plain prompt when no turn runs, and queues behind the one the first of them starts.
	 */
	private async release(s: Queue): Promise<string[]> {
		while (this.state === s && s.held.length > 0) {
			const next = s.held.shift() as HeldPrompt;
			this.host.changed();
			let failed = false;
			try {
				const r = await this.host.send({
					type: "prompt",
					message: next.message,
					...(next.images ? { images: next.images } : {}),
					streamingBehavior: "followUp",
				});
				failed = !r.success;
			} catch {
				failed = true;
			}
			if (failed) {
				const returned = [next.message, ...s.held.splice(0).map((h) => h.message)];
				this.host.changed();
				return returned;
			}
		}
		return [];
	}
}
