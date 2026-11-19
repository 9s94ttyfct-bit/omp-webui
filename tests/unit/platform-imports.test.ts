import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Every module of `server/platform/` can be the first one a worker, a script or a test imports (#298): a cycle through
 * `index.ts` made a module that was loaded before it fail with a temporal-dead-zone error. Each is imported alone, in a
 * process of its own.
 */

const DIR = join(import.meta.dir, "../../server/platform");

for (const file of readdirSync(DIR).filter((f) => f.endsWith(".ts"))) {
	test(`${file} loads when it is the first import`, async () => {
		const proc = Bun.spawn([process.execPath, "-e", `await import(${JSON.stringify(join(DIR, file))})`], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
		expect(stderr).toBe("");
		expect(code).toBe(0);
	});
}
