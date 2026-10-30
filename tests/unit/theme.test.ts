import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	applyPalette,
	applyTheme,
	DEFAULT_PALETTE,
	followSystemTheme,
	paintTheme,
	storedPalette,
	storedTheme,
} from "../../web/src/lib/theme.ts";

/**
 * The mode and palette of the page: what is remembered, what lands on <html> and the colour of the browser's chrome, and
 * the script in index.html that does the same before the first paint (no flash). A small fake of the three browser
 * objects they touch; the E2E specs run the real thing.
 */

interface Fake {
	classes: Set<string>;
	dataset: Record<string, string>;
	storage: Map<string, string>;
	meta: { content: string };
	/** What `--bg` computes to on <html> (palettes.css decides; the fake stands in for it). */
	bg: string;
	osDark: boolean;
	listeners: (() => void)[];
}

let fake: Fake;
const globals = globalThis as Record<string, unknown>;
const saved: Record<string, unknown> = {};

beforeEach(() => {
	fake = {
		classes: new Set(),
		dataset: {},
		storage: new Map(),
		meta: { content: "" },
		bg: "#123456",
		osDark: false,
		listeners: [],
	};
	const root = {
		classList: {
			toggle: (name: string, force: boolean) => void (force ? fake.classes.add(name) : fake.classes.delete(name)),
		},
		dataset: fake.dataset,
	};
	const stubs = {
		document: {
			documentElement: root,
			querySelector: (sel: string) =>
				sel === 'meta[name="theme-color"]' ? { setAttribute: (_: string, v: string) => (fake.meta.content = v) } : null,
		},
		localStorage: {
			getItem: (k: string) => fake.storage.get(k) ?? null,
			setItem: (k: string, v: string) => void fake.storage.set(k, v),
		},
		getComputedStyle: () => ({ getPropertyValue: (name: string) => (name === "--bg" ? ` ${fake.bg}` : "") }),
		matchMedia: () => ({
			get matches() {
				return fake.osDark;
			},
			addEventListener: (_: string, fn: () => void) => fake.listeners.push(fn),
			removeEventListener: (_: string, fn: () => void) => {
				fake.listeners = fake.listeners.filter((l) => l !== fn);
			},
		}),
	};
	for (const [k, v] of Object.entries(stubs)) {
		saved[k] = globals[k];
		globals[k] = v;
	}
});
afterEach(() => {
	for (const [k, v] of Object.entries(saved)) globals[k] = v;
});

test("the stored palette is the default until a known palette is stored", () => {
	expect(storedPalette()).toBe(DEFAULT_PALETTE);
	fake.storage.set("ompw.palette", "terminal");
	expect(storedPalette()).toBe("terminal");
	fake.storage.set("ompw.palette", "solarized");
	expect(storedPalette()).toBe(DEFAULT_PALETTE);
});

test("the stored theme is dark until one of the three is stored: a value nobody offers shows the default, with none checked in Settings", () => {
	expect(storedTheme()).toBe("dark");
	for (const theme of ["light", "system", "dark"] as const) {
		fake.storage.set("ompw.theme", theme);
		expect(storedTheme()).toBe(theme);
	}
	fake.storage.set("ompw.theme", "blue");
	expect(storedTheme()).toBe("dark");
});

test("choosing a palette remembers it, marks <html> and takes the page background for the browser chrome", () => {
	applyPalette("hermes");
	expect(fake.storage.get("ompw.palette")).toBe("hermes");
	expect(fake.dataset.palette).toBe("hermes");
	expect(fake.meta.content).toBe("#123456");
	// The mode is untouched by a palette.
	expect(fake.storage.has("ompw.theme")).toBe(false);
	expect(fake.classes.has("dark")).toBe(false);
});

test("choosing a mode remembers it and leaves the palette alone; system follows the OS", () => {
	applyPalette("omp");
	applyTheme("dark");
	expect(fake.classes.has("dark")).toBe(true);
	expect(fake.dataset.palette).toBe("omp");
	applyTheme("light");
	expect(fake.classes.has("dark")).toBe(false);
	fake.osDark = true;
	applyTheme("system");
	expect(fake.classes.has("dark")).toBe(true);
	expect(fake.storage.get("ompw.theme")).toBe("system");
	expect(fake.storage.get("ompw.palette")).toBe("omp");
});

test("an OS change repaints only while the mode is system", () => {
	let mode: "system" | "light" = "system";
	const stop = followSystemTheme(() => mode);
	fake.osDark = true;
	for (const fn of fake.listeners) fn();
	expect(fake.classes.has("dark")).toBe(true);
	mode = "light";
	paintTheme("light");
	fake.osDark = true;
	for (const fn of fake.listeners) fn();
	expect(fake.classes.has("dark")).toBe(false);
	stop();
	expect(fake.listeners).toHaveLength(0);
});

test("a stylesheet that is not loaded yet leaves the browser chrome alone", () => {
	fake.bg = "";
	fake.meta.content = "#abcdef";
	paintTheme("dark");
	expect(fake.meta.content).toBe("#abcdef");
});

/** The inline script of index.html, run against the fake: what it does to <html> before the stylesheet paints anything. */
function prePaint() {
	const html = readFileSync(new URL("../../web/index.html", import.meta.url), "utf8");
	const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
	if (!script) throw new Error("no inline script in index.html");
	new Function(script)();
	return { dark: fake.classes.has("dark"), palette: fake.dataset.palette };
}

test("before the first paint index.html sets the stored mode and palette, dark Claude by default", () => {
	expect(prePaint()).toEqual({ dark: true, palette: "claude" });
	fake.storage.set("ompw.theme", "light");
	fake.storage.set("ompw.palette", "chatgpt");
	expect(prePaint()).toEqual({ dark: false, palette: "chatgpt" });
	fake.storage.set("ompw.theme", "system");
	fake.osDark = true;
	fake.storage.set("ompw.palette", "terminal");
	expect(prePaint()).toEqual({ dark: true, palette: "terminal" });
	fake.osDark = false;
	expect(prePaint()).toEqual({ dark: false, palette: "terminal" });
});
