import { isRecord } from "../../../shared/guards.ts";
import { statusOf } from "../../../shared/held-state.ts";
import type { OmpFrame, UsageReport } from "../../../shared/protocol.ts";
import type { LiveCacheWarming, LiveQuotaHold, QuotaHoldReason, QuotaHoldState } from "../../../shared/quota-floor.ts";
import {
	type HoldFields,
	parseWarmVerdict,
	QUOTA_DIALOG_TITLE,
	QUOTA_SELF_RELEASE_MS,
	QUOTA_STATUS_KEY,
	type WarmVerdict,
} from "../../../shared/quota-hold.ts";
import {
	type FloorReading,
	nextHold,
	nextLookMs,
	type QuotaHold,
	type QuotaTimings,
	readFloor,
	resumeAtOf,
} from "./decide.ts";

/**
 * One conversation's quota floor (#652): when its provider is at the floor the person set, the conversation is held between two
 * model requests, and let go when the provider is above the floor again, which is after the window resets.
 *
 * The tracker is the server's half. The hold itself is a small file (`HoldFields`) that omp's extension reads
 * (`extension.ts`: the main agent's next step waits in a dialog while the file says so); the tracker writes it, takes it away,
 * and consumes the extension's two ways of speaking (the dialog it waits in, and the status it tells its cache warming
 * decision with) so that no page is shown either. It decides nothing about omp's process: nothing here signals it.
 *
 * A look at the quota goes through `providerUsage`, the cache every page's quota pill shares, so that N working conversations
 * on one provider are one `omp usage` per interval, not N. A conversation is looked at when it starts working and every
 * `workingLookMs` while it does; a held one rarely (it spends nothing) and once at its reset (`decide.ts nextLookMs`).
 *
 * A hold is only meaningful while the conversation works: when the turn ends it is gone (the next turn looks again). "Continue
 * anyway" is not: it is the person's word that the floor is not to hold this conversation, and it stands until the provider is
 * seen above the floor again.
 */

/** What the tracker needs of the world, so that a test can supply a clock and a provider. */
export interface QuotaDeps {
	timings: QuotaTimings;
	now(): number;
	/** Run `fn` after `ms`; the answer cancels it. */
	after(ms: number, fn: () => void): () => void;
	/** The provider's floor (percent left), or null when it has none. */
	floorOf(provider: string): number | null;
	reports(provider: string, force: boolean): Promise<UsageReport[]>;
	/** Write the hold file (null: take it away). Throws when it cannot. */
	write(hold: HoldFields | null): void;
	/** Something went wrong that the conversation's work is not to be held up by. */
	report(message: string): void;
}

/** What the tracker needs of its conversation. */
export interface QuotaHost {
	/** The provider the conversation's model is of, and the model's bare id; null while the server has not heard which. */
	provider(): string | null;
	model(): string | null;
	/** The conversation works and spends quota: a turn runs, it is not paused, and it is not waiting out a usage limit. */
	working(): boolean;
	/** Why this process cannot be held (its omp does not run the extension), or null when it can. */
	cannotHold(): QuotaHoldReason | null;
	/** A turn is open: it works, or it is paused or waiting out a usage limit. A hold lasts as long as the turn does. */
	active(): boolean;
	/** Prompt cache warming is off for this conversation, as far as the server knows (it told omp so). */
	warmingOff(): boolean;
	/** Answer the quota dialog `id` (the hold is over: the extension's wait ends at once, not at its next look at the file). */
	answer(id: string): void;
	/** What a page is told of the conversation changed. */
	changed(): void;
}

/** What is kept of a conversation across the server (`ParkedRecord.quota`). */
export interface QuotaRecord {
	hold: QuotaHold | null;
	override: boolean;
	/** omp was waiting in the dialog when this was written. */
	held: boolean;
	/** The dialogs it was waiting in, so that their end is told from any other dialog's. */
	dialogs: string[];
	verdict: WarmVerdict | null;
	refreshes: number;
	spent: number;
}

export class QuotaTracker {
	private hold: QuotaHold | null = null;
	private override = false;
	/** The extension's dialogs that are open now. */
	private readonly dialogs = new Set<string>();
	/** A server took the conversation over while omp was waiting: its dialog is open, though this server saw it not open. */
	private adoptedHeld = false;
	private verdict: WarmVerdict | null = null;
	private refreshes = 0;
	private spent = 0;
	private lastLook = 0;
	private looking = false;
	private cancelNext: (() => void) | null = null;
	/** What the hold file says now, as text (so that a repeat is not written). */
	private written = "";
	private ended = false;

	constructor(
		private readonly deps: QuotaDeps,
		private readonly host: QuotaHost,
		restored?: QuotaRecord,
	) {
		if (restored) {
			this.hold = restored.hold;
			this.override = restored.override;
			// The waits it was in are known by their ids, and their ends are told from any other dialog's; a wait whose id was not
			// kept is held all the same until the conversation's work says otherwise.
			this.adoptedHeld = restored.held && restored.dialogs.length === 0;
			for (const id of restored.dialogs) this.dialogs.add(id);
			this.verdict = restored.verdict;
			this.refreshes = restored.refreshes;
			this.spent = restored.spent;
		}
	}

