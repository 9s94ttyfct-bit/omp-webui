import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
import { basename, join } from "node:path";
import { ZipReader } from "../../server/migrate/zip.ts";
import type { ImportStatus, MigrateState } from "../../shared/migrate.ts";
import type { LiveInfo, SessionSummary } from "../../shared/protocol.ts";
import { writeSimpleSession } from "../support/fixtures.ts";
import { messageWhere } from "../support/frames.ts";
import { apply, call, discardImport, exportTo, plan, state, unlock, uploadAndVerify } from "../support/migrate-http.ts";
import { expectUntouched, treeOf } from "../support/migrate-run.ts";
import { SECRETS } from "../support/migrate-world.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { connect, request } from "../support/ws.ts";

/**
 * Moving between two real servers whose home folders differ, over the HTTP API the page uses: the archive made on one,
 * uploaded to the other, checked, applied; then the migrated conversation is opened and resumed there by a real omp (#572).
 * Real omp, no model calls.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-migrate-http-"));
const PASSWORD = "correct horse battery";
let a: TestServer;
let b: TestServer;
/** The conversation that ran in a folder under the old home. */
let moved: { id: string; name: string; oldFile: string };
let oldCwd: string;
let archive: string;

const bucketDir = (s: TestServer, bucket: string) => join(s.agentDir, "sessions", bucket);
const sessions = async (s: TestServer) =>
	(await call<SessionSummary[]>(s, "/api/sessions")).body as unknown as SessionSummary[];

beforeAll(async () => {
	[a, b] = await Promise.all([startTestServer(0, {}, { login: false }), startTestServer(0, {}, { login: false })]);
	expect(a.home).not.toBe(b.home);
	// A conversation of a project under the old home, as omp records it: the folder with its links resolved.
	oldCwd = join(realpathSync(a.home), "proj");
	const made = writeSimpleSession(a.agentDir, 0x51, "Home project talk");
	const text = readFileSync(made, "utf8").replace(
		'"cwd":"/tmp/ompw-fixture-project"',
		`"cwd":${JSON.stringify(oldCwd)}`,
	);
	mkdirSync(bucketDir(a, "-proj"), { recursive: true });
	const name = basename(made);
	const oldFile = join(bucketDir(a, "-proj"), name);
	writeFileSync(oldFile, text);
	rmSync(made);
	moved = { id: /_([^_]+)\.jsonl$/.exec(name)?.[1] as string, name, oldFile };
	// Things beside it: settings with the old home in them, secrets, a login, and this app's own lists.
	writeFileSync(
		join(a.agentDir, "lsp.json"),
		`${JSON.stringify({ idleTimeoutMs: 1, servers: { gopls: { command: `${realpathSync(a.home)}/go/bin/gopls` } } }, null, 2)}\n`,
	);
	writeFileSync(
		join(a.agentDir, "models.yml"),
		`providers:\n  local:\n    baseUrl: http://127.0.0.1:8000/v1\n    apiKey: ${SECRETS.apiKey}\n`,
	);
	writeFileSync(join(a.agentDir, "secrets.yml"), `- type: plain\n  content: ${SECRETS.secretsYml}\n`);
	const auth = new Database(join(a.agentDir, "agent.db"));
	auth.run(
		"INSERT INTO auth_credentials (provider, credential_type, data, identity_key) VALUES ('anthropic', 'oauth', ?, 'acct-1')",
		[JSON.stringify({ refresh: SECRETS.oauth })],
	);
	auth.close();
	writeFileSync(join(a.root, "data", "archived.json"), JSON.stringify([oldFile]));
	await call(a, "/api/prefs", { method: "POST", body: JSON.stringify({ changes: { "ompw.theme": "light" } }) });
	await call(a, "/api/favorite-models", {
		method: "POST",
		body: JSON.stringify({ model: "anthropic/claude-haiku-5-5", on: true }),
	});
	// This Mac already has its own settings, which differ.
	writeFileSync(join(b.agentDir, "lsp.json"), `${JSON.stringify({ idleTimeoutMs: 99 }, null, 2)}\n`);
	archive = join(root, "moved.ompw");
}, 120_000);

