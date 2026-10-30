import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { t } from "../../web/src/i18n/index.ts";
import "../../web/src/i18n/later.ts";
import { chain, HOME_CHUNKS, homeLoad, staticImports, WEB } from "../support/entry-graph.ts";

/**
 * The first page load carries the English strings its own modules ask for, and no others (`scripts/check-entry-size.ts`
 * keeps a budget on it). The first page is the modules of the first load and the chunks the home page fetches as its
 * process starts (`HOME_CHUNKS`: the pickers, the request cards, the quota meter): those are on screen within a second,
 * and the later strings' module is 20 KiB, which a home page that fetched it would carry as well. A namespace that has
 * more keeps the rest in `<namespace>-later.ts`; `i18n/later.ts` registers all of those, and a module outside the first
 * page that uses one imports `later.ts`. Three things hold that together, and a new string breaks one of them when it
 * is put in the wrong place:
 *
 *  - the strings of `<namespace>.ts` are exactly the keys a module of the first page asks for;
 *  - a module outside the first page that asks for a string of `<namespace>-later.ts` imports `later.ts`;
 *  - nothing of the first page imports `later.ts`.
 */

const I18N = join(WEB, "i18n");
const SPLIT = readdirSync(I18N)
	.filter((f) => f.endsWith("-later.ts"))
	.map((f) => f.slice(0, -"-later.ts".length))
	.sort();
const NAMESPACES = SPLIT.join("|");
const LITERAL_KEY = new RegExp(`["'\`](${NAMESPACES})\\.([A-Za-z0-9_]+)`, "g");
/** A key built from a variable (`t(\`mode.${side}\`)`): which strings it asks for is not known from the text. */
const TEMPLATE_KEY = new RegExp(`["'\`](${NAMESPACES})\\.\\$\\{`, "g");

/** Every `.ts` / `.tsx` file of `web/src` outside `i18n/`. */
function modules(dir = WEB): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			if (path !== I18N) out.push(...modules(path));
		} else if (/\.tsx?$/.test(name)) out.push(path);
	}
	return out;
}

interface Asked {
	/** `namespace.key` of every string the module names. */
	keys: Set<string>;
	/** The namespaces it builds a key in from a variable. */
	templates: Set<string>;
}

function asked(file: string): Asked {
	const text = readFileSync(file, "utf8");
	return {
		keys: new Set([...text.matchAll(LITERAL_KEY)].map((m) => `${m[1]}.${m[2]}`)),
		templates: new Set([...text.matchAll(TEMPLATE_KEY)].map((m) => m[1])),
	};
}

// The namespaces are the `-later.ts` files found in the folder, so their modules are named at run time.
async function strings(namespace: string): Promise<{ first: string[]; later: string[] }> {
	const first = (await import(join(I18N, `${namespace}.ts`))) as { en: Record<string, string> };
	const later = (await import(join(I18N, `${namespace}-later.ts`))) as { en: Record<string, string> };
	return { first: Object.keys(first.en), later: Object.keys(later.en) };
}

const FIRST_LOAD = [...homeLoad().keys()].filter((f) => f.startsWith(WEB) && !f.startsWith(I18N));

describe("the strings of the first page load", () => {
	test("the walk finds the namespaces that are split, and the modules of the first load", () => {
		expect(SPLIT).toContain("panel");
		expect(SPLIT).toContain("chat");
		expect(FIRST_LOAD).toContain(join(WEB, "App.tsx"));
		expect(FIRST_LOAD).toContain(join(WEB, "components", "Sidebar.tsx"));
		expect(FIRST_LOAD).not.toContain(join(WEB, "components", "ChatView.tsx"));
		// The home page's own chunks are in it (NewChat.tsx fetches them as its process starts), whole.
		for (const chunk of HOME_CHUNKS) expect(FIRST_LOAD).toContain(chunk);
		expect(FIRST_LOAD).toContain(join(WEB, "components", "ModelPicker.tsx"));
	});

	for (const namespace of SPLIT) {
		test(`${namespace}.ts holds the keys a module of the first load asks for, and no others`, async () => {
			const { first, later } = await strings(namespace);
			const wanted = new Set<string>();
			for (const file of FIRST_LOAD) {
				const { keys, templates } = asked(file);
				for (const key of keys) if (key.startsWith(`${namespace}.`)) wanted.add(key.slice(namespace.length + 1));
				// A key built from a variable could be any of the namespace: it has to be whole in the first page, which is no split.
				expect(templates.has(namespace) ? `${relative(WEB, file)} builds a ${namespace}.* key` : null).toBeNull();
			}
			const known = new Set([...first, ...later]);
			expect(first.filter((k) => later.includes(k))).toEqual([]);
			// Named by a module of the first load but in `-later`: the first page would show the key, not the text.
			expect([...wanted].filter((k) => known.has(k) && !first.includes(k))).toEqual([]);
			// In `.ts` but asked for by no module of the first load: it only makes the first load bigger.
			expect(first.filter((k) => !wanted.has(k))).toEqual([]);
		});
	}

	test("a module outside the first load that asks for a string of a -later module imports i18n/later.ts", async () => {
		const later = new Set<string>();
		for (const namespace of SPLIT) for (const key of (await strings(namespace)).later) later.add(`${namespace}.${key}`);
		const registered = join(I18N, "later.ts");
		const loaded = new Set(FIRST_LOAD);
		const missing: string[] = [];
		for (const file of modules()) {
			if (loaded.has(file)) continue;
			const { keys, templates } = asked(file);
			if (templates.size === 0 && ![...keys].some((k) => later.has(k))) continue;
			if (!staticImports(file).includes(registered)) missing.push(relative(WEB, file));
		}
		expect(missing).toEqual([]);
	});

	test("nothing the home page loads imports the later strings", () => {
		const reached = homeLoad();
		const later = [join(I18N, "later.ts"), ...SPLIT.map((ns) => join(I18N, `${ns}-later.ts`))];
		for (const file of later) expect(reached.has(file) ? chain(reached, file) : null).toBeNull();
	});

	test("later.ts registers the -later module of every namespace that has one", () => {
		const imported = staticImports(join(I18N, "later.ts"))
			.map((f) => relative(I18N, f))
			.filter((f) => f.endsWith("-later.ts"))
			.sort();
		expect(imported).toEqual(SPLIT.map((ns) => `${ns}-later.ts`));
	});

	test("once later.ts is imported, every string of a split namespace is known to t()", async () => {
		// later.ts is imported at the top of this file, as a module that asks for a later string does.
		const unknown: string[] = [];
		for (const namespace of SPLIT) {
			const { first, later } = await strings(namespace);
			for (const key of [...first, ...later]) {
				const full = `${namespace}.${key}` as Parameters<typeof t>[0];
				if (t(full) === full) unknown.push(full);
			}
		}
		expect(unknown).toEqual([]);
	});
});
