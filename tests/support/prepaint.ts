import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PREFS_ELEMENT_ID, type PrefsSnapshot } from "../../shared/prefs.ts";

export interface FakePage {
	/** The origin's localStorage; the one passed in when a Map was. */
	storage: Map<string, string>;
	/** The classes on <html>: `dark`, as the page starts out. */
	classes: Set<string>;
	dataset: Record<string, string>;
}

/**
 * Run web/index.html's own inline script (the one that paints before anything else loads) against a page whose server
 * snapshot is `snapshot` (a string: the element's raw text; null: the page was served without one) and an origin
 * holding `stored`. Nothing but that script runs.
 */
export function runPrepaint(
	snapshot: PrefsSnapshot | string | null,
	stored: Record<string, string> | Map<string, string>,
	osDark = false,
): FakePage {
	const html = readFileSync(join(import.meta.dir, "../../web/index.html"), "utf8");
	const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
	if (!script) throw new Error("index.html has no inline script");
	const page: FakePage = {
		storage: stored instanceof Map ? stored : new Map(Object.entries(stored)),
		classes: new Set(["dark"]),
		dataset: { palette: "claude" },
	};
	const document = {
		documentElement: {
			classList: { toggle: (c: string, on: boolean) => void (on ? page.classes.add(c) : page.classes.delete(c)) },
			dataset: page.dataset,
		},
		getElementById: (id: string) =>
			id === PREFS_ELEMENT_ID && snapshot
				? { textContent: typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot) }
				: null,
	};
	const localStorage = {
		getItem: (k: string) => page.storage.get(k) ?? null,
		setItem: (k: string, v: string) => void page.storage.set(k, v),
		removeItem: (k: string) => void page.storage.delete(k),
	};
	const matchMedia = () => ({ matches: osDark });
	new Function("document", "localStorage", "matchMedia", script)(document, localStorage, matchMedia);
	return page;
}
