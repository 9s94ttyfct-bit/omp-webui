import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { readFolderFile } from "../../server/folder.ts";
import { type TransferOptions, TransferService } from "../../server/folder-transfer.ts";
import { mayEdit } from "../../server/folder-write.ts";
import type { TransferEnv } from "../../server/transfer-core.ts";
import { FOLDER_LIMITS, type FolderFile, type FolderSaved } from "../../shared/folder.ts";
import { ERROR_HEADER, type TransferRecord } from "../../shared/transfer.ts";
import { tempDir } from "../support/temp-dirs.ts";

/**
 * The save into a file (`POST /api/folder/file`, `server/folder-write.ts`), asked of the transfer service itself on folders made
 * here: where a save may land, who may make one, what it is made from (the etag), and that what is written is whole, with the
 * permissions the file had, or nothing. The route, the token, the CSRF header and the pages that really come through a tunnel
 * are in `tests/contract/folder-edit.test.ts`.
 *
 *   scratch/<case>/
 *     home/        the home folder of the person the server runs as
 *     home/proj/   the conversation's folder
 *     outside/     what no save may touch
 *     data/        a folder an omp-webui keeps its own data in
 */

const scratch = realpathSync(tempDir("ompw-edit-"));
let cases = 0;
const services: TransferService[] = [];
afterAll(async () => {
	for (const s of services) await s.close();
});

const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
/** Text in Latin-1 (an é is the byte 0xE9): mostly ASCII, so the read takes it for text, and it is not UTF-8. */
const LATIN1 = Buffer.concat([Buffer.from("plain ascii text before the accent ".repeat(4)), Buffer.from([0xe9, 0x0a])]);

function world(opts: Partial<TransferOptions> = {}, root: "proj" | "home" = "proj") {
	const top = join(scratch, `case-${++cases}`);
	const home = join(top, "home");
	const proj = join(home, "proj");
	const outside = join(top, "outside");
	const data = join(top, "data");
	for (const dir of [proj, outside, data]) mkdirSync(dir, { recursive: true });
	const service = new TransferService({ logFile: join(top, "transfers.jsonl"), ...opts });
	services.push(service);
	const cwd = root === "proj" ? proj : home;
	const env = (over: Partial<TransferEnv> = {}): TransferEnv => ({
		setting: "full",
		local: false,
		who: "me@example.test",
		dataDirs: [data],
		protect: [data, join(proj, "protected")],
		home,
		...over,
	});
	/** A save as a page makes it. `over` replaces what the body says; a string is the body as it is. */
	const save = async (over: Record<string, unknown> | string, e = env()) => {
		const url = new URL("http://x/api/folder/file");
		const body = typeof over === "string" ? over : JSON.stringify({ path: "a.txt", text: "x", etag: "0", ...over });
		const res = await service.handle(
			new Request(url, { method: "POST", body, headers: { "content-type": "application/json" } }),
			url,
			{ cwdOf: async () => cwd },
			e,
		);
		return {
			res,
			status: res.status,
			json: (await res.json()) as FolderSaved & { code?: string; error?: string; etag: string; limit?: number },
		};
	};
	const log = () =>
		existsSync(join(top, "transfers.jsonl"))
			? readFileSync(join(top, "transfers.jsonl"), "utf8")
					.split("\n")
					.filter(Boolean)
					.map((l) => JSON.parse(l) as TransferRecord)
			: [];
	return { top, home, proj, outside, data, service, env, save, log };
}

const write = (path: string, text: string | Uint8Array, mode?: number) => {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text);
	if (mode !== undefined) chmodSync(path, mode);
};
/** What is left in a folder: a save that failed leaves nothing of its own beside the file. */
const names = (dir: string) => readdirSync(dir).sort();

