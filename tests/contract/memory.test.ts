import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layoutOf } from "../../server/memory/store.ts";
import {
	MEMORY_CONTENT_MAX,
	type MemoryChanged,
	type MemoryDeleted,
	type MemoryDetail,
	type MemoryList,
	type MemoryOverview,
} from "../../shared/memory.ts";
import { type AccessKey, type Jwks, makeKey, startJwks } from "../support/access-jwt.ts";
import { lanAddress, rawRequest } from "../support/lan-peer.ts";
import { createDb, insertDerived, insertEpisodic, insertWorking } from "../support/mnemopi-store.ts";
import { remoteClient, remoteSettings } from "../support/remote-client.ts";
import { startTestServer, type TestServer } from "../support/server.ts";

/**
 * `/api/memory*` on the real server (and the real omp it asks for `memory.backend` and `mnemopi.scoping`), against a store
 * of the tables omp 18.12.6 makes, written into the agent directory of this test's own server: an isolated HOME in the temp
 * folder, never a real `~/.omp`. The routes are for a page on this computer: a page that came through the tunnel is refused
 * all of them, and the store is what it was. No model is called, and no omp conversation is running: what omp recalls of
 * a change is not tested here (that needs a live Mnemopi session).
 */

const root = mkdtempSync(join(tmpdir(), "ompw-memory-contract-"));
const settingsFile = join(root, "remote.json");
const dist = join(root, "dist");
let s: TestServer;
let key: AccessKey;
let jwks: Jwks;

const APP = "app-1a2b3c";
const ODD = "odd-4d5e6f";
const SCRATCH = "ompw-offline-x1";

const dbPath = (bank: string) => {
	const layout = layoutOf(s.agentDir, null, null);
	return bank === "default" ? layout.sharedDb : join(layout.banksDir, bank, "mnemopi.db");
};
const dataDir = () => join(s.root, "data");
const configFile = () => join(s.agentDir, "config.yml");

const authed = (extra: Record<string, string> = {}) => ({
	"x-omp-webui-token": s.accessToken,
	"x-omp-webui": "1",
	...extra,
});

/** A request as the page on this computer makes it. */
async function call<T = unknown>(
	path: string,
	body?: Record<string, unknown>,
): Promise<{ status: number; body: T & { error?: string; code?: string } }> {
	const res = await fetch(`${s.url}${path}`, {
		method: body ? "POST" : "GET",
		headers: body ? authed({ "content-type": "application/json" }) : authed(),
		body: body ? JSON.stringify(body) : undefined,
	});
	return { status: res.status, body: (await res.json()) as T & { error?: string; code?: string } };
}

const item = async (bank: string, id: string): Promise<MemoryDetail> =>
	(await call<{ item: MemoryDetail }>(`/api/memory/item?bank=${bank}&id=${id}`)).body.item;

const read = <T>(bank: string, sql: string, ...params: string[]): T[] => {
	const db = new Database(dbPath(bank), { readonly: true });
	try {
		return db.query<T, string[]>(sql).all(...params);
	} finally {
		db.close();
	}
};
const content = (bank: string, id: string): string | null =>
	read<{ content: string }>(bank, "SELECT content FROM working_memory WHERE id = ?", id)[0]?.content ?? null;
const digest = (bank: string): string =>
	createHash("sha256")
		.update(readFileSync(dbPath(bank)))
		.digest("hex");

/** Every memory this test's store holds, in a form that says whether anything changed. */
const snapshot = (): string =>
	JSON.stringify(
		["default", APP, ODD].map((bank) => [
			bank,
			read(bank, "SELECT id, content, importance, valid_until, superseded_by FROM working_memory ORDER BY id"),
			read(bank, "SELECT id, valid_until FROM episodic_memory ORDER BY id"),
		]),
	);

