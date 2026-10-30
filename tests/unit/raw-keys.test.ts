import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { WEB } from "../support/entry-graph.ts";
import { NAMESPACES, rawKeysIn } from "../support/raw-keys.ts";

/** The e2e fixtures fail a test whose page shows a translation key; this holds that check to every namespace there is. */
test("every namespace of web/src/i18n is checked for raw keys", () => {
	const camel = (f: string) => f.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
	const files = readdirSync(join(WEB, "i18n"))
		.filter((f) => f.endsWith(".ts") && !["index.ts", "later.ts"].includes(f) && !f.endsWith("-later.ts"))
		.map((f) => camel(f.slice(0, -3)))
		.sort();
	expect(Object.keys(NAMESPACES).sort()).toEqual(files);
});

test("a key that is shown as it is gets found, and ordinary text with dots does not", () => {
	expect(rawKeysIn("Start\npages.newPlaceholder\nfiles.mentionInserted!")).toEqual([
		"pages.newPlaceholder",
		"files.mentionInserted",
	]);
	expect(rawKeysIn("Edit package.json in files.ts or see omp.dev and errors.notAKey")).toEqual([]);
});
