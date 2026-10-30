import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZipReader } from "../../server/migrate/zip.ts";
import { type ImportStatus, MIGRATE_API, type MigrateState } from "../../shared/migrate.ts";
import { messageWhere } from "../support/frames.ts";
import { apply, call, discardImport, exportTo, state, uploadAndVerify } from "../support/migrate-http.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { connect } from "../support/ws.ts";

/**
 * What `server/main.ts` does with the migration, which no unit of it can show (#572, the second review): the server
 * clears what a crash left in `<data dir>/migrate` when it starts, and while an import writes no conversation and no
 * terminal is opened. Each is a line of wiring in `main.ts`; deleting it must turn a test here red. Real servers, real omp,
 * no model calls.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-migrate-wiring-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("what a crash left in the data folder", () => {
	test("an upload, a finished export and a scratch folder are gone once the server is up; the rest of the folder is not touched", async () => {
		const data = join(root, "swept-data");
		mkdirSync(join(data, "migrate", "tmp-1a2b"), { recursive: true });
		writeFileSync(join(data, "migrate", "tmp-1a2b", "x.db"), "scratch");
		writeFileSync(join(data, "migrate", "incoming-x.ompw"), "a copy of every conversation");
		writeFileSync(join(data, "migrate", "omp-webui-migration-mac-2026-10-21.ompw"), "an export nobody downloaded");
		mkdirSync(join(data, "migration-backups", "2026"), { recursive: true });
		writeFileSync(join(data, "migration-backups", "2026", "changed.txt"), "a backup is kept\n");
		const s = await startTestServer(0, { OMP_WEBUI_DATA_DIR: data }, { login: false });
		try {
			expect(readdirSync(join(data, "migrate"))).toEqual([]);
			expect(readFileSync(join(data, "migration-backups", "2026", "changed.txt"), "utf8")).toBe("a backup is kept\n");
			// The server is up and answers: the sweep did not need it.
			expect((await call(s, MIGRATE_API.state)).status).toBe(200);
		} finally {
			await s.stop();
			rmSync(data, { recursive: true, force: true });
		}
	}, 60_000);
});

describe("while an import writes", () => {
	let a: TestServer;
	let b: TestServer;
	const fifo = (): string => join(b.agentDir, "lsp.json");
	let archive: string;

	beforeAll(async () => {
		[a, b] = await Promise.all([startTestServer(0, {}, { login: false }), startTestServer(0, {}, { login: false })]);
		// One file the import reads on this Mac before it decides what to do with it: a pipe, which does not answer until
		// somebody writes to it. The import stands still in the middle of its work for as long as the test wants.
		writeFileSync(join(a.agentDir, "lsp.json"), "{}");
		archive = join(root, "moved.ompw");
		await exportTo(a, archive, { credentials: false });
		expect(spawnSync("mkfifo", [fifo()]).status).toBe(0);
	}, 120_000);

	afterAll(async () => {
		await Promise.all([a?.stop(), b?.stop()]);
	});

	/** One reply of the server to a socket message (the code and the parameters travel beside the sentence). */
	async function ask(ws: WebSocket, msg: Record<string, unknown>) {
		const req = crypto.randomUUID();
		const reply = messageWhere(ws, (m) => m.t === "reply" && m.req === req);
		ws.send(JSON.stringify({ ...msg, req }));
		return (await reply) as unknown as { ok: boolean; code?: string; error?: string; data?: { liveId: string } };
	}

	/** The pipe answers: what the import was waiting for comes, and it goes on. */
	function release(): void {
		const fd = openSync(fifo(), "w");
		writeSync(fd, "{}");
		closeSync(fd);
	}

	/** omp reads this file when it starts: a pipe nobody writes to would stop it there. */
	function mend(): void {
		rmSync(fifo(), { force: true });
		writeFileSync(fifo(), "{}");
	}

	test("no conversation is opened or resumed and no terminal is started; a second apply is refused; all of it works again when it ends", async () => {
		expect((await uploadAndVerify(b, archive)).state).toBe("ready");
		const started = await call<ImportStatus>(b, MIGRATE_API.importApply, {
			method: "POST",
			body: JSON.stringify({ mode: "merge", credentials: false }),
		});
		expect(started.status).toBe(200);
		expect(started.body.state).toBe("applying");
		const ws = await connect(b);
		try {
			await pollUntil(
				async () => ((await state(b)).body as MigrateState).import?.progress.phase === "write",
				"the import to write",
			);
			expect(((await state(b)).body as MigrateState).import?.state).toBe("applying");

			const fresh = await ask(ws, { t: "open", target: { kind: "new", cwd: b.work } });
			expect([fresh.ok, fresh.code]).toEqual([false, "migrateRunning"]);
			const resumed = await ask(ws, { t: "open", target: { kind: "resume", sessionFile: b.fixtures.alpha } });
			expect([resumed.ok, resumed.code]).toEqual([false, "migrateRunning"]);
			const terminal = await ask(ws, { t: "pty_open", args: [], cwd: b.work, cols: 80, rows: 24 });
			expect([terminal.ok, terminal.code]).toEqual([false, "migrateRunning"]);
			// Nothing started in the meantime.
			expect((await call<unknown[]>(b, "/api/lives")).body).toEqual([]);

			const second = await call<ImportStatus>(b, MIGRATE_API.importApply, {
				method: "POST",
				body: JSON.stringify({ mode: "merge", credentials: false }),
			});
			expect([second.status, second.body.code]).toEqual([409, "migrateBusy"]);

			release();
			await pollUntil(
				async () => ((await state(b)).body as MigrateState).import?.state === "done",
				"the import to end",
			);

			mend();
			const after = await ask(ws, { t: "open", target: { kind: "new", cwd: b.work } });
			expect(after.ok, after.error).toBe(true);
			await ask(ws, { t: "close", liveId: (after.data as { liveId: string }).liveId });
		} finally {
			ws.close();
			await discardImport(b);
		}
	}, 120_000);
});

