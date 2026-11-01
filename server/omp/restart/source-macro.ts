import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A Bun macro: the text of a file of the restart extension's own folder, read when the importer is bundled (and when it is
 * run from source), so the compiled server holds it. Each extension has a macro of its own that resolves against its own
 * folder (`server/omp/unattended/source-macro.ts` and the others), so that the extension installed under `restart/` is this
 * one and never another's.
 */
export function source(path: string): string {
	return readFileSync(join(import.meta.dir, path), "utf8");
}
