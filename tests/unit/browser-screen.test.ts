import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineHost } from "../../server/browser/engine.ts";
import { PageRegistry } from "../../server/browser/registry.ts";
import { ScreenHub, type ScreenSocket } from "../../server/browser/screen.ts";
import { decodeFrame, frameToPage, pageSizeFor, type ScreenServerMessage } from "../../shared/browser-protocol.ts";
import { FakeBrowser } from "../support/fake-cdp.ts";

/** The Browser tab's sizes and coordinates, and who is told a page's console. */

const work = mkdtempSync(join(tmpdir(), "ompw-browser-screen-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

test("a page lays out at the desktop size, the panel's, or a phone's", () => {
	const panel = { w: 333.4, h: 500 };
	expect(pageSizeFor("desktop", panel)).toEqual({ w: 1280, h: 800, scale: 1, mobile: false });
	expect(pageSizeFor("desktop", panel, { w: 1440, h: 900 })).toEqual({ w: 1440, h: 900, scale: 1, mobile: false });
	expect(pageSizeFor("phone", panel)).toEqual({ w: 390, h: 844, scale: 3, mobile: true });
	expect(pageSizeFor("panel", panel)).toEqual({ w: 333, h: 500, scale: 1, mobile: false });
});

test("a point of the shown frame is the page's CSS pixel under it, kept on the page", () => {
	const frame = { w: 640, h: 400 };
	const page = { w: 1280, h: 800 };
	expect(frameToPage(320, 200, frame, page)).toEqual({ x: 640, y: 400 });
	expect(frameToPage(-5, 900, frame, page)).toEqual({ x: 0, y: 799 });
	expect(frameToPage(700, 10, frame, page)).toEqual({ x: 1279, y: 20 });
});

class Socket implements ScreenSocket {
	readonly texts: ScreenServerMessage[] = [];
	readonly frames: Uint8Array[] = [];
	sendText(text: string): void {
		this.texts.push(JSON.parse(text) as ScreenServerMessage);
	}
	sendBinary(data: Uint8Array): void {
		this.frames.push(data);
	}
	buffered(): number {
		return 0;
	}
	close(): void {}
}

async function until(fn: () => boolean): Promise<void> {
	for (let i = 0; i < 500 && !fn(); i++) await Bun.sleep(2);
	expect(fn()).toBe(true);
}

test("a page's console is told only to the tabs that show that page", async () => {
	const registry = new PageRegistry(join(work, "owners.json"));
	const browser = new FakeBrowser();
	const host = new EngineHost(registry, async () => ({ transport: browser, generation: "g", fresh: true }));
	const hub = new ScreenHub(host, registry);
	const engine = await host.ready();
	const one = await engine.createPage("/s/a.jsonl");
	const two = await engine.createPage("/s/a.jsonl");

	const watchOne = new Socket();
	const watchTwo = new Socket();
	const listOnly = new Socket();
	hub
		.connect(watchOne)
		.message(JSON.stringify({ t: "watch", owner: "/s/a.jsonl", targetId: one, panel: { w: 800, h: 600 } }));
	hub
		.connect(watchTwo)
		.message(JSON.stringify({ t: "watch", owner: "/s/a.jsonl", targetId: two, panel: { w: 800, h: 600 } }));
	hub
		.connect(listOnly)
		.message(JSON.stringify({ t: "watch", owner: "/s/a.jsonl", targetId: null, panel: { w: 800, h: 600 } }));
	await until(() => listOnly.texts.some((m) => m.t === "pages" && m.pages.length === 2));
	await until(() => browser.log.filter((l) => l.method === "Runtime.enable").length === 2);

	browser.emitOnPage(one, "Runtime.consoleAPICalled", {
		type: "error",
		args: [{ type: "string", value: "boom" }],
		timestamp: 1,
	});
	await until(() => watchOne.texts.some((m) => m.t === "console"));
	const entry = watchOne.texts.find((m) => m.t === "console");
	expect(entry).toMatchObject({
		t: "console",
		targetId: one,
		entry: { level: "error", text: "boom", source: "console" },
	});
	await Bun.sleep(10);
	expect(watchTwo.texts.some((m) => m.t === "console")).toBe(false);
	expect(listOnly.texts.some((m) => m.t === "console")).toBe(false);
});

test("a tab that watches its page again (its panel resized) is not told the page's console twice", async () => {
	const registry = new PageRegistry(join(work, "owners-rewatch.json"));
	const browser = new FakeBrowser();
	const host = new EngineHost(registry, async () => ({ transport: browser, generation: "g", fresh: true }));
	const hub = new ScreenHub(host, registry);
	const engine = await host.ready();
	const page = await engine.createPage("/s/a.jsonl");
	const other = await engine.createPage("/s/a.jsonl");
	const tab = new Socket();
	const client = hub.connect(tab);
	const watch = (targetId: string, w: number) =>
		client.message(JSON.stringify({ t: "watch", owner: "/s/a.jsonl", targetId, panel: { w, h: 600 } }));
	const told = () => tab.texts.filter((m) => m.t === "console").length;
	watch(page, 800);
	await until(() => browser.log.some((l) => l.method === "Runtime.enable"));
	browser.emitOnPage(page, "Runtime.consoleAPICalled", { type: "error", args: [{ type: "string", value: "boom" }] });
	await until(() => told() === 1);
	watch(page, 640);
	await until(() => tab.texts.filter((m) => m.t === "pages").length >= 4);
	await Bun.sleep(10);
	expect(told()).toBe(1);
	// Another page, then this one again: the tab's list started over, so it is told the console again.
	watch(other, 640);
	watch(page, 640);
	await until(() => told() === 2);
});

test("a tab acts only on the pages of the conversation it watches", async () => {
	const registry = new PageRegistry(join(work, "owners-scope.json"));
	const browser = new FakeBrowser();
	const host = new EngineHost(registry, async () => ({ transport: browser, generation: "g", fresh: true }));
	const hub = new ScreenHub(host, registry);
	const engine = await host.ready();
	const pageB = await engine.createPage("/s/b.jsonl");
	const tab = new Socket();
	const client = hub.connect(tab);
	client.message(JSON.stringify({ t: "watch", owner: "/s/a.jsonl", targetId: null, panel: { w: 800, h: 600 } }));
	await until(() => tab.texts.some((m) => m.t === "pages"));
	const sent = browser.log.length;
	client.message(JSON.stringify({ t: "navigate", targetId: pageB, action: "url", url: "https://example.com" }));
	client.message(JSON.stringify({ t: "input", targetId: pageB, event: { kind: "text", text: "x" } }));
	client.message(JSON.stringify({ t: "close", targetId: pageB }));
	client.message(JSON.stringify({ t: "open", owner: "/s/b.jsonl", url: "https://example.com" }));
	await Bun.sleep(20);
	const after = browser.log.slice(sent).map((l) => l.method);
	expect(after).not.toContain("Page.navigate");
	expect(after).not.toContain("Input.insertText");
	expect(after).not.toContain("Target.closeTarget");
	expect(after).not.toContain("Target.createTarget");
	expect(registry.pagesOf("/s/b.jsonl")).toEqual([pageB]);
});

test("a command on a page that went away, or not this conversation's, is no sign the browser cannot be used", async () => {
	const registry = new PageRegistry(join(work, "owners-gone.json"));
	const browser = new FakeBrowser();
	const host = new EngineHost(registry, async () => ({ transport: browser, generation: "g", fresh: true }));
	const hub = new ScreenHub(host, registry);
	const engine = await host.ready();
	const page = await engine.createPage("/s/a.jsonl");
	const gone = await engine.createPage("/s/a.jsonl");
	const other = await engine.createPage("/s/b.jsonl");
	const tab = new Socket();
	const client = hub.connect(tab);
	client.message(JSON.stringify({ t: "watch", owner: "/s/a.jsonl", targetId: page, panel: { w: 800, h: 600 } }));
	await until(() => browser.log.some((l) => l.method === "Runtime.enable"));
	// The agent closed a page; a key the person pressed in it reaches the server after.
	await engine.close(gone);
	client.message(JSON.stringify({ t: "input", targetId: gone, event: { kind: "text", text: "x" } }));
	client.message(JSON.stringify({ t: "size", targetId: other, mode: "phone" }));
	client.message(JSON.stringify({ t: "input", targetId: page, event: { kind: "text", text: "y" } }));
	await until(() => browser.log.some((l) => l.method === "Input.insertText"));
	expect(tab.texts.some((m) => m.t === "unavailable")).toBe(false);
});

test("a page drawn by the app's own view is scaled to fit it, until the tab that said so stops watching", async () => {
	const registry = new PageRegistry(join(work, "owners-fit.json"));
	const browser = new FakeBrowser();
	const host = new EngineHost(registry, async () => ({ transport: browser, generation: "g", fresh: true }));
	const hub = new ScreenHub(host, registry);
	const engine = await host.ready();
	const page = await engine.createPage("/s/a.jsonl");
	const metrics = () =>
		browser.log.filter((l) => l.method === "Emulation.setDeviceMetricsOverride").map((l) => l.params) as {
			width: number;
			deviceScaleFactor: number;
			scale?: number;
		}[];
	const tab = new Socket();
	const client = hub.connect(tab);
	client.message(JSON.stringify({ t: "watch", owner: "/s/a.jsonl", targetId: null, panel: { w: 1, h: 1 } }));
	client.message(JSON.stringify({ t: "fit", targetId: page, room: { w: 320, h: 400 } }));
	// 1280×800 into 320×400: a quarter, drawn at the screen's own pixel ratio.
	await until(() => metrics().at(-1)?.scale === 0.25);
	expect(metrics().at(-1)).toMatchObject({ width: 1280, deviceScaleFactor: 0 });
	// Laid out at a phone's size, it keeps the phone's pixel ratio, scaled to the same room.
	client.message(JSON.stringify({ t: "size", targetId: page, mode: "phone" }));
	await until(() => metrics().at(-1)?.width === 390);
	expect(metrics().at(-1)).toMatchObject({ deviceScaleFactor: 3, scale: Math.min(320 / 390, 400 / 844) });
	// The tab stops watching (it went away): the page is drawn unscaled for the screencasts.
	const before = metrics().length;
	client.message(JSON.stringify({ t: "unwatch" }));
	await until(() => metrics().length > before);
	expect(metrics().at(-1)).not.toHaveProperty("scale");
	// What it says after it stopped (its view ending as it goes) is no error, and changes nothing.
	client.message(JSON.stringify({ t: "fit", targetId: page, room: null }));
	await Bun.sleep(20);
	expect(metrics().length).toBe(before + 1);
	expect(tab.texts.some((m) => m.t === "unavailable")).toBe(false);
});

test("a page's frames are numbered above any earlier view's of it, so a tab that drew those still draws these", async () => {
	const registry = new PageRegistry(join(work, "owners-seq.json"));
	const browser = new FakeBrowser();
	const host = new EngineHost(registry, async () => ({ transport: browser, generation: "g", fresh: true }));
	const engine = await host.ready();
	const page = await engine.createPage("/s/a.jsonl");
	/** A tab of a server (its own hub, as a server that restarted while the app kept the page) and the frames it gets. */
	const watching = async () => {
		const tab = new Socket();
		new ScreenHub(host, registry)
			.connect(tab)
			.message(JSON.stringify({ t: "watch", owner: "/s/a.jsonl", targetId: page, panel: { w: 800, h: 600 } }));
		await until(() => tab.texts.some((m) => m.t === "pages" && m.pages.length === 1));
		await Bun.sleep(10);
		return tab;
	};
	const frame = { data: Buffer.from("jpeg").toString("base64"), sessionId: 1 };
	const first = await watching();
	for (let i = 0; i < 50; i++) browser.emitOnPage(page, "Page.screencastFrame", frame);
	await until(() => first.frames.length === 50);
	const later = await watching();
	browser.emitOnPage(page, "Page.screencastFrame", frame);
	await until(() => later.frames.length === 1);
	const seqOf = (data: Uint8Array | undefined) => decodeFrame(data as Uint8Array).header.seq;
	expect(seqOf(later.frames[0])).toBeGreaterThan(seqOf(first.frames.at(-1)));
});

test("a page that has loaded with no frame since it navigated is cast again; one that sent a frame is not (#41)", async () => {
	const registry = new PageRegistry(join(work, "owners-recast.json"));
	const browser = new FakeBrowser();
	const host = new EngineHost(registry, async () => ({ transport: browser, generation: "g", fresh: true }));
	const hub = new ScreenHub(host, registry);
	const engine = await host.ready();
	const silent = await engine.createPage("/s/a.jsonl");
	const shown = await engine.createPage("/s/a.jsonl");
	for (const page of [silent, shown]) {
		const tab = new Socket();
		hub
			.connect(tab)
			.message(JSON.stringify({ t: "watch", owner: "/s/a.jsonl", targetId: page, panel: { w: 800, h: 600 } }));
	}
	const starts = () => browser.log.filter((l) => l.method === "Page.startScreencast").length;
	await until(() => starts() === 2);
	const frame = { data: Buffer.from("jpeg").toString("base64"), sessionId: 1 };
	for (const page of [silent, shown]) browser.emitOnPage(page, "Page.frameNavigated", { frame: { id: "main" } });
	// A child frame's navigation is not the page's.
	browser.emitOnPage(shown, "Page.frameNavigated", { frame: { id: "child", parentId: "main" } });
	browser.emitOnPage(shown, "Page.screencastFrame", frame);
	for (const page of [silent, shown]) browser.emitOnPage(page, "Page.loadEventFired", {});
	// The engine gets a moment for a frame first (`RECAST_AFTER_MS`, 1 s).
	await Bun.sleep(900);
	await until(() => starts() === 3);
	await Bun.sleep(1200);
	expect(starts()).toBe(3);
	expect(browser.log.filter((l) => l.method === "Page.stopScreencast")).toHaveLength(1);
});

test("a tab that draws the page itself (the Mac app's view) is told its console, and gets no frames", async () => {
	const registry = new PageRegistry(join(work, "owners-console-only.json"));
	const browser = new FakeBrowser();
	const host = new EngineHost(registry, async () => ({ transport: browser, generation: "g", fresh: true }));
	const hub = new ScreenHub(host, registry);
	const engine = await host.ready();
	const page = await engine.createPage("/s/a.jsonl");
	const tab = new Socket();
	hub
		.connect(tab)
		.message(
			JSON.stringify({ t: "watch", owner: "/s/a.jsonl", targetId: page, panel: { w: 800, h: 600 }, frames: false }),
		);
	await until(() => browser.log.some((l) => l.method === "Runtime.enable"));
	browser.emitOnPage(page, "Runtime.consoleAPICalled", { type: "error", args: [{ type: "string", value: "boom" }] });
	await until(() => tab.texts.some((m) => m.t === "console"));
	browser.emitOnPage(page, "Page.screencastFrame", { data: Buffer.from("jpeg").toString("base64"), sessionId: 1 });
	await Bun.sleep(10);
	expect(tab.frames).toEqual([]);
	expect(browser.log.some((l) => l.method === "Page.startScreencast")).toBe(false);
});

test("a tab whose watch came before the engine could be used watches again once it can, and is told so", async () => {
	const registry = new PageRegistry(join(work, "owners-late.json"));
	// The app's browser, over one connection and then another (its pages stay): the second sees the first's pages.
	const first = new FakeBrowser();
	const browser = new FakeBrowser();
	let linked = true;
	const host = new EngineHost(registry, async () => {
		if (!linked) throw new Error("the app's browser is not connected");
		return { transport: browser.targets.size ? browser : first, generation: "g", fresh: false };
	});
	const page = await (await host.ready()).createPage("/s/a.jsonl");
	for (const [id, info] of first.targets) browser.targets.set(id, info);
	// The engine's connection ends (the app's server restarted) and the tab's watch comes before the app is linked again.
	linked = false;
	await host.stop("The app connected again");
	const hub = new ScreenHub(host, registry);
	const tab = new Socket();
	hub
		.connect(tab)
		.message(JSON.stringify({ t: "watch", owner: "/s/a.jsonl", targetId: page, panel: { w: 800, h: 600 } }));
	await until(() => tab.texts.some((m) => m.t === "unavailable"));

	linked = true;
	hub.engineBack();
	await until(() => tab.texts.some((m) => m.t === "available"));
	expect(tab.texts.findLast((m) => m.t === "pages")).toMatchObject({
		owner: "/s/a.jsonl",
		pages: [{ targetId: page }],
	});
	browser.emitOnPage(page, "Runtime.consoleAPICalled", { type: "error", args: [{ type: "string", value: "boom" }] });
	await until(() => tab.texts.some((m) => m.t === "console"));
	// A tab that was never told it could not be used is not made to watch again.
	const before = tab.texts.length;
	hub.engineBack();
	await Bun.sleep(10);
	expect(tab.texts.length).toBe(before);
});