describe("a save", () => {
	test("replaces the text, answers the etag of what is there, keeps the file's permissions and leaves nothing beside it", async () => {
		const w = world();
		write(join(w.proj, "a.txt"), "one\n", 0o640);
		write(join(w.proj, "run.sh"), "#!/bin/sh\n", 0o755);
		write(join(w.proj, "other.txt"), "other\n");
		const { status, json } = await w.save({ text: "one\ntwo\n", etag: sha("one\n") });
		expect(status).toBe(200);
		expect(readFileSync(join(w.proj, "a.txt"), "utf8")).toBe("one\ntwo\n");
		expect(json).toMatchObject({ etag: sha("one\ntwo\n"), size: 8 });
		expect(statSync(join(w.proj, "a.txt")).mode & 0o777).toBe(0o640);
		// A program keeps being one; a file that was not never becomes one.
		expect((await w.save({ path: "run.sh", text: "#!/bin/sh\necho hi\n", etag: sha("#!/bin/sh\n") })).status).toBe(200);
		expect(statSync(join(w.proj, "run.sh")).mode & 0o777).toBe(0o755);
		expect(readFileSync(join(w.proj, "other.txt"), "utf8")).toBe("other\n");
		expect(names(w.proj)).toEqual(["a.txt", "other.txt", "run.sh"]);
	});

	test("is logged with who made it, what it was and its hash; a refusal of a rule is logged too", async () => {
		const w = world();
		write(join(w.proj, "a.txt"), "a");
		write(join(w.proj, ".github/workflows/ci.yml"), "on: push\n");
		await w.save({ text: "b", etag: sha("a") });
		await w.save({ path: ".github/workflows/ci.yml", text: "on: pull_request\n", etag: sha("on: push\n") });
		expect(w.log()).toMatchObject([
			{ kind: "edit", who: "me@example.test", root: w.proj, path: "a.txt", size: 1, sha256: sha("b"), status: "ok" },
			{ kind: "edit", path: ".github/workflows/ci.yml", status: "refused:protected" },
		]);
	});

	test("a text that is the file already is not written again: the file is not touched", async () => {
		const w = world();
		write(join(w.proj, "a.txt"), "same\n");
		const then = new Date(2020, 0, 1);
		utimesSync(join(w.proj, "a.txt"), then, then);
		const { status, json } = await w.save({ text: "same\n", etag: sha("same\n") });
		expect(status).toBe(200);
		expect(json.etag).toBe(sha("same\n"));
		expect(statSync(join(w.proj, "a.txt")).mtimeMs).toBe(then.getTime());
	});

	test("a byte order mark the file had stays, whether or not the page saw it; the text is written as it is (line endings too)", async () => {
		const w = world();
		const bom = Buffer.from([0xef, 0xbb, 0xbf]);
		write(join(w.proj, "a.txt"), Buffer.concat([bom, Buffer.from("héllo\r\n")]));
		const etag = sha(readFileSync(join(w.proj, "a.txt")));
		const { status } = await w.save({ text: "héllo\r\nwörld\r\n", etag });
		expect(status).toBe(200);
		expect([...readFileSync(join(w.proj, "a.txt"))]).toEqual([...bom, ...Buffer.from("héllo\r\nwörld\r\n")]);
		// A file that had none does not get one.
		write(join(w.proj, "b.txt"), "plain");
		await w.save({ path: "b.txt", text: "plain 2", etag: sha("plain") });
		expect(readFileSync(join(w.proj, "b.txt"), "utf8")).toBe("plain 2");
	});

	test("goes through a link to a file inside the folder: the file it leads to is written and the link stays", async () => {
		const w = world();
		write(join(w.proj, "real.txt"), "real");
		symlinkSync(join(w.proj, "real.txt"), join(w.proj, "link.txt"));
		const { status } = await w.save({ path: "link.txt", text: "changed", etag: sha("real") });
		expect(status).toBe(200);
		expect(readFileSync(join(w.proj, "real.txt"), "utf8")).toBe("changed");
		expect(lstatSync(join(w.proj, "link.txt")).isSymbolicLink()).toBe(true);
	});
});

