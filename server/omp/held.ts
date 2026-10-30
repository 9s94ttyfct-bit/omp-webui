import {
	type AttachedHold,
	type BashRun,
	bashEnded,
	bashStarted,
	statusOf,
	widgetOf,
} from "../../shared/held-state.ts";
import type { OmpFrame } from "../../shared/protocol.ts";

/**
 * What omp says once and a page that attaches later still has to show (#587): a compaction that is under way, the status
 * lines and widgets an extension put on the screen, and the `!commands` that run. A page that was listening heard each as
 * a frame; one that attaches afterwards (a reload, the other window of the app, a page through the tunnel opened later,
 * a reconnect) would show none of them for as long as they last. The server keeps each as the frame that said it, in the
 * order they were said, and replays them to a tab that attaches (`Live.resync`), then names what it holds
 * (`AttachedHold`) so that the tab drops what it shows beyond it (a thing that ended while it was away).
 */
export class HeldState {
	private compaction: OmpFrame | null = null;
	private readonly statuses = new Map<string, OmpFrame>();
	private readonly widgets = new Map<string, OmpFrame>();
	private readonly bashes = new Map<string, BashRun>();
	private seq = 0;

	/** Take one frame omp sent. Nothing is changed in `frame`: the tabs hold the same object. */
	note(frame: OmpFrame): void {
		switch (frame.type) {
			case "auto_compaction_start":
				this.compaction = frame;
				return;
			case "auto_compaction_end":
			// The page ends a compaction whose end it never heard at the settled session, and so does this.
			case "session_settled":
				this.compaction = null;
				return;
			case "extension_ui_request": {
				if (frame.method === "setStatus") {
					const { key, text } = statusOf(frame);
					if (text) this.statuses.set(key, frame);
					else this.statuses.delete(key);
				} else if (frame.method === "setWidget") {
					const { key, lines } = widgetOf(frame);
					if (lines.length > 0) this.widgets.set(key, frame);
					else this.widgets.delete(key);
				}
				return;
			}
		}
	}

	/** A `!command` begins: what the pages are told is the frame this returns. */
	startBash(command: string): OmpFrame {
		const run: BashRun = { id: `bash-${++this.seq}`, command, startedAt: Date.now() };
		this.bashes.set(run.id, run);
		return bashStarted(run);
	}

	/**
	 * A `!command` is over (omp answered it): the frame that says so, with how long it ran, or null when it was not held (the
	 * process ended first).
	 */
	endBash(id: string): OmpFrame | null {
		const run = this.bashes.get(id);
		if (!run) return null;
		this.bashes.delete(id);
		return bashEnded(id, run);
	}

	/** A `!command` is running (omp has not answered it yet). */
	get bashRunning(): boolean {
		return this.bashes.size > 0;
	}

	/**
	 * The frames that bring a tab that attached up to what is held: the status lines, then the widgets, then the
	 * compaction under way, then the `!command`s that run (each group keeps the order its keys were first set). The page
	 * folds each by key, so the order between groups does not matter.
	 */
	replay(): OmpFrame[] {
		const frames: OmpFrame[] = [...this.statuses.values(), ...this.widgets.values()];
		if (this.compaction) frames.push(this.compaction);
		for (const run of this.bashes.values()) frames.push(bashStarted(run));
		return frames;
	}

	/** What is held, by the names a page keeps each under (it is the whole of it: see `AttachedHold`). */
	hold(): AttachedHold {
		return {
			compacting: this.compaction !== null,
			statuses: [...this.statuses.keys()],
			widgets: [...this.widgets.keys()],
			bashes: [...this.bashes.keys()],
		};
	}

	/** The process is gone: nothing it said holds any more. */
	clear(): void {
		this.compaction = null;
		this.statuses.clear();
		this.widgets.clear();
		this.bashes.clear();
	}
}
