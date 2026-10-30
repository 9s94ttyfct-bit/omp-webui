import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A Bun macro: the text of a file of the unattended extension's own folder, read when the importer is bundled (and when it
 * is run from source), so the compiled server holds it. The gate and the model guidance have macros of their own
 * (`server/omp/gate/source-macro.ts`, `server/omp/guidance/source-macro.ts`), and the three are not interchangeable: each
 * resolves against its own folder, so that the extension installed under `unattended/` is this one and never another's.
 */
export function source(path: string): string {
	return readFileSync(join(import.meta.dir, path), "utf8");
}