describe("what a save is made from", () => {
	test("a file that is not the one the text was made from is a 409 with the etag it has now; saving again with it overwrites", async () => {
		const w = world();
		write(join(w.proj, "a.txt"), "mine\n");
		const stale = sha("mine\n");
		write(join(w.proj, "a.txt"), "theirs\n");
		const first = await w.save({ text: "mine, changed\n", etag: stale });
		expect(first.status).toBe(409);
		expect(first.json).toMatchObject({ code: "conflict", etag: sha("theirs\n") });
		expect(first.res.headers.get(ERROR_HEADER)).toBe("conflict");
		expect(readFileSync(join(w.proj, "a.txt"), "utf8")).toBe("theirs\n");
		const again = await w.save({ text: "mine, changed\n", etag: first.json.etag });
		expect(again.status).toBe(200);
		expect(readFileSync(join(w.proj, "a.txt"), "utf8")).toBe("mine, changed\n");
		// A refusal that was only a mistake of the request is not logged as a rule saying no.
		expect(w.log().map((l) => l.status)).toEqual(["ok"]);
	});

	test("a file touched with the same text is still the one (the etag is the bytes, not the time)", async () => {
		const w = world();
		write(join(w.proj, "a.txt"), "same\n");
		const etag = sha("same\n");
		write(join(w.proj, "a.txt"), "same\n");
		expect((await w.save({ text: "new\n", etag })).status).toBe(200);
	});

	test("a file that changes between the look and the swap is a conflict, and is not overwritten", async () => {
		const w = world({
			beforePublish: () => {
				writeFileSync(join(w.proj, "a.txt"), "someone else, meanwhile\n");
			},
		});
		write(join(w.proj, "a.txt"), "one\n");
		const { status, json } = await w.save({ text: "mine\n", etag: sha("one\n") });
		expect(status).toBe(409);
		expect(json.etag).toBe(sha("someone else, meanwhile\n"));
		expect(readFileSync(join(w.proj, "a.txt"), "utf8")).toBe("someone else, meanwhile\n");
		// What was written beside the file for the swap is gone with the refusal.
		expect(names(w.proj)).toEqual(["a.txt"]);
	});

	test("a file that is larger than a file is edited at is not saved into, whatever its etag says", async () => {
		const w = world();
		const big = "x".repeat(FOLDER_LIMITS.editBytes + 1);
		write(join(w.proj, "a.txt"), big);
		const { status, json } = await w.save({ text: "small", etag: sha(big) });
		expect(status).toBe(413);
		expect(json).toMatchObject({ code: "tooLarge", limit: FOLDER_LIMITS.editBytes });
		expect(readFileSync(join(w.proj, "a.txt"), "utf8")).toBe(big);
	});
});

