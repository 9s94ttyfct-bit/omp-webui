import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { isPushPayload, openHash, type PushPayload } from "../../shared/push.ts";

/**
 * The service worker is a plain file in `web/public` (it is not built, and the page's code does not import it), so the page's
 * rules are held to it here: what it may do (almost nothing), what it shows, and where a click goes.
 */

const PUBLIC = join(import.meta.dirname, "../../web/public");
const source = readFileSync(join(PUBLIC, "sw.js"), "utf8");
/** The worker's code, its comments taken out (they say what it does not do). */
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

interface Shown {
	title: string;
	options: { body: string; tag: string; renotify: boolean; icon: string; data: { hash: string } };
}
interface Worker {
	listeners: Record<string, (event: unknown) => void>;
	shown: Shown[];
	opened: string[];
	posted: { to: string; message: unknown }[];
	focused: string[];
	closed: number;
	skipped: number;
	claimed: number;
}

/** The worker's code run against a stand-in of the service worker's global scope. */
function load(options: { windows?: string[]; language?: string; origin?: string } = {}) {
	const w: Worker = {
		listeners: {},
		shown: [],
		opened: [],
		posted: [],
		focused: [],
		closed: 0,
		skipped: 0,
		claimed: 0,
	};
	const origin = options.origin ?? "https://omp.example.com";
	const windows = (options.windows ?? []).map((url) => ({
		url,
		focus: async () => {
			w.focused.push(url);
		},
		postMessage: (message: unknown) => w.posted.push({ to: url, message }),
	}));
	const self = {
		addEventListener: (type: string, fn: (event: unknown) => void) => {
			w.listeners[type] = fn;
		},
		skipWaiting: () => {
			w.skipped++;
		},
		navigator: { language: options.language ?? "en-US" },
		location: { origin },
		clients: {
			claim: async () => {
				w.claimed++;
			},
			matchAll: async () => windows,
			openWindow: async (url: string) => {
				w.opened.push(url);
			},
		},
		registration: {
			showNotification: async (title: string, shown: Shown["options"]) => {
				w.shown.push({ title, options: shown });
			},
		},
	};
	vm.runInNewContext(source, { self, URL, encodeURIComponent });
	return w;
}

/** What a push event carries: nothing, text the browser could not read as JSON, or JSON. */
const none = null;
const broken = {
	json: () => {
		throw new SyntaxError("not json");
	},
};
const json = (value: unknown) => ({ json: () => value });

/** A `push` event with `data`, and the work the worker asked to wait for. */
async function push(w: Worker, data: { json: () => unknown } | null): Promise<void> {
	const waits: Promise<unknown>[] = [];
	w.listeners.push({ data, waitUntil: (p: Promise<unknown>) => waits.push(p) });
	await Promise.all(waits);
}

async function click(w: Worker, hash: unknown): Promise<void> {
	const waits: Promise<unknown>[] = [];
	w.listeners.notificationclick({
		notification: { close: () => w.closed++, data: hash === undefined ? undefined : { hash } },
		waitUntil: (p: Promise<unknown>) => waits.push(p),
	});
	await Promise.all(waits);
}

const payload = (over: Partial<PushPayload> = {}): PushPayload => ({
	v: 1,
	kind: "finished",
	liveId: "live-1",
	file: "/Users/someone/.omp/agent/sessions/-proj/2026_abc.jsonl",
	title: "Fixing the build",
	body: "Finished",
	...over,
});

