import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Bun macros, run when the importer is bundled (and when it is run from source), so that the compiled server holds what they
 * read: the sources of the server's own omp extensions (`extension-files.ts` writes them out) and the documentation the
 * `webui_docs` tool answers from. The packaged app has no source tree and no `docs/` folder: these are how they get into it.
 *
 * A `with { type: "text" }` import cannot read a file the server also imports as a module (`shared/guard.ts`,
 * `shared/quota-hold.ts`…): Bun keeps one module per file, and the bundle then fails with "No matching export … for import
 * default".
 */

/** The repository's root folder. */
const ROOT = join(import.meta.dir, "..", "..");

/** The text of a file of this tree, named by its path from the repository's root (`server/omp/gate/extension.ts`). */
export function source(path: string): string {
	return readFileSync(join(ROOT, path), "utf8");
}

/** Every file of `docs/agents/`, file name to Markdown. */
export function agentDocs(): Record<string, string> {
	const dir = join(ROOT, "docs", "agents");
	const docs: Record<string, string> = {};
	for (const name of readdirSync(dir).sort()) {
		if (name.endsWith(".md")) docs[name] = readFileSync(join(dir, name), "utf8");
	}
	return docs;
}
