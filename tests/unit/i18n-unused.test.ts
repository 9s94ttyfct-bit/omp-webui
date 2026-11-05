import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Every string an `en` module of `web/src/i18n` defines is asked for by the app: a key no module names is carried by
 * every page that loads its namespace, and has to be translated and kept in step for nothing. Keys are named as literals
 * (`"files.title"`), except under the three prefixes a key is built from a variable: `errors.${code}`
 * (`lib/error-text.ts`), `guard.case_${id}` (`GuardBench`) and `mode.${side}` (`ModeSettings`).
 */

const ROOT = join(import.meta.dir, "..", "..");
const I18N = join(ROOT, "web", "src", "i18n");
const BUILT = ["errors.", "guard.case_", "mode."];

/** The namespace of a strings module: `chat-projects.ts` is `chatProjects`, `chat-later.ts` is `chat`. */
const namespaceOf = (file: string) =>
	file
		.replace(/\.ts$/, "")
		.replace(/-later$/, "")
		.replace(/-([a-z])/g, (_all, c: string) => c.toUpperCase());

/** The text of every `.ts` / `.tsx` file of the app (`web/src` outside `i18n/`, `shared`, `server`). */
function sources(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (path === I18N) continue;
		if (statSync(path).isDirectory()) sources(path, out);
		else if (/\.tsx?$/.test(name)) out.push(readFileSync(path, "utf8"));
	}
	return out;
}

test("every English string is asked for by some module of the app", async () => {
	const named = new Set<string>();
	for (const dir of [join(ROOT, "web", "src"), join(ROOT, "shared"), join(ROOT, "server")]) {
		for (const text of sources(dir)) {
			for (const m of text.matchAll(/["'`]([A-Za-z]+\.[A-Za-z0-9_]+)["'`]/g)) named.add(m[1] as string);
		}
	}
	const unused: string[] = [];
	for (const file of readdirSync(I18N).filter((f) => f.endsWith(".ts"))) {
		// The modules are the files found in the folder, so they are named at run time.
		const { en } = (await import(join(I18N, file))) as { en?: Record<string, string> };
		if (!en) continue;
		for (const key of Object.keys(en)) {
			const full = `${namespaceOf(file)}.${key}`;
			if (!named.has(full) && !BUILT.some((prefix) => full.startsWith(prefix))) unused.push(`${full} (${file})`);
		}
	}
	expect(unused).toEqual([]);
});
