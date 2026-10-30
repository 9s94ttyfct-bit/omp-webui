import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { decrypt, encrypt } from "../../server/migrate/crypto.ts";
import { ImportArchive } from "../../server/migrate/import.ts";
import { inventory, placementOf } from "../../server/migrate/layout.ts";
import { type Manifest, parseManifest } from "../../server/migrate/manifest.ts";
import { ZipReader, ZipWriter } from "../../server/migrate/zip.ts";
import { CodedError } from "../../shared/error-info.ts";
import {
	MIGRATE_CATEGORIES,
	MIGRATE_DATA_CATEGORIES,
	type MigrateCategoryId,
	type MigrateDataCategoryId,
	migrateHeldCategories,
} from "../../shared/migrate.ts";
import { hooks, locationsOf, scratch, treeOf } from "../support/migrate-run.ts";
import { type Machine, SECRETS, seedMachine, stopMachine, TUNNEL_ID } from "../support/migrate-world.ts";

/**
 * Choosing which kinds of data go into the file (#632): an export of some categories holds those and nothing else (the
 * entries, the zip, the encrypted part, the manifest), an import of such a file changes nothing outside them, and an
 * archive made before the manifest recorded its categories is a whole one.
 */

const { root, remove, exportOf, importInto } = scratch();
afterAll(remove);

const PASSWORD = "correct horse battery";
const FIXTURES = join(import.meta.dir, "..", "fixtures", "migrate");
const never = new AbortController().signal;

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