afterAll(async () => {
	await Promise.all([a?.stop(), b?.stop()]);
	rmSync(root, { recursive: true, force: true });
});

describe("the page of the old machine", () => {
	test("the plan counts what would go and what would not, and says the logins are not in it", async () => {
		const { status, body } = await plan(a);
		expect(status).toBe(200);
		expect(body.home).toBe(a.home);
		expect(body.host.length).toBeGreaterThan(0);
		const by = Object.fromEntries(body.categories.map((c) => [c.id, c]));
		expect(by.conversations.files).toBeGreaterThanOrEqual(6);
		expect(by.history.files).toBeGreaterThanOrEqual(1);
		expect(by.settings.files).toBeGreaterThanOrEqual(3);
		expect(by.webui.files).toBeGreaterThanOrEqual(1);
		expect(by.credentials.files).toBeGreaterThanOrEqual(2);
		// The credentials category is not part of what is carried by default.
		expect(body.totalFiles).toBe(
			body.categories.filter((c) => c.id !== "credentials").reduce((n, c) => n + c.files, 0),
		);
		const left = Object.fromEntries(
			body.leftOut.map((l) => [l.path.replace(realpathSync(a.home), "~").replace(a.home, "~"), l.reason]),
		);
		expect(left["~/.omp/agent/agent.db"]).toBe("secret");
		expect(left["~/.omp/agent/secrets.yml"]).toBe("secret");
		expect(body.leftOut.find((l) => l.path === join(a.root, "data", "index.db"))?.reason).toBe("rebuilt");
		expect(body.secretFiles.map((f) => basename(f.path))).toEqual(["models.yml"]);
		expect(JSON.stringify(body)).not.toContain(SECRETS.apiKey);
	});

	test("a password is asked for when logins are, and is checked before anything starts", async () => {
		const none = await call(a, "/api/migrate/export", { method: "POST", body: JSON.stringify({ credentials: true }) });
		expect([none.status, none.body.code]).toEqual([400, "migratePasswordMissing"]);
		const short = await call(a, "/api/migrate/export", {
			method: "POST",
			body: JSON.stringify({ credentials: true, password: "short" }),
		});
		expect([short.status, short.body.code]).toEqual([400, "migratePasswordShort"]);
		expect(((await state(a)).body as MigrateState).export).toBeNull();
		expect((await call(a, "/api/migrate/export", { method: "GET" })).status).toBe(405);
	});

	test("the archive of an export without logins holds none of them, and is downloaded as a file", async () => {
		const done = await exportTo(a, archive, { credentials: false });
		expect(done.file?.name).toMatch(/^omp-webui-migration-.+-\d{4}-\d{2}-\d{2}\.ompw$/);
		expect(done.progress.totalFiles).toBeGreaterThan(5);
		const raw = readFileSync(archive).toString("latin1");
		for (const secret of [SECRETS.apiKey, SECRETS.oauth, SECRETS.secretsYml]) expect(raw).not.toContain(secret);
		const zip = await ZipReader.open(archive);
		const manifest = JSON.parse(Buffer.from(await zip.bytes("manifest.json")).toString("utf8"));
		await zip.close();
		expect(manifest).toMatchObject({
			format: 1,
			app: "omp-webui",
			credentials: { included: false },
			source: { home: a.home },
		});
		// The copy kept on the server is dropped when the person is done with it.
		expect((await call(a, "/api/migrate/export/discard", { method: "POST" })).status).toBe(200);
		expect((await call(a, "/api/migrate/export/file")).status).toBe(404);
	});
});