describe("an import that fails halfway", () => {
	test("says where its backup is over the API, and Restore puts back what it had changed", async () => {
		const [a, b] = await Promise.all([
			startTestServer(0, {}, { login: false }),
			startTestServer(0, {}, { login: false }),
		]);
		try {
			// The archive changes this Mac's settings (a key it lacks), and its last file is damaged after it was checked.
			const config = join(b.agentDir, "config.yml");
			const mine = readFileSync(config, "utf8");
			writeFileSync(join(a.agentDir, "config.yml"), `${mine}migrated: true\n`);
			const file = join(root, "halfway.ompw");
			await exportTo(a, file, { credentials: false });
			expect((await uploadAndVerify(b, file)).state).toBe("ready");
			const held = join(b.root, "data", "migrate");
			const incoming = join(held, readdirSync(held).find((n) => n.startsWith("incoming-")) as string);
			const zip = await ZipReader.open(incoming);
			const last = zip.entries.filter((e) => e.name.startsWith("webui/")).at(-1) as {
				name: string;
				offset: number;
				compressedSize: number;
			};
			await zip.close();
			const bytes = readFileSync(incoming);
			const nameLength = bytes.readUInt16LE(last.offset + 26);
			const extraLength = bytes.readUInt16LE(last.offset + 28);
			bytes[last.offset + 30 + nameLength + extraLength + Math.floor(last.compressedSize / 2)] ^= 0x5a;
			writeFileSync(incoming, bytes);

			const { started, ended } = await apply(b, { mode: "merge", credentials: false });
			expect(started.status).toBe(200);
			expect(ended?.state).toBe("failed");
			expect(ended?.error?.code).toBe("migrateCorrupt");
			expect(ended?.backup?.startsWith(join(b.root, "data", "migration-backups"))).toBe(true);
			// What was written before the damage is there, and listed.
			expect(readFileSync(config, "utf8")).toContain("migrated: true");
			expect(readFileSync(join(ended?.backup as string, "changed.txt"), "utf8")).toContain("config.yml");
			expect(JSON.parse(readFileSync(join(ended?.backup as string, "backup.json"), "utf8")).status).toBe("incomplete");

			const restored = await call<ImportStatus>(b, MIGRATE_API.importRestore, { method: "POST" });
			expect([restored.status, restored.body.restored]).toEqual([200, true]);
			expect(readFileSync(config, "utf8")).toBe(mine);
			// Once; and nothing to restore where nothing failed.
			expect((await call(b, MIGRATE_API.importRestore, { method: "POST" })).body.code).toBe("migrateNoBackup");
			expect(existsSync(join(ended?.backup as string, "backup.json"))).toBe(true);
			expect(JSON.parse(readFileSync(join(ended?.backup as string, "backup.json"), "utf8")).status).toBe("restored");
			await discardImport(b);
			expect((await call(b, MIGRATE_API.importRestore, { method: "POST" })).body.code).toBe("migrateNoBackup");
		} finally {
			await Promise.all([a.stop(), b.stop()]);
		}
	}, 120_000);
});
