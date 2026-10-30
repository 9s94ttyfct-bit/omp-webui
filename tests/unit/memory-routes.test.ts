import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type MemorySettings, parseSettings } from "../../server/memory/config.ts";
import { MemoryService, parseQuery } from "../../server/memory/routes.ts";
import {
	MEMORY_CONTENT_MAX,
	type MemoryChanged,
	type MemoryDetail,
	type MemoryList,
	type MemoryOverview,
} from "../../shared/memory.ts";
import { type MemoryFixture, memoryFixture } from "../support/mnemopi-store.ts";

/**
 * `/api/memory*` with no omp: the routes' answers, what they refuse and with which code, and that a change made on a
 * memory that is not as the page read it is turned away. The store they work on is `memory-store.test.ts`'s.
 */

const NOW = new Date("2026-10-23T12:00:00.000Z");

function seeded(): MemoryFixture {
	const fx = memoryFixture();
	fx.bank("default", {
		working: [
			{ id: "g1", content: "Prefers tabs.", source: "coding-agent-learn", timestamp: "2026-10-12T09:00:00.000Z" },
			{ id: "g2", content: "a turn", source: "coding-agent-transcript", timestamp: "2026-10-11T09:00:00.000Z" },
		],
		episodic: [
			{ id: "gE1", content: "Prefers tabs. (consolidated)", summaryOf: "g1", timestamp: "2026-10-13T09:00:00.000Z" },
		],
	}).close();
	fx.bank("app-abc123", {
		working: [
			{
				id: "p1",
				content: "Build with bun.",
				timestamp: "2026-10-14T09:00:00.000Z",
				metadata: { cwd: "/work/app", session_id: "s1" },
			},
		],
	}).close();
	fx.bank("ompw-context-x1", { working: [{ id: "s1", content: "scratch" }] }).close();
	fx.bank("empty-1").close();
	return fx;
}

function service(fx: MemoryFixture, settings: Partial<MemorySettings> = {}) {
	const resolved: MemorySettings = {
		backend: "mnemopi",
		scoping: "per-project-tagged",
		dbPath: null,
		relativePath: false,
		bank: null,
		...settings,
	};
	return new MemoryService({
		agentDir: fx.agentDir,
		dataDir: fx.dataDir,
		settings: { get: async () => resolved },
		clock: () => NOW,
	});
}

interface Answer<T> {
	status: number;
	body: T & { error?: string; code?: string };
}
async function ask<T = unknown>(svc: MemoryService, method: string, path: string, body?: unknown): Promise<Answer<T>> {
	const url = new URL(`http://127.0.0.1${path}`);
	const init: RequestInit = { method };
	if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
	const res = await svc.handle(new Request(url, init), url);
	return { status: res.status, body: (await res.json()) as Answer<T>["body"] };
}
const get = <T>(svc: MemoryService, path: string) => ask<T>(svc, "GET", path);
const post = <T>(svc: MemoryService, path: string, body: unknown) => ask<T>(svc, "POST", path, body);
const detail = async (svc: MemoryService, bank: string, id: string): Promise<MemoryDetail> =>
	(await get<{ item: MemoryDetail }>(svc, `/api/memory/item?bank=${bank}&id=${id}`)).body.item;