beforeAll(async () => {
	key = await makeKey("kid-1");
	jwks = await startJwks([key]);
	mkdirSync(join(dist, "assets"), { recursive: true });
	writeFileSync(
		join(dist, "index.html"),
		'<!doctype html>\n<html><head></head><body><div id="root"></div></body></html>\n',
	);
	writeFileSync(settingsFile, JSON.stringify(remoteSettings()));
	s = await startTestServer(
		0,
		{ OMP_WEBUI_REMOTE_CONFIG: settingsFile, OMP_WEBUI_ACCESS_CERTS_URL: jwks.url, OMP_WEBUI_DIST: dist },
		{ login: false },
	);
	// omp's own settings, which the server asks the real omp for: the store is used, and one shared bank serves every project.
	writeFileSync(
		configFile(),
		`${readFileSync(configFile(), "utf8")}memory:\n  backend: mnemopi\nmnemopi:\n  scoping: global\n`,
	);

	const shared = createDb(dbPath("default"));
	insertWorking(shared, "default", {
		id: "g1",
		content: "Prefers tabs over spaces in every project.",
		source: "coding-agent-learn",
		timestamp: "2026-10-12T09:00:00.000Z",
		metadata: { session_id: "sess-g1", cwd: "/work/app", context: "Said so in the review", tool: "learn" },
		embedded: true,
	});
	insertWorking(shared, "default", {
		id: "g2",
		content: "user: rename the module\nassistant: done",
		source: "coding-agent-transcript",
		timestamp: "2026-10-11T09:00:00.000Z",
	});
	insertWorking(shared, "default", {
		id: "g3",
		content: "Third memory, to delete.",
		timestamp: "2026-10-10T09:00:00.000Z",
	});
	insertDerived(shared, "g3");
	for (let i = 0; i < 8; i++) {
		insertWorking(shared, "default", {
			id: `n${i}`,
			content: `Numbered note ${i}.`,
			timestamp: `2026-10-0${i + 1}T09:00:00.000Z`,
		});
	}
	insertEpisodic(shared, "default", {
		id: "gE1",
		content: "Prefers tabs. (consolidated)",
		summaryOf: "g1",
		timestamp: "2026-10-13T09:00:00.000Z",
	});
	shared.close();

	const app = createDb(dbPath(APP));
	insertWorking(app, APP, {
		id: "p1",
		content: "The build needs bun 1.4.",
		timestamp: "2026-10-14T09:00:00.000Z",
		metadata: { cwd: "/work/app" },
	});
	insertWorking(app, APP, {
		id: "p2",
		content: "Old advice about webpack.",
		timestamp: "2026-10-09T09:00:00.000Z",
		validUntil: "2026-10-10T00:00:00.000Z",
	});
	app.close();

	// A layout of someone else's: the trigger that keeps omp's search index in step is not there.
	const odd = createDb(dbPath(ODD));
	insertWorking(odd, ODD, {
		id: "o1",
		content: "In a layout this page does not change.",
		metadata: { cwd: "/work/odd" },
	});
	odd.exec("DROP TRIGGER wm_au");
	odd.close();

	createDb(dbPath(SCRATCH)).close();
}, 120_000);

afterAll(async () => {
	await s?.stop();
	jwks?.stop();
	rmSync(root, { recursive: true, force: true });
});

describe("what the page is told of omp and its store", () => {
	test("omp's own settings come from the real omp, and the store's banks are named by their folders", async () => {
		const { status, body } = await call<MemoryOverview>("/api/memory");
		expect(status).toBe(200);
		expect(body).toMatchObject({
			backend: "mnemopi",
			scoping: "global",
			present: true,
			unsupported: null,
			canAddGlobal: true,
		});
		// The server names the store by its real path (the temp folder is a link on macOS).
		expect(realpathSync(body.dbPath)).toBe(realpathSync(dbPath("default")));
		expect(body.banks.map((b) => [b.bank, b.scope, b.label])).toEqual([
			["default", "global", "default"],
			[APP, "project", "app"],
			[ODD, "project", "odd"],
		]);
		// The scratch bank of this app's own helper conversations is not a memory, and is counted as hidden.
		expect(body.hiddenBanks).toBe(1);
		expect(body.banks.find((b) => b.bank === ODD)?.writeProblem).toContain("wm_au");
		expect(body.banks.find((b) => b.bank === "default")?.writeProblem).toBeNull();
	});

	test("omp's per-project scoping, read again when its config changes, leaves nowhere global to add a memory", async () => {
		const before = readFileSync(configFile(), "utf8");
		writeFileSync(configFile(), before.replace("scoping: global", "scoping: per-project"));
		try {
			const overview = (await call<MemoryOverview>("/api/memory")).body;
			expect(overview).toMatchObject({ scoping: "per-project", canAddGlobal: false });
			const refused = await call("/api/memory/add", { scope: "global", content: "Nowhere to put this." });
			expect(refused).toMatchObject({ status: 409, body: { code: "noGlobal" } });
			expect(content("default", "g1")).not.toBeNull();
			expect(read("default", "SELECT id FROM working_memory WHERE content = 'Nowhere to put this.'")).toEqual([]);
		} finally {
			writeFileSync(configFile(), before);
		}
		expect((await call<MemoryOverview>("/api/memory")).body.canAddGlobal).toBe(true);
	});
});

