import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { handleUpload, type UploadContext } from "../../server/upload.ts";
import { UPLOAD_DIR, type UploadFailure, type UploadResult } from "../../shared/upload.ts";
import { writeChatSession } from "../support/chat-session.ts";
import { startTestServer, type TestServer } from "../support/server.ts";

/**
 * `POST /api/upload` (#617): a file the page holds is saved into `<conversation folder>/.omp-webui/uploads/<day>/<name>`
 * and nowhere else. The filesystem cases call the handler directly with small limits, on folders made here; the HTTP
 * facts (the route, the method, the headers the server asks of a write) go through the real server.
 *
 *   scratch/<case>/
 *     proj/      the conversation's folder
 *     outside/   what no upload may touch
 */

// macOS keeps temp dirs under a link (/var -> /private/var): the folder is named by its real path.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ompw-upload-")));
const NOW = new Date(2026, 9, 24, 12, 0, 0);
const DAY = "2026-10-24";

let cases = 0;
/** A new `proj` (made unless `make` is false) next to an `outside` folder, under a folder of its own. */
function world(make = true) {
	const top = join(scratch, `case-${++cases}`);
	const proj = join(top, "proj");
	const outside = join(top, "outside");
	mkdirSync(outside, { recursive: true });
	if (make) mkdirSync(proj);
	const uploads = join(proj, UPLOAD_DIR);
	return { top, proj, outside, uploads, today: join(uploads, DAY) };
}

const names = (dir: string): string[] => readdirSync(dir).sort();
const text = (path: string): string => readFileSync(path, "utf8");

type Failure = UploadFailure & { status: number };
interface Sent {
	/** The query: `name` is encoded for you. */
	name?: string | null;
	body?: BodyInit | null;
	headers?: Record<string, string>;
	method?: string;
}

/** A data folder of these tests' own, nowhere near a `world()`: the one unless a test names others. */
const DATA = join(scratch, "data-default");

/** One upload to `cwd`, through `handleUpload` as the server calls it. */
async function send(cwd: string | null, o: Sent, ctx: Partial<UploadContext> = {}) {
	const query = new URLSearchParams({ live: "l", file: "f" });
	if (o.name !== null) query.set("name", o.name ?? "x.txt");
	const url = `http://localhost/api/upload?${query}`;
	const init: RequestInit & { duplex?: "half" } = { method: o.method ?? "POST", headers: o.headers };
	if (o.body !== undefined && o.body !== null) {
		init.body = o.body;
		if (typeof o.body === "object" && "getReader" in o.body) init.duplex = "half";
	}
	const res = await handleUpload(new Request(url, init), new URL(url), {
		cwdOf: async () => cwd,
		dataDirs: [DATA],
		now: () => NOW,
		...ctx,
	});
	const body = (await res.json()) as UploadResult & Failure;
	return { status: res.status, body };
}

/** A body that arrives in pieces and says nothing of its length. */
const streamOf = (...pieces: string[]) => {
	const enc = new TextEncoder();
	let at = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			const piece = pieces[at++];
			if (piece === undefined) controller.close();
			else controller.enqueue(enc.encode(piece));
		},
	});
};

afterAll(() => {
	// Folders that were made read-only are put right again, so that the scratch folder can go.
	for (const dir of readdirSync(scratch)) {
		const proj = join(scratch, dir, "proj");
		if (existsSync(proj) && !lstatSync(proj).isSymbolicLink()) chmodSync(proj, 0o755);
	}
	rmSync(scratch, { recursive: true, force: true });
});

describe("a file that is saved", () => {
	test("lands at <folder>/.omp-webui/uploads/<day>/<name>, with its bytes, and the answer says where", async () => {
		const w = world();
		const { status, body } = await send(w.proj, { name: "notes.txt", body: "hello\nworld\n" });
		expect(status).toBe(200);
		const path = join(w.today, "notes.txt");
		expect<unknown>(body).toEqual({ path, name: "notes.txt", bytes: 12 });
		expect(text(path)).toBe("hello\nworld\n");
		expect(names(w.today)).toEqual(["notes.txt"]);
		expect(lstatSync(path).isFile()).toBe(true);
		expect(statSync(path).mode & 0o777).toBe(0o644 & ~process.umask());
	});

	test("binary bytes arrive as they were", async () => {
		const w = world();
		const all = Uint8Array.from({ length: 256 }, (_, i) => i);
		const { status, body } = await send(w.proj, { name: "all.bin", body: all });
		expect(status).toBe(200);
		expect(body.bytes).toBe(256);
		expect(new Uint8Array(readFileSync(body.path))).toEqual(all);
	});

	test("the folder ignores itself in git: .omp-webui/.gitignore holds `*`, and a second upload leaves it alone", async () => {
		const w = world();
		await send(w.proj, { body: "one" });
		const ignore = join(w.proj, ".omp-webui", ".gitignore");
		expect(text(ignore)).toBe("*\n");
		await send(w.proj, { name: "two.txt", body: "two" });
		expect(text(ignore)).toBe("*\n");
		expect(names(join(w.proj, ".omp-webui"))).toEqual([".gitignore", "uploads"]);
	});

	test("a .gitignore the person already has there is not rewritten", async () => {
		const w = world();
		mkdirSync(join(w.proj, ".omp-webui"));
		writeFileSync(join(w.proj, ".omp-webui", ".gitignore"), "mine\n");
		expect((await send(w.proj, { body: "x" })).status).toBe(200);
		expect(text(join(w.proj, ".omp-webui", ".gitignore"))).toBe("mine\n");
	});

	test("a folder that is already there, with files of earlier days, is used as it is", async () => {
		const w = world();
		mkdirSync(join(w.uploads, "2026-10-01"), { recursive: true });
		writeFileSync(join(w.uploads, "2026-10-01", "old.txt"), "old");
		const { status } = await send(w.proj, { name: "new.txt", body: "new" });
		expect(status).toBe(200);
		expect(names(w.uploads)).toEqual(["2026-10-01", DAY]);
		expect(text(join(w.uploads, "2026-10-01", "old.txt"))).toBe("old");
		expect(text(join(w.today, "new.txt"))).toBe("new");
	});

	test("an empty body saves an empty file", async () => {
		const w = world();
		for (const [name, body] of [
			["none.txt", undefined],
			["bytes.txt", new Uint8Array(0)],
			["string.txt", ""],
		] as const) {
			const { status, body: answer } = await send(w.proj, { name, body });
			expect(status, name).toBe(200);
			expect<unknown>(answer, name).toEqual({ path: join(w.today, name), name, bytes: 0 });
			expect(statSync(join(w.today, name)).size, name).toBe(0);
		}
	});

	test("the name is tidied, and the answer says what it was saved as", async () => {
		const w = world();
		const { body } = await send(w.proj, { name: "12:30 notes?.txt", body: "x" });
		expect(body).toMatchObject({ name: "12_30 notes_.txt" });
		expect(names(w.today)).toEqual(["12_30 notes_.txt"]);
		const dots = await send(w.proj, { name: "..", body: "x" });
		expect(dots.body).toMatchObject({ name: "file" });
		const long = await send(w.proj, { name: `${"é".repeat(300)}.txt`, body: "x" });
		expect(Buffer.byteLength(long.body.name)).toBeLessThanOrEqual(120);
		expect(long.body.name.endsWith(".txt")).toBe(true);
		expect(text(long.body.path)).toBe("x");
	});

	test("the day's folder follows the clock", async () => {
		const w = world();
		await send(w.proj, { name: "a.txt", body: "a" }, { now: () => new Date(2027, 0, 2, 3, 4, 5) });
		expect(names(w.uploads)).toEqual(["2027-01-02"]);
	});
});