	/** omp is waiting in the extension's dialog: it is stopped before its next step, not only about to be. */
	get held(): boolean {
		return this.state() === "held";
	}

	state(): QuotaHoldState | null {
		if (!this.hold) return null;
		if (this.override) return "overridden";
		if (this.host.cannotHold()) return "unavailable";
		return this.dialogs.size > 0 || this.adoptedHeld ? "held" : "armed";
	}

	/** What a page is told (`LiveInfo.quotaHold`); undefined while there is nothing to tell. */
	info(): LiveQuotaHold | undefined {
		const hold = this.hold;
		const state = this.state();
		if (!hold || !state) return undefined;
		const reason = this.host.cannotHold();
		return {
			state,
			provider: hold.provider,
			floor: hold.floor,
			remaining: hold.remaining,
			...(hold.window ? { window: hold.window } : {}),
			...(hold.resetsAt !== null ? { resetsAt: hold.resetsAt } : {}),
			since: hold.since,
			warming: this.warming(),
			...(state === "unavailable" && reason ? { reason } : {}),
		};
	}

	private warming(): LiveCacheWarming {
		const v = this.verdict;
		const base: LiveCacheWarming = this.host.warmingOff()
			? { state: "off" }
			: v
				? {
						state: v.state,
						...(v.why ? { why: v.why } : {}),
						...(v.pings !== undefined ? { pings: v.pings } : {}),
						...(v.warmCost !== undefined ? { warmCost: v.warmCost } : {}),
						...(v.rebuildCost !== undefined ? { rebuildCost: v.rebuildCost } : {}),
					}
				: { state: "unknown" };
		return this.refreshes > 0 ? { ...base, refreshes: this.refreshes, spent: this.spent } : base;
	}

	/** What is kept of this conversation across the server; undefined when there is nothing to keep. */
	record(): QuotaRecord | undefined {
		if (!this.hold && !this.override) return undefined;
		return {
			hold: this.hold,
			override: this.override,
			held: this.state() === "held",
			dialogs: [...this.dialogs],
			verdict: this.verdict,
			refreshes: this.refreshes,
			spent: this.spent,
		};
	}

	/**
	 * A frame omp sent. True when it was the tracker's (the extension's dialog, its end, its status), which no page is shown;
	 * the frames that tell what the cache warming cost are read and left to go on.
	 */
	onFrame(frame: OmpFrame): boolean {
		if (frame.type === "cache_warming_end") {
			this.noteRefresh(frame);
			return false;
		}
		if (frame.type !== "extension_ui_request") return false;
		if (frame.method === "select" && frame.title === QUOTA_DIALOG_TITLE) {
			const id = String(frame.id);
			// Nothing holds the conversation now (the hold ended, or the person went on): its wait ends as it begins.
			if (!this.hold || this.override) {
				this.host.answer(id);
				return true;
			}
			this.dialogs.add(id);
			this.adoptedHeld = false;
			this.host.changed();
			return true;
		}
		if (frame.method === "cancel" && this.dialogs.has(String(frame.targetId))) {
			this.dialogs.delete(String(frame.targetId));
			this.host.changed();
			return true;
		}
		if (frame.method === "setStatus" && statusOf(frame).key === QUOTA_STATUS_KEY) {
			const verdict = parseWarmVerdict(statusOf(frame).text);
			if (verdict && this.hold) {
				this.verdict = verdict;
				this.host.changed();
			}
			return true;
		}
		return false;
	}

	/** omp refreshed the prompt cache (`cache_warming_end`): what it cost counts while the conversation is held. */
	private noteRefresh(frame: OmpFrame): void {
		if (!this.hold) return;
		const { usage } = frame;
		if (usage !== undefined) {
			this.refreshes++;
			const cost = isRecord(usage) && isRecord(usage.cost) ? usage.cost.total : undefined;
			if (typeof cost === "number" && Number.isFinite(cost)) this.spent += cost;
		}
		// A refresh that failed to keep the cache ends omp's warming for good (`warmingStopReason`): that is a lapse too.
		if (typeof frame.warmingStopReason === "string" && this.verdict?.state !== "lapse")
			this.verdict = { v: 1, at: this.deps.now(), state: "lapse", why: "omp" };
		this.host.changed();
	}

	/**
	 * The conversation's work changed (a turn began or ended, it was paused or resumed, a usage-limit wait began or ended). A turn
	 * that begins is looked at at once; one that is over leaves no hold behind, and nothing is looked at while nothing works.
	 */
	onWork(): void {
		if (this.ended) return;
		if (!this.host.active()) {
			this.cancelTimer();
			if (this.hold) this.settle(null);
			return;
		}
		// Paused, or waiting out a usage limit: the turn is open and a hold stands, but nothing spends and nothing is looked at.
		if (!this.host.working()) {
			this.cancelTimer();
			return;
		}
		if (this.hold === null || !this.looking) void this.look(false);
	}

