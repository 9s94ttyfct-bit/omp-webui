import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A Bun macro: the text of a file of this tree, read when the importer is bundled (and when it is run from source), so
 * the compiled server holds it. A `with { type: "text" }` import cannot do this for a file the server also imports as a
 * module (`shared/guard.ts`, `shared/risk-confirm.ts`): Bun keeps one module per file, and the bundle then fails with
 * "No matching export … for import default".
 */
export function source(path: string): string {
	return readFileSync(join(import.meta.dir, path), "utf8");
}
