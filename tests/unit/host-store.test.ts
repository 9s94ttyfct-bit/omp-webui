import { beforeEach, describe, expect, test } from "bun:test";
import type { HostHistory, HostInfo, HostPoint } from "../../shared/host.ts";
import { takeHistory, takeSample, useHost } from "../../web/src/lib/host-store.ts";

/** What the page holds of the host's load (web/src/lib/host-store.ts): the server's answer and the socket's looks, folded together. */

const INFO: HostInfo = {
	platform: "darwin",
	cores: 12,
	memTotal: 24_000_000_000,
	gpu: { name: "Apple M4 Pro", cores: 16 },
	pressure: true,
	liveMs: 2000,
	backgroundMs: 10_000,
	fineSpanMs: 3_600_000,
	coarseMs: 60_000,
	coarseSpanMs: 86_400_000,
};

const point = (t: number, over: Partial<HostPoint> = {}): HostPoint => ({
	t,
	cpu: 10,
	gpu: 5,
	mem: 50,
	pressure: 0,
	...over,
});
const series = (points: HostPoint[]) => ({
	t: points.map((p) => p.t),
	cpu: points.map((p) => p.cpu),
	gpu: points.map((p) => p.gpu),
	mem: points.map((p) => p.mem),
	pressure: points.map((p) => p.pressure),
});
const history = (
	now: number,
	fine: HostPoint[],
	coarse: HostPoint[] = [],
	over: Partial<HostHistory> = {},
): HostHistory => ({
	info: INFO,
	now,
	fine: series(fine),
	coarse: series(coarse),
	procs: null,
	...over,
});

beforeEach(() => {
	useHost.setState({ info: null, fine: [], coarse: [], procs: null, loaded: false, failed: false });
});

describe("the server's answer", () => {
	test("is the history: rows from its columns, and what does not change", () => {
		takeHistory(history(10_000, [point(2000), point(4000)], [point(0)]));
		const s = useHost.getState();
		expect(s.loaded).toBe(true);
		expect(s.info).toEqual(INFO);
		expect(s.fine.map((r) => r.t)).toEqual([2000, 4000]);
		expect(s.coarse.map((r) => r.t)).toEqual([0]);
	});

	test("keeps a look the socket told while the request was on its way (it is after the answer's clock)", () => {
		useHost.setState({ fine: [point(9000), point(12_000)] });
		takeHistory(history(10_000, [point(8000), point(9000)]));
		// 9000 is in the answer; 12000 is newer than the answer and is only on the socket.
		expect(useHost.getState().fine.map((r) => r.t)).toEqual([8000, 9000, 12_000]);
	});

	test("a look the answer and the socket both carry is one row", () => {
		useHost.setState({ fine: [point(9000)] });
		takeHistory(history(10_000, [point(9000)]));
		expect(useHost.getState().fine).toHaveLength(1);
	});

	test("clears an earlier failure to read it", () => {
		useHost.setState({ failed: true });
		takeHistory(history(10_000, []));
		expect(useHost.getState().failed).toBe(false);
	});

	test("the processes the server names are kept; an answer with none leaves what the socket said", () => {
		const procs = [{ id: "server" as const, count: 1, cpu: 1.5, rss: 1000 }];
		takeHistory(history(10_000, [], [], { procs }));
		expect(useHost.getState().procs).toEqual(procs);
		takeHistory(history(20_000, []));
		expect(useHost.getState().procs).toEqual(procs);
	});
});

describe("a look over the socket", () => {
	test("is added to the last hour, and the minute it finished to the last day", () => {
		takeHistory(history(10_000, [point(8000)], [point(0)]));
		takeSample({ t: "host_sample", point: point(10_000), minute: point(60_000) });
		const s = useHost.getState();
		expect(s.fine.map((r) => r.t)).toEqual([8000, 10_000]);
		expect(s.coarse.map((r) => r.t)).toEqual([0, 60_000]);
	});

	test("a look with no finished minute adds nothing to the day", () => {
		takeHistory(history(10_000, [point(8000)], [point(0)]));
		takeSample({ t: "host_sample", point: point(10_000) });
		expect(useHost.getState().coarse.map((r) => r.t)).toEqual([0]);
	});

	test("the hour holds an hour: a look drops what is older than the span before it", () => {
		takeHistory(history(5_000_000, [point(1_000_000), point(1_500_000)]));
		takeSample({ t: "host_sample", point: point(1_000_000 + 3_600_000 + 1000) });
		// 1_000_000 is more than an hour before the new look; 1_500_000 is not.
		expect(useHost.getState().fine.map((r) => r.t)).toEqual([1_500_000, 4_601_000]);
	});

	test("the day holds a day", () => {
		takeHistory(history(5_000_000, [], [point(0), point(60_000)]));
		takeSample({ t: "host_sample", point: point(86_400_000 + 60_000), minute: point(86_400_000 + 30_000) });
		expect(useHost.getState().coarse.map((r) => r.t)).toEqual([60_000, 86_400_000 + 30_000]);
	});

	test("the processes come with the look when this page asked for them, and stay when a look has none", () => {
		const procs = [{ id: "omp" as const, count: 2, cpu: 12, rss: 5000 }];
		takeSample({ t: "host_sample", point: point(1000), procs });
		expect(useHost.getState().procs).toEqual(procs);
		takeSample({ t: "host_sample", point: point(3000) });
		expect(useHost.getState().procs).toEqual(procs);
	});

	test("a look before the history was read is kept and the answer, when it comes, does not lose it", () => {
		takeSample({ t: "host_sample", point: point(20_000) });
		takeHistory(history(10_000, [point(8000)]));
		expect(useHost.getState().fine.map((r) => r.t)).toEqual([8000, 20_000]);
	});
});

describe("the GPU turning up after the page read what the server knew", () => {
	test("a look with a GPU figure, on a page whose answer named no GPU, says the history is to be read again", () => {
		takeHistory(history(10_000, [point(8000, { gpu: null })], [], { info: { ...INFO, gpu: null } }));
		expect(takeSample({ t: "host_sample", point: point(10_000, { gpu: 12 }) })).toBe(true);
	});

	test("one whose answer named the GPU, or whose look has none, does not", () => {
		takeHistory(history(10_000, [point(8000)]));
		expect(takeSample({ t: "host_sample", point: point(10_000, { gpu: 12 }) })).toBe(false);
		takeHistory(history(20_000, [point(8000, { gpu: null })], [], { info: { ...INFO, gpu: null } }));
		expect(takeSample({ t: "host_sample", point: point(30_000, { gpu: null }) })).toBe(false);
	});

	test("nothing is asked before the history is read at all", () => {
		expect(takeSample({ t: "host_sample", point: point(1000, { gpu: 5 }) })).toBe(false);
	});
});
