import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RowPlan } from "../../server/disk-space/rows.ts";
import { DiskSpace, type DiskSpaceDeps, FOLDER_MS, STALE_MS } from "../../server/disk-space/scan.ts";

/**
 * The Disk space page's scan (docs/superpowers/specs/2026-11-26-disk-space-page-design.md, "What is measured"): one folder
 * at a time, conversations as transcript plus artifacts folder, the time limits, and the cache kept across restarts.
 * `du` is a stand-in that answers from a table and moves a fake clock.
 */

const dir = mkdtempSync(join(tmpdir(), "ompw-disk-scan-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let cacheN = 0;

interface World {
	rows: RowPlan[];
	convs: Record<string, { title?: string; modifiedAt?: number; size: number }>;
	du: Record<string, number | null>;
	/** How long each `du` takes on the fake clock. */
	duMs?: Record<string, number>;
	file?: Record<string, number>;
}

function world(w: World, cache = join(dir, `cache-${cacheN++}.json`)) {
	let t = 1_000_000;
	let running = 0;
	let overlapped = false;
	const calls: string[] = [];
	const deps: DiskSpaceDeps = {
		plan: async () => ({
			rows: w.rows,
			conversations: new Map(
				Object.entries(w.convs).map(([file, c]) => [
					file,
					{ title: c.title ?? file, modifiedAt: c.modifiedAt ?? 1, size: c.size },
				]),
			),
		}),
		du: async (path, budget) => {
			calls.push(path);
			running++;
			if (running > 1) overlapped = true;
			await Bun.sleep(1);
			const took = w.duMs?.[path] ?? 10;
			t += Math.min(took, budget);
			running--;
			if (took > budget) return null;
			return w.du[path] ?? null;
		},
		fileBytes: (file) => w.file?.[file] ?? w.convs[file]?.size ?? 0,
		folderMtime: () => null,
		now: () => t,
		free: () => ({ free: 5, total: 10 }),
	};
	const space = new DiskSpace(cache, deps);
	return {
		space,
		calls,
		cache,
		overlapped: () => overlapped,
		advance: (ms: number) => {
			t += ms;
		},
	};
}

const project = (folder: string, files: string[] = []): RowPlan => ({ folder, real: folder, kind: "project", files });

describe("DiskSpace", () => {
	test("an answer before any scan shows every row pending with its transcripts' sizes", async () => {
		const { space } = world({
			rows: [project("/p/a", ["/s/1.jsonl", "/s/2.jsonl"])],
			convs: { "/s/1.jsonl": { size: 100 }, "/s/2.jsonl": { size: 50 } },
			du: {},
		});
		const a = await space.answer();
		expect(a.rows).toMatchObject([
			{
				folder: "/p/a",
				name: "a",
				folderState: "pending",
				folderBytes: null,
				conversations: 2,
				conversationBytes: 150,
			},
		]);
		expect(a.disk).toEqual({ free: 5, total: 10 });
	});

	test("a scan measures folders one at a time and conversations as transcript plus artifacts folder", async () => {
		const w = world({
			rows: [project("/p/a", ["/s/1.jsonl"]), project("/p/b")],
			convs: { "/s/1.jsonl": { size: 100 } },
			du: { "/p/a": 4000, "/p/b": 2000, "/s/1": 900 },
		});
		expect(w.space.scan()).toBe(true);
		await w.space.done();
		expect(w.overlapped()).toBe(false);
		const a = await w.space.answer();
		expect(a.rows).toMatchObject([
			{ folder: "/p/a", folderState: "measured", folderBytes: 4000, conversationBytes: 1000 },
			{ folder: "/p/b", folderState: "measured", folderBytes: 2000, conversationBytes: 0 },
		]);
		expect(a.scan).toMatchObject({ running: false, done: 2, total: 2 });
	});

	test("transcripts kept inside a project folder count once, under conversations", async () => {
		const w = world({
			rows: [project("/p/a", ["/p/a/.sessions/1.jsonl"])],
			convs: { "/p/a/.sessions/1.jsonl": { size: 100 } },
			du: { "/p/a": 5000, "/p/a/.sessions/1": 400 },
		});
		w.space.scan();
		await w.space.done();
		expect((await w.space.answer()).rows[0]).toMatchObject({ folderBytes: 4500, conversationBytes: 500 });
	});

	test("a folder over its budget is unknown and the scan goes on", async () => {
		const w = world({
			rows: [project("/p/slow"), project("/p/z")],
			convs: {},
			du: { "/p/slow": 1, "/p/z": 300 },
			duMs: { "/p/slow": FOLDER_MS + 1 },
		});
		w.space.scan();
		await w.space.done();
		expect((await w.space.answer()).rows).toMatchObject([
			{ folder: "/p/slow", folderState: "unknown", folderBytes: null },
			{ folder: "/p/z", folderState: "measured", folderBytes: 300 },
		]);
	});

	test("a scan stops after SCAN_MS and keeps the last sizes of what it did not reach", async () => {
		const names = Array.from({ length: 12 }, (_, i) => `/p/f${String(i).padStart(2, "0")}`);
		const rows = names.map((n) => project(n));
		const cache = join(dir, "stop.json");
		const first = world({ rows, convs: {}, du: Object.fromEntries(names.map((n) => [n, 1])) }, cache);
		first.space.scan();
		await first.space.done();
		// The next scan: each folder takes just under a folder's time, so ten fit in a scan's; the eleventh is cut by its end
		// and the twelfth not reached: both keep what they had.
		const slow = Object.fromEntries(names.map((n) => [n, FOLDER_MS - 1]));
		const second = world({ rows, convs: {}, du: Object.fromEntries(names.map((n) => [n, 2])), duMs: slow }, cache);
		second.space.scan();
		await second.space.done();
		const after = (await second.space.answer()).rows;
		expect(after.slice(0, 10).every((r) => r.folderBytes === 2)).toBe(true);
		expect(after.slice(10)).toMatchObject([
			{ folder: "/p/f10", folderState: "measured", folderBytes: 1 },
			{ folder: "/p/f11", folderState: "measured", folderBytes: 1 },
		]);
		expect(second.calls).not.toContain("/p/f11");
		expect((await second.space.answer()).scan).toMatchObject({ running: false, done: 10, total: 12 });
		// The one after starts with those measured longest ago.
		const third = world({ rows, convs: {}, du: Object.fromEntries(names.map((n) => [n, 3])) }, cache);
		third.space.scan();
		await third.space.done();
		expect(third.calls.slice(0, 2)).toEqual(["/p/f10", "/p/f11"]);
	});

	test("protected rows are notMeasured, gone rows are gone, and neither is measured", async () => {
		const w = world({
			rows: [
				{ folder: "/home", real: "/home", kind: "protected", files: ["/s/h.jsonl"] },
				{ folder: "/gone", real: null, kind: "other", files: ["/s/g.jsonl"] },
			],
			convs: { "/s/h.jsonl": { size: 7 }, "/s/g.jsonl": { size: 8 } },
			du: {},
		});
		w.space.scan();
		await w.space.done();
		expect(w.calls.filter((c) => c === "/home" || c === "/gone")).toEqual([]);
		expect((await w.space.answer()).rows).toMatchObject([
			{ folder: "/home", folderState: "notMeasured", conversationBytes: 7 },
			{ folder: "/gone", folderState: "gone", conversationBytes: 8 },
		]);
	});

	test("the cache survives a restart and sizes follow real paths when the projects folder changes", async () => {
		const cache = join(dir, "restart.json");
		const a = world({ rows: [project("/p/a")], convs: {}, du: { "/p/a": 42 } }, cache);
		a.space.scan();
		await a.space.done();
		// Another projects folder: /p/a is now an `other` row, and keeps its size.
		const b = world(
			{ rows: [{ folder: "/p/a", real: "/p/a", kind: "other", files: [] }, project("/q/new")], convs: {}, du: {} },
			cache,
		);
		expect((await b.space.answer()).rows).toMatchObject([
			{ folder: "/p/a", folderState: "measured", folderBytes: 42 },
			{ folder: "/q/new", folderState: "pending" },
		]);
	});

	test("scan() while one runs is refused; scanIfStale starts one only when the last finished over STALE_MS ago", async () => {
		const w = world({ rows: [project("/p/a")], convs: {}, du: { "/p/a": 1 } });
		expect(w.space.scan()).toBe(true);
		expect(w.space.scan()).toBe(false);
		await w.space.done();
		w.space.scanIfStale();
		expect((await w.space.answer()).scan.running).toBe(false);
		w.advance(STALE_MS + 1);
		w.space.scanIfStale();
		expect((await w.space.answer()).scan.running).toBe(true);
		await w.space.done();
	});

	test("forget makes a folder pending again", async () => {
		const w = world({ rows: [project("/p/a")], convs: {}, du: { "/p/a": 1 } });
		w.space.scan();
		await w.space.done();
		w.space.forget(["/p/a"]);
		expect((await w.space.answer()).rows[0].folderState).toBe("pending");
	});
});