describe("reading", () => {
	test("a page of memories, newest first, narrowed by kind, scope, text and the retired switch", async () => {
		const all = (await call<MemoryList>("/api/memory/items?kinds=note,conversation,consolidated")).body;
		expect(all.items.slice(0, 4).map((i) => i.id)).toEqual(["p1", "gE1", "g1", "g2"]);
		expect(all.counts).toMatchObject({ conversation: 1, consolidated: 1 });
		expect(all.unreadable).toEqual([]);

		const notes = (await call<MemoryList>("/api/memory/items?kinds=note&scope=global&limit=3&offset=1")).body;
		expect(notes.items).toHaveLength(3);
		expect(notes.total).toBe(10);
		expect(notes.items.every((i) => i.scope === "global" && i.kind === "note")).toBe(true);

		expect((await call<MemoryList>("/api/memory/items?q=WEBPACK")).body.total).toBe(0);
		const retired = (await call<MemoryList>("/api/memory/items?q=WEBPACK&retired=all")).body;
		expect(retired.items.map((i) => [i.id, i.retired])).toEqual([["p2", true]]);
		expect((await call<MemoryList>(`/api/memory/items?q=review&bank=${APP}`)).body.total).toBe(0);
		// Its reason, which is not in its text.
		expect((await call<MemoryList>("/api/memory/items?q=Said so in the review")).body.items.map((i) => i.id)).toEqual([
			"g1",
		]);
	});

	test("one memory in full, and the refusals for what is not one", async () => {
		const g1 = await item("default", "g1");
		expect(g1).toMatchObject({
			store: "working",
			kind: "note",
			editable: true,
			retirable: true,
			consolidatedInto: ["gE1"],
			provenance: {
				origin: "learn",
				sessionId: "sess-g1",
				cwd: "/work/app",
				context: "Said so in the review",
				tool: "learn",
			},
		});
		expect(g1.etag).toMatch(/^[0-9a-f]{16}$/);
		expect(await item("default", "gE1")).toMatchObject({
			store: "episodic",
			kind: "consolidated",
			editable: false,
			retirable: true,
		});
		expect(await call("/api/memory/item?bank=default&id=nope")).toMatchObject({
			status: 404,
			body: { code: "notFound" },
		});
		expect(await call("/api/memory/item?bank=nope-1&id=g1")).toMatchObject({ status: 404, body: { code: "notFound" } });
		// The scratch bank cannot be named, and a name that is no bank's is not a path.
		expect(await call(`/api/memory/item?bank=${SCRATCH}&id=g1`)).toMatchObject({ status: 404 });
		expect(await call("/api/memory/item?bank=..%2Fx&id=g1")).toMatchObject({ status: 404 });
		expect(await call("/api/memory/item?bank=default&id=..%2Fg1")).toMatchObject({
			status: 400,
			body: { code: "badRequest" },
		});
		expect((await call("/api/memory/other")).status).toBe(404);
		const put = await fetch(`${s.url}/api/memory/items`, { method: "PUT", headers: authed() });
		expect(put.status).toBe(405);
	});
});