describe("a name that tries to leave the folder", () => {
	test("../../outside.txt, an absolute name and a backslash name land in the day's folder under their last part", async () => {
		const w = world();
		const attempts: Array<[string, string]> = [
			["../../outside.txt", "outside.txt"],
			["../../../../../../../../tmp/up-abs.txt", "up-abs.txt"],
			[join(w.outside, "abs.txt"), "abs.txt"],
			["..\\..\\back.txt", "back.txt"],
			["C:\\Windows\\win.txt", "win.txt"],
			["a/b/../../c.txt", "c.txt"],
			["/etc/passwd", "passwd"],
		];
		for (const [given, saved] of attempts) {
			const { status, body } = await send(w.proj, { name: given, body: `body of ${saved}` });
			expect(status, given).toBe(200);
			expect(body.name, given).toBe(saved);
			expect(body.path, given).toBe(join(w.today, saved));
			expect(text(join(w.today, saved)), given).toBe(`body of ${saved}`);
		}
		// Nothing outside: the folder's parent holds the two folders and nothing else, outside is empty, proj holds only .omp-webui.
		expect(names(w.top)).toEqual(["outside", "proj"]);
		expect(names(w.outside)).toEqual([]);
		expect(names(w.proj)).toEqual([".omp-webui"]);
		expect(names(w.today)).toEqual(attempts.map(([, saved]) => saved).sort());
		expect(existsSync("/tmp/up-abs.txt")).toBe(false);
	});

	test("a name that is nothing but dots or a path to a folder becomes `file`", async () => {
		const w = world();
		for (const given of ["..", ".", "../", "a/..", "/"]) {
			const { status, body } = await send(w.proj, { name: given, body: given });
			expect(status, given).toBe(200);
			expect(dirname(body.path), given).toBe(w.today);
			expect(basename(body.path).startsWith("file"), given).toBe(true);
		}
		expect(names(w.top)).toEqual(["outside", "proj"]);
		expect(names(w.proj)).toEqual([".omp-webui"]);
	});
});

