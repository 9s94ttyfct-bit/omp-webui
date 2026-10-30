import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { absoluteBucket, homeBucket } from "../../server/migrate/rewrite.ts";
import { ZipReader } from "../../server/migrate/zip.ts";
import type { ImportSummary } from "../../shared/migrate.ts";
import { scratch, text, treeOf } from "../support/migrate-run.ts";
import {
	FORK_ID,
	LEGACY_ID,
	type Machine,
	SECRETS,
	SESSION_ID,
	seedMachine,
	stopMachine,
	TMP_ID,
} from "../support/migrate-world.ts";

/**
 * A person moves from one made-up machine to another whose home folder has another name: what the archive holds, what
 * it leaves out, what an import makes of it (#572).
 */

const { root, remove, exportOf, importInto } = scratch();
afterAll(remove);

const tree = (dir: string): string[] => Object.keys(treeOf(dir)).sort();

describe("what an archive holds", () => {
	let old: Machine;
	beforeAll(() => {
		old = seedMachine(join(root, "a"), "jdoe");
	});
	afterAll(() => stopMachine(old));

	test("every category is in it, the caches and per-machine state are not, and the manifest says why", async () => {
		const { manifest } = await exportOf(old);
		const paths = manifest.entries.map((e) => e.path);
		for (const wanted of [
			`agent/sessions/${homeBucket(join(old.home, "proj"), old.home)}/2026-01-05T10-00-00-000Z_${SESSION_ID}.jsonl`,
			`agent/sessions/${homeBucket(join(old.home, "proj"), old.home)}/2026-01-05T10-00-00-000Z_${SESSION_ID}/0-Scout.jsonl`,
			"agent/history.db",
			"agent/memories/mnemopi/mnemopi.db",
			"agent/config.yml",
			"agent/models.yml",
			"agent/mcp.json",
			"agent/lsp.json",
			"agent/AGENTS.md",
			"agent/skills/demo/SKILL.md",
			"agent/session-pins.json",
			"omp/plugins/installed_plugins.json",
			"omp/plugins/cache/plugins/market___tool___1.0.0/package.json",
			"omp/plugins/node_modules/tool",
			"omp/marketplaces.json",
			"webui/ui-prefs.json",
			"webui/remote.json",
			"webui/archived.json",
		]) {
			expect(paths).toContain(wanted);
		}
		const left = Object.fromEntries(manifest.leftOut.map((l) => [l.path.replace(old.home, "~"), l.reason]));
		expect(left["~/.omp/agent/cache"]).toBe("cache");
		expect(left["~/.omp/agent/models.db"]).toBe("rebuilt");
		expect(left["~/.omp/agent/terminal-sessions"]).toBe("machine");
		expect(left["~/.omp/install-id"]).toBe("machine");
		expect(left["~/.omp/stats.db"]).toBe("rebuilt");
		expect(left["~/.omp/logs"]).toBe("runtime");
		expect(left["~/.omp/plugins/cache/marketplaces"]).toBe("redownload");
		expect(left["~/.omp-webui/index.db"]).toBe("rebuilt");
		expect(left["~/.omp-webui/token"]).toBe("machine");
		// The Web Push key and its subscriptions stay on this computer (they are not "unknown", which would be listed to the person).
		expect(left["~/.omp-webui/push-vapid.json"]).toBe("machine");
		expect(left["~/.omp-webui/push-devices.json"]).toBe("machine");
		// The list of other Macs names this computer's sign-in stores: it stays too, and is listed as machine state, not as unknown.
		expect(left["~/.omp-webui/remote-macs.json"]).toBe("machine");
		expect(paths.some((p) => p.includes("remote-macs"))).toBe(false);
		expect(paths.some((p) => p.includes("push-"))).toBe(false);
		// The helper conversations' own scratch memories are not the person's.
		expect(Object.keys(left).some((p) => p.includes("ompw-context"))).toBe(true);
		expect(paths.some((p) => p.includes("ompw-context"))).toBe(false);
		// And no login is among them.
		expect(paths).not.toContain("agent/agent.db");
		expect(paths).not.toContain("agent/secrets.yml");
		expect(manifest.credentials.included).toBe(false);
	});

	test("a database that a running omp holds open is copied whole, with what is only in its -wal", async () => {
		const { file } = await exportOf(old);
		const zip = await ZipReader.open(file);
		const bytes = await zip.bytes("agent/history.db");
		await zip.close();
		const copy = join(root, "history-copy.db");
		writeFileSync(copy, bytes);
		const db = new Database(copy, { readonly: true });
		expect(db.query("SELECT COUNT(*) AS n FROM history").get()).toEqual({ n: 3 });
		expect(db.query("SELECT rowid FROM history_fts WHERE history_fts MATCH 'zebra'").all()).toHaveLength(1);
		db.close();
	});

	test("a transcript that is being written is copied up to its last complete line", async () => {
		const grown = seedMachine(join(root, "grow"), "jdoe");
		const file = join(
			grown.agentDir,
			"sessions",
			homeBucket(join(grown.home, "proj"), grown.home) as string,
			`2026-01-05T10-00-00-000Z_${SESSION_ID}.jsonl`,
		);
		const whole = readFileSync(file, "utf8");
		writeFileSync(file, `${whole}{"type":"message","id":"half","text":"cut in the mid`);
		const { file: archive } = await exportOf(grown);
		const zip = await ZipReader.open(archive);
		const copied = Buffer.from(
			await zip.bytes(
				`agent/sessions/${homeBucket(join(grown.home, "proj"), grown.home)}/2026-01-05T10-00-00-000Z_${SESSION_ID}.jsonl`,
			),
		).toString("utf8");
		await zip.close();
		stopMachine(grown);
		expect(copied.endsWith("\n")).toBe(true);
		expect(copied).not.toContain("cut in the mid");
		expect(
			copied
				.split("\n")
				.filter(Boolean)
				.every((l) => JSON.parse(l)),
		).toBe(true);
	});

	test("without credentials no secret is in the archive, in any entry or anywhere in the file", async () => {
		const { file, manifest } = await exportOf(old);
		const raw = readFileSync(file).toString("latin1");
		const zip = await ZipReader.open(file);
		const everything: string[] = [raw];
		for (const e of zip.entries) everything.push(Buffer.from(await zip.bytes(e.name)).toString("latin1"));
		await zip.close();
		for (const secret of [
			SECRETS.apiKey,
			SECRETS.bearer,
			SECRETS.envToken,
			SECRETS.oauth,
			SECRETS.loginKey,
			SECRETS.secretsYml,
			"MIIBsecretcertificate",
			"tunnelsecret0123",
		]) {
			expect(everything.some((t) => t.includes(secret))).toBe(false);
		}
		expect(manifest.secretFiles.map((f) => f.path.replace(old.home, "~")).sort()).toEqual([
			"~/.omp/agent/mcp.json",
			"~/.omp/agent/models.yml",
		]);
		// The rest of those files is as it was.
		const reader = await ZipReader.open(file);
		const models = Buffer.from(await reader.bytes("agent/models.yml")).toString("utf8");
		await reader.close();
		expect(models).toContain("baseUrl: http://127.0.0.1:8000/v1");
		expect(models).toContain('apiKey: ""');
		expect(
			manifest.leftOut
				.filter((l) => l.reason === "secret")
				.map((l) => l.path.replace(old.home, "~"))
				.sort(),
		).toEqual([
			"~/.cloudflared/01234567-89ab-cdef-0123-456789abcdef.json",
			"~/.cloudflared/cert.pem",
			"~/.omp/agent/agent.db",
			"~/.omp/agent/secrets.yml",
		]);
	});

	test("with credentials the logins are in the archive, encrypted, and only there", async () => {
		const { file, manifest } = await exportOf(old, { credentials: true, password: "correct horse battery" });
		expect(manifest.credentials.included).toBe(true);
		const raw = readFileSync(file).toString("latin1");
		const zip = await ZipReader.open(file);
		const names = zip.entries.map((e) => e.name);
		expect(names).toContain("credentials.enc");
		const everything: string[] = [raw];
		for (const e of zip.entries) everything.push(Buffer.from(await zip.bytes(e.name)).toString("latin1"));
		await zip.close();
		for (const secret of [
			SECRETS.apiKey,
			SECRETS.bearer,
			SECRETS.envToken,
			SECRETS.oauth,
			SECRETS.loginKey,
			SECRETS.secretsYml,
			"MIIBsecretcertificate",
			"tunnelsecret0123",
			"correct horse",
		]) {
			expect(everything.some((t) => t.includes(secret))).toBe(false);
		}
		expect(manifest.leftOut.some((l) => l.reason === "secret")).toBe(false);
	});
});

