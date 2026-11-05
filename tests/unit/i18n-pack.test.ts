import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as pack from "../../web/src/i18n/zh-CN/index.ts";

/**
 * The zh-CN pack (`i18n/zh-CN/index.ts`, loaded when Chinese is chosen) carries the namespaces of the first page and of
 * `registerStrings`, not those whose Chinese strings are a chunk of their own (`lazyStrings`, `import("…/zh-CN/x.ts")`):
 * a page in Chinese would download those with the pack, and their own chunk would be waited for for nothing.
 */

const WEB = join(import.meta.dir, "..", "..", "web", "src");

function sources(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) sources(path, out);
		else if (/\.tsx?$/.test(name)) out.push(readFileSync(path, "utf8"));
	}
	return out;
}

test("the pack carries no namespace whose Chinese strings load on their own", () => {
	const own = new Set<string>();
	for (const text of sources(WEB)) {
		for (const m of text.matchAll(/import\("\.\.\/i18n\/zh-CN\/([a-z-]+)\.ts"\)/g)) {
			own.add((m[1] as string).replace(/-([a-z])/g, (_all, c: string) => c.toUpperCase()));
		}
	}
	expect(own.size).toBeGreaterThan(0);
	expect(Object.keys(pack).filter((ns) => own.has(ns))).toEqual([]);
});