describe("a link in the way is refused, not followed", () => {
	test("a symlinked .omp-webui leading out: 403 refused, and the folder outside stays empty", async () => {
		const w = world();
		symlinkSync(w.outside, join(w.proj, ".omp-webui"));
		const { status, body } = await send(w.proj, { name: "x.txt", body: "leak" });
		expect(status).toBe(403);
		expect(body.code).toBe("refused");
		expect(names(w.outside)).toEqual([]);
		expect(lstatSync(join(w.proj, ".omp-webui")).isSymbolicLink()).toBe(true);
	});

	test("a symlinked uploads folder leading out", async () => {
		const w = world();
		mkdirSync(join(w.proj, ".omp-webui"));
		symlinkSync(w.outside, w.uploads);
		const { status, body } = await send(w.proj, { name: "x.txt", body: "leak" });
		expect(status).toBe(403);
		expect(body.code).toBe("refused");
		expect(names(w.outside)).toEqual([]);
	});

	test("a symlinked day folder leading out", async () => {
		const w = world();
		mkdirSync(w.uploads, { recursive: true });
		symlinkSync(w.outside, w.today);
		const { status, body } = await send(w.proj, { name: "x.txt", body: "leak" });
		expect(status).toBe(403);
		expect(body.code).toBe("refused");
		expect(names(w.outside)).toEqual([]);
	});

	test("a link that leads to a folder inside is refused as well: it can be moved", async () => {
		const w = world();
		mkdirSync(join(w.proj, "elsewhere"));
		symlinkSync(join(w.proj, "elsewhere"), join(w.proj, ".omp-webui"));
		const { status, body } = await send(w.proj, { body: "x" });
		expect(status).toBe(403);
		expect(body.code).toBe("refused");
		expect(names(join(w.proj, "elsewhere"))).toEqual([]);
	});

	test("a link to nothing is refused too", async () => {
		const w = world();
		symlinkSync(join(w.top, "not-there"), join(w.proj, ".omp-webui"));
		const { status, body } = await send(w.proj, { body: "x" });
		expect(status).toBe(403);
		expect(body.code).toBe("refused");
		expect(existsSync(join(w.top, "not-there"))).toBe(false);
	});

	test("the conversation's folder may itself be reached by a link: it is resolved once, then used", async () => {
		const w = world();
		const real = join(w.top, "real");
		mkdirSync(real);
		symlinkSync(real, join(w.top, "alias"));
		// The links refused are those below the folder; the folder itself is resolved first.
		const { status, body } = await send(join(w.top, "alias"), { name: "a.txt", body: "x" });
		expect(status).toBe(200);
		expect(body.path).toBe(join(real, UPLOAD_DIR, DAY, "a.txt"));
		expect(text(body.path)).toBe("x");
	});

	test("a .omp-webui that is a regular file: 403 refused, and the file is as it was", async () => {
		const w = world();
		writeFileSync(join(w.proj, ".omp-webui"), "i am a file");
		const { status, body } = await send(w.proj, { body: "x" });
		expect(status).toBe(403);
		expect(body.code).toBe("refused");
		expect(text(join(w.proj, ".omp-webui"))).toBe("i am a file");
		expect(names(w.proj)).toEqual([".omp-webui"]);
	});

	test("an uploads or day entry that is a regular file is refused", async () => {
		const a = world();
		mkdirSync(join(a.proj, ".omp-webui"));
		writeFileSync(a.uploads, "file");
		expect((await send(a.proj, { body: "x" })).status).toBe(403);
		expect(text(a.uploads)).toBe("file");
		const b = world();
		mkdirSync(b.uploads, { recursive: true });
		writeFileSync(b.today, "file");
		const answer = await send(b.proj, { body: "x" });
		expect(answer.status).toBe(403);
		expect(answer.body.code).toBe("refused");
		expect(text(b.today)).toBe("file");
	});

	test("a symlink at the file's own name is not written through: the file it points at is untouched and the upload is numbered", async () => {
		const w = world();
		mkdirSync(w.today, { recursive: true });
		const target = join(w.outside, "secret.txt");
		writeFileSync(target, "keep me");
		symlinkSync(target, join(w.today, "x.txt"));
		const { status, body } = await send(w.proj, { name: "x.txt", body: "new content" });
		expect(status).toBe(200);
		expect(body.name).toBe("x (1).txt");
		expect(text(target)).toBe("keep me");
		expect(lstatSync(join(w.today, "x.txt")).isSymbolicLink()).toBe(true);
		expect(text(join(w.today, "x (1).txt"))).toBe("new content");
		expect(names(w.outside)).toEqual(["secret.txt"]);
	});

	test("a dangling symlink at the file's name does not make the file it points at", async () => {
		const w = world();
		mkdirSync(w.today, { recursive: true });
		const target = join(w.outside, "made-by-upload.txt");
		symlinkSync(target, join(w.today, "x.txt"));
		const { status, body } = await send(w.proj, { name: "x.txt", body: "new" });
		expect(status).toBe(200);
		expect(body.name).toBe("x (1).txt");
		expect(existsSync(target)).toBe(false);
		expect(names(w.outside)).toEqual([]);
	});

	test("a link at the numbered name too: the upload goes to the first free one", async () => {
		const w = world();
		mkdirSync(w.today, { recursive: true });
		const target = join(w.outside, "t.txt");
		writeFileSync(target, "keep");
		symlinkSync(target, join(w.today, "x.txt"));
		symlinkSync(target, join(w.today, "x (1).txt"));
		const { body } = await send(w.proj, { name: "x.txt", body: "new" });
		expect(body.name).toBe("x (2).txt");
		expect(text(target)).toBe("keep");
	});
});

describe("a file is never overwritten", () => {
	test("the same name twice makes `x.txt` and `x (1).txt`, both whole", async () => {
		const w = world();
		const first = await send(w.proj, { name: "x.txt", body: "first" });
		const second = await send(w.proj, { name: "x.txt", body: "second" });
		const third = await send(w.proj, { name: "x.txt", body: "third" });
		expect([first.body.name, second.body.name, third.body.name]).toEqual(["x.txt", "x (1).txt", "x (2).txt"]);
		expect(text(join(w.today, "x.txt"))).toBe("first");
		expect(text(join(w.today, "x (1).txt"))).toBe("second");
		expect(text(join(w.today, "x (2).txt"))).toBe("third");
		expect(names(w.today)).toEqual(["x (1).txt", "x (2).txt", "x.txt"]);
	});

	test("a file the person put there is not overwritten either, nor is a dotfile or a name without extension", async () => {
		const w = world();
		mkdirSync(w.today, { recursive: true });
		for (const name of ["mine.txt", ".env", "Makefile"]) writeFileSync(join(w.today, name), `mine: ${name}`);
		for (const name of ["mine.txt", ".env", "Makefile"]) {
			const { body } = await send(w.proj, { name, body: "upload" });
			expect(body.name, name).toBe(name === "mine.txt" ? "mine (1).txt" : `${name} (1)`);
			expect(text(join(w.today, name)), name).toBe(`mine: ${name}`);
			expect(text(body.path), name).toBe("upload");
		}
	});

	test("three uploads of one name at once give three distinct files, each with its own content", async () => {
		const w = world(); // nothing made yet: the three race to make the folders too
		const answers = await Promise.all(
			["alpha", "bravo", "charlie"].map((content) => send(w.proj, { name: "same.txt", body: content })),
		);
		expect(answers.map((a) => a.status)).toEqual([200, 200, 200]);
		const paths = answers.map((a) => a.body.path);
		expect(new Set(paths).size).toBe(3);
		expect(new Set(answers.map((a) => a.body.name)).size).toBe(3);
		expect(names(w.today)).toEqual(["same (1).txt", "same (2).txt", "same.txt"].sort());
		for (const [i, content] of ["alpha", "bravo", "charlie"].entries()) {
			expect(text(paths[i] as string), content).toBe(content);
		}
		expect(text(join(w.proj, ".omp-webui", ".gitignore"))).toBe("*\n");
	});

	test("concurrent uploads of different names and one name mixed together all arrive", async () => {
		const w = world();
		const sent = ["a.txt", "b.txt", "a.txt", "c.txt", "a.txt", "b.txt"].map((name, i) => ({ name, content: `#${i}` }));
		const answers = await Promise.all(sent.map((s) => send(w.proj, { name: s.name, body: s.content })));
		expect(answers.every((a) => a.status === 200)).toBe(true);
		expect(new Set(answers.map((a) => a.body.path)).size).toBe(sent.length);
		answers.forEach((a, i) => {
			expect(text(a.body.path)).toBe(sent[i]?.content as string);
		});
		expect(names(w.today)).toHaveLength(sent.length);
	});
});

