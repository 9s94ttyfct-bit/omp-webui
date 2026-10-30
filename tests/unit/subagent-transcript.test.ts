import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SessionEntry } from "../../shared/protocol.ts";
import { showLang } from "../../web/src/i18n/index.ts";
import { fmtElapsed } from "../../web/src/lib/clock.ts";
import type { AgentMessage } from "../../web/src/lib/messages.ts";
import {
	appendPage,
	EMPTY_TRANSCRIPT,
	liveToolOutput,
	pendingTail,
	readFailure,
	replaceEntries,
	type TranscriptPage,
} from "../../web/src/lib/subagent-transcript.ts";

/**
 * A subagent's transcript as the live view builds it: pages of `get_subagent_messages` (read from a byte offset
 * onwards), and the message being written on top of them until the transcript has it.
 */

const entry = (id: string, role = "assistant", timestamp?: number): SessionEntry => ({
	type: "message",
	id,
	parentId: null,
	timestamp: "t",
	message: { role, content: [{ type: "text", text: id }], timestamp },
});
const page = (fromByte: number, nextByte: number, entries: unknown[], reset = false): TranscriptPage => ({
	sessionFile: "/s/A.jsonl",
	fromByte,
	nextByte,
	reset,
	entries,
});
const ids = (t: { entries: SessionEntry[] }) => t.entries.map((e) => e.id);

describe("pages", () => {
	test("each page continues the transcript where the last one ended", () => {
		let t = appendPage(EMPTY_TRANSCRIPT, page(0, 100, [entry("a"), entry("b")]));
		expect(ids(t)).toEqual(["a", "b"]);
		expect(t.nextByte).toBe(100);
		t = appendPage(t, page(100, 180, [entry("c")]));
		expect(ids(t)).toEqual(["a", "b", "c"]);
		expect(t.nextByte).toBe(180);
	});

	test("an empty page changes nothing but may move the offset", () => {
		const t = appendPage(EMPTY_TRANSCRIPT, page(0, 100, [entry("a")]));
		const same = appendPage(t, page(100, 100, []));
		expect(same).toBe(t);
		expect(appendPage(t, page(100, 120, [])).nextByte).toBe(120);
	});

	test("a page read twice (two reads out at once) adds its entries once", () => {
		const first = appendPage(EMPTY_TRANSCRIPT, page(0, 100, [entry("a"), entry("b")]));
		const again = appendPage(first, page(0, 100, [entry("a"), entry("b")]));
		expect(ids(again)).toEqual(["a", "b"]);
		expect(again.nextByte).toBe(100);
	});

	test("an older page never moves the offset back", () => {
		const t = appendPage(EMPTY_TRANSCRIPT, page(0, 300, [entry("a"), entry("b"), entry("c")]));
		expect(appendPage(t, page(0, 100, [entry("a")])).nextByte).toBe(300);
	});

	test("a reset starts the transcript over (the file shrank or was rewritten)", () => {
		const t = appendPage(EMPTY_TRANSCRIPT, page(0, 500, [entry("a"), entry("b")]));
		const fresh = appendPage(t, page(0, 90, [entry("x")], true));
		expect(ids(fresh)).toEqual(["x"]);
		expect(fresh.nextByte).toBe(90);
	});

	test("only records with an id are entries: the header and junk are not", () => {
		const header = { type: "session", version: 3, id: undefined, timestamp: "t" };
		const t = appendPage(EMPTY_TRANSCRIPT, page(0, 50, [header, null, 7, "x", {}, entry("a")]));
		expect(ids(t)).toEqual(["a"]);
	});
});

describe("the message being written", () => {
	const message = (timestamp?: number): AgentMessage => ({ role: "assistant", content: [], timestamp });

	test("shows while it is not in the transcript", () => {
		const m = message(5);
		expect(pendingTail(m, false, [entry("a", "assistant", 4)])).toBe(m);
		expect(pendingTail(m, true, [entry("a", "assistant", 4)])).toBe(m);
	});

	test("goes once the transcript has it, however far the transcript got", () => {
		expect(pendingTail(message(5), true, [entry("a", "assistant", 5)])).toBeNull();
		expect(pendingTail(message(5), false, [entry("a", "assistant", 5), entry("b", "assistant", 6)])).toBeNull();
	});

	test("without a timestamp it shows only while it is still being written", () => {
		expect(pendingTail(message(), false, [])).not.toBeNull();
		expect(pendingTail(message(), true, [])).toBeNull();
	});

	test("is nothing when there is nothing", () => {
		expect(pendingTail(null, false, [])).toBeNull();
		expect(pendingTail(undefined, undefined, [])).toBeNull();
	});
});

