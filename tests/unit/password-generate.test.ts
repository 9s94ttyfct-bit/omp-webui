import { expect, test } from "bun:test";
import {
	generatePassword,
	PASSWORD_ALPHABET,
	PASSWORD_LENGTH,
	randomInt,
} from "../../web/src/lib/password-generate.ts";

/** Fake `fill` that serves the given draws in order, cycling, and counts its calls. */
function fakeFill(draws: number[]) {
	const state = { calls: 0, position: 0 };
	const fill = (a: Uint32Array) => {
		state.calls++;
		for (let k = 0; k < a.length; k++) a[k] = draws[state.position++ % draws.length] as number;
	};
	return { fill, state };
}

/** 0 for an upper-case letter, 1 lower-case, 2 digit, 3 symbol. */
function classOf(c: string): number {
	return /[A-Z]/.test(c) ? 0 : /[a-z]/.test(c) ? 1 : /\d/.test(c) ? 2 : 3;
}

/** True when every count is within +-tolerance (relative) of the expected count. */
function uniform(counts: number[], expectedPerChar: number, tolerance: number): boolean {
	return counts.every((c) => Math.abs(c - expectedPerChar) <= expectedPerChar * tolerance);
}

function countChars(passwords: string[]): number[] {
	const counts = new Array<number>(PASSWORD_ALPHABET.length).fill(0);
	for (const p of passwords) for (const c of p) counts[PASSWORD_ALPHABET.indexOf(c)]++;
	return counts;
}

/**
 * The largest distance of a count from its class's mean, in binomial sigmas, and the character it belongs to. With T
 * draws in a class of k characters, one character's count is Binomial(T, 1/k): mean T/k, variance T/k*(1-1/k). The
 * class totals are not compared with anything.
 */
function worstWithinClass(counts: number[]): { sigmas: number; index: number } {
	let worst = { sigmas: 0, index: -1 };
	for (let cls = 0; cls < 4; cls++) {
		const members = Array.from(PASSWORD_ALPHABET, (_, i) => i).filter(
			(i) => classOf(PASSWORD_ALPHABET[i] as string) === cls,
		);
		const total = members.reduce((sum, i) => sum + (counts[i] as number), 0);
		const p = 1 / members.length;
		const sigma = Math.sqrt(total * p * (1 - p));
		for (const i of members) {
			const z = Math.abs((counts[i] as number) - total * p) / sigma;
			if (z > worst.sigmas) worst = { sigmas: z, index: i };
		}
	}
	return worst;
}

test("the alphabet has at least 64 distinct characters and none that look alike or need shell escaping", () => {
	expect(PASSWORD_ALPHABET.length).toBeGreaterThanOrEqual(64);
	expect(new Set(PASSWORD_ALPHABET).size).toBe(PASSWORD_ALPHABET.length);
	for (const c of "0Oo1lI|`'\" \\$;&<>(){}[]~#^?!*") expect(PASSWORD_ALPHABET.includes(c)).toBe(false);
	expect(/[A-Z]/.test(PASSWORD_ALPHABET) && /[a-z]/.test(PASSWORD_ALPHABET)).toBe(true);
	expect(/\d/.test(PASSWORD_ALPHABET)).toBe(true);
	// 24 characters carry at least 140 bits.
	expect(PASSWORD_LENGTH * Math.log2(PASSWORD_ALPHABET.length)).toBeGreaterThanOrEqual(140);
});

test("the default length is 24 and an explicit length is honoured", () => {
	expect(PASSWORD_LENGTH).toBe(24);
	expect(generatePassword()).toHaveLength(24);
	for (const length of [8, 9, 32, 100, 256]) expect(generatePassword(length)).toHaveLength(length);
});

test("lengths below 8 and above 256 throw RangeError", () => {
	expect(() => generatePassword(7)).toThrow(RangeError);
	expect(() => generatePassword(257)).toThrow(RangeError);
	expect(() => generatePassword(Number.NaN)).toThrow(RangeError);
	expect(() => generatePassword(12.5)).toThrow(RangeError);
});

test("every character comes from the alphabet and every password has all four classes", () => {
	for (let k = 0; k < 2000; k++) {
		const p = generatePassword(k % 2 === 0 ? PASSWORD_LENGTH : 8);
		for (const c of p) expect(PASSWORD_ALPHABET.includes(c)).toBe(true);
		expect(/[A-Z]/.test(p)).toBe(true);
		expect(/[a-z]/.test(p)).toBe(true);
		expect(/\d/.test(p)).toBe(true);
		expect(/[^A-Za-z\d]/.test(p)).toBe(true);
		for (const c of "0Oo1lI|`'\" \\") expect(p.includes(c)).toBe(false);
	}
});

test("randomInt rejects draws at or above the largest multiple of max and uses the next draw", () => {
	for (const max of [3, 7, 66, 250, 1000]) {
		const limit = Math.floor(2 ** 32 / max) * max;
		// Draws in [limit, 2**32) must be skipped; the first draw below the limit is reduced modulo max.
		const { fill, state } = fakeFill([limit, 0xffffffff, limit - 1]);
		expect(randomInt(max, fill)).toBe((limit - 1) % max);
		expect(state.calls).toBe(3);
	}
	// max = 3: the single biased value is 2**32 - 1 itself (floor(2**32 / 3) * 3 = 2**32 - 1).
	const three = fakeFill([0xffffffff, 7]);
	expect(randomInt(3, three.fill)).toBe(1);
	expect(three.state.calls).toBe(2);
	// A draw just below the limit is accepted at once.
	const ok = fakeFill([0xfffffffe]);
	expect(randomInt(3, ok.fill)).toBe(0xfffffffe % 3);
	expect(ok.state.calls).toBe(1);
});