describe("the overview", () => {
	test("says how omp is set, which banks there are (scratch and empty ones are not shown), and whether a global memory can be added", async () => {
		const fx = seeded();
		const { status, body } = await get<MemoryOverview>(service(fx), "/api/memory");
		expect(status).toBe(200);
		expect(body).toMatchObject({
			backend: "mnemopi",
			scoping: "per-project-tagged",
			settingsKnown: true,
			present: true,
			dbPath: fx.layout.sharedDb,
			unsupported: null,
			hiddenBanks: 2,
			canAddGlobal: true,
		});
		expect(body.banks.map((b) => [b.bank, b.scope, b.label, b.working, b.episodic])).toEqual([
			["default", "global", "default", 2, 1],
			["app-abc123", "project", "app", 1, 0],
		]);
	});

	test("with per-project scoping there is no memory every project recalls, so none can be added to it", async () => {
		const fx = seeded();
		const svc = service(fx, { scoping: "per-project" });
		expect((await get<MemoryOverview>(svc, "/api/memory")).body.canAddGlobal).toBe(false);
		const refused = await post(svc, "/api/memory/add", { scope: "global", content: "x" });
		expect(refused).toMatchObject({ status: 409, body: { code: "noGlobal" } });
		// The global memories are still listed: omp keeps what it wrote before the scoping was changed.
		expect((await get<MemoryList>(svc, "/api/memory/items?scope=global")).body.total).toBe(3);
	});

	test("a store omp has never written says so; one at a relative mnemopi.dbPath is not shown at all", async () => {
		const fx = memoryFixture();
		const none = (await get<MemoryOverview>(service(fx), "/api/memory")).body;
		expect(none).toMatchObject({ present: false, banks: [], canAddGlobal: false });
		const relative = (await get<MemoryOverview>(service(fx, { relativePath: true }), "/api/memory")).body;
		expect(relative.unsupported).toBe("relativePath");
		// Asking never makes the store.
		expect(existsSync(fx.layout.sharedDb)).toBe(false);
		expect(existsSync(join(fx.agentDir, "memories"))).toBe(false);
	});

	test("when omp cannot be asked, the page shows what is there and says it does not know the settings", async () => {
		const fx = seeded();
		const svc = new MemoryService({
			agentDir: fx.agentDir,
			dataDir: fx.dataDir,
			settings: { get: async () => null },
			clock: () => NOW,
		});
		const { body } = await get<MemoryOverview>(svc, "/api/memory");
		// The banks are the ones under omp's agent directory; omp may keep them elsewhere (`mnemopi.dbPath`), so the page
		// says the settings are unknown rather than presenting that guess as omp's store.
		expect(body).toMatchObject({ backend: null, scoping: null, settingsKnown: false, present: true });
		expect(body.banks).toHaveLength(2);
	});
});

describe("the list", () => {
	test("is asked for by its query, which a page cannot make mean anything else", () => {
		const q = (s: string) => parseQuery(new URLSearchParams(s));
		expect(q("")).toEqual({
			q: "",
			scope: "all",
			bank: "",
			kinds: ["note", "conversation", "consolidated"],
			retired: "active",
			limit: 50,
			offset: 0,
		});
		expect(q("q=%20tabs%20&scope=global&kinds=note,conversation&retired=all&limit=10&offset=20")).toEqual({
			q: "tabs",
			scope: "global",
			bank: "",
			kinds: ["note", "conversation"],
			retired: "all",
			limit: 10,
			offset: 20,
		});
		// What is not a value is the default, not an error and not a wider list.
		expect(q("scope=x&kinds=a,b&retired=x&limit=-1&offset=-5&bank=../x")).toMatchObject({
			scope: "all",
			kinds: [],
			retired: "active",
			limit: 50,
			offset: 0,
			bank: "",
		});
		expect(q("limit=100000").limit).toBe(200);
		expect(q("limit=abc").limit).toBe(50);
		expect(q(`q=${"a".repeat(500)}`).q).toHaveLength(200);
		expect(q("kinds=").kinds).toEqual([]);
	});

	test("answers with the page, the total and the counts of each kind", async () => {
		const fx = seeded();
		const { status, body } = await get<MemoryList>(service(fx), "/api/memory/items?kinds=note&limit=1");
		expect(status).toBe(200);
		expect(body.items.map((i) => i.id)).toEqual(["p1"]);
		expect(body).toMatchObject({ total: 2, counts: { note: 2, conversation: 1, consolidated: 1 }, unreadable: [] });
		expect((await get<MemoryList>(service(fx), "/api/memory/items?q=bun")).body.items.map((i) => i.id)).toEqual(["p1"]);
	});

	test("one memory in full; one that is not there, or a bank or id that is not omp's, is a 404 or a 400, never a path", async () => {
		const fx = seeded();
		const svc = service(fx);
		const ok = await get<{ item: MemoryDetail }>(svc, "/api/memory/item?bank=app-abc123&id=p1");
		expect(ok.status).toBe(200);
		expect(ok.body.item).toMatchObject({
			id: "p1",
			content: "Build with bun.",
			provenance: { cwd: "/work/app", sessionId: "s1" },
		});
		expect(await get(svc, "/api/memory/item?bank=app-abc123&id=nope")).toMatchObject({
			status: 404,
			body: { code: "notFound" },
		});
		expect(await get(svc, "/api/memory/item?bank=nope&id=p1")).toMatchObject({
			status: 404,
			body: { code: "notFound" },
		});
		expect(await get(svc, "/api/memory/item?bank=../agent&id=p1")).toMatchObject({
			status: 404,
			body: { code: "notFound" },
		});
		expect(await get(svc, "/api/memory/item?bank=ompw-context-x1&id=s1")).toMatchObject({ status: 404 });
		expect(await get(svc, "/api/memory/item?bank=default&id=../x")).toMatchObject({
			status: 400,
			body: { code: "badRequest" },
		});
		expect(await get(svc, "/api/memory/item?bank=default")).toMatchObject({ status: 400 });
	});

	test("an unknown path, a method that is none, a body that is not JSON, one that is too large", async () => {
		const fx = seeded();
		const svc = service(fx);
		expect((await get(svc, "/api/memory/nothing")).status).toBe(404);
		expect((await ask(svc, "POST", "/api/memory/nothing", {})).status).toBe(404);
		expect((await ask(svc, "PUT", "/api/memory/add", {})).status).toBe(405);
		expect(await ask(svc, "POST", "/api/memory/add", "not json")).toMatchObject({
			status: 400,
			body: { code: "badRequest" },
		});
		expect(await ask(svc, "POST", "/api/memory/add", "[1]")).toMatchObject({ status: 400 });
		const url = new URL("http://127.0.0.1/api/memory/add");
		const big = await svc.handle(
			new Request(url, { method: "POST", headers: { "content-length": String(10_000_000) }, body: "{}" }),
			url,
		);
		expect(big.status).toBe(413);
	});
});

