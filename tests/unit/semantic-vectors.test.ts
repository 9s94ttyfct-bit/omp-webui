import { expect, test } from "bun:test";
import { DIMENSIONS } from "../../server/semantic/assets.ts";
import {
	MAX_PASSAGES,
	PASSAGE_CHARS,
	passages,
	quantize,
	score,
	shorten,
	TAIL_PASSAGES,
} from "../../server/semantic/vectors.ts";

/** How a message becomes passages, and a model's vector a stored one that scores as the original would. */

test("a message too short to say anything has no passage", () => {
	expect(passages("ok")).toEqual([]);
	expect(passages("   继续   ")).toEqual([]);
});

test("passages cover the message in order, each where it starts, ending at a break near the limit", () => {
	const sentence = "The harvest plan names every row of the orchard. ";
	const text = sentence.repeat(80);
	const out = passages(text);
	expect(out.length).toBeGreaterThan(1);
	let at = 0;
	for (const p of out) {
		expect(p.start).toBe(at);
		expect(text.slice(p.start, p.start + p.text.length)).toBe(p.text);
		expect(p.text.length).toBeLessThanOrEqual(PASSAGE_CHARS);
		at += p.text.length;
	}
	expect(at).toBe(text.length);
	// Every passage but the last ends at the end of a sentence, never inside a word.
	for (const p of out.slice(0, -1)) expect(p.text.endsWith(". ")).toBe(true);
});

test("Chinese text breaks at its own punctuation", () => {
	const text = "我们讨论了果园的收获计划和灌溉安排。".repeat(120);
	for (const p of passages(text).slice(0, -1)) expect(p.text.endsWith("。")).toBe(true);
});

test("text with no break at all is cut at the limit", () => {
	const out = passages("x".repeat(PASSAGE_CHARS * 2 + 10));
	expect(out.map((p) => p.text.length)).toEqual([PASSAGE_CHARS, PASSAGE_CHARS, 10]);
});

test("a very long message keeps its beginning and its end", () => {
	const text = "y".repeat(PASSAGE_CHARS * 40);
	const out = passages(text);
	expect(out).toHaveLength(MAX_PASSAGES);
	const head = MAX_PASSAGES - TAIL_PASSAGES;
	expect(out.slice(0, head).map((p) => p.start)).toEqual(Array.from({ length: head }, (_, i) => i * PASSAGE_CHARS));
	expect(out.slice(head).map((p) => p.start)).toEqual(
		Array.from({ length: TAIL_PASSAGES }, (_, i) => (40 - TAIL_PASSAGES + i) * PASSAGE_CHARS),
	);
});

test("a vector is cut to its leading dimensions and normalized; one that is not a vector is refused", () => {
	const full = Array.from({ length: 768 }, (_, i) => (i < DIMENSIONS ? (i % 7) - 3 : 100));
	const v = shorten(full);
	expect(v).not.toBeNull();
	expect(v?.length).toBe(DIMENSIONS);
	const norm = Math.sqrt([...(v as Float32Array)].reduce((s, x) => s + x * x, 0));
	expect(norm).toBeCloseTo(1, 5);

	expect(shorten(full.slice(0, DIMENSIONS - 1))).toBeNull();
	expect(shorten([null, ...full.slice(1)])).toBeNull();
	expect(shorten([Number.NaN, ...full.slice(1)])).toBeNull();
	expect(shorten(new Array(768).fill(0))).toBeNull();
});

test("a stored vector scores within a hair of the cosine of the original", () => {
	let seed = 7;
	const random = () => {
		seed = (seed * 1103515245 + 12345) % 2 ** 31;
		return seed / 2 ** 31 - 0.5;
	};
	const a = shorten(Array.from({ length: DIMENSIONS }, random)) as Float32Array;
	const b = shorten(Array.from({ length: DIMENSIONS }, random)) as Float32Array;
	const mix = shorten([...a].map((x, i) => x + 0.5 * (b[i] as number))) as Float32Array;
	const store = new Int8Array(DIMENSIONS * 2);
	const scales: number[] = [];
	for (const [i, v] of [b, mix].entries()) {
		const { q, scale } = quantize(v);
		store.set(q, i * DIMENSIONS);
		scales.push(scale);
	}
	const cos = (x: Float32Array, y: Float32Array) => x.reduce((s, v, i) => s + v * (y[i] as number), 0);
	expect(Math.abs(score(a, store, 0, scales[0] as number) - cos(a, b))).toBeLessThan(0.01);
	expect(Math.abs(score(a, store, 1, scales[1] as number) - cos(a, mix))).toBeLessThan(0.01);
});
