import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A name exported from `shared/` is the contract of something that crosses the server, the page, the app or a test (#295):
 * one that appears nowhere but its own declaration is checked against nothing, and drifts from what the code does without
 * a compiler error. Use it where the thing is built or read, or delete it.
 */

const root = join(import.meta.dir, "..", "..");
const glob = (dir: string, pattern: string) => [
	...new Bun.Glob(pattern).scanSync({ cwd: join(root, dir), absolute: true }),
];
const sources = [
	...glob("shared", "**/*.ts"),
	...glob("server", "**/*.ts"),
	...glob("web/src", "**/*.{ts,tsx}"),
	...glob("scripts", "**/*.ts"),
	...glob("tests", "**/*.{ts,tsx}"),
	...glob("macos", "**/*.{swift,js}"),
];

test("every name shared/ exports is used somewhere besides its declaration", () => {
	// Every word of every source, counted once.
	const words = new Map<string, number>();
	for (const file of sources)
		for (const [word] of readFileSync(file, "utf8").matchAll(/\w+/g)) words.set(word, (words.get(word) ?? 0) + 1);
	const exported = glob("shared", "**/*.ts").flatMap((f) =>
		[
			...readFileSync(f, "utf8").matchAll(
				/^export (?:declare )?(?:async )?(?:interface|type|const|function|class|enum) (\w+)/gm,
			),
		].map((m) => m[1]),
	);
	expect(exported.filter((name) => (words.get(name) ?? 0) < 2)).toEqual([]);
}, 60_000);
