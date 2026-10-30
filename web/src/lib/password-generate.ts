/**
 * Random password for the export password field (Settings > Move to another computer).
 * Randomness comes only from crypto.getRandomValues (or an injected `fill` in tests); never Math.random.
 */

const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnpqrstuvwxyz";
const DIGITS = "23456789";
const SYMBOLS = "-_.,:=+@%/";

/**
 * Upper + lower + digits + symbols, 66 characters (6.04 bits each, 145 bits for 24).
 * Left out: the look-alikes 0 O o 1 l I | ` ' " and everything a shell or a URL treats specially
 * (space \ $ ; & < > ( ) { } [ ] ~ # ^ ? ! *). The symbols kept are - _ . , : = + @ % /, which survive copy/paste
 * into a terminal, a form and a chat message without escaping.
 */
export const PASSWORD_ALPHABET = UPPER + LOWER + DIGITS + SYMBOLS;
export const PASSWORD_LENGTH = 24;

const MIN_LENGTH = 8;
const MAX_LENGTH = 256;
const BATCH = 32;
const TWO_32 = 2 ** 32;

/** Fills the array with random 32-bit words; a returned value is ignored. */
type Fill = (a: Uint32Array) => unknown;

/** Unbiased integers in [0, max) by rejection sampling over 32-bit draws, taken `batch` words per `fill` call. */
function sampler(fill: Fill | undefined, batch: number): (max: number) => number {
	const draw: Fill = fill ?? ((a) => globalThis.crypto.getRandomValues(a));
	const words = new Uint32Array(batch);
	let next = batch;
	return (max) => {
		if (!Number.isInteger(max) || max < 1 || max > TWO_32)
			throw new RangeError(`max must be an integer in [1, 2**32]: ${max}`);
		// Draws at or above the largest multiple of max would make small results likelier: reject them.
		const limit = Math.floor(TWO_32 / max) * max;
		for (;;) {
			if (next === batch) {
				draw(words);
				next = 0;
			}
			const v = words[next++] as number;
			if (v < limit) return v % max;
		}
	};
}

/** An unbiased integer in [0, max): rejection sampling over 32-bit draws from `fill` (default crypto.getRandomValues). */
export function randomInt(max: number, fill?: Fill): number {
	return sampler(fill, 1)(max);
}

/**
 * `length` characters of PASSWORD_ALPHABET. The whole password is resampled until it holds an upper, a lower, a digit
 * and a symbol; conditioning by rejection keeps it uniform over the passwords that qualify.
 */
export function generatePassword(length: number = PASSWORD_LENGTH, fill?: Fill): string {
	if (!Number.isInteger(length) || length < MIN_LENGTH || length > MAX_LENGTH) {
		throw new RangeError(`length must be an integer in [${MIN_LENGTH}, ${MAX_LENGTH}]: ${length}`);
	}
	const next = sampler(fill, BATCH);
	const upperEnd = UPPER.length;
	const lowerEnd = upperEnd + LOWER.length;
	const digitEnd = lowerEnd + DIGITS.length;
	for (;;) {
		let out = "";
		let classes = 0;
		for (let k = 0; k < length; k++) {
			const idx = next(PASSWORD_ALPHABET.length);
			out += PASSWORD_ALPHABET[idx];
			classes |= 1 << (idx < upperEnd ? 0 : idx < lowerEnd ? 1 : idx < digitEnd ? 2 : 3);
		}
		if (classes === 0b1111) return out;
	}
}
