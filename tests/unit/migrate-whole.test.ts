import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ImportArchive } from "../../server/migrate/import.ts";
import type { Manifest } from "../../server/migrate/manifest.ts";
import { SEALED_CHUNK, SEALED_OVERHEAD, SealedFile, SealedWriter, unlockSealed } from "../../server/migrate/sealed.ts";
import { ZipReader, ZipWriter } from "../../server/migrate/zip.ts";
import { CodedError } from "../../shared/error-info.ts";
import { hooks, locationsOf, scratch, text, treeOf } from "../support/migrate-run.ts";
import { type Machine, SECRETS, SESSION_ID, seedMachine, stopMachine } from "../support/migrate-world.ts";

/**
 * "Encrypt the whole file" (#607): every entry and the manifest under the password, nothing readable in the file, nothing
 * changed without being refused, and the archives older versions made (nothing encrypted, or the logins only) still
 * imported as they were. The two `*-v1.ompw` fixtures were made by the exporter as it was before this existed, from
 * `seedMachine(…, "jdoe")` with the password below.
 */

const { root, remove, exportOf, importInto } = scratch();
afterAll(remove);

const PASSWORD = "correct horse battery";
const FIXTURES = join(import.meta.dir, "..", "fixtures", "migrate");
const FULL = SEALED_CHUNK + SEALED_OVERHEAD;
const never = new AbortController().signal;

async function codeOf(run: () => Promise<unknown>): Promise<string | null> {
	try {
		await run();
		return null;
	} catch (e) {
		return e instanceof CodedError ? e.code : `other:${(e as Error).message}`;
	}
}

const envOf = (m: Machine, tag: string) => ({
	loc: locationsOf(m),
	ompVersion: "18.12.5",
	serverVersion: "0.11.9",
	backups: join(m.dataDir, "migration-backups"),
	tmp: join(root, `tmp-${tag}`),
	signal: never,
	onProgress: () => {},
	hooks: hooks(),
});

/** An archive an export made. */
interface Made {
	file: string;
	manifest: Manifest;
	bytes: number;
}

const headerEnd = (file: Buffer): number => 8 + 4 + file.readUInt32BE(8);

/** Where, in a sealed file, the chunk holding plaintext byte `at` of the zip starts. */
const chunkStart = (file: Buffer, at: number): number => headerEnd(file) + Math.floor(at / SEALED_CHUNK) * FULL;