describe("limits", () => {
	test("a file that says it is over the limit is refused before anything is made", async () => {
		const w = world();
		const { status, body } = await send(
			w.proj,
			{ name: "big.bin", body: "x".repeat(11), headers: { "content-length": "11" } },
			{ limits: { fileBytes: 10 } },
		);
		expect(status).toBe(413);
		expect<unknown>(body).toEqual({ error: expect.any(String), code: "tooLarge", limit: 10 });
		expect(existsSync(join(w.proj, ".omp-webui"))).toBe(false);
		expect(names(w.proj)).toEqual([]);
	});

	test("a file of exactly the limit is saved", async () => {
		const w = world();
		const { status, body } = await send(w.proj, { name: "ten.bin", body: "0123456789" }, { limits: { fileBytes: 10 } });
		expect(status).toBe(200);
		expect(body.bytes).toBe(10);
		expect(text(body.path)).toBe("0123456789");
	});

	test("a file over the limit that does not say so is stopped while it is read, and what was written is removed", async () => {
		const w = world();
		// Six bytes are written before the seventh to twelfth show it is too much.
		const { status, body } = await send(
			w.proj,
			{ name: "stream.bin", body: streamOf("abcdef", "ghijkl", "mnop") },
			{ limits: { fileBytes: 10 } },
		);
		expect(status).toBe(413);
		expect<unknown>(body).toEqual({ error: expect.any(String), code: "tooLarge", limit: 10 });
		expect(names(w.today)).toEqual([]);
	});

	test("a file that says it is small and is not is stopped too", async () => {
		const w = world();
		const { status, body } = await send(
			w.proj,
			{ name: "liar.bin", body: streamOf("0123456", "89abcdef"), headers: { "content-length": "5" } },
			{ limits: { fileBytes: 10 } },
		);
		expect(status).toBe(413);
		expect(body.code).toBe("tooLarge");
		expect(names(w.today)).toEqual([]);
	});

	test("a refused upload leaves what was there: an earlier file of the same name is intact and no number is used up", async () => {
		const w = world();
		const first = await send(w.proj, { name: "x.bin", body: "small" }, { limits: { fileBytes: 10 } });
		expect(first.status).toBe(200);
		const refused = await send(
			w.proj,
			{ name: "x.bin", body: streamOf("0123456", "789abcdef") },
			{ limits: { fileBytes: 10 } },
		);
		expect(refused.status).toBe(413);
		expect(names(w.today)).toEqual(["x.bin"]);
		expect(text(join(w.today, "x.bin"))).toBe("small");
		const later = await send(w.proj, { name: "x.bin", body: "later" }, { limits: { fileBytes: 10 } });
		expect(later.body.name).toBe("x (1).bin");
	});

	test("the folder of uploads has a quota: what is there, from any day, counts, and the limit itself is allowed", async () => {
		const w = world();
		mkdirSync(join(w.uploads, "2026-10-01", "nested"), { recursive: true });
		writeFileSync(join(w.uploads, "2026-10-01", "old.bin"), "x".repeat(8));
		writeFileSync(join(w.uploads, "2026-10-01", "nested", "older.bin"), "y".repeat(7));
		const limits = { folderBytes: 20 };
		// 15 bytes in the folder: five more is the limit and goes in.
		const fits = await send(w.proj, { name: "fits.bin", body: "12345" }, { limits });
		expect(fits.status).toBe(200);
		// Now it is full by one byte.
		const full = await send(w.proj, { name: "more.bin", body: "1", headers: { "content-length": "1" } }, { limits });
		expect(full.status).toBe(413);
		expect<unknown>(full.body).toEqual({ error: expect.any(String), code: "quota", limit: 20 });
		expect(names(w.today)).toEqual(["fits.bin"]);
	});

	test("a file that would pass the quota is refused by its declared size, before it is made", async () => {
		const w = world();
		const { status, body } = await send(
			w.proj,
			{ name: "wide.bin", body: "x".repeat(12), headers: { "content-length": "12" } },
			{ limits: { folderBytes: 10 } },
		);
		expect(status).toBe(413);
		expect(body).toMatchObject({ code: "quota", limit: 10 });
		expect(existsSync(w.today)).toBe(false);
	});

	test("a file that passes the quota while it is read is stopped and its part removed", async () => {
		const w = world();
		mkdirSync(w.today, { recursive: true });
		writeFileSync(join(w.today, "there.bin"), "x".repeat(15));
		const { status, body } = await send(
			w.proj,
			{ name: "grows.bin", body: streamOf("12", "34", "56") },
			{ limits: { folderBytes: 20 } },
		);
		expect(status).toBe(413);
		expect(body).toMatchObject({ code: "quota", limit: 20 });
		expect(names(w.today)).toEqual(["there.bin"]);
		expect(text(join(w.today, "there.bin"))).toBe("x".repeat(15));
	});

	test("the file limit is told before the quota when both are passed", async () => {
		const w = world();
		const { body } = await send(
			w.proj,
			{ body: streamOf("0123456789ab") },
			{ limits: { fileBytes: 5, folderBytes: 8 } },
		);
		expect(body.code).toBe("tooLarge");
	});
});

