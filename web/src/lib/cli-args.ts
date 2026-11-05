/**
 * The CLI page's command line (`components/CliPage.tsx`): arguments shown as one line, and a line split into arguments for
 * Run, so that the arguments shown are the arguments run. A backslash is an ordinary character, so a Windows path is typed
 * as it is (`C:\Users\someone\x.jsonl`).
 */

/**
 * Split a command line: whitespace separates arguments; `'…'` and `"…"` keep everything inside as written, and quoted and
 * unquoted parts next to each other make one argument (`'it'"'"'s'` is `it's`, `''` an empty one).
 */
export function splitArgs(line: string): string[] {
	const out: string[] = [];
	let cur = "";
	let quote: "'" | '"' | null = null;
	/** The argument has begun, though it may be empty (`''`). */
	let has = false;
	for (const ch of line) {
		if (quote) {
			if (ch === quote) quote = null;
			else cur += ch;
		} else if (ch === "'" || ch === '"') {
			quote = ch;
			has = true;
		} else if (/\s/.test(ch)) {
			if (has) out.push(cur);
			cur = "";
			has = false;
		} else {
			cur += ch;
			has = true;
		}
	}
	if (has) out.push(cur);
	return out;
}

/**
 * An argument as `splitArgs` reads it back: as it is when nothing in it is special, else in single quotes, with each `'`
 * written as `'"'"'` (close, a double-quoted `'`, open again), which a POSIX shell reads the same way.
 */
function quoteArg(a: string): string {
	return a !== "" && !/[\s"']/.test(a) ? a : `'${a.replaceAll("'", `'"'"'`)}'`;
}

/** The command line that shows `args`, which `splitArgs` splits back into `args`. */
export const commandLine = (args: readonly string[]): string => args.map(quoteArg).join(" ");