function put(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

async function codeOf(run: () => Promise<unknown>): Promise<string | null> {
	try {
		await run();
		return null;
	} catch (e) {
		return e instanceof CodedError ? e.code : `other:${(e as Error).message}`;
	}
}

/** What the zip itself holds: its entry names, and the manifest it carries. */
async function opened(file: string): Promise<{ names: string[]; manifest: Manifest }> {
	const zip = await ZipReader.open(file);
	try {
		const manifest: Manifest = JSON.parse(Buffer.from(await zip.bytes("manifest.json")).toString("utf8"));
		return { names: zip.entries.map((e) => e.name).sort(), manifest };
	} finally {
		await zip.close();
	}
}

/** The paths of the files in the archive's encrypted part (a zip whose logins are encrypted on their own). */
async function bundlePaths(file: string): Promise<string[]> {
	const zip = await ZipReader.open(file);
	try {
		const plain = await decrypt(await zip.bytes("credentials.enc"), PASSWORD);
		// The test's own archive: the shape the exporter wrote.
		const bundle: { files: { path: string }[] } = JSON.parse(plain.toString("utf8"));
		return bundle.files.map((f) => f.path).sort();
	} finally {
		await zip.close();
	}
}

/** The category an archive path was placed in: what the importer would make of it. */
const categoryOf = (path: string): MigrateCategoryId => placementOf(path)?.category ?? "credentials";

let old: Machine;
beforeAll(() => {
	old = seedMachine(join(root, "a"), "jdoe");
	// A secret by its name in a folder of the customization category, and a second one in the settings'.
	put(join(old.agentDir, "skills", "demo", ".env"), `TOKEN=${SECRETS.envToken}\n`);
});
afterAll(() => stopMachine(old));

describe("an export of some categories holds those and nothing else", () => {
	let whole: { file: string; manifest: Manifest };
	beforeAll(async () => {
		whole = await exportOf(old);
	});

	test("without a choice it is the whole export, and says so", async () => {
		expect(whole.manifest.categories).toEqual([...MIGRATE_DATA_CATEGORIES]);
		const wholeAgain = await exportOf(old, { categories: [...MIGRATE_DATA_CATEGORIES] });
		expect(wholeAgain.manifest.entries.map((e) => e.path)).toEqual(whole.manifest.entries.map((e) => e.path));
		// Every data category has something in the made-up machine, or the tests below prove nothing about it.
		for (const id of MIGRATE_DATA_CATEGORIES) {
			expect(
				whole.manifest.entries.some((e) => e.category === id),
				id,
			).toBe(true);
		}
	});

	for (const id of MIGRATE_DATA_CATEGORIES) {
		test(`only ${id}: its entries, the zip of exactly those, the manifest naming it`, async () => {
			const { file, manifest } = await exportOf(old, { categories: [id] });
			const { names, manifest: inZip } = await opened(file);
			expect(manifest.categories).toEqual([id]);
			expect(inZip.categories).toEqual([id]);
			expect(manifest.credentials.included).toBe(false);
			// Every entry is of that category, and none of it is missing: the very ones the whole export has.
			expect(manifest.entries.every((e) => e.category === id)).toBe(true);
			expect(manifest.entries.map((e) => e.path)).toEqual(
				whole.manifest.entries.filter((e) => e.category === id).map((e) => e.path),
			);
			// The zip holds those files and the manifest: no file of another category, no encrypted part. (A link is no file.)
			const files = manifest.entries.filter((e) => e.kind !== "symlink").map((e) => e.path);
			expect(names).toEqual([...files, "manifest.json"].sort());
			for (const name of names) if (name !== "manifest.json") expect(categoryOf(name), name).toBe(id);
		});
	}

	test("two categories are two categories, in the order the page lists them", async () => {
		const { manifest, file } = await exportOf(old, { categories: ["webui", "memories"] });
		expect(manifest.categories).toEqual(["memories", "webui"]);
		expect(new Set(manifest.entries.map((e) => e.category))).toEqual(new Set(["memories", "webui"]));
		const { names } = await opened(file);
		expect(names.every((n) => n === "manifest.json" || ["memories", "webui"].includes(categoryOf(n)))).toBe(true);
	});

	test("the secret values of a category that is left out are not in the file, nor told of", async () => {
		const settings = await exportOf(old, { categories: ["settings"] });
		expect(settings.manifest.secretFiles.length).toBeGreaterThan(0);
		for (const id of MIGRATE_DATA_CATEGORIES.filter((c) => c !== "settings")) {
			const other = await exportOf(old, { categories: [id] });
			expect(other.manifest.secretFiles, id).toEqual([]);
		}
		// Nothing of what was left out is in the manifest's list of what is left out for being a secret either.
		const history = await exportOf(old, { categories: ["history"] });
		expect(history.manifest.leftOut.some((l) => l.reason === "secret" && l.path.endsWith(".env"))).toBe(false);
	});

	test("nothing chosen, and no logins, is no export", async () => {
		expect(await codeOf(() => exportOf(old, { categories: [] }))).toBe("other:Nothing is chosen to export");
	});

	test("the list the page and the server share: the ones named, plus the logins when they are asked for", () => {
		expect(migrateHeldCategories({ credentials: false })).toEqual([...MIGRATE_DATA_CATEGORIES]);
		expect(migrateHeldCategories({ credentials: true, categories: ["webui"] })).toEqual(["webui", "credentials"]);
		expect(migrateHeldCategories({ credentials: true, categories: [] })).toEqual(["credentials"]);
		expect(migrateHeldCategories({ credentials: false, categories: [] })).toEqual([]);
		expect(MIGRATE_CATEGORIES.at(-1)).toBe("credentials");
	});
});

describe("the logins with a choice of categories", () => {
	test("the encrypted part holds the logins and the secrets of the chosen categories only", async () => {
		const { file, manifest } = await exportOf(old, {
			credentials: true,
			password: PASSWORD,
			categories: ["settings"],
		});
		expect(manifest.categories).toEqual(["settings", "credentials"]);
		expect(manifest.credentials.included).toBe(true);
		expect(manifest.entries.every((e) => e.category === "settings")).toBe(true);
		const paths = await bundlePaths(file);
		expect(paths).toContain("agent/agent.db");
		expect(paths).toContain("agent/secrets.yml");
		expect(paths).toContain(`home/.cloudflared/${TUNNEL_ID}.json`);
		// The configuration files of the chosen category keep their secrets here; the `.env` of a skill that was not chosen is not carried.
		expect(paths).toContain("agent/models.yml");
		expect(paths).not.toContain("agent/skills/demo/.env");
		for (const p of paths) expect(["settings", "credentials"], p).toContain(categoryOf(p));
		const { names } = await opened(file);
		expect(names).toContain("credentials.enc");
		expect(names.some((n) => n.startsWith("agent/skills/"))).toBe(false);
	});

	test("the secret file of a chosen folder goes with it", async () => {
		const { file } = await exportOf(old, { credentials: true, password: PASSWORD, categories: ["customization"] });
		const paths = await bundlePaths(file);
		expect(paths).toContain("agent/skills/demo/.env");
		expect(paths).not.toContain("agent/models.yml");
	});

	test("the logins alone are an archive with nothing else in it", async () => {
		const { file, manifest } = await exportOf(old, { credentials: true, password: PASSWORD, categories: [] });
		expect(manifest.categories).toEqual(["credentials"]);
		expect(manifest.entries).toEqual([]);
		expect((await opened(file)).names).toEqual(["credentials.enc", "manifest.json"]);
		expect(await bundlePaths(file)).not.toContain("agent/models.yml");
	});

	test("without the logins, a secret file of a chosen folder is told as left out; one of a folder not chosen is not", async () => {
		const some = await exportOf(old, { categories: ["customization"] });
		expect(some.manifest.leftOut.some((l) => l.reason === "secret" && l.path.endsWith("skills/demo/.env"))).toBe(true);
		const other = await exportOf(old, { categories: ["webui"] });
		expect(other.manifest.leftOut.some((l) => l.path.endsWith("skills/demo/.env"))).toBe(false);
	});
});

describe("an import of some categories touches nothing outside them", () => {
	/** Which category each file under a machine's home is in (a SQLite database's `-wal` is its database's). */
	async function categories(m: Machine): Promise<Map<string, MigrateCategoryId>> {
		const inv = await inventory(locationsOf(m));
		return new Map(inv.items.map((i) => [relative(m.home, i.source), i.category]));
	}

	/** What an import changed, by category: the files that differ, are new or are gone. */
	async function changes(
		m: Machine,
		before: Record<string, string>,
	): Promise<Set<MigrateCategoryId | "backup" | "other">> {
		const after = treeOf(m.home);
		const owner = await categories(m);
		const out = new Set<MigrateCategoryId | "backup" | "other">();
		for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
			if (before[key] === after[key]) continue;
			if (key.startsWith(".omp-webui/migration-backups/")) out.add("backup");
			else out.add(owner.get(key.replace(/-(wal|shm|journal)$/, "")) ?? "other");
		}
		return out;
	}

	let changed: Machine;
	beforeAll(() => {
		// The old Mac has something this one lacks in each category, so that an import of it changes each of them.
		changed = seedMachine(join(root, "changed"), "jdoe");
		put(join(changed.agentDir, "session-pins.json"), JSON.stringify(["0190aaaa-0000-7000-8000-0000000000ff"]));
		changed.live[0].run("INSERT INTO history (prompt, created_at, cwd) VALUES ('only on the old Mac', 400, ?)", [
			join(changed.home, "proj"),
		]);
		put(join(changed.agentDir, "AGENTS.md"), "# Rules\nChanged on the old Mac.\n");
		put(join(changed.agentDir, "skills", "demo", "SKILL.md"), "---\nname: demo\n---\nChanged on the old Mac.\n");
		put(join(changed.home, ".omp", "plugins", "data", "notes.txt"), "only on the old Mac");
		put(join(changed.dataDir, "favorite-models.json"), JSON.stringify(["anthropic/model-b"]));
	});
	afterAll(() => stopMachine(changed));

	const label = (ids: readonly string[]) => ids.join("+");
	const subsets: MigrateDataCategoryId[][] = [
		...MIGRATE_DATA_CATEGORIES.map((id) => [id]),
		["settings", "webui"],
		["history", "memories", "plugins"],
	];

	test("the whole export changes every category (so that the others below could be seen to change)", async () => {
		const target = seedMachine(join(root, "t-whole"), "alice");
		const before = treeOf(target.home);
		const { file } = await exportOf(changed);
		await importInto(target, file, { mode: "replace" });
		const seen = await changes(target, before);
		for (const id of MIGRATE_DATA_CATEGORIES) expect(seen.has(id), id).toBe(true);
		stopMachine(target);
	});

	for (const ids of subsets) {
		test(`${label(ids)} only: what is chosen is imported, every other file is as it was`, async () => {
			const target = seedMachine(join(root, `t-${label(ids)}`), "alice");
			const before = treeOf(target.home);
			const { file } = await exportOf(changed, { categories: ids });
			const summary = await importInto(target, file, { mode: "replace" });
			const seen = await changes(target, before);
			for (const id of seen) expect(["backup", ...ids], `changed ${id} on importing ${label(ids)}`).toContain(id);
			for (const id of ids) expect(seen.has(id), `${id} was not imported`).toBe(true);
			expect(summary.files.skipped).toBe(0);
			stopMachine(target);
		});
	}

	test("the same into a machine that has nothing: only the chosen files appear", async () => {
		const target = seedMachine(join(root, "t-empty"), "alice", { rich: false });
		const { file } = await exportOf(changed, { categories: ["settings"] });
		await importInto(target, file, { mode: "merge" });
		const owner = await categories(target);
		const made = Object.keys(treeOf(target.home)).filter((k) => !k.startsWith(".omp-webui/migration-backups/"));
		expect(made.length).toBeGreaterThan(0);
		for (const key of made) expect(owner.get(key), key).toBe("settings");
		expect(existsSync(join(target.agentDir, "sessions"))).toBe(false);
		expect(existsSync(join(target.dataDir, "ui-prefs.json"))).toBe(false);
		stopMachine(target);
	});

	test("a file of logins and a subset restores the logins and writes nothing else", async () => {
		const target = seedMachine(join(root, "t-logins"), "alice", { rich: false });
		const { file } = await exportOf(changed, { credentials: true, password: PASSWORD, categories: ["webui"] });
		const summary = await importInto(target, file, { mode: "merge", credentials: true, password: PASSWORD });
		expect(summary.credentials).toMatchObject({ restored: true });
		const made = Object.keys(treeOf(target.home)).filter((k) => !k.startsWith(".omp-webui/migration-backups/"));
		const owner = await categories(target);
		for (const key of made) {
			expect(["webui", "credentials"], key).toContain(owner.get(key.replace(/-(wal|shm)$/, "")) ?? "other");
		}
		expect(existsSync(join(target.agentDir, "config.yml"))).toBe(false);
		stopMachine(target);
	});

	test("memory banks of a file without the conversations and the history are still renamed for the new home", async () => {
		const target = seedMachine(join(root, "t-banks"), "alice", { rich: false });
		const { file, manifest } = await exportOf(changed, { categories: ["memories"] });
		// The folders the banks are named after are in the manifest, and only those a bank is named after.
		expect(manifest.bankFolders).toContain(join(changed.home, "proj"));
		expect(manifest.bankFolders).toContain(join(changed.home, "histonly"));
		expect(manifest.bankFolders.every((dir) => dir.startsWith(changed.home))).toBe(true);
		const summary = await importInto(target, file, { mode: "merge" });
		expect(summary.notes.some((n) => n.code === "banksRenamed")).toBe(true);
		const banks = join(target.agentDir, "memories", "mnemopi", "banks");
		const name = (cwd: string) => `${cwd.split("/").pop()}-${Bun.hash(cwd).toString(36)}`;
		expect(existsSync(join(banks, name(join(target.home, "proj")), "mnemopi.db"))).toBe(true);
		expect(existsSync(join(banks, name(join(target.home, "histonly")), "mnemopi.db"))).toBe(true);
		expect(existsSync(join(banks, name(join(changed.home, "proj"))))).toBe(false);
		stopMachine(target);
	});

	test("a whole export records no folders of its own (the conversations and the history say them)", async () => {
		const { manifest } = await exportOf(changed);
		expect(manifest.bankFolders).toEqual([]);
	});
});