describe("a whole-file archive", () => {
	let old: Machine;
	let whole: Made;
	let plain: Made;
	/** Plaintext positions inside the zip of the things a tamper test changes. */
	const at = { manifest: 0, entry: 0, directory: 0 };

	beforeAll(async () => {
		old = seedMachine(join(root, "w-old"), "jdoe");
		// A file that does not compress, so that the archive is several chunks and the places below are in different ones.
		writeFileSync(join(old.agentDir, "skills", "demo", "big.md"), randomBytes(300_000).toString("base64"));
		plain = await exportOf(old);
		whole = await exportOf(old, { wholeFile: true, credentials: true, password: PASSWORD });
		const f = await SealedFile.open(whole.file, await unlockSealed(whole.file, PASSWORD));
		const zip = await ZipReader.from(f, f.size);
		at.entry = (zip.entry("agent/skills/demo/big.md")?.offset ?? 0) + 40 + 100_000;
		at.manifest = (zip.entry("manifest.json")?.offset ?? 0) + 50;
		// The last bytes of the zip are its directory and end record.
		at.directory = f.size - 30;
		await zip.close();
		const chunks = [at.entry, at.manifest, at.directory].map((p) => Math.floor(p / SEALED_CHUNK));
		expect(new Set(chunks).size).toBeGreaterThanOrEqual(2);
		expect(chunks[0]).toBeLessThan(chunks[2]);
	});
	afterAll(() => stopMachine(old));

	test("nothing readable is in the file: no name, no host, no secret, no conversation text, and it is not a zip", () => {
		const raw = readFileSync(whole.file);
		expect(raw.subarray(0, 8).toString()).toBe("OMPWENC2");
		const latin1 = raw.toString("latin1");
		for (const readable of [
			"PK\x03\x04",
			"manifest.json",
			"credentials",
			"agent/config.yml",
			".jsonl",
			"history.db",
			SESSION_ID,
			"Alpha session",
			"old-mac",
			"jdoe",
			PASSWORD,
			SECRETS.apiKey,
			SECRETS.bearer,
			SECRETS.envToken,
			SECRETS.oauth,
			SECRETS.loginKey,
			SECRETS.secretsYml,
			"MIIBsecretcertificate",
			"tunnelsecret0123",
		]) {
			expect(latin1.includes(readable), readable).toBe(false);
		}
		// The check means something: the same text is in the archive that is not encrypted as a whole.
		const open = readFileSync(plain.file).toString("latin1");
		for (const readable of ["manifest.json", "agent/config.yml", ".jsonl", "history.db"]) {
			expect(open.includes(readable), readable).toBe(true);
		}
	});

	test("inside, it is the same archive: the manifest lists the same files with the same checksums, and the logins are one plain entry", async () => {
		expect(whole.manifest.entries.map((e) => [e.path, e.sha256])).toEqual(
			plain.manifest.entries.map((e) => [e.path, e.sha256]),
		);
		expect(whole.manifest.credentials).toMatchObject({ included: true, files: 6 });
		const f = await SealedFile.open(whole.file, await unlockSealed(whole.file, PASSWORD));
		const zip = await ZipReader.from(f, f.size);
		const names = zip.entries.map((e) => e.name);
		expect(names).toContain("credentials.json");
		expect(names).not.toContain("credentials.enc");
		await f.authenticateAll();
		await zip.close();
	});

	test("the file is what the page is told: its own size on disk", () => {
		expect(whole.bytes).toBe(readFileSync(whole.file).length);
	});

	test("without a password it asks for one; a wrong one is refused as wrong, whatever it is", async () => {
		expect(await codeOf(() => ImportArchive.open(whole.file))).toBe("migratePasswordNeeded");
		expect(await codeOf(() => ImportArchive.open(whole.file, { password: "" }))).toBe("migratePasswordNeeded");
		expect(await codeOf(() => ImportArchive.open(whole.file, { password: "not the password" }))).toBe(
			"migrateFilePasswordWrong",
		);
	});

	test("with the right one the preview is the archive's, from its manifest, marked as encrypted as a whole", async () => {
		const fresh = seedMachine(join(root, "w-prev"), "alice", { rich: false });
		const archive = await ImportArchive.open(whole.file, { password: PASSWORD });
		await archive.verify({ signal: never, onProgress: () => {} });
		const preview = await archive.preview(envOf(fresh, "prev"));
		await archive.close();
		expect(preview).toMatchObject({ encryption: "whole", credentials: true });
		expect(preview.source).toMatchObject({ host: "old-mac", user: "jdoe" });
		expect(preview.conversations.total).toBe(4);
		const open = await ImportArchive.open(plain.file);
		const reference = await open.preview(envOf(fresh, "prev2"));
		await open.close();
		expect(preview.categories.filter((c) => c.id !== "credentials")).toEqual(
			reference.categories.filter((c) => c.id !== "credentials"),
		);
		expect(reference.encryption).toBe("none");
		stopMachine(fresh);
	});

	test("it imports to exactly what the archive that is not encrypted imports to", async () => {
		const into = join(root, "w-same");
		const first = seedMachine(into, "alice", { rich: false });
		await importInto(first, plain.file);
		const expected = treeOf(first.home);
		stopMachine(first);
		rmSync(first.home, { recursive: true, force: true });
		const second = seedMachine(into, "alice", { rich: false });
		const summary = await importInto(second, whole.file, { archivePassword: PASSWORD });
		// The preferences file gets an id of its own on every import: the one thing that is not the archive's.
		const [got, want] = [treeOf(second.home), expected];
		delete got[".omp-webui/ui-prefs.json"];
		delete want[".omp-webui/ui-prefs.json"];
		expect(got).toEqual(want);
		expect(summary.credentials).toMatchObject({ restored: false, reason: "notAsked" });
		stopMachine(second);
	});

	test("the logins come back with no second password: the archive was opened with it already", async () => {
		const fresh = seedMachine(join(root, "w-logins"), "alice", { rich: false });
		const summary = await importInto(fresh, whole.file, { archivePassword: PASSWORD, credentials: true });
		expect(summary.credentials).toMatchObject({ restored: true, providers: 2 });
		const db = new Database(join(fresh.agentDir, "agent.db"), { readonly: true });
		expect(db.query("SELECT provider FROM auth_credentials ORDER BY provider").all()).toEqual([
			{ provider: "anthropic" },
			{ provider: "ollama-cloud" },
		]);
		db.close();
		expect(text(fresh.agentDir, "secrets.yml")).toContain(SECRETS.secretsYml);
		expect(text(fresh.agentDir, "models.yml")).toContain(SECRETS.apiKey);
		stopMachine(fresh);
	});

	test("a whole-file archive with no logins has none of them, and still needs the password", async () => {
		const made = await exportOf(old, { wholeFile: true, password: PASSWORD });
		expect(made.manifest.credentials.included).toBe(false);
		const f = await SealedFile.open(made.file, await unlockSealed(made.file, PASSWORD));
		const zip = await ZipReader.from(f, f.size);
		expect(zip.entries.map((e) => e.name).filter((n) => n.startsWith("credentials"))).toEqual([]);
		await zip.close();
		const fresh = seedMachine(join(root, "w-nologin"), "alice", { rich: false });
		const summary = await importInto(fresh, made.file, { archivePassword: PASSWORD });
		expect(summary.credentials).toMatchObject({ restored: false, reason: "absent" });
		expect(await codeOf(() => importInto(fresh, made.file))).toBe("migratePasswordNeeded");
		stopMachine(fresh);
	});

	describe("every way of changing it is refused, and nothing is written", () => {
		let target: Machine;
		let before: Record<string, string>;
		beforeAll(() => {
			target = seedMachine(join(root, "w-target"), "alice", { rich: false });
			writeFileSync(join(target.agentDir, "config.yml"), "theme:\n  dark: mine\n");
			before = treeOf(target.home);
		});
		afterAll(() => stopMachine(target));

		function changed(name: string, change: (b: Buffer) => Buffer): string {
			const path = join(root, `tamper-${name}.ompw`);
			writeFileSync(path, change(Buffer.from(readFileSync(whole.file))));
			return path;
		}
		const flip = (position: number) => (b: Buffer) => {
			b[position] ^= 0x01;
			return b;
		};
		const refused = async (file: string, want: string) => {
			expect(await codeOf(() => importInto(target, file, { archivePassword: PASSWORD, credentials: true }))).toBe(want);
			expect(treeOf(target.home)).toEqual(before);
			expect(existsSync(join(target.dataDir, "migration-backups"))).toBe(false);
		};

		test("the untouched file imports (so what follows is the change)", async () => {
			expect(await codeOf(() => importInto(target, whole.file, { archivePassword: PASSWORD }))).toBeNull();
			// Put the Mac back as it was for the cases below.
			rmSync(target.home, { recursive: true, force: true });
			target = seedMachine(join(root, "w-target"), "alice", { rich: false });
			writeFileSync(join(target.agentDir, "config.yml"), "theme:\n  dark: mine\n");
			before = treeOf(target.home);
		});

		test("a byte inside a file's data (the archive's own checksums are inside, so they could not catch an edit that fixed them)", async () => {
			const raw = readFileSync(whole.file);
			await refused(changed("entry", flip(chunkStart(raw, at.entry) + 20)), "migrateTampered");
		});

		test("a byte of the manifest", async () => {
			const raw = readFileSync(whole.file);
			await refused(changed("manifest", flip(chunkStart(raw, at.manifest) + 20)), "migrateTampered");
		});

		test("a byte of the directory and end record at the end", async () => {
			const raw = readFileSync(whole.file);
			await refused(changed("directory", flip(chunkStart(raw, at.directory) + 3)), "migrateTampered");
		});

		test("a byte of the tag, of the first chunk and of the last", async () => {
			const raw = readFileSync(whole.file);
			await refused(changed("tag0", flip(headerEnd(raw) + FULL - 1)), "migrateTampered");
			await refused(changed("tagN", flip(raw.length - 1)), "migrateTampered");
		});

		test("the file cut short, or with something added", async () => {
			await refused(
				changed("cut", (b) => b.subarray(0, b.length - 1)),
				"migrateTampered",
			);
			await refused(
				changed("cutchunk", (b) => b.subarray(0, b.length - FULL)),
				"migrateTampered",
			);
			await refused(
				changed("added", (b) => Buffer.concat([b, Buffer.from("x")])),
				"migrateTampered",
			);
		});

		test("a header that was changed never opens (the key, the nonce and the check are all in it)", async () => {
			const raw = readFileSync(whole.file);
			const end = headerEnd(raw);
			const codes = new Set<string | null>();
			for (let i = 12; i < end; i += 7) {
				const file = changed(`header${i}`, flip(i));
				codes.add(await codeOf(() => ImportArchive.open(file, { password: PASSWORD })));
			}
			expect(codes.has(null)).toBe(false);
			for (const code of codes)
				expect(["migrateFilePasswordWrong", "migrateTampered", "migrateNotArchive"]).toContain(code as string);
		});

		test("a file that does not start like a sealed archive is not read as one", async () => {
			const notSealed = changed("notsealed", (b) => b.subarray(1));
			expect(await codeOf(() => ImportArchive.open(notSealed, { password: PASSWORD }))).toBe("migrateNotArchive");
		});
	});

	test("a sealed file that holds something else than an omp-webui archive is refused as that", async () => {
		const path = join(root, "other-sealed.ompw");
		const writer = ZipWriter.createOn(await SealedWriter.create(path, PASSWORD, { N: 1 << 10 }), path);
		await writer.add("hello.txt", Buffer.from("hi"));
		await writer.finish();
		expect(await codeOf(() => ImportArchive.open(path, { password: PASSWORD }))).toBe("migrateNotArchive");
	});
});

