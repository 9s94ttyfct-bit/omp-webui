import { describe, expect, test } from "bun:test";
import type { HostSeries } from "../../shared/host.ts";
import {
	appendRow,
	chartRows,
	clockTicks,
	downsample,
	fmtCore,
	fmtMem,
	fmtShare,
	type HostRow,
	hostColor,
	mergeRows,
	peakOf,
	pressureRuns,
	rowsOf,
	tickStep,
	trimRows,
} from "../../web/src/lib/host-rows.ts";

/** What the host's graphs and tiles do with the server's figures (web/src/lib/host-rows.ts). */

const row = (t: number, over: Partial<HostRow> = {}): HostRow => ({
	t,
	cpu: 10,
	gpu: null,
	mem: 50,
	pressure: 0,
	...over,
});
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

describe("rows from the server's columns", () => {
	test("each index of the columns is one row, oldest first, and a missing figure stays null", () => {
		const s: HostSeries = {
			t: [1000, 3000],
			cpu: [12.5, 40],
			gpu: [null, 7],
			mem: [61.2, 61.4],
			pressure: [0, null],
		};
		expect(rowsOf(s)).toEqual([
			{ t: 1000, cpu: 12.5, gpu: null, mem: 61.2, pressure: 0 },
			{ t: 3000, cpu: 40, gpu: 7, mem: 61.4, pressure: null },
		]);
	});

	test("empty columns are no rows", () => {
		expect(rowsOf({ t: [], cpu: [], gpu: [], mem: [], pressure: [] })).toEqual([]);
	});
});

describe("adding a look", () => {
	test("a look is added at the end and what is older than the span before it goes", () => {
		const rows = [row(0), row(30 * MIN), row(HOUR)];
		const next = appendRow(rows, row(HOUR + 2 * SEC), HOUR);
		// 0 is 1 h 2 s before the new look: gone; 30 min is within the hour: kept.
		expect(next.map((r) => r.t)).toEqual([30 * MIN, HOUR, HOUR + 2 * SEC]);
	});

	test("a row at exactly the span stays", () => {
		expect(appendRow([row(0)], row(HOUR), HOUR).map((r) => r.t)).toEqual([0, HOUR]);
	});

	test("a look that is not newer than the last is told twice and added once, whichever of the two came first", () => {
		const rows = [row(1000), row(3000)];
		expect(appendRow(rows, row(3000), HOUR)).toBe(rows);
		expect(appendRow(rows, row(2000), HOUR)).toBe(rows);
	});

	test("the array it was given is never changed", () => {
		const rows = [row(0)];
		appendRow(rows, row(2000), HOUR);
		expect(rows).toHaveLength(1);
	});

	test("trimming that drops nothing gives the same array back", () => {
		const rows = [row(10), row(20)];
		expect(trimRows(rows, 10)).toBe(rows);
		expect(trimRows(rows, 15).map((r) => r.t)).toEqual([20]);
	});
});

describe("the server's answer and the socket's looks, which overlap", () => {
	test("only the looks after the answer's last are added: nothing twice, nothing missing", () => {
		const base = [row(1000), row(3000)];
		expect(mergeRows(base, [row(2000), row(3000), row(5000), row(7000)]).map((r) => r.t)).toEqual([
			1000, 3000, 5000, 7000,
		]);
	});

	test("an answer with no rows takes everything the socket said", () => {
		expect(mergeRows([], [row(5), row(6)]).map((r) => r.t)).toEqual([5, 6]);
	});

	test("nothing new is the same array", () => {
		const base = [row(1000)];
		expect(mergeRows(base, [row(500)])).toBe(base);
	});
});

describe("a graph's gaps", () => {
	test("a stretch with no looks (asleep, or no server) breaks the line: a row of nothing is put in it", () => {
		const out = chartRows([row(0), row(10 * SEC), row(10 * MIN)], 30 * SEC);
		expect(out.map((r) => r.t)).toEqual([0, 10 * SEC, 10 * SEC + 1, 10 * MIN]);
		expect(out[2]).toEqual({ t: 10 * SEC + 1, cpu: null, gpu: null, mem: null, pressure: null });
	});

	test("looks that keep their pace are one line", () => {
		const rows = [row(0), row(10 * SEC), row(20 * SEC)];
		expect(chartRows(rows, 30 * SEC)).toEqual(rows);
	});
});

describe("fewer rows for a graph that is a few hundred pixels wide", () => {
	test("rows within the limit are left alone", () => {
		const rows = Array.from({ length: 10 }, (_, i) => row(i * 2000));
		expect(downsample(rows, HOUR, 600)).toBe(rows);
	});

	test("an hour of looks every two seconds is at most about the limit, and keeps what it shows", () => {
		const rows = Array.from({ length: 1800 }, (_, i) => row(i * 2000, { cpu: i % 2 === 0 ? 0 : 100 }));
		const out = downsample(rows, HOUR, 300);
		expect(out.length).toBeLessThanOrEqual(301);
		expect(out.length).toBeGreaterThan(250);
		// Each point is the mean of the looks in its stretch: a flicker of 0 and 100 is 50.
		for (const r of out) expect(r.cpu).toBe(50);
		// Time stays in order.
		for (let i = 1; i < out.length; i++) expect((out[i] as HostRow).t).toBeGreaterThan((out[i - 1] as HostRow).t);
	});

	test("a stretch's pressure is its worst and a figure the host lacks stays null", () => {
		const rows = [
			row(0, { pressure: 0, gpu: null }),
			row(1000, { pressure: 2, gpu: null }),
			row(2000, { pressure: 1, gpu: null }),
		];
		const [one] = downsample(rows, 3000, 1);
		expect(one?.pressure).toBe(2);
		expect(one?.gpu).toBeNull();
	});

	test("the stretches are cut from the clock, so a new look does not move the older ones between stretches", () => {
		const rows = Array.from({ length: 1000 }, (_, i) => row(i * 2000, { cpu: i % 7 }));
		const a = downsample(rows, 2000 * 1000, 100);
		const b = downsample([...rows, row(1000 * 2000, { cpu: 1 })], 2000 * 1000, 100);
		// Every point but the newest ones is identical.
		expect(b.slice(0, a.length - 2)).toEqual(a.slice(0, a.length - 2));
	});
});