describe("the page of the new machine", () => {
	let ready: ImportStatus;

	test("an uploaded archive is checked and shown before anything is written", async () => {
		const before = treeOf(b.root);
		ready = await uploadAndVerify(b, archive);
		expect(ready.state).toBe("ready");
		const preview = ready.preview;
		expect(preview?.source).toMatchObject({ home: a.home });
		expect(preview?.home).toBe(b.home);
		expect(preview?.warnings.map((w) => w.code)).toContain("homeDiffers");
		// The fixtures both have are the same conversations; the one that ran under the old home is new.
		expect(preview?.conversations).toMatchObject({ total: 6, added: 1, same: 5, differs: 0 });
		expect(preview?.credentials).toBe(false);
		// Nothing was written to this Mac by looking.
		const after = treeOf(b.root);
		expectUntouched(before, after);
		expect(existsSync(join(b.root, "data", "migration-backups"))).toBe(false);
	});

	test("merging adds the conversation under the new home, keeps what this Mac has, and copies what it changes first", async () => {
		const { started, ended } = await apply(b, { mode: "merge", credentials: false });
		expect(started.status).toBe(200);
		expect(ended?.state, JSON.stringify(ended?.error)).toBe("done");
		const summary = ended?.summary;
		expect(summary?.conversations).toMatchObject({ added: 1, kept: 5, updated: 0, replaced: 0 });
		expect(summary?.rewrittenFolders).toBe(1);
		expect(summary?.credentials).toMatchObject({ restored: false, reason: "absent" });
		// The settings this Mac had gained what the old one had; its own value stayed. The old one was copied before.
		const lsp = JSON.parse(readFileSync(join(b.agentDir, "lsp.json"), "utf8"));
		expect(lsp.idleTimeoutMs).toBe(99);
		expect(lsp.servers.gopls.command).toBe(`${realpathSync(b.home)}/go/bin/gopls`);
		expect(summary?.backup?.startsWith(join(b.root, "data", "migration-backups"))).toBe(true);
		const copy = join(summary?.backup as string, "files", join(realpathSync(b.agentDir), "lsp.json"));
		expect(JSON.parse(readFileSync(copy, "utf8"))).toEqual({ idleTimeoutMs: 99 });
		expect(summary?.oldMachine.some((v) => v.key === "servers.gopls.command" && v.why === "missing")).toBe(true);
		// What is a login is not here.
		expect(readFileSync(join(b.agentDir, "models.yml"), "utf8")).toContain('apiKey: ""');
		expect(existsSync(join(b.agentDir, "secrets.yml"))).toBe(false);
		expect(
			new Database(join(b.agentDir, "agent.db"), { readonly: true })
				.query("SELECT COUNT(*) AS n FROM auth_credentials")
				.get(),
		).toEqual({ n: 0 });
	});

	test("the running server shows it at once: the conversation, the preferences, the favourites", async () => {
		const found = (await sessions(b)).find((s) => s.id === moved.id);
		expect(found?.cwd).toBe(join(realpathSync(b.home), "proj"));
		expect(found?.file.startsWith(realpathSync(b.agentDir))).toBe(true);
		expect(basename(found?.file ?? "")).toBe(moved.name);
		expect((await call<{ values: Record<string, string | null> }>(b, "/api/prefs")).body.values["ompw.theme"]).toBe(
			"light",
		);
		expect((await call<string[]>(b, "/api/favorite-models")).body).toEqual(["anthropic/claude-haiku-5-5"]);
		expect(((await call<string[]>(b, "/api/archive")).body as unknown as string[]).map((f) => basename(f))).toEqual([
			moved.name,
		]);
	});

	test("the conversation opens in the new home, and resumes there once its folder exists", async () => {
		const ws = await connect(b);
		const folder = join(realpathSync(b.home), "proj");
		const open = async (target: Record<string, unknown>) => {
			const req = crypto.randomUUID();
			const reply = messageWhere(ws, (m) => m.t === "reply" && m.req === req);
			ws.send(JSON.stringify({ t: "open", req, target }));
			return (await reply) as unknown as {
				ok: boolean;
				code?: string;
				params?: Record<string, string>;
				data?: LiveInfo;
			};
		};
		const file = (await sessions(b)).find((s) => s.id === moved.id)?.file as string;
		// The folder is not on this Mac yet: it is named by the NEW home, not the old one.
		const gone = await open({ kind: "resume", sessionFile: file });
		expect(gone.ok).toBe(false);
		expect(gone.code).toBe("sessionFolderGone");
		expect(gone.params?.folder).toBe(folder);
		expect(JSON.stringify(gone)).not.toContain(oldCwd);
		mkdirSync(folder, { recursive: true });
		const resumed = await open({ kind: "resume", sessionFile: file });
		expect(resumed.ok, JSON.stringify(resumed)).toBe(true);
		const live = resumed.data as LiveInfo;
		expect(realpathSync(live.cwd)).toBe(realpathSync(folder));
		const ran = await request<{ workingDir?: string }>(ws, {
			t: "rpc",
			liveId: live.liveId,
			command: { type: "bash", command: "pwd" },
		});
		expect(realpathSync(String(ran.workingDir))).toBe(realpathSync(folder));
		// Its transcript is there with its messages.
		const loaded = await call<{ entries: unknown[] }>(b, `/api/session?file=${encodeURIComponent(file)}`);
		expect(loaded.status).toBe(200);
		expect(JSON.stringify(loaded.body)).toContain("Home project talk");
		await request(ws, { t: "close", liveId: live.liveId });
		ws.close();
	}, 90_000);

	test("the upload is dropped when the person is done, and nothing of it stays in the data folder", async () => {
		expect((await discardImport(b)).status).toBe(200);
		expect(((await state(b)).body as MigrateState).import).toBeNull();
		expect(readdirSync(join(b.root, "data", "migrate"))).toEqual([]);
	});
});

