import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decrypt, encrypt, WrongPasswordError } from "../../server/migrate/crypto.ts";
import { parseManifest } from "../../server/migrate/manifest.ts";
import { compareFiles, mergeDoc, parseDoc, unionList } from "../../server/migrate/merge.ts";
import { absoluteBucket, bucketFor, homeBucket, PathMap, rewriteSession } from "../../server/migrate/rewrite.ts";
import { countSecrets, redactSecrets } from "../../server/migrate/secrets.ts";
import { authSnapshot, foldersOf, mergeHistory, restoreAuth, snapshotDb } from "../../server/migrate/sqlite.ts";
import { CodedError } from "../../shared/error-info.ts";
import { migrateArchiveName } from "../../shared/migrate.ts";

const root = mkdtempSync(join(tmpdir(), "ompw-parts-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("moving a path from the old home to the new one", () => {
	const map = new PathMap([{ from: "/Users/jdoe", to: "/Users/alice" }]);

	test("a folder is moved as a whole path, never as the start of another folder's name", () => {
		expect(map.map("/Users/jdoe")).toBe("/Users/alice");
		expect(map.map("/Users/jdoe/proj/src")).toBe("/Users/alice/proj/src");
		expect(map.map("/Users/jdoe2/proj")).toBe("/Users/jdoe2/proj");
		expect(map.map("/Users/jdo")).toBe("/Users/jdo");
		expect(map.map("/other/Users/jdoe")).toBe("/other/Users/jdoe");
		expect(map.map("relative/jdoe")).toBe("relative/jdoe");
	});

	test("in text, every old path is moved: in quotes, in a command line, twice in a line; a similar name is not", () => {
		const text = 'cmd "/Users/jdoe/bin/x" --cache=/Users/jdoe/.cache; ls /Users/jdoe2 /Users/jdoe.';
		expect(map.text(text)).toEqual({
			text: 'cmd "/Users/alice/bin/x" --cache=/Users/alice/.cache; ls /Users/jdoe2 /Users/alice.',
			count: 3,
		});
		expect(map.remaining(text)).toBe(3);
		expect(map.remaining(map.text(text).text)).toBe(0);
		// A name that continues the old one (`/Users/jdoe-old`, `~jdoe`) is somebody else's.
		expect(map.text("/Users/jdoe-old /Users/jdoe_x a/Users/jdoe").count).toBe(0);
	});

	test("the most specific old folder decides, and pairs that change nothing are dropped", () => {
		const both = new PathMap([
			{ from: "/Users/jdoe", to: "/Users/alice" },
			{ from: "/Users/jdoe/.omp/agent", to: "/Volumes/data/agent" },
			{ from: "/same", to: "/same" },
		]);
		expect(both.pairs).toHaveLength(2);
		expect(both.map("/Users/jdoe/.omp/agent/sessions")).toBe("/Volumes/data/agent/sessions");
		expect(both.map("/Users/jdoe/.omp/other")).toBe("/Users/alice/.omp/other");
		expect(new PathMap([{ from: "/a", to: "/a" }]).identity).toBe(true);
	});

	test("omp's folder names: a project under home is named by its part below it, anything else by its whole path", () => {
		expect(homeBucket("/Users/jdoe/proj", "/Users/jdoe")).toBe("-proj");
		expect(homeBucket("/Users/jdoe/a/b.c", "/Users/jdoe")).toBe("-a-b.c");
		expect(homeBucket("/Users/jdoe", "/Users/jdoe")).toBe("-");
		expect(homeBucket("/tmp/x", "/Users/jdoe")).toBeNull();
		expect(absoluteBucket("/private/tmp/x")).toBe("--private-tmp-x--");
	});

	test("a session folder is renamed when its name was made from a path that moved, and only then", () => {
		const args: [PathMap, string[], string[]] = [map, ["/Users/jdoe"], ["/Users/alice"]];
		// Named the way omp does it now: the same name on the new machine.
		expect(bucketFor("-proj", "/Users/jdoe/proj", ...args)).toBe("-proj");
		// Named from the whole path (what omp did before 17.2.9): the whole path moved.
		expect(bucketFor(absoluteBucket("/Users/jdoe/proj"), "/Users/jdoe/proj", ...args)).toBe("-proj");
		// Outside home: no change.
		const outside = new PathMap([{ from: "/Users/jdoe", to: "/Users/alice" }]);
		expect(bucketFor(absoluteBucket("/tmp/x"), "/tmp/x", outside, ["/Users/jdoe"], ["/Users/alice"])).toBe(
			absoluteBucket("/tmp/x"),
		);
		// A name that is neither spelling of the folder was chosen by something else: it stays.
		expect(bucketFor("custom-name", "/Users/jdoe/proj", ...args)).toBe("custom-name");
		// A folder that goes from home-relative to outside it (the new home is elsewhere) gets the other spelling.
		const away = new PathMap([{ from: "/Users/jdoe/proj", to: "/srv/proj" }]);
		expect(bucketFor("-proj", "/Users/jdoe/proj", away, ["/Users/jdoe"], ["/Users/alice"])).toBe(
			absoluteBucket("/srv/proj"),
		);
	});
});

