import { DIMENSIONS } from "./assets.ts";

/**
 * What semantic search does with text and vectors, apart from where they are kept: how a message is cut into passages, how a
 * model's vector is shortened and stored, and how stored vectors are scored against a query.
 */

/** A passage is about this many characters: a few hundred tokens, which the model reads whole and in one piece of meaning. */
export const PASSAGE_CHARS = 1000;
/**
 * At most this many passages of one message are indexed (a pasted log of hundreds of kilobytes would otherwise be thousands):
 * a longer message is indexed by its beginning and its end (`TAIL_PASSAGES`), where what it is about is usually said.
 */
export const MAX_PASSAGES = 16;
export const TAIL_PASSAGES = 4;
/** A message shorter than this ("ok", "继续") says nothing to search for, and would come up for any short query. */
export const MIN_CHARS = 8;

export interface Passage {
	/** Where the passage begins in the message (UTF-16 offset). */
	start: number;
	text: string;
}

/** Where a passage may end: a paragraph, a line, a sentence (Chinese or Latin), a word, in that order of preference. */
const BREAKS = ["\n\n", "\n", "。", "！", "？", ". ", "! ", "? ", "；", "; ", "，", ", ", " "];

/**
 * `text` cut into passages of about `PASSAGE_CHARS`, each ending where the text breaks if one is near the end; of a message
 * longer than `MAX_PASSAGES` of them, the first and the last `TAIL_PASSAGES`.
 */
export function passages(text: string): Passage[] {
	if ([...text.trim()].length < MIN_CHARS) return [];
	const out: Passage[] = [];
	let at = 0;
	while (at < text.length) {
		let end = Math.min(at + PASSAGE_CHARS, text.length);
		if (end < text.length) {
			const floor = at + Math.floor(PASSAGE_CHARS * 0.6);
			for (const b of BREAKS) {
				const i = text.lastIndexOf(b, end - b.length);
				if (i >= floor) {
					end = i + b.length;
					break;
				}
			}
		}
		const piece = text.slice(at, end);
		if (piece.trim()) out.push({ start: at, text: piece });
		at = end;
	}
	if (out.length <= MAX_PASSAGES) return out;
	return [...out.slice(0, MAX_PASSAGES - TAIL_PASSAGES), ...out.slice(-TAIL_PASSAGES)];
}

/**
 * The model's vector cut to its first `DIMENSIONS` (a Matryoshka model's leading dimensions are a vector of their own) and
 * normalized again. Null for a vector that is not one (too short, not finite: llama.cpp answers NaN as null).
 */
export function shorten(vector: readonly (number | null)[]): Float32Array | null {
	if (vector.length < DIMENSIONS) return null;
	const out = new Float32Array(DIMENSIONS);
	let norm = 0;
	for (let i = 0; i < DIMENSIONS; i++) {
		const x = vector[i];
		if (typeof x !== "number" || !Number.isFinite(x)) return null;
		out[i] = x;
		norm += x * x;
	}
	if (!(norm > 0)) return null;
	const inv = 1 / Math.sqrt(norm);
	for (let i = 0; i < DIMENSIONS; i++) out[i] = (out[i] as number) * inv;
	return out;
}

/** A unit vector as one byte a dimension and the scale that gives it back (`x ≈ q * scale`): a quarter of the room of floats. */
export function quantize(unit: Float32Array): { q: Int8Array; scale: number } {
	let max = 0;
	for (const x of unit) max = Math.max(max, Math.abs(x));
	const scale = max > 0 ? max / 127 : 1;
	const q = new Int8Array(unit.length);
	for (let i = 0; i < unit.length; i++) q[i] = Math.round((unit[i] as number) / scale);
	return { q, scale };
}

/** The cosine of a query (a unit vector) and the stored vector `i` of `store`. */
export function score(query: Float32Array, store: Int8Array, i: number, scale: number): number {
	const base = i * DIMENSIONS;
	let dot = 0;
	for (let d = 0; d < DIMENSIONS; d++) dot += (query[d] as number) * (store[base + d] as number);
	return dot * scale;
}