describe("exporting", () => {
	test("no password, no archive: the exporter refuses before it writes", async () => {
		const old = seedMachine(join(root, "e-old"), "jdoe");
		await expect(exportOf(old, { wholeFile: true })).rejects.toThrow("password");
		await expect(exportOf(old, { credentials: true })).rejects.toThrow("password");
		stopMachine(old);
	});

	test("a cancelled export leaves nothing behind: not the archive, and not a half-written sealed `.part`", async () => {
		const old = seedMachine(join(root, "e-cancel"), "jdoe");
		const controller = new AbortController();
		const archives = () => [...new Bun.Glob("archive-*").scanSync(root)].sort();
		const had = archives();
		await expect(
			exportOf(old, {
				wholeFile: true,
				password: PASSWORD,
				signal: controller.signal,
				// The first file being copied: the sealed file exists by then.
				onProgress: (p) => {
					if (p.current) controller.abort();
				},
			}),
		).rejects.toThrow("Cancelled");
		expect(archives()).toEqual(had);
		stopMachine(old);
	});
});

describe("archives made before this existed", () => {
	const OLD = ["plain-v1.ompw", "logins-v1.ompw"] as const;
	let fresh: Machine;
	beforeAll(() => {
		fresh = seedMachine(join(root, "v1"), "alice", { rich: false });
	});
	afterAll(() => stopMachine(fresh));

	test("they are zips, and take the way they always took: no password to open, and one given is ignored", async () => {
		for (const name of OLD) {
			const file = join(FIXTURES, name);
			expect(readFileSync(file).subarray(0, 2).toString()).toBe("PK");
			for (const password of [undefined, PASSWORD]) {
				const archive = await ImportArchive.open(file, { password });
				await archive.verify({ signal: never, onProgress: () => {} });
				const preview = await archive.preview(envOf(fresh, `v1-${name}`));
				await archive.close();
				expect(preview.encryption).toBe(name === "plain-v1.ompw" ? "none" : "logins");
				expect(preview.credentials).toBe(name !== "plain-v1.ompw");
				expect(preview.conversations.total).toBe(4);
			}
		}
	});

	test("one that holds nothing secret imports", async () => {
		const summary = await importInto(fresh, join(FIXTURES, "plain-v1.ompw"));
		expect(summary.conversations.added).toBe(4);
		expect(summary.credentials).toMatchObject({ restored: false, reason: "absent" });
		expect(existsSync(join(fresh.agentDir, "config.yml"))).toBe(true);
		expect(existsSync(join(fresh.agentDir, "agent.db"))).toBe(false);
	});

	test("one with the logins only encrypted still wants that password for them, and not before", async () => {
		const file = join(FIXTURES, "logins-v1.ompw");
		const target = seedMachine(join(root, "v1-logins"), "alice", { rich: false });
		const before = treeOf(target.home);
		expect(await codeOf(() => importInto(target, file, { credentials: true, password: "not the password" }))).toBe(
			"migratePasswordWrong",
		);
		expect(await codeOf(() => importInto(target, file, { credentials: true }))).toBe("migratePasswordMissing");
		expect(treeOf(target.home)).toEqual(before);
		const summary = await importInto(target, file, { credentials: true, password: PASSWORD });
		expect(summary.credentials).toMatchObject({ restored: true, providers: 2 });
		const db = new Database(join(target.agentDir, "agent.db"), { readonly: true });
		expect(db.query("SELECT provider FROM auth_credentials ORDER BY provider").all()).toHaveLength(2);
		db.close();
		stopMachine(target);
		// And without asking for the logins it needs no password at all.
		const other = seedMachine(join(root, "v1-nologins"), "alice", { rich: false });
		const done = await importInto(other, file, { credentials: false });
		expect(done.credentials).toMatchObject({ restored: false, reason: "notAsked" });
		stopMachine(other);
	});

	test("a copy of a fixture changed in one byte is refused as before (the checksums catch damage)", async () => {
		mkdirSync(join(root, "v1-damage"), { recursive: true });
		const file = join(root, "v1-damage", "damaged.ompw");
		copyFileSync(join(FIXTURES, "plain-v1.ompw"), file);
		const bytes = readFileSync(file);
		// Inside the first entry's data, past its local header (30 bytes, then its name and extra field).
		bytes[30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28) + 10] ^= 0x01;
		writeFileSync(file, bytes);
		const target = seedMachine(join(root, "v1-damaged"), "alice", { rich: false });
		const code = await codeOf(() => importInto(target, file));
		expect(code).toMatch(/^migrateCorrupt$/);
		stopMachine(target);
	});
});
