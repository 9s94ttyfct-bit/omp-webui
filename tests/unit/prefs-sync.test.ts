import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UiPrefs } from "../../server/prefs.ts";
import { PREF, PREFS_ELEMENT_ID, PREFS_SYNC_KEY, syncMarker } from "../../shared/prefs.ts";
import type * as PrefsModule from "../../web/src/lib/prefs.ts";
import { type FakePage, runPrepaint } from "../support/prepaint.ts";

/**
 * A page and the server keeping each other's preferences, with no network: each "origin" is a localStorage and its own
 * copy of web/src/lib/prefs.ts, and the server is the real store behind a stand-in for `fetch`. A server restart on
 * another port is a new `UiPrefs` on the same directory and an origin with a storage of its own.
 */

type Prefs = typeof PrefsModule;

interface Origin {
	storage: Map<string, string>;
	prefs: Prefs;
	/** What the page's own script left in localStorage and on <html> before anything else ran. */
	painted: FakePage & { before: Map<string, string> };
	/** The page is hidden: whatever is waiting is sent now, and this resolves when it has been answered. */
	hide(): Promise<void>;
	/** Make this origin the page the globals belong to (`localStorage`, `fetch`...): the last one opened is, until then. */
	use(): void;
	/** An event the page's own listeners (registered with the global `addEventListener`) hear, as the browser fires it. */
	fire(type: string, event: object): void;
}

const globals = globalThis as Record<string, unknown>;
const saved: Record<string, unknown> = {};
const STUBBED = ["localStorage", "document", "fetch", "addEventListener"];

let dir: string;
/** Requests to `/api/prefs` fail: `offline` throws like a lost connection, a status answers it. */
let outage: "offline" | number | null;
let requests: { method: string; changes?: unknown }[];
let loads = 0;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompw-prefs-sync-"));
	outage = null;
	requests = [];
	for (const k of STUBBED) saved[k] = globals[k];
});
afterEach(() => {
	for (const k of STUBBED) {
		if (saved[k] === undefined) delete globals[k];
		else globals[k] = saved[k];
	}
	rmSync(dir, { recursive: true, force: true });
});

const posts = () => requests.filter((r) => r.method === "POST");

/**
 * Load the page as `server` serves it at an origin holding `stored`, and start the page's sync. `served: false` is a
 * page that came without the preferences in it (the dev server's).
 */
async function open(server: UiPrefs, stored: Record<string, string> = {}, served = true): Promise<Origin> {
	const storage = new Map(Object.entries(stored));
	const html = served ? server.inject("<html><head><script>x</script></head></html>") : "";
	const block = new RegExp(`id="${PREFS_ELEMENT_ID}">([\\s\\S]*?)</script>`).exec(html)?.[1] ?? null;
	const painted = { ...runPrepaint(block, storage), before: new Map(storage) };

	const listeners: Record<string, ((e: never) => void)[]> = {};
	const on = (type: string, fn: (e: never) => void) => {
		listeners[type] = [...(listeners[type] ?? []), fn];
	};
	const document = {
		visibilityState: "visible",
		getElementById: (id: string) => (id === PREFS_ELEMENT_ID && block ? { textContent: block } : null),
		addEventListener: on,
	};
	const stubs = {
		document,
		addEventListener: on,
		localStorage: {
			getItem: (k: string) => storage.get(k) ?? null,
			setItem: (k: string, v: string) => void storage.set(k, v),
			removeItem: (k: string) => void storage.delete(k),
		},
		fetch: async (url: string, init?: { method?: string; body?: string }) => {
			if (url !== "/api/prefs") throw new Error(`unexpected request ${url}`);
			const method = init?.method ?? "GET";
			const changes = init?.body ? JSON.parse(init.body).changes : undefined;
			requests.push({ method, changes });
			if (outage === "offline") throw new TypeError("fetch failed");
			if (typeof outage === "number") return Response.json({ error: "no" }, { status: outage });
			return Response.json(method === "POST" ? server.apply(changes) : server.snapshot());
		},
	};
	Object.assign(globals, stubs);
	// Not one module: every origin is a page of its own, with its own copy of the module's state (what is waiting, whether
	// it has started), and only a specifier that differs gives another copy.
	const prefs: Prefs = await import(`../../web/src/lib/prefs.ts?origin=${++loads}`);
	await prefs.startPrefsSync();
	return {
		storage,
		prefs,
		painted,
		use: () => void Object.assign(globals, stubs),
		async hide() {
			Object.assign(globals, stubs);
			document.visibilityState = "hidden";
			for (const fn of listeners.visibilitychange ?? []) fn(undefined as never);
			await prefs.flushPrefs();
		},
		fire(type, event) {
			Object.assign(globals, stubs);
			for (const fn of listeners[type] ?? []) fn(event as never);
		},
	};
}