describe("what a save refuses", () => {
	test("text over the limit (counted as UTF-8), and a body that is far over it", async () => {
		const w = world();
		write(join(w.proj, "a.txt"), "a");
		const etag = sha("a");
		// Exactly the limit is fine; one byte more is not; a character of two bytes counts for both.
		expect((await w.save({ text: "x".repeat(FOLDER_LIMITS.editBytes), etag })).status).toBe(200);
		const next = sha("x".repeat(FOLDER_LIMITS.editBytes));
		expect((await w.save({ text: "x".repeat(FOLDER_LIMITS.editBytes + 1), etag: next })).json.code).toBe("tooLarge");
		const wide = await w.save({ text: "é".repeat(FOLDER_LIMITS.editBytes / 2 + 1), etag: next });
		expect(wide).toMatchObject({ status: 413, json: { code: "tooLarge" } });
		const huge = await w.save(JSON.stringify({ path: "a.txt", text: "x".repeat(9 * 1024 * 1024), etag: next }));
		expect(huge.status).toBe(413);
		expect(readFileSync(join(w.proj, "a.txt"), "utf8")).toBe("x".repeat(FOLDER_LIMITS.editBytes));
	});

	test("a file that is not UTF-8 text is not rewritten: a binary file, and text in another encoding", async () => {
		const w = world();
		const binary = new Uint8Array([0x89, 0x50, 0x00, 0x01, 0x02]);
		const latin1 = LATIN1;
		write(join(w.proj, "a.bin"), binary);
		write(join(w.proj, "b.txt"), latin1);
		for (const [path, bytes] of [
			["a.bin", binary],
			["b.txt", latin1],
		] as const) {
			const { status, json } = await w.save({ path, text: "text", etag: sha(bytes) });
			expect(status, path).toBe(415);
			expect(json.code, path).toBe("notText");
			expect([...readFileSync(join(w.proj, path))], path).toEqual([...bytes]);
		}
	});

	test("nothing outside the folder, whatever the way to it", async () => {
		const w = world();
		write(join(w.outside, "o.txt"), "outside");
		symlinkSync(join(w.outside, "o.txt"), join(w.proj, "link-out.txt"));
		symlinkSync(w.outside, join(w.proj, "link-dir"));
		for (const path of [
			"../outside/o.txt",
			"src/../../outside/o.txt",
			join(w.outside, "o.txt"),
			"link-out.txt",
			"link-dir/o.txt",
		]) {
			const { status, json } = await w.save({ path, text: "changed", etag: sha("outside") });
			expect([status, json.code], path).toEqual([403, "outside"]);
		}
		expect(readFileSync(join(w.outside, "o.txt"), "utf8")).toBe("outside");
		expect(names(w.outside)).toEqual(["o.txt"]);
	});

	test("a file that is not there is not made; a folder is not a file", async () => {
		const w = world();
		mkdirSync(join(w.proj, "dir"));
		const missing = await w.save({ path: "new.txt", text: "x", etag: sha("") });
		expect([missing.status, missing.json.code]).toEqual([404, "notFound"]);
		expect(existsSync(join(w.proj, "new.txt"))).toBe(false);
		const dir = await w.save({ path: "dir", text: "x", etag: sha("") });
		expect([dir.status, dir.json.code]).toEqual([415, "notFile"]);
		expect(names(w.proj)).toEqual(["dir"]);
	});

	test("what CI runs, what looks like a secret, a protected place and the app's own data: for a page on this computer too", async () => {
		const w = world();
		const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n";
		const files: [string, string, string][] = [
			[".github/workflows/ci.yml", "on: push\n", "protected"],
			[".GitHub/Actions/run.yml", "run\n", "protected"],
			["src/.env", "A=1\n", "secret"],
			["src/id_rsa", "x\n", "secret"],
			["notes.txt", key, "secret"],
			["protected/file.txt", "p\n", "protected"],
		];
		for (const [path, text] of files) write(join(w.proj, path), text);
		for (const local of [true, false]) {
			for (const [path, text, code] of files) {
				const { status, json } = await w.save({ path, text: "changed", etag: sha(text) }, w.env({ local }));
				expect([status, json.code], `${path} ${local ? "local" : "remote"}`).toEqual([403, code]);
				expect(readFileSync(join(w.proj, path), "utf8"), path).toBe(text);
			}
		}
		// The data folder of an omp-webui, when the conversation's folder holds it (and a path that goes there through a link).
		const inner = world();
		const dataIn = join(inner.proj, "appdata");
		write(join(dataIn, "state.json"), "{}");
		const env = inner.env({ dataDirs: [dataIn], protect: [] });
		const refused = await inner.save({ path: "appdata/state.json", text: "{}", etag: sha("{}") }, env);
		expect([refused.status, refused.json.code]).toEqual([403, "ownData"]);
		symlinkSync(dataIn, join(inner.proj, "via-link"));
		const viaLink = await inner.save({ path: "via-link/state.json", text: "{ }", etag: sha("{}") }, env);
		expect([viaLink.status, viaLink.json.code]).toEqual([403, "ownData"]);
		expect(readFileSync(join(dataIn, "state.json"), "utf8")).toBe("{}");
	});

	test("a request that is not a save: no body, not JSON, the wrong kinds, no etag", async () => {
		const w = world();
		write(join(w.proj, "a.txt"), "a");
		for (const body of [
			"",
			"not json",
			"[]",
			JSON.stringify({ path: "a.txt", text: "x" }),
			JSON.stringify({ path: "a.txt", text: "x", etag: "" }),
			JSON.stringify({ path: "a.txt", text: 5, etag: "e" }),
			JSON.stringify({ path: "", text: "x", etag: "e" }),
			JSON.stringify({ path: 7, text: "x", etag: "e" }),
			JSON.stringify({ path: "a.txt", text: "x", etag: "e", live: 3 }),
		]) {
			const { status, json } = await w.save(body);
			expect([status, json.code], body).toEqual([400, "badRequest"]);
		}
		expect(readFileSync(join(w.proj, "a.txt"), "utf8")).toBe("a");
	});
});