describe("what the worker may do", () => {
	test("it has no fetch handler and no cache: what the server answers a signed-in page is never kept by it", () => {
		expect(code).not.toMatch(/addEventListener\(\s*["']fetch["']/);
		expect(code).not.toMatch(/\bcaches\b/);
		expect(code).not.toMatch(/\bfetch\s*\(/);
		expect(code).not.toMatch(/\bXMLHttpRequest\b|\bindexedDB\b|\blocalStorage\b|\bimportScripts\b/);
		expect(Object.keys(load().listeners).sort()).toEqual(["activate", "install", "notificationclick", "push"]);
	});

	test("a new worker takes over at once, so that a fix of it reaches the pages that are open", async () => {
		const w = load();
		w.listeners.install({});
		expect(w.skipped).toBe(1);
		const waits: Promise<unknown>[] = [];
		w.listeners.activate({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
		await Promise.all(waits);
		expect(w.claimed).toBe(1);
	});
});

describe("what it shows", () => {
	test("a notification of ours: its title and words, one per conversation, with the icon", async () => {
		const w = load();
		await push(w, json(payload()));
		expect(w.shown).toHaveLength(1);
		expect(w.shown[0].title).toBe("Fixing the build");
		expect(w.shown[0].options).toMatchObject({
			body: "Finished",
			tag: "omp-live-1",
			renotify: true,
			icon: "/icon-192.png",
		});
	});

	test("what a click opens is the page's own address of the conversation, and the worker and shared/push.ts agree on it", async () => {
		for (const p of [
			payload(),
			payload({ file: null }),
			payload({ file: null, liveId: null, kind: "test" }),
			payload({ file: "/a b/ü/c#d?e.jsonl" }),
		]) {
			const w = load();
			await push(w, json(p));
			expect(w.shown[0].options.data.hash).toBe(openHash(p));
		}
		expect(openHash(payload())).toBe(`#/s/${encodeURIComponent(payload().file as string)}`);
		expect(openHash(payload({ file: null }))).toBe("#/live/live-1");
		expect(openHash(payload({ file: null, liveId: null }))).toBe("#/");
	});

	test("a message that is no notification of ours still shows one (a browser revokes a push that shows nothing), one that names nothing", async () => {
		for (const bad of [
			none,
			broken,
			json({ v: 2 }),
			json({ v: 1, kind: "x", title: "t", body: "b", liveId: null, file: null }),
			json([]),
		]) {
			const w = load();
			await push(w, bad);
			expect(w.shown).toHaveLength(1);
			expect(w.shown[0].title).toBe("omp");
			expect(w.shown[0].options.tag).toBe("omp");
			expect(w.shown[0].options.data.hash).toBe("#/");
		}
		const zh = load({ language: "zh-CN" });
		await push(zh, none);
		expect(zh.shown[0].options.body).toBe("有对话需要你");
	});

	test("the worker's idea of a payload is the page's", () => {
		const good = payload();
		expect(isPushPayload(good)).toBe(true);
		for (const bad of [
			{ ...good, v: 2 },
			{ ...good, kind: "x" },
			{ ...good, title: 1 },
			{ ...good, liveId: undefined },
			null,
			"x",
		]) {
			expect(isPushPayload(bad)).toBe(false);
		}
	});
});

describe("a click", () => {
	test("brings a window of the app forward and tells it where to go; with none open it opens one on the conversation", async () => {
		const hash = openHash(payload());
		const open = load({ windows: ["https://other.example/", "https://omp.example.com/#/settings"] });
		await click(open, hash);
		expect(open.closed).toBe(1);
		expect(open.focused).toEqual(["https://omp.example.com/#/settings"]);
		expect(open.posted).toEqual([{ to: "https://omp.example.com/#/settings", message: { type: "ompw-open", hash } }]);
		expect(open.opened).toEqual([]);
		const none = load({ windows: ["https://other.example/"] });
		await click(none, hash);
		expect(none.opened).toEqual([`/${hash}`]);
		expect(none.posted).toEqual([]);
	});

	test("a notification with no address (or a strange one) opens the app, not nowhere", async () => {
		const w = load();
		await click(w, undefined);
		await click(w, 5);
		expect(w.opened).toEqual(["/#/", "/#/"]);
	});
});

describe("the manifest and the icons", () => {
	const manifest = JSON.parse(readFileSync(join(PUBLIC, "manifest.webmanifest"), "utf8"));

	test("it makes an installable app of the whole origin", () => {
		expect(manifest).toMatchObject({ start_url: "/", scope: "/", display: "standalone", name: "omp" });
		expect(manifest.short_name.length).toBeGreaterThan(0);
		expect(manifest.id).toBe("/");
	});

	test("every icon it names is there, as large as it says, and a maskable one is among them", () => {
		const purposes = new Set<string>();
		const sizes = new Set<string>();
		for (const icon of manifest.icons) {
			const file = join(PUBLIC, icon.src.slice(1));
			expect(statSync(file).size).toBeGreaterThan(1000);
			const png = readFileSync(file);
			expect(png.subarray(1, 4).toString()).toBe("PNG");
			const [w, h] = icon.sizes.split("x").map(Number);
			expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([w, h]);
			purposes.add(icon.purpose);
			sizes.add(icon.sizes);
		}
		expect([...purposes].sort()).toEqual(["any", "maskable"]);
		expect(sizes.has("192x192") && sizes.has("512x512")).toBe(true);
	});

	test("iOS's own icon is 180 px, and the page links the manifest with its credentials (Cloudflare Access wants its cookie)", () => {
		const png = readFileSync(join(PUBLIC, "apple-touch-icon.png"));
		expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([180, 180]);
		const html = readFileSync(join(import.meta.dirname, "../../web/index.html"), "utf8");
		expect(html).toContain('rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials"');
		expect(html).toContain('rel="apple-touch-icon" href="/apple-touch-icon.png"');
	});
});
