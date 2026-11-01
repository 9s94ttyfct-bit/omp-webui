import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, linkSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { platformId } from "../../server/platform/capabilities.ts";

/**
 * A program a test hands the server (an `OMP_BIN`) that is a script run by Bun, written into `dir`; returns the path to run
 * it by. On macOS and Linux it is one executable file, `name`, with a `#!` line. Windows runs no `#!` line, nor a script
 * by its name: there the program is `<name>.exe`, a small Bun executable (`bun build --compile`, made once per Bun and
 * linked in) that runs the script beside it, `<name>.ts`, with the arguments it was given. The arguments a script sees
 * (`process.argv.slice(2)`) are the same on every system.
 */

/** A program `name` whose code is `source` (JavaScript or TypeScript; a `#!` line at its top is left to Bun to skip). */
export function writeBunProgram(dir: string, name: string, source: string): string {
	if (platformId !== "win32") {
		const bin = join(dir, name);
		writeFileSync(bin, source.startsWith("#!") ? source : `#!/usr/bin/env bun\n${source}`);
		chmodSync(bin, 0o755);
		return bin;
	}
	writeFileSync(join(dir, `${name}.ts`), source);
	return linkLauncher(dir, name);
}

/** A program `name` that runs the script at `script` (an absolute path) with the arguments it is given. */
export function writeBunLauncher(dir: string, name: string, script: string): string {
	if (platformId !== "win32") {
		const bin = join(dir, name);
		writeFileSync(bin, `#!/bin/sh\nexec bun ${script} "$@"\n`, { mode: 0o755 });
		return bin;
	}
	writeFileSync(join(dir, `${name}.ts`), `import ${JSON.stringify(pathToFileURL(script).href)};\n`);
	return linkLauncher(dir, name);
}

/** `<dir>/<name>.exe`: the launcher, which runs the `.ts` file of its own name. */
function linkLauncher(dir: string, name: string): string {
	const bin = join(dir, `${name}.exe`);
	const launcher = windowsLauncher();
	try {
		linkSync(launcher, bin);
	} catch {
		copyFileSync(launcher, bin);
	}
	return bin;
}

let made: string | undefined;

/** The launcher for this Bun, compiled the first time a test asks for it (a fraction of a second) and kept in the temp folder. */
function windowsLauncher(): string {
	if (made) return made;
	const version = execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();
	const launcher = join(tmpdir(), `ompw-bun-launcher-${version}.exe`);
	if (existsSync(launcher)) {
		made = launcher;
		return launcher;
	}
	const work = mkdtempSync(join(tmpdir(), "ompw-bun-launcher-"));
	try {
		const source = join(work, "launch.ts");
		writeFileSync(
			source,
			[
				'import { pathToFileURL } from "node:url";',
				"// The script is the one beside this program, by its name: known only when it runs.",
				'await import(pathToFileURL(process.execPath.replace(/\\.exe$/i, ".ts")).href);',
				"",
			].join("\n"),
		);
		const built = join(work, "launch.exe");
		execFileSync("bun", ["build", "--compile", source, "--outfile", built], { stdio: "ignore" });
		// Another test process may have made it meanwhile: the one already there serves as well.
		try {
			renameSync(built, launcher);
		} catch {
			if (!existsSync(launcher)) throw new Error(`the Bun launcher could not be put at ${launcher}`);
		}
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
	made = launcher;
	return launcher;
}
