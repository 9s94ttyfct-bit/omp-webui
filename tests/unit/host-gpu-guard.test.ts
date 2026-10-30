import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MIN_BACKGROUND_MS, MIN_LIVE_MS, paceFrom } from "../../server/host.ts";
import { GPU_MARKER, guardedGpu } from "../../server/host-gpu-guard.ts";
import { systemReader } from "../../server/host-read.ts";
import { tempDir } from "../support/temp-dirs.ts";

/**
 * The GPU's reading is isolated from the rest of a look (server/host-gpu-guard.ts): IOKit is asked in a thread of its own,
 * each read is awaited with a deadline, a thread that hangs, throws or ends is given up on for the run and for the next start,
 * and the GPU can be turned off. The threads here are stand-ins written in the tests (a blob each): one that answers, one that
 * never does, one blocked as a driver call would block it, one that throws, one that ends. Directories are fresh temporary ones.
 *
 * Real time passes in the tests of a deadline (`timeoutMs` is a few tens of milliseconds): what is under test is that the
 * server stops waiting, which no fake clock can show for a thread that is really blocked.
 */

const dir = () => tempDir("ompw-host-gpu-");
const marker = (d: string) => readFileSync(join(d, GPU_MARKER), "utf8").trim();
const gpu = (util: number) => ({ name: "Fake GPU", cores: 8, util });

/** A thread that runs `body` (the script of a worker): `self.onmessage` answers `{ id }` requests. */
const thread = (body: string) => () => new Worker(URL.createObjectURL(new Blob([body], { type: "text/javascript" })));

const ANSWERS = (gpus: string) => `self.onmessage = (e) => postMessage({ id: e.data.id, ok: true, gpus: ${gpus} });`;
const WORKERS = {
	/** Util 10, then 11, 12… */
	answers: `let n = 0; self.onmessage = (e) => postMessage({ id: e.data.id, ok: true, gpus: [{ name: "Fake GPU", cores: 8, util: 10 + n++ }] });`,
	/** A computer with no probe. */
	none: ANSWERS("null"),
	/** A computer with a probe and no accelerator. */
	empty: ANSWERS("[]"),
	/** An exception in the probe: the thread says so, once, then answers. */
	throwsOnce: `let n = 0; self.onmessage = (e) => postMessage(n++ === 0 ? { id: e.data.id, ok: false, error: "driver said no" } : { id: e.data.id, ok: true, gpus: [{ name: "Fake GPU", cores: 8, util: 7 }] });`,
	/** Never answers. */
	silent: "self.onmessage = () => {};",
	/** Blocked where a driver call would block it (bounded, so that the test run ends). */
	blocked: "self.onmessage = () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500); };",
	/** An exception out of the thread's own code. */
	crashes: `self.onmessage = () => { throw new Error("boom"); };`,
	/** The thread ends. */
	exits: "self.onmessage = () => { process.exit(3); };",
} as const;

/** `console.warn` quiet, and what it was told. */
function quiet() {
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	return { told: () => warn.mock.calls.map((c) => String(c[0])), done: () => warn.mockRestore() };
}

const FAST = { timeoutMs: 150, startMs: 150 };

describe("starting the probe", () => {
	test("is on the first read, not when the guard is made", async () => {
		let started = 0;
		const g = guardedGpu({
			spawn: () => {
				started++;
				return thread(WORKERS.answers)();
			},
		});
		try {
			expect(started).toBe(0);
			expect(await g.read()).toEqual([gpu(10)]);
			expect(await g.read()).toEqual([gpu(11)]);
			expect(started).toBe(1);
		} finally {
			g.close();
		}
	});

	test("never, when it is turned off (and no marker is written)", async () => {
		const d = dir();
		let started = 0;
		const g = guardedGpu({
			enabled: false,
			markerDir: d,
			spawn: () => {
				started++;
				return thread(WORKERS.answers)();
			},
		});
		expect(await g.read()).toBeNull();
		expect(started).toBe(0);
		expect(() => readFileSync(join(d, GPU_MARKER))).toThrow();
	});

	test("a computer with no probe, or with no accelerator, reads as no GPU and is no error; the thread of the first is stopped", async () => {
		const q = quiet();
		try {
			const none = guardedGpu({ spawn: thread(WORKERS.none) });
			expect(await none.read()).toBeNull();
			expect(await none.read()).toBeNull();
			const empty = guardedGpu({ spawn: thread(WORKERS.empty) });
			expect(await empty.read()).toBeNull();
			empty.close();
			expect(q.told()).toEqual([]);
		} finally {
			q.done();
		}
	});

	test("a thread that cannot be started is a GPU left out, told once", async () => {
		const q = quiet();
		try {
			const d = dir();
			const g = guardedGpu({
				markerDir: d,
				spawn: () => {
					throw new Error("no threads");
				},
			});
			expect(await g.read()).toBeNull();
			expect(await g.read()).toBeNull();
			expect(q.told()).toHaveLength(1);
			expect(q.told()[0]).toContain("no threads");
			expect(marker(d)).toBe("probing");
		} finally {
			q.done();
		}
	});
});

