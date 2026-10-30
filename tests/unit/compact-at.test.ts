import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessOverlay } from "../../server/omp/approval.ts";
import { type ParkedRecord, ParkedStore } from "../../server/omp/parked.ts";
import {
	COMPACT_KEYS,
	type CompactAt,
	type CompactSettings,
	compactAtOf,
	compactAtWrites,
	compactSettingsOf,
	compactTrigger,
	isCompactAt,
	modelThresholdOf,
	ompTriggerTokens,
	pointOf,
	sameCompactAt,
	shareOfTokens,
} from "../../shared/compact-at.ts";
import { isRecord } from "../../shared/guards.ts";

/**
 * "Compact at" is omp's own two settings for where it compacts by itself: `compaction.thresholdPercent` (a share of the
 * model's window) and `compaction.thresholdTokens` (a count, which omp takes over the share; `-1` in both is omp's
 * reserve-based default). The page says where omp will compact without being started to say it, so the arithmetic here
 * is checked against omp's own (18.12.6, `packages/agent/src/compaction/compaction.ts`: `rT`, `C4`, `BG` and `qi`), and
 * what it writes is checked against the overlay file omp reads.
 */

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "ompw-compact-at-"));
	dirs.push(dir);
	return dir;
}

/** What the overlay file says of `compaction`, as YAML reads it; undefined where it says nothing of it. */
function compactionIn(file: string): Record<string, unknown> | undefined {
	const parsed: unknown = Bun.YAML.parse(readFileSync(file, "utf8"));
	if (!isRecord(parsed)) return undefined;
	const held = parsed.compaction;
	return isRecord(held) ? held : undefined;
}

/**
 * omp's own arithmetic, copied from its source to stand as the oracle: what it keeps free (`rT`, `C4`), where it
 * compacts with no setting (`BG`), and the count it compacts at (`qi`). A reserve that is absent is omp's own.
 */
function ompSays(settings: CompactSettings, window: number): number {
	const reserve = settings.reserve;
	const kept = (): number => {
		const r = Math.max(Math.floor(window * 0.15), reserve ?? 16384);
		const share = Math.max(1, Math.floor(window * 0.15));
		const unset = reserve === undefined;
		return (unset && r >= window - share) || r >= window ? share : r;
	};
	const fallback = Math.max(0, Math.min(window - 1, window - kept()));
	if (settings.tokens > 0)
		return settings.tokens >= window ? fallback : Math.min(window - 1, Math.max(1, settings.tokens));
	if (!(settings.percent > 0)) return fallback;
	return Math.floor((window * Math.min(99, Math.max(1, settings.percent))) / 100);
}

const WINDOWS = [200_000, 1_000_000, 32_000, 8_000, 3_000, 1];

test("the point omp compacts at is omp's own arithmetic, for every window and setting", () => {
	const settings: CompactSettings[] = [
		{ percent: -1, tokens: -1 },
		{ percent: 85, tokens: -1 },
		{ percent: 50, tokens: -1 },
		{ percent: 99, tokens: -1 },
		{ percent: 120, tokens: -1 },
		{ percent: 0, tokens: -1 },
		{ percent: -1, tokens: 40_000 },
		{ percent: 60, tokens: 40_000 },
		{ percent: -1, tokens: 500_000 },
		{ percent: -1, tokens: -1, reserve: 8_192 },
		{ percent: 70, tokens: -1, reserve: 30_000 },
		{ percent: -1, tokens: -1, reserve: 0 },
	];
	for (const window of WINDOWS) {
		for (const one of settings) {
			expect(ompTriggerTokens(one, window), `${JSON.stringify(one)} on ${window}`).toBe(ompSays(one, window));
		}
	}
});

test("omp's default keeps 15% of the window or 16k free, whichever is larger: 170k of 200k is about 85%", () => {
	const ompDefault: CompactSettings = { percent: -1, tokens: -1 };
	expect(ompTriggerTokens(ompDefault, 200_000)).toBe(170_000);
	expect(shareOfTokens(ompTriggerTokens(ompDefault, 200_000), 200_000)).toBe(85);
	// A 1M window keeps 150k free, not 16k.
	expect(ompTriggerTokens(ompDefault, 1_000_000)).toBe(850_000);
	// A window smaller than the reserve keeps its own 15%: what is left is all there is to compact with.
	expect(ompTriggerTokens(ompDefault, 8_000)).toBe(6_800);
	// A window omp cannot count is no point at all.
	expect(ompTriggerTokens(ompDefault, 0)).toBe(0);
});