describe("who may ask", () => {
	test("a request without the access token is turned away, and one that changes something needs the page's own header", async () => {
		const before = snapshot();
		expect((await fetch(`${s.url}/api/memory`)).status).toBe(401);
		for (const path of ["add", "update", "retire", "restore", "delete"]) {
			const noHeader = await fetch(`${s.url}/api/memory/${path}`, {
				method: "POST",
				headers: { "x-omp-webui-token": s.accessToken, "content-type": "application/json" },
				body: JSON.stringify({ bank: "default", id: "g1", etag: "x", content: "x", scope: "global" }),
			});
			expect(noHeader.status, path).toBe(403);
			const noToken = await fetch(`${s.url}/api/memory/${path}`, {
				method: "POST",
				headers: { "x-omp-webui": "1", "content-type": "application/json" },
				body: JSON.stringify({ bank: "default", id: "g1", etag: "x", content: "x", scope: "global" }),
			});
			expect(noToken.status, path).toBe(401);
		}
		expect(snapshot()).toBe(before);
	});

	test("a page that came in through the tunnel is refused every route, reads and changes alike, and the store is as it was", async () => {
		const before = snapshot();
		const phone = remoteClient(s, key);
		const g1 = await item("default", "g1");
		const body = JSON.stringify({
			bank: "default",
			id: "g1",
			etag: g1.etag,
			content: "Changed from the tunnel.",
			scope: "global",
		});
		for (const [path, method] of [
			["/api/memory", "GET"],
			["/api/memory/items", "GET"],
			["/api/memory/items?q=tabs", "GET"],
			["/api/memory/item?bank=default&id=g1", "GET"],
			["/api/memory/add", "POST"],
			["/api/memory/update", "POST"],
			["/api/memory/retire", "POST"],
			["/api/memory/restore", "POST"],
			["/api/memory/delete", "POST"],
		] as const) {
			const res = await phone.fetch(
				path,
				{ method, headers: method === "POST" ? { "x-omp-webui": "1", "content-type": "application/json" } : undefined },
				method === "POST" ? body : undefined,
			);
			expect(res.status, `${method} ${path}`).toBe(403);
			// What it was refused says nothing of the store.
			expect(await res.text()).toBe("Forbidden");
		}
		expect(snapshot()).toBe(before);
		// The same requests from this computer go through (a refusal is the tunnel's, not the route's).
		expect((await call("/api/memory")).status).toBe(200);
	});
});

