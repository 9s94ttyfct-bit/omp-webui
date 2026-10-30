import { describe, expect, spyOn, test } from "bun:test";
import { HostSampler } from "../../server/host.ts";
import { openGpuProbe } from "../../server/host-gpu.ts";
import type { PsRow } from "../../server/host-parse.ts";
import { type HostReader, type Reading, systemReader } from "../../server/host-read.ts";
import type { ServerMessage } from "../../shared/protocol.ts";

/** How many accelerators this computer's probe reads: 0 where there is none (not macOS, or a Mac with no GPU statistics). */
const accelerators = openGpuProbe()?.read().length ?? 0;

/** A reader that says what the test wants it to, one reading per look, and a clock the test moves. */
class Fake implements HostReader {
	readonly platform = "darwin";
	now = 1_000_000_000;
	/** Cumulative counters: each look adds `busy` and `idle`. */
	user = 0;
	idle = 0;
	gpus: Reading["gpus"] = [{ name: "Test GPU", cores: 8, util: 25 }];
	memUsed: number | null = 8_000;
	pressure: Reading["pressure"] = 0;
	rows: PsRow[] = [];
	listingFails = false;
	reads = 0;
	look(busy: number, idle: number, advanceMs: number): void {
		this.user += busy;
		this.idle += idle;
		this.now += advanceMs;
	}
	async read(): Promise<Reading> {
		this.reads++;
		return {
			cpu: { user: this.user, sys: 0, idle: this.idle },
			memUsed: this.memUsed,
			memTotal: 16_000,
			pressure: this.pressure,
			gpus: this.gpus,
		};
	}
	async processes(): Promise<PsRow[]> {
		if (this.listingFails) throw new Error("ps is gone");
		return this.rows;
	}
}

const sampler = (fake: Fake, over: Partial<ConstructorParameters<typeof HostSampler>[0]> = {}) =>
	new HostSampler({ liveMs: 2000, backgroundMs: 10_000, reader: fake, now: () => fake.now, ...over });

const collect = () => {
	const got: ServerMessage[] = [];
	return { got, send: (m: ServerMessage) => void got.push(m) };
};

describe("one look", () => {
	test("the first look only measures from: CPU time has nothing to be a share of yet", async () => {
		const fake = new Fake();
		const s = sampler(fake);
		expect(await s.sample()).toBeNull();
		expect(s.history().fine.t).toEqual([]);
	});

	test("the next look records CPU share, the busiest GPU, memory as a share of all of it, and the pressure", async () => {
		const fake = new Fake();
		fake.gpus = [
			{ name: "Integrated", cores: null, util: 10 },
			{ name: "Discrete", cores: 30, util: 70 },
		];
		fake.pressure = 1;
		const s = sampler(fake);
		await s.sample();
		fake.look(300, 700, 2000);
		expect(await s.sample()).toEqual({ t: fake.now, cpu: 30, gpu: 70, mem: 50, pressure: 1 });
		const h = s.history();
		expect(h.fine.cpu).toEqual([30]);
		expect(h.info.gpu).toEqual({ name: "Discrete", cores: 30 });
		expect(h.info.pressure).toBe(true);
	});

	test("a computer with no GPU or pressure figure has none recorded, and says so in its info", async () => {
		const fake = new Fake();
		fake.gpus = null;
		fake.pressure = null;
		const s = sampler(fake);
		await s.sample();
		fake.look(10, 90, 2000);
		const p = await s.sample();
		expect(p?.gpu).toBeNull();
		expect(p?.pressure).toBeNull();
		expect(s.info().gpu).toBeNull();
		expect(s.info().pressure).toBe(false);
	});

	test("a failed read of memory is a null, not a zero", async () => {
		const fake = new Fake();
		fake.memUsed = null;
		const s = sampler(fake);
		await s.sample();
		fake.look(10, 90, 2000);
		expect((await s.sample())?.mem).toBeNull();
	});
});

