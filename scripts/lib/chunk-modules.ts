import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

/** What `vite build` leaves for `scripts/check-entry-size.ts`: for each JS file, the modules in it and the size of each. */
export type ChunkModules = Record<string, Record<string, number>>;

/** Its name under `dist/`, beside `dist/web` and not in it, so that it is not shipped with the page. */
export const CHUNK_MODULES_FILE = "chunk-modules.json";

/**
 * Writes the module list of every JS file the build makes (the module's id and the length of its code, before the
 * minifier), so that a build over the first load's budget can say which modules the entry is made of.
 */
export function chunkModules(root: string): Plugin {
	return {
		name: "ompw-chunk-modules",
		apply: "build",
		writeBundle(_options, bundle) {
			const out: ChunkModules = {};
			for (const chunk of Object.values(bundle)) {
				if (chunk.type !== "chunk") continue;
				const modules: Record<string, number> = {};
				for (const [id, mod] of Object.entries(chunk.modules)) {
					modules[id.replace(root, "")] = mod.code?.length ?? 0;
				}
				out[chunk.fileName] = modules;
			}
			const dist = resolve(root, "dist");
			mkdirSync(dist, { recursive: true });
			writeFileSync(resolve(dist, CHUNK_MODULES_FILE), `${JSON.stringify(out)}\n`);
		},
	};
}