describe("adding", () => {
	test("a global memory goes to the shared bank, a project's to the bank it names; both are read back", async () => {
		const fx = seeded();
		const svc = service(fx);
		const global = await post<MemoryChanged>(svc, "/api/memory/add", {
			scope: "global",
			content: "  Answer in Chinese.  ",
			importance: 0.9,
			context: "  from the page ",
		});
		expect(global.status).toBe(200);
		expect(global.body.item).toMatchObject({
			bank: "default",
			scope: "global",
			store: "working",
			kind: "note",
			content: "Answer in Chinese.",
			importance: 0.9,
			editable: true,
			provenance: { origin: "web", context: "from the page", cwd: null },
		});
		expect(global.body.backedUp).toBe(true);
		const project = await post<MemoryChanged>(svc, "/api/memory/add", {
			scope: "project",
			bank: "app-abc123",
			content: "Use pnpm.",
		});
		expect(project.body.item).toMatchObject({
			bank: "app-abc123",
			scope: "project",
			importance: 0.75,
			provenance: { cwd: "/work/app" },
		});
		// Both are in the list, at its top: they are the newest (the clock is the day they were added on).
		const list = await get<MemoryList>(svc, "/api/memory/items?kinds=note");
		expect(new Set(list.body.items.slice(0, 2).map((i) => i.id))).toEqual(
			new Set([global.body.item.id, project.body.item.id]),
		);
		expect(list.body.items.map((i) => i.id)).toContain(global.body.item.id);
		expect(list.body.items.map((i) => i.id)).toContain(project.body.item.id);
	});

	test("what is not a memory is refused with a code and nothing is written", async () => {
		const fx = seeded();
		const svc = service(fx);
		const add = (body: unknown) => post(svc, "/api/memory/add", body);
		expect(await add({ content: "x" })).toMatchObject({ status: 400, body: { code: "badRequest" } });
		expect(await add({ scope: "universe", content: "x" })).toMatchObject({ status: 400 });
		expect(await add({ scope: "global" })).toMatchObject({ status: 400 });
		expect(await add({ scope: "global", content: 7 })).toMatchObject({ status: 400 });
		expect(await add({ scope: "global", content: "  \n " })).toMatchObject({ status: 400 });
		expect(await add({ scope: "global", content: "x", importance: "high" })).toMatchObject({ status: 400 });
		expect(await add({ scope: "global", content: "x", importance: Number.NaN })).toMatchObject({ status: 400 });
		expect(await add({ scope: "global", content: "x".repeat(MEMORY_CONTENT_MAX + 1) })).toMatchObject({
			status: 413,
			body: { code: "tooLong" },
		});
		expect(await add({ scope: "project", content: "x" })).toMatchObject({ status: 404, body: { code: "notFound" } });
		expect(await add({ scope: "project", bank: "nope-1", content: "x" })).toMatchObject({ status: 404 });
		expect(await add({ scope: "project", bank: "../default", content: "x" })).toMatchObject({ status: 404 });
		// The shared bank is not "a project".
		expect(await add({ scope: "project", bank: "default", content: "x" })).toMatchObject({ status: 400 });
		expect((await get<MemoryList>(svc, "/api/memory/items")).body.total).toBe(4);
		expect(existsSync(join(fx.dataDir, "memory-backups"))).toBe(false);
		// An importance outside 0..1 is brought into it, as omp's own is.
		const high = await add({ scope: "global", content: "clamped", importance: 7 });
		expect((high.body as MemoryChanged).item.importance).toBe(1);
	});
});