describe("history", () => {
	test("the fine series keeps the last hour only", async () => {
		const fake = new Fake();
		const s = sampler(fake);
		await s.sample();
		for (let i = 0; i < 3; i++) {
			fake.look(10, 90, 1_800_000);
			await s.sample();
		}
		// Looks 30, 60 and 90 minutes after the baseline: all three are within the hour before the last (the edge counts).
		const t = s.history().fine.t;
		expect(t.every((x) => x >= fake.now - 3_600_000)).toBe(true);
		expect(t.length).toBe(3);
		// A millisecond more than half an hour later, the hour reaches back to just after the 60-minute look.
		fake.now += 1_800_001;
		expect(s.history().fine.t.length).toBe(1);
	});

	test("a finished minute joins the coarse series as the mean of its looks; the minute under way is not in it", async () => {
		const fake = new Fake();
		fake.now = 60_000 * 1000 + 1000; // one second into a minute
		const s = sampler(fake);
		await s.sample();
		fake.look(200, 800, 10_000);
		await s.sample(); // cpu 20
		fake.look(400, 600, 10_000);
		await s.sample(); // cpu 40
		expect(s.history().coarse.t).toEqual([]);
		fake.look(0, 1000, 60_000);
		const sent = collect();
		s.watch({}, { detail: false, procs: false, send: sent.send });
		await s.sample(); // cpu 0, in the next minute: finishes the first
		const coarse = s.history().coarse;
		expect(coarse.t).toEqual([60_000 * 1000]);
		expect(coarse.cpu).toEqual([30]);
		const last = sent.got.at(-1);
		expect(last).toMatchObject({ t: "host_sample", minute: { t: 60_000 * 1000, cpu: 30 } });
	});
});

describe("telling the pages", () => {
	test("each look is sent to every watcher; only those who asked for them get the processes", async () => {
		const fake = new Fake();
		fake.rows = [
			{ pid: 10, ppid: 1, cpu: 5, rss: 2048 },
			{ pid: 11, ppid: 10, cpu: 1, rss: 1024 },
			{ pid: 5, ppid: 1, cpu: 0.5, rss: 512 },
		];
		const s = sampler(fake, { pids: () => ({ omp: [10], relay: [5] }) });
		const plain = collect();
		const full = collect();
		s.watch({}, { detail: false, procs: false, send: plain.send });
		s.watch({}, { detail: false, procs: true, send: full.send });
		await s.sample();
		fake.look(100, 900, 2000);
		// The first listing is what the second is measured against: it has no share yet.
		await s.sample();
		fake.look(100, 900, 2000);
		fake.rows = fake.rows.map((r) => (r.pid === 10 ? { ...r, cpu: r.cpu + 2 } : r));
		await s.sample();
		// The baseline look sends nothing: what the page hears is the second look and the third.
		const [a, a2] = plain.got;
		const [first, b] = full.got;
		expect(a).toMatchObject({ t: "host_sample", point: { cpu: 10 } });
		expect(a2 && "procs" in a2).toBe(false);
		expect(first?.t === "host_sample" && first.procs?.find((p) => p.id === "omp")?.cpu).toBeNull();
		if (b?.t !== "host_sample" || !b.procs) throw new Error("the page that asked for processes got none");
		const byId = Object.fromEntries(b.procs.map((p) => [p.id, p]));
		expect(Object.keys(byId).sort()).toEqual(["omp", "relay", "server"]);
		// omp's group is 10 and its child 11: 2 s of CPU (10's) in the 2 s between the listings is one core.
		expect(byId.omp).toMatchObject({ count: 1, cpu: 100, rss: 3072 });
		expect(byId.relay).toMatchObject({ count: 1, cpu: 0, rss: 512 });
		expect(byId.server?.count).toBe(1);
		expect(byId.server?.rss).toBeGreaterThan(0);
	});

	test("a page that stopped watching is told nothing more; with nobody watching nothing of the processes is kept or computed", async () => {
		const fake = new Fake();
		const s = sampler(fake);
		const page = {};
		const sent = collect();
		s.watch(page, { detail: false, procs: true, send: sent.send });
		await s.sample();
		fake.look(10, 90, 2000);
		await s.sample();
		expect(sent.got).toHaveLength(1);
		s.unwatch(page);
		expect(s.watchers).toBe(0);
		fake.look(10, 90, 2000);
		await s.sample();
		expect(sent.got).toHaveLength(1);
		expect(s.history().procs).toBeNull();
	});

	test("a process listing that fails leaves the server's own figures and nothing of the rest", async () => {
		const fake = new Fake();
		fake.listingFails = true;
		const s = sampler(fake, { pids: () => ({ omp: [10], relay: [] }) });
		const sent = collect();
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			s.watch({}, { detail: false, procs: true, send: sent.send });
			await s.sample();
			fake.look(10, 90, 2000);
			await s.sample();
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
		const m = sent.got[0];
		if (m?.t !== "host_sample") throw new Error("no sample");
		expect(m.procs?.map((p) => p.id)).toEqual(["server"]);
	});

	test("a group with no process is not listed (no relay: nothing to show)", async () => {
		const fake = new Fake();
		const s = sampler(fake, { pids: () => ({ omp: [], relay: [] }) });
		const sent = collect();
		s.watch({}, { detail: false, procs: true, send: sent.send });
		await s.sample();
		fake.look(10, 90, 2000);
		await s.sample();
		const m = sent.got[0];
		expect(m?.t === "host_sample" && m.procs?.map((p) => p.id)).toEqual(["server"]);
	});
});