describe("a conversation's header", () => {
	const map = new PathMap([{ from: "/Users/jdoe", to: "/Users/alice" }]);
	const slot = `${JSON.stringify({ type: "title", v: 1, title: "t /Users/jdoe", pad: "" })}\n`;
	const header = {
		type: "session",
		id: "s1",
		cwd: "/Users/jdoe/proj",
		parentSession: "/Users/jdoe/.omp/agent/sessions/-proj/x.jsonl",
		additionalDirectories: ["/Users/jdoe/shared", "/mnt/x"],
		previousSessionFiles: ["/Users/jdoe/old.jsonl"],
	};
	const body = `${JSON.stringify({ type: "message", text: "see /Users/jdoe/proj" })}\n`;

	async function run(pieces: Uint8Array[], onHeader?: Parameters<typeof rewriteSession>[2]): Promise<string> {
		async function* source() {
			for (const p of pieces) yield p;
		}
		const out: Buffer[] = [];
		for await (const chunk of rewriteSession(source(), map, onHeader)) out.push(Buffer.from(chunk));
		return Buffer.concat(out).toString("utf8");
	}

	test("its folder, its parent's file and its other folders are the new home's; nothing else of the file is touched", async () => {
		const text = `${slot}${JSON.stringify(header)}\n${body}`;
		const seen: boolean[] = [];
		const out = await run([Buffer.from(text)], (h) => seen.push(h.changed));
		const lines = out.split("\n");
		expect(JSON.parse(lines[1])).toEqual({
			...header,
			cwd: "/Users/alice/proj",
			parentSession: "/Users/alice/.omp/agent/sessions/-proj/x.jsonl",
			additionalDirectories: ["/Users/alice/shared", "/mnt/x"],
			previousSessionFiles: ["/Users/alice/old.jsonl"],
		});
		// The title slot and the messages are the record of what happened: they are as they were.
		expect(lines[0]).toBe(slot.trimEnd());
		expect(out.endsWith(body)).toBe(true);
		expect(seen).toEqual([true]);
	});

	test("the same result however the file arrives: one byte at a time, or a header cut in the middle of a chunk", async () => {
		const big = `${slot}${JSON.stringify(header)}\n${body.repeat(2000)}`;
		const whole = await run([Buffer.from(big)]);
		const bytes = Buffer.from(big);
		const single = await run(Array.from(bytes.subarray(0, 600), (b) => Uint8Array.of(b)).concat([bytes.subarray(600)]));
		expect(single).toBe(whole);
		expect(whole.length).toBeGreaterThan(80_000);
		expect(whole).toContain('"cwd":"/Users/alice/proj"');
		expect(whole).not.toContain('"cwd":"/Users/jdoe/proj"');
	});

	test("a file with no header in its first window, or an old home it does not name, passes through byte for byte", async () => {
		const none = `${JSON.stringify({ type: "message", cwd: "/Users/jdoe/x" })}\n`.repeat(3);
		expect(await run([Buffer.from(none)])).toBe(none);
		const same = `${slot}${JSON.stringify({ ...header, cwd: "/elsewhere", parentSession: undefined, additionalDirectories: undefined, previousSessionFiles: undefined })}\n${body}`;
		const changed: boolean[] = [];
		expect(await run([Buffer.from(same)], (h) => changed.push(h.changed))).toBe(same);
		expect(changed).toEqual([false]);
		expect(await run([])).toBe("");
	});
});

