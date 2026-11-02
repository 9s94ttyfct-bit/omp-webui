import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineHost } from "../../server/browser/engine.ts";
import { CdpProxy, NOT_THIS_CONVERSATION, type ProxySocket } from "../../server/browser/proxy.ts";
import { PageRegistry, type TargetInfo } from "../../server/browser/registry.ts";
import { type CdpMessage, type CdpTransport, TransportListeners } from "../../server/browser/transport.ts";

/**
 * The per-conversation CDP proxy against a scripted browser that speaks enough of the browser-level Target domain (browser
 * sessions, discovery, auto-attach, flat sessions, pages opening pages): each conversation sees and drives only its pages.
 */

const work = mkdtempSync(join(tmpdir(), "ompw-browser-proxy-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

type Session =
	| { kind: "browser"; discover: boolean; autoAttach: boolean }
	| { kind: "page"; targetId: string; parent: string | undefined };

/** A browser that answers the Target domain the way Chrome does, events before the answer that caused them. */
class FakeBrowser implements CdpTransport {
	readonly listeners = new TransportListeners();
	readonly targets = new Map<string, TargetInfo>();
	readonly sessions = new Map<string | undefined, Session>([
		[undefined, { kind: "browser", discover: false, autoAttach: false }],
	]);
	/** Every command the browser was sent, with its session. */
	readonly log: { method: string; sessionId?: string; params?: unknown }[] = [];
	private n = 0;

	send(message: object): void {
		const m = message as CdpMessage;
		this.log.push({ method: m.method ?? "", sessionId: m.sessionId, params: m.params });
		queueMicrotask(() => this.handle(m));
	}
	onMessage(fn: (m: CdpMessage) => void) {
		return this.listeners.onMessage(fn);
	}
	onClose(fn: (why: string) => void) {
		return this.listeners.onClose(fn);
	}
	close(): void {
		this.listeners.end("closed");
	}

	/** A page opened by `opener` (`window.open`). */
	open(opener: string): string {
		return this.create("about:blank", opener);
	}

	private emit(sessionId: string | undefined, method: string, params: object): void {
		this.listeners.deliver({ method, params, ...(sessionId === undefined ? {} : { sessionId }) });
	}

	private create(url: string, openerId?: string): string {
		const targetId = `T${++this.n}`.padEnd(32, "0");
		const info: TargetInfo = { targetId, type: "page", url, title: url, ...(openerId ? { openerId } : {}) };
		this.targets.set(targetId, info);
		for (const [id, s] of this.sessions) {
			if (s.kind !== "browser") continue;
			if (s.discover) this.emit(id, "Target.targetCreated", { targetInfo: info });
			if (s.autoAttach) this.attach(id, targetId);
		}
		return targetId;
	}

	private attach(parent: string | undefined, targetId: string): string {
		const sessionId = `S${++this.n}`;
		this.sessions.set(sessionId, { kind: "page", targetId, parent });
		this.emit(parent, "Target.attachedToTarget", {
			sessionId,
			targetInfo: this.targets.get(targetId),
			waitingForDebugger: true,
		});
		return sessionId;
	}

	private handle(m: CdpMessage): undefined {
		const session = this.sessions.get(m.sessionId);
		const reply = (result: object): undefined => {
			this.listeners.deliver({ id: m.id, result, ...(m.sessionId ? { sessionId: m.sessionId } : {}) });
		};
		const p = (m.params ?? {}) as Record<string, unknown>;
		if (!session) {
			this.listeners.deliver({ id: m.id, error: { code: -32001, message: "Session not found" } });
			return;
		}
		switch (m.method) {
			case "Target.attachToBrowserTarget": {
				const sessionId = `B${++this.n}`;
				this.sessions.set(sessionId, { kind: "browser", discover: false, autoAttach: false });
				return reply({ sessionId });
			}
			case "Target.setDiscoverTargets":
				if (session.kind === "browser") {
					session.discover = p.discover === true;
					if (session.discover)
						for (const t of this.targets.values()) this.emit(m.sessionId, "Target.targetCreated", { targetInfo: t });
				}
				return reply({});
			case "Target.setAutoAttach":
				if (session.kind === "browser") {
					session.autoAttach = p.autoAttach === true;
					if (session.autoAttach) for (const t of this.targets.keys()) this.attach(m.sessionId, t);
				}
				return reply({});
			case "Target.getTargets":
				return reply({ targetInfos: [...this.targets.values()] });
			case "Target.createTarget":
				return reply({ targetId: this.create(String(p.url)) });
			case "Target.attachToTarget":
				return reply({ sessionId: this.attach(m.sessionId, String(p.targetId)) });
			case "Target.detachFromTarget": {
				const child = this.sessions.get(String(p.sessionId));
				this.sessions.delete(String(p.sessionId));
				if (child?.kind === "page")
					this.emit(m.sessionId, "Target.detachedFromTarget", { sessionId: p.sessionId, targetId: child.targetId });
				return reply({});
			}
			case "Target.closeTarget": {
				const targetId = String(p.targetId);
				this.targets.delete(targetId);
				for (const [id, s] of [...this.sessions]) {
					if (s.kind === "page" && s.targetId === targetId) {
						this.sessions.delete(id);
						this.emit(s.parent, "Target.detachedFromTarget", { sessionId: id, targetId });
					}
				}
				for (const [id, s] of this.sessions)
					if (s.kind === "browser" && s.discover) this.emit(id, "Target.targetDestroyed", { targetId });
				return reply({ success: true });
			}
			case "Browser.getVersion":
				return reply({ product: "Chrome/1.0", protocolVersion: "1.3", userAgent: "fake", jsVersion: "1" });
			default:
				return reply({});
		}
	}
}

/** A conversation's WebSocket: what it was sent, and whether it was closed. */
class Client implements ProxySocket {
	readonly got: CdpMessage[] = [];
	closed: { code?: number; reason?: string } | null = null;
	private n = 0;
	conn!: { message(text: string): void };
	send(text: string): void {
		this.got.push(JSON.parse(text) as CdpMessage);
	}
	close(code?: number, reason?: string): void {
		this.closed = { code, reason };
	}
	/** Sends a command and waits for its answer. */
	async call(method: string, params: object = {}, sessionId?: string): Promise<CdpMessage> {
		const id = ++this.n;
		this.conn.message(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
		for (let i = 0; i < 500; i++) {
			const answer = this.got.find((m) => m.id === id);
			if (answer) return answer;
			await Bun.sleep(1);
		}
		throw new Error(`no answer to ${method}`);
	}
	events(method: string): CdpMessage[] {
		return this.got.filter((m) => m.method === method);
	}
}

let worlds = 0;
async function world() {
	const file = join(work, `owners-${++worlds}.json`);
	const registry = new PageRegistry(file);
	const browser = new FakeBrowser();
	const host = new EngineHost(registry, async () => ({ transport: browser, generation: "gen-1", fresh: true }));
	const proxy = new CdpProxy(host, registry);
	const connect = (owner: string) => {
		const client = new Client();
		client.conn = proxy.connect(owner, client);
		return client;
	};
	return { file, registry, browser, host, proxy, connect };
}

const targetIds = (m: CdpMessage) =>
	((m.result as { targetInfos: TargetInfo[] }).targetInfos ?? []).map((t) => t.targetId).sort();

test("a conversation hears of, lists and attaches to its own pages only", async () => {
	const { registry, connect } = await world();
	const a = connect("/s/a.jsonl");
	const b = connect("/s/b.jsonl");
	await a.call("Target.setDiscoverTargets", { discover: true });
	await b.call("Target.setDiscoverTargets", { discover: true });
	const [pageA] = registry.pagesOf("/s/a.jsonl");
	const [pageB] = registry.pagesOf("/s/b.jsonl");
	expect(pageA).toBeDefined();
	expect(pageB).toBeDefined();
	expect(
		a.events("Target.targetCreated").map((e) => (e.params as { targetInfo: TargetInfo }).targetInfo.targetId),
	).toEqual([pageA]);
	expect(targetIds(await a.call("Target.getTargets"))).toEqual([pageA]);
	expect(targetIds(await b.call("Target.getTargets"))).toEqual([pageB]);

	await a.call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
	const attached = a
		.events("Target.attachedToTarget")
		.map((e) => (e.params as { targetInfo: TargetInfo }).targetInfo.targetId);
	expect(attached).toEqual([pageA]);
});

test("a command naming another conversation's page or session is refused", async () => {
	const { registry, connect } = await world();
	const a = connect("/s/a.jsonl");
	const b = connect("/s/b.jsonl");
	await b.call("Target.getTargets");
	await a.call("Target.getTargets");
	const [pageB] = registry.pagesOf("/s/b.jsonl");
	for (const method of ["Target.attachToTarget", "Target.closeTarget", "Target.activateTarget"]) {
		const answer = await a.call(method, { targetId: pageB, flatten: true });
		expect(answer.error).toEqual({ code: -32000, message: NOT_THIS_CONVERSATION });
	}
	const own = await b.call("Target.attachToTarget", { targetId: pageB, flatten: true });
	const sessionB = (own.result as { sessionId: string }).sessionId;
	expect((await a.call("Runtime.evaluate", { expression: "1" }, sessionB)).error?.message).toBe(NOT_THIS_CONVERSATION);
	expect((await a.call("Target.detachFromTarget", { sessionId: sessionB })).error?.message).toBe(NOT_THIS_CONVERSATION);
	expect(registry.pagesOf("/s/b.jsonl")).toEqual([pageB]);
});

test("a page a conversation creates, or its page opens, is that conversation's, and the other never keeps it", async () => {
	const { registry, browser, connect } = await world();
	const a = connect("/s/a.jsonl");
	const b = connect("/s/b.jsonl");
	await a.call("Target.setDiscoverTargets", { discover: true });
	await b.call("Target.setDiscoverTargets", { discover: true });
	await b.call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
	const made = await a.call("Target.createTarget", { url: "https://example.com/" });
	const created = (made.result as { targetId: string }).targetId;
	expect(registry.ownerOfTarget(created)).toBe("/s/a.jsonl");
	const heardA = a
		.events("Target.targetCreated")
		.map((e) => (e.params as { targetInfo: TargetInfo }).targetInfo.targetId);
	expect(heardA).toContain(created);
	// The event came before the answer: it was held until the answer said whose page it is, and arrived first.
	expect(
		a.got.findIndex(
			(m) =>
				m.method === "Target.targetCreated" && (m.params as { targetInfo: TargetInfo }).targetInfo.targetId === created,
		),
	).toBeLessThan(a.got.indexOf(made));
	const heardB = b.got.filter((m) => JSON.stringify(m.params ?? {}).includes(created));
	expect(heardB).toEqual([]);
	// B's browser session was auto-attached to A's pages (the blank one, the new one): each let go at once, resumed first.
	await Bun.sleep(5);
	const heldOnA = [...browser.sessions.values()].filter(
		(s) => s.kind === "page" && registry.ownerOfTarget(s.targetId) === "/s/a.jsonl",
	);
	expect(heldOnA).toEqual([]);
	const released = browser.log.filter(
		(l) => l.method === "Runtime.runIfWaitingForDebugger" || l.method === "Target.detachFromTarget",
	);
	expect(released.map((l) => l.method)).toEqual([
		"Runtime.runIfWaitingForDebugger",
		"Target.detachFromTarget",
		"Runtime.runIfWaitingForDebugger",
		"Target.detachFromTarget",
	]);

	const popup = browser.open(created);
	await Bun.sleep(5);
	expect(registry.ownerOfTarget(popup)).toBe("/s/a.jsonl");
	expect(targetIds(await a.call("Target.getTargets"))).toContain(popup);
	expect(targetIds(await b.call("Target.getTargets"))).not.toContain(popup);
});

test("a conversation with no page gets a blank one before its first answer", async () => {
	const { registry, connect } = await world();
	const c = connect("/s/c.jsonl");
	const answer = await c.call("Target.getTargets");
	const pages = registry.pagesOf("/s/c.jsonl");
	expect(pages).toHaveLength(1);
	expect(targetIds(answer)).toEqual(pages);
});

test("Browser.close ends the connection, not the browser", async () => {
	const { browser, connect, registry } = await world();
	const a = connect("/s/a.jsonl");
	await a.call("Target.getTargets");
	const answer = await a.call("Browser.close");
	expect(answer.result).toEqual({});
	expect(a.closed?.code).toBe(1000);
	expect(browser.log.some((l) => l.method === "Browser.close")).toBe(false);
	expect(registry.pagesOf("/s/a.jsonl")).toHaveLength(1);
});

test("owners.json keeps tokens and owners for the same engine, and only tokens for a new one", async () => {
	const { file, registry, connect } = await world();
	const tokenA = registry.tokenFor("/s/a.jsonl");
	const a = connect("/s/a.jsonl");
	await a.call("Target.getTargets");
	const [pageA] = registry.pagesOf("/s/a.jsonl");

	const sameEngine = new PageRegistry(file);
	sameEngine.load("gen-1");
	expect(sameEngine.tokenFor("/s/a.jsonl")).toBe(tokenA);
	expect(sameEngine.ownerOf(tokenA)).toBe("/s/a.jsonl");
	expect(sameEngine.ownerOfTarget(pageA)).toBe("/s/a.jsonl");

	const newEngine = new PageRegistry(file);
	newEngine.load("gen-2");
	expect(newEngine.tokenFor("/s/a.jsonl")).toBe(tokenA);
	expect(newEngine.ownerOfTarget(pageA)).toBeNull();
});

test("a moved session file keeps its pages and token; a closed conversation's pages are closed and its token forgotten", async () => {
	const { registry, browser, connect } = await world();
	const token = registry.tokenFor("/s/a.jsonl");
	const a = connect("/s/a.jsonl");
	await a.call("Target.getTargets");
	const [page] = registry.pagesOf("/s/a.jsonl");
	registry.rekey("/s/a.jsonl", "/moved/a.jsonl");
	expect(registry.ownerOf(token)).toBe("/moved/a.jsonl");
	expect(registry.pagesOf("/moved/a.jsonl")).toEqual([page]);
	expect(registry.pagesOf("/s/a.jsonl")).toEqual([]);

	await registry.closeOwner("/moved/a.jsonl");
	expect(registry.ownerOf(token)).toBeNull();
	expect(browser.targets.has(page)).toBe(false);
});
