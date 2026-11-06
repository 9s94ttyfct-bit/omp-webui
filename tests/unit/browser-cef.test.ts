import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppPage, CefLink, type ServerToApp, startCefEngine } from "../../server/browser/cef.ts";
import { EngineHost } from "../../server/browser/engine.ts";
import { CdpProxy, type ProxySocket } from "../../server/browser/proxy.ts";
import { PageRegistry, type TargetInfo } from "../../server/browser/registry.ts";
import { CdpClient, type CdpMessage } from "../../server/browser/transport.ts";

/**
 * The Mac app's CEF as the server's engine (server/browser/cef.ts) against a scripted app: the browser-level CDP the
 * server speaks is answered from the app's list of pages, pages are made and closed by the app, and what is said on a
 * page session goes to that page's channel in the app and back. The conversations' proxy works over it as over CfT.
 */

const work = mkdtempSync(join(tmpdir(), "ompw-browser-cef-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** What `answer` gives for a command the page never answers (it closes first). */
const NO_ANSWER = Symbol("no answer");

/** The app: its pages, what it was told, and a page channel that answers every command with what `answer` says. */
class FakeApp {
	readonly told: ServerToApp[] = [];
	readonly link: CefLink;
	private n = 0;
	answer: (method: string, params: unknown) => unknown = () => ({});

	constructor(pages: AppPage[] = []) {
		this.link = new CefLink({ send: (text) => this.got(JSON.parse(text) as ServerToApp) });
		this.link.receive(
			JSON.stringify({ t: "hello", run: "run-1", version: "156.0.15+g+chromium-156.0.8078.80", pages }),
		);
	}

	/** A page appears in the app (`opener`: opened by that page). */
	open(url: string, openerId?: string): string {
		const targetId = `P${++this.n}`.padEnd(32, "0");
		this.link.receive(
			JSON.stringify({ t: "page", page: { targetId, url, title: url, ...(openerId ? { openerId } : {}) } }),
		);
		return targetId;
	}

	close(targetId: string): void {
		this.link.receive(JSON.stringify({ t: "closed", targetId }));
	}

	/** The commands a page's channel was sent. */
	cdpTo(targetId: string): { id: number; method: string; sessionId?: string }[] {
		return this.told.flatMap((m) =>
			m.t === "cdp" && m.targetId === targetId
				? [JSON.parse(m.message) as { id: number; method: string; sessionId?: string }]
				: [],
		);
	}

	/** The page's channel says something of its own (an event; `sessionId`: of a frame's session there). */
	event(targetId: string, method: string, params: unknown = {}, sessionId?: string): void {
		const message = JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) });
		this.link.receive(JSON.stringify({ t: "cdp", targetId, message }));
	}

	private got(m: ServerToApp): void {
		this.told.push(m);
		// The app answers on a later turn, as it does over its socket.
		queueMicrotask(() => {
			if (m.t === "create") {
				const targetId = this.open(m.url);
				this.link.receive(JSON.stringify({ t: "created", req: m.req, targetId }));
			} else if (m.t === "close") {
				this.close(m.targetId);
			} else if (m.t === "cdp") {
				const c = JSON.parse(m.message) as { id: number; method: string; params: unknown; sessionId?: string };
				const result = this.answer(c.method, c.params);
				if (result === NO_ANSWER) return;
				const reply = { id: c.id, result, ...(c.sessionId ? { sessionId: c.sessionId } : {}) };
				this.link.receive(JSON.stringify({ t: "cdp", targetId: m.targetId, message: JSON.stringify(reply) }));
			}
		});
	}
}

const ids = (infos: TargetInfo[]) => infos.map((t) => t.targetId).sort();