describe("changing", () => {
	test("a rewrite needs the etag of the memory as it was read, and answers with the memory as it is", async () => {
		const fx = seeded();
		const svc = service(fx);
		const before = await detail(svc, "app-abc123", "p1");
		const res = await post<MemoryChanged>(svc, "/api/memory/update", {
			bank: "app-abc123",
			id: "p1",
			etag: before.etag,
			content: "Build with bun 1.4.",
			importance: 0.3,
		});
		expect(res.status).toBe(200);
		expect(res.body.item).toMatchObject({ content: "Build with bun 1.4.", importance: 0.3 });
		expect(res.body.item.etag).not.toBe(before.etag);
		expect(res.body.backedUp).toBe(true);
		// The same etag again is a change made on what is no longer there.
		expect(
			await post(svc, "/api/memory/update", { bank: "app-abc123", id: "p1", etag: before.etag, content: "again" }),
		).toMatchObject({ status: 409, body: { code: "stale" } });
		expect((await detail(svc, "app-abc123", "p1")).content).toBe("Build with bun 1.4.");
	});

	test("what changes nothing writes nothing; what is not allowed says why", async () => {
		const fx = seeded();
		const svc = service(fx);
		const p1 = await detail(svc, "app-abc123", "p1");
		const same = await post<MemoryChanged>(svc, "/api/memory/update", {
			bank: "app-abc123",
			id: "p1",
			etag: p1.etag,
			content: p1.content,
			importance: p1.importance,
		});
		expect(same).toMatchObject({ status: 200, body: { backedUp: false } });
		expect(existsSync(join(fx.dataDir, "memory-backups"))).toBe(false);
		const update = (body: Record<string, unknown>) =>
			post(svc, "/api/memory/update", { bank: "app-abc123", id: "p1", etag: p1.etag, ...body });
		expect(await update({})).toMatchObject({ status: 400, body: { code: "badRequest" } });
		expect(await update({ content: "   " })).toMatchObject({ status: 400 });
		expect(await update({ content: 5 })).toMatchObject({ status: 413 });
		expect(await update({ importance: "x" })).toMatchObject({ status: 400 });
		expect(await post(svc, "/api/memory/update", { bank: "app-abc123", id: "p1", content: "x" })).toMatchObject({
			status: 400,
			body: { code: "badRequest" },
		});
		expect(
			await post(svc, "/api/memory/update", { bank: "app-abc123", id: "nope", etag: "0123456789abcdef", content: "x" }),
		).toMatchObject({ status: 404 });
		const consolidated = await detail(svc, "default", "gE1");
		expect(
			await post(svc, "/api/memory/update", { bank: "default", id: "gE1", etag: consolidated.etag, content: "x" }),
		).toMatchObject({ status: 409, body: { code: "notEditable" } });
		expect(
			await post(svc, "/api/memory/delete", { bank: "default", id: "gE1", etag: consolidated.etag }),
		).toMatchObject({ status: 409, body: { code: "notEditable" } });
		expect((await detail(svc, "app-abc123", "p1")).content).toBe("Build with bun.");
	});

	test("retire and restore are the same change twice: asking for what already is does nothing", async () => {
		const fx = seeded();
		const svc = service(fx);
		const at = (path: string, etag?: string) =>
			post<MemoryChanged>(svc, path, { bank: "default", id: "gE1", ...(etag ? { etag } : {}) });
		const open = await detail(svc, "default", "gE1");
		expect((await at("/api/memory/restore")).body).toMatchObject({ backedUp: false });
		const retired = await at("/api/memory/retire", open.etag);
		expect(retired.status).toBe(200);
		expect(retired.body.item).toMatchObject({ retired: true, validUntil: NOW.toISOString() });
		expect((await at("/api/memory/retire")).body.backedUp).toBe(false);
		expect(await at("/api/memory/retire", open.etag)).toMatchObject({ status: 409, body: { code: "stale" } });
		const back = await at("/api/memory/restore", retired.body.item.etag);
		expect(back.body.item).toMatchObject({ retired: false, validUntil: null });
		expect((await get<MemoryList>(svc, "/api/memory/items?kinds=consolidated")).body.total).toBe(1);
	});

	test("a deletion needs the etag, takes the memory away, and asks again for nothing", async () => {
		const fx = seeded();
		const svc = service(fx);
		const g2 = await detail(svc, "default", "g2");
		expect(await post(svc, "/api/memory/delete", { bank: "default", id: "g2" })).toMatchObject({ status: 400 });
		expect(
			await post(svc, "/api/memory/delete", { bank: "default", id: "g2", etag: "0000000000000000" }),
		).toMatchObject({ status: 409, body: { code: "stale" } });
		const done = await post(svc, "/api/memory/delete", { bank: "default", id: "g2", etag: g2.etag });
		expect(done).toMatchObject({ status: 200, body: { deleted: true, backedUp: true } });
		expect((await get(svc, "/api/memory/item?bank=default&id=g2")).status).toBe(404);
		expect(await post(svc, "/api/memory/delete", { bank: "default", id: "g2", etag: g2.etag })).toMatchObject({
			status: 404,
			body: { code: "notFound" },
		});
		expect((await get<MemoryOverview>(svc, "/api/memory")).body.banks[0]).toMatchObject({ working: 1 });
	});
});

