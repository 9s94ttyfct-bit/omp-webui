/**
 * The CLI page's command line (`components/CliPage.tsx`): arguments shown as one line, and a line split into arguments for
 * Run, both by POSIX shell rules, so that the arguments shown are the arguments run.
 */

/**
 * Split a command line as a POSIX shell does, without expansions: whitespace separates arguments; `'…'` keeps everything
 * as written; a backslash outside quotes takes the next character as it is; inside `"…"` it does so only before `"`, `\`,
 * `$` and `` ` `` and is kept before any other character.
 */
export function splitArgs(line: string): string[] {
	const out: string[] = [];
	let cur = "";
	let quote: "'" | '"' | null = null;
	/** The argument has begun, though it may be empty (`''`). */
	let has = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i] as string;
		if (quote === "'") {
			if (ch === "'") quote = null;
			else cur += ch;
		} else if (quote === '"') {
			if (ch === '"') quote = null;
			else if (ch === "\\" && i + 1 < line.length && '"\\$`'.includes(line[i + 1] as string)) cur += line[++i];
			else cur += ch;
		} else if (ch === "'" || ch === '"') {
			quote = ch;
			has = true;
		} else if (ch === "\\" && i + 1 < line.length) {
			cur += line[++i];
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

/** An argument as a shell reads it back: as it is when nothing in it is special, else in single quotes (`'` as `'\''`). */
function quoteArg(a: string): string {
	return a !== "" && !/[\s"'\\]/.test(a) ? a : `'${a.replaceAll("'", "'\\''")}'`;
}

/** The command line that shows `args`, which `splitArgs` splits back into `args`. */
export const commandLine = (args: readonly string[]): string => args.map(quoteArg).join(" ");
