/** What a job comes to when a newer request replaced it; the callers never see it. */
const REPLACED = Symbol("replaced");

interface Job<T> {
	/** What the job is for: a request for the same thing joins it. */
	fp: string;
	abort: AbortController;
	result: Promise<T>;
}

/**
 * Work that runs one job at a time, in the order it was asked for, in which only the newest request for each `key`
 * counts. A request for what is already pending under its key joins that job. A request for something else
 * replaces the pending job: its signal is aborted, so a job that runs is told to stop (and one that has not started
 * never does), and whoever asked for it is given the newer job's answer instead.
 *
 * Context measurements use it: each is an omp process with its MCP servers (about 200 MB), and a few clicks in
 * Settings change what is to be measured a few times over.
 */
export class LatestQueue<T> {
	private tail: Promise<unknown> = Promise.resolve();
	private readonly jobs = new Map<string, Job<T>>();

	/** `run` is given the signal that aborts when this request is replaced; what it does after that is not used. */
	request(key: string, fp: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
		const pending = this.jobs.get(key);
		if (pending?.fp === fp) return pending.result;
		pending?.abort.abort();
		const abort = new AbortController();
		const finished = this.tail.then(async () => {
			if (abort.signal.aborted) return REPLACED;
			try {
				const answer = await run(abort.signal);
				return abort.signal.aborted ? REPLACED : answer;
			} catch (e) {
				if (abort.signal.aborted) return REPLACED;
				throw e;
			}
		});
		// The next job starts when this one is over, however it ended.
		this.tail = finished.catch(() => {});
		const job: Job<T> = {
			fp,
			abort,
			result: finished.then((answer) => {
				if (answer !== REPLACED) return answer;
				// Replaced: the job that replaced it is still pending, since it cannot have started before this one ended.
				const newer = this.jobs.get(key);
				return newer ? newer.result : Promise.reject(new Error("The request was replaced by a newer one."));
			}),
		};
		this.jobs.set(key, job);
		const done = () => {
			if (this.jobs.get(key) === job) this.jobs.delete(key);
		};
		job.result.then(done, done);
		return job.result;
	}
}