describe("what is refused", () => {
	test("a conversation the server does not know: 404 unknownConversation, nothing made", async () => {
		const w = world();
		const { status, body } = await send(null, { name: "x.txt", body: "x" });
		expect(status).toBe(404);
		expect(body.code).toBe("unknownConversation");
		expect(names(w.proj)).toEqual([]);
	});

	test("a folder that is gone: 404 folderGone, and nothing is made in its place", async () => {
		const w = world(false);
		const gone = join(w.top, "gone");
		const { status, body } = await send(gone, { name: "x.txt", body: "x" });
		expect(status).toBe(404);
		expect(body.code).toBe("folderGone");
		expect(existsSync(gone)).toBe(false);
		expect(names(w.top)).toEqual(["outside"]);
	});

	test("a folder that is a file, or not an absolute path, is gone too", async () => {
		const w = world();
		writeFileSync(join(w.top, "plain-file"), "x");
		for (const cwd of [join(w.top, "plain-file"), "relative/dir", "proj"]) {
			const { status, body } = await send(cwd, { body: "x" });
			expect(status, cwd).toBe(404);
			expect(body.code, cwd).toBe("folderGone");
		}
		expect(names(w.proj)).toEqual([]);
	});

	test("a folder that is a link to a folder that is gone is gone", async () => {
		const w = world(false);
		symlinkSync(join(w.top, "nowhere"), join(w.top, "dangling"));
		const { status, body } = await send(join(w.top, "dangling"), { body: "x" });
		expect(status).toBe(404);
		expect(body.code).toBe("folderGone");
		expect(existsSync(join(w.top, "nowhere"))).toBe(false);
	});

	test("no usable name: 400 badRequest, nothing made", async () => {
		const w = world();
		const long = "n".repeat(1025);
		for (const name of [null, "", "a\0b", long]) {
			const { status, body } = await send(w.proj, { name, body: "x" });
			expect(status, String(name).slice(0, 10)).toBe(400);
			expect(body.code).toBe("badRequest");
		}
		expect(names(w.proj)).toEqual([]);
		// The longest name is let in (and is cut to what a file system takes).
		const edge = await send(w.proj, { name: "n".repeat(1024), body: "x" });
		expect(edge.status).toBe(200);
		expect(Buffer.byteLength(edge.body.name)).toBeLessThanOrEqual(120);
	});

	test("only POST saves: any other method is 405 and makes nothing", async () => {
		const w = world();
		for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
			const { status, body } = await send(w.proj, { method, name: "x.txt", body: method === "GET" ? undefined : "x" });
			expect(status, method).toBe(405);
			expect(body.code, method).toBe("badRequest");
		}
		expect(names(w.proj)).toEqual([]);
	});

	test("a folder that cannot be written to: 500 write, with a sentence that names no path", async () => {
		const w = world();
		chmodSync(w.proj, 0o555);
		const log = spyOn(console, "error").mockImplementation(() => {});
		try {
			const { status, body } = await send(w.proj, { name: "x.txt", body: "x" });
			if (process.getuid?.() === 0) return; // root writes anywhere
			expect(status).toBe(500);
			expect(body.code).toBe("write");
			expect(body.error).not.toContain(w.proj);
			expect(log).toHaveBeenCalled();
		} finally {
			log.mockRestore();
			chmodSync(w.proj, 0o755);
		}
		expect(names(w.proj)).toEqual([]);
	});
});

describe("uploads at once share the folder's room", () => {
	const bytesIn = (dir: string): number => names(dir).reduce((sum, n) => sum + statSync(join(dir, n)).size, 0);

	test("ten that say how large they are: only as many as fit are saved, the rest are 413 quota, and the folder is not over", async () => {
		const w = world();
		const limits = { folderBytes: 25 };
		const answers = await Promise.all(
			Array.from({ length: 10 }, (_, i) =>
				send(w.proj, { name: `f${i}.bin`, body: "x".repeat(10), headers: { "content-length": "10" } }, { limits }),
			),
		);
		const saved = answers.filter((a) => a.status === 200);
		const refused = answers.filter((a) => a.status !== 200);
		expect(saved.length).toBeLessThanOrEqual(Math.floor(25 / 10));
		expect(saved).toHaveLength(2);
		for (const a of refused) {
			expect(a.status).toBe(413);
			expect(a.body).toMatchObject({ code: "quota", limit: 25 });
		}
		expect(names(w.today)).toHaveLength(saved.length);
		expect(bytesIn(w.today)).toBeLessThanOrEqual(25);
		expect(bytesIn(w.today)).toBe(20);
	});

	test("ten that do not say how large they are (streamed): the same, and what a refused one wrote is gone", async () => {
		const w = world();
		const limits = { folderBytes: 25 };
		const answers = await Promise.all(
			Array.from({ length: 10 }, (_, i) =>
				send(w.proj, { name: `s${i}.bin`, body: streamOf("12345", "67890") }, { limits }),
			),
		);
		const saved = answers.filter((a) => a.status === 200);
		expect(saved.length).toBeLessThanOrEqual(Math.floor(25 / 10));
		expect(saved).toHaveLength(2);
		for (const a of answers.filter((x) => x.status !== 200)) {
			expect(a.status).toBe(413);
			expect(a.body).toMatchObject({ code: "quota", limit: 25 });
		}
		expect(names(w.today)).toHaveLength(saved.length);
		expect(bytesIn(w.today)).toBe(20);
		for (const a of saved) expect(text(a.body.path)).toBe("1234567890");
	});

	test("a mix of declared and streamed uploads, over a folder that already holds some, stays within the quota", async () => {
		const w = world();
		mkdirSync(join(w.uploads, "2026-10-01"), { recursive: true });
		writeFileSync(join(w.uploads, "2026-10-01", "old.bin"), "o".repeat(12));
		const limits = { folderBytes: 30 };
		const answers = await Promise.all(
			Array.from({ length: 12 }, (_, i) =>
				i % 2
					? send(w.proj, { name: `d${i}.bin`, body: "d".repeat(7), headers: { "content-length": "7" } }, { limits })
					: send(w.proj, { name: `s${i}.bin`, body: streamOf("sss", "ssss") }, { limits }),
			),
		);
		const saved = answers.filter((a) => a.status === 200);
		expect(saved).toHaveLength(2); // 12 + 7 + 7 = 26; a third would be 33
		expect(answers.filter((a) => a.status !== 200).every((a) => a.status === 413 && a.body.code === "quota")).toBe(
			true,
		);
		expect(bytesIn(w.today) + 12).toBeLessThanOrEqual(30);
	});
});

