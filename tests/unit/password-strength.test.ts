import { expect, test } from "bun:test";
import { generatePassword } from "../../web/src/lib/password-generate.ts";
import {
	estimateStrength,
	getPassphraseWords,
	type StrengthReason,
	suggestPassphrase,
} from "../../web/src/lib/password-strength.ts";

/** mulberry32: a small seeded PRNG, so every run draws the same passwords. */
function seeded(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function seededInt(seed: number): (n: number) => number {
	const next = seeded(seed);
	return (n) => Math.floor(next() * n);
}

const PRINTABLE = Array.from({ length: 94 }, (_, k) => String.fromCharCode(33 + k)).join("");

function randomPrintable(length: number, rand: () => number): string {
	let out = "";
	for (let k = 0; k < length; k++) out += PRINTABLE[Math.floor(rand() * PRINTABLE.length)];
	return out;
}

const weakPasswords = [
	"password",
	"Password1",
	"qwerty123",
	"iloveyou",
	"abcdefgh",
	"12345678",
	"11111111",
	"19900101",
	"P@ssw0rd!",
];

test("well-known weak passwords score 0 or 1", () => {
	for (const p of weakPasswords) expect(estimateStrength(p).score).toBeLessThanOrEqual(1);
});

test("a 24-character random password scores 4", () => {
	const rand = seeded(7);
	for (let k = 0; k < 200; k++) expect(estimateStrength(randomPrintable(24, rand)).score).toBe(4);
	for (let k = 0; k < 200; k++) expect(estimateStrength(generatePassword()).score).toBe(4);
});

test("a long passphrase with spaces is strong and Tr0ub4dor&3 is fair", () => {
	const horse = estimateStrength("correct horse battery staple");
	expect(horse.score).toBeGreaterThanOrEqual(3);
	expect(horse.reasons).toEqual([]);
	expect(estimateStrength("Tr0ub4dor&3").score).toBe(2);
});

test("every 5-word suggestion scores 4 and a 3-word one scores 2 or 3", () => {
	const rand = seededInt(2024);
	for (let k = 0; k < 3000; k++) {
		const s = estimateStrength(suggestPassphrase(rand));
		expect(s.score).toBe(4);
		expect(s.reasons).toEqual([]);
	}
	for (let k = 0; k < 3000; k++) {
		const s = estimateStrength(suggestPassphrase(rand, 3));
		expect(s.score).toBeGreaterThanOrEqual(2);
		expect(s.score).toBeLessThanOrEqual(3);
	}
});

test("the worst five words of the list still score 4 (the cheapest words, as a human would pick them)", () => {
	const words = getPassphraseWords();
	for (let start = 0; start + 5 <= 50; start++) {
		expect(estimateStrength(words.slice(start, start + 5).join("-")).score).toBe(4);
		expect(estimateStrength(words.slice(start, start + 5).join(" ")).score).toBe(4);
	}
});

test("the empty string scores 0 with the reason short", () => {
	expect(estimateStrength("")).toEqual({ score: 0, guessesLog10: 0, reasons: ["short"] });
});

test("weaknesses are reported with their reasons", () => {
	const reasons = (p: string): StrengthReason[] => estimateStrength(p).reasons;
	expect(reasons("qwerty123")).toContain("keyboard");
	expect(reasons("aaaaaaaaaaaa")).toContain("repeat");
	expect(reasons("abcdefghijkl")).toContain("sequence");
	expect(reasons("19900101")).toContain("date");
	expect(reasons("Summer2023!")).toEqual(expect.arrayContaining(["word", "date"]));
	expect(reasons("password")).toContain("common");
	expect(reasons("P@ssw0rd!")).toContain("common");
	expect(reasons("12345678")).toContain("common");
	expect(reasons("1qaz2wsx")).toContain("keyboard");
	expect(reasons("abcabcabcabc")).toContain("repeat");
	expect(reasons("123123123123")).toContain("repeat");
	expect(reasons("19/04/1990")).toContain("date");
	expect(reasons("190490")).toContain("date");
	expect(reasons("987654321012")).toContain("sequence");
	expect(reasons("monkeybanana")).toContain("singleKind");
	expect(reasons("190490")).toContain("singleKind");
	expect(reasons("Autumn4Dragon")).toContain("word");
	// Short passwords always say so; long ones never do.
	expect(reasons("Aa1!xY")).toContain("short");
	expect(reasons("abcdefghijkl")).not.toContain("short");
});

test("reasons are at most 3, without duplicates, and short is never dropped", () => {
	const rand = seeded(11);
	const samples = [
		...weakPasswords,
		"qwerty123456",
		"abcabc123123",
		"Password123456",
		"19900101abcd",
		"1234",
		"a",
		...Array.from({ length: 300 }, () => randomPrintable(1 + Math.floor(rand() * 20), rand)),
	];
	for (const p of samples) {
		const { reasons } = estimateStrength(p);
		expect(reasons.length).toBeLessThanOrEqual(3);
		expect(new Set(reasons).size).toBe(reasons.length);
		if ([...p].length < 12) expect(reasons).toContain("short");
		else expect(reasons).not.toContain("short");
	}
});

test("a strong password lists no reasons", () => {
	expect(estimateStrength("xK9#mQ2$vLp7@nR4wZ8&tY3!").reasons).toEqual([]);
});

test("non-ASCII passwords: a repeat is weak, random ideographs are not", () => {
	const repeated = estimateStrength("密码密码密码密码");
	expect(repeated.score).toBeLessThanOrEqual(1);
	expect(repeated.reasons).toContain("repeat");
	const rand = seeded(3);
	for (let k = 0; k < 50; k++) {
		const ideographs = Array.from({ length: 8 }, () => String.fromCodePoint(0x4e00 + Math.floor(rand() * 0x51a5))).join(
			"",
		);
		expect(estimateStrength(ideographs).score).toBeGreaterThanOrEqual(3);
	}
	expect(estimateStrength("héllo wörld ünïcode").score).toBeGreaterThanOrEqual(3);
});

test("input is NFKC-normalised: full-width letters count as the ASCII word", () => {
	expect(estimateStrength("ｐａｓｓｗｏｒｄ").score).toBe(0);
});

test("the same input always gives the same result", () => {
	for (const p of [...weakPasswords, "Tr0ub4dor&3", "correct horse battery staple", "密码密码"]) {
		expect(estimateStrength(p)).toEqual(estimateStrength(p));
	}
});

test("200-character inputs are analysed in under 20 ms (best of seven) and inputs over 256 characters from the first 256", () => {
	estimateStrength("warm up the dictionary");
	const rand = seeded(5);
	const inputs = [
		randomPrintable(200, rand),
		"a".repeat(200),
		"ab".repeat(100),
		"1234567890".repeat(20),
		"qwertyuiop".repeat(20),
		"password".repeat(25),
		"Summer2023!".repeat(18),
		"密码".repeat(100),
		"p@ssw0rd-".repeat(23),
	];
	for (const input of inputs) {
		// The best of several runs: a busy machine (the suite runs in parallel) can stall one run, not all of them, and a
		// cost that grows with the input would show in every run.
		const times: number[] = [];
		for (let run = 0; run < 7; run++) {
			const t0 = performance.now();
			estimateStrength(input);
			times.push(performance.now() - t0);
		}
		expect(Math.min(...times)).toBeLessThan(20);
		expect(estimateStrength(input).score).toBeGreaterThanOrEqual(0);
	}
	expect(estimateStrength(randomPrintable(5000, rand)).score).toBe(4);
	const long = randomPrintable(300, rand);
	expect(estimateStrength(long)).toEqual(estimateStrength(long.slice(0, 256)));
});

test("suggestPassphrase gives distinct words from the list joined by dashes, using only the injected random", () => {
	const list = new Set(getPassphraseWords());
	for (let seed = 1; seed <= 200; seed++) {
		for (const words of [1, 3, 5, 8]) {
			const parts = suggestPassphrase(seededInt(seed), words).split("-");
			expect(parts).toHaveLength(words);
			expect(new Set(parts).size).toBe(words);
			for (const w of parts) expect(list.has(w)).toBe(true);
		}
	}
	expect(suggestPassphrase(seededInt(9))).toBe(suggestPassphrase(seededInt(9)));
	expect(suggestPassphrase(seededInt(9))).not.toBe(suggestPassphrase(seededInt(10)));
	expect(suggestPassphrase(seededInt(9)).split("-")).toHaveLength(5);
});

test("suggestPassphrase draws exactly one number per word, each below the number of words still unpicked", () => {
	const seen: number[] = [];
	const total = getPassphraseWords().length;
	suggestPassphrase((n) => {
		seen.push(n);
		return 0;
	}, 4);
	expect(seen).toEqual([total, total - 1, total - 2, total - 3]);
	// Always picking the first word of the shrinking pool walks the sorted list from the start.
	expect(suggestPassphrase(() => 0, 3)).toBe(getPassphraseWords().slice(0, 3).join("-"));
	expect(() => suggestPassphrase(() => 0, 0)).toThrow(RangeError);
	expect(() => suggestPassphrase(() => 0, total + 1)).toThrow(RangeError);
});

test("the suggestion list has at least 512 distinct easy words, sorted, none a prefix of another", () => {
	const words = getPassphraseWords();
	expect(words.length).toBeGreaterThanOrEqual(512);
	expect(new Set(words).size).toBe(words.length);
	for (const w of words) expect(/^[a-z]{4,8}$/.test(w)).toBe(true);
	expect([...words].sort()).toEqual([...words]);
	// Sorted, so a word that is a prefix of another comes right before some word it prefixes.
	for (let k = 0; k + 1 < words.length; k++)
		expect((words[k + 1] as string).startsWith(words[k] as string)).toBe(false);
	const clashes = words.flatMap((a) => words.filter((b) => a !== b && b.startsWith(a)).map((b) => `${a}<${b}`));
	expect(clashes).toEqual([]);
});
