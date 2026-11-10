import { describe, expect, test } from "bun:test";
import { HostRing, MinuteBuckets } from "../../server/host-ring.ts";
import { type HostPoint, MAX_DISKS } from "../../shared/host.ts";

const point = (t: number, over: Partial<HostPoint> = {}): HostPoint => ({
	t,
	cpu: 10,
	gpu: 5,
	mem: 50,
	pressure: 0,
	power: 20,
	rx: 1000,
	tx: 500,
	disks: { "/": 132_000_000_000 },
	...over,
});

describe("the ring of looks", () => {
	test("keeps looks in order, oldest first, with figures to a tenth", () => {
		const ring = new HostRing(4);
		ring.push(point(1000, { cpu: 12.34, gpu: 0.04, mem: 66.55, power: 18.44 }));
		ring.push(point(2000, { cpu: 100, gpu: 100, mem: 100, pressure: 2, power: 120 }));
		expect(ring.length).toBe(2);
		expect(ring.series()).toEqual({
			t: [1000, 2000],
			cpu: [12.3, 100],
			gpu: [0, 100],
			mem: [66.6, 100],
			pressure: [0, 2],
			power: [18.4, 120],
			rx: [1000, 1000],
			tx: [500, 500],
			disks: { "/": [132_000_000_000, 132_000_000_000] },
		});
		expect(ring.last()).toEqual({
			t: 2000,
			cpu: 100,
			gpu: 100,
			mem: 100,
			pressure: 2,
			power: 120,
			rx: 1000,
			tx: 500,
			disks: { "/": 132_000_000_000 },
		});
	});

	test("a figure the platform lacks stays null, and comes back as null", () => {
		const ring = new HostRing(2);
		ring.push(point(1, { gpu: null, mem: null, pressure: null, power: null, rx: null, tx: null, disks: {} }));
		const s = ring.series();
		expect([s.gpu[0], s.mem[0], s.pressure[0], s.power[0], s.rx[0], s.tx[0]]).toEqual([
			null,
			null,
			null,
			null,
			null,
			null,
		]);
		expect(s.disks).toEqual({});
		expect(ring.last()).toEqual({
			t: 1,
			cpu: 10,
			gpu: null,
			mem: null,
			pressure: null,
			power: null,
			rx: null,
			tx: null,
			disks: {},
		});
	});

	test("the network's bytes a second come back whole, a disk's free bytes to the megabyte", () => {
		const ring = new HostRing(2);
		ring.push(point(1, { rx: 1_234_567.4, tx: 0, disks: { "/": 131_956_060_160 } }));
		// Over 16 MB/s a 32-bit float is no longer exact to the byte, but to a few parts in ten million.
		ring.push(point(2, { rx: 987_654_321, tx: 12, disks: { "/": 4_000_000_000_000 } }));
		const s = ring.series();
		expect(s.rx[0]).toBe(1_234_567);
		expect(s.tx).toEqual([0, 12]);
		expect(Math.abs((s.rx[1] as number) - 987_654_321)).toBeLessThan(100);
		expect(s.disks["/"]).toEqual([131_956_000_000, 4_000_000_000_000]);
	});

	test("a disk plugged in later has a column from then on (none before), and one taken out has none after", () => {
		const ring = new HostRing(10);
		ring.push(point(1, { disks: { "/": 1e9 } }));
		ring.push(point(2, { disks: { "/": 1e9, "/Volumes/Backup": 5e9 } }));
		ring.push(point(3, { disks: { "/": 2e9, "/Volumes/Backup": null } }));
		ring.push(point(4, { disks: { "/": 2e9 } }));
		expect(ring.series().disks).toEqual({ "/": [1e9, 1e9, 2e9, 2e9], "/Volumes/Backup": [null, 5e9, null, null] });
		// A window the disk has no figure in has no column of it.
		expect(ring.series(3).disks).toEqual({ "/": [2e9, 2e9] });
		expect(ring.last()?.disks).toEqual({ "/": 2e9 });
	});

	test("at most MAX_DISKS columns: a disk taken out makes room for one plugged in, the emptiest first", () => {
		const ring = new HostRing(4);
		const many = (n: number, from = 0) =>
			Object.fromEntries(Array.from({ length: n }, (_, i) => [`/Volumes/D${from + i}`, 1e9]));
		ring.push(point(1, { disks: many(MAX_DISKS) }));
		// Every column's disk is still there: one more has no room.
		ring.push(point(2, { disks: { ...many(MAX_DISKS), "/Volumes/Extra": 1e9 } }));
		expect(Object.keys(ring.series().disks)).toHaveLength(MAX_DISKS);
		expect(ring.series().disks["/Volumes/Extra"]).toBeUndefined();
		// D0 is taken out and another plugged in at once: D0's column makes room, though it still has figures in it.
		ring.push(point(3, { disks: { ...many(MAX_DISKS - 1, 1), "/Volumes/Extra": 7e9 } }));
		expect(ring.series().disks["/Volumes/Extra"]).toEqual([null, null, 7e9]);
		expect(ring.series().disks["/Volumes/D0"]).toBeUndefined();
		expect(Object.keys(ring.series().disks)).toHaveLength(MAX_DISKS);
	});

	test("past its size the oldest are overwritten: the ring never holds more than it was made for", () => {
		const ring = new HostRing(3);
		for (let i = 1; i <= 8; i++) ring.push(point(i * 1000, { cpu: i }));
		expect(ring.length).toBe(3);
		expect(ring.series().t).toEqual([6000, 7000, 8000]);
		expect(ring.series().cpu).toEqual([6, 7, 8]);
	});

	test("a window from `since` on, and an empty ring's series is empty columns", () => {
		const ring = new HostRing(10);
		expect(ring.series()).toEqual({
			t: [],
			cpu: [],
			gpu: [],
			mem: [],
			pressure: [],
			power: [],
			rx: [],
			tx: [],
			disks: {},
		});
		expect(ring.last()).toBeNull();
		for (let i = 1; i <= 5; i++) ring.push(point(i * 1000));
		expect(ring.series(3000).t).toEqual([3000, 4000, 5000]);
		expect(ring.series(6000).t).toEqual([]);
	});

	test("percentages are held to the 0–100 a page can draw", () => {
		const ring = new HostRing(2);
		ring.push(point(1, { cpu: 180, gpu: -4 }));
		expect(ring.series().cpu[0]).toBe(100);
		expect(ring.series().gpu[0]).toBe(0);
	});

	test("watts are not held to a percentage's 100: a computer that draws 240 W is said to", () => {
		const ring = new HostRing(1);
		ring.push(point(1, { power: 240.25 }));
		expect(ring.series().power[0]).toBe(240.3);
	});

	test("a ring holds at least one look", () => {
		expect(() => new HostRing(0)).toThrow();
		expect(() => new HostRing(1.5)).toThrow();
	});
});