describe("what a file says it holds", () => {
	let sample: Manifest;
	beforeAll(async () => {
		sample = (await exportOf(old, { categories: ["webui"] })).manifest;
	});
	const parsed = (over: Record<string, unknown>) =>
		codeOf(async () => parseManifest({ ...JSON.parse(JSON.stringify(sample)), ...over }));

	test("the importer shows the categories of the manifest, and reads an entry of no other", async () => {
		const target = seedMachine(join(root, "t-preview"), "alice", { rich: false });
		const { file } = await exportOf(old, { categories: ["webui", "history"] });
		const archive = await ImportArchive.open(file);
		const preview = await archive.preview({
			loc: locationsOf(target),
			ompVersion: "18.12.5",
			serverVersion: "0.11.9",
			backups: join(target.dataDir, "migration-backups"),
			tmp: join(root, "preview-tmp"),
			signal: never,
			onProgress: () => {},
			hooks: hooks(),
		});
		await archive.close();
		expect(preview.held).toEqual(["history", "webui"]);
		expect(preview.categories.map((c) => c.id)).toEqual(["history", "webui"]);
		stopMachine(target);
		expect(await parsed({ categories: ["history"] })).toBe("migrateCorrupt");
	});

	test("a list that is not one, repeats itself, names no category, or disagrees with the encrypted part is a damaged manifest", async () => {
		expect(await parsed({ categories: "webui" })).toBe("migrateCorrupt");
		expect(await parsed({ categories: ["webui", "webui"] })).toBe("migrateCorrupt");
		expect(await parsed({ categories: ["webui", "nothing"] })).toBe("migrateCorrupt");
		expect(await parsed({ categories: [...MIGRATE_CATEGORIES, "webui"] })).toBe("migrateCorrupt");
		// It lists the logins only when the file holds them.
		expect(await parsed({ categories: ["webui", "credentials"] })).toBe("migrateCorrupt");
		expect(await parsed({ credentials: { included: true, sha256: "a".repeat(64), bytes: 1, files: 1 } })).toBe(
			"migrateCorrupt",
		);
		expect(await parsed({})).toBeNull();
	});

	test("archives made before it was recorded are whole ones: every data category, and the logins when they hold them", async () => {
		const fresh = seedMachine(join(root, "t-v1"), "alice", { rich: false });
		for (const [name, logins] of [
			["plain-v1.ompw", false],
			["logins-v1.ompw", true],
		] as const) {
			const archive = await ImportArchive.open(join(FIXTURES, name));
			expect(archive.manifest.categories).toEqual(MIGRATE_CATEGORIES.filter((c) => c !== "credentials" || logins));
			await archive.close();
		}
		const summary = await importInto(fresh, join(FIXTURES, "plain-v1.ompw"));
		expect(summary.conversations.added).toBe(4);
		expect(existsSync(join(fresh.agentDir, "config.yml"))).toBe(true);
		stopMachine(fresh);
	});
});