describe("the number of entries", () => {
	test("a folder that holds as many entries as are counted takes no more: 413 tooMany with the count, nothing made", async () => {
		const w = world();
		// A day folder and four files: five entries.
		mkdirSync(join(w.uploads, "2026-10-01"), { recursive: true });
		for (const n of ["a", "b", "c", "d"]) writeFileSync(join(w.uploads, "2026-10-01", n), n);
		const { status, body } = await send(w.proj, { name: "x.txt", body: "x" }, { limits: { counted: 5 } });
		expect(status).toBe(413);
		expect<unknown>(body).toEqual({ error: expect.any(String), code: "tooMany", limit: 5 });
		expect(existsSync(w.today)).toBe(false);
		expect(names(join(w.uploads, "2026-10-01"))).toEqual(["a", "b", "c", "d"]);
	});

	test("one entry less than the count is room for one more upload, and then the folder is full", async () => {
		const w = world();
		// A day folder and two files: three entries.
		mkdirSync(join(w.uploads, "2026-10-01"), { recursive: true });
		for (const n of ["a", "b"]) writeFileSync(join(w.uploads, "2026-10-01", n), n);
		const limits = { counted: 5 };
		const first = await send(w.proj, { name: "x.txt", body: "x" }, { limits });
		expect(first.status).toBe(200);
		// Today's folder and its file bring the entries to five.
		const second = await send(w.proj, { name: "y.txt", body: "y" }, { limits });
		expect(second.status).toBe(413);
		expect(second.body).toMatchObject({ code: "tooMany", limit: 5 });
		expect(names(w.today)).toEqual(["x.txt"]);
	});

	test("entries are counted in nested folders too, and a link is one entry that is not followed", async () => {
		const w = world();
		mkdirSync(join(w.uploads, "2026-10-01", "deep", "deeper"), { recursive: true });
		writeFileSync(join(w.uploads, "2026-10-01", "deep", "deeper", "f"), "f");
		symlinkSync(w.outside, join(w.uploads, "2026-10-01", "link"));
		writeFileSync(join(w.outside, "o1"), "1");
		// day, deep, deeper, f, link: five entries; the files outside are not counted.
		const { status, body } = await send(w.proj, { body: "x" }, { limits: { counted: 5 } });
		expect(status).toBe(413);
		expect(body.code).toBe("tooMany");
		const fine = await send(w.proj, { body: "x" }, { limits: { counted: 6 } });
		expect(fine.status).toBe(200);
	});

	test("ten at once into a folder with room for few: no more than the count are made", async () => {
		const w = world();
		const limits = { counted: 4 };
		const answers = await Promise.all(
			Array.from({ length: 10 }, (_, i) => send(w.proj, { name: `n${i}.txt`, body: "x" }, { limits })),
		);
		const saved = answers.filter((a) => a.status === 200);
		// Today's folder takes one entry, so three files are made.
		expect(saved).toHaveLength(3);
		expect(answers.filter((a) => a.status !== 200).every((a) => a.status === 413 && a.body.code === "tooMany")).toBe(
			true,
		);
		expect(names(w.today)).toHaveLength(3);
	});
});

describe("the app's own data", () => {
	test("a conversation in the home folder is saved there when no omp-webui keeps data in `~/.omp-webui`", async () => {
		const home = realpathSync(mkdtempSync(join(scratch, "home-")));
		const dataDir = realpathSync(mkdtempSync(join(scratch, "data-")));
		const { status, body } = await send(home, { name: "x.txt", body: "x" }, { dataDirs: [dataDir] });
		expect(status).toBe(200);
		expect(body.path).toBe(join(home, UPLOAD_DIR, DAY, "x.txt"));
		expect(text(body.path)).toBe("x");
	});

	test("the home folder is that folder by a link too: its uploads land in the folder it really is", async () => {
		const home = realpathSync(mkdtempSync(join(scratch, "home-")));
		const dataDir = realpathSync(mkdtempSync(join(scratch, "data-")));
		const alias = join(scratch, `alias-${++cases}`);
		symlinkSync(home, alias);
		const { status, body } = await send(alias, { name: "y.txt", body: "y" }, { dataDirs: [dataDir] });
		expect(status).toBe(200);
		expect(body.path).toBe(join(home, UPLOAD_DIR, DAY, "y.txt"));
		expect(names(home)).toEqual([".omp-webui"]);
	});

	test("every omp-webui's data folder counts: the app's, in Application Support, still refuses a home-folder conversation", async () => {
		// The macOS app's own data folder is `~/Library/Application Support/omp-webui`, and the web version keeps `~/.omp-webui`:
		// a home-folder conversation would upload into the second one, so the first being elsewhere does not make it ordinary.
		const home = realpathSync(mkdtempSync(join(scratch, "home-")));
		const appData = join(home, "Library", "Application Support", "omp-webui");
		mkdirSync(appData, { recursive: true });
		const webData = join(home, ".omp-webui");
		mkdirSync(webData);
		const { status, body } = await send(home, { body: "x" }, { dataDirs: [appData, webData] });
		expect(status).toBe(403);
		expect(body.code).toBe("ownData");
		expect(names(webData)).toEqual([]);
		expect(names(join(home, "Library", "Application Support"))).toEqual(["omp-webui"]);
	});

	test("a data folder that is not there yet is refused all the same: the home folder's `.omp-webui` is where it will be", async () => {
		const home = realpathSync(mkdtempSync(join(scratch, "home-")));
		const elsewhere = realpathSync(mkdtempSync(join(scratch, "data-")));
		// Neither folder exists: the comparison is of real paths as far as they exist, and a missing one is its own place.
		const { status, body } = await send(home, { body: "x" }, { dataDirs: [elsewhere, join(home, ".omp-webui")] });
		expect(status).toBe(403);
		expect(body.code).toBe("ownData");
		expect(names(home)).toEqual([]);
	});

	test("a context that names no data folder at all is refused rather than allowed", async () => {
		const w = world();
		const { status, body } = await send(w.proj, { name: "x.txt", body: "x" }, { dataDirs: [] });
		expect(status).toBe(403);
		expect(body.code).toBe("ownData");
		expect(names(w.proj)).toEqual([]);
	});

	test("the data folder itself, and a folder inside it, are refused and nothing is made", async () => {
		const dataDir = realpathSync(mkdtempSync(join(scratch, "data-")));
		const sub = join(dataDir, "sub");
		mkdirSync(sub);
		for (const cwd of [dataDir, sub]) {
			const { status, body } = await send(cwd, { name: "x.txt", body: "x" }, { dataDirs: [dataDir] });
			expect(status, cwd).toBe(403);
			expect(body.code, cwd).toBe("ownData");
		}
		expect(names(dataDir)).toEqual(["sub"]);
		expect(names(sub)).toEqual([]);
	});

	test("a data folder of the home folder's `.omp-webui` is refused, by the folder or by a link to it", async () => {
		const home = realpathSync(mkdtempSync(join(scratch, "home-")));
		const dataDir = join(home, ".omp-webui");
		mkdirSync(dataDir);
		const alias = join(scratch, `alias-${++cases}`);
		symlinkSync(home, alias);
		for (const cwd of [home, alias]) {
			const { status, body } = await send(cwd, { body: "x" }, { dataDirs: [dataDir] });
			expect(status, cwd).toBe(403);
			expect(body.code).toBe("ownData");
		}
		expect(names(dataDir)).toEqual([]);
	});

	test("a data folder inside the project's own .omp-webui is refused too", async () => {
		const w = world();
		const dataDir = join(w.proj, ".omp-webui", "data");
		mkdirSync(dataDir, { recursive: true });
		const { status, body } = await send(w.proj, { body: "x" }, { dataDirs: [dataDir] });
		expect(status).toBe(403);
		expect(body.code).toBe("ownData");
		expect(names(dataDir)).toEqual([]);
		expect(names(join(w.proj, ".omp-webui"))).toEqual(["data"]);
	});

	test("a data folder somewhere else, a missing one, or one beside the project does not block", async () => {
		const w = world();
		mkdirSync(join(w.proj, "data"));
		for (const dataDirs of [[w.outside], [join(w.top, "no-such-data")], [join(w.proj, "data")]]) {
			const { status } = await send(w.proj, { name: "x.txt", body: "x" }, { dataDirs });
			expect(status, dataDirs.join()).toBe(200);
		}
		expect(names(w.outside)).toEqual([]);
	});
});

