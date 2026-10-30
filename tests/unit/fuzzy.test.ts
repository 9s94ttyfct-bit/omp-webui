import { describe, expect, test } from "bun:test";
import { fuzzyMatch } from "../../shared/fuzzy.ts";

/**
 * The one scorer behind Settings search, the sidebar's conversations and the model picker: what it matches, and what
 * order it puts what it matched in. Its numbers are part of the contract only in their order, so the tests say how
 * two texts rank against one another, and where the characters it matched are.
 */

/** How `a` ranks against `b` for `query`, as a sign: negative when `a` comes first. */
function order(query: string, a: string, b: string): number {
	const one = fuzzyMatch(query, a);
	const two = fuzzyMatch(query, b);
	if (!one || !two) throw new Error(`"${query}" does not match both "${a}" and "${b}"`);
	return two.score - one.score;
}

const text = (s: string, positions: number[]) => positions.map((i) => s[i]).join("");

describe("what a query matches", () => {
	test("the letters in order, anywhere in the text", () => {
		expect(fuzzyMatch("snt", "Sonnet")).not.toBeNull();
		expect(fuzzyMatch("clh", "Claude Haiku 4.5")).not.toBeNull();
	});

	test("letters out of order, or absent, do not match", () => {
		expect(fuzzyMatch("tns", "Sonnet")).toBeNull();
		expect(fuzzyMatch("zzz", "Sonnet")).toBeNull();
		// A letter may not be used twice for one query.
		expect(fuzzyMatch("sss", "Sonnet")).toBeNull();
	});

	test("an empty query matches everything with no characters, and nothing ranks", () => {
		expect(fuzzyMatch("", "anything at all")).toEqual({ score: 0, positions: [] });
		expect(fuzzyMatch("   ", "anything at all")).toEqual({ score: 0, positions: [] });
	});

	test("case does not change the match or the rank", () => {
		expect(fuzzyMatch("SONNET", "Claude Sonnet 4.5")).toEqual(fuzzyMatch("sonnet", "Claude Sonnet 4.5"));
		expect(order("HAI", "Claude Haiku", "Claude Haiku")).toBe(0);
	});

	test("diacritics fold both ways", () => {
		expect(fuzzyMatch("cafe", "Café")).not.toBeNull();
		expect(fuzzyMatch("café", "Cafe")).not.toBeNull();
		// The same ranking with the mark as without it.
		expect(fuzzyMatch("cafe", "Café")?.score).toBe(fuzzyMatch("cafe", "Cafe")?.score ?? Number.NaN);
		// A combining mark written as its own code point folds to the letter alone.
		expect(fuzzyMatch("cafe", "Cafe\u0301")).not.toBeNull();
	});

	test("a word of the query matches where the text has it, whatever the rest of the query does", () => {
		expect(fuzzyMatch("claude sonnet", "Claude 4.5 Sonnet")).not.toBeNull();
		// Order between words does not matter (a model's name and its provider are written either way).
		expect(fuzzyMatch("sonnet claude", "Claude Sonnet")).not.toBeNull();
	});

	test("separators between words are one query: `claude-4` is `claude 4`", () => {
		const joined = fuzzyMatch("claude 4", "claude-sonnet-4");
		expect(fuzzyMatch("claude-4", "claude-sonnet-4")).toEqual(joined);
		expect(fuzzyMatch("claude/4", "claude-sonnet-4")).toEqual(joined);
	});

	test("Chinese matches by character, and a run of Chinese is one word", () => {
		expect(fuzzyMatch("设置", "设置页面")).not.toBeNull();
		expect(fuzzyMatch("语言", "语言")).not.toBeNull();
		expect(fuzzyMatch("语言", "设置页面")).toBeNull();
		// A character of the middle of a Chinese run still matches: there are no word starts to reward, only letters in a row.
		expect(fuzzyMatch("面", "设置页面")).not.toBeNull();
		// Chinese and Latin in one query: settings whose label is in one language and whose alias is in the other.
		expect(fuzzyMatch("暗色 dark", "暗色主题")).toBeNull();
		expect(fuzzyMatch("暗色", "暗色主题")).not.toBeNull();
	});
});

