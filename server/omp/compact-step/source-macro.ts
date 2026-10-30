import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A Bun macro: the text of a file of this tree, read when the importer is bundled (and when it is run from source), so the
 * compiled server holds it. The gate, the model guidance, unattended mode and the quota floor have macros of their own
 * (`server/omp/quota-floor/source-macro.ts`, …), and they are not interchangeable: each resolves against its own folder. The
 * shared file the extension imports (`shared/compact-step.ts`) is also a module of the server, which a `with { type: "text" }`
 * import cannot read as text (Bun keeps one module per file).
 */
export function source(path: string): string {
	return readFileSync(join(import.meta.dir, path), "utf8");
}
