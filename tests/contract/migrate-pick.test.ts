import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { placementOf } from "../../server/migrate/layout.ts";
import type { Manifest } from "../../server/migrate/manifest.ts";
import { ZipReader } from "../../server/migrate/zip.ts";
import { MIGRATE_DATA_CATEGORIES, type MigrateState } from "../../shared/migrate.ts";
import { writeSimpleSession } from "../support/fixtures.ts";
import { apply, call, discardImport, exportTo, plan, state, uploadAndVerify } from "../support/migrate-http.ts";
import { treeOf } from "../support/migrate-run.ts";
import { SECRETS } from "../support/migrate-world.ts";
import { startTestServer, type TestServer } from "../support/server.ts";

/**
 * Choosing which kinds of data go into the file, over the HTTP API the page uses, between two real servers with their
 * own home folders (#632): the subset the request names is the subset in the zip, an import of it leaves every other
 * category of the other Mac byte for byte as it was, and an archive of before the manifest named its categories still
 * imports as a whole one.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-pick-"));
const FIXTURES = join(import.meta.dir, "..", "fixtures", "migrate");
let a: TestServer;
let b: TestServer;

const put = (path: string, text: string): void => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
};
const post = (s: TestServer, body: unknown) =>
	call<{ code?: string; categories?: string[] }>(s, "/api/migrate/export", {
		method: "POST",
		body: JSON.stringify(body),
	});

beforeAll(async () => {
	[a, b] = await Promise.all([startTestServer(0, {}, { login: false }), startTestServer(0, {}, { login: false })]);
	// The old Mac: a conversation, settings (one with a secret in it), a skill, this app's preferences.
	writeSimpleSession(a.agentDir, 0x61, "Only on the old Mac");
	put(join(a.agentDir, "lsp.json"), `${JSON.stringify({ idleTimeoutMs: 1 })}\n`);
	put(join(a.agentDir, "AGENTS.md"), "# Rules of the old Mac\n");
	put(
		join(a.agentDir, "models.yml"),
		`providers:\n  local:\n    baseUrl: http://127.0.0.1:8000/v1\n    apiKey: ${SECRETS.apiKey}\n`,
	);
	put(join(a.agentDir, "skills", "demo", "SKILL.md"), "---\nname: demo\n---\nThe old Mac's.\n");
	await call(a, "/api/prefs", { method: "POST", body: JSON.stringify({ changes: { "ompw.theme": "light" } }) });
	// The new Mac has its own, which differ in each place the old one has a file.
	put(join(b.agentDir, "lsp.json"), `${JSON.stringify({ idleTimeoutMs: 99 })}\n`);
	put(join(b.agentDir, "AGENTS.md"), "# Rules of the new Mac\n");
	put(join(b.agentDir, "skills", "demo", "SKILL.md"), "---\nname: demo\n---\nThe new Mac's.\n");
	writeSimpleSession(b.agentDir, 0x62, "Only on the new Mac");
}, 120_000);

afterAll(async () => {
	await Promise.all([a?.stop(), b?.stop()]);
	rmSync(root, { recursive: true, force: true });
});

describe("what the export is asked for", () => {
	test("the plan says which category each file with secret values is in", async () => {
		const { body } = await plan(a);
		expect(body.secretFiles.map((f) => [f.path.split("/").pop(), f.category])).toEqual([["models.yml", "settings"]]);
		expect(body.categories.map((c) => c.id)).toEqual([...MIGRATE_DATA_CATEGORIES, "credentials"]);
	});

	test("a request that names no kind of data to export, or one there is none of, is refused before anything starts", async () => {
		const logins = await post(a, { credentials: false, categories: ["credentials"] });
		expect([logins.status, logins.body.code]).toEqual([400, "migrateCategories"]);
		const unknown = await post(a, { credentials: false, categories: ["settings", "bogus"] });
		expect([unknown.status, unknown.body.code]).toEqual([400, "migrateCategories"]);
		const notAList = await post(a, { credentials: false, categories: "settings" });
		expect([notAList.status, notAList.body.code]).toEqual([400, "migrateCategories"]);
		const nothing = await post(a, { credentials: false, categories: [] });
		expect([nothing.status, nothing.body.code]).toEqual([400, "migrateNothingChosen"]);
		expect(((await state(a)).body as MigrateState).export).toBeNull();
	});
});

describe("an export of a subset, and an import of it", () => {
	const file = join(root, "subset.ompw");
	let before: Record<string, string>;

	test("the zip holds exactly the categories asked for, and the manifest and the status say so", async () => {
		const done = await exportTo(a, file, { credentials: false, categories: ["settings", "webui"] });
		expect(done.categories).toEqual(["settings", "webui"]);
		const zip = await ZipReader.open(file);
		const manifest: Manifest = JSON.parse(Buffer.from(await zip.bytes("manifest.json")).toString("utf8"));
		const names = zip.entries.map((e) => e.name).filter((n) => n !== "manifest.json");
		await zip.close();
		expect(manifest.categories).toEqual(["settings", "webui"]);
		expect(manifest.credentials.included).toBe(false);
		expect(names.length).toBeGreaterThan(0);
		for (const name of names) expect(["settings", "webui"], name).toContain(placementOf(name)?.category ?? "none");
		expect(names).toContain("agent/lsp.json");
		expect(names).toContain("agent/AGENTS.md");
		expect(names.some((n) => n.includes("/sessions/") || n.includes("/skills/"))).toBe(false);
		// The secret value of the settings is blanked, as it is without logins.
		expect(readFileSync(file).toString("latin1")).not.toContain(SECRETS.apiKey);
		expect(manifest.secretFiles.map((f) => f.path.split("/").pop())).toEqual(["models.yml"]);
	});

	test("the other Mac is shown what the file holds, and only that", async () => {
		before = treeOf(b.root);
		const ready = await uploadAndVerify(b, file);
		expect(ready.state, JSON.stringify(ready.error)).toBe("ready");
		expect(ready.preview?.held).toEqual(["settings", "webui"]);
		expect(ready.preview?.categories.map((c) => c.id)).toEqual(["settings", "webui"]);
		expect(ready.preview?.conversations.total).toBe(0);
	});

	test("importing it replaces what it holds, and every other category is byte for byte as it was", async () => {
		const { started, ended } = await apply(b, { mode: "replace", credentials: false });
		expect(started.status).toBe(200);
		expect(ended?.state, JSON.stringify(ended?.error)).toBe("done");
		// What it holds came over.
		expect(readFileSync(join(b.agentDir, "lsp.json"), "utf8")).toContain('"idleTimeoutMs":1');
		expect(readFileSync(join(b.agentDir, "AGENTS.md"), "utf8")).toBe("# Rules of the old Mac\n");
		expect((await call<{ values: Record<string, string | null> }>(b, "/api/prefs")).body.values["ompw.theme"]).toBe(
			"light",
		);
		// What it does not hold was not touched: the skill, the conversations, the history. Nothing was added there either.
		const after = treeOf(b.root);
		const rel = (path: string) => relative(b.root, path);
		const kept = [
			rel(join(b.agentDir, "sessions")),
			rel(join(b.agentDir, "skills")),
			rel(join(b.agentDir, "history.db")),
		];
		const inKept = (k: string) => kept.some((p) => k === p || k.startsWith(`${p}/`));
		const checked = Object.keys(before).filter(inKept);
		expect(checked.some((k) => k.endsWith("skills/demo/SKILL.md"))).toBe(true);
		expect(checked.length).toBeGreaterThan(2);
		for (const k of checked) expect(after[k], k).toBe(before[k]);
		expect(Object.keys(after).filter(inKept).sort()).toEqual(checked.sort());
		expect(readFileSync(join(b.agentDir, "skills", "demo", "SKILL.md"), "utf8")).toContain("The new Mac's.");
		await discardImport(b);
	});
});

describe("an archive of before the manifest named its categories", () => {
	let c: TestServer;
	beforeAll(async () => {
		c = await startTestServer(0, {}, { login: false });
	}, 60_000);
	afterAll(async () => {
		await c?.stop();
	});

	test("is a whole one: it is shown as holding every category, and it imports", async () => {
		const old = join(root, "plain-v1.ompw");
		copyFileSync(join(FIXTURES, "plain-v1.ompw"), old);
		const ready = await uploadAndVerify(c, old);
		expect(ready.state, JSON.stringify(ready.error)).toBe("ready");
		expect(ready.preview?.held).toEqual([...MIGRATE_DATA_CATEGORIES]);
		expect(ready.preview?.credentials).toBe(false);
		const { ended } = await apply(c, { mode: "merge", credentials: false });
		expect(ended?.state, JSON.stringify(ended?.error)).toBe("done");
		expect(ended?.summary?.conversations.added).toBe(4);
		expect(readFileSync(join(c.agentDir, "config.yml"), "utf8").length).toBeGreaterThan(0);
		await discardImport(c);
	});
});