test("randomInt accepts every draw when max is 2**32 and returns 0 when max is 1", () => {
	const all = fakeFill([0xffffffff]);
	expect(randomInt(2 ** 32, all.fill)).toBe(0xffffffff);
	expect(all.state.calls).toBe(1);
	const zero = fakeFill([0]);
	expect(randomInt(2 ** 32, zero.fill)).toBe(0);
	expect(randomInt(1, fakeFill([123456]).fill)).toBe(0);
	expect(randomInt(2 ** 31, fakeFill([0xffffffff]).fill)).toBe(2 ** 31 - 1);
});

test("randomInt rejects a max outside [1, 2**32]", () => {
	for (const max of [0, -1, 2 ** 32 + 1, 1.5, Number.NaN]) {
		expect(() => randomInt(max, fakeFill([0]).fill)).toThrow(RangeError);
	}
});

test("randomInt is uniform for small ranges", () => {
	for (const max of [3, 7, 250]) {
		const draws = 60_000;
		const counts = new Array<number>(max).fill(0);
		for (let k = 0; k < draws; k++) counts[randomInt(max)]++;
		const expected = draws / max;
		// 6 sigma of the binomial count, relative: across a few hundred bins 5 sigma fails about once in 6,000 runs.
		const tolerance = (6 * Math.sqrt(draws * (1 / max) * (1 - 1 / max))) / expected;
		expect(uniform(counts, expected, tolerance)).toBe(true);
	}
});

test("generatePassword draws from crypto.getRandomValues and never from Math.random", () => {
	const realRandom = Math.random;
	const realGet = globalThis.crypto.getRandomValues;
	let calls = 0;
	const spy = ((a: Uint32Array) => {
		calls++;
		return realGet.call(globalThis.crypto, a);
	}) as typeof globalThis.crypto.getRandomValues;
	Math.random = () => {
		throw new Error("Math.random must not be used");
	};
	globalThis.crypto.getRandomValues = spy;
	try {
		const p = generatePassword();
		expect(p).toHaveLength(24);
		expect(calls).toBeGreaterThan(0);
		expect(randomInt(10)).toBeLessThan(10);
	} finally {
		Math.random = realRandom;
		globalThis.crypto.getRandomValues = realGet;
	}
});

test("the password is a pure function of the raw draws, and a password missing a class is resampled", () => {
	const unusable = [0xffffffff, 0xfffffffd]; // above the limit for 66 characters: skipped
	const first = new Array<number>(PASSWORD_LENGTH).fill(0); // 24 x "A": no lower, digit or symbol
	const second = Array.from({ length: PASSWORD_LENGTH }, (_, k) => (k * 3) % PASSWORD_ALPHABET.length);
	const expected = second.map((i) => PASSWORD_ALPHABET[i]).join("");
	const stream = [...unusable, ...first, ...unusable, ...second];

	const a = fakeFill(stream);
	const b = fakeFill(stream);
	const pa = generatePassword(PASSWORD_LENGTH, a.fill);
	expect(pa).toBe(expected);
	expect(generatePassword(PASSWORD_LENGTH, b.fill)).toBe(pa);
	// 2 + 24 + 2 + 24 draws are consumed, 32 per fill call.
	expect(a.state.calls).toBe(2);
	expect(/[A-Z]/.test(pa) && /[a-z]/.test(pa) && /\d/.test(pa) && /[^A-Za-z\d]/.test(pa)).toBe(true);
});

test("within each character class the characters of 10,000 passwords are uniform, and a modulo-biased generator fails the same check", () => {
	const passwords = Array.from({ length: 10_000 }, () => generatePassword());
	const samples = passwords.length * PASSWORD_LENGTH;
	const n = PASSWORD_ALPHABET.length;
	// Requiring all four classes makes digits and symbols likelier than their share of the alphabet, so class totals
	// are not compared. Within a class the characters are exactly uniform: acceptance depends only on which class each
	// position is in, and permuting the characters of a class keeps a password qualifying. Given the class total T,
	// one of k characters has count Binomial(T, 1/k); 6 sigma is exceeded about once in 10^9 per character.
	const sigmas = 6;
	expect(worstWithinClass(countChars(passwords)).sigmas).toBeLessThan(sigmas);

	// Negative control: one random byte modulo n. 256 = 3 * 66 + 58, so the last 8 characters get 3/256 instead of
	// 4/256 of the draws. Upper, lower and digits all sit below index 58 and stay uniform; the symbols (indices 56
	// to 65) split in two: 56 and 57 get 4 parts in 32, the other eight 3, which is ~14 sigma for index 56.
	const biased = new Array<number>(n).fill(0);
	const bytes = new Uint8Array(samples);
	for (let off = 0; off < samples; off += 65_536) {
		crypto.getRandomValues(bytes.subarray(off, Math.min(off + 65_536, samples)));
	}
	for (const b of bytes) biased[b % n]++;
	const worst = worstWithinClass(biased);
	expect(worst.sigmas).toBeGreaterThan(sigmas);
	expect(classOf(PASSWORD_ALPHABET[worst.index] as string)).toBe(3);
});