describe("encrypted logins", () => {
	const plain = Buffer.from(JSON.stringify({ secret: "value" }));

	test("they come back with the password, and only with it", async () => {
		const sealed = await encrypt(plain, "correct horse battery");
		expect(sealed.toString("latin1")).not.toContain("value");
		expect((await decrypt(sealed, "correct horse battery")).equals(plain)).toBe(true);
		await expect(decrypt(sealed, "correct horse batterY")).rejects.toBeInstanceOf(WrongPasswordError);
		await expect(decrypt(sealed, "")).rejects.toBeInstanceOf(WrongPasswordError);
	});

	test("two encryptions of the same thing differ (a fresh salt and nonce each time), and a password is read as Unicode text", async () => {
		const a = await encrypt(plain, "pässword-1234");
		const b = await encrypt(plain, "pässword-1234");
		expect(a.equals(b)).toBe(false);
		// The same letters composed or decomposed (a keyboard and a file name may differ) are the same password.
		expect((await decrypt(a, "pa\u0308ssword-1234".normalize("NFD"))).equals(plain)).toBe(true);
	});

	test("a changed byte anywhere is refused, the way a wrong password is, not decrypted into something else", async () => {
		const sealed = await encrypt(plain, "correct horse battery");
		for (const at of [14, 40, sealed.length - 20, sealed.length - 1]) {
			const damaged = Buffer.from(sealed);
			damaged[at] ^= 1;
			await expect(decrypt(damaged, "correct horse battery"), `byte ${at}`).rejects.toBeInstanceOf(Error);
		}
		await expect(decrypt(sealed.subarray(0, sealed.length - 3), "correct horse battery")).rejects.toBeInstanceOf(Error);
		await expect(decrypt(Buffer.from("not encrypted at all"), "x")).rejects.toThrow(/not an encrypted part/);
	});

	test("the key is made at scrypt's N=2^17 (the cost OWASP asks for), and nothing above 2^18 is obeyed", async () => {
		const sealed = await encrypt(plain, "correct horse battery");
		const length = sealed.readUInt32BE(8);
		const header = JSON.parse(sealed.subarray(12, 12 + length).toString("utf8"));
		expect(header).toMatchObject({ kdf: "scrypt", N: 131072, r: 8, p: 1 });
		const asking = Buffer.from(JSON.stringify({ ...header, N: 2 ** 19 }));
		const forged = Buffer.concat([sealed.subarray(0, 8), Buffer.alloc(4), asking, sealed.subarray(12 + length)]);
		forged.writeUInt32BE(asking.length, 8);
		const started = Date.now();
		await expect(decrypt(forged, "correct horse battery")).rejects.toThrow(/parameters this version does not know/);
		expect(Date.now() - started).toBeLessThan(2000);
	});

	test("a file that asks for more work than the cost it was made with is not obeyed", async () => {
		const sealed = await encrypt(plain, "correct horse battery");
		const length = sealed.readUInt32BE(8);
		const header = JSON.parse(sealed.subarray(12, 12 + length).toString("utf8"));
		header.N = 2 ** 30;
		const bytes = Buffer.from(JSON.stringify(header));
		const forged = Buffer.concat([
			sealed.subarray(0, 8),
			Buffer.from(new Uint32Array([0]).buffer),
			bytes,
			sealed.subarray(12 + length),
		]);
		forged.writeUInt32BE(bytes.length, 8);
		const started = Date.now();
		await expect(decrypt(forged, "correct horse battery")).rejects.toThrow(/parameters this version does not know/);
		expect(Date.now() - started).toBeLessThan(2000);
	});
});