/** The sampler's timer, driven by the test: what is armed and for how long, and firing it by hand. */
class Timers {
	armed: { fn: () => void; ms: number; live: boolean }[] = [];
	schedule = (fn: () => void, ms: number): (() => void) => {
		const entry = { fn, ms, live: true };
		this.armed.push(entry);
		return () => {
			entry.live = false;
		};
	};
	/** The delay of the timer that is armed now; null when none is. */
	get delay(): number | null {
		return this.armed.findLast((e) => e.live)?.ms ?? null;
	}
	/** Fire the armed timer, as the clock would. */
	fire(): void {
		const entry = this.armed.findLast((e) => e.live);
		if (!entry) throw new Error("no timer is armed");
		entry.live = false;
		entry.fn();
	}
}

/** Let every promise that can settle without waiting for a clock do so (a look is a few awaits long). */
const settle = () => new Promise<void>((r) => setImmediate(r));

describe("the pace", () => {
	const make = () => {
		const fake = new Fake();
		const timers = new Timers();
		const s = sampler(fake, { liveMs: 2000, backgroundMs: 10_000, schedule: timers.schedule });
		return { fake, timers, s };
	};

	test("the first look only measures from, the first figure follows a second later, then looks come at the background pace", async () => {
		const { fake, timers, s } = make();
		s.start();
		await settle();
		expect(fake.reads).toBe(1);
		expect(s.history().fine.t).toEqual([]);
		expect(timers.delay).toBe(1000);
		fake.look(100, 900, 1000);
		timers.fire();
		await settle();
		expect(s.history().fine.t).toHaveLength(1);
		expect(timers.delay).toBe(10_000);
	});

	test("a page that shows the graphs brings the next look forward to the live pace, and its leaving puts the background pace back", async () => {
		const { fake, timers, s } = make();
		s.start();
		await settle();
		fake.look(100, 900, 1000);
		timers.fire();
		await settle();
		const page = {};
		s.watch(page, { detail: true, procs: false, send: () => {} });
		expect(timers.delay).toBe(2000);
		fake.look(100, 900, 2000);
		timers.fire();
		await settle();
		expect(timers.delay).toBe(2000);
		s.unwatch(page);
		fake.look(100, 900, 2000);
		timers.fire();
		await settle();
		expect(timers.delay).toBe(10_000);
	});

	test("the sidebar's line alone keeps the background pace: no graphs, no reason to look every 2 s", async () => {
		const { fake, timers, s } = make();
		s.start();
		await settle();
		fake.look(100, 900, 1000);
		timers.fire();
		await settle();
		// Nine seconds after the last look: the line's next one is a second away, as the background pace says.
		fake.now += 9000;
		s.watch({}, { detail: false, procs: false, send: () => {} });
		expect(timers.delay).toBe(1000);
		fake.look(100, 900, 1000);
		timers.fire();
		await settle();
		expect(timers.delay).toBe(10_000);
		expect(s.watchers).toBe(1);
	});

	test("a page that opens the graphs on top of the line takes the live pace up; the line left behind alone gives it back", async () => {
		const { fake, timers, s } = make();
		s.start();
		await settle();
		fake.look(100, 900, 1000);
		timers.fire();
		await settle();
		const line = {};
		const graphs = {};
		s.watch(line, { detail: false, procs: false, send: () => {} });
		expect(timers.delay).toBe(10_000);
		// The popover opens four seconds later: what the live pace says is due is brought forward.
		fake.now += 4000;
		s.watch(graphs, { detail: true, procs: false, send: () => {} });
		expect(timers.delay).toBe(300);
		fake.look(100, 900, 300);
		timers.fire();
		await settle();
		expect(timers.delay).toBe(2000);
		// The popover closes: the line is all that is left, and the pace is the background one again.
		s.unwatch(graphs);
		fake.look(100, 900, 2000);
		timers.fire();
		await settle();
		expect(timers.delay).toBe(10_000);
	});

	test("a page that arrives long after the last look is not given a CPU share of a few milliseconds, nor made to wait the whole pace it asks for", async () => {
		const { fake, timers, s } = make();
		s.start();
		await settle();
		fake.look(100, 900, 1000);
		timers.fire();
		await settle();
		fake.now += 9000;
		// The graphs, due 7 s ago at the live pace: 300 ms is the soonest a look may follow another.
		s.watch({}, { detail: true, procs: false, send: () => {} });
		expect(timers.delay).toBe(300);
		// The line, due 1 s ago at the background pace: that second, not the whole 10 s counted from when the page came.
		const line = make();
		line.s.start();
		await settle();
		line.fake.look(100, 900, 1000);
		line.timers.fire();
		await settle();
		line.fake.now += 9000;
		line.s.watch({}, { detail: false, procs: false, send: () => {} });
		expect(line.timers.delay).toBe(1000);
	});

	test("a second page changes nothing about the pace; only the first one starts it", async () => {
		const { fake, timers, s } = make();
		s.start();
		await settle();
		fake.look(100, 900, 1000);
		timers.fire();
		await settle();
		s.watch({}, { detail: false, procs: false, send: () => {} });
		const armed = timers.armed.length;
		s.watch({}, { detail: false, procs: true, send: () => {} });
		expect(timers.armed.length).toBe(armed);
		expect(s.watchers).toBe(2);
	});

	test("stopped, it looks no more, even for a timer that was already on its way", async () => {
		const { fake, timers, s } = make();
		s.start();
		await settle();
		const pending = timers.armed.findLast((e) => e.live);
		s.stop();
		expect(timers.delay).toBeNull();
		const reads = fake.reads;
		pending?.fn();
		await settle();
		expect(fake.reads).toBe(reads);
		expect(s.running).toBe(false);
	});

	test("a look still under way is not started again over it", async () => {
		const fake = new Fake();
		const timers = new Timers();
		const gate = Promise.withResolvers<void>();
		let inFlight = 0;
		let overlapped = false;
		let slow = false;
		const s = new HostSampler({
			liveMs: 5,
			backgroundMs: 5,
			now: () => fake.now,
			schedule: timers.schedule,
			reader: {
				platform: "darwin",
				async read() {
					if (++inFlight > 1) overlapped = true;
					if (slow) await gate.promise;
					inFlight--;
					return fake.read();
				},
				processes: async () => [],
			},
		});
		s.start();
		await settle();
		slow = true;
		const due = timers.armed.findLast((e) => e.live);
		timers.fire();
		await settle();
		// The timer fires again while the look is waiting on the machine.
		due?.fn();
		await settle();
		expect(overlapped).toBe(false);
		expect(fake.reads).toBe(1);
		gate.resolve();
		await settle();
		expect(fake.reads).toBe(2);
		expect(timers.delay).not.toBeNull();
	});
});

