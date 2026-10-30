import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ImportArchive } from "../../server/migrate/import.ts";
import { CodedError } from "../../shared/error-info.ts";
import { scratch, text, treeOf } from "../support/migrate-run.ts";
import {
	FORK_ID,
	type Machine,
	SECRETS,
	SESSION_ID,
	seedMachine,
	seedProfile,
	seedSessionDir,
	stopMachine,
	TUNNEL_ID,
	transcript,
} from "../support/migrate-world.ts";

/**
 * What an import does with what a Mac already has, with the logins, and with an archive that cannot be trusted: merge
 * keeps and adds, replace lets the archive win, nothing existing changes without a copy of it first, a wrong password or a
 * damaged archive changes nothing (#572).
 */

const { root, remove, exportOf, importInto } = scratch();
afterAll(remove);

const sessionPath = (m: Machine, id: string, bucket = "-proj") =>
	join(m.agentDir, "sessions", bucket, `2026-01-05T10-00-00-000Z_${id}.jsonl`);

/** The error code an async call fails with. */
async function codeOf(run: () => Promise<unknown>): Promise<string | null> {
	try {
		await run();
		return null;
	} catch (e) {
		return e instanceof CodedError ? e.code : `other:${(e as Error).message}`;
	}
}

describe("logins", () => {
	const PASSWORD = "correct horse battery";

	test("with the password they come back: the login database, the secrets file, the tunnel's files, and the values blanked elsewhere", async () => {
		const old = seedMachine(join(root, "l1"), "jdoe");
		const fresh = seedMachine(join(root, "l2"), "alice", { rich: false });
		const { file } = await exportOf(old, { credentials: true, password: PASSWORD });
		const summary = await importInto(fresh, file, { credentials: true, password: PASSWORD });
		expect(summary.credentials).toMatchObject({ restored: true, providers: 2 });
		const db = new Database(join(fresh.agentDir, "agent.db"), { readonly: true });
		expect(db.query("SELECT provider, credential_type, data FROM auth_credentials ORDER BY provider").all()).toEqual([
			{ provider: "anthropic", credential_type: "oauth", data: JSON.stringify({ refresh: SECRETS.oauth }) },
			{ provider: "ollama-cloud", credential_type: "api_key", data: JSON.stringify({ key: SECRETS.loginKey }) },
		]);
		// What is machine state stays behind.
		expect(db.query("SELECT COUNT(*) AS n FROM usage_history").get()).toEqual({ n: 0 });
		db.close();
		expect(text(fresh.agentDir, "secrets.yml")).toContain(SECRETS.secretsYml);
		expect(text(fresh.home, ".cloudflared", "cert.pem")).toBe(SECRETS.pem);
		expect(text(fresh.home, ".cloudflared", `${TUNNEL_ID}.json`)).toBe(SECRETS.tunnel);
		expect(statSync(join(fresh.agentDir, "agent.db")).mode & 0o077).toBe(0);
		expect(statSync(join(fresh.agentDir, "secrets.yml")).mode & 0o077).toBe(0);
		// The configuration files come back as they were, secrets in them and the new home's paths.
		expect(text(fresh.agentDir, "models.yml")).toContain(`apiKey: ${SECRETS.apiKey}`);
		expect(text(fresh.agentDir, "models.yml")).toContain(`command: ${fresh.home}/bin/serve-models`);
		expect(JSON.parse(text(fresh.agentDir, "mcp.json")).mcpServers.github.headers.Authorization).toBe(
			`Bearer ${SECRETS.bearer}`,
		);
		expect(summary.notes.some((n) => n.code === "secretsBlanked")).toBe(false);
		// Its tunnel's id is kept (its credentials came), and remote access is still off.
		expect(JSON.parse(text(fresh.dataDir, "remote.json"))).toMatchObject({
			enabled: false,
			autostart: false,
			tunnelId: TUNNEL_ID,
		});
		stopMachine(old);
		stopMachine(fresh);
	});

	test("a wrong password is refused before anything is written or copied", async () => {
		const old = seedMachine(join(root, "w1"), "jdoe");
		const fresh = seedMachine(join(root, "w2"), "alice", { rich: false });
		writeFileSync(join(fresh.agentDir, "config.yml"), "theme:\n  dark: mine\n");
		const { file } = await exportOf(old, { credentials: true, password: PASSWORD });
		const before = treeOf(join(fresh.home));
		expect(await codeOf(() => importInto(fresh, file, { credentials: true, password: "not the password" }))).toBe(
			"migratePasswordWrong",
		);
		expect(await codeOf(() => importInto(fresh, file, { credentials: true }))).toBe("migratePasswordMissing");
		expect(treeOf(fresh.home)).toEqual(before);
		expect(existsSync(join(fresh.dataDir, "migration-backups"))).toBe(false);
		// The right one still works afterwards: the refusal left the archive and the Mac as they were.
		const ok = await importInto(fresh, file, { credentials: true, password: PASSWORD });
		expect(ok.credentials.restored).toBe(true);
		stopMachine(old);
		stopMachine(fresh);
	});

	test("asking for logins an archive does not have is refused; leaving them out of an archive that has them restores the rest", async () => {
		const old = seedMachine(join(root, "n1"), "jdoe");
		const fresh = seedMachine(join(root, "n2"), "alice", { rich: false });
		const without = (await exportOf(old)).file;
		expect(await codeOf(() => importInto(fresh, without, { credentials: true, password: PASSWORD }))).toBe(
			"migrateNoCredentials",
		);
		const withLogins = (await exportOf(old, { credentials: true, password: PASSWORD })).file;
		const summary = await importInto(fresh, withLogins, { credentials: false });
		expect(summary.credentials).toMatchObject({ restored: false, reason: "notAsked" });
		expect(existsSync(join(fresh.agentDir, "agent.db"))).toBe(false);
		expect(text(fresh.agentDir, "models.yml")).toContain('apiKey: ""');
		stopMachine(old);
		stopMachine(fresh);
	});

	test("logins join a login database this Mac already has: its own stay, the archive's are added, usage records are not touched", async () => {
		const old = seedMachine(join(root, "j1"), "jdoe");
		const fresh = seedMachine(join(root, "j2"), "alice");
		const mine = new Database(join(fresh.agentDir, "agent.db"));
		mine.run("DELETE FROM auth_credentials");
		mine.run(
			"INSERT INTO auth_credentials (provider, credential_type, data, identity_key) VALUES ('anthropic', 'oauth', ?, 'acct-1')",
			[JSON.stringify({ refresh: "this-mac" })],
		);
		mine.run("INSERT INTO auth_credentials (provider, credential_type, data) VALUES ('other', 'api_key', ?)", [
			JSON.stringify({ key: "local-key" }),
		]);
		const { file } = await exportOf(old, { credentials: true, password: PASSWORD });
		const revision = () =>
			mine.query<{ revision: number }, []>("SELECT revision FROM auth_change_revision").get()?.revision;
		const before = revision();
		await importInto(fresh, file, { credentials: true, password: PASSWORD });
		const rows = () =>
			mine
				.query<{ provider: string; data: string }, []>("SELECT provider, data FROM auth_credentials ORDER BY provider")
				.all();
		// The same account is kept as it is here; the new provider is added; the local one stays.
		expect(rows().map((r) => [r.provider, JSON.parse(r.data)])).toEqual([
			["anthropic", { refresh: "this-mac" }],
			["ollama-cloud", { key: SECRETS.loginKey }],
			["other", { key: "local-key" }],
		]);
		expect(revision()).toBeGreaterThan(before ?? 0);
		expect(mine.query("SELECT COUNT(*) AS n FROM usage_history").get()).toEqual({ n: 1 });
		await importInto(fresh, file, { credentials: true, password: PASSWORD, mode: "replace" });
		expect(rows().map((r) => [r.provider, JSON.parse(r.data)])[0]).toEqual(["anthropic", { refresh: SECRETS.oauth }]);
		mine.close();
		stopMachine(old);
		stopMachine(fresh);
	});

	test("a settings file in flow style is written again with its secret blanked, and the encrypted part brings the original back", async () => {
		const old = seedMachine(join(root, "u1"), "jdoe");
		writeFileSync(
			join(old.agentDir, "models.yml"),
			`providers: { local: { apiKey: ${SECRETS.apiKey}, baseUrl: "http://127.0.0.1:1" } }\n`,
		);
		const plain = await exportOf(old);
		expect(plain.manifest.entries.find((e) => e.path === "agent/models.yml")?.redacted).toBe(1);
		expect(readFileSync(plain.file).toString("latin1")).not.toContain(SECRETS.apiKey);
		const sealed = await exportOf(old, { credentials: true, password: PASSWORD });
		const fresh = seedMachine(join(root, "u2"), "alice", { rich: false });
		await importInto(fresh, sealed.file, { credentials: true, password: PASSWORD });
		expect(text(fresh.agentDir, "models.yml")).toContain(SECRETS.apiKey);
		stopMachine(old);
		stopMachine(fresh);
	});
});