describe("a probe that throws", () => {
	test("costs the GPU of that look and is told once; the next look is a GPU again", async () => {
		const q = quiet();
		const d = dir();
		const g = guardedGpu({ markerDir: d, spawn: thread(WORKERS.throwsOnce) });
		try {
			expect(await g.read()).toBeNull();
			expect(q.told()).toHaveLength(1);
			expect(q.told()[0]).toContain("gpu: driver said no");
			expect(await g.read()).toEqual([gpu(7)]);
			// The thread is there and said so: no crash, and the mark is `ok`.
			expect(marker(d)).toBe("ok");
		} finally {
			g.close();
			q.done();
		}
	});
});

describe("a thread that does not answer, fails or ends", () => {
	test("a silent one is given up on at the deadline: no GPU for the look, nothing asked again, told once, the mark left at probing", async () => {
		const q = quiet();
		const d = dir();
		const g = guardedGpu({ ...FAST, markerDir: d, spawn: thread(WORKERS.silent) });
		try {
			const began = performance.now();
			expect(await g.read()).toBeNull();
			expect(performance.now() - began).toBeGreaterThanOrEqual(100);
			expect(marker(d)).toBe("probing");
			// Given up on for the run: the next reads do not wait for anything.
			const again = performance.now();
			expect(await g.read()).toBeNull();
			expect(await g.read()).toBeNull();
			expect(performance.now() - again).toBeLessThan(100);
			expect(q.told()).toHaveLength(1);
			expect(q.told()[0]).toContain("no answer in 150 ms");
			expect(q.told()[0]).toContain("OMP_WEBUI_HOST_GPU=1");
		} finally {
			g.close();
			q.done();
		}
	});

	test("one blocked as a driver call blocks it leaves the server's own thread free while it is waited for", async () => {
		const q = quiet();
		const g = guardedGpu({ timeoutMs: 400, startMs: 400, spawn: thread(WORKERS.blocked) });
		let ticks = 0;
		const timer = setInterval(() => ticks++, 20);
		try {
			expect(await g.read()).toBeNull();
			// The server's thread kept running timers for the whole wait (it would have counted none if it had been the one blocked).
			expect(ticks).toBeGreaterThanOrEqual(8);
		} finally {
			clearInterval(timer);
			g.close();
			q.done();
		}
	});

	test("a thread that throws out of its own code is given up on, as the silent one is", async () => {
		const q = quiet();
		const d = dir();
		const g = guardedGpu({ ...FAST, markerDir: d, spawn: thread(WORKERS.crashes) });
		try {
			expect(await g.read()).toBeNull();
			expect(marker(d)).toBe("probing");
			expect(await g.read()).toBeNull();
			expect(q.told()).toHaveLength(1);
			expect(q.told()[0]).toMatch(/left out|failed|boom/);
		} finally {
			g.close();
			q.done();
		}
	});

	test("a thread that ends is given up on, as the silent one is", async () => {
		const q = quiet();
		const d = dir();
		const g = guardedGpu({ ...FAST, markerDir: d, spawn: thread(WORKERS.exits) });
		try {
			expect(await g.read()).toBeNull();
			expect(marker(d)).toBe("probing");
			expect(await g.read()).toBeNull();
			expect(q.told()).toHaveLength(1);
		} finally {
			g.close();
			q.done();
		}
	});

	test("one that has answered and then stops answering is given up on too, and the mark goes back to probing", async () => {
		const q = quiet();
		const d = dir();
		// Answers the first request, then never.
		const g = guardedGpu({
			...FAST,
			markerDir: d,
			spawn: thread(
				`let n = 0; self.onmessage = (e) => { if (n++ === 0) postMessage({ id: e.data.id, ok: true, gpus: [{ name: "Fake GPU", cores: 8, util: 3 }] }); };`,
			),
		});
		try {
			expect(await g.read()).toEqual([gpu(3)]);
			expect(marker(d)).toBe("ok");
			expect(await g.read()).toBeNull();
			expect(marker(d)).toBe("probing");
			expect(q.told()).toHaveLength(1);
		} finally {
			g.close();
			q.done();
		}
	});

	test("takes only the GPU out of a look: CPU and memory are still read (macOS)", async () => {
		if (process.platform !== "darwin") return;
		const q = quiet();
		const d = dir();
		const reader = systemReader({ gpu: { ...FAST, markerDir: d, spawn: thread(WORKERS.silent) } });
		try {
			const look = await reader.read();
			expect(look.gpus).toBeNull();
			expect(look.cpu.user + look.cpu.sys + look.cpu.idle).toBeGreaterThan(0);
			expect(look.memUsed).not.toBeNull();
			expect(look.pressure).not.toBeNull();
			expect(marker(d)).toBe("probing");
			// And the look after it is as quick as one without a GPU.
			const began = performance.now();
			const next = await reader.read();
			expect(next.gpus).toBeNull();
			expect(next.memUsed).not.toBeNull();
			expect(performance.now() - began).toBeLessThan(1000);
		} finally {
			reader.close?.();
			q.done();
		}
	});
});

