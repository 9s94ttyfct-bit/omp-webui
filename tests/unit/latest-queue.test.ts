import { expect, test } from "bun:test";
import { LatestQueue } from "../../server/offline/latest-queue.ts";

/**
 * The queue behind the context measurements (each an omp process and its MCP servers): one job at a time, and only
 * the newest request for each key counts. Jobs are finished by the test, so nothing here waits for time to pass.
 */

/** A job that the test finishes by hand, and that says when it starts and is stopped. */
function job(name: string, log: string[]) {
	const started = Promise.withResolvers<AbortSignal>();
	let finish: (answer: string) => void = () => {};
	const run = (signal: AbortSignal) => {
		log.push(`start ${name}`);
		started.resolve(signal);
		return new Promise<string>((resolve, reject) => {
			finish = resolve;
			signal.addEventListener("abort", () => reject(new Error("stopped")));
		}).finally(() => log.push(`end ${name}`));
	};
	return { run, started: started.promise, finish: (answer = name) => finish(answer) };
}

test("jobs run one at a time, in the order they were asked for", async () => {
	const queue = new LatestQueue<string>();
	const log: string[] = [];
	const a = job("a", log);
	const b = job("b", log);
	const first = queue.request("full", "1", a.run);
	const second = queue.request("light", "1", b.run);
	await a.started;
	expect(log).toEqual(["start a"]);
	a.finish();
	expect(await first).toBe("a");
	await b.started;
	b.finish();
	expect(await second).toBe("b");
	expect(log).toEqual(["start a", "end a", "start b", "end b"]);
});

test("a request for something else replaces the pending one before it starts: it never runs, and its asker gets the newest answer", async () => {
	const queue = new LatestQueue<string>();
	const log: string[] = [];
	const hold = job("hold", log);
	const x = job("x", log);
	const y = job("y", log);
	const z = job("z", log);
	const held = queue.request("full", "1", hold.run);
	const rx = queue.request("light", "1", x.run);
	const ry = queue.request("light", "2", y.run);
	const rz = queue.request("light", "3", z.run);
	// The same thing again joins the job instead of starting another.
	expect(queue.request("light", "3", z.run)).toBe(rz);
	await hold.started;
	hold.finish();
	await held;
	await z.started;
	z.finish("newest");
	expect(await Promise.all([rx, ry, rz])).toEqual(["newest", "newest", "newest"]);
	expect(log).toEqual(["start hold", "end hold", "start z", "end z"]);
});

test("a job that runs is told to stop when it is replaced, and the next one starts only after it has ended", async () => {
	const queue = new LatestQueue<string>();
	const log: string[] = [];
	const a = job("a", log);
	const b = job("b", log);
	const first = queue.request("light", "1", a.run);
	const signal = await a.started;
	expect(signal.aborted).toBe(false);
	const second = queue.request("light", "2", b.run);
	expect(signal.aborted).toBe(true);
	await b.started;
	expect(log).toEqual(["start a", "end a", "start b"]);
	b.finish("B");
	expect(await Promise.all([first, second])).toEqual(["B", "B"]);
});

test("keys are independent: replacing one side's job leaves the other's alone", async () => {
	const queue = new LatestQueue<string>();
	const log: string[] = [];
	const full = job("full", log);
	const light = job("light", log);
	const first = queue.request("full", "1", full.run);
	const second = queue.request("light", "1", light.run);
	const signal = await full.started;
	queue.request("light", "2", async () => "replacement");
	expect(signal.aborted).toBe(false);
	full.finish();
	expect(await first).toBe("full");
	expect(await second).toBe("replacement");
});

test("a job that fails fails its asker, and the next one runs", async () => {
	const queue = new LatestQueue<string>();
	const bad = queue.request("a", "1", () => Promise.reject(new Error("boom")));
	const good = queue.request("b", "1", async () => "ok");
	await expect(bad).rejects.toThrow("boom");
	expect(await good).toBe("ok");
});

test("a finished job is forgotten: the same thing asked for later is run again", async () => {
	const queue = new LatestQueue<string>();
	let runs = 0;
	const run = async () => `run ${++runs}`;
	expect(await queue.request("a", "1", run)).toBe("run 1");
	expect(await queue.request("a", "1", run)).toBe("run 2");
});