describe("merge keeps what is here and adds what is missing; replace lets the archive win", () => {
	/** An archive of a machine, and a Mac that already has some of the same things in another state. */
	async function scene(tag: string) {
		const old = seedMachine(join(root, `${tag}1`), "jdoe");
		const here = seedMachine(join(root, `${tag}2`), "alice", { rich: false });
		const { file } = await exportOf(old);
		// The same conversation, written on this Mac as well: diverged from the archive's.
		const mine = sessionPath(here, SESSION_ID);
		mkdirSync(join(here.agentDir, "sessions", "-proj"), { recursive: true });
		writeFileSync(
			mine,
			transcript({
				id: SESSION_ID,
				bucket: "",
				cwd: join(here.home, "proj"),
				title: "Alpha session",
				turns: 1,
			}).replace("turn 1", "local words"),
		);
		// A conversation continued on the old Mac since: this Mac has its first part only.
		const forkOld = readFileSync(sessionPath(old, FORK_ID), "utf8").replaceAll(old.home, here.home);
		const forkCut = `${forkOld.split("\n").slice(0, 3).join("\n")}\n`;
		writeFileSync(sessionPath(here, FORK_ID), forkCut);
		// Settings that differ, and things only this Mac has.
		writeFileSync(join(here.agentDir, "config.yml"), "theme:\n  dark: my-own\nlocalOnly: true\n");
		mkdirSync(join(here.agentDir, "skills", "mine"), { recursive: true });
		writeFileSync(join(here.agentDir, "skills", "mine", "SKILL.md"), "mine\n");
		writeFileSync(join(here.dataDir, "favorite-models.json"), JSON.stringify(["local/model"]));
		const h = new Database(join(here.agentDir, "history.db"));
		h.exec(
			"CREATE TABLE history (id INTEGER PRIMARY KEY AUTOINCREMENT, prompt TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL DEFAULT 0, cwd TEXT, session_id TEXT, use_count INTEGER NOT NULL DEFAULT 1);" +
				"CREATE VIRTUAL TABLE history_fts USING fts5(prompt, content='history', content_rowid='id');" +
				"CREATE TRIGGER history_ai AFTER INSERT ON history BEGIN INSERT INTO history_fts(rowid, prompt) VALUES (new.id, new.prompt); END;" +
				"CREATE TABLE session_titles (session_id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0);" +
				"CREATE TABLE session_recaps (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, cwd TEXT NOT NULL, recap TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 0);",
		);
		h.run("INSERT INTO history (prompt, created_at, use_count) VALUES ('explain the zebra protocol', 999, 7)");
		h.run("INSERT INTO history (prompt, created_at) VALUES ('only on this mac', 1)");
		h.close();
		return { old, here, file, mine, forkPath: sessionPath(here, FORK_ID), forkFull: forkOld };
	}

	test("merge: this Mac's version of a conversation stays, one the archive continues is brought up to date, everything else is added", async () => {
		const { old, here, file, mine, forkPath, forkFull } = await scene("m");
		const mineBefore = readFileSync(mine, "utf8");
		const summary = await importInto(here, file, { mode: "merge" });
		expect(readFileSync(mine, "utf8")).toBe(mineBefore);
		// The fork's file was the start of the archive's: it is now the whole of it (with the new home's paths).
		expect(readFileSync(forkPath, "utf8")).toBe(forkFull);
		expect(summary.conversations).toMatchObject({ kept: 1, updated: 1, replaced: 0 });
		expect(summary.conversations.added).toBe(2);
		// Settings: a value this Mac has is its own, a key it lacks is added, and what only it has stays.
		const config = text(here.agentDir, "config.yml");
		expect(config).toContain("dark: my-own");
		expect(config).toContain("localOnly: true");
		expect(config).toContain("modelRoles");
		expect(config).toContain("default: anthropic/model-a");
		expect(existsSync(join(here.agentDir, "skills", "mine", "SKILL.md"))).toBe(true);
		expect(existsSync(join(here.agentDir, "skills", "demo", "SKILL.md"))).toBe(true);
		// Lists are joined, this Mac's first.
		expect(JSON.parse(text(here.dataDir, "favorite-models.json"))).toEqual(["local/model", "anthropic/model-a"]);
		// History: a prompt both have keeps this Mac's count, the others are added, with the new home's folders.
		const db = new Database(join(here.agentDir, "history.db"), { readonly: true });
		expect(db.query("SELECT prompt, use_count, cwd FROM history ORDER BY id").all()).toEqual([
			{ prompt: "explain the zebra protocol", use_count: 7, cwd: null },
			{ prompt: "only on this mac", use_count: 1, cwd: null },
			{ prompt: "wombat routing question", use_count: 1, cwd: join(root, "m1", "elsewhere", "tmpproj") },
			{ prompt: "a question from another folder", use_count: 1, cwd: join(here.home, "histonly") },
		]);
		expect(db.query("SELECT rowid FROM history_fts WHERE history_fts MATCH 'wombat'").all()).toHaveLength(1);
		db.close();
		expect(summary.files.merged).toBeGreaterThan(0);
		stopMachine(old);
		stopMachine(here);
	});

	test("merge never writes over anything without a copy of it first, and says where the copies are", async () => {
		const { old, here, file, forkPath } = await scene("b");
		const forkBefore = readFileSync(forkPath, "utf8");
		const configBefore = text(here.agentDir, "config.yml");
		const summary = await importInto(here, file);
		const backup = summary.backup as string;
		expect(backup.startsWith(join(here.dataDir, "migration-backups"))).toBe(true);
		expect(readFileSync(join(backup, "files", forkPath), "utf8")).toBe(forkBefore);
		expect(readFileSync(join(backup, "files", join(here.agentDir, "config.yml")), "utf8")).toBe(configBefore);
		// The database was copied as a database (it has its rows), not as a file next to its -wal.
		const copy = new Database(join(backup, "files", join(here.agentDir, "history.db")), { readonly: true });
		expect(copy.query("SELECT COUNT(*) AS n FROM history").get()).toEqual({ n: 2 });
		copy.close();
		const changed = readFileSync(join(backup, "changed.txt"), "utf8").split("\n").filter(Boolean);
		expect(changed).toContain(forkPath);
		expect(changed).toContain(join(here.agentDir, "config.yml"));
		const created = readFileSync(join(backup, "created.txt"), "utf8").split("\n").filter(Boolean);
		expect(created).toContain(sessionPath(here, "0190aaaa-0000-7000-8000-000000000003", "-legacy"));
		expect(JSON.parse(readFileSync(join(backup, "backup.json"), "utf8")).mode).toBe("merge");
		stopMachine(old);
		stopMachine(here);
	});

	test("a second import of the same archive changes nothing and makes no backup", async () => {
		const { old, here, file } = await scene("i");
		await importInto(here, file);
		const before = treeOf(here.home);
		const again = await importInto(here, file);
		expect(treeOf(here.home)).toEqual(before);
		expect(again.backup).toBeNull();
		expect(again.conversations.added).toBe(0);
		expect(again.files.added).toBe(0);
		stopMachine(old);
		stopMachine(here);
	});

	test("replace: the archive's version wins wherever both have one, and what only this Mac has stays", async () => {
		const { old, here, file, mine } = await scene("r");
		const summary = await importInto(here, file, { mode: "replace" });
		expect(text(mine)).not.toContain("local words");
		expect(text(mine)).toContain("Alpha session turn 1");
		expect(summary.conversations.replaced).toBeGreaterThanOrEqual(1);
		const config = text(here.agentDir, "config.yml");
		expect(config).toBe(text(old.agentDir, "config.yml"));
		expect(existsSync(join(here.agentDir, "skills", "mine", "SKILL.md"))).toBe(true);
		expect(JSON.parse(text(here.dataDir, "favorite-models.json"))).toEqual(["anthropic/model-a", "local/model"]);
		const db = new Database(join(here.agentDir, "history.db"), { readonly: true });
		expect(db.query("SELECT use_count FROM history WHERE prompt = 'explain the zebra protocol'").get()).toEqual({
			use_count: 2,
		});
		expect(db.query("SELECT prompt FROM history WHERE prompt = 'only on this mac'").all()).toHaveLength(1);
		db.close();
		// What was replaced was copied first.
		expect(readFileSync(join(summary.backup as string, "files", mine), "utf8")).toContain("local words");
		stopMachine(old);
		stopMachine(here);
	});

	test("the same conversation under another folder name is kept once, and a conversation a terminal's omp holds is not replaced", async () => {
		const old = seedMachine(join(root, "k1"), "jdoe");
		const here = seedMachine(join(root, "k2"), "alice", { rich: false });
		const { file } = await exportOf(old);
		// Here it lives in a folder of another name.
		const elsewhere = sessionPath(here, SESSION_ID, "--other-place--");
		mkdirSync(join(here.agentDir, "sessions", "--other-place--"), { recursive: true });
		writeFileSync(elsewhere, "here first\n");
		const merged = await importInto(here, file);
		expect(readFileSync(elsewhere, "utf8")).toBe("here first\n");
		expect(existsSync(sessionPath(here, SESSION_ID))).toBe(false);
		expect(merged.conversations.kept).toBe(1);
		// In replace, it is that file that takes the archive's content, so there is still one.
		const held: string[] = [];
		const kept = await importInto(
			here,
			file,
			{ mode: "replace" },
			{
				openElsewhere: async (id) => {
					held.push(id);
					return true;
				},
			},
		);
		expect(held).toContain(SESSION_ID);
		expect(readFileSync(elsewhere, "utf8")).toBe("here first\n");
		expect(kept.notes.some((n) => n.code === "openElsewhere")).toBe(true);
		await importInto(here, file, { mode: "replace" });
		expect(readFileSync(elsewhere, "utf8")).toContain("Alpha session turn 3");
		expect(existsSync(sessionPath(here, SESSION_ID))).toBe(false);
		stopMachine(old);
		stopMachine(here);
	});

	test("conversations that are working are not interrupted: nothing is written, and idle ones are ended first", async () => {
		const old = seedMachine(join(root, "q1"), "jdoe");
		const here = seedMachine(join(root, "q2"), "alice", { rich: false });
		const { file } = await exportOf(old);
		const before = treeOf(here.home);
		expect(await codeOf(() => importInto(here, file, {}, { busy: () => 2 }))).toBe("migrateWorking");
		expect(treeOf(here.home)).toEqual(before);
		let ended = 0;
		const summary = await importInto(here, file, {}, { endIdle: async () => ++ended + 1 });
		expect(ended).toBe(1);
		expect(summary.notes).toContainEqual({ code: "liveEnded", params: { count: 2 } });
		stopMachine(old);
		stopMachine(here);
	});
});

