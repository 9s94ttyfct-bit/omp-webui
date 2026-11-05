import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { SERVER_WORKERS } from "../../scripts/lib/server-compile.ts";

/**
 * The compiled server (the macOS app's, the Windows and Linux launchers') has each worker the server starts by a relative URL
 * as an entry point of its own (scripts/lib/server-compile.ts, #177): one forgotten breaks only that package, at run time.
 */

const server = join(import.meta.dir, "..", "..", "server");

test("every worker the server starts by a relative URL is an entry point of the compiled program, and nothing else is", () => {
	const started = new Set<string>();
	for (const file of new Bun.Glob("**/*.ts").scanSync({ cwd: server, absolute: true })) {
		const text = readFileSync(file, "utf8");
		for (const m of text.matchAll(/new Worker\(\s*new URL\(\s*["']\.\/([^"']+)["']/g)) {
			// Entry points are named from server/: a worker beside a module in a subfolder is named with that folder.
			started.add(relative(server, join(file, "..", m[1])).replaceAll("\\", "/"));
		}
	}
	expect(started.size).toBeGreaterThan(0);
	expect([...started].sort()).toEqual([...SERVER_WORKERS].sort());
	for (const worker of SERVER_WORKERS) expect(existsSync(join(server, worker)), worker).toBe(true);
});
