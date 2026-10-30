import { describe, expect, test } from "bun:test";
import { isLocalOnlyRoute } from "../../server/this-computer.ts";
import { DEFAULT_GUARD_CONFIG, type GuardConfig, type LiveGuard, resolveGuard } from "../../shared/guard.ts";
import { isValidPref, MAX_PREF_LENGTH, PREF } from "../../shared/prefs.ts";
import {
	GUARD_OFF,
	guardIsOn,
	guardOnPatch,
	guardToggleBlock,
	MAX_REMEMBERED,
	onChoiceOf,
	readRemembered,
	rememberedChoice,
	withRemembered,
} from "../../web/src/lib/guard-toggle.ts";

/**
 * The guard's switch in a conversation's header (v0.12.2): Off for this conversation alone, and back on to what it was under
 * before (kept per conversation), else to Settings' mode, else the shipped default; and the pages that may not switch it.
 */

const SETTINGS: GuardConfig = { mode: "reviewer", reviewer: "", askWhenUnavailable: true, askWhenDenied: true };
const under = (
	own: Parameters<typeof resolveGuard>[1],
	settings: Partial<GuardConfig> = {},
	damaged = false,
): LiveGuard => resolveGuard({ ...SETTINGS, ...settings }, own, damaged);

describe("what the switch says the conversation is under", () => {
	test("on is any mode but Off, whether it is the conversation's own or Settings'", () => {
		expect(guardIsOn(under(null))).toBe(true);
		expect(guardIsOn(under({ mode: "ask" }))).toBe(true);
		expect(guardIsOn(under({ mode: "off" }))).toBe(false);
		expect(guardIsOn(under(null, { mode: "off" }))).toBe(false);
		// A damaged record is never off: the stricter of Settings and the default.
		expect(guardIsOn(under(null, { mode: "off" }, true))).toBe(true);
	});

	test("what it gives back later: its own mode, following Settings, or nothing while it is off", () => {
		expect(onChoiceOf(under(null))).toBe("follow");
		expect(onChoiceOf(under({ reviewer: "a/b" }))).toBe("follow");
		expect(onChoiceOf(under({ mode: "ask" }))).toBe("ask");
		expect(onChoiceOf(under({ mode: "reviewer" }, { mode: "ask" }))).toBe("reviewer");
		expect(onChoiceOf(under({ mode: "off" }))).toBeNull();
		expect(onChoiceOf(under(null, { mode: "off" }))).toBeNull();
		// A damaged record is under a mode none of its choices names: that mode, as its own, never "follow" (Settings may say Off).
		expect(onChoiceOf(under(null, { mode: "off" }, true))).toBe("reviewer");
		expect(onChoiceOf(under(null, { mode: "ask" }, true))).toBe("ask");
	});
});

describe("turning it off and on", () => {
	test("off is Off for this conversation alone", () => {
		expect(GUARD_OFF).toEqual({ mode: "off" });
	});

	test("on gives back the mode it had before it was turned off", () => {
		expect(guardOnPatch("ask", "reviewer")).toEqual({ mode: "ask" });
		expect(guardOnPatch("reviewer", "ask")).toEqual({ mode: "reviewer" });
		// Whatever Settings say now, even Off, and when they could not be read.
		expect(guardOnPatch("ask", "off")).toEqual({ mode: "ask" });
		expect(guardOnPatch("reviewer", null)).toEqual({ mode: "reviewer" });
	});

	test("one that followed Settings follows them again, while they are on", () => {
		expect(guardOnPatch("follow", "reviewer")).toEqual({ mode: null });
		expect(guardOnPatch("follow", "ask")).toEqual({ mode: null });
	});

	test("with nothing remembered it takes Settings' mode, by following them", () => {
		expect(guardOnPatch(null, "reviewer")).toEqual({ mode: null });
		expect(guardOnPatch(null, "ask")).toEqual({ mode: null });
	});

	test("following Settings that say Off, or that could not be read, is no way on: the shipped default, as its own", () => {
		expect(DEFAULT_GUARD_CONFIG.mode).not.toBe("off");
		expect(guardOnPatch(null, "off")).toEqual({ mode: DEFAULT_GUARD_CONFIG.mode });
		expect(guardOnPatch(null, null)).toEqual({ mode: DEFAULT_GUARD_CONFIG.mode });
		expect(guardOnPatch("follow", "off")).toEqual({ mode: DEFAULT_GUARD_CONFIG.mode });
		expect(guardOnPatch("follow", null)).toEqual({ mode: DEFAULT_GUARD_CONFIG.mode });
	});

	test("every way back on leaves the conversation on", () => {
		for (const previous of [null, "follow", "reviewer", "ask"] as const) {
			for (const settings of [null, "off", "reviewer", "ask"] as const) {
				const patch = guardOnPatch(previous, settings);
				const own = patch.mode === null || patch.mode === undefined ? null : { mode: patch.mode };
				const now = resolveGuard({ ...SETTINGS, mode: settings ?? "off" }, own);
				expect(guardIsOn(now)).toBe(true);
			}
		}
	});
});