describe("secrets inside configuration files", () => {
	test("a key that names a secret is blanked, in YAML as written, comments and neighbours kept", () => {
		const text = `# mine\nproviders:\n  local:\n    baseUrl: http://127.0.0.1:8000/v1   # here\n    apiKey: sk-abcdefghijklmnopqrstuvwxyz0123   # key\n    maxTokens: 123\n    password: |\n      line one\n      line two\n    other: 1\n`;
		const r = redactSecrets(text, "yaml");
		expect(r).toEqual({
			text: `# mine\nproviders:\n  local:\n    baseUrl: http://127.0.0.1:8000/v1   # here\n    apiKey: ""   # key\n    maxTokens: 123\n    password: ""\n    other: 1\n`,
			count: 2,
			clean: true,
		});
		expect(countSecrets(text, "yaml")).toBe(2);
	});

	test("a reference to a secret is not one: a variable's name or command for an apiKey, a variable filled in later, 'none'", () => {
		const text = `a:\n  apiKey: OPENAI_API_KEY\n  other:\n    apiKey: "!security find-generic-password -s x -w"\n  auth: none\n  secret: \${HOME_SECRET}\n  password: ""\n  token: Bearer \${GH_TOKEN}\n`;
		const r = redactSecrets(text, "yaml");
		expect(r.text).toBe(text);
		expect(r.count).toBe(0);
		expect(r.clean).toBe(true);
		// Under any other name, the same words are a value like any other.
		expect(redactSecrets('a:\n  token: "!cat /x"\n  SERVICE_KEY: OPENAI_API_KEY\n', "yaml").count).toBe(2);
	});

	test("JSON: headers, environment values, flags that take a secret, a URL's password, and a token by its shape", () => {
		const doc = {
			servers: {
				github: {
					url: "https://mcp.example.com",
					headers: { Authorization: "Bearer ghp_0123456789abcdefghijklmnopqrstuvwxyz", Accept: "x" },
				},
				run: {
					command: "npx",
					args: ["-y", "--api-key", "zzzzzzzz1234", "--token=abcdef12345", "--port", "9"],
					env: { API_TOKEN: "tok_0123456789", PORT: "9877" },
					url: "postgres://user:hunter2hunter2@db.example.com/x",
					note: "sk-0123456789abcdefghijklmnop",
				},
			},
		};
		const r = redactSecrets(JSON.stringify(doc, null, 2), "json");
		const out = JSON.parse(r.text);
		expect(out.servers.github.headers).toEqual({ Authorization: "", Accept: "x" });
		expect(out.servers.run.args).toEqual(["-y", "--api-key", "", "--token=", "--port", "9"]);
		expect(out.servers.run.env).toEqual({ API_TOKEN: "", PORT: "9877" });
		expect(out.servers.run.url).toBe("postgres://user@db.example.com/x");
		expect(out.servers.run.note).toBe("");
		expect(r.clean).toBe(true);
		expect(r.count).toBe(6);
		// A minified file has no line to a value: the document is written again, with its indentation of two.
		expect(redactSecrets(JSON.stringify(doc), "json").clean).toBe(true);
	});

	test("a file that is not a document is read line by line: what is shaped like a secret, or named like one, is blanked", () => {
		const r = redactSecrets("not: [valid yaml\nkey: sk-0123456789abcdefghijklmnop\nnote: fine\n", "yaml");
		expect(r).toEqual({ text: "not: [valid yaml\nkey: \nnote: fine\n", count: 1, clean: true });
		expect(redactSecrets("just prose with no secret in it: [\n", "yaml")).toEqual({
			text: "just prose with no secret in it: [\n",
			count: 0,
			clean: true,
		});
	});
});

