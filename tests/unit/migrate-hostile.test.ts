import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { LivePool } from "../../server/live.ts";
import { encrypt } from "../../server/migrate/crypto.ts";
import { ImportArchive } from "../../server/migrate/import.ts";
import { restoreBackup } from "../../server/migrate/restore.ts";
import { MigrateService } from "../../server/migrate/service.ts";
import { sweepMigrateDir } from "../../server/migrate/sweep.ts";
import { ZipWriter } from "../../server/migrate/zip.ts";
import { CodedError } from "../../shared/error-info.ts";
import type { ImportStatus } from "../../shared/migrate.ts";
import { fakeConfig, writeFakeOmp } from "../support/fake-omp.ts";
import { hooks, locationsOf, scratch, text, treeOf } from "../support/migrate-run.ts";
import { type Machine, SESSION_ID, seedMachine, seedSession, stopMachine } from "../support/migrate-world.ts";
import { pollUntil } from "../support/poll.ts";

/**
 * Archives that somebody made on purpose to do harm, and what happens to the Mac they are opened on (#572, the security
 * review): nothing is written outside omp's and this app's folders, whatever the manifest says; secrets that a Mac asked
 * to keep out are out; a failed import can be undone; a hostile size cannot take the server's memory or the disk.
 */

const { root, remove, exportOf, importInto } = scratch();
afterAll(remove);

const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
let counter = 0;

interface Forge {
	/** Files that are in the archive and named by the manifest (as conversations: the category does not matter). */
	files?: Record<string, string | Buffer>;
	/** Entries the manifest names as they are written (no file is made for them). */
	entries?: Record<string, unknown>[];
	sessionDirs?: { index: number; dir: string }[];
	bundle?: { files: unknown[]; password: string };
	/** The sentence the first lines of the manifest hold about the machine it comes from. */
	home?: string;
}

/** An archive the exporter would never make: its manifest says what the forger wants. */
async function forge(f: Forge): Promise<string> {
	const file = join(root, `forged-${counter++}.ompw`);
	const zw = await ZipWriter.create(file);
	const entries: Record<string, unknown>[] = [];
	for (const [path, data] of Object.entries(f.files ?? {})) {
		const b = Buffer.from(data);
		await zw.add(path, b);
		const config = path.startsWith("webui/");
		entries.push({
			path,
			category: config ? "webui" : "conversations",
			kind: config ? "config" : "file",
			size: b.length,
			sha256: sha(b),
			mode: 0o644,
			mtimeMs: 0,
		});
	}
	entries.push(...(f.entries ?? []));
	let credentials: Record<string, unknown> = { included: false };
	if (f.bundle) {
		const sealed = await encrypt(Buffer.from(JSON.stringify({ v: 1, files: f.bundle.files })), f.bundle.password);
		await zw.add("credentials.enc", sealed, { compress: false });
		credentials = { included: true, sha256: sha(sealed), bytes: sealed.length, files: f.bundle.files.length };
	}
	const home = f.home ?? "/Users/attacker";
	const manifest = {
		format: 1,
		app: "omp-webui",
		createdAt: new Date().toISOString(),
		source: {
			host: "evil",
			user: "a",
			home,
			agentDir: `${home}/.omp/agent`,
			dataDir: `${home}/.omp-webui`,
			platform: "darwin",
			ompVersion: "18.12.5",
			serverVersion: "0.11.9",
		},
		sessionDirs: f.sessionDirs ?? [],
		profiles: [],
		entries,
		leftOut: [],
		secretFiles: [],
		skipped: [],
		credentials,
	};
	await zw.add("manifest.json", Buffer.from(JSON.stringify(manifest)));
	await zw.finish();
	return file;
}

async function codeOf(run: () => Promise<unknown>): Promise<string | null> {
	try {
		await run();
		return null;
	} catch (e) {
		return e instanceof CodedError ? e.code : `other:${(e as Error).message}`;
	}
}