test("a share and a count are read in every window, and a count at or past the window is omp's default again", () => {
	for (const window of [200_000, 128_000, 1_000_000]) {
		for (const percent of [50, 60, 70, 80, 90, 95]) {
			const trigger = compactTrigger({ percent }, { percent: -1, tokens: -1 }, window);
			expect(trigger?.tokens).toBe(Math.floor((window * percent) / 100));
			expect(trigger?.percent).toBe(shareOfTokens(trigger?.tokens ?? 0, window));
			expect(trigger?.source).toBe("conversation");
		}
		for (const tokens of [40_000, 120_000]) {
			const trigger = compactTrigger({ tokens }, { percent: -1, tokens: -1 }, window);
			expect(trigger?.tokens).toBe(Math.min(window - 1, tokens));
			expect(trigger?.source).toBe("conversation");
		}
	}
	// omp falls back to its own reserve for a count past the window, and the page says that rather than claiming the count.
	const past = compactTrigger({ tokens: 300_000 }, { percent: -1, tokens: -1 }, 200_000);
	expect(past?.tokens).toBe(170_000);
	expect(past?.source).toBe("default");
	// A conversation with no point of its own uses what omp's configuration says, or omp's own reserve.
	expect(compactTrigger(null, { percent: 70, tokens: -1 }, 200_000)).toMatchObject({
		tokens: 140_000,
		source: "config",
	});
	expect(compactTrigger(null, { percent: -1, tokens: -1 }, 200_000)).toMatchObject({
		tokens: 170_000,
		source: "default",
	});
	// Nothing can be said without a window.
	expect(compactTrigger({ percent: 70 }, { percent: -1, tokens: -1 }, undefined)).toBeUndefined();
	expect(compactTrigger({ percent: 70 }, { percent: -1, tokens: -1 }, 0)).toBeUndefined();
});

test("a point is a share from 50% to 95% or a positive count, and never both", () => {
	for (const percent of [50, 85, 95]) expect(isCompactAt({ percent })).toBe(true);
	for (const tokens of [1, 40_000]) expect(isCompactAt({ tokens })).toBe(true);
	for (const bad of [
		{ percent: 49 },
		{ percent: 96 },
		{ percent: 70.5 },
		{ tokens: 0 },
		{ tokens: -1 },
		{ tokens: 1.5 },
	]) {
		expect(isCompactAt(bad), JSON.stringify(bad)).toBe(false);
		expect(compactAtOf(bad)).toBeNull();
	}
	expect(isCompactAt({ percent: 70, tokens: 40_000 })).toBe(false);
	expect(isCompactAt(null)).toBe(false);
	expect(isCompactAt("85")).toBe(false);
	expect(isCompactAt([85])).toBe(false);
	expect(compactAtOf({ percent: 70 })).toEqual({ percent: 70 });
	expect(compactAtOf({ tokens: 40_000 })).toEqual({ tokens: 40_000 });
});

test("omp's settings are read as omp lists them, with -1 for what is unset", () => {
	expect(
		compactSettingsOf({ [COMPACT_KEYS.percent]: 70, [COMPACT_KEYS.tokens]: -1, [COMPACT_KEYS.reserve]: 30_000 }),
	).toEqual({ percent: 70, tokens: -1, reserve: 30_000 });
	// Nothing listed is omp's default, and a reserve that is not a count is omp's own.
	expect(compactSettingsOf({})).toEqual({ percent: -1, tokens: -1 });
	expect(compactSettingsOf({ [COMPACT_KEYS.reserve]: -5 })).toEqual({ percent: -1, tokens: -1 });
	expect(compactSettingsOf({ [COMPACT_KEYS.percent]: "70" })).toEqual({ percent: -1, tokens: -1 });

	expect(pointOf({ percent: 70, tokens: -1 })).toEqual({ percent: 70 });
	expect(pointOf({ percent: 70, tokens: 40_000 })).toEqual({ tokens: 40_000 });
	expect(pointOf({ percent: -1, tokens: -1 })).toBeNull();
	expect(sameCompactAt({ percent: 70 }, { percent: 70 })).toBe(true);
	expect(sameCompactAt(null, null)).toBe(true);
	expect(sameCompactAt({ percent: 70 }, { tokens: 70 })).toBe(false);
	expect(sameCompactAt({ percent: 70 }, null)).toBe(false);
});

