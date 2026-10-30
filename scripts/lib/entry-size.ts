import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CHUNK_MODULES_FILE, type ChunkModules } from "./chunk-modules.ts";

/** One JS file of the first page load, and what it costs on the wire. */
export interface EntryFile {
	/** Its path under `dist/web`, as `index.html` names it without the leading slash (`assets/index-AbC.js`). */
	file: string;
	/** Bytes as `Bun.gzipSync` makes them: the number the budget is kept in. */
	gzip: number;
}

/** What a module is worth in an entry file, as a share of the file's gzip (its code length over the file's total). */
export interface EntryModule {
	id: string;
	gzip: number;
}

/**
 * The JS files `index.html` has the browser fetch before the page runs: its module script and every modulepreload link.
 * Anything the page asks for later (`import()`, a stylesheet) is not the first load's.
 */
export function entryScripts(html: string): string[] {
	const files: string[] = [];
	for (const [tag, name] of html.matchAll(/<(script|link)\b[^>]*>/g)) {
		const attr = (key: string) => new RegExp(`\\s${key}="([^"]*)"`).exec(tag)?.[1];
		const url = name === "script" ? (attr("type") === "module" ? attr("src") : undefined) : attr("href");
		if (url === undefined || (name === "link" && attr("rel") !== "modulepreload")) continue;
		const file = new URL(url, "http://page/").pathname.slice(1);
		if (!files.includes(file)) files.push(file);
	}
	return files;
}

/** The first load's JS files with their gzip sizes. `web` is the build's output (`dist/web`). */
export function measureEntry(web: string): EntryFile[] {
	const html = readFileSync(join(web, "index.html"), "utf8");
	const files = entryScripts(html);
	if (files.length === 0) throw new Error(`${join(web, "index.html")} loads no script: nothing to measure`);
	return files.map((file) => ({ file, gzip: Bun.gzipSync(readFileSync(join(web, file))).length }));
}

export const kib = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KiB`;

/** A module of the node_modules tree is named by its package, so that the list says `lucide-react`, not 40 icons. */
function owner(id: string): string {
	const at = id.lastIndexOf("node_modules/");
	if (at < 0) return id.split("?")[0];
	const [first, second] = id.slice(at + "node_modules/".length).split("/");
	return `${first.startsWith("@") ? `${first}/${second}` : first} (package)`;
}

/**
 * The modules of the entry files, biggest first. The build records each module's code length per file
 * (`scripts/lib/chunk-modules.ts`); a file's gzip is shared out in that proportion, which is an estimate: gzip has no
 * per-module size. Empty when the build left no record.
 */
export function entryModules(files: EntryFile[], modules: ChunkModules): EntryModule[] {
	const bySource = new Map<string, number>();
	for (const { file, gzip } of files) {
		const inFile = modules[file] ?? {};
		const total = Object.values(inFile).reduce((sum, length) => sum + length, 0);
		if (total === 0) continue;
		for (const [id, length] of Object.entries(inFile)) {
			const name = owner(id);
			bySource.set(name, (bySource.get(name) ?? 0) + (gzip * length) / total);
		}
	}
	return [...bySource.entries()].map(([id, gzip]) => ({ id, gzip })).sort((a, b) => b.gzip - a.gzip);
}

/** The build's module record (`dist/chunk-modules.json`), or `{}` when there is none. `dist` is the build's folder. */
export function readChunkModules(dist: string): ChunkModules {
	const file = join(dist, CHUNK_MODULES_FILE);
	return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as ChunkModules) : {};
}

/** How many modules the over-budget report lists. */
export const REPORT_MODULES = 30;

/** The text of a check: one line when the entry fits the budget, and when it does not, what it is made of. */
export function report(files: EntryFile[], modules: EntryModule[], budgetKiB: number): { ok: boolean; text: string } {
	const total = files.reduce((sum, f) => sum + f.gzip, 0);
	const ok = total <= budgetKiB * 1024;
	const head = `first-load JS ${kib(total)} gzip in ${files.length} file${files.length === 1 ? "" : "s"} (budget ${budgetKiB} KiB)`;
	if (ok) return { ok, text: `${head}: ok` };
	const lines = [
		`${head}: OVER by ${kib(total - budgetKiB * 1024)}`,
		"",
		"Files `index.html` loads before the page runs:",
	];
	for (const f of files) lines.push(`  ${kib(f.gzip).padStart(10)}  ${f.file}`);
	if (modules.length === 0) {
		lines.push("", "No module list (run `bun run build`, which writes dist/chunk-modules.json beside dist/web).");
	} else {
		lines.push("", `Modules in them, by share of the files' gzip (an estimate), the ${REPORT_MODULES} biggest:`);
		for (const m of modules.slice(0, REPORT_MODULES)) lines.push(`  ${kib(m.gzip).padStart(10)}  ${m.id}`);
		if (modules.length > REPORT_MODULES) lines.push(`  … and ${modules.length - REPORT_MODULES} more`);
	}
	lines.push(
		"",
		"Load what the first paint does not need behind import() (web/src/lib/lazy-chunk.ts), and do not import it from a",
		"module the first paint runs. The budget is ENTRY_BUDGET_KIB in scripts/check-entry-size.ts.",
	);
	return { ok, text: lines.join("\n") };
}