function victim(tag: string): Machine {
	return seedMachine(join(root, tag), "victim", { rich: false });
}

describe("a crafted archive cannot write outside omp's and this app's folders", () => {
	test("files under the home folder are refused: it is no place the exporter ever writes to", async () => {
		const here = victim("a1");
		for (const path of [
			"home/.ssh/authorized_keys",
			"home/.zshrc",
			"home/Library/LaunchAgents/com.evil.plist",
			"home/.cloudflared/cert.pem",
		]) {
			const file = await forge({ files: { [path]: "evil\n" } });
			expect(await codeOf(() => importInto(here, file)), path).toBe("migrateCorrupt");
		}
		expect(readdirSync(here.home).sort()).toEqual([".omp", ".omp-webui"]);
		stopMachine(here);
	});

	test("a path the exporter's own rules would not have made is refused, whatever its root", async () => {
		const here = victim("a2");
		const bad = [
			"etc/passwd",
			"agent/../../x",
			"agent/cache/x",
			"agent/terminal-sessions/tty",
			"agent/sessions",
			"agent/unknown-file.bin",
			"agent/skills/x/.env",
			"agent/agent.db",
			"agent/secrets.yml",
			"agent/models.db",
			"agent/config.yml-wal",
			"webui/token",
			"webui/index.db",
			"webui/sub/ui-prefs.json",
			"omp/install-id",
			"omp/stats.db",
			"omp/plugins/logs/x",
			"omp/plugins/cache/marketplaces/m/marketplace.json",
			"omp/bin/omp",
			"profiles/../agent/x",
			"profiles/p/other/x",
			"profiles/p/agent/cache/x",
			"sessiondirs/7/x.jsonl",
			"sessiondirs/0",
		];
		for (const path of bad) {
			// The zip writer refuses names that climb: the manifest is what a forger writes by hand.
			const entry = {
				path,
				category: "conversations",
				kind: "file",
				size: 2,
				sha256: sha(Buffer.from("x\n")),
				mode: 0o644,
				mtimeMs: 0,
			};
			const file = await forge(
				path.includes("..")
					? { entries: [entry], sessionDirs: [{ index: 0, dir: "/Users/attacker/chats" }] }
					: { files: { [path]: "x\n" }, sessionDirs: [{ index: 0, dir: "/Users/attacker/chats" }] },
			);
			expect(await codeOf(() => importInto(here, file)), path).toBe("migrateCorrupt");
		}
		stopMachine(here);
	});

	test("a --session-dir folder of the archive is always this app's own folder, whatever place the manifest names", async () => {
		const here = victim("a3");
		const outside = join(root, "OUTSIDE-the-home-folder");
		mkdirSync(outside, { recursive: true });
		// Places of the victim's own that an archive must never reach: an existing folder or a file that is read at login.
		const targets = [
			outside,
			join(here.home, ".ssh"),
			join(here.home, "Library", "LaunchAgents"),
			join(here.home, ".config"),
			join(here.home, "Documents"),
			here.home,
			join(here.agentDir, "skills"),
			join(here.agentDir, "hooks"),
			"/Users/attacker/chats",
		];
		// A place that is not on this Mac at all is named too; the rest are made, as a victim's folders are.
		for (const dir of targets.filter((d) => d.startsWith(root))) mkdirSync(dir, { recursive: true });
		for (const dir of targets) {
			const file = await forge({
				files: { "sessiondirs/0/authorized_keys": "owned\n", "sessiondirs/0/com.evil.plist": "<plist/>\n" },
				sessionDirs: [{ index: 0, dir }],
			});
			const summary = await importInto(here, file);
			expect([dir, existsSync(join(dir, "authorized_keys")), existsSync(join(dir, "com.evil.plist"))]).toEqual([
				dir,
				false,
				false,
			]);
			expect(text(here.dataDir, "session-dirs", "0", "authorized_keys")).toBe("owned\n");
			expect(summary.notes).toContainEqual({
				code: "sessionDirMoved",
				params: { from: expect.any(String), to: join(here.dataDir, "session-dirs", "0").replace(here.home, "~") },
			});
		}
		expect(readdirSync(join(here.home, ".ssh"))).toEqual([]);
		expect(existsSync(join(here.home, "authorized_keys"))).toBe(false);
		expect(readdirSync(join(here.agentDir, "hooks"))).toEqual([]);
		stopMachine(here);
	});

	test("a project folder that lies under a session folder's old path keeps its path; only the list of session folders is moved", async () => {
		const here = victim("a3b");
		const old = "/Users/attacker/work";
		const transcript = `${JSON.stringify({ type: "session", id: "s1", cwd: `${old}/proj` })}\n`;
		const file = await forge({
			files: {
				"sessiondirs/0/2026-01-05T10-00-00-000Z_0190aaaa-0000-7000-8000-0000000000aa.jsonl": transcript,
				"webui/session-roots.json": JSON.stringify({
					roots: [{ dir: old, kind: "session-dir", name: old, agentDir: "/Users/attacker/.omp/agent", usedAt: 1 }],
				}),
			},
			sessionDirs: [{ index: 0, dir: old }],
		});
		await importInto(here, file);
		const moved = join(here.dataDir, "session-dirs", "0");
		const roots = JSON.parse(text(here.dataDir, "session-roots.json")).roots;
		expect(roots.map((r: { dir: string }) => r.dir)).toEqual([moved]);
		const header = JSON.parse(text(moved, readdirSync(moved)[0]));
		expect(header.cwd).toBe(join(here.home, "work", "proj"));
		stopMachine(here);
	});

	test("a link in the plugins' folder that climbs out of it is refused, and nothing is written through it", async () => {
		const here = victim("a4");
		const plugins = join(here.home, ".omp", "plugins");
		mkdirSync(plugins, { recursive: true });
		const climbing = {
			path: "omp/plugins/node_modules/a",
			category: "plugins",
			kind: "symlink",
			size: 0,
			sha256: "",
			mode: 0o777,
			mtimeMs: 0,
		};
		for (const target of [
			"/Users/attacker/.omp/plugins/../../../..",
			"/etc",
			"/Users/attacker/.omp/plugins-other/x",
			"../../../..",
			"/Users/attacker/.omp/plugins/cache/plugins/../../../../x",
		]) {
			const file = await forge({ entries: [{ ...climbing, target }] });
			expect(await codeOf(() => importInto(here, file)), target).toBe("migrateCorrupt");
			expect(existsSync(join(plugins, "node_modules", "a"))).toBe(false);
		}
		// A real file under node_modules would be written through such a link: none is accepted, link or no link.
		const file = await forge({ files: { "omp/plugins/node_modules/a/pwn.txt": "x\n" } });
		expect(await codeOf(() => importInto(here, file))).toBe("migrateCorrupt");
		expect(existsSync(join(here.home, "..", "pwn.txt"))).toBe(false);
		// A link into the plugins' own cache is what the exporter makes: it is made again for the new home.
		const fine = await forge({
			entries: [{ ...climbing, target: "/Users/attacker/.omp/plugins/cache/plugins/p___q___1" }],
		});
		await importInto(here, fine);
		expect(lstatSync(join(plugins, "node_modules", "a")).isSymbolicLink()).toBe(true);
		expect(readdirSync(join(plugins, "node_modules"))).toEqual(["a"]);
		stopMachine(here);
	});

	test("nothing is written through a link that is already in the plugins' folder", async () => {
		const here = victim("a5");
		const outside = join(root, "OUTSIDE-through-a-link");
		mkdirSync(outside, { recursive: true });
		const plugins = join(here.home, ".omp", "plugins");
		mkdirSync(plugins, { recursive: true });
		symlinkSync(outside, join(plugins, "data"));
		const file = await forge({ files: { "omp/plugins/data/x.txt": "x\n" } });
		const summary = await importInto(here, file);
		expect(existsSync(join(outside, "x.txt"))).toBe(false);
		expect(summary.notes.some((n) => n.code === "fileFailed")).toBe(true);
		stopMachine(here);
	});

	test("the encrypted part is held to the same rules: only the logins' own files, and the tunnel's two", async () => {
		const here = victim("a6");
		const password = "correct horse battery";
		const bundle = {
			password,
			files: [
				{
					path: "home/.ssh/authorized_keys",
					kind: "secret",
					mode: 0o600,
					mtimeMs: 0,
					data: Buffer.from("evil\n").toString("base64"),
				},
				{
					path: "home/.cloudflared/../.zshrc",
					kind: "secret",
					mode: 0o600,
					mtimeMs: 0,
					data: Buffer.from("evil\n").toString("base64"),
				},
				{
					path: "home/.cloudflared/run.sh",
					kind: "secret",
					mode: 0o600,
					mtimeMs: 0,
					data: Buffer.from("evil\n").toString("base64"),
				},
				{
					path: "agent/skills/x/run.sh",
					kind: "secret",
					mode: 0o600,
					mtimeMs: 0,
					data: Buffer.from("evil\n").toString("base64"),
				},
				{
					path: "agent/AGENTS.md",
					kind: "auth",
					mode: 0o600,
					mtimeMs: 0,
					data: Buffer.from("evil\n").toString("base64"),
				},
				{
					path: "home/.cloudflared/cert.pem",
					kind: "secret",
					mode: 0o600,
					mtimeMs: 0,
					data: Buffer.from("cert\n").toString("base64"),
				},
				{
					path: "agent/secrets.yml",
					kind: "secret",
					mode: 0o600,
					mtimeMs: 0,
					data: Buffer.from("- a\n").toString("base64"),
				},
				{
					path: "agent/skills/x/.env",
					kind: "secret",
					mode: 0o600,
					mtimeMs: 0,
					data: Buffer.from("T=1\n").toString("base64"),
				},
			],
		};
		const file = await forge({ bundle });
		const summary = await importInto(here, file, { credentials: true, password });
		expect(readdirSync(here.home).sort()).toEqual([".cloudflared", ".omp", ".omp-webui"]);
		expect(readdirSync(join(here.home, ".cloudflared"))).toEqual(["cert.pem"]);
		expect(text(here.agentDir, "secrets.yml")).toBe("- a\n");
		expect(text(here.agentDir, "skills", "x", ".env")).toBe("T=1\n");
		expect(existsSync(join(here.agentDir, "skills", "x", "run.sh"))).toBe(false);
		expect(existsSync(join(here.agentDir, "AGENTS.md"))).toBe(false);
		expect(summary.credentials.files).toBe(3);
		expect(summary.notes.filter((n) => n.code === "credentialsFailed")).toHaveLength(5);
		stopMachine(here);
	});
});

