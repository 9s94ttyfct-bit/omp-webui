import { type CiAnswer, type CiRun, type CiRuns, type CiScope, finishedRuns } from "@shared/ci.ts";
import type { PageEnv } from "./auto-refresh.ts";

/**
 * The page's side of the CI tab's runs (`server/gh-runs.ts`): one loop per folder and list (`branch`, `all`), shared by
 * whatever shows it (the tab's badge and the tab itself), that asks the server again when the server says a newer look is
 * due (`nextMs`: 10 s while a run is queued or running, 60 s when all are finished, longer after failures). While the page
 * is hidden nothing is asked, unless a run's end is to be notified (`background`); when it comes back it asks at once. The
 * last one to stop watching ends the loop: a folder nobody looks at is not asked about.
 */

export interface CiView {
	answer: CiAnswer<CiRuns> | null;
	/** An ask the person made (the first, or Refresh) is under way. */
	loading: boolean;
}

export interface CiWatchDeps {
	/** `POST /api/github/runs`. */
	ask(body: { cwd: string; scope: CiScope; fresh: boolean }): Promise<CiAnswer<CiRuns>>;
	env: PageEnv;
	setTimer(fn: () => void, ms: number): unknown;
	clearTimer(handle: unknown): void;
	/** Whether a list goes on being looked at while the page is hidden (a run's end is to be notified). */
	background(scope: CiScope): boolean;
	/** Runs of the folder's branch that were queued or running at the last look and are finished now. */
	onFinished(cwd: string, runs: CiRun[]): void;
}

/** The longest a page waits whatever the server says (a timer cannot hold more), and the shortest. */
const MAX_WAIT_MS = 15 * 60_000;
const MIN_WAIT_MS = 1000;

type Listener = (view: CiView) => void;

interface Loop {
	cwd: string;
	scope: CiScope;
	view: CiView;
	listeners: Set<Listener>;
	timer: unknown;
	/** The ask under way, numbered: a later one has the say. */
	seq: number;
	busy: boolean;
	stop: () => void;
}

export class CiWatcher {
	readonly #deps: CiWatchDeps;
	readonly #loops = new Map<string, Loop>();

	constructor(deps: CiWatchDeps) {
		this.#deps = deps;
	}

	/** Watch a folder's list; `listener` gets what is known now and every change. Returns the way to stop. */
	watch(cwd: string, scope: CiScope, listener: Listener): () => void {
		const key = `${scope}\0${cwd}`;
		let loop = this.#loops.get(key);
		if (!loop) {
			const made: Loop = {
				cwd,
				scope,
				view: { answer: null, loading: true },
				listeners: new Set(),
				timer: undefined,
				seq: 0,
				busy: false,
				stop: () => {},
			};
			// Back on screen (shown again, or the window got the focus): look now.
			const back = () => {
				if (this.#deps.env.visible()) void this.#ask(made, false);
				else if (!this.#deps.background(made.scope)) this.#halt(made);
			};
			const stopVisibility = this.#deps.env.onVisibility(back);
			const stopFocus = this.#deps.env.onFocus(back);
			made.stop = () => {
				stopVisibility();
				stopFocus();
			};
			this.#loops.set(key, made);
			loop = made;
			void this.#ask(made, false, true);
		}
		const mine = loop;
		mine.listeners.add(listener);
		listener(mine.view);
		return () => {
			mine.listeners.delete(listener);
			if (mine.listeners.size > 0 || this.#loops.get(key) !== mine) return;
			this.#halt(mine);
			mine.stop();
			mine.seq++;
			this.#loops.delete(key);
		};
	}

	/** Look again now, whatever the last look's age (the Refresh button). */
	refresh(cwd: string, scope: CiScope): void {
		const loop = this.#loops.get(`${scope}\0${cwd}`);
		if (loop) void this.#ask(loop, true, true);
	}

	/** What is known of a list a loop watches (null: none does). */
	view(cwd: string, scope: CiScope): CiView | null {
		return this.#loops.get(`${scope}\0${cwd}`)?.view ?? null;
	}

	#halt(loop: Loop): void {
		if (loop.timer !== undefined) this.#deps.clearTimer(loop.timer);
		loop.timer = undefined;
	}

	/** `shown`: the person asked (the first look, Refresh): the tab shows that it is asking. */
	async #ask(loop: Loop, fresh: boolean, shown = false): Promise<void> {
		// A quiet look while one is under way would get the same answer.
		if (loop.busy && !fresh) return;
		const mine = ++loop.seq;
		loop.busy = true;
		this.#halt(loop);
		if (shown && !loop.view.loading) this.#set(loop, { ...loop.view, loading: true });
		const answer = await this.#deps.ask({ cwd: loop.cwd, scope: loop.scope, fresh }).catch(
			(e: unknown): CiAnswer<CiRuns> => ({
				ok: false,
				problem: "failed",
				message: e instanceof Error ? e.message : String(e),
				nextMs: 60_000,
			}),
		);
		// Stopped meanwhile, or a later ask (Refresh) has the say.
		if (mine !== loop.seq) return;
		loop.busy = false;
		const before = loop.view.answer;
		this.#set(loop, { answer, loading: false });
		if (loop.scope === "branch" && before?.ok && answer.ok && before.value.branch === answer.value.branch) {
			const done = finishedRuns(before.value.runs, answer.value.runs);
			if (done.length > 0) this.#deps.onFinished(loop.cwd, done);
		}
		if (this.#deps.env.visible() || this.#deps.background(loop.scope)) {
			const wait = Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, answer.nextMs));
			loop.timer = this.#deps.setTimer(() => {
				loop.timer = undefined;
				if (this.#deps.env.visible() || this.#deps.background(loop.scope)) void this.#ask(loop, false);
			}, wait);
		}
	}

	#set(loop: Loop, view: CiView): void {
		loop.view = view;
		for (const fn of loop.listeners) fn(view);
	}
}