describe("moving to a machine with another home folder", () => {
	let old: Machine;
	let fresh: Machine;
	let summary: ImportSummary;
	let archive: string;
	beforeAll(async () => {
		old = seedMachine(join(root, "b"), "jdoe");
		fresh = seedMachine(join(root, "c"), "alice", { rich: false });
		archive = (await exportOf(old)).file;
		summary = await importInto(fresh, archive);
	});
	afterAll(() => {
		stopMachine(old);
		stopMachine(fresh);
	});

	const proj = (m: Machine) => join(m.home, "proj");
	const sessionFile = (m: Machine, bucket: string, id: string) =>
		join(m.agentDir, "sessions", bucket, `2026-01-05T10-00-00-000Z_${id}.jsonl`);
	const header = (file: string) =>
		JSON.parse(
			text(file)
				.split("\n")
				.find((l) => l.includes('"type":"session"')) as string,
		);

	test("a conversation's recorded folder is the new home's, and its file is where omp looks for it", () => {
		const bucket = homeBucket(proj(fresh), fresh.home) as string;
		expect(bucket).toBe("-proj");
		const file = sessionFile(fresh, bucket, SESSION_ID);
		expect(header(file).cwd).toBe(proj(fresh));
		// Nothing of the old home is left in what omp reads to find the folder.
		expect(text(file)).not.toContain(old.home);
		// The rest of the transcript is byte for byte what it was.
		const oldLines = text(sessionFile(old, bucket, SESSION_ID)).split("\n");
		const newLines = text(file).split("\n");
		expect(newLines[0]).toBe(oldLines[0]);
		expect(newLines.slice(2)).toEqual(oldLines.slice(2));
		// A fork names its parent by path: the path is the new one.
		expect(header(sessionFile(fresh, bucket, FORK_ID)).parentSession).toBe(sessionFile(fresh, bucket, SESSION_ID));
	});

	test("the file's time is kept (the sidebar orders conversations by it)", () => {
		const file = sessionFile(fresh, "-proj", SESSION_ID);
		expect(statSync(file).mtime.toISOString()).toBe("2026-02-03T04:05:06.000Z");
	});

	test("a folder omp named after a whole path under the old home is named for the new one", () => {
		const legacyNew = join(fresh.home, "legacy");
		const bucket = homeBucket(legacyNew, fresh.home) as string;
		expect(bucket).toBe("-legacy");
		expect(existsSync(sessionFile(fresh, bucket, LEGACY_ID))).toBe(true);
		expect(header(sessionFile(fresh, bucket, LEGACY_ID)).cwd).toBe(legacyNew);
		expect(existsSync(join(fresh.agentDir, "sessions", absoluteBucket(join(old.home, "legacy"))))).toBe(false);
	});

	test("a conversation outside the home folder is where it was, and its subagents and images came along", () => {
		const outside = join(root, "b", "elsewhere", "tmpproj");
		const bucket = absoluteBucket(outside);
		expect(header(sessionFile(fresh, bucket, TMP_ID)).cwd).toBe(outside);
		const nested = join(fresh.agentDir, "sessions", "-proj", `2026-01-05T10-00-00-000Z_${SESSION_ID}`);
		expect(existsSync(join(nested, "0-Scout.jsonl"))).toBe(true);
		expect(header(join(nested, "0-Scout.jsonl")).cwd).toBe(proj(fresh));
		expect(text(nested, "artifact-1.md")).toBe("# found\nnothing\n");
		expect(tree(join(fresh.agentDir, "blobs"))).toHaveLength(1);
	});

	test("history, with the folders in it, and what omp keeps about a conversation, are the new machine's", () => {
		const db = new Database(join(fresh.agentDir, "history.db"), { readonly: true });
		expect(db.query("SELECT prompt, cwd, use_count FROM history ORDER BY id").all()).toEqual([
			{ prompt: "explain the zebra protocol", cwd: proj(fresh), use_count: 2 },
			{ prompt: "wombat routing question", cwd: join(root, "b", "elsewhere", "tmpproj"), use_count: 1 },
			{ prompt: "a question from another folder", cwd: join(fresh.home, "histonly"), use_count: 1 },
		]);
		expect(db.query("SELECT rowid FROM history_fts WHERE history_fts MATCH 'wombat'").all()).toHaveLength(1);
		expect(db.query("SELECT cwd FROM session_recaps").all()).toEqual([{ cwd: proj(fresh) }]);
		expect(db.query("SELECT title FROM session_titles").all()).toEqual([{ title: "Alpha session" }]);
		db.close();
	});

	test("memory banks follow their folder to its new path; this app's scratch banks and unknown ones are treated as what they are", () => {
		const banks = join(fresh.agentDir, "memories", "mnemopi", "banks");
		const names = readdirSync(banks).sort();
		expect(names).toContain(`proj-${Bun.hash(proj(fresh)).toString(36)}`);
		expect(names).not.toContain(`proj-${Bun.hash(proj(old)).toString(36)}`);
		// A bank of a folder that only the prompt history remembers is found by it.
		const onlyNew = join(fresh.home, "histonly");
		expect(names).toContain(`histonly-${Bun.hash(onlyNew).toString(36)}`);
		expect(names).not.toContain(`histonly-${Bun.hash(join(old.home, "histonly")).toString(36)}`);
		expect(names).toContain("mystery-1abcdefgh");
		expect(names.some((n) => n.startsWith("ompw-"))).toBe(false);
		const db = new Database(join(banks, `proj-${Bun.hash(proj(fresh)).toString(36)}`, "mnemopi.db"), {
			readonly: true,
		});
		expect(db.query("SELECT content FROM working_memory").all()).toEqual([{ content: "project memory" }]);
		db.close();
		expect(
			new Database(join(fresh.agentDir, "memories", "mnemopi", "mnemopi.db"), { readonly: true })
				.query("SELECT content FROM working_memory")
				.all(),
		).toEqual([{ content: "global memory" }]);
		expect(summary.notes.some((n) => n.code === "banksRenamed")).toBe(true);
		expect(summary.notes.some((n) => n.code === "banksKept")).toBe(true);
	});

	test("settings keep their comments and layout, with the old home replaced by the new one", () => {
		expect(text(fresh.agentDir, "config.yml")).toBe(text(old.agentDir, "config.yml"));
		expect(text(fresh.agentDir, "lsp.json")).toContain(`${fresh.home}/go/bin/gopls`);
		expect(text(fresh.agentDir, "lsp.json")).not.toContain(old.home);
		expect(text(fresh.agentDir, "AGENTS.md")).toContain(`${fresh.home}/notes`);
		expect(text(fresh.agentDir, "models.yml")).toContain(`command: ${fresh.home}/bin/serve-models`);
		const mcp = JSON.parse(text(fresh.agentDir, "mcp.json"));
		expect(mcp.mcpServers.blender.command).toBe(`${fresh.home}/.local/bin/blender-mcp`);
		expect(text(fresh.agentDir, "skills", "demo", "SKILL.md")).toBe(text(old.agentDir, "skills", "demo", "SKILL.md"));
	});

	test("what still points at the old machine is listed: a path that is not on this one", () => {
		const missing = summary.oldMachine.filter((v) => v.why === "missing").map((v) => `${v.file}:${v.key}=${v.value}`);
		expect(missing).toContain(`~/.omp/agent/lsp.json:servers.gopls.command=${fresh.home}/go/bin/gopls`);
		expect(summary.oldMachine.some((v) => v.why === "home")).toBe(false);
		expect(summary.oldMachineCount).toBeGreaterThanOrEqual(3);
	});

	test("plugins: the registry names this home, the links are made again and point at what came along", () => {
		const registry = JSON.parse(text(fresh.home, ".omp", "plugins", "installed_plugins.json"));
		const installed = join(fresh.home, ".omp", "plugins", "cache", "plugins", "market___tool___1.0.0");
		expect(registry.plugins["tool@market"][0].installPath).toBe(installed);
		const link = join(fresh.home, ".omp", "plugins", "node_modules", "tool");
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(readlinkSync(link)).toBe(installed);
		expect(existsSync(join(link, "package.json"))).toBe(true);
		expect(text(fresh.home, ".omp", "marketplaces.json")).toContain(
			`${fresh.home}/.omp/plugins/cache/marketplaces/market`,
		);
		// A catalogue is downloaded again; it is not carried.
		expect(existsSync(join(fresh.home, ".omp", "plugins", "cache", "marketplaces"))).toBe(false);
	});

	test("this app's own data: paths rewritten, preferences kept, remote access off", () => {
		const archived = JSON.parse(text(fresh.dataDir, "archived.json")) as string[];
		// A conversation whose folder was named from a whole path under the old home is archived under its new folder's name.
		expect(archived).toEqual([sessionFile(fresh, "-proj", FORK_ID), sessionFile(fresh, "-legacy", LEGACY_ID)]);
		const approval = JSON.parse(text(fresh.dataDir, "approval.json"));
		expect(Object.keys(approval.sessions)).toEqual([sessionFile(fresh, "-proj", SESSION_ID)]);
		const prefs = JSON.parse(text(fresh.dataDir, "ui-prefs.json"));
		expect(prefs.values["ompw.theme"]).toBe("dark");
		expect(prefs.values["ompw.cwd"]).toBe(proj(fresh));
		expect(prefs.id).not.toBe("prefs-id-old");
		expect(JSON.parse(text(fresh.agentDir, "session-pins.json"))).toEqual([SESSION_ID]);
		const remote = JSON.parse(text(fresh.dataDir, "remote.json"));
		expect(remote).toMatchObject({ enabled: false, autostart: false, hostname: "omp.example.com", team: "my-team" });
		// Its tunnel's credentials did not come: its id is of no use here.
		expect(remote.tunnelId).toBeUndefined();
		expect(summary.notes.some((n) => n.code === "remoteOff")).toBe(true);
		expect(existsSync(join(fresh.dataDir, "token"))).toBe(false);
		expect(existsSync(join(fresh.dataDir, "push-vapid.json"))).toBe(false);
		expect(existsSync(join(fresh.dataDir, "index.db"))).toBe(false);
	});

	test("no login came: the archive had none, and the person is told what was blanked", () => {
		expect(existsSync(join(fresh.agentDir, "agent.db"))).toBe(false);
		expect(existsSync(join(fresh.agentDir, "secrets.yml"))).toBe(false);
		expect(existsSync(join(fresh.home, ".cloudflared"))).toBe(false);
		expect(summary.credentials).toMatchObject({ restored: false, reason: "absent" });
		expect(summary.notes.find((n) => n.code === "secretsBlanked")?.params.count).toBe(3);
		expect(text(fresh.agentDir, "models.yml")).toContain('apiKey: ""');
	});

	test("the summary counts what was added; nothing existed, so there is no backup", () => {
		expect(summary.conversations).toEqual({ added: 4, kept: 0, updated: 0, replaced: 0 });
		expect(summary.backup).toBeNull();
		expect(summary.rewrittenFolders).toBe(3);
		expect(summary.missingFolderCount).toBe(3);
		expect(summary.missingFolders).toContain(proj(fresh));
		expect(existsSync(join(fresh.dataDir, "migration-backups"))).toBe(false);
	});
});
