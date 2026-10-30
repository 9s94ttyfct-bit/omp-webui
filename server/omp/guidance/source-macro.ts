import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A Bun macro: the text of a file of the guidance extension's own folder, read when the importer is bundled (and when it is
 * run from source), so the compiled server holds it. A `with { type: "text" }` import cannot do this for a file the server
 * also imports as a module: Bun keeps one module per file, and the bundle then fails with "No matching export … for import
 * default".
 *
 * The gate has a macro of its own (`server/omp/gate/source-macro.ts`), and the two are not interchangeable: each resolves
 * against its own folder, so that the guidance extension installed beside the gate is the guidance one and never the gate's
 * (a copy of the gate's extension in the guidance folder would ask for approvals it has no one to ask).
 */
export function source(path: string): string {
	return readFileSync(join(import.meta.dir, path), "utf8");
}
