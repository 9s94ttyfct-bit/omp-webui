import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Bun macros, run when the importer is bundled (and when it is run from source), so that the compiled server holds what they
 * read: `source` is the text of a file of the docs tool's own folder (as the other extensions' macros are, each against its
 * own folder), and `agentDocs` is every file of `docs/agents/` — the documentation the `webui_docs` tool answers from — as
 * a record of file name to Markdown. The packaged app has no `docs/` folder: these are how the docs get into it.
 */
export function source(path: string): string {
	return readFileSync(join(import.meta.dir, path), "utf8");
}

export function agentDocs(): Record<string, string> {
	const dir = join(import.meta.dir, "..", "..", "..", "docs", "agents");
	const docs: Record<string, string> = {};
	for (const name of readdirSync(dir).sort()) {
		if (name.endsWith(".md")) docs[name] = readFileSync(join(dir, name), "utf8");
	}
	return docs;
}
