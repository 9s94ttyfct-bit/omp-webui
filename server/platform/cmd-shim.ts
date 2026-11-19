import { win32 } from "node:path";

/**
 * What npm's Windows launcher for a global package (`%APPDATA%\npm\omp.cmd`, a `cmd-shim`) runs, read from the shim itself
 * (#296, #288). Bun refuses to start a `.cmd` with an argument that has a cmd.exe metacharacter (`"`, `%`, `&`, `|`, `<`, `>`,
 * `^`, a line end: `omp config set disabledExtensions ["skill:x"]` is one), and an older Bun lets cmd.exe drop or expand them,
 * so what the shim runs is started instead, with the arguments given as they are.
 *
 * The shim (`cmd-shim` 6, the template npm writes) ends with
 *
 *     IF EXIST "%dp0%\bun.exe" (
 *       SET "_prog=%dp0%\bun.exe"
 *     ) ELSE (
 *       SET "_prog=bun"
 *       SET PATHEXT=%PATHEXT:;.JS;=;%
 *     )
 *     endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\pkg\bin\cli.js" %*
 *
 * `%dp0%` is the shim's own folder. Null for a file that is not such a shim.
 */
export function parseCmdShim(text: string, dir: string, exists: (path: string) => boolean): string[] | null {
	const last = text
		.split(/\r?\n/)
		.reverse()
		.find((line) => line.includes('"%_prog%"'));
	if (!last) return null;
	const tail = last.slice(last.indexOf('"%_prog%"') + '"%_prog%"'.length);
	const args: string[] = [];
	for (const m of tail.matchAll(/"([^"]*)"|(%\*)|(\S+)/g)) {
		if (m[2]) break;
		args.push((m[1] ?? m[3]).replace(/%~?dp0%?/gi, dir));
	}
	if (args.length === 0) return null;
	const own = (arg: string) => win32.normalize(arg);

	// The program: the one beside the shim when there is one, else the name the shim falls back on.
	const progs = [...text.matchAll(/SET "_prog=([^"]+)"/gi)].map((m) => m[1].replace(/%~?dp0%?/gi, dir));
	if (progs.length === 0) return null;
	const beside = progs.find((p) => win32.isAbsolute(p) && !p.includes("%"));
	const program = beside && exists(own(beside)) ? own(beside) : progs[progs.length - 1];
	return [program, ...args.map((a) => (a.includes("\\") || a.includes("/") ? own(a) : a))];
}

/** The script a shim's command line runs: its first argument that is not an option. */
export function shimScript(command: string[]): string | null {
	return command.slice(1).find((a) => !a.startsWith("-")) ?? null;
}

/**
 * `command` as it is started: an npm shim (`omp.cmd`) is replaced by the program and script it runs, any other command is
 * as it was. A `.cmd` that is not an npm shim (or cannot be read) is left to be started as it is.
 */
export function launchArgv(
	command: string[],
	read: (path: string) => string | null,
	exists: (path: string) => boolean,
): string[] {
	const bin = command[0];
	if (typeof bin !== "string" || !/\.(cmd|bat)$/i.test(bin)) return command;
	const text = read(bin);
	const resolved = text === null ? null : parseCmdShim(text, win32.dirname(bin), exists);
	return resolved ? [...resolved, ...command.slice(1)] : command;
}
