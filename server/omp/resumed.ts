import { resolve } from "node:path";

/**
 * Which saved conversations a terminal's `omp` command line opens again, as far as the line says: the web UI's own omp
 * for any of them must be closed first (`LivePool.release`), or two processes write one session and omp saves the
 * history as two files.
 */
export type Resumed =
	/** `--resume <file>.jsonl`. */
	| { by: "file"; file: string }
	/** `--resume <id prefix>`: omp matches the start of a session's id. */
	| { by: "id"; prefix: string }
	/**
	 * `-c`/`--continue` (the newest session of the folder omp runs in) and `--resume` with no value (omp asks which of the
	 * sessions to open): any conversation of that folder may be the one.
	 */
	| { by: "folder"; cwd: string };

/** `-r`, `--resume` and `--restore`, with their value attached (`=x`) or not. */
const RESUME_FLAG = /^(?:-r|--resume|--restore)(?:=(.*))?$/;

/**
 * What the `omp` command line `args` opens again when it runs in the folder `cwd` (`--cwd` moves it). A flag's value is
 * the next word unless that is another flag, as omp reads it. A line that opens no old conversation: nothing.
 */
export function resumedSessions(args: string[], cwd: string): Resumed[] {
	let dir = cwd;
	for (let i = 0; i < args.length; i++) {
		const eq = /^--cwd=(.*)$/.exec(args[i]);
		const value = eq ? eq[1] : args[i] === "--cwd" ? args[i + 1] : undefined;
		if (value) dir = resolve(cwd, value);
	}
	const found: Resumed[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "-c" || a === "--continue") {
			found.push({ by: "folder", cwd: dir });
			continue;
		}
		const flag = RESUME_FLAG.exec(a);
		if (!flag) continue;
		const next = args[i + 1];
		const value = flag[1] ?? (typeof next === "string" && !next.startsWith("-") ? next : "");
		if (!value) found.push({ by: "folder", cwd: dir });
		else if (value.endsWith(".jsonl")) found.push({ by: "file", file: resolve(dir, value) });
		else found.push({ by: "id", prefix: value });
	}
	return found;
}