describe("a running tool's output", () => {
	const text = (s: string) => ({ content: [{ type: "text", text: s }] });

	test("is its last lines, the way the tool has printed them so far", () => {
		const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
		const out = liveToolOutput(text(lines), 12);
		expect(out.split("\n")).toHaveLength(12);
		expect(out.endsWith("line 29")).toBe(true);
		expect(out.startsWith("line 18")).toBe(true);
	});

	test("takes a bare string, and ignores what is not text", () => {
		expect(liveToolOutput("partial", 5)).toBe("partial");
		expect(liveToolOutput(undefined, 5)).toBe("");
		expect(liveToolOutput({ content: [{ type: "image", data: "x" }] }, 5)).toBe("");
		expect(liveToolOutput({ details: 1 }, 5)).toBe("");
	});

	test("drops trailing blank lines", () => {
		expect(liveToolOutput(text("a\nb\n\n\n"), 5)).toBe("a\nb");
	});
});

describe("elapsed time", () => {
	test("reads like a stopwatch up to an hour, then in hours", () => {
		expect(fmtElapsed(0)).toBe("0s");
		expect(fmtElapsed(7400)).toBe("7s");
		expect(fmtElapsed(59_999)).toBe("59s");
		expect(fmtElapsed(60_000)).toBe("1m 00s");
		expect(fmtElapsed(125_000)).toBe("2m 05s");
		expect(fmtElapsed(3_600_000)).toBe("1h 00m");
		expect(fmtElapsed(3_600_000 + 125_000)).toBe("1h 02m");
	});

	test("is never negative", () => {
		expect(fmtElapsed(-5000)).toBe("0s");
	});
});

describe("elapsed time in Chinese", () => {
	beforeAll(() => showLang("zh-CN"));
	afterAll(() => showLang("en"));

	test("reads like a stopwatch up to an hour, then in hours, with Chinese units", () => {
		expect(fmtElapsed(0)).toBe("0秒");
		expect(fmtElapsed(59_999)).toBe("59秒");
		expect(fmtElapsed(60_000)).toBe("1分00秒");
		expect(fmtElapsed(754_000)).toBe("12分34秒");
		expect(fmtElapsed(3_599_999)).toBe("59分59秒");
		expect(fmtElapsed(3_600_000)).toBe("1小时00分");
		expect(fmtElapsed(3_600_000 + 125_000)).toBe("1小时02分");
	});
});

describe("when omp cannot give the transcript", () => {
	test("only omp not knowing the subagent sends the view to the file", () => {
		expect(readFailure(new Error("Unknown subagent or session file unavailable: Scout"))).toBe("fallback");
		expect(readFailure(new Error("Unknown subagent session file"))).toBe("fallback");
		expect(readFailure(new Error("Subagent event bus is unavailable"))).toBe("fallback");
	});

	test("a dropped socket, a paused process or any other failure is asked again", () => {
		expect(readFailure(new Error("Connection lost"))).toBe("retry");
		expect(readFailure(new Error("This conversation is paused; resume it to continue."))).toBe("retry");
		expect(readFailure(new Error("fromByte must be a finite number"))).toBe("retry");
		expect(readFailure("boom")).toBe("retry");
	});
});

describe("a read of the whole file", () => {
	test("keeps the offset omp reads from", () => {
		const t = appendPage(EMPTY_TRANSCRIPT, page(0, 300, [entry("a")]));
		const next = replaceEntries(t, [entry("a"), entry("b")]);
		expect(ids(next)).toEqual(["a", "b"]);
		expect(next.nextByte).toBe(300);
	});

	test("is the very same transcript when the file has not moved on, so nothing renders again", () => {
		const t = appendPage(EMPTY_TRANSCRIPT, page(0, 300, [entry("a"), entry("b")]));
		expect(replaceEntries(t, [entry("a"), entry("b")])).toBe(t);
	});
});