describe("the encrypted part of a file is held to its categories too", () => {
	/** A file whose manifest holds only `categories` and whose encrypted part carries `files` (which an honest export would not make). */
	async function forged(categories: MigrateCategoryId[], files: { path: string; kind: string; data: string }[]) {
		const out = join(root, `forged-${Bun.hash(JSON.stringify([categories, files])).toString(36)}.ompw`);
		const zip = await ZipWriter.create(out);
		const sealed = await encrypt(
			Buffer.from(JSON.stringify({ v: 1, files: files.map((f) => ({ ...f, mode: 0o600, mtimeMs: 0 })) })),
			PASSWORD,
		);
		await zip.add("credentials.enc", sealed, { compress: false });
		const home = "/Users/jdoe";
		const manifest = {
			format: 1,
			app: "omp-webui",
			createdAt: new Date().toISOString(),
			categories,
			source: {
				host: "old",
				user: "jdoe",
				home,
				agentDir: `${home}/.omp/agent`,
				dataDir: `${home}/.omp-webui`,
				platform: "darwin",
				ompVersion: "18.12.5",
				serverVersion: "0.11.9",
			},
			sessionDirs: [],
			profiles: [],
			bankFolders: [],
			entries: [],
			leftOut: [],
			secretFiles: [],
			skipped: [],
			credentials: { included: true, sha256: sha(sealed), bytes: sealed.length, files: files.length },
		};
		await zip.add("manifest.json", Buffer.from(JSON.stringify(manifest)));
		await zip.finish();
		return out;
	}

	test("a configuration file of a category the file does not hold is refused; a login is restored", async () => {
		const target = seedMachine(join(root, "t-forged"), "alice", { rich: false });
		const login = (path: string) => ({ path, kind: "secret", data: Buffer.from("secret value").toString("base64") });
		const file = await forged(
			["credentials"],
			[
				login("agent/secrets.yml"),
				{ path: "agent/AGENTS.md", kind: "config", data: Buffer.from("not chosen").toString("base64") },
				{ path: "agent/models.yml", kind: "config", data: Buffer.from("providers: {}\n").toString("base64") },
			],
		);
		const summary = await importInto(target, file, { mode: "merge", credentials: true, password: PASSWORD });
		expect(summary.credentials).toMatchObject({ restored: true, files: 1 });
		expect(readFileSync(join(target.agentDir, "secrets.yml"), "utf8")).toBe("secret value");
		expect(existsSync(join(target.agentDir, "AGENTS.md"))).toBe(false);
		expect(existsSync(join(target.agentDir, "models.yml"))).toBe(false);
		expect(summary.notes.filter((n) => n.code === "credentialsFailed")).toHaveLength(2);
		stopMachine(target);
	});

	test("with the category held, the same file is written", async () => {
		const target = seedMachine(join(root, "t-forged-held"), "alice", { rich: false });
		const file = await forged(
			["settings", "credentials"],
			[{ path: "agent/AGENTS.md", kind: "config", data: Buffer.from("chosen\n").toString("base64") }],
		);
		await importInto(target, file, { mode: "merge", credentials: true, password: PASSWORD });
		expect(readFileSync(join(target.agentDir, "AGENTS.md"), "utf8")).toBe("chosen\n");
		stopMachine(target);
	});

	test("a secret by its name needs the category of the folder it lies in as well as the logins", async () => {
		const target = seedMachine(join(root, "t-forged-env"), "alice", { rich: false });
		const env = [{ path: "agent/skills/x/.env", kind: "secret", data: Buffer.from("TOKEN=abc\n").toString("base64") }];
		const refused = await forged(["settings", "credentials"], env);
		const first = await importInto(target, refused, { mode: "merge", credentials: true, password: PASSWORD });
		expect(existsSync(join(target.agentDir, "skills"))).toBe(false);
		expect(first.notes.filter((n) => n.code === "credentialsFailed")).toHaveLength(1);
		const held = await forged(["customization", "credentials"], env);
		await importInto(target, held, { mode: "merge", credentials: true, password: PASSWORD });
		expect(readFileSync(join(target.agentDir, "skills", "x", ".env"), "utf8")).toBe("TOKEN=abc\n");
		stopMachine(target);
	});
});

