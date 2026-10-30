import { statSync } from "node:fs";

/**
 * A value `read` gets from omp (an `omp config get`: a whole omp start, about 0.15 s and 140 MB) that depends on the
 * config file `file` and nothing else the page could change. Whoever asks while the file is as it was shares one run
 * (a reconnect asks once for omp's own value and once for every conversation shown), and a value that was read is kept
 * for as long as the file is as it was, so a popover that opens again costs no omp at all.
 *
 * What the file looks like is asked of the file system on every question (its size, change time and identity), not
 * remembered from a watcher or a timer: a change made in the terminal is the next question's answer, and a question
 * never joins a read that began before the file changed. An answer `read` could not give (null) is not kept.
 */
export class ConfigRead<T> {
	#kept: { stamp: string; value: T } | null = null;
	#running: { stamp: string; value: Promise<T | null> } | null = null;

	constructor(
		private readonly file: string,
		private readonly read: () => Promise<T | null>,
	) {}

	/** What the file is now: "missing" until it exists. */
	private stamp(): string {
		try {
			const s = statSync(this.file, { bigint: true });
			return `${s.ino}:${s.size}:${s.mtimeNs}`;
		} catch {
			return "missing";
		}
	}

	get(): Promise<T | null> {
		const stamp = this.stamp();
		if (this.#kept?.stamp === stamp) return Promise.resolve(this.#kept.value);
		if (this.#running?.stamp === stamp) return this.#running.value;
		const run = {
			stamp,
			value: this.read().then((value) => {
				// Only the newest read says what the file holds now: an older one, finished late, would put its value back.
				if (value !== null && this.#running === run) this.#kept = { stamp, value };
				return value;
			}),
		};
		this.#running = run;
		const done = () => {
			if (this.#running === run) this.#running = null;
		};
		run.value.then(done, done);
		return run.value;
	}
}