describe("the pages that may switch it", () => {
	test("only the page of the computer omp-webui runs on: any other is shown the switch and cannot use it", () => {
		expect(guardToggleBlock({ local: true })).toBeNull();
		expect(guardToggleBlock({ local: false })).toBe("remote");
	});

	test("what the switch sends is refused to any other page by the server, whatever the page draws", () => {
		// The switch changes the conversation's guard through the same route as This session; a page that is not this
		// computer's is answered 403 there (`route` in server/main.ts), so a page that drew the switch enabled changes nothing.
		expect(isLocalOnlyRoute("/api/guard/live")).toBe(true);
		expect(isLocalOnlyRoute("/api/guard")).toBe(true);
	});
});

describe("what is remembered per conversation", () => {
	test("kept per conversation, the newest last, and nothing written when it already says so", () => {
		const one = withRemembered(null, "/s/a.jsonl", "ask");
		expect(one).not.toBeNull();
		expect(rememberedChoice(one, "/s/a.jsonl")).toBe("ask");
		expect(rememberedChoice(one, "/s/b.jsonl")).toBeNull();
		expect(withRemembered(one, "/s/a.jsonl", "ask")).toBeNull();
		const two = withRemembered(one, "/s/b.jsonl", "follow");
		const three = withRemembered(two, "/s/a.jsonl", "reviewer");
		expect([...readRemembered(three)]).toEqual([
			["/s/b.jsonl", "follow"],
			["/s/a.jsonl", "reviewer"],
		]);
	});

	test("whatever does not read as what it writes is left out, not trusted", () => {
		expect(readRemembered("not json").size).toBe(0);
		expect(readRemembered("[1,2]").size).toBe(0);
		expect(readRemembered("null").size).toBe(0);
		expect([...readRemembered(JSON.stringify({ a: "off", b: "ask", c: 3, "": "ask", d: "follow" }))]).toEqual([
			["b", "ask"],
			["d", "follow"],
		]);
	});

	test("bounded: the oldest go first, and it stays a preference the server keeps", () => {
		let raw: string | null = null;
		for (let i = 0; i < MAX_REMEMBERED + 5; i++) raw = withRemembered(raw, `/s/${i}.jsonl`, "ask") ?? raw;
		const kept = readRemembered(raw);
		expect(kept.size).toBe(MAX_REMEMBERED);
		expect(kept.has("/s/0.jsonl")).toBe(false);
		expect(kept.has(`/s/${MAX_REMEMBERED + 4}.jsonl`)).toBe(true);
		expect(isValidPref(PREF.guardBefore, raw as string)).toBe(true);

		// Very long paths: fewer of them, never more than the server keeps of one preference; the newest always.
		let long: string | null = null;
		for (let i = 0; i < 10; i++) long = withRemembered(long, `/${"x".repeat(4000)}/${i}.jsonl`, "reviewer") ?? long;
		expect((long as string).length).toBeLessThanOrEqual(MAX_PREF_LENGTH);
		expect(rememberedChoice(long, `/${"x".repeat(4000)}/9.jsonl`)).toBe("reviewer");
	});

	test("the preference holds an object only", () => {
		expect(isValidPref(PREF.guardBefore, "{}")).toBe(true);
		expect(isValidPref(PREF.guardBefore, "[]")).toBe(false);
		expect(isValidPref(PREF.guardBefore, "ask")).toBe(false);
	});
});