describe("changing", () => {
	test("a rewrite carries the etag it was read with, takes a copy of the store first, and keeps omp's search index in step", async () => {
		const g1 = await item("default", "g1");
		const done = await call<MemoryChanged>("/api/memory/update", {
			bank: "default",
			id: "g1",
			etag: g1.etag,
			content: "Prefers zebrafish-shaped tabs.",
			importance: 0.9,
		});
		expect(done.status).toBe(200);
		expect(done.body.backedUp).toBe(true);
		expect(done.body.item).toMatchObject({ content: "Prefers zebrafish-shaped tabs.", importance: 0.9 });
		expect(done.body.item.etag).not.toBe(g1.etag);
		expect(content("default", "g1")).toBe("Prefers zebrafish-shaped tabs.");
		// The stale embedding of the old words is gone (omp's next start makes the new one).
		expect(read("default", "SELECT memory_id FROM memory_embeddings WHERE memory_id = 'g1'")).toEqual([]);
		// omp's full-text index finds it by its new words and no longer by its old ones.
		const found = (words: string) =>
			read<{ id: string }>("default", "SELECT id FROM fts_working WHERE fts_working MATCH ?", words).map((r) => r.id);
		expect(found("zebrafish")).toEqual(["g1"]);
		expect(found("spaces")).toEqual([]);

		// The copy that was made first holds the memory as it was.
		const dir = join(dataDir(), "memory-backups", "default");
		const copies = readdirSync(dir);
		expect(copies.length).toBeGreaterThan(0);
		const backup = new Database(join(dir, copies[0] as string), { readonly: true });
		try {
			expect(
				backup.query<{ content: string }, []>("SELECT content FROM working_memory WHERE id = 'g1'").get()?.content,
			).toBe("Prefers tabs over spaces in every project.");
			expect(backup.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
		} finally {
			backup.close();
		}
	});

	test("a rewrite of a memory that changed since it was read is refused, and so is one of the same memory racing it", async () => {
		const g2 = await item("default", "g2");
		// Changed behind the page's back (omp consolidating, or another page).
		const db = new Database(dbPath("default"), { readwrite: true });
		db.query("UPDATE working_memory SET content = 'omp rewrote this.' WHERE id = 'g2'").run();
		db.close();
		const stale = await call("/api/memory/update", { bank: "default", id: "g2", etag: g2.etag, content: "Too late." });
		expect(stale).toMatchObject({ status: 409, body: { code: "stale" } });
		expect(content("default", "g2")).toBe("omp rewrote this.");
		// A delete or retire with that etag is refused too.
		expect(await call("/api/memory/delete", { bank: "default", id: "g2", etag: g2.etag })).toMatchObject({
			status: 409,
			body: { code: "stale" },
		});
		expect(await call("/api/memory/retire", { bank: "default", id: "g2", etag: g2.etag })).toMatchObject({
			status: 409,
			body: { code: "stale" },
		});

		// Two pages save the same memory from the same state at the same moment: one wins, the other is told.
		const now = await item("default", "g2");
		const results = await Promise.all(
			["First page.", "Second page."].map((text) =>
				call("/api/memory/update", { bank: "default", id: "g2", etag: now.etag, content: text }),
			),
		);
		expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
		expect(results.find((r) => r.status === 409)?.body.code).toBe("stale");
		expect(["First page.", "Second page."]).toContain(content("default", "g2") ?? "");
	});

	test("many changes at once to different memories all land, and the database is whole after them", async () => {
		const ids = Array.from({ length: 8 }, (_, i) => `n${i}`);
		const items = await Promise.all(ids.map((id) => item("default", id)));
		const results = await Promise.all(
			items.map((it, i) =>
				call("/api/memory/update", {
					bank: "default",
					id: it.id,
					etag: it.etag,
					content: `Numbered note ${i}, rewritten.`,
				}),
			),
		);
		expect(results.map((r) => r.status)).toEqual(ids.map(() => 200));
		for (const [i, id] of ids.entries()) expect(content("default", id)).toBe(`Numbered note ${i}, rewritten.`);
		expect(read<{ integrity_check: string }>("default", "PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
		expect(
			read<{ n: number }>("default", "SELECT COUNT(*) AS n FROM fts_working WHERE fts_working MATCH 'rewritten'")[0]?.n,
		).toBe(8);
	});

	test("retiring and bringing back leave the memory in the store, a consolidated one included; a consolidated one is not rewritten or deleted", async () => {
		const p1 = await item(APP, "p1");
		const retired = await call<MemoryChanged>("/api/memory/retire", { bank: APP, id: "p1", etag: p1.etag });
		expect(retired.status).toBe(200);
		expect(retired.body.item.retired).toBe(true);
		expect(content(APP, "p1")).toBe("The build needs bun 1.4.");
		const back = await call<MemoryChanged>("/api/memory/restore", { bank: APP, id: "p1" });
		expect(back.body.item.retired).toBe(false);
		// Doing it again is not an error: it is what the page wanted.
		expect((await call("/api/memory/restore", { bank: APP, id: "p1" })).status).toBe(200);

		const gE1 = await item("default", "gE1");
		expect(
			(await call<MemoryChanged>("/api/memory/retire", { bank: "default", id: "gE1", etag: gE1.etag })).body.item
				.retired,
		).toBe(true);
		expect((await call<MemoryChanged>("/api/memory/restore", { bank: "default", id: "gE1" })).body.item.retired).toBe(
			false,
		);
		const fresh = await item("default", "gE1");
		for (const path of ["update", "delete"]) {
			const res = await call(`/api/memory/${path}`, { bank: "default", id: "gE1", etag: fresh.etag, content: "x" });
			expect(res, path).toMatchObject({ status: 409, body: { code: "notEditable" } });
		}
		expect(read("default", "SELECT content FROM episodic_memory WHERE id = 'gE1'")).toEqual([
			{ content: "Prefers tabs. (consolidated)" },
		]);
	});

	test("a memory is added as the agent would save it, with where it came from, and to a project's bank with the project's folder", async () => {
		const global = await call<MemoryChanged>("/api/memory/add", {
			scope: "global",
			content: "  Added to every project.  ",
			importance: 0.5,
		});
		expect(global.status).toBe(200);
		expect(global.body.item).toMatchObject({
			content: "Added to every project.",
			scope: "global",
			importance: 0.5,
			kind: "note",
		});
		expect(global.body.item.provenance).toMatchObject({ origin: "web", source: "omp-webui" });
		const project = await call<MemoryChanged>("/api/memory/add", {
			scope: "project",
			bank: APP,
			content: "Added to the app.",
			context: "Typed by hand.",
		});
		expect(project.body.item.provenance).toMatchObject({ origin: "web", cwd: "/work/app", context: "Typed by hand." });
		expect(project.body.item.bank).toBe(APP);
		expect(read(APP, "SELECT source, trust_tier FROM working_memory WHERE content = 'Added to the app.'")).toEqual([
			{ source: "omp-webui", trust_tier: "STATED" },
		]);
		// What is not a memory, or not one this page makes.
		expect(await call("/api/memory/add", { scope: "global", content: "   " })).toMatchObject({
			status: 400,
			body: { code: "badRequest" },
		});
		expect(
			await call("/api/memory/add", { scope: "global", content: "x".repeat(MEMORY_CONTENT_MAX + 1) }),
		).toMatchObject({ status: 413, body: { code: "tooLong" } });
		expect(await call("/api/memory/add", { scope: "global", content: "x", importance: "high" })).toMatchObject({
			status: 400,
		});
		expect(await call("/api/memory/add", { scope: "project", bank: "default", content: "x" })).toMatchObject({
			status: 400,
		});
		expect(await call("/api/memory/add", { scope: "nowhere", content: "x" })).toMatchObject({ status: 400 });
	});

	test("deleting takes the memory and what omp derived from it, and nothing else", async () => {
		const g3 = await item("default", "g3");
		const others = read("default", "SELECT id FROM working_memory WHERE id != 'g3' ORDER BY id");
		const done = await call<MemoryDeleted>("/api/memory/delete", { bank: "default", id: "g3", etag: g3.etag });
		expect(done).toMatchObject({ status: 200, body: { deleted: true } });
		expect(content("default", "g3")).toBeNull();
		for (const table of ["facts", "annotations", "memoria_facts", "memoria_kg", "gists"]) {
			expect(read<{ n: number }>("default", `SELECT COUNT(*) AS n FROM ${table}`)[0]?.n, table).toBe(0);
		}
		expect(read("default", "SELECT id FROM working_memory WHERE id != 'g3' ORDER BY id")).toEqual(others);
		expect((await call("/api/memory/item?bank=default&id=g3")).status).toBe(404);
		expect(await call("/api/memory/delete", { bank: "default", id: "g3", etag: g3.etag })).toMatchObject({
			status: 404,
		});
		// A delete without the etag is not one: the page must have read the memory it deletes.
		const g1 = await item("default", "g1");
		expect(await call("/api/memory/delete", { bank: "default", id: "g1" })).toMatchObject({
			status: 400,
			body: { code: "badRequest" },
		});
		expect(content("default", "g1")).not.toBeNull();
		expect(g1.editable).toBe(true);
	});

	test("a text that looks like a key or token is saved only when the page says it is meant, on add and on rewrite", async () => {
		const secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
		expect(await call("/api/memory/add", { scope: "global", content: `the key is ${secret}` })).toMatchObject({
			status: 409,
			body: { code: "secret" },
		});
		expect(
			await call("/api/memory/add", { scope: "global", content: "x", context: "token_aB3dEfGh1JkLmN" }),
		).toMatchObject({
			status: 409,
			body: { code: "secret" },
		});
		expect(read("default", "SELECT id FROM working_memory WHERE content LIKE '%abcdefghijkl%'")).toEqual([]);
		const meant = await call<MemoryChanged>("/api/memory/add", {
			scope: "global",
			content: `the key is ${secret}`,
			acknowledgeSecret: true,
		});
		expect(meant.status).toBe(200);
		const id = meant.body.item.id;
		const then = await item("default", id);
		// A rewrite that leaves the secret is asked about too; one that takes it out is not.
		expect(
			await call("/api/memory/update", { bank: "default", id, etag: then.etag, content: `now ${secret}!` }),
		).toMatchObject({
			status: 409,
			body: { code: "secret" },
		});
		expect(
			await call("/api/memory/update", { bank: "default", id, etag: then.etag, content: "now it is gone" }),
		).toMatchObject({ status: 200 });
	});

	test("deleting can retire what omp consolidated from the memory in the same transaction, and a copy that holds the memory precedes it", async () => {
		const dir = join(dataDir(), "memory-backups", "default");
		const g1 = await item("default", "g1");
		expect(g1.consolidatedInto).toEqual(["gE1"]);
		const holds = (name: string): boolean => {
			const db = new Database(join(dir, name), { readonly: true });
			try {
				return db.query<{ id: string }, []>("SELECT id FROM working_memory WHERE id = 'g1'").all().length > 0;
			} finally {
				db.close();
			}
		};
		const copies = readdirSync(dir).sort();
		expect(copies.filter(holds).length).toBeGreaterThan(0);
		const done = await call<MemoryDeleted>("/api/memory/delete", {
			bank: "default",
			id: "g1",
			etag: g1.etag,
			retireConsolidated: true,
		});
		expect(done).toMatchObject({ status: 200, body: { deleted: true } });
		expect(content("default", "g1")).toBeNull();
		expect((await item("default", "gE1")).retired).toBe(true);
		// A copy that holds the memory, as it was before the delete, is there: a delete takes one of its own only when the
		// newest copy is older than a minute or was made before the memory was saved. Here the copy made seconds ago holds it.
		expect(done.body.backedUp).toBe(false);
		expect(readdirSync(dir).sort()).toEqual(copies);
		expect(copies.filter(holds).length).toBeGreaterThan(0);
	});

	test.skipIf(lanAddress() === undefined)(
		"a page on the network that holds the token is refused every route (this computer's only), and the store is as it was",
		async () => {
			const before = snapshot();
			const port = Number(new URL(s.url).port);
			const lan = lanAddress() as string;
			const headers = { "x-omp-webui-token": s.accessToken, "x-omp-webui": "1", "content-type": "application/json" };
			for (const [path, method, body] of [
				["/api/memory", "GET", undefined],
				["/api/memory/items", "GET", undefined],
				["/api/memory/item?bank=default&id=n0", "GET", undefined],
				["/api/memory/add", "POST", JSON.stringify({ scope: "global", content: "From the network." })],
				["/api/memory/delete", "POST", JSON.stringify({ bank: "default", id: "n0", etag: "x" })],
			] as const) {
				const res = await rawRequest({ host: "127.0.0.1", port, from: lan, path, method, headers, body });
				expect(res.status, `${method} ${path}`).toBe(403);
			}
			expect(snapshot()).toBe(before);
			// The same request from the loopback, with the same token, is served.
			expect((await call("/api/memory")).status).toBe(200);
		},
	);

	test("a database in a layout this page does not know is not written to, byte for byte, whatever is asked", async () => {
		const o1 = await item(ODD, "o1");
		expect(o1).toMatchObject({ editable: false, retirable: false });
		const before = digest(ODD);
		for (const [path, extra] of [
			["update", { content: "Changed." }],
			["delete", {}],
			["retire", {}],
			["restore", {}],
		] as const) {
			const res = await call(`/api/memory/${path}`, { bank: ODD, id: "o1", etag: o1.etag, ...extra });
			expect(res, path).toMatchObject({ status: 409, body: { code: "layout" } });
		}
		expect(await call("/api/memory/add", { scope: "project", bank: ODD, content: "Added." })).toMatchObject({
			status: 409,
			body: { code: "layout" },
		});
		expect(digest(ODD)).toBe(before);
		expect(existsSync(join(dataDir(), "memory-backups", ODD))).toBe(false);
	});
});
