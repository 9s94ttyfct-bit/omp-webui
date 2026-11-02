// needs: posixShell
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { startCft } from "../../server/browser/cft.ts";
import { type Engine, EngineHost } from "../../server/browser/engine.ts";
import { PageRegistry } from "../../server/browser/registry.ts";
import { ScreenHub, type ScreenSocket } from "../../server/browser/screen.ts";
import {
	type ConsoleEntry,
	decodeFrame,
	type FrameHeader,
	frameToPage,
	type ScreenServerMessage,
} from "../../shared/browser-protocol.ts";

/**
 * The Browser tab's socket over a real Chrome for Testing: frames of the shown page, a click mapped from a phone-sized
 * frame onto a desktop-sized page, the phone size, and the page's console and failed requests.
 */

const work = mkdtempSync(join(tmpdir(), "ompw-browser-screen-cft-"));
const OWNER = "/sessions/a.jsonl";
let host: EngineHost;
let hub: ScreenHub;
let engine: Engine;

beforeAll(async () => {
	const registry = new PageRegistry(join(work, "owners.json"));
	host = new EngineHost(registry, async () => ({
		transport: await startCft({
			executable: process.env.OMPW_BROWSER_EXECUTABLE || chromium.executablePath(),
			profileDir: join(work, "profile"),
		}),
		generation: "g",
		fresh: true,
	}));
	hub = new ScreenHub(host, registry);
	engine = await host.ready();
}, 30_000);

afterAll(async () => {
	await host.stop("done");
	rmSync(work, { recursive: true, force: true });
});

class Tab implements ScreenSocket {
	readonly texts: ScreenServerMessage[] = [];
	readonly frames: { header: FrameHeader; jpeg: Uint8Array }[] = [];
	sendText(text: string): void {
		this.texts.push(JSON.parse(text) as ScreenServerMessage);
	}
	sendBinary(data: Uint8Array): void {
		this.frames.push(decodeFrame(data));
	}
	buffered(): number {
		return 0;
	}
	close(): void {}
	consoles(): ConsoleEntry[] {
		return this.texts.flatMap((m) => (m.t === "console" ? [m.entry] : []));
	}
}

async function until(what: string, fn: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await fn()) return;
		await Bun.sleep(20);
	}
	throw new Error(`timed out: ${what}`);
}

async function evaluate(targetId: string, expression: string): Promise<unknown> {
	const view = await hub.view(engine, targetId);
	const r = await view.call<{ result: { value: unknown } }>("Runtime.evaluate", { expression, returnByValue: true });
	return r.result.value;
}

const BUTTON_PAGE = `data:text/html,<title>btn</title><style>body{margin:0}</style><button id=b style="position:absolute;left:900px;top:600px;width:200px;height:100px" onclick="this.textContent='clicked'">press</button>`;

test("a watched page sends JPEG frames, and a click on a narrow frame lands on the desktop-sized page", async () => {
	const targetId = await engine.createPage(OWNER, BUTTON_PAGE);
	const tab = new Tab();
	const client = hub.connect(tab);
	client.message(JSON.stringify({ t: "watch", owner: OWNER, targetId, panel: { w: 390, h: 244 } }));
	await until("a frame", () => tab.frames.length > 0, 2000);
	const { header, jpeg } = tab.frames[0];
	expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]);
	expect({ w: header.w, h: header.h }).toEqual({ w: 1280, h: 800 });

	// The button's centre (1000, 650) as the tab shows it: 390 px wide.
	const shown = { w: 390, h: 390 * (800 / 1280) };
	const at = { x: (1000 * shown.w) / 1280, y: (650 * shown.h) / 800 };
	const p = frameToPage(at.x, at.y, shown, { w: header.w, h: header.h });
	for (const type of ["mousePressed", "mouseReleased"])
		client.message(
			JSON.stringify({
				t: "input",
				targetId,
				event: { kind: "mouse", type, x: p.x, y: p.y, button: "left", clickCount: 1, modifiers: 0 },
			}),
		);
	await until(
		"the click",
		async () => (await evaluate(targetId, "document.getElementById('b').textContent")) === "clicked",
	);
	client.close();
}, 30_000);

test("the phone size lays the page out 390 px wide", async () => {
	// A page made for phones (`width=device-width`): one without it lays out 980 wide on a phone, as on a real one.
	const targetId = await engine.createPage(
		OWNER,
		"data:text/html,<meta name=viewport content='width=device-width'><title>w</title>",
	);
	const tab = new Tab();
	const client = hub.connect(tab);
	client.message(JSON.stringify({ t: "watch", owner: OWNER, targetId, panel: { w: 400, h: 800 } }));
	client.message(JSON.stringify({ t: "size", targetId, mode: "phone" }));
	await until("390 wide", async () => (await evaluate(targetId, "innerWidth")) === 390);
	await until("pages say phone", () =>
		tab.texts.some((m) => m.t === "pages" && m.pages.some((pg) => pg.targetId === targetId && pg.mode === "phone")),
	);
	client.close();
}, 30_000);

test("the page's console errors and failed requests reach the tab that shows it", async () => {
	const targetId = await engine.createPage(OWNER, "data:text/html,<title>c</title>");
	const tab = new Tab();
	const client = hub.connect(tab);
	client.message(JSON.stringify({ t: "watch", owner: OWNER, targetId, panel: { w: 400, h: 300 } }));
	await until("watching", () => tab.texts.some((m) => m.t === "pages"));
	await hub.view(engine, targetId);
	const closed = Bun.serve({ port: 0, fetch: () => new Response("") });
	const port = closed.port;
	closed.stop(true);
	await evaluate(targetId, `console.error("x"); fetch("http://127.0.0.1:${port}/nothing").catch(() => {}); 1`);
	await until("console error", () =>
		tab.consoles().some((e) => e.source === "console" && e.level === "error" && e.text === "x"),
	);
	await until("network error", () =>
		tab
			.consoles()
			.some((e) => e.source === "network" && e.level === "error" && (e.url ?? "").includes(`:${port}/nothing`)),
	);
	client.close();
}, 30_000);

test("the tabs learn a page's title once it has loaded, and again after it moves", async () => {
	const targetId = await engine.createPage(OWNER, "about:blank");
	const tab = new Tab();
	const client = hub.connect(tab);
	client.message(JSON.stringify({ t: "watch", owner: OWNER, targetId, panel: { w: 400, h: 300 } }));
	const titled = (title: string) =>
		tab.texts.some((m) => m.t === "pages" && m.pages.some((pg) => pg.targetId === targetId && pg.title === title));
	client.message(
		JSON.stringify({ t: "navigate", targetId, action: "url", url: "data:text/html,<title>first-title</title>" }),
	);
	await until("the first title", () => titled("first-title"));
	client.message(
		JSON.stringify({ t: "navigate", targetId, action: "url", url: "data:text/html,<title>second-title</title>" }),
	);
	await until("the second title", () => titled("second-title"));
	client.close();
}, 30_000);