describe("the crash marker", () => {
	test("says probing while the thread is started and asked, and ok once the first read has come back", async () => {
		const d = dir();
		let during = "";
		const g = guardedGpu({
			markerDir: d,
			spawn: () => {
				during = marker(d);
				return thread(WORKERS.answers)();
			},
		});
		try {
			await g.read();
			expect(during).toBe("probing");
			expect(marker(d)).toBe("ok");
		} finally {
			g.close();
		}
	});

	test("a first read that gives no accelerator is no crash", async () => {
		const d = dir();
		const g = guardedGpu({ markerDir: d, spawn: thread(WORKERS.empty) });
		try {
			await g.read();
			expect(marker(d)).toBe("ok");
		} finally {
			g.close();
		}
	});

	test("a start that finds probing knows the last one did not get through: the GPU is left out, said once, nothing started", async () => {
		const q = quiet();
		try {
			const d = dir();
			writeFileSync(join(d, GPU_MARKER), "probing\n");
			let started = 0;
			const g = guardedGpu({
				markerDir: d,
				spawn: () => {
					started++;
					return thread(WORKERS.answers)();
				},
			});
			expect(await g.read()).toBeNull();
			expect(await g.read()).toBeNull();
			expect(started).toBe(0);
			expect(q.told()).toHaveLength(1);
			expect(q.told()[0]).toContain("OMP_WEBUI_HOST_GPU=1");
			// It stays out at the next start too: nothing has cleared it.
			expect(marker(d)).toBe("probing");
		} finally {
			q.done();
		}
	});

	test("retrying (OMP_WEBUI_HOST_GPU=1) starts it anyway, and a good first read clears the mark", async () => {
		const d = dir();
		writeFileSync(join(d, GPU_MARKER), "probing\n");
		const g = guardedGpu({ markerDir: d, retry: true, spawn: thread(WORKERS.answers) });
		try {
			expect(await g.read()).toEqual([gpu(10)]);
			expect(marker(d)).toBe("ok");
		} finally {
			g.close();
		}
		const next = guardedGpu({ markerDir: d, spawn: thread(WORKERS.answers) });
		try {
			expect(await next.read()).toEqual([gpu(10)]);
		} finally {
			next.close();
		}
	});

	test("turned off, a crash mark is not read at all", async () => {
		const q = quiet();
		try {
			const d = dir();
			writeFileSync(join(d, GPU_MARKER), "probing\n");
			expect(await guardedGpu({ enabled: false, markerDir: d, spawn: thread(WORKERS.answers) }).read()).toBeNull();
			expect(q.told()).toEqual([]);
		} finally {
			q.done();
		}
	});

	test("a marker that cannot be written is no marker: the thread is not started without one", async () => {
		const q = quiet();
		try {
			let started = 0;
			const g = guardedGpu({
				markerDir: join(dir(), "no", "such", "directory"),
				spawn: () => {
					started++;
					return thread(WORKERS.answers)();
				},
			});
			expect(await g.read()).toBeNull();
			expect(started).toBe(0);
			expect(q.told()).toHaveLength(1);
		} finally {
			q.done();
		}
	});
});

describe("the real thread (macOS)", () => {
	test("answers with this Mac's accelerators from a thread of its own, and is stopped by close()", async () => {
		if (process.platform !== "darwin") return;
		const g = guardedGpu();
		try {
			const readings = await g.read();
			// A Mac with no accelerator (a virtual machine) has no GPU, which is no failure.
			for (const r of readings ?? []) {
				expect(r.util).toBeGreaterThanOrEqual(0);
				expect(r.util).toBeLessThanOrEqual(100);
			}
			expect(await g.read()).toEqual(expect.anything());
		} finally {
			g.close();
		}
		expect(await g.read()).toBeNull();
	});
});

describe("the pace settings", () => {
	test("a pace under the floor is the floor: a millisecond would start a process in a loop", () => {
		expect(paceFrom("1", 2000, MIN_LIVE_MS)).toBe(MIN_LIVE_MS);
		expect(paceFrom("-5", 2000, MIN_LIVE_MS)).toBe(MIN_LIVE_MS);
		expect(paceFrom("999", 10_000, MIN_BACKGROUND_MS)).toBe(MIN_BACKGROUND_MS);
	});

	test("a pace at or over the floor is kept", () => {
		expect(paceFrom("250", 2000, MIN_LIVE_MS)).toBe(250);
		expect(paceFrom("3000", 2000, MIN_LIVE_MS)).toBe(3000);
		expect(paceFrom("1000", 10_000, MIN_BACKGROUND_MS)).toBe(1000);
	});

	test("what is not a number, or is zero, is the default", () => {
		for (const v of [undefined, "", "0", "abc", "NaN", "Infinity"]) expect(paceFrom(v, 2000, MIN_LIVE_MS)).toBe(2000);
	});

	test("the floors are 250 ms and 1 s", () => {
		expect([MIN_LIVE_MS, MIN_BACKGROUND_MS]).toEqual([250, 1000]);
	});
});