describe("who may save", () => {
	test("a page that is not on this computer may when it may upload, and only then; this computer's page always may", async () => {
		const w = world();
		write(join(w.proj, "a.txt"), "a");
		for (const [setting, code] of [
			["off", "off"],
			["download", "uploadOff"],
		] as const) {
			const { status, json } = await w.save({ text: "b", etag: sha("a") }, w.env({ setting }));
			expect([status, json.code], setting).toEqual([403, code]);
			expect(readFileSync(join(w.proj, "a.txt"), "utf8")).toBe("a");
		}
		expect((await w.save({ text: "b", etag: sha("a") }, w.env({ setting: "full" }))).status).toBe(200);
		expect((await w.save({ text: "c", etag: sha("b") }, w.env({ setting: "off", local: true }))).status).toBe(200);
		// The refusals are the person's rule saying no: they are in the log, with who asked.
		expect(w.log().map((l) => l.status)).toEqual(["refused:off", "refused:uploadOff", "ok", "ok"]);
	});

	test("a page that is not on this computer is not written for what the Files tab does not show it, nor in a home folder", async () => {
		const w = world();
		write(join(w.proj, ".hidden.txt"), "h");
		write(join(w.proj, "dist/out.txt"), "d");
		for (const path of [".hidden.txt", "dist/out.txt"]) {
			const { status, json } = await w.save({ path, text: "x", etag: sha(path.startsWith("dist") ? "d" : "h") });
			expect([status, json.code], path).toEqual([403, "hidden"]);
		}
		// This computer's page is shown them, and so edits them.
		const local = await w.save({ path: ".hidden.txt", text: "x", etag: sha("h") }, w.env({ local: true }));
		expect(local.status).toBe(200);
		const home = world({}, "home");
		write(join(home.home, "notes.txt"), "n");
		const remote = await home.save({ path: "notes.txt", text: "x", etag: sha("n") });
		expect([remote.status, remote.json.code]).toEqual([403, "homeFolder"]);
		expect((await home.save({ path: "notes.txt", text: "x", etag: sha("n") }, home.env({ local: true }))).status).toBe(
			200,
		);
	});
});

describe("what the read says of a file: its etag, and whether it is editable", () => {
	const read = (root: string, rel: string, guarded = false) => readFolderFile(root, rel, false, { guarded });
	const text = async (root: string, rel: string) => {
		const file = await read(root, rel);
		if (file.kind !== "text") throw new Error(`${rel} is ${file.kind}`);
		return file;
	};

	test("the etag is the SHA-256 of the bytes: another for other content, the same for the same, and what a save answers", async () => {
		const w = world();
		write(join(w.proj, "a.txt"), "one\n");
		const first = await text(w.proj, "a.txt");
		expect(first.etag).toBe(sha("one\n"));
		write(join(w.proj, "a.txt"), "one\n");
		expect((await text(w.proj, "a.txt")).etag).toBe(first.etag);
		const saved = await w.save({ text: "two\n", etag: first.etag });
		expect((await text(w.proj, "a.txt")).etag).toBe(saved.json.etag);
		// The BOM is in the bytes: a file with one is another file than one without.
		write(join(w.proj, "b.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("x")]));
		write(join(w.proj, "c.txt"), "x");
		expect((await text(w.proj, "b.txt")).etag).not.toBe((await text(w.proj, "c.txt")).etag);
	});

	test("what is whole UTF-8 text is editable; a text cut at the limit, and one in another encoding, are not", async () => {
		const w = world();
		write(join(w.proj, "a.txt"), "héllo");
		write(join(w.proj, "empty.txt"), "");
		write(join(w.proj, "cut.txt"), "x".repeat(FOLDER_LIMITS.textBytes + 10));
		write(join(w.proj, "latin1.txt"), LATIN1);
		expect((await text(w.proj, "a.txt")).editable).toBe(true);
		expect((await text(w.proj, "empty.txt")).editable).toBe(true);
		const cut = await text(w.proj, "cut.txt");
		expect([cut.truncated, cut.editable]).toEqual([true, false]);
		expect((await text(w.proj, "latin1.txt")).editable).toBe(false);
	});

	test("the answer of the route adds what the place and the page allow: a file no save would take is not editable", async () => {
		const w = world();
		write(join(w.proj, "a.txt"), "a");
		write(join(w.proj, ".github/workflows/ci.yml"), "on: push\n");
		write(join(w.proj, "src/.env"), "A=1\n");
		const asked = (e: TransferEnv, path: string) => mayEdit(w.proj, path, e);
		expect(await asked(w.env(), "a.txt")).toBe(true);
		expect(await asked(w.env({ local: true, setting: "off" }), "a.txt")).toBe(true);
		for (const setting of ["off", "download"] as const) expect(await asked(w.env({ setting }), "a.txt")).toBe(false);
		for (const path of [".github/workflows/ci.yml", "src/.env", "../outside/o.txt", "missing.txt"])
			expect([path, await asked(w.env({ local: true }), path)]).toEqual([path, false]);
		const file: FolderFile = await text(w.proj, "a.txt");
		expect(file.kind).toBe("text");
	});
});