describe("an import that fails halfway can be undone", () => {
	/** An archive of a machine, and a Mac with a conversation that differs and settings of its own. */
	async function scene(tag: string) {
		const old = seedMachine(join(root, `${tag}1`), "jdoe");
		const { file } = await exportOf(old);
		stopMachine(old);
		const here = seedMachine(join(root, `${tag}2`), "alice", { rich: false });
		writeFileSync(join(here.agentDir, "config.yml"), "theme:\n  dark: mine\n");
		mkdirSync(join(here.agentDir, "sessions", "-proj"), { recursive: true });
		seedSession(here, { id: SESSION_ID, bucket: "-proj", cwd: join(here.home, "proj"), title: "Different", turns: 1 });
		return { file, here };
	}

	/** The service the page talks to, with the archive uploaded and checked. */
	async function uploaded(
		here: Machine,
		file: string,
		over: Partial<ConstructorParameters<typeof MigrateService>[0]> = {},
	) {
		const writing: boolean[] = [];
		const svc = new MigrateService({
			locations: () => locationsOf(here),
			ompVersion: () => "18.12.5",
			serverVersion: "0.11.9",
			hooks: hooks(),
			after: async () => {},
			writing: (on) => writing.push(on),
			json: (data) => new Response(JSON.stringify(data)),
			fail: (error) => new Response(error, { status: 400 }),
			...over,
		});
		const bytes = readFileSync(file);
		await svc.begin("moved.ompw", bytes.length);
		await svc.chunk(0, new Blob([bytes]).stream());
		svc.verify();
		await pollUntil(() => svc.state().import?.state !== "verifying", "the archive to be checked");
		expect(svc.state().import?.state).toBe("ready");
		return { svc, writing };
	}

	async function settled(svc: MigrateService): Promise<ImportStatus> {
		await pollUntil(() => svc.state().import?.state !== "applying", "the import to end");
		return svc.state().import as ImportStatus;
	}

	test("the journal is on disk before each write: a cancelled import leaves its lists, its copies and a note on how to put them back", async () => {
		const { file, here } = await scene("h1");
		const abort = new AbortController();
		const archive = await ImportArchive.open(file);
		await archive.verify({ signal: abort.signal, onProgress: () => {} });
		let n = 0;
		const run = await archive.prepare(
			{ mode: "replace", credentials: false },
			{
				loc: locationsOf(here),
				ompVersion: "18.12.5",
				serverVersion: "0.11.9",
				backups: join(here.dataDir, "migration-backups"),
				tmp: join(root, "h1-tmp"),
				signal: abort.signal,
				hooks: hooks(),
				onProgress: (p) => {
					if (p.current && p.phase === undefined && ++n === 14) abort.abort();
				},
			},
		);
		await expect(run.run()).rejects.toThrow("Cancelled");
		await archive.close();
		const backup = run.backup as string;
		expect(backup.startsWith(join(here.dataDir, "migration-backups"))).toBe(true);
		expect(readFileSync(join(backup, "changed.txt"), "utf8")).toContain(join(here.agentDir, "config.yml"));
		expect(readFileSync(join(backup, "created.txt"), "utf8").length).toBeGreaterThan(0);
		const note = JSON.parse(readFileSync(join(backup, "backup.json"), "utf8"));
		expect(note.status).toBe("incomplete");
		expect(note.restore).toContain("-wal");
		expect(note.restore).toContain("-shm");
		expect(readFileSync(join(backup, "files", join(here.agentDir, "config.yml")), "utf8")).toBe(
			"theme:\n  dark: mine\n",
		);
		stopMachine(here);
	});

	test("a failed import says where its backup is, and Restore puts the Mac back as it was", async () => {
		const { file, here } = await scene("h2");
		const before = treeOf(here.home);
		const { svc, writing } = await uploaded(here, file, {
			hooks: hooks({
				openElsewhere: async () => {
					throw new CodedError("a terminal holds it", "migrateWorking", { count: 1 });
				},
			}),
		});
		await svc.apply({ mode: "replace", credentials: false });
		const failed = await settled(svc);
		expect(failed.state).toBe("failed");
		expect(failed.error?.code).toBe("migrateWorking");
		expect(failed.backup).toBeTruthy();
		// Files were written before it failed.
		expect(text(here.agentDir, "config.yml")).not.toBe("theme:\n  dark: mine\n");
		expect(existsSync(join(here.agentDir, "AGENTS.md"))).toBe(true);
		expect(writing).toEqual([true, false]);

		const restored = await svc.restore();
		expect(restored.restored).toBe(true);
		expect(text(here.agentDir, "config.yml")).toBe("theme:\n  dark: mine\n");
		const ignoring = (t: Record<string, string>) =>
			Object.fromEntries(
				Object.entries(t).filter(([k]) => !k.includes("migration-backups") && !k.includes("/migrate/")),
			);
		expect(ignoring(treeOf(here.home))).toEqual(ignoring(before));
		expect(await codeOf(() => svc.restore())).not.toBeNull();
		await svc.discardImport();
		stopMachine(here);
	});

	test("restoring a database puts back the snapshot and drops the -wal and -shm of the one it replaces", async () => {
		const { here } = await scene("h3");
		const backup = join(here.dataDir, "migration-backups", "x");
		const dest = join(here.agentDir, "history.db");
		mkdirSync(join(backup, "files", here.agentDir), { recursive: true });
		writeFileSync(join(backup, "files", dest), "snapshot");
		writeFileSync(join(backup, "changed.txt"), `${dest}\n`);
		writeFileSync(join(backup, "created.txt"), "");
		writeFileSync(
			join(backup, "backup.json"),
			JSON.stringify({ app: "omp-webui-migration-backup", status: "incomplete" }),
		);
		writeFileSync(dest, "new");
		writeFileSync(`${dest}-wal`, "stale");
		writeFileSync(`${dest}-shm`, "stale");
		await restoreBackup(backup);
		expect(readFileSync(dest, "utf8")).toBe("snapshot");
		expect(existsSync(`${dest}-wal`)).toBe(false);
		expect(existsSync(`${dest}-shm`)).toBe(false);
		stopMachine(here);
	});

	test("only one import is applied: a second request while the first is still deciding is refused", async () => {
		const { file, here } = await scene("h4");
		const { svc } = await uploaded(here, file);
		const first = svc.apply({ mode: "merge", credentials: false });
		const second = svc.apply({ mode: "merge", credentials: false });
		expect(await codeOf(() => second)).toBe("migrateBusy");
		await first;
		expect((await settled(svc)).state).toBe("done");
		await svc.discardImport();
		stopMachine(here);
	});

	test("the preferences it changes are copied first, and the summary and the lists say so", async () => {
		const old = seedMachine(join(root, "h51"), "jdoe");
		const { file } = await exportOf(old);
		stopMachine(old);
		const here = seedMachine(join(root, "h52"), "alice", { rich: false });
		const prefs = JSON.stringify({ id: "mine", rev: 1, values: { "ompw.theme": "light", "ompw.lang": "en" } });
		writeFileSync(join(here.dataDir, "ui-prefs.json"), prefs);
		const summary = await importInto(here, file, { mode: "replace" });
		expect(JSON.parse(text(here.dataDir, "ui-prefs.json")).values["ompw.theme"]).toBe("dark");
		expect(summary.backup).not.toBeNull();
		expect(readFileSync(join(summary.backup as string, "changed.txt"), "utf8")).toContain(
			join(here.dataDir, "ui-prefs.json"),
		);
		expect(readFileSync(join(summary.backup as string, "files", here.dataDir, "ui-prefs.json"), "utf8")).toBe(prefs);
		stopMachine(old);
		stopMachine(here);
	});
});