describe("minutes", () => {
	const MINUTE = 60_000;
	const T0 = 10 * MINUTE;

	test("a minute is finished by the first look of the next, and is the mean of its looks at the minute's start", () => {
		const m = new MinuteBuckets(MINUTE);
		expect(
			m.add(
				point(T0 + 5_000, { cpu: 10, gpu: 20, mem: 40, power: 10, rx: 100, tx: 7, disks: { "/": 9e9, "/b": 1e9 } }),
			),
		).toBeNull();
		expect(
			m.add(
				point(T0 + 25_000, { cpu: 30, gpu: 40, mem: 60, power: 30, rx: 301, tx: 8, disks: { "/": 8e9, "/b": null } }),
			),
		).toBeNull();
		const done = m.add(point(T0 + MINUTE + 1_000, { cpu: 99 }));
		// The network's is the mean too, whole; a disk's free space is the minute's last figure.
		expect(done).toEqual({
			t: T0,
			cpu: 20,
			gpu: 30,
			mem: 50,
			pressure: 0,
			power: 20,
			rx: 201,
			tx: 8,
			disks: { "/": 8e9, "/b": 1e9 },
		});
	});

	test("the pressure of a minute is its worst, and a figure missing from every look of it stays null", () => {
		const m = new MinuteBuckets(MINUTE);
		m.add(point(T0, { gpu: null, pressure: 0, power: null, rx: null, tx: null, disks: {} }));
		m.add(point(T0 + 10_000, { gpu: null, pressure: 2, power: null, rx: null, tx: null, disks: {} }));
		m.add(point(T0 + 20_000, { gpu: null, pressure: 1, power: null, rx: null, tx: null, disks: {} }));
		expect(m.add(point(T0 + MINUTE))).toEqual({
			t: T0,
			cpu: 10,
			gpu: null,
			mem: 50,
			pressure: 2,
			power: null,
			rx: null,
			tx: null,
			disks: {},
		});
	});

	test("a look with no network figure (the first, or one after a counter ran back) is left out of the minute's mean", () => {
		const m = new MinuteBuckets(MINUTE);
		m.add(point(T0, { rx: null, tx: null }));
		m.add(point(T0 + 10_000, { rx: 4000, tx: 2000 }));
		expect(m.add(point(T0 + MINUTE))).toMatchObject({ rx: 4000, tx: 2000 });
	});

	test("a minute with a gap in front of it finishes the one before and starts afresh", () => {
		const m = new MinuteBuckets(MINUTE);
		m.add(point(T0, { cpu: 10 }));
		const first = m.add(point(T0 + 7 * MINUTE, { cpu: 50 }));
		expect(first?.t).toBe(T0);
		const second = m.add(point(T0 + 8 * MINUTE, { cpu: 70 }));
		expect(second).toMatchObject({ t: T0 + 7 * MINUTE, cpu: 50 });
	});
});