describe("a body that stops", () => {
	/** A body that sends `piece` and then nothing, ever. */
	const stalls = (piece: string) => {
		const enc = new TextEncoder();
		let sent = false;
		return new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent) return new Promise<void>(() => {});
				sent = true;
				controller.enqueue(enc.encode(piece));
			},
		});
	};
	/** A body that sends `piece` and then breaks, as a page that is closed or a connection that drops does. */
	const breaks = (piece: string) => {
		const enc = new TextEncoder();
		let sent = false;
		return new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent) controller.error(new Error("connection reset"));
				else controller.enqueue(enc.encode(piece));
				sent = true;
			},
		});
	};

	test("one that sends a piece and then nothing is given up (408), its file is gone and the folder is free again", async () => {
		const w = world();
		const stalled = await send(w.proj, { name: "stall.bin", body: stalls("abc") }, { limits: { stallMs: 50 } });
		expect(stalled.status).toBe(408);
		expect(stalled.body.code).toBe("stalled");
		expect(names(w.today)).toEqual([]);
		const next = await send(w.proj, { name: "after.bin", body: "after" }, { limits: { stallMs: 50 } });
		expect(next.status).toBe(200);
		expect(names(w.today)).toEqual(["after.bin"]);
	});

	test("an upload sent at the same time waits for the stalled one and is then saved", async () => {
		const w = world();
		const limits = { stallMs: 50 };
		const [stalled, other] = await Promise.all([
			send(w.proj, { name: "stall.bin", body: stalls("abc") }, { limits }),
			send(w.proj, { name: "other.bin", body: "other" }, { limits }),
		]);
		expect(stalled.status).toBe(408);
		expect(other.status).toBe(200);
		expect(names(w.today)).toEqual(["other.bin"]);
		expect(text(join(w.today, "other.bin"))).toBe("other");
	});

	test("one that sends nothing at all is given up too", async () => {
		const w = world();
		const silent = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}) });
		const { status, body } = await send(w.proj, { name: "silent.bin", body: silent }, { limits: { stallMs: 50 } });
		expect(status).toBe(408);
		expect(body.code).toBe("stalled");
		expect(names(w.today)).toEqual([]);
	});

	test("a body that is slow but arrives is saved: the time is between pieces, not for the whole", async () => {
		const w = world();
		const enc = new TextEncoder();
		let at = 0;
		const slow = new ReadableStream<Uint8Array>({
			async pull(controller) {
				if (at++ === 4) return controller.close();
				// Real time is the point: the wait for a piece is measured between pieces, by the clock.
				await Bun.sleep(30);
				controller.enqueue(enc.encode(`p${at}`));
			},
		});
		const { status, body } = await send(w.proj, { name: "slow.bin", body: slow }, { limits: { stallMs: 100 } });
		expect(status).toBe(200);
		expect(text(body.path)).toBe("p1p2p3p4");
	});

	test("a body that breaks (the page went away) is 400, not a failure of the server: nothing is logged, nothing is left", async () => {
		const w = world();
		const log = spyOn(console, "error").mockImplementation(() => {});
		try {
			const { status, body } = await send(w.proj, { name: "gone.bin", body: breaks("abc") });
			expect(status).toBe(400);
			expect(body.code).toBe("badRequest");
			expect(log).not.toHaveBeenCalled();
		} finally {
			log.mockRestore();
		}
		expect(names(w.today)).toEqual([]);
		const next = await send(w.proj, { name: "after.bin", body: "after" });
		expect(next.status).toBe(200);
		expect(names(w.today)).toEqual(["after.bin"]);
	});
});

