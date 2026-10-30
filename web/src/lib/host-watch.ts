/**
 * Who on this page shows the host's load, and what the server is to be told of it (`host_watch`). Pure: `lib/host.ts` gives
 * it the socket to say things on and the clock of a microtask to coalesce with.
 *
 * Several things show the load at once (the sidebar's line, its popover, the Host tab), and each asks for what it needs:
 * the server looks at the live pace while any shows the graphs, at its background pace while only the line does, and lists
 * processes while any of them shows the process table. A change is told once, however many watchers came and went in the
 * same tick (a component that re-mounts its effect with another `detail` or `procs` would otherwise say "off" and "on" in
 * a row), and nothing is told that the server already has.
 */

/** What one watcher asks of the server. */
export interface Wanted {
	/** It shows the graphs of the load (the sidebar's popover, the Host tab), not only the line of figures: the live pace. */
	detail: boolean;
	/** It shows the processes' share, which costs a listing of processes at each look. */
	procs: boolean;
}

/** What the page asks as a whole, as the server takes it. */
interface Told extends Wanted {
	on: boolean;
}

export class WatchBook {
	private readonly watchers = new Map<object, Wanted>();
	/** What the server was last told on this connection; null: nothing yet, or the connection is a new one. */
	private told: Told | null = null;
	private pending = false;

	constructor(
		/** Whether there is a connection to say it on: nothing is queued for a connection that is not there. */
		private readonly connected: () => boolean,
		private readonly send: (told: Told) => void,
		/** What a watcher no longer asks for (the processes): the page drops what it kept of it. */
		private readonly dropProcs: () => void,
		/** Runs `fn` after the current tick's synchronous work (a microtask). Not `queueMicrotask` itself: called as a method of the book it is an illegal invocation. */
		private readonly later: (fn: () => void) => void = (fn) => queueMicrotask(fn),
	) {}

	get size(): number {
		return this.watchers.size;
	}

	/** `owner` shows the load from now on, as `wanted` says. Returns whether it is the first to. */
	watch(owner: object, wanted: Wanted): boolean {
		const first = this.watchers.size === 0;
		this.watchers.set(owner, wanted);
		this.schedule();
		return first;
	}

	unwatch(owner: object): void {
		if (this.watchers.delete(owner)) this.schedule();
	}

	/** The connection is gone: the server forgot what this page watched with it, so the next connection is told afresh. */
	disconnected(): void {
		this.told = null;
	}

	/** A connection has come (again): tell the server what is watched. */
	reconnected(): void {
		this.told = null;
		this.schedule();
	}

	private schedule(): void {
		if (this.pending) return;
		this.pending = true;
		this.later(() => {
			this.pending = false;
			this.flush();
		});
	}

	private flush(): void {
		if (!this.connected()) return;
		const on = this.watchers.size > 0;
		const wanted = [...this.watchers.values()];
		const told: Told = {
			on,
			detail: on && wanted.some((w) => w.detail),
			procs: on && wanted.some((w) => w.procs),
		};
		const last = this.told;
		// A new connection that has nothing to watch has nothing to say either.
		if (last === null ? !on : last.on === told.on && last.detail === told.detail && last.procs === told.procs) return;
		this.told = told;
		this.send(told);
		if (last?.procs && !told.procs) this.dropProcs();
	}
}