describe("a change of port", () => {
	test("keeps the theme, palette, language and panel widths, applied before the app reads anything", async () => {
		const a = await open(new UiPrefs(dir));
		a.prefs.setPref(PREF.theme, "light");
		a.prefs.setPref(PREF.palette, "terminal");
		a.prefs.setPref(PREF.lang, "zh-CN");
		a.prefs.setPref(PREF.sidebarWidth, "412");
		a.prefs.setPref(PREF.panelWidth, "530");
		await a.hide();
		requests.length = 0;

		// The server starts again, on another port: a new origin that has never seen any of it.
		const restarted = new UiPrefs(dir);
		const b = await open(restarted);
		expect(b.painted.before.get(PREF.theme)).toBe("light");
		expect(b.painted.before.get(PREF.palette)).toBe("terminal");
		expect(b.painted.before.get(PREF.lang)).toBe("zh-CN");
		expect(b.painted.before.get(PREF.sidebarWidth)).toBe("412");
		expect(b.painted.before.get(PREF.panelWidth)).toBe("530");
		expect(b.painted.dataset.palette).toBe("terminal");
		expect(b.painted.classes.has("dark")).toBe(false);
		// Nothing had to be sent back, and the origin knows it is level with the server.
		expect(requests).toEqual([]);
		expect(b.storage.get(PREFS_SYNC_KEY)).toBe(syncMarker(restarted.snapshot()));
	});

	test("a width that was reset is forgotten on the other port too", async () => {
		const server = new UiPrefs(dir);
		const a = await open(server);
		a.prefs.setPref(PREF.sidebarWidth, "400");
		await a.hide();
		const b = await open(server);
		expect(b.storage.get(PREF.sidebarWidth)).toBe("400");

		a.prefs.setPref(PREF.sidebarWidth, null);
		await a.hide();
		expect(server.snapshot().values[PREF.sidebarWidth]).toBeNull();
		const bAgain = await open(server, Object.fromEntries(b.storage));
		expect(bAgain.storage.has(PREF.sidebarWidth)).toBe(false);
	});

	test("an origin that is behind takes the other's change", async () => {
		const server = new UiPrefs(dir);
		const a = await open(server);
		a.prefs.setPref(PREF.theme, "dark");
		await a.hide();
		const b = await open(server);
		b.prefs.setPref(PREF.theme, "light");
		b.prefs.setPref(PREF.cwd, "/work");
		await b.hide();

		const aReopened = await open(server, Object.fromEntries(a.storage));
		expect(aReopened.painted.before.get(PREF.theme)).toBe("light");
		expect(aReopened.painted.before.get(PREF.cwd)).toBe("/work");
		expect(aReopened.storage.get(PREFS_SYNC_KEY)).toBe(syncMarker(server.snapshot()));
	});
});