describe("over HTTP, through the real server", () => {
	let s: TestServer;
	let proj: string;
	let file: string;

	beforeAll(async () => {
		s = await startTestServer();
		proj = join(realpathSync(s.work), "upload-proj");
		mkdirSync(proj, { recursive: true });
		file = writeChatSession(s.agentDir, {
			n: 93,
			title: "Upload probe",
			cwd: proj,
			turns: [{ prompt: "hi", reply: "ok" }],
		});
	}, 90_000);

	afterAll(async () => {
		await s?.stop();
	});

	const headers = (extra: Record<string, string> = {}) => ({
		"x-omp-webui-token": s.accessToken,
		"x-omp-webui": "1",
		...extra,
	});
	const post = (query: Record<string, string | undefined>, body?: BodyInit, extra: Record<string, string> = {}) => {
		const params = new URLSearchParams();
		for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, v);
		return fetch(`${s.url}/api/upload?${params}`, { method: "POST", headers: headers(extra), body });
	};

	test("a file is saved at <folder>/.omp-webui/uploads/<day>/<name> and the answer is its absolute path", async () => {
		const res = await post({ file, name: "hello world.txt" }, "hello over http");
		expect(res.status).toBe(200);
		const body = (await res.json()) as UploadResult;
		expect(body).toMatchObject({ name: "hello world.txt", bytes: 15 });
		expect(body.path.startsWith("/")).toBe(true);
		const day = basename(dirname(body.path));
		expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(body.path).toBe(join(proj, ".omp-webui", "uploads", day, "hello world.txt"));
		expect(text(body.path)).toBe("hello over http");
		expect(text(join(proj, ".omp-webui", ".gitignore"))).toBe("*\n");
	});

	test("binary bytes arrive whole, and the same name again is numbered", async () => {
		const bytes = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) % 256);
		const first = (await (await post({ file, name: "blob.bin" }, bytes)).json()) as UploadResult;
		const second = (await (await post({ file, name: "blob.bin" }, bytes)).json()) as UploadResult;
		expect(first.bytes).toBe(1000);
		expect(second.name).toBe("blob (1).bin");
		expect(new Uint8Array(readFileSync(first.path))).toEqual(bytes);
		expect(new Uint8Array(readFileSync(second.path))).toEqual(bytes);
	});

	test("a name that climbs out lands inside under its last part", async () => {
		const res = await post({ file, name: "../../escape.txt" }, "x");
		expect(res.status).toBe(200);
		const body = (await res.json()) as UploadResult;
		expect(body.name).toBe("escape.txt");
		expect(body.path).toBe(join(proj, ".omp-webui", "uploads", basename(dirname(body.path)), "escape.txt"));
		expect(existsSync(join(dirname(proj), "escape.txt"))).toBe(false);
		expect(existsSync(join(proj, "escape.txt"))).toBe(false);
	});

	test("an empty body is an empty file", async () => {
		const res = await post({ file, name: "empty.txt" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as UploadResult;
		expect(body.bytes).toBe(0);
		expect(statSync(body.path).size).toBe(0);
	});

	test("a conversation the server does not know is 404 unknownConversation", async () => {
		const res = await post({ file: join(proj, "no-such-session.jsonl"), name: "x.txt" }, "x");
		expect(res.status).toBe(404);
		expect(((await res.json()) as UploadFailure).code).toBe("unknownConversation");
		const none = await post({ name: "x.txt" }, "x");
		expect(none.status).toBe(404);
		expect(((await none.json()) as UploadFailure).code).toBe("unknownConversation");
		const live = await post({ live: "no-such-live", name: "x.txt" }, "x");
		expect(live.status).toBe(404);
		expect(existsSync(join(proj, "x.txt"))).toBe(false);
	});

	test("a missing or empty name is 400 badRequest", async () => {
		for (const name of [undefined, ""]) {
			const res = await post({ file, name }, "x");
			expect(res.status, String(name)).toBe(400);
			expect(((await res.json()) as UploadFailure).code).toBe("badRequest");
		}
	});

	test("a GET is 405", async () => {
		const res = await fetch(`${s.url}/api/upload?file=${encodeURIComponent(file)}&name=x.txt`, { headers: headers() });
		expect(res.status).toBe(405);
		expect(((await res.json()) as UploadFailure).code).toBe("badRequest");
	});

	test("a write without the page's own header is refused before the handler, and without the token it is not served", async () => {
		const params = new URLSearchParams({ file, name: "csrf.txt" });
		const bare = await fetch(`${s.url}/api/upload?${params}`, {
			method: "POST",
			headers: { "x-omp-webui-token": s.accessToken },
			body: "x",
		});
		expect(bare.status).toBe(403);
		const unknown = await fetch(`${s.url}/api/upload?${params}`, {
			method: "POST",
			headers: { "x-omp-webui": "1" },
			body: "x",
		});
		expect([401, 403]).toContain(unknown.status);
		const uploads = join(proj, ".omp-webui", "uploads");
		for (const d of existsSync(uploads) ? readdirSync(uploads) : []) {
			expect(names(join(uploads, d))).not.toContain("csrf.txt");
		}
	});

	test("a conversation in the server's home folder is refused (its `~/.omp-webui` is a data folder), and one in its data folder too", async () => {
		// The test server's HOME is `<root>/home` and its data dir `<root>/data`; `~/.omp-webui` is a known data folder of its
		// own, so a conversation in the home folder would upload where the web version keeps its data: both are refused.
		const dataDir = join(s.root, "data");
		mkdirSync(join(dataDir, "sub"), { recursive: true });
		const asked: Array<[string, string]> = [
			[s.home, "home"],
			[dataDir, "data"],
			[join(dataDir, "sub"), "inside data"],
		];
		for (const [i, [cwd, what]] of asked.entries()) {
			const own = writeChatSession(s.agentDir, {
				n: 94 + i,
				title: `Own data ${what}`,
				cwd,
				turns: [{ prompt: "hi", reply: "ok" }],
			});
			const before = existsSync(join(cwd, ".omp-webui"));
			const res = await post({ file: own, name: "x.txt" }, "x");
			expect(res.status, what).toBe(403);
			expect(((await res.json()) as UploadFailure).code, what).toBe("ownData");
			expect(existsSync(join(cwd, ".omp-webui")), what).toBe(before);
			expect(existsSync(join(cwd, ".omp-webui", "uploads")), what).toBe(false);
		}
	});

	test("a folder inside the server's home is an ordinary project", async () => {
		const inHome = join(s.home, "projects", "p1");
		mkdirSync(inHome, { recursive: true });
		const own = writeChatSession(s.agentDir, {
			n: 98,
			title: "In home",
			cwd: inHome,
			turns: [{ prompt: "hi", reply: "ok" }],
		});
		const res = await post({ file: own, name: "x.txt" }, "x");
		expect(res.status).toBe(200);
		const body = (await res.json()) as UploadResult;
		expect(body.path.startsWith(join(realpathSync(inHome), ".omp-webui", "uploads"))).toBe(true);
	});
});