describe("a hostile size cannot take the server's memory or the disk", () => {
	async function* spaces(mib: number): AsyncGenerator<Buffer> {
		const chunk = Buffer.alloc(1 << 20, 0x20);
		for (let i = 0; i < mib; i++) yield chunk;
		yield Buffer.from("{}");
	}

	test("a manifest of more than 64 MiB is refused without being read", async () => {
		const file = join(root, "bomb.ompw");
		const zw = await ZipWriter.create(file);
		await zw.add("manifest.json", spaces(160));
		await zw.finish();
		const before = process.memoryUsage().rss;
		let peak = before;
		// A measurement, not a wait: the peak is only seen while the manifest is being read.
		const timer = setInterval(() => {
			peak = Math.max(peak, process.memoryUsage().rss);
		}, 5);
		const code = await codeOf(() => ImportArchive.open(file));
		clearInterval(timer);
		expect(code).toBe("migrateCorrupt");
		expect(peak - before).toBeLessThan(100 * 1024 * 1024);
	});

	test("a file that is said to be hundreds of times larger than what is stored is refused, before anything is written", async () => {
		const here = victim("b1");
		const blob = Buffer.alloc(100 * 1024 * 1024);
		const file = await forge({ files: { [`agent/blobs/${"a".repeat(64)}`]: blob } });
		expect(await codeOf(() => importInto(here, file))).toBe("migrateTooLarge");
		expect(Object.keys(treeOf(here.home))).not.toContain("x");
		stopMachine(here);
	});

	test("an archive that would not fit is shown with a warning, and is not applied", async () => {
		const old = seedMachine(join(root, "b21"), "jdoe");
		const { file } = await exportOf(old);
		const here = seedMachine(join(root, "b22"), "alice", { rich: false });
		const archive = await ImportArchive.open(file);
		const env = {
			loc: locationsOf(here),
			ompVersion: "18.12.5",
			serverVersion: "0.11.9",
			backups: join(here.dataDir, "migration-backups"),
			tmp: join(root, "b2-tmp"),
			signal: new AbortController().signal,
			onProgress: () => {},
			hooks: hooks(),
			freeBytes: () => 4096,
		};
		expect((await archive.preview(env)).warnings.map((w) => w.code)).toContain("diskLow");
		await archive.close();
		const before = treeOf(here.home);
		expect(await codeOf(() => importInto(here, file, {}, {}, {}, { freeBytes: () => 4096 }))).toBe("migrateDiskSpace");
		expect(treeOf(here.home)).toEqual(before);
		stopMachine(old);
		stopMachine(here);
	});
});