test("the browser's targets are the app's pages, and the app makes and closes them", async () => {
	const app = new FakeApp([{ targetId: "A".repeat(32), url: "about:blank", title: "" }]);
	const client = new CdpClient(startCefEngine(app.link));
	const created: string[] = [];
	const destroyed: string[] = [];
	client.on<{ targetInfo: TargetInfo }>("Target.targetCreated", (p) => created.push(p.targetInfo.targetId));
	client.on<{ targetId: string }>("Target.targetDestroyed", (p) => destroyed.push(p.targetId));
	await client.call("Target.setDiscoverTargets", { discover: true });
	// The browser itself first, as Chrome tells it (Puppeteer's `browser.target()`), then the pages.
	expect(created).toEqual(["ompw-cef-browser", "A".repeat(32)]);

	const { targetId } = await client.call<{ targetId: string }>("Target.createTarget", { url: "https://example.com/" });
	expect(app.told.find((m) => m.t === "create")).toMatchObject({ url: "https://example.com/" });
	// Heard of before it was answered, as Chrome tells it.
	expect(created).toEqual(["ompw-cef-browser", "A".repeat(32), targetId]);
	const { targetInfos } = await client.call<{ targetInfos: TargetInfo[] }>("Target.getTargets");
	expect(ids(targetInfos)).toEqual(ids([{ targetId: "A".repeat(32) } as TargetInfo, { targetId } as TargetInfo]));
	expect(targetInfos.find((t) => t.targetId === targetId)?.url).toBe("https://example.com/");

	await client.call("Target.closeTarget", { targetId });
	await Bun.sleep(0);
	expect(destroyed).toEqual([targetId]);
	await expect(client.call("Target.attachToTarget", { targetId, flatten: true })).rejects.toThrow(/No target/);
});

test("what is said on a page session reaches that page in the app, and its answers and events come back to each session", async () => {
	const app = new FakeApp();
	const page = app.open("about:blank");
	app.answer = (method) => (method === "Runtime.evaluate" ? { result: { value: 2 } } : {});
	const transport = startCefEngine(app.link);
	const got: CdpMessage[] = [];
	transport.onMessage((m) => got.push(m));
	const call = async (m: CdpMessage) => {
		transport.send(m);
		for (let i = 0; i < 100 && !got.some((g) => g.id === m.id && g.sessionId === m.sessionId); i++) await Bun.sleep(0);
		return got.find((g) => g.id === m.id && g.sessionId === m.sessionId) as CdpMessage;
	};
	const s1 = (
		(await call({ id: 1, method: "Target.attachToTarget", params: { targetId: page, flatten: true } })).result as {
			sessionId: string;
		}
	).sessionId;
	const s2 = (
		(await call({ id: 2, method: "Target.attachToTarget", params: { targetId: page, flatten: true } })).result as {
			sessionId: string;
		}
	).sessionId;
	expect(s1).not.toBe(s2);

	// Both sessions use id 7: the page's channel gets two different ids, and each answer goes back to its own session.
	const [a, b] = await Promise.all([
		call({ id: 7, method: "Runtime.evaluate", params: { expression: "1+1" }, sessionId: s1 }),
		call({ id: 7, method: "Page.enable", params: {}, sessionId: s2 }),
	]);
	expect(a.result).toEqual({ result: { value: 2 } });
	expect(b.result).toEqual({});
	const wire = app.cdpTo(page);
	expect(wire.map((c) => c.method)).toEqual(["Runtime.evaluate", "Page.enable"]);
	expect(new Set(wire.map((c) => c.id)).size).toBe(2);

	// An event of the page reaches every session on it.
	app.link.receive(
		JSON.stringify({
			t: "cdp",
			targetId: page,
			message: JSON.stringify({ method: "Page.loadEventFired", params: {} }),
		}),
	);
	expect(
		got
			.filter((m) => m.method === "Page.loadEventFired")
			.map((m) => m.sessionId)
			.sort(),
	).toEqual([s1, s2].sort());

	// The page closes in the app: its sessions are detached.
	app.close(page);
	expect(
		got
			.filter((m) => m.method === "Target.detachedFromTarget")
			.map((m) => (m.params as { sessionId: string }).sessionId)
			.sort(),
	).toEqual([s1, s2].sort());
});