describe("databases that a running omp holds open", () => {
	test("a snapshot has what is still only in the -wal; a plain file copy of the database does not", () => {
		const live = join(root, "live.db");
		const db = new Database(live);
		db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (x TEXT);");
		db.run("INSERT INTO t VALUES ('only in the wal')");
		writeFileSync(join(root, "naive.db"), readFileSync(live));
		snapshotDb(live, join(root, "snap.db"));
		db.close();
		expect(new Database(join(root, "snap.db"), { readonly: true }).query("SELECT x FROM t").all()).toEqual([
			{ x: "only in the wal" },
		]);
		expect(() => new Database(join(root, "naive.db"), { readonly: true }).query("SELECT x FROM t").all()).toThrow();
	});

	function loginDb(name: string, version: number, rows: [string, string, string | null][]): string {
		const path = join(root, name);
		const db = new Database(path);
		db.exec(
			"CREATE TABLE auth_schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);" +
				"CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT NOT NULL, identity_key TEXT DEFAULT NULL, created_at INTEGER NOT NULL DEFAULT 0);" +
				"CREATE TABLE usage (n INTEGER);",
		);
		db.run("INSERT INTO auth_schema_version VALUES (1, ?)", [version]);
		for (const [provider, data, identity] of rows)
			db.run("INSERT INTO auth_credentials (provider, credential_type, data, identity_key) VALUES (?, 'oauth', ?, ?)", [
				provider,
				data,
				identity,
			]);
		db.run("INSERT INTO usage VALUES (1)");
		db.close();
		return path;
	}
	const rowsOf = (path: string) =>
		new Database(path, { readonly: true })
			.query("SELECT provider, data FROM auth_credentials ORDER BY provider, id")
			.all();

	test("only the logins are taken from a login database: the usage records stay behind", () => {
		const src = loginDb("auth-src.db", 8, [["anthropic", "a", "acct"]]);
		const out = join(root, "auth-only.db");
		expect(authSnapshot(src, out)).toEqual({ credentials: 1, providers: ["anthropic"] });
		const db = new Database(out, { readonly: true });
		expect(db.query("SELECT COUNT(*) AS n FROM usage").get()).toEqual({ n: 0 });
		expect(db.query("SELECT COUNT(*) AS n FROM auth_credentials").get()).toEqual({ n: 1 });
	});

	test("restoring: this Mac's own account stays unless the archive is to win; other accounts are added; a newer layout is not touched", () => {
		const archive = loginDb("auth-a.db", 8, [
			["anthropic", "theirs", "acct"],
			["other", "theirs", null],
		]);
		const merged = loginDb("auth-m.db", 8, [
			["anthropic", "mine", "acct"],
			["local", "mine", null],
		]);
		expect(restoreAuth(merged, archive, "merge")).toEqual({ restored: 2, providers: ["anthropic", "other"] });
		expect(rowsOf(merged)).toEqual([
			{ provider: "anthropic", data: "mine" },
			{ provider: "local", data: "mine" },
			{ provider: "other", data: "theirs" },
		]);
		const replaced = loginDb("auth-r.db", 8, [
			["anthropic", "mine", "acct"],
			["local", "mine", null],
		]);
		restoreAuth(replaced, archive, "replace");
		expect(rowsOf(replaced)).toEqual([
			{ provider: "anthropic", data: "theirs" },
			{ provider: "local", data: "mine" },
			{ provider: "other", data: "theirs" },
		]);
		// The same login twice is one login.
		restoreAuth(replaced, archive, "replace");
		expect(rowsOf(replaced)).toHaveLength(3);
		const older = loginDb("auth-o.db", 7, [["local", "mine", null]]);
		expect(restoreAuth(older, archive, "merge")).toEqual({ skipped: "omp-older" });
		expect(rowsOf(older)).toEqual([{ provider: "local", data: "mine" }]);
		const none = join(root, "auth-new.db");
		expect(restoreAuth(none, archive, "merge")).toMatchObject({ restored: 2 });
		expect(rowsOf(none)).toHaveLength(2);
	});

	function historyDb(name: string, rows: [string, number, number][]): string {
		const path = join(root, name);
		const db = new Database(path);
		db.exec(
			"CREATE TABLE history (id INTEGER PRIMARY KEY AUTOINCREMENT, prompt TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL DEFAULT 0, cwd TEXT, use_count INTEGER NOT NULL DEFAULT 1);" +
				"CREATE TABLE session_titles (session_id TEXT PRIMARY KEY, title TEXT NOT NULL);" +
				"CREATE TABLE session_recaps (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, cwd TEXT NOT NULL, recap TEXT NOT NULL);",
		);
		for (const [prompt, at, uses] of rows)
			db.run("INSERT INTO history (prompt, created_at, cwd, use_count) VALUES (?, ?, '/x', ?)", [prompt, at, uses]);
		db.run("INSERT INTO session_recaps (session_id, cwd, recap) VALUES ('s', '/y', 'r')");
		db.close();
		return path;
	}

	test("history: a database that omp has not made every table of yet is joined with one that has them, either way round", () => {
		const full = historyDb("h-full.db", [["one", 1, 1]]);
		const onlyPrompts = (name: string, rows: [string, number, number][]): string => {
			const path = join(root, name);
			const db = new Database(path);
			db.exec(
				"CREATE TABLE history (id INTEGER PRIMARY KEY AUTOINCREMENT, prompt TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL DEFAULT 0, cwd TEXT, use_count INTEGER NOT NULL DEFAULT 1)",
			);
			for (const [prompt, at, uses] of rows)
				db.run("INSERT INTO history (prompt, created_at, cwd, use_count) VALUES (?, ?, '/x', ?)", [prompt, at, uses]);
			db.close();
			return path;
		};
		// The archive lacks the other tables: its prompts still come.
		const mine = historyDb("h-mine.db", [["mine", 1, 1]]);
		expect(mergeHistory(mine, onlyPrompts("h-p1.db", [["theirs", 2, 1]]), "merge")).toMatchObject({
			prompts: 1,
			titles: 0,
			recaps: 0,
		});
		// This one lacks them: they are made from the archive's, and its recaps come.
		const bare = onlyPrompts("h-p2.db", [["mine", 1, 1]]);
		expect(mergeHistory(bare, full, "merge")).toMatchObject({ prompts: 1, titles: 0, recaps: 1 });
		expect(new Database(bare, { readonly: true }).query("SELECT recap FROM session_recaps").all()).toEqual([
			{ recap: "r" },
		]);
	});

	test("history: a prompt both have is not doubled; nothing changes when the archive adds nothing; the folders of it are found", () => {
		const archive = historyDb("h-a.db", [
			["one", 1, 5],
			["two", 2, 1],
		]);
		const mine = historyDb("h-m.db", [["one", 9, 2]]);
		const first = mergeHistory(mine, archive, "merge");
		expect(first).toMatchObject({ prompts: 1, titles: 0, recaps: 0 });
		expect(first.changes).toBeGreaterThan(0);
		const db = new Database(mine, { readonly: true });
		expect(db.query("SELECT prompt, use_count FROM history ORDER BY id").all()).toEqual([
			{ prompt: "one", use_count: 2 },
			{ prompt: "two", use_count: 1 },
		]);
		db.close();
		expect(mergeHistory(mine, archive, "merge").changes).toBe(0);
		expect(mergeHistory(mine, archive, "replace").changes).toBeGreaterThan(0);
		expect(mergeHistory(mine, archive, "replace").changes).toBe(0);
		expect(foldersOf(archive).sort()).toEqual(["/x", "/y"]);
	});
});