describe("other places conversations live", () => {
	test("a --profile's agent directory and a --session-dir folder move with their paths", async () => {
		const old = seedMachine(join(root, "p1"), "jdoe", { rich: false });
		const agent = seedProfile(old, "work");
		const dir = seedSessionDir(old, "chats");
		const { file, manifest } = await exportOf(old);
		expect(manifest.profiles).toEqual(["work"]);
		expect(manifest.sessionDirs).toEqual([{ index: 0, dir }]);
		const fresh = seedMachine(join(root, "p2"), "alice", { rich: false });
		const summary = await importInto(fresh, file);
		const cwd = (f: string) =>
			JSON.parse(
				readFileSync(f, "utf8")
					.split("\n")
					.find((l) => l.includes('"session"')) as string,
			).cwd;
		const profile = join(fresh.home, ".omp", "profiles", "work", "agent");
		expect(readdirSync(join(profile, "sessions", "-work-proj"))).toHaveLength(1);
		expect(cwd(join(profile, "sessions", "-work-proj", readdirSync(join(profile, "sessions", "-work-proj"))[0]))).toBe(
			join(fresh.home, "work-proj"),
		);
		expect(text(profile, "config.yml")).toBe(`profileSetting: ${fresh.home}/profile-data\n`);
		const chats = join(fresh.dataDir, "session-dirs", "0");
		expect(cwd(join(chats, readdirSync(chats)[0]))).toBe(join(fresh.home, "chat-proj"));
		expect(existsSync(join(fresh.home, "chats"))).toBe(false);
		expect(summary.conversations.added).toBe(2);
		expect(agent).toContain("work");
		stopMachine(old);
		stopMachine(fresh);
	});

	test("the folders this app started omp in are listed where they were moved to: this app's own folder", async () => {
		const old = seedMachine(join(root, "s1"), "jdoe", { rich: false });
		const dir = seedSessionDir(old, "chats");
		writeFileSync(
			join(old.dataDir, "session-roots.json"),
			JSON.stringify({ roots: [{ dir, kind: "session-dir", name: dir, agentDir: old.agentDir, usedAt: 5 }] }),
		);
		const { file } = await exportOf(old);
		const fresh = seedMachine(join(root, "s2"), "alice", { rich: false });
		await importInto(fresh, file);
		expect(JSON.parse(text(fresh.dataDir, "session-roots.json")).roots).toEqual([
			{
				dir: join(fresh.dataDir, "session-dirs", "0"),
				kind: "session-dir",
				name: join(fresh.dataDir, "session-dirs", "0"),
				agentDir: fresh.agentDir,
				usedAt: 5,
			},
		]);
		stopMachine(old);
		stopMachine(fresh);
	});
});