test("what a session set on its page ends with it: the page gets back what the session before it set, or none (#27)", async () => {
	const app = new FakeApp();
	const page = app.open("about:blank");
	const transport = startCefEngine(app.link);
	const got: CdpMessage[] = [];
	transport.onMessage((m) => got.push(m));
	let next = 100;
	const call = async (method: string, params: object = {}, sessionId?: string) => {
		const id = next++;
		transport.send({ id, method, params, ...(sessionId ? { sessionId } : {}) });
		for (let i = 0; i < 100 && !got.some((g) => g.id === id); i++) await Bun.sleep(0);
		return got.find((g) => g.id === id) as CdpMessage;
	};
	const attach = async () =>
		((await call("Target.attachToTarget", { targetId: page, flatten: true })).result as { sessionId: string })
			.sessionId;
	const tab = await attach();
	const agent = await attach();
	const sent = () => app.cdpTo(page) as { method: string; params?: Record<string, unknown> }[];

	// The tab lays the page out as a phone; the agent then sets its own size and intercepts requests.
	await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, mobile: true }, tab);
	await call("Emulation.setDeviceMetricsOverride", { width: 800, height: 600, mobile: false }, agent);
	await call("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, agent);
	// A held request is the interceptor's alone.
	app.event(page, "Fetch.requestPaused", { requestId: "r1" });
	expect(got.filter((m) => m.method === "Fetch.requestPaused").map((m) => m.sessionId)).toEqual([agent]);

	// The agent goes: the tab's phone comes back, and the interception ends (its held requests go on).
	const before = sent().length;
	await call("Target.detachFromTarget", { sessionId: agent });
	await Bun.sleep(0);
	const after = sent().slice(before);
	expect(after.map((c) => c.method).sort()).toEqual(["Emulation.setDeviceMetricsOverride", "Fetch.disable"]);
	expect(after.find((c) => c.method === "Emulation.setDeviceMetricsOverride")?.params).toMatchObject({ width: 390 });

	// The tab goes too: nobody set a size any more.
	const later = sent().length;
	await call("Target.detachFromTarget", { sessionId: tab });
	await Bun.sleep(0);
	expect(
		sent()
			.slice(later)
			.map((c) => c.method),
	).toEqual(["Emulation.clearDeviceMetricsOverride"]);

	// A session that cleared what it set leaves nothing to undo.
	const third = await attach();
	await call("Emulation.setUserAgentOverride", { userAgent: "phone" }, third);
	await call("Emulation.setUserAgentOverride", { userAgent: "" }, third);
	const last = sent().length;
	await call("Target.detachFromTarget", { sessionId: third });
	await Bun.sleep(0);
	expect(sent().slice(last)).toEqual([]);
});

