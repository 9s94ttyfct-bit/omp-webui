/**
 * Fails when the JavaScript of the first page load is over budget. Run after `vite build` (`bun run build` does).
 *
 * The first load is what `dist/web/index.html` has the browser fetch before the page runs: its module script and its
 * modulepreload links. Its size is the sum of those files' gzip (`Bun.gzipSync`), the number the benchmark's
 * `load.cold.jsTransfer_kb` follows. Over budget, it lists the modules those files are made of, biggest first.
 *
 *   bun scripts/check-entry-size.ts [--dist <dir>] [--budget <KiB>]
 */
import { join } from "node:path";
import { entryModules, measureEntry, readChunkModules, report } from "./lib/entry-size.ts";

/**
 * The most gzip KiB of JS the first page load may carry. v0.11.7 carried 221.3; the benchmark allows its
 * `load.cold.jsTransfer_kb` 5% over v0.11.7's 223.0 (234), and that number also counts the fetch overhead this sum
 * does not. 228 is 3% over v0.11.7. Raise it only with a reason a release note could give: the usual fix is to put
 * what the first paint does not need behind `import()`.
 */
export const ENTRY_BUDGET_KIB = 228;

function option(name: string): string | undefined {
	const at = process.argv.indexOf(`--${name}`);
	return at < 0 ? undefined : process.argv[at + 1];
}

if (import.meta.main) {
	const dist = option("dist") ?? join(import.meta.dir, "..", "dist");
	const budget = Number(option("budget") ?? ENTRY_BUDGET_KIB);
	if (!Number.isFinite(budget) || budget <= 0)
		throw new Error(`--budget wants a number of KiB, not "${option("budget")}"`);
	const files = measureEntry(join(dist, "web"));
	const { ok, text } = report(files, entryModules(files, readChunkModules(dist)), budget);
	console.log(text);
	if (!ok) process.exit(1);
}
