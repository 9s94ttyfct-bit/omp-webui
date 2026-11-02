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
	cdpTo(targetId: string): { id: number; method: string }[] {
		return this.told.flatMap((m) =>
			m.t === "cdp" && m.targetId === targetId ? [JSON.parse(m.message) as { id: number; method: string }] : [],
		);
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
			} else {
				const c = JSON.parse(m.message) as { id: number; method: string; params: unknown };
				const reply = { id: c.id, result: this.answer(c.method, c.params) };
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
	expect(created).toEqual(["A".repeat(32)]);

	const { targetId } = await client.call<{ targetId: string }>("Target.createTarget", { url: "https://example.com/" });
	expect(app.told.find((m) => m.t === "create")).toMatchObject({ url: "https://example.com/" });
	// Heard of before it was answered, as Chrome tells it.
	expect(created).toEqual(["A".repeat(32), targetId]);
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