describe("logins", () => {
	let c: TestServer;
	beforeAll(async () => {
		c = await startTestServer(0, {}, { login: false });
	}, 60_000);
	afterAll(async () => {
		await c?.stop();
	});

	test("an export with a password holds them encrypted; a wrong password changes nothing and the right one restores them", async () => {
		const sealed = join(root, "sealed.ompw");
		const done = await exportTo(a, sealed, { credentials: true, password: PASSWORD });
		expect(done.credentials).toBe(true);
		const raw = readFileSync(sealed).toString("latin1");
		for (const secret of [SECRETS.apiKey, SECRETS.oauth, SECRETS.secretsYml, PASSWORD])
			expect(raw).not.toContain(secret);
		const ready = await uploadAndVerify(c, sealed);
		expect(ready.state).toBe("ready");
		expect(ready.preview?.credentials).toBe(true);
		const before = treeOf(c.root);
		for (const request of [{ password: "not the password" }, {}]) {
			const { started } = await apply(c, { mode: "merge", credentials: true, ...request });
			expect(started.status).toBe(400);
			expect(started.body.code).toBe(Object.keys(request).length ? "migratePasswordWrong" : "migratePasswordMissing");
		}
		// Still ready to try again, and not a byte on disk changed (the upload itself aside).
		expect(((await state(c)).body as MigrateState).import?.state).toBe("ready");
		const after = treeOf(c.root);
		expectUntouched(before, after);
		expect(existsSync(join(c.root, "data", "migration-backups"))).toBe(false);
		const { ended } = await apply(c, { mode: "merge", credentials: true, password: PASSWORD });
		expect(ended?.state, JSON.stringify(ended?.error)).toBe("done");
		expect(ended?.summary?.credentials).toMatchObject({ restored: true, providers: 1 });
		const db = new Database(join(c.agentDir, "agent.db"), { readonly: true });
		expect(db.query("SELECT provider, data FROM auth_credentials").all()).toEqual([
			{ provider: "anthropic", data: JSON.stringify({ refresh: SECRETS.oauth }) },
		]);
		db.close();
		expect(readFileSync(join(c.agentDir, "models.yml"), "utf8")).toContain(`apiKey: ${SECRETS.apiKey}`);
		expect(readFileSync(join(c.agentDir, "secrets.yml"), "utf8")).toContain(SECRETS.secretsYml);
		await discardImport(c);
	});

	test("an archive that was damaged on the way is refused with its file's name, and nothing of it is applied", async () => {
		const sealed = join(root, "sealed.ompw");
		const bytes = readFileSync(sealed);
		const zip = await ZipReader.open(sealed);
		const victim = zip.entries.find((e) => e.name.endsWith("config.yml")) as {
			name: string;
			offset: number;
			compressedSize: number;
		};
		await zip.close();
		bytes[victim.offset + 30 + victim.name.length + 32 + Math.floor(victim.compressedSize / 2)] ^= 0x55;
		const damaged = join(root, "damaged.ompw");
		writeFileSync(damaged, bytes);
		const before = treeOf(c.root);
		const result = await uploadAndVerify(c, damaged);
		expect(result.state).toBe("failed");
		expect(result.error?.code).toBe("migrateCorrupt");
		expect(result.error?.params?.file).toBe("agent/config.yml");
		// It cannot be applied from there.
		const { started } = await apply(c, { mode: "merge", credentials: false });
		expect(started.body.code).toBe("migrateNotReady");
		const after = treeOf(c.root);
		expectUntouched(before, after);
		await discardImport(c);
		// A file that is no archive at all.
		const junk = join(root, "junk.ompw");
		writeFileSync(junk, "x".repeat(4096));
		const notZip = await uploadAndVerify(c, junk);
		expect(notZip.state).toBe("failed");
		expect(notZip.error?.code).toBe("migrateNotArchive");
		await discardImport(c);
	});

	test("an upload that does not continue where it stopped, or is larger than it said, is refused", async () => {
		const begun = await call<ImportStatus>(c, "/api/migrate/import/begin", {
			method: "POST",
			body: JSON.stringify({ name: "x.ompw", size: 100 }),
		});
		expect(begun.status).toBe(200);
		const send = (offset: number, bytes: number) =>
			call<ImportStatus>(c, `/api/migrate/import/chunk?offset=${offset}`, {
				method: "POST",
				headers: { "content-type": "application/octet-stream" },
				body: new Uint8Array(bytes),
			});
		expect((await send(50, 10)).body.code).toBe("migrateUpload");
		expect((await send(0, 101)).body.code).toBe("migrateUpload");
		expect((await send(0, 60)).status).toBe(200);
		// A piece sent again from where it began replaces what was there.
		expect(((await send(0, 70)).body as ImportStatus).received).toBe(70);
		expect((await call(c, "/api/migrate/import/verify", { method: "POST" })).body.code).toBe("migrateUpload");
		await discardImport(c);
	});
});