describe("an entry is what its path is, not what its label says", () => {
	interface Listed {
		path: string;
		label: MigrateCategoryId;
		text: string;
	}

	/** A zip whose manifest lists `entries` under the labels given and holds `categories` (none named: an archive of before they were recorded). */
	async function mislabelled(entries: Listed[], categories?: MigrateCategoryId[]): Promise<string> {
		const out = join(root, `mislabelled-${Bun.hash(JSON.stringify([entries, categories])).toString(36)}.ompw`);
		const zip = await ZipWriter.create(out);
		const listed = [];
		for (const e of entries) {
			const bytes = Buffer.from(e.text);
			await zip.add(e.path, bytes);
			listed.push({
				path: e.path,
				category: e.label,
				kind: e.path.endsWith(".json") ? "config" : "file",
				size: bytes.length,
				sha256: sha(bytes),
				mode: 0o644,
				mtimeMs: 0,
			});
		}
		const home = "/Users/jdoe";
		const manifest = {
			format: 1,
			app: "omp-webui",
			createdAt: new Date().toISOString(),
			...(categories ? { categories } : {}),
			source: {
				host: "old",
				user: "jdoe",
				home,
				agentDir: `${home}/.omp/agent`,
				dataDir: `${home}/.omp-webui`,
				platform: "darwin",
				ompVersion: "18.12.5",
				serverVersion: "0.11.9",
			},
			sessionDirs: [],
			profiles: [],
			entries: listed,
			leftOut: [],
			secretFiles: [],
			skipped: [],
			credentials: { included: false },
		};
		await zip.add("manifest.json", Buffer.from(JSON.stringify(manifest)));
		await zip.finish();
		return out;
	}

	const SKILL = "---\nname: x\n---\nA skill the file does not say it holds.\n";
	const PREFS = '["anthropic/model-a"]';

	test("a skill labelled as this app's data, in a file that holds only that, is refused and nothing is written", async () => {
		const target = seedMachine(join(root, "t-mislabelled"), "alice", { rich: false });
		const file = await mislabelled(
			[
				{ path: "webui/favorite-models.json", label: "webui", text: PREFS },
				{ path: "agent/skills/x/SKILL.md", label: "webui", text: SKILL },
			],
			["webui"],
		);
		const before = treeOf(target.home);
		expect(await codeOf(() => importInto(target, file))).toBe("migrateCorrupt");
		expect(treeOf(target.home)).toEqual(before);
		expect(existsSync(join(target.agentDir, "skills"))).toBe(false);
		// The same file with the label it should have, in a file that says it holds the category: written.
		const honest = await mislabelled(
			[{ path: "agent/skills/x/SKILL.md", label: "customization", text: SKILL }],
			["customization"],
		);
		await importInto(target, honest);
		expect(readFileSync(join(target.agentDir, "skills", "x", "SKILL.md"), "utf8")).toBe(SKILL);
		stopMachine(target);
	});

	test("a file of any other category is held to the same: the category of its path must be one the file holds", async () => {
		const target = seedMachine(join(root, "t-mislabelled-2"), "alice", { rich: false });
		for (const [path, held] of [
			["agent/history.db", "settings"],
			["omp/marketplaces.json", "webui"],
			["agent/memories/mnemopi/mnemopi.db", "history"],
		] as const) {
			const file = await mislabelled([{ path, label: held, text: "{}" }], [held]);
			const before = treeOf(target.home);
			expect(await codeOf(() => importInto(target, file)), path).toBe("migrateCorrupt");
			expect(treeOf(target.home), path).toEqual(before);
		}
		stopMachine(target);
	});

	test("in an archive of before categories were recorded the label decides nothing: it is counted and written by its path", async () => {
		const target = seedMachine(join(root, "t-mislabelled-old"), "alice", { rich: false });
		const file = await mislabelled([{ path: "agent/AGENTS.md", label: "webui", text: "# Rules\n" }]);
		const archive = await ImportArchive.open(file);
		const preview = await archive.preview({
			loc: locationsOf(target),
			ompVersion: "18.12.5",
			serverVersion: "0.11.9",
			backups: join(target.dataDir, "migration-backups"),
			tmp: join(root, "mislabelled-preview-tmp"),
			signal: never,
			onProgress: () => {},
			hooks: hooks(),
		});
		await archive.close();
		expect(preview.categories.map((c) => c.id)).toEqual(["settings"]);
		// And what writes omp's files ends omp's idle conversations first, as it does for a file with the right label.
		let ended = 0;
		const over = {
			endIdle: async () => {
				ended++;
				return 0;
			},
		};
		await importInto(target, file, {}, over);
		expect(ended).toBe(1);
		expect(readFileSync(join(target.agentDir, "AGENTS.md"), "utf8")).toBe("# Rules\n");
		// A file of only this app's data leaves them running.
		const prefs = await mislabelled([{ path: "webui/favorite-models.json", label: "webui", text: PREFS }]);
		await importInto(target, prefs, {}, over);
		expect(ended).toBe(1);
		stopMachine(target);
	});
});