describe("omp's settings", () => {
	test("are read from `omp config list --json`: the backend, the scoping, a moved store and the shared bank's base name", () => {
		const doc = {
			"memory.backend": { value: "mnemopi", type: "enum", description: "" },
			"mnemopi.scoping": { value: "per-project-tagged", type: "enum", description: "" },
			"mnemopi.dbPath": { type: "string", description: "" },
			"mnemopi.bank": { type: "string", description: "" },
		};
		expect(parseSettings(doc)).toEqual({
			backend: "mnemopi",
			scoping: "per-project-tagged",
			dbPath: null,
			relativePath: false,
			bank: null,
		});
		expect(
			parseSettings({
				...doc,
				"mnemopi.dbPath": { value: "/data/mem/mnemopi.db" },
				"mnemopi.bank": { value: " work " },
			}),
		).toMatchObject({ dbPath: "/data/mem/mnemopi.db", bank: "work" });
		expect(parseSettings({ ...doc, "mnemopi.dbPath": { value: "~/mem/mnemopi.db" } })?.dbPath).toBe(
			join(homedir(), "mem", "mnemopi.db"),
		);
		expect(parseSettings({ ...doc, "mnemopi.dbPath": { value: "mem/mnemopi.db" } })).toMatchObject({
			dbPath: null,
			relativePath: true,
		});
		expect(parseSettings({ ...doc, "mnemopi.dbPath": { value: "  " } })).toMatchObject({
			dbPath: null,
			relativePath: false,
		});
		expect(parseSettings({})).toEqual({ backend: null, scoping: null, dbPath: null, relativePath: false, bank: null });
		expect(parseSettings(null)).toBeNull();
		expect(parseSettings([])).toBeNull();
	});
});

describe("when omp's settings cannot be read", () => {
	test("nothing is written (a guess at the store could write to the wrong one), and reading still works", async () => {
		const fx = seeded();
		const blind = new MemoryService({
			agentDir: fx.agentDir,
			dataDir: fx.dataDir,
			settings: { get: async () => null },
			clock: () => NOW,
		});
		const post = (path: string, body: unknown) =>
			blind.handle(
				new Request(`http://x${path}`, { method: "POST", body: JSON.stringify(body) }),
				new URL(`http://x${path}`),
			);
		for (const [path, body] of [
			["/api/memory/add", { scope: "global", content: "x" }],
			["/api/memory/update", { bank: "default", id: "g1", etag: "e", content: "y" }],
			["/api/memory/retire", { bank: "default", id: "g1" }],
			["/api/memory/delete", { bank: "default", id: "g1", etag: "e" }],
		] as const) {
			const res = await post(path, body);
			expect(res.status, path).toBe(503);
			expect(((await res.json()) as { code: string }).code).toBe("settings");
		}
		expect((await blind.handle(new Request("http://x/api/memory"), new URL("http://x/api/memory"))).status).toBe(200);
	});
});