test("a connection reaches only its own pages: page commands at the browser are refused, a frame's session is its asker's, and a closed page answers what it was asked", async () => {
	const app = new FakeApp();
	const page = app.open("about:blank");
	const transport = startCefEngine(app.link);
	const got: CdpMessage[] = [];
	transport.onMessage((m) => got.push(m));
	const answer = async (id: number, sessionId?: string) => {
		for (let i = 0; i < 100 && !got.some((g) => g.id === id && g.sessionId === sessionId); i++) await Bun.sleep(0);
		return got.find((g) => g.id === id && g.sessionId === sessionId) as CdpMessage;
	};
	const call = (m: CdpMessage) => {
		transport.send(m);
		return answer(m.id as number, m.sessionId);
	};
	// A page's own command sent to the browser goes to no page (on the app's first page it would reach whoever's it is).
	const refused = await call({ id: 1, method: "Runtime.evaluate", params: { expression: "document.cookie" } });
	expect(refused.error?.message).toContain("wasn't found");
	expect(app.cdpTo(page)).toEqual([]);
	// The browser's own domains still go through a page's channel.
	expect((await call({ id: 2, method: "Browser.setDownloadBehavior", params: { behavior: "deny" } })).result).toEqual(
		{},
	);
	expect(app.cdpTo(page).map((c) => c.method)).toEqual(["Browser.setDownloadBehavior"]);

	// A connection's browser session, gone: no page attaches in it any more.
	const context = ((await call({ id: 3, method: "Target.attachToBrowserTarget" })).result as { sessionId: string })
		.sessionId;
	await call({
		id: 4,
		method: "Target.setAutoAttach",
		params: { autoAttach: true, flatten: true },
		sessionId: context,
	});
	await call({ id: 5, method: "Target.detachFromTarget", params: { sessionId: context } });
	const before = got.length;
	app.open("https://example.com/");
	expect(got.slice(before).filter((m) => m.method === "Target.attachedToTarget")).toEqual([]);

	// Two sessions on the page; one asks for its frames.
	const attach = async (id: number) =>
		(
			(await call({ id, method: "Target.attachToTarget", params: { targetId: page, flatten: true } })).result as {
				sessionId: string;
			}
		).sessionId;
	const [s1, s2] = [await attach(6), await attach(7)];
	await call({
		id: 8,
		method: "Target.setAutoAttach",
		params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
		sessionId: s1,
	});
	app.event(page, "Target.attachedToTarget", {
		sessionId: "FRAME1",
		targetInfo: { type: "iframe" },
		waitingForDebugger: true,
	});
	const frameAttached = got.filter(
		(m) => m.method === "Target.attachedToTarget" && (m.params as { sessionId?: string }).sessionId === "FRAME1",
	);
	expect(frameAttached.map((m) => m.sessionId)).toEqual([s1]);
	// The frame's session is the page channel's own: what is said on it goes there as it is, and comes back on it.
	const resumed = await call({ id: 9, method: "Runtime.runIfWaitingForDebugger", params: {}, sessionId: "FRAME1" });
	expect(resumed.result).toEqual({});
	expect(app.cdpTo(page).at(-1)).toMatchObject({ method: "Runtime.runIfWaitingForDebugger", sessionId: "FRAME1" });
	app.event(page, "Runtime.consoleAPICalled", { type: "log" }, "FRAME1");
	expect(got.filter((m) => m.method === "Runtime.consoleAPICalled").map((m) => m.sessionId)).toEqual(["FRAME1"]);

	// The screencast's frames go to the session that runs it.
	await call({ id: 10, method: "Page.startScreencast", params: {}, sessionId: s2 });
	app.event(page, "Page.screencastFrame", { data: "", sessionId: 1 });
	expect(got.filter((m) => m.method === "Page.screencastFrame").map((m) => m.sessionId)).toEqual([s2]);

	// The page closes while a command waits for its answer: the command is answered.
	app.answer = () => NO_ANSWER;
	transport.send({ id: 11, method: "Page.navigate", params: { url: "https://example.org/" }, sessionId: s1 });
	for (let i = 0; i < 100 && !app.cdpTo(page).some((c) => c.method === "Page.navigate"); i++) await Bun.sleep(0);
	app.close(page);
	expect((await answer(11, s1)).error?.message).toBe("Target closed");
});