test("a per-model threshold decides over both settings: the exact key first, then the longest wildcard", () => {
	const record = { "anthropic/claude-opus-5-5": 60, "anthropic/*": 80, "*": 90 };
	expect(modelThresholdOf(record, "anthropic/claude-opus-5-5")?.key).toBe("anthropic/claude-opus-5-5");
	expect(modelThresholdOf(record, "anthropic/claude-haiku-5-5")?.key).toBe("anthropic/*");
	expect(modelThresholdOf(record, "openai/gpt-6-astra")?.key).toBe("*");
	expect(modelThresholdOf(record, "no-provider")).toBeNull();
	expect(modelThresholdOf({}, "a/b")).toBeNull();
	expect(modelThresholdOf(null, "a/b")).toBeNull();
});

test("the overlay says the chosen point and -1 for the other, as YAML numbers omp reads", () => {
	expect(compactAtWrites({ percent: 70 })).toEqual({
		"compaction.thresholdPercent": 70,
		"compaction.thresholdTokens": -1,
	});
	expect(compactAtWrites({ tokens: 40_000 })).toEqual({
		"compaction.thresholdPercent": -1,
		"compaction.thresholdTokens": 40_000,
	});

	const root = scratch();
	const overlay = new ProcessOverlay(join(root, "L1.yml"), "yolo", 0);
	// An overlay that says nothing of the point leaves omp's own configuration to decide.
	expect(compactionIn(overlay.file)).toBeUndefined();

	void overlay.setCompact({ percent: 70 });
	expect(compactionIn(overlay.file)).toEqual({ thresholdPercent: 70, thresholdTokens: -1 });
	expect(overlay.settings).toMatchObject({ "compaction.thresholdPercent": 70, "compaction.thresholdTokens": -1 });

	// A count replaces the share (omp takes it over the share whenever it is positive).
	void overlay.setCompact({ tokens: 40_000 });
	expect(compactionIn(overlay.file)).toEqual({ thresholdPercent: -1, thresholdTokens: 40_000 });

	// Clearing it takes both lines away: omp's own configuration decides again.
	void overlay.setCompact(null);
	expect(compactionIn(overlay.file)).toBeUndefined();
	expect(overlay.settings["compaction.thresholdPercent"]).toBeUndefined();
});

test("an overlay a former server left is written again with the point its conversation kept", () => {
	const root = scratch();
	const file = join(root, "L1.yml");
	const written = new ProcessOverlay(file, "yolo", 0, null, null, [], {}, undefined, null, [], { tokens: 40_000 });
	expect(compactionIn(written.file)).toEqual({ thresholdPercent: -1, thresholdTokens: 40_000 });
	written.remove();
	const restored = new ProcessOverlay(file, "yolo", 0, null, null, [], {}, undefined, null, [], { percent: 65 });
	expect(compactionIn(restored.file)).toEqual({ thresholdPercent: 65, thresholdTokens: -1 });
	restored.remove();
});

/** A paused conversation's record, with the fields this test is not about left at what the format requires. */
function paused(liveId: string, compact: CompactAt | null, pausedAt = 1): ParkedRecord {
	return {
		version: 1,
		liveId,
		omp: { pid: 1, identity: "a" },
		relay: { pid: 2, identity: "b" },
		socket: join(tmpdir(), `${liveId}.sock`),
		owner: null,
		cwd: "/",
		args: [],
		env: {},
		mode: "full",
		startedAt: 0,
		pausedAt,
		sessionFile: null,
		sessionId: null,
		streaming: false,
		overlay: { file: join(tmpdir(), `${liveId}.yml`), mode: "yolo", compact },
		interviewing: false,
		pendingUI: [],
		descendants: [],
	};
}

test("a paused conversation's point is kept in its record, and a damaged one reads as none (omp's configuration)", () => {
	const data = scratch();
	const store = new ParkedStore(data);
	store.save(paused("L1", { percent: 70 }, 1));
	store.save(paused("L2", { tokens: 40_000 }, 2));
	store.save(paused("L3", null, 3));
	// What a damaged record says of the point: below the shares this page offers, both at once, a count as text, a number.
	const damaged: unknown[] = [{ percent: 20 }, { percent: 70, tokens: 40_000 }, { tokens: "40000" }, 70];
	for (const [i, compact] of damaged.entries()) {
		const one = paused(`L${i + 4}`, null, i + 4);
		const overlay = { ...one.overlay, compact };
		writeFileSync(join(data, "parked", `L${i + 4}.json`), JSON.stringify({ ...one, overlay }));
	}

	const listed = store.list();
	expect(listed.map((r) => r.liveId)).toEqual(["L1", "L2", "L3", "L4", "L5", "L6", "L7"]);
	expect(listed.map((r) => r.overlay?.compact)).toEqual([
		{ percent: 70 },
		{ tokens: 40_000 },
		null,
		null,
		null,
		null,
		null,
	]);
});