describe("an archive that cannot be trusted", () => {
	async function made(tag: string) {
		const old = seedMachine(join(root, tag), "jdoe");
		const { file } = await exportOf(old);
		stopMachine(old);
		return file;
	}

	test("a file that is no archive at all, an empty one and a cut-off one are refused with a reason each", async () => {
		const file = await made("x1");
		const junk = join(root, "junk.ompw");
		writeFileSync(junk, "just some text, not a zip file at all");
		expect(await codeOf(() => ImportArchive.open(junk))).toBe("migrateNotArchive");
		const empty = join(root, "empty.ompw");
		writeFileSync(empty, "");
		expect(await codeOf(() => ImportArchive.open(empty))).toBe("migrateNotArchive");
		const whole = readFileSync(file);
		const cut = join(root, "cut.ompw");
		writeFileSync(cut, whole.subarray(0, Math.floor(whole.length / 2)));
		expect(await codeOf(() => ImportArchive.open(cut))).toBe("migrateCorrupt");
	});

	test("a byte changed anywhere in a file is found, with the file's name, before anything is written", async () => {
		const file = await made("x2");
		const { ZipReader } = await import("../../server/migrate/zip.ts");
		const zip = await ZipReader.open(file);
		const victim = zip.entries.find((e) => e.name.endsWith("0-Scout.jsonl")) as {
			name: string;
			offset: number;
			compressedSize: number;
		};
		await zip.close();
		const bytes = readFileSync(file);
		// The data is after the local header (30 bytes, the name, an extra field): the middle of the entry is in it.
		bytes[victim.offset + 30 + victim.name.length + 32 + Math.floor(victim.compressedSize / 2)] ^= 0xff;
		const damaged = join(root, "damaged.ompw");
		writeFileSync(damaged, bytes);
		const here = seedMachine(join(root, "x2b"), "alice", { rich: false });
		const before = treeOf(here.home);
		const archive = await ImportArchive.open(damaged);
		let error: unknown;
		try {
			await archive.verify({ signal: new AbortController().signal, onProgress: () => {} });
		} catch (e) {
			error = e;
		}
		await archive.close();
		expect(error).toBeInstanceOf(CodedError);
		expect((error as CodedError).code).toBe("migrateCorrupt");
		expect((error as CodedError).params.file).toBe(victim.name);
		expect(treeOf(here.home)).toEqual(before);
		stopMachine(here);
	});

	test("a file that was replaced by another of the same size, with its own checksum inside the zip, is found by the manifest's", async () => {
		const old = seedMachine(join(root, "x2c"), "jdoe");
		const { file } = await exportOf(old);
		const { ZipReader, ZipWriter } = await import("../../server/migrate/zip.ts");
		const zip = await ZipReader.open(file);
		const forged = join(root, "swapped.ompw");
		const writer = await ZipWriter.create(forged);
		for (const e of zip.entries) {
			const bytes = Buffer.from(await zip.bytes(e.name));
			// The same length, other letters: the zip is whole and consistent with itself; only the manifest knows better.
			if (e.name === "agent/AGENTS.md") bytes.write("# Evil", 0);
			await writer.add(e.name, bytes);
		}
		await writer.finish();
		await zip.close();
		const archive = await ImportArchive.open(forged);
		let error: unknown;
		try {
			await archive.verify({ signal: new AbortController().signal, onProgress: () => {} });
		} catch (e) {
			error = e;
		}
		await archive.close();
		expect(error).toBeInstanceOf(CodedError);
		expect([(error as CodedError).code, (error as CodedError).params.file]).toEqual([
			"migrateCorrupt",
			"agent/AGENTS.md",
		]);
		stopMachine(old);
	});

	test("an archive from a newer omp-webui is refused, and one from a newer omp is allowed with a warning", async () => {
		const old = seedMachine(join(root, "x3"), "jdoe");
		const { file, manifest } = await exportOf(old);
		const { ZipReader, ZipWriter } = await import("../../server/migrate/zip.ts");
		const zip = await ZipReader.open(file);
		const forged = join(root, "newer.ompw");
		const writer = await ZipWriter.create(forged);
		for (const e of zip.entries) {
			if (e.name === "manifest.json")
				await writer.add(e.name, Buffer.from(JSON.stringify({ ...manifest, format: 99 })));
			else await writer.add(e.name, await zip.bytes(e.name));
		}
		await writer.finish();
		await zip.close();
		expect(await codeOf(() => ImportArchive.open(forged))).toBe("migrateNewerFormat");
		const archive = await ImportArchive.open(file);
		const preview = await archive.preview({
			loc: {
				home: join(root, "x3b"),
				agentDir: join(root, "x3b", ".omp", "agent"),
				dataDir: join(root, "x3b", "d"),
				sessionDirs: [],
			},
			ompVersion: "18.11.0",
			serverVersion: "0.11.0",
			backups: "",
			tmp: "",
			signal: new AbortController().signal,
			onProgress: () => {},
			hooks: { busy: () => 0, endIdle: async () => 0, openElsewhere: async () => false },
		});
		await archive.close();
		expect(preview.warnings.map((w) => w.code).sort()).toEqual(["homeDiffers", "ompNewer", "webuiNewer"]);
		expect(preview.source).toMatchObject({ host: "old-mac", ompVersion: "18.12.5", serverVersion: "0.11.9" });
		expect(preview.credentials).toBe(false);
		stopMachine(old);
	});

	test("a manifest that names a place outside this Mac's folders, or a file the archive lacks, is refused", async () => {
		const old = seedMachine(join(root, "x4"), "jdoe");
		const { file, manifest } = await exportOf(old);
		const { ZipReader, ZipWriter } = await import("../../server/migrate/zip.ts");
		const zip = await ZipReader.open(file);
		const forge = async (name: string, change: (m: typeof manifest) => typeof manifest, skip?: string) => {
			const out = join(root, name);
			const writer = await ZipWriter.create(out);
			for (const e of zip.entries) {
				if (e.name === skip) continue;
				if (e.name === "manifest.json")
					await writer.add(e.name, Buffer.from(JSON.stringify(change(structuredClone(manifest)))));
				else await writer.add(e.name, await zip.bytes(e.name));
			}
			await writer.finish();
			return out;
		};
		const outside = await forge("escape.ompw", (m) => ({
			...m,
			entries: m.entries.map((e, i) => (i === 0 ? { ...e, path: "agent/../../../outside" } : e)),
		}));
		expect(await codeOf(() => ImportArchive.open(outside))).toBe("migrateCorrupt");
		const unknown = await forge("unknown.ompw", (m) => ({
			...m,
			entries: m.entries.map((e, i) => (i === 0 ? { ...e, path: "etc/passwd" } : e)),
		}));
		expect(await codeOf(() => ImportArchive.open(unknown))).toBe("migrateCorrupt");
		const link = await forge("link.ompw", (m) => ({
			...m,
			entries: [
				...m.entries,
				{
					path: "agent/sessions/evil",
					category: "conversations",
					kind: "symlink",
					size: 0,
					sha256: "",
					mode: 0o777,
					mtimeMs: 0,
					target: "/etc",
				},
			],
		}));
		expect(await codeOf(() => ImportArchive.open(link))).toBe("migrateCorrupt");
		const lacking = await forge("lacking.ompw", (m) => m, "agent/config.yml");
		expect(await codeOf(() => ImportArchive.open(lacking))).toBe("migrateCorrupt");
		await zip.close();
		stopMachine(old);
	});
});