describe("while an import writes", () => {
	test("no conversation is opened or resumed, and none is as soon as it is over", async () => {
		const dir = join(root, "pool");
		mkdirSync(dir, { recursive: true });
		// The scripted omp and a HOME of the test's own: if the hold ever let a process start, it must not be the person's omp
		// against the person's `~/.omp` (#775).
		const home = join(dir, "home");
		mkdirSync(home, { recursive: true });
		const realHome = process.env.HOME;
		process.env.HOME = home;
		try {
			const pool = new LivePool(fakeConfig(dir, writeFakeOmp(dir)));
			let writing = true;
			pool.setHold(() => writing);
			expect(await codeOf(() => pool.open({ kind: "new", cwd: dir }, async () => null))).toBe("migrateRunning");
			expect(
				await codeOf(() => pool.open({ kind: "resume", sessionFile: join(dir, "s.jsonl") }, async () => dir)),
			).toBe("migrateRunning");
			writing = false;
			expect(await codeOf(() => pool.open({ kind: "new", cwd: join(dir, "missing") }, async () => null))).toMatch(
				/^other:Directory does not exist/,
			);
		} finally {
			process.env.HOME = realHome;
		}
	});
});

describe("what a crash leaves in the data folder", () => {
	test("uploads, finished exports and scratch folders are swept when the server starts", () => {
		const data = join(root, "sweep");
		const dir = join(data, "migrate");
		mkdirSync(join(dir, "tmp-1a2b"), { recursive: true });
		writeFileSync(join(dir, "tmp-1a2b", "x.db"), "x");
		writeFileSync(join(dir, "incoming-abc.ompw"), "a copy of every conversation");
		writeFileSync(join(dir, "omp-webui-migration-mac-2026-10-21.ompw.part"), "p");
		writeFileSync(join(data, "ui-prefs.json"), "{}");
		sweepMigrateDir(data);
		expect(readdirSync(dir)).toEqual([]);
		expect(existsSync(join(data, "ui-prefs.json"))).toBe(true);
		// A data folder that never held one is left as it is.
		sweepMigrateDir(join(root, "nowhere"));
		expect(existsSync(join(root, "nowhere"))).toBe(false);
		expect(statSync(dir).isDirectory()).toBe(true);
	});
});
