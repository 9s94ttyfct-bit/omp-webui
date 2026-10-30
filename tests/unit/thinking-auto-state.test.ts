import { describe, expect, test } from "bun:test";
import type { LiveInfo, SessionEntry } from "../../shared/protocol.ts";
import { savedSettings } from "../../web/src/lib/session-settings.ts";
import { applyFrame, initialLive } from "../../web/src/store/live.ts";

/**
 * omp's `auto` thinking level (omp 18.12.3, observed): `get_state.thinkingLevel` is the level `auto` resolved to, and
 * `get_available_thinking_levels` never lists it. `auto` shows only in the `configured` field of the
 * `thinking_level_changed` frame and of the journal's `thinking_level_change` entry (null for an explicit level), and
 * in a process's `--thinking auto`. omp announces nothing on resume: the journal is all a resumed conversation has.
 */

const info: LiveInfo = {
	liveId: "L1",
	pid: 1,
	cwd: "/work",
	sessionFile: null,
	sessionId: null,
	args: [],
	startedAt: 0,
	streaming: false,
	exited: false,
	subscribers: 1,
	pausedAt: null,
	mode: "full",
};

const change = (id: string, thinkingLevel: string, configured: string | null): SessionEntry => ({
	type: "thinking_level_change",
	id,
	parentId: null,
	timestamp: "2026-01-01T00:00:00Z",
	thinkingLevel,
	configured,
});

describe("what a saved conversation was set to", () => {
	test("`auto` is read from the journal's configured selector, not the level it resolved to", () => {
		expect(savedSettings([change("t1", "high", "auto")]).thinking).toBe("auto");
	});

	test("an explicit level picked after `auto` ends it", () => {
		const path = [change("t1", "high", "auto"), change("t2", "medium", null)];
		expect(savedSettings(path).thinking).toBe("medium");
	});

	test("an explicit level and `auto` picked again after it", () => {
		const path = [change("t1", "medium", null), change("t2", "high", "auto")];
		expect(savedSettings(path).thinking).toBe("auto");
	});
});

describe("what a live process was set to", () => {
	test("a `thinking_level_changed` frame that names `auto` as configured sets it, whatever it resolved to", () => {
		const s = applyFrame(initialLive(info), {
			type: "thinking_level_changed",
			thinkingLevel: "high",
			configured: "auto",
		});
		expect(s.thinking).toBe("auto");
	});

	test("a frame without a configured selector is an explicit level and ends `auto`", () => {
		const auto = applyFrame(initialLive(info), {
			type: "thinking_level_changed",
			thinkingLevel: "high",
			configured: "auto",
		});
		expect(applyFrame(auto, { type: "thinking_level_changed", thinkingLevel: "low" }).thinking).toBe("low");
	});

	test("how the process was started is not something it was told: a page that heard no frame has no selector of its own", () => {
		expect(initialLive({ ...info, args: ["--thinking=auto"] }).thinking).toBeUndefined();
		expect(initialLive({ ...info, args: ["--model=x", "--thinking", "auto"] }).thinking).toBeUndefined();
	});
});