describe("memory pressure bands", () => {
	test("a stretch above normal runs from its first look to the look that ends it", () => {
		const rows = [
			row(0, { pressure: 0 }),
			row(10, { pressure: 1 }),
			row(20, { pressure: 1 }),
			row(30, { pressure: 0 }),
		];
		expect(pressureRuns(rows, 100)).toEqual([{ from: 10, to: 30, level: 1 }]);
	});

	test("a worse level is a stretch of its own, next to the one before", () => {
		const rows = [
			row(0, { pressure: 1 }),
			row(10, { pressure: 2 }),
			row(20, { pressure: 2 }),
			row(30, { pressure: 0 }),
		];
		expect(pressureRuns(rows, 100)).toEqual([
			{ from: 0, to: 10, level: 1 },
			{ from: 10, to: 30, level: 2 },
		]);
	});

	test("normal pressure, and a host that tells none, have no band", () => {
		expect(pressureRuns([row(0, { pressure: 0 }), row(10, { pressure: 0 })], 100)).toEqual([]);
		expect(pressureRuns([row(0, { pressure: null }), row(10, { pressure: null })], 100)).toEqual([]);
	});

	test("a band is never drawn across a gap: nothing is known of what was between", () => {
		const rows = [row(0, { pressure: 2 }), row(1000, { pressure: 2 }), row(1010, { pressure: 0 })];
		expect(pressureRuns(rows, 100)).toEqual([{ from: 1000, to: 1010, level: 2 }]);
	});

	test("the last look has nothing after it to end a band: it has none", () => {
		expect(pressureRuns([row(0, { pressure: 0 }), row(10, { pressure: 2 })], 100)).toEqual([]);
	});

	test("two separate stretches are two bands", () => {
		const rows = [
			row(0, { pressure: 1 }),
			row(10, { pressure: 0 }),
			row(20, { pressure: 1 }),
			row(30, { pressure: 0 }),
		];
		expect(pressureRuns(rows, 100)).toEqual([
			{ from: 0, to: 10, level: 1 },
			{ from: 20, to: 30, level: 1 },
		]);
	});
});

describe("time marks", () => {
	test("an hour is marked every quarter, a day every six hours, a few minutes every minute", () => {
		expect(tickStep(HOUR)).toBe(15 * MIN);
		expect(tickStep(24 * HOUR)).toBe(6 * HOUR);
		expect(tickStep(4 * MIN)).toBe(MIN);
		expect(tickStep(10 * 24 * HOUR)).toBe(12 * HOUR);
	});

	test("marks fall on the viewer's clock, not where the history happens to start", () => {
		// 10:07 UTC to 11:07 UTC in a zone 5 h 30 min ahead (India): the quarters are 15:45, 16:00 … on that clock.
		const start = Date.UTC(2026, 9, 24, 10, 7);
		const offset = 5.5 * HOUR;
		const ticks = clockTicks(start, start + HOUR, 15 * MIN, offset);
		expect(ticks.map((t) => new Date(t + offset).toISOString().slice(11, 16))).toEqual([
			"15:45",
			"16:00",
			"16:15",
			"16:30",
		]);
	});
});

describe("figures", () => {
	test("peaks skip what is missing", () => {
		expect(peakOf([row(0, { gpu: null }), row(1, { gpu: 30 }), row(2, { gpu: 12 })], (r) => r.gpu)).toBe(30);
		expect(peakOf([row(0, { gpu: null })], (r) => r.gpu)).toBeNull();
	});

	test("a share is whole percent and a dash when there is none", () => {
		expect(fmtShare(12.4)).toBe("12%");
		expect(fmtShare(99.6)).toBe("100%");
		expect(fmtShare(0)).toBe("0%");
		expect(fmtShare(null)).toBe("—");
		expect(fmtShare(undefined)).toBe("—");
	});

	test("a process's share of one core has a tenth below 10% and may pass 100%", () => {
		expect(fmtCore(0.04)).toBe("0.0%");
		expect(fmtCore(3.26)).toBe("3.3%");
		expect(fmtCore(42.4)).toBe("42%");
		expect(fmtCore(312.2)).toBe("312%");
		expect(fmtCore(null)).toBe("—");
	});

	test("memory is written in decimal units, as Activity Monitor does", () => {
		expect(fmtMem(412_000_000)).toBe("412 MB");
		expect(fmtMem(9_800_000_000)).toBe("9.8 GB");
		expect(fmtMem(24_000_000_000)).toBe("24 GB");
		expect(fmtMem(512)).toBe("512 B");
	});

	test("the series colours are the palette's own, one each", () => {
		expect([0, 1, 2].map(hostColor)).toEqual(["var(--chart-1)", "var(--chart-2)", "var(--chart-3)"]);
	});
});