/** A conversation's connection to the proxy (as in tests/unit/browser-proxy.test.ts). */
class Client implements ProxySocket {
	readonly got: CdpMessage[] = [];
	conn!: { message(text: string): void };
	private n = 0;
	send(text: string): void {
		this.got.push(JSON.parse(text) as CdpMessage);
	}
	close(): void {}
	async call(method: string, params: object = {}, sessionId?: string): Promise<CdpMessage> {
		const id = ++this.n;
		this.conn.message(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
		for (let i = 0; i < 500; i++) {
			const answer = this.got.find((m) => m.id === id && m.sessionId === sessionId);
			if (answer) return answer;
			await Bun.sleep(1);
		}
		throw new Error(`no answer to ${method}`);
	}
}

test("over the app's pages each conversation sees its own, and a page its page opens is its too", async () => {
	const app = new FakeApp();
	const registry = new PageRegistry(join(work, "owners.json"));
	const host = new EngineHost(registry, async () => ({
		transport: startCefEngine(app.link),
		generation: app.link.run,
		fresh: false,
	}));
	const proxy = new CdpProxy(host, registry);
	const connect = (owner: string) => {
		const client = new Client();
		client.conn = proxy.connect(owner, client);
		return client;
	};
	const a = connect("/s/a.jsonl");
	const b = connect("/s/b.jsonl");
	const listA = await a.call("Target.getTargets");
	const listB = await b.call("Target.getTargets");
	const [pageA] = registry.pagesOf("/s/a.jsonl");
	const [pageB] = registry.pagesOf("/s/b.jsonl");
	expect(ids((listA.result as { targetInfos: TargetInfo[] }).targetInfos)).toEqual([pageA]);
	expect(ids((listB.result as { targetInfos: TargetInfo[] }).targetInfos)).toEqual([pageB]);

	// A page opens another (window.open): it is the opener's conversation's.
	await a.call("Target.setDiscoverTargets", { discover: true });
	const popup = app.open("https://example.com/popup", pageA);
	for (let i = 0; i < 100 && registry.ownerOfTarget(popup) === null; i++) await Bun.sleep(1);
	expect(registry.ownerOfTarget(popup)).toBe("/s/a.jsonl");
	expect(ids(((await b.call("Target.getTargets")).result as { targetInfos: TargetInfo[] }).targetInfos)).toEqual([
		pageB,
	]);

	// The conversation drives its page through the app.
	const { sessionId } = (await a.call("Target.attachToTarget", { targetId: pageA, flatten: true })).result as {
		sessionId: string;
	};
	app.answer = () => ({ frameTree: { frame: { id: "F" } } });
	expect((await a.call("Page.getFrameTree", {}, sessionId)).result).toEqual({ frameTree: { frame: { id: "F" } } });
	expect(app.cdpTo(pageA).some((c) => c.method === "Page.getFrameTree")).toBe(true);
});

test("a session of the browser (omp's downloads) sets where every page's downloads go and hears every page's download events, until it ends", async () => {
	const app = new FakeApp();
	const registry = new PageRegistry(join(work, "owners-downloads.json"));
	const host = new EngineHost(registry, async () => ({
		transport: startCefEngine(app.link),
		generation: app.link.run,
		fresh: false,
	}));
	const proxy = new CdpProxy(host, registry);
	const a = new Client();
	a.conn = proxy.connect("/s/a.jsonl", a);
	await a.call("Target.setDiscoverTargets", { discover: true, filter: [{}] });
	const created = a.got
		.filter((m) => m.method === "Target.targetCreated")
		.map((m) => (m.params as { targetInfo: TargetInfo }).targetInfo.type);
	expect(created).toEqual(["browser", "page"]);
	const own = ((await a.call("Target.getTargetInfo")).result as { targetInfo: TargetInfo }).targetInfo;
	expect(own.type).toBe("browser");
	const [pageA] = registry.pagesOf("/s/a.jsonl");
	const other = app.open("https://example.com/");

	// Puppeteer's `browser.target().createCDPSession()`.
	const { sessionId } = (await a.call("Target.attachToTarget", { targetId: own.targetId, flatten: true })).result as {
		sessionId: string;
	};
	const behavior = { behavior: "allow", downloadPath: "/tmp/ompw-downloads", eventsEnabled: true };
	expect((await a.call("Browser.setDownloadBehavior", behavior, sessionId)).result).toEqual({});
	const downloadsOf = (targetId: string) =>
		app.told.flatMap((m) => {
			if (m.t !== "cdp" || m.targetId !== targetId) return [];
			const c = JSON.parse(m.message) as { method: string; params: Record<string, unknown> };
			return c.method === "Browser.setDownloadBehavior" ? [c.params] : [];
		});
	// Every page is set (each page's channel carries only its own downloads' events), a page made later too.
	expect(downloadsOf(pageA)).toEqual([behavior]);
	expect(downloadsOf(other)).toEqual([behavior]);
	const later = app.open("https://example.org/");
	expect(downloadsOf(later)).toEqual([behavior]);

	// A download of any page is heard on the session that asked for the events.
	const will = { frameId: later, guid: "g1", url: "https://example.org/f", suggestedFilename: "f" };
	app.event(later, "Browser.downloadWillBegin", will);
	app.event(later, "Browser.downloadProgress", { guid: "g1", state: "completed", filePath: "/tmp/ompw-downloads/f" });
	expect(a.got.filter((m) => m.method?.startsWith("Browser.download")).map((m) => [m.method, m.sessionId])).toEqual([
		["Browser.downloadWillBegin", sessionId],
		["Browser.downloadProgress", sessionId],
	]);

	// A page that closes takes the behaviour with it in CEF: the others are given it again.
	app.close(other);
	expect(downloadsOf(later)).toEqual([behavior, behavior]);

	// The session ends: the browser's default is back, and the conversation is told its session went.
	await a.call("Target.detachFromTarget", { sessionId });
	expect(downloadsOf(pageA).at(-1)).toEqual({ behavior: "default", eventsEnabled: false });
	expect(
		a.got
			.filter((m) => m.method === "Target.detachedFromTarget")
			.map((m) => (m.params as { sessionId: string }).sessionId),
	).toEqual([sessionId]);
});
