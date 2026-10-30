import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { hardenExport } from "./export-harden.ts";
import { run } from "./omp/run.ts";

/**
 * `omp --export` renders a session to one self-contained HTML file. The file holds the whole transcript,
 * unredacted and with its images, so it must not outlive the request: each export runs in a directory of
 * its own (a concurrent export can never be mistaken for it), is read into memory and removed at once.
 *
 * What omp writes is not safe to open: it renders the model's Markdown with raw HTML in it and carries no policy, so a
 * reply could run script (and send the transcript away) when the file is opened. `hardenExport` makes it inert.
 */

/** An export directory this old was left by a crash; nothing is still writing to it. */
const STALE_MS = 60 * 60_000;

/**
 * How long `omp --export` gets: it renders the whole transcript with its images, which takes a while for a very long
 * conversation, but it does end. One that does not is killed, and the export fails (#319).
 */
const EXPORT_MS = 120_000;

/** Run the export of `sessionFile`; the HTML and the file name omp gave it. */
export async function exportSession(
	ompBin: string,
	dataDir: string,
	sessionFile: string,
	timeoutMs = EXPORT_MS,
): Promise<{ name: string; html: Uint8Array<ArrayBuffer> }> {
	const exports = join(dataDir, "exports");
	mkdirSync(exports, { recursive: true, mode: 0o700 });
	sweep(exports);
	const dir = mkdtempSync(join(exports, "export-"));
	try {
		const { stdout, stderr, code } = await run([ompBin, "--export", sessionFile], { cwd: dir, timeoutMs });
		if (code !== 0) throw new Error(`Export failed: ${stderr}`);
		const name = readdirSync(dir).find((f) => f.endsWith(".html"));
		if (!name) throw new Error(`Export produced no HTML: ${stdout}`);
		const html = await hardenExport(await Bun.file(join(dir, name)).text());
		return { name, html: new TextEncoder().encode(html) };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Remove what earlier exports left behind: the loose `.html` files of versions that exported into this
 * folder directly, and directories of exports that crashed.
 */
function sweep(exports: string): void {
	for (const name of readdirSync(exports)) {
		const path = join(exports, name);
		try {
			const info = statSync(path);
			const stale = info.isDirectory() ? Date.now() - info.mtimeMs > STALE_MS : name.endsWith(".html");
			if (stale) rmSync(path, { recursive: true, force: true });
		} catch {
			// removed meanwhile by a concurrent export
		}
	}
}