describe("what is said to be left out, and which folders are named", () => {
	let m: Machine;
	beforeAll(() => {
		m = seedMachine(join(root, "left"), "jdoe");
		const dir = join(root, "left", "elsewhere", "sessions");
		put(join(dir, "proj", "note.txt"), "a conversation folder of its own");
		m.sessionDirs.push(dir);
	});
	afterAll(() => stopMachine(m));

	/** What an export of `categories` says is left out, with `~` for the home folder. */
	async function leftOf(categories: MigrateDataCategoryId[]): Promise<string[]> {
		return (await exportOf(m, { categories })).manifest.leftOut.map((l) => l.path.replace(m.home, "~"));
	}

	const AGENT_CACHE = "~/.omp/agent/cache";
	const ROOT_STATE = "~/.omp/install-id";
	const APP_TOKEN = "~/.omp-webui/token";
	const LOGINS = "~/.omp/agent/agent.db";

	test("an export names as left out what lies where its categories draw from, and the logins, which are never in without the switch", async () => {
		const webui = await leftOf(["webui"]);
		expect(webui).toContain(APP_TOKEN);
		expect(webui).toContain(LOGINS);
		expect(webui).not.toContain(AGENT_CACHE);
		expect(webui).not.toContain(ROOT_STATE);
		const plugins = await leftOf(["plugins"]);
		expect(plugins).toContain(ROOT_STATE);
		expect(plugins).toContain("~/.omp/logs");
		expect(plugins).not.toContain(AGENT_CACHE);
		expect(plugins).not.toContain(APP_TOKEN);
		const history = await leftOf(["history"]);
		expect(history).toContain(AGENT_CACHE);
		expect(history).not.toContain(ROOT_STATE);
		expect(history).not.toContain(APP_TOKEN);
		const whole = await leftOf([...MIGRATE_DATA_CATEGORIES]);
		for (const p of [AGENT_CACHE, ROOT_STATE, APP_TOKEN, LOGINS]) expect(whole).toContain(p);
	});

	test("the folders conversations were started in are named only by a file that holds the conversations", async () => {
		const folder = (await exportOf(m, { categories: ["conversations"] })).manifest.sessionDirs;
		expect(folder).toHaveLength(1);
		expect(folder[0].dir).toBe(m.sessionDirs[0]);
		for (const id of MIGRATE_DATA_CATEGORIES.filter((c) => c !== "conversations")) {
			expect((await exportOf(m, { categories: [id] })).manifest.sessionDirs, id).toEqual([]);
		}
		expect((await exportOf(m)).manifest.sessionDirs).toHaveLength(1);
	});
});
