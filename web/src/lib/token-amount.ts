/**
 * A token amount typed the way the page prints them (`fmtTokens`: `200k`, `1.5M`, `2B`) or as plain digits, with
 * `,`, `_` or spaces between thousands. What cannot be read is `null`, never a guess: a budget of 200 for "200k" would
 * end the goal after its first request.
 */

const UNITS: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };

/** `12`, `12.5`, `1,200,000`, `1 200 000`, `1_000`, optionally followed by `k`, `m` or `b`. */
const AMOUNT = /^(\d+(?:[ ,_]\d{3})*|\d*)(?:\.(\d+))?([kmb])?$/i;

/**
 * The positive whole number of tokens `text` stands for. An empty field is `undefined` (no amount); anything that is not
 * a positive amount, or is too big to count, is `null`.
 */
export function parseTokenAmount(text: string): number | undefined | null {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	const m = AMOUNT.exec(trimmed);
	if (!m) return null;
	const whole = m[1].replace(/[ ,_]/g, "");
	const fraction = m[2] ?? "";
	if (!whole && !fraction) return null;
	const unit = m[3] ? UNITS[m[3].toLowerCase()] : 1;
	// A fraction needs a unit to mean something: `1.5` is not a count of tokens.
	if (fraction && !m[3]) return null;
	const value = Math.round(Number(`${whole || "0"}.${fraction || "0"}`) * unit);
	return Number.isSafeInteger(value) && value >= 1 ? value : null;
}
