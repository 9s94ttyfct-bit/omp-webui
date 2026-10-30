/**
 * The unit and contract test files one CI runner runs, split by how long each took (`.bun-test-timings.json`, which
 * `bun run test:timings` refreshes), one per line, for `bun test <files>`.
 *
 *   bun scripts/test-shard.ts --shard <index>/<total> [dir…]   (dirs: tests/unit tests/contract)
 *
 * The files are what is in the folders now, so a file added since the timings were taken runs too (it weighs as a
 * usual one).
 */
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isRecord } from "../shared/guards.ts";
import { assignShards, parseShard, weigh } from "./lib/shards.ts";

const root = join(import.meta.dir, "..");

/** The milliseconds each file took, by its path from the checkout (`tests/unit/x.test.ts`), as Bun writes them. */
export function readBunTimings(text: string): Record<string, number> {
	const parsed: unknown = JSON.parse(text);
	if (!isRecord(parsed) || !isRecord(parsed.files)) throw new Error(".bun-test-timings.json has no files");
	const out: Record<string, number> = {};
	for (const [file, ms] of Object.entries(parsed.files)) if (typeof ms === "number") out[file] = ms;
	return out;
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const at = args.indexOf("--shard");
	const { index, total } = parseShard(at < 0 ? undefined : args[at + 1]);
	const dirs = args.filter((_, i) => i !== at && i !== at + 1);
	const files: string[] = [];
	for (const dir of dirs.length ? dirs : ["tests/unit", "tests/contract"])
		for (const file of new Bun.Glob("**/*.test.ts").scanSync({ cwd: join(root, dir), absolute: true }))
			files.push(relative(root, file).split("\\").join("/"));
	files.sort();
	const timings = readBunTimings(readFileSync(join(root, ".bun-test-timings.json"), "utf8"));
	console.log(assignShards(weigh(files, timings), total)[index - 1].join("\n"));
}