describe("encrypted as a whole (#607)", () => {
	let d: TestServer;
	const whole = () => join(root, "whole.ompw");
	beforeAll(async () => {
		d = await startTestServer(0, {}, { login: false });
	}, 60_000);
	afterAll(async () => {
		await d?.stop();
	});

	test("the password is asked for, and checked, before anything starts, as it is for the logins", async () => {
		// The earlier test's finished export is still kept here: start with none, so that "none started" is what is checked.
		await call(a, "/api/migrate/export/discard", { method: "POST" });
		const send = (body: unknown) => call(a, "/api/migrate/export", { method: "POST", body: JSON.stringify(body) });
		const none = await send({ credentials: false, wholeFile: true });
		expect([none.status, none.body.code]).toEqual([400, "migratePasswordMissing"]);
		const short = await send({ credentials: false, wholeFile: true, password: "short" });
		expect([short.status, short.body.code]).toEqual([400, "migratePasswordShort"]);
		expect(((await state(a)).body as MigrateState).export).toBeNull();
	});

	test("an export holds nothing readable: no name, no secret, no password, and it is not a zip", async () => {
		const done = await exportTo(a, whole(), { credentials: true, wholeFile: true, password: PASSWORD });
		expect(done).toMatchObject({ credentials: true, wholeFile: true });
		const raw = readFileSync(whole());
		expect(raw.subarray(0, 8).toString()).toBe("OMPWENC2");
		const latin1 = raw.toString("latin1");
		for (const readable of ["manifest.json", "PK\x03\x04", "lsp.json", SECRETS.apiKey, SECRETS.oauth, PASSWORD]) {
			expect(latin1.includes(readable), readable).toBe(false);
		}
		expect(done.file?.bytes).toBe(raw.length);
		await call(a, "/api/migrate/export/discard", { method: "POST" });
	});

	test("an upload waits locked: no preview, nothing written, and nothing can be applied until it is opened", async () => {
		const before = treeOf(d.root);
		const locked = await uploadAndVerify(d, whole());
		expect(locked.state).toBe("locked");
		expect(locked.preview).toBeUndefined();
		expect(locked.error).toBeUndefined();
		const { started } = await apply(d, { mode: "merge", credentials: false });
		expect([started.status, started.body.code]).toEqual([400, "migrateNotReady"]);
		const after = treeOf(d.root);
		expectUntouched(before, after);
	});

	test("a missing or a wrong password is refused and the archive stays locked, to be tried again", async () => {
		const empty = await unlock(d, "");
		expect([empty.answered.status, empty.answered.body.code]).toEqual([400, "migratePasswordNeeded"]);
		const wrong = await unlock(d, "not the password");
		expect([wrong.answered.status, wrong.answered.body.code]).toEqual([400, "migrateFilePasswordWrong"]);
		expect(((await state(d)).body as MigrateState).import).toMatchObject({ state: "locked" });
	});

	test("the right one opens it: the same check as any archive, then the preview, with the logins needing no second password", async () => {
		const { answered, ended } = await unlock(d, PASSWORD);
		expect(answered.status).toBe(200);
		expect(ended?.state, JSON.stringify(ended?.error)).toBe("ready");
		expect(ended?.preview).toMatchObject({ encryption: "whole", credentials: true, source: { home: a.home } });
		expect(ended?.preview?.conversations.total).toBe(6);
		// Not locked any more: a second try has nothing to open.
		const again = await unlock(d, PASSWORD);
		expect([again.answered.status, again.answered.body.code]).toEqual([400, "migrateNotReady"]);
		const done = await apply(d, { mode: "merge", credentials: true });
		expect(done.started.status).toBe(200);
		expect(done.ended?.state, JSON.stringify(done.ended?.error)).toBe("done");
		expect(done.ended?.summary?.credentials).toMatchObject({ restored: true, providers: 1 });
		const db = new Database(join(d.agentDir, "agent.db"), { readonly: true });
		expect(db.query("SELECT provider FROM auth_credentials").all()).toEqual([{ provider: "anthropic" }]);
		db.close();
		expect(readFileSync(join(d.agentDir, "secrets.yml"), "utf8")).toContain(SECRETS.secretsYml);
		await discardImport(d);
	});

	test("an archive that was changed on the way is refused once it is opened, with nothing applied", async () => {
		const bytes = readFileSync(whole());
		bytes[8 + 4 + bytes.readUInt32BE(8) + 100] ^= 0x01;
		const changed = join(root, "whole-changed.ompw");
		writeFileSync(changed, bytes);
		const locked = await uploadAndVerify(d, changed);
		// Nothing can be told before the password: the change is found when the file is read with it.
		expect(locked.state).toBe("locked");
		const before = treeOf(d.root);
		const { answered, ended } = await unlock(d, PASSWORD);
		expect(answered.status).toBe(200);
		expect(ended?.state).toBe("failed");
		expect(ended?.error?.code).toBe("migrateTampered");
		const { started } = await apply(d, { mode: "merge", credentials: true });
		expect([started.status, started.body.code]).toEqual([400, "migrateNotReady"]);
		const after = treeOf(d.root);
		expectUntouched(before, after);
		await discardImport(d);
	});

	test("an upload that is dropped while it waits for its password leaves nothing in the data folder", async () => {
		expect((await uploadAndVerify(d, whole())).state).toBe("locked");
		expect((await discardImport(d)).status).toBe(200);
		expect(((await state(d)).body as MigrateState).import).toBeNull();
		expect(readdirSync(join(d.root, "data", "migrate"))).toEqual([]);
	});
});