describe("the order it puts matched texts in", () => {
	test("the start of a word beats a letter inside one", () => {
		expect(order("son", "Claude Sonnet", "Personally")).toBeLessThan(0);
		expect(order("set", "Settings", "Reset layout")).toBeLessThan(0);
	});

	test("letters in a row beat letters apart", () => {
		expect(order("hai", "Haiku", "H a i")).toBeLessThan(0);
		expect(order("mod", "Model", "M o d e l")).toBeLessThan(0);
		expect(order("sonnet", "Claude Sonnet", "S o n n e t")).toBeLessThan(0);
	});

	test("the initials of a multi-word text rank high: each starts a word", () => {
		// Every letter of `mdl` starts a word of its own here, which a person typing initials means.
		expect(fuzzyMatch("mdl", "My dear llama")).not.toBeNull();
		// `S` opens the second word of DeepSeek; in Devices the `s` is inside a word.
		expect(order("ds", "DeepSeek", "Devices")).toBeLessThan(0);
	});

	test("the start of the text beats the middle", () => {
		expect(order("opus", "Opus 4.1", "Claude Opus 4.1")).toBeLessThan(0);
	});

	test("a whole text beats the same letters inside a longer one", () => {
		expect(order("dark", "Dark", "Dark mode, and the darkest of the three")).toBeLessThan(0);
	});

	test("a longer skip costs more than a short one", () => {
		expect(order("ab", "axb", "axxxxxb")).toBeLessThan(0);
	});

	test("a word at the start of another word ranks above one in the middle", () => {
		// `new` starts the second word of one text and sits inside a word of the other.
		expect(order("new", "Chat new", "Renewable")).toBeLessThan(0);
	});

	test("camel case and a capital after a small letter start a word", () => {
		expect(order("flash", "DeepSeek Flash", "Superflashy")).toBeLessThan(0);
	});

	test("two words add up: a text that matches both well leads", () => {
		// Both words start words of the first text; the second has the first inside a word of its own.
		expect(order("claude sonnet", "Claude Sonnet 4.5", "Aclaude sonnet")).toBeLessThan(0);
	});

	test("nothing matched and a weak match are different answers", () => {
		expect(fuzzyMatch("q", "Settings")).toBeNull();
		expect(fuzzyMatch("s", "Settings")).not.toBeNull();
	});
});

describe("where the characters it matched are", () => {
	test("positions are indices of the original text, so the text can be cut up to be shown", () => {
		const found = fuzzyMatch("hai", "Claude Haiku 4.5");
		expect(found).not.toBeNull();
		expect(text("Claude Haiku 4.5", found?.positions ?? [])).toBe("Hai");
	});

	test("the positions are in the text as it is written, capitals and accents included", () => {
		const found = fuzzyMatch("cafe", "Café open");
		expect(found).not.toBeNull();
		expect(found?.positions).toEqual([0, 1, 2, 3]);
		expect(text("Café open", found?.positions ?? [])).toBe("Café");
	});

	test("two words that matched in the same place are one position", () => {
		const found = fuzzyMatch("set set", "Settings");
		expect(found?.positions).toEqual([0, 1, 2]);
	});

	test("the positions of the words are in the order they appear in the text", () => {
		const found = fuzzyMatch("sonnet claude", "Claude Sonnet 4.5");
		expect(found?.positions).toEqual([0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12]);
	});
});

describe("a limit on the characters skipped between letters", () => {
	const sentence = "Keep the Mac awake while a conversation works";

	test("without it the letters may be anywhere; with it a word whose letters are far apart does not match", () => {
		expect(fuzzyMatch("theme", sentence)).not.toBeNull();
		expect(fuzzyMatch("theme", sentence, { maxSkip: 2 })).toBeNull();
	});

	test("the letters of a word may skip up to the limit between them, and not before the first", () => {
		expect(fuzzyMatch("ntfctns", "Notifications", { maxSkip: 2 })).not.toBeNull();
		expect(fuzzyMatch("ntfctns", "Notifications", { maxSkip: 0 })).toBeNull();
		expect(fuzzyMatch("tifi", "Notifications", { maxSkip: 0 })).not.toBeNull();
	});

	test("the first alignment that keeps the limit is used, not the earliest subsequence", () => {
		// The earliest "theme" is the t of "the", the m of "Mac" and an e far off; the whole word later is the one that fits.
		const s = "the Mac, and a theme";
		const found = fuzzyMatch("theme", s, { maxSkip: 2 });
		expect(found).not.toBeNull();
		expect(text(s, found?.positions ?? [])).toBe("theme");
		expect(found?.positions).toEqual([15, 16, 17, 18, 19]);
	});

	test("each word of the query is held to it separately", () => {
		expect(fuzzyMatch("keep theme", sentence, { maxSkip: 2 })).toBeNull();
		expect(fuzzyMatch("keep awake", sentence, { maxSkip: 2 })).not.toBeNull();
	});

	test("a limit does not change the score of a match that keeps it, and none changes nothing", () => {
		expect(fuzzyMatch("ntfctns", "Notifications", { maxSkip: 2 })).toEqual(fuzzyMatch("ntfctns", "Notifications"));
		expect(fuzzyMatch("theme", sentence, {})).toEqual(fuzzyMatch("theme", sentence));
	});
});
