/**
 * Automatic titles. omp turns them off in RPC mode (the TUI asks for one after the first reply), so something has to ask:
 * the server does, for every conversation it holds, whether or not a page is open on it (a conversation that ends its first
 * run while the macOS app has no window is titled all the same, #627). `/rename` without a title makes omp generate one
 * with its title models (source "user", so it sticks); what it printed is taken here, so that no page is shown it.
 *
 * It asks once the first exchange is over (a turn ended for good, the conversation is not named, and a prompt and a reply
 * are in it). omp's title model sometimes declines ("Could not generate a session title"): the next two attempts follow
 * after a short wait, and then the next time a turn ends.
 */

/** What an `AutoTitle` needs of a conversation's process. */
export interface TitleTarget {
	/** What omp says its state is now (null: it did not say). */
	state(): Promise<Record<string, unknown> | null>;
	/** Run `/rename` and return what omp printed (null: omp took the line for a message to the model). Throws when it could not be run. */
	rename(): Promise<string | null>;
	/** The process has ended or is ending: nothing more is asked of it. */
	gone(): boolean;
}

/** What omp prints when its title model gave nothing. */
const DECLINED = /Could not generate a session title/;
/** Attempts after one first exchange before the next turn's end is waited for. */
const MAX_ATTEMPTS = 3;
/** The wait after a declined attempt, times the number of attempts so far. */
const RETRY_MS = 1500;

export class AutoTitle {
	/** Sessions a title was asked for: not asked for again (until one was declined). */
	private readonly asked = new Set<string>();
	private readonly attempts = new Map<string, number>();
	private checking = false;
	private timers = new Set<ReturnType<typeof setTimeout>>();

	constructor(
		private readonly target: TitleTarget,
		/** Whether Settings has automatic titles on (read each time). */
		private readonly enabled: () => boolean,
		private readonly retryMs: number = RETRY_MS,
	) {}

	/** A turn ended for good (not one of a goal's, which goes on): the first exchange may be over. */
	turnEnded(): void {
		void this.check().catch(() => {});
	}

	/** Stop the waits for another attempt (the process ended). */
	stop(): void {
		for (const timer of this.timers) clearTimeout(timer);
		this.timers.clear();
	}

	private async check(): Promise<void> {
		if (this.checking || !this.enabled() || this.target.gone()) return;
		this.checking = true;
		try {
			const state = await this.target.state();
			const id = typeof state?.sessionId === "string" ? state.sessionId : "";
			if (!id || state?.sessionName || this.asked.has(id)) return;
			// A finished first exchange: at least a prompt and a reply.
			if (typeof state?.messageCount !== "number" || state.messageCount < 2) return;
			this.asked.add(id);
			let printed: string | null;
			try {
				printed = await this.target.rename();
			} catch {
				// Not asked after all (a paused conversation, a process that went away): the next turn's end asks again.
				this.asked.delete(id);
				return;
			}
			if (printed === null || !DECLINED.test(printed)) {
				this.attempts.delete(id);
				return;
			}
			this.asked.delete(id);
			const attempts = (this.attempts.get(id) ?? 0) + 1;
			if (attempts >= MAX_ATTEMPTS) {
				this.attempts.delete(id);
				return;
			}
			this.attempts.set(id, attempts);
			const timer = setTimeout(() => {
				this.timers.delete(timer);
				this.turnEnded();
			}, this.retryMs * attempts);
			this.timers.add(timer);
		} finally {
			this.checking = false;
		}
	}
}
