import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { platformId } from "../../server/platform/capabilities.ts";

/**
 * A program a test hands the server (an `OMP_BIN`) that is a script run by Bun, written into `dir`; returns the path to run
 * it by. On macOS and Linux it is one executable file, `name`, with a `#!` line. Windows runs no `#!` line, so there the
 * script goes beside it as a file of its own and the program is `<name>.cmd`, which hands its arguments to `bun`.
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
	return writeCmd(dir, name, `%~dp0${name}.ts`);
}

/** A program `name` that runs the script at `script` (an absolute path) with the arguments it is given. */
export function writeBunLauncher(dir: string, name: string, script: string): string {
	if (platformId !== "win32") {
		const bin = join(dir, name);
		writeFileSync(bin, `#!/bin/sh\nexec bun ${script} "$@"\n`, { mode: 0o755 });
		return bin;
	}
	return writeCmd(dir, name, script);
}

function writeCmd(dir: string, name: string, script: string): string {
	const bin = join(dir, `${name}.cmd`);
	writeFileSync(bin, `@bun "${script}" %*\r\n`);
	return bin;
}