describe("an export that is stopped", () => {
	test("in the middle of the copy leaves no archive, no part of one and no scratch files, and the machine as it was", async () => {
		const old = seedMachine(join(root, "c2"), "jdoe");
		const before = treeOf(old.home);
		const files = readdirSync(root);
		const stop = new AbortController();
		let seen = 0;
		expect(
			await codeOf(() =>
				exportOf(old, {
					signal: stop.signal,
					onProgress: (p) => {
						if (p.current && ++seen === 12) stop.abort();
					},
				}),
			),
		).toBe("other:Cancelled");
		expect(seen).toBeGreaterThanOrEqual(12);
		// Whatever it made (the archive, its part, its scratch folder) is gone.
		expect(readdirSync(root).filter((n) => !files.includes(n))).toEqual([]);
		expect(treeOf(old.home)).toEqual(before);
		stopMachine(old);
	});

	test("before it starts leaves no archive, no part of one and no scratch files behind", async () => {
		const old = seedMachine(join(root, "c1"), "jdoe");
		const stop = new AbortController();
		stop.abort();
		expect(await codeOf(() => exportOf(old, { signal: stop.signal }))).toBe("other:Cancelled");
		expect(readdirSync(root).filter((n) => n.startsWith("archive-") && !n.endsWith(".ompw"))).toEqual([]);
		expect(readdirSync(root).filter((n) => n.endsWith(".part"))).toEqual([]);
		stopMachine(old);
	});
});