	/** A floor was set or changed: a conversation that works looks again. */
	refresh(): void {
		if (this.ended || !this.host.working()) return;
		void this.look(false);
	}

	/** "Continue anyway" (`on`), or hold again. The choice is the person's, so it holds while the conversation is held or armed. */
	setOverride(on: boolean): void {
		if (on === this.override) return;
		if (on && !this.hold) return;
		this.override = on;
		this.sync();
		this.host.changed();
		this.schedule();
	}

	/** Look at the provider's quota now. */
	async look(force: boolean): Promise<void> {
		if (this.ended || this.looking || !this.host.working()) return;
		const provider = this.host.provider();
		const floor = provider ? this.deps.floorOf(provider) : null;
		if (!provider || floor === null) {
			// No floor for this provider (it was taken away, or the model changed): nothing holds it and nothing is overridden.
			const was = this.override;
			this.override = false;
			if (this.hold) this.settle(null);
			else if (was) this.host.changed();
			this.cancelTimer();
			return;
		}
		this.looking = true;
		let reading: FloorReading | null = null;
		try {
			reading = readFloor(await this.deps.reports(provider, force), provider, this.host.model(), floor);
		} catch {
			// `omp usage` did not answer: what is known stays, and the next look is the usual interval away.
		} finally {
			this.looking = false;
		}
		this.lastLook = this.deps.now();
		// Whatever happened while the quota was read: the turn may be over, or the conversation on another model.
		if (this.ended || !this.host.working() || this.host.provider() !== provider) {
			if (this.hold && !this.host.active()) this.settle(null);
			this.schedule();
			return;
		}
		// A provider above its floor is the end of "Continue anyway": it was for the stretch that was below it.
		if (reading && !reading.low) this.override = false;
		this.settle(nextHold(this.hold, reading, this.lastLook));
		this.schedule();
	}

	/** Take `next` as the hold: what the extension reads, and what pages are told, follow. */
	private settle(next: QuotaHold | null): void {
		const prev = this.hold;
		this.hold = next;
		if (next === null) {
			this.verdict = null;
			this.refreshes = 0;
			this.spent = 0;
			this.adoptedHeld = false;
		}
		this.sync();
		if (JSON.stringify(prev) !== JSON.stringify(next)) this.host.changed();
		else if (next === null) this.host.changed();
	}

	/** Bring the hold file, and the extension's open dialogs, in line with the hold. */
	private sync(): void {
		const hold = this.hold;
		const holds = hold !== null && !this.override && this.host.cannotHold() === null;
		let fields: HoldFields | null = null;
		if (hold && holds) {
			const resumeAt = resumeAtOf(hold, this.deps.timings);
			fields = {
				provider: hold.provider,
				resetsAt: hold.resetsAt,
				resumeAt,
				expiresAt: resumeAt === null ? null : resumeAt + QUOTA_SELF_RELEASE_MS,
				since: hold.since,
			};
		}
		const text = fields ? JSON.stringify(fields) : "";
		if (text !== this.written) {
			try {
				this.deps.write(fields);
				this.written = text;
			} catch (e) {
				this.deps.report(`could not write the quota hold: ${(e as Error).message}`);
			}
		}
		// The hold file is gone first, so that a wait that ends reads it so; the open dialogs are answered, and the extension's
		// handlers end now rather than at their next look at the file.
		if (!fields) this.release();
	}

	/** Let go the extension's open dialogs. */
	private release(): void {
		for (const id of this.dialogs) this.host.answer(id);
		this.dialogs.clear();
		this.adoptedHeld = false;
	}

	private cancelTimer(): void {
		this.cancelNext?.();
		this.cancelNext = null;
	}

	/** The next look: see `nextLookMs`. */
	private schedule(): void {
		this.cancelTimer();
		if (this.ended) return;
		const resumeAt = this.hold ? resumeAtOf(this.hold, this.deps.timings) : null;
		const now = this.deps.now();
		const wait = nextLookMs({
			working: this.host.working(),
			held: this.hold !== null && !this.override,
			resumeAt,
			now,
			last: this.lastLook,
			timings: this.deps.timings,
		});
		if (wait === null) return;
		// The look at the reset asks the provider itself: a figure from before the reset says nothing of it.
		const afterReset = resumeAt !== null && now + wait >= resumeAt;
		this.cancelNext = this.deps.after(wait, () => {
			this.cancelNext = null;
			void this.look(afterReset);
		});
	}

	/** The conversation ended or the server is: no more looks. The hold file goes with the process's own folder. */
	end(): void {
		this.ended = true;
		this.cancelTimer();
	}

	/** A server took this conversation over: look again (the quota may have reset while no server was there) and keep looking. */
	resume(): void {
		if (this.ended) return;
		this.sync();
		if (this.host.working() || this.hold) {
			this.lastLook = 0;
			void this.look(this.hold !== null);
		}
	}
}