describe("an origin that predates the server's copy", () => {
	test("its preferences go to the server once, and are there for the next port", async () => {
		const server = new UiPrefs(dir);
		const legacy = await open(server, { [PREF.theme]: "light", [PREF.cwd]: "/work", [PREF.autoTitle]: "off" });
		const values = server.snapshot().values;
		expect([values[PREF.theme], values[PREF.cwd], values[PREF.autoTitle]]).toEqual(["light", "/work", "off"]);
		expect(legacy.storage.get(PREFS_SYNC_KEY)).toBe(syncMarker(server.snapshot()));

		const next = await open(server);
		expect(next.painted.before.get(PREF.cwd)).toBe("/work");
		// Only the first of them had anything to send.
		expect(posts()).toHaveLength(1);
	});

	test("a second such origin keeps what it has and takes the server's only for what it lacks", async () => {
		const server = new UiPrefs(dir);
		await open(server, { [PREF.theme]: "light", [PREF.palette]: "omp" });
		const second = await open(server, { [PREF.theme]: "dark", [PREF.cwd]: "/other" });
		expect(second.storage.get(PREF.theme)).toBe("dark");
		expect(second.storage.get(PREF.palette)).toBe("omp");
		expect(second.storage.get(PREF.cwd)).toBe("/other");
		const values = server.snapshot().values;
		expect([values[PREF.theme], values[PREF.palette], values[PREF.cwd]]).toEqual(["dark", "omp", "/other"]);
	});

	test("a page served without the preferences asks the server for them", async () => {
		const server = new UiPrefs(dir);
		server.apply({ [PREF.palette]: "omp" });
		const dev = await open(server, { [PREF.theme]: "light" }, false);
		expect(requests.map((r) => r.method)).toEqual(["GET", "POST"]);
		expect(server.snapshot().values[PREF.theme]).toBe("light");
		expect(dev.storage.get(PREF.palette)).toBe("omp");
		expect(dev.storage.get(PREFS_SYNC_KEY)).toBe(syncMarker(server.snapshot()));
	});
});

describe("sending changes", () => {
	test("a burst is one request carrying the last choice of each key", async () => {
		const a = await open(new UiPrefs(dir));
		requests.length = 0;
		for (const w of ["300", "310", "320"]) a.prefs.setPref(PREF.sidebarWidth, w);
		a.prefs.setPref(PREF.theme, "light");
		await a.hide();
		expect(requests).toEqual([{ method: "POST", changes: { [PREF.sidebarWidth]: "320", [PREF.theme]: "light" } }]);
	});

	test("while the server cannot be reached nothing is lost: it goes with the next chance, and only then is the origin level", async () => {
		const server = new UiPrefs(dir);
		const a = await open(server);
		const level = syncMarker(server.snapshot());
		outage = "offline";
		a.prefs.setPref(PREF.theme, "light");
		await a.hide();
		expect(server.snapshot().values[PREF.theme]).toBeNull();
		expect(a.storage.get(PREFS_SYNC_KEY)).toBe(level);

		outage = null;
		a.prefs.setPref(PREF.palette, "hermes");
		await a.hide();
		expect(server.snapshot().values[PREF.theme]).toBe("light");
		expect(server.snapshot().values[PREF.palette]).toBe("hermes");
		expect(a.storage.get(PREFS_SYNC_KEY)).toBe(syncMarker(server.snapshot()));
	});

	test("a change that never arrived is sent by the next page of the origin", async () => {
		const server = new UiPrefs(dir);
		const a = await open(server);
		outage = "offline";
		a.prefs.setPref(PREF.sidebarWidth, "444");
		await a.hide();
		outage = null;

		const reopened = await open(server, Object.fromEntries(a.storage));
		expect(server.snapshot().values[PREF.sidebarWidth]).toBe("444");
		expect(reopened.storage.get(PREF.sidebarWidth)).toBe("444");
	});

	test("a request the server refuses is not sent again and again", async () => {
		const a = await open(new UiPrefs(dir));
		outage = 400;
		a.prefs.setPref(PREF.theme, "light");
		await a.hide();
		const sent = requests.length;
		await a.hide();
		expect(requests.length).toBe(sent);
	});

	test("the star prompt's own record is kept like any other preference; keys outside the list stay in the origin", async () => {
		const server = new UiPrefs(dir);
		const a = await open(server);
		const answer = JSON.stringify({ answer: "never", at: 1 });
		a.prefs.prefStorage.setItem(PREF.star, answer);
		a.prefs.prefStorage.setItem("unrelated", "x");
		await a.hide();
		expect(server.snapshot().values[PREF.star]).toBe(answer);
		expect(a.storage.get("unrelated")).toBe("x");
		expect(posts().at(-1)?.changes).toEqual({ [PREF.star]: answer });
	});
});

