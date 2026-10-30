import { describe, expect, test } from "bun:test";
import { HostRing, MinuteBuckets } from "../../server/host-ring.ts";
import type { HostPoint } from "../../shared/host.ts";

const point = (t: number, over: Partial<HostPoint> = {}): HostPoint => ({
	t,
	cpu: 10,
	gpu: 5,
	mem: 50,
	pressure: 0,
	...over,
});

describe("the ring of looks", () => {
	test("keeps looks in order, oldest first, with figures to a tenth", () => {
		const ring = new HostRing(4);
		ring.push(point(1000, { cpu: 12.34, gpu: 0.04, mem: 66.55 }));
		ring.push(point(2000, { cpu: 100, gpu: 100, mem: 100, pressure: 2 }));
		expect(ring.length).toBe(2);
		expect(ring.series()).toEqual({
			t: [1000, 2000],
			cpu: [12.3, 100],
			gpu: [0, 100],
			mem: [66.6, 100],
			pressure: [0, 2],
		});
		expect(ring.last()).toEqual({ t: 2000, cpu: 100, gpu: 100, mem: 100, pressure: 2 });
	});

	test("a figure the platform lacks stays null, and comes back as null", () => {
		const ring = new HostRing(2);
		ring.push(point(1, { gpu: null, mem: null, pressure: null }));
		const s = ring.series();
		expect([s.gpu[0], s.mem[0], s.pressure[0]]).toEqual([null, null, null]);
		expect(ring.last()).toEqual({ t: 1, cpu: 10, gpu: null, mem: null, pressure: null });
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
		expect(ring.series()).toEqual({ t: [], cpu: [], gpu: [], mem: [], pressure: [] });
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
		expect(m.add(point(T0 + 5_000, { cpu: 10, gpu: 20, mem: 40 }))).toBeNull();
		expect(m.add(point(T0 + 25_000, { cpu: 30, gpu: 40, mem: 60 }))).toBeNull();
		const done = m.add(point(T0 + MINUTE + 1_000, { cpu: 99 }));
		expect(done).toEqual({ t: T0, cpu: 20, gpu: 30, mem: 50, pressure: 0 });
	});

	test("the pressure of a minute is its worst, and a figure missing from every look of it stays null", () => {
		const m = new MinuteBuckets(MINUTE);
		m.add(point(T0, { gpu: null, pressure: 0 }));
		m.add(point(T0 + 10_000, { gpu: null, pressure: 2 }));
		m.add(point(T0 + 20_000, { gpu: null, pressure: 1 }));
		expect(m.add(point(T0 + MINUTE))).toEqual({ t: T0, cpu: 10, gpu: null, mem: 50, pressure: 2 });
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