describe("merging settings", () => {
	test("what this Mac has stays, what it lacks is added, two objects are merged key by key, a list with an identity by it", () => {
		const mine = { a: 1, deep: { x: 1, y: [1] }, list: [{ name: "m", v: 1 }] };
		const theirs = {
			a: 2,
			b: 3,
			deep: { x: 9, z: 2, y: [2] },
			list: [
				{ name: "m", v: 2 },
				{ name: "t", v: 1 },
			],
		};
		const merged = structuredClone(mine) as Record<string, unknown>;
		expect(mergeDoc(merged, theirs, "merge", { list: "name" })).toBe(true);
		expect(merged).toEqual({
			a: 1,
			b: 3,
			deep: { x: 1, y: [1], z: 2 },
			list: [
				{ name: "m", v: 1 },
				{ name: "t", v: 1 },
			],
		});
		expect(mergeDoc(merged, theirs, "merge", { list: "name" })).toBe(false);
		const replaced = structuredClone(mine) as Record<string, unknown>;
		mergeDoc(replaced, theirs, "replace", { list: "name" });
		expect(replaced).toEqual({
			a: 2,
			b: 3,
			deep: { x: 9, y: [2], z: 2 },
			list: [
				{ name: "m", v: 2 },
				{ name: "t", v: 1 },
			],
		});
		expect(parseDoc("a: [", "yaml")).toBeNull();
		expect(parseDoc("[1]", "json")).toBeNull();
	});

	test("lists of names are joined with the first one's order, once each", () => {
		expect(unionList(["a", "b"], ["b", "c", 3])).toEqual(["a", "b", "c"]);
		expect(unionList("nope", ["x"])).toEqual(["x"]);
	});

	test("a file is the start of another when the other goes on from it", async () => {
		const write = (name: string, text: string) => {
			const path = join(root, name);
			writeFileSync(path, text);
			return path;
		};
		const base = write("c-base", "line1\nline2\n");
		expect(await compareFiles(base, write("c-same", "line1\nline2\n"))).toEqual({ same: true, extends: false });
		expect(await compareFiles(base, write("c-more", "line1\nline2\nline3\n"))).toEqual({ same: false, extends: true });
		expect(await compareFiles(base, write("c-other", "line1\nlineX\nline3\n"))).toEqual({
			same: false,
			extends: false,
		});
		expect(await compareFiles(base, write("c-short", "line1\n"))).toEqual({ same: false, extends: false });
		const big = "x".repeat(3 * 1024 * 1024);
		expect(await compareFiles(write("c-big", big), write("c-bigger", `${big}y`))).toEqual({
			same: false,
			extends: true,
		});
		expect(await compareFiles(write("c-big2", `${big}y`), write("c-bigger2", `${big}z`))).toEqual({
			same: false,
			extends: false,
		});
	});
});