describe("a change made on another page", () => {
	/** What a page repaints: the keys `onPrefsChanged` was told about, in order. */
	const watch = (o: Origin) => {
		const told: string[][] = [];
		o.prefs.onPrefsChanged((keys) => told.push(keys));
		return told;
	};

	test("is taken from the server's word, key by key, and announced", async () => {
		const server = new UiPrefs(dir);
		const a = await open(server);
		const b = await open(server);
		const told = watch(b);
		a.use();
		a.prefs.setPref(PREF.palette, "terminal");
		a.prefs.setPref(PREF.sidebarWidth, "333");
		await a.hide();

		b.use();
		b.prefs.receiveSnapshot(server.snapshot());
		expect(b.storage.get(PREF.palette)).toBe("terminal");
		expect(b.storage.get(PREF.sidebarWidth)).toBe("333");
		expect(told).toEqual([[PREF.palette, PREF.sidebarWidth]]);
		expect(b.storage.get(PREFS_SYNC_KEY)).toBe(syncMarker(server.snapshot()));
		// What is already shown is not announced again, and an older state arriving late changes nothing.
		const old = server.snapshot();
		a.use();
		a.prefs.setPref(PREF.palette, "omp");
		await a.hide();
		b.use();
		b.prefs.receiveSnapshot(server.snapshot());
		b.prefs.receiveSnapshot(old);
		b.prefs.receiveSnapshot(server.snapshot());
		expect(b.storage.get(PREF.palette)).toBe("omp");
		expect(told).toEqual([[PREF.palette, PREF.sidebarWidth], [PREF.palette]]);
		expect(posts().filter((r) => JSON.stringify(r.changes).includes("terminal"))).toHaveLength(1);
	});

	test("does not undo what this page chose and the server has not heard yet", async () => {
		const server = new UiPrefs(dir);
		const a = await open(server);
		const b = await open(server);
		a.use();
		a.prefs.setPref(PREF.theme, "light");
		a.prefs.setPref(PREF.palette, "hermes");
		await a.hide();

		b.use();
		b.prefs.setPref(PREF.theme, "dark");
		b.prefs.receiveSnapshot(server.snapshot());
		expect(b.storage.get(PREF.theme)).toBe("dark");
		expect(b.storage.get(PREF.palette)).toBe("hermes");
		await b.hide();
		expect(server.snapshot().values[PREF.theme]).toBe("dark");
	});

	test("a forgotten key is forgotten here too", async () => {
		const server = new UiPrefs(dir);
		const a = await open(server);
		a.prefs.setPref(PREF.sidebarWidth, "400");
		await a.hide();
		const b = await open(server);
		a.use();
		a.prefs.setPref(PREF.sidebarWidth, null);
		await a.hide();
		b.use();
		b.prefs.receiveSnapshot(server.snapshot());
		expect(b.storage.has(PREF.sidebarWidth)).toBe(false);
	});

	test("the answer to this page's own request carries what other pages changed meanwhile", async () => {
		const server = new UiPrefs(dir);
		const a = await open(server);
		const b = await open(server);
		const told = watch(a);
		b.use();
		b.prefs.setPref(PREF.palette, "chatgpt");
		await b.hide();
		a.use();
		a.prefs.setPref(PREF.theme, "light");
		await a.hide();
		expect(a.storage.get(PREF.palette)).toBe("chatgpt");
		expect(told).toEqual([[PREF.palette]]);
	});

	test("in another tab of the same origin is heard through the storage event, and that tab's choice wins over an unsent one", async () => {
		const a = await open(new UiPrefs(dir));
		const told = watch(a);
		a.prefs.setPref(PREF.theme, "light");
		a.fire("storage", { key: PREF.theme, storageArea: globals.localStorage });
		a.fire("storage", { key: "ompw.chunkReloadAt", storageArea: globals.localStorage });
		a.fire("storage", { key: PREF.palette, storageArea: {} });
		expect(told).toEqual([[PREF.theme]]);
		requests.length = 0;
		await a.hide();
		expect(requests).toEqual([]);
	});

	test("a value no build writes is dropped at start, and does not stop the rest from reaching the server", async () => {
		const server = new UiPrefs(dir);
		const a = await open(server, { [PREF.theme]: "blue", [PREF.palette]: "omp", [PREF.sidebarWidth]: "wide" });
		expect(a.storage.has(PREF.theme)).toBe(false);
		expect(a.storage.has(PREF.sidebarWidth)).toBe(false);
		const values = server.snapshot().values;
		expect([values[PREF.theme], values[PREF.palette], values[PREF.sidebarWidth]]).toEqual([null, "omp", null]);
	});
});