describe("the computer's own reader", () => {
	test("reads this machine: CPU counters, and memory within the machine's", async () => {
		const reader = systemReader();
		const a = await reader.read();
		const b = await reader.read();
		// The counters only ever count up (a share is made of the difference).
		expect(b.cpu.user).toBeGreaterThanOrEqual(a.cpu.user);
		expect(b.cpu.sys).toBeGreaterThanOrEqual(a.cpu.sys);
		expect(b.cpu.idle).toBeGreaterThanOrEqual(a.cpu.idle);
		expect(b.cpu.user + b.cpu.sys + b.cpu.idle).toBeGreaterThan(0);
		expect(b.memTotal).toBeGreaterThan(0);
		if (b.memUsed !== null) {
			expect(b.memUsed).toBeGreaterThan(0);
			expect(b.memUsed).toBeLessThanOrEqual(b.memTotal);
		}
		if (process.platform === "darwin") {
			expect(b.memUsed).not.toBeNull();
			expect([0, 1, 2]).toContain(b.pressure as number);
		}
		// A Mac with an accelerator the probe reads (IOKit, no process started) has the figure; one with none (a virtual
		// machine, a headless runner) has no GPU, which is no failure.
		if (accelerators > 0) expect(b.gpus).not.toBeNull();
		for (const g of b.gpus ?? []) {
			expect(g.util).toBeGreaterThanOrEqual(0);
			expect(g.util).toBeLessThanOrEqual(100);
		}
	});

	test("lists processes, this one among them", async () => {
		const rows = await systemReader().processes();
		expect(rows.find((r) => r.pid === process.pid)?.rss).toBeGreaterThan(0);
	});
});

describe("the IOKit GPU probe", () => {
	test("is none off macOS", () => {
		if (process.platform !== "darwin") expect(openGpuProbe()).toBeNull();
	});

	// Skipped (not passed) on a Mac that has no accelerator to read: the probe is fine, there is nothing for it to say.
	test.skipIf(accelerators === 0)(
		"macOS: every accelerator reads a utilisation of 0–100 and a name, and repeated reads do not fail",
		() => {
			const probe = openGpuProbe();
			expect(probe).not.toBeNull();
			for (let i = 0; i < 20; i++) {
				const readings = probe?.read() ?? [];
				expect(readings.length).toBeGreaterThan(0);
				for (const g of readings) {
					expect(Number.isInteger(g.util)).toBe(true);
					expect(g.util).toBeGreaterThanOrEqual(0);
					expect(g.util).toBeLessThanOrEqual(100);
					expect(g.name === null || g.name.length > 0).toBe(true);
				}
			}
		},
	);
});