describe("the archive's table of contents", () => {
	const entry = {
		path: "agent/config.yml",
		category: "settings",
		kind: "config",
		size: 1,
		sha256: "a".repeat(64),
		mode: 0o644,
		mtimeMs: 1,
	};
	const manifest = (over: Record<string, unknown> = {}) => ({
		format: 1,
		app: "omp-webui",
		createdAt: "2026-01-01T00:00:00.000Z",
		source: {
			host: "h",
			user: "u",
			home: "/Users/jdoe",
			agentDir: "/a",
			dataDir: "/d",
			ompVersion: "1",
			serverVersion: "1",
		},
		entries: [entry],
		...over,
	});
	const code = (v: unknown): string | null => {
		try {
			parseManifest(v);
			return null;
		} catch (e) {
			return e instanceof CodedError ? e.code : "other";
		}
	};

	test("a well-formed manifest is read; a newer format, another app, and every wrong shape are refused with their own code", () => {
		expect(parseManifest(manifest()).entries).toHaveLength(1);
		expect(code(manifest({ format: 2 }))).toBe("migrateNewerFormat");
		expect(code(manifest({ format: 99, entries: "damaged" }))).toBe("migrateNewerFormat");
		for (const bad of [
			null,
			[],
			manifest({ app: "other" }),
			manifest({ format: -1 }),
			manifest({ entries: "x" }),
			manifest({ entries: [{ ...entry, category: "nonsense" }] }),
			manifest({ entries: [{ ...entry, kind: "device" }] }),
			manifest({ entries: [{ ...entry, sha256: "xyz" }] }),
			manifest({ entries: [{ ...entry, size: -1 }] }),
			manifest({ source: null }),
			manifest({ leftOut: [{ path: "x", reason: "because", bytes: 1 }] }),
		]) {
			expect(code(bad), JSON.stringify(bad)?.slice(0, 80)).toBe("migrateCorrupt");
		}
	});

	test("the archive is named for the machine and the day, and a host name cannot make it a path", () => {
		expect(migrateArchiveName("Jane's MacBook Pro", new Date("2026-10-21T12:00:00Z"))).toBe(
			"omp-webui-migration-Jane-s-MacBook-Pro-2026-10-21.ompw",
		);
		expect(migrateArchiveName("../../etc", new Date("2026-10-21T12:00:00Z"))).toBe(
			"omp-webui-migration-etc-2026-10-21.ompw",
		);
		expect(migrateArchiveName("", new Date("2026-10-21T12:00:00Z"))).toBe("omp-webui-migration-mac-2026-10-21.ompw");
	});
});
