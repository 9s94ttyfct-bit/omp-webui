import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { hiddenByDefault } from "../../server/files.ts";
import { type TransferOptions, TransferService } from "../../server/folder-transfer.ts";
import { ZipReader } from "../../server/migrate/zip.ts";
import type { TransferEnv } from "../../server/transfer-core.ts";
import { contentDisposition, ifRangeHolds, parseRange } from "../../server/transfer-download.ts";
import { TransferLog } from "../../server/transfer-log.ts";
import {
	type ArchivePlan,
	ERROR_HEADER,
	type FileTransfer,
	isHiddenName,
	type UploadProgress,
	type UploadSaved,
} from "../../shared/transfer.ts";
import { tempDir } from "../support/temp-dirs.ts";

/**
 * The rules of the file transfer (`server/folder-transfer.ts`), asked of the service itself on folders made here: who may
 * move what, where a file may land, what is never overwritten, what a ZIP leaves out. The routes, the token, the CSRF header and
 * the pages that really come through a tunnel or over a network are in `tests/contract/folder-transfer.test.ts`.
 *
 *   scratch/<case>/
 *     home/        the home folder of the person the server runs as
 *     home/proj/   the conversation's folder
 *     outside/     what no transfer may touch
 *     data/        a folder an omp-webui keeps its own data in
 */

const scratch = realpathSync(tempDir("ompw-transfer-"));
let cases = 0;
const services: TransferService[] = [];
const answers: Response[] = [];
afterEach(async () => {
	for (const r of answers.splice(0)) await r.body?.cancel().catch(() => {});
});
afterAll(async () => {
	// Whatever was staged goes; nothing is deleted from the disk but that, and nothing outside what the service made.
	for (const s of services) await s.close();
});

const MiB = 1024 * 1024;

function world(opts: Partial<TransferOptions> = {}, root: "proj" | "home" = "proj") {
	const top = join(scratch, `case-${++cases}`);
	const home = join(top, "home");
	const proj = join(home, "proj");
	const outside = join(top, "outside");
	const data = join(top, "data");
	for (const dir of [proj, outside, data]) mkdirSync(dir, { recursive: true });
	let time = 1_000_000;
	const clock = {
		now: () => time,
		advance: (ms: number) => {
			time += ms;
		},
	};
	const service = new TransferService({
		logFile: join(top, "transfers.jsonl"),
		now: clock.now,
		...opts,
		limits: { pieceMax: 8, uploadBytes: 64, stallMs: 150, chunkBytes: 4, ...opts.limits },
	});
	services.push(service);
	const cwd = root === "proj" ? proj : home;
	const env = (over: Partial<TransferEnv> = {}): TransferEnv => ({
		setting: "full",
		local: false,
		who: "me@example.test",
		dataDirs: [data],
		protect: [data],
		home,
		...over,
	});
	const call = (
		path: string,
		o: { method?: string; body?: BodyInit | null; headers?: Record<string, string> } = {},
		e = env(),
	) => {
		const url = new URL(`http://x/api/folder/${path}`);
		const init: RequestInit & { duplex?: "half" } = { method: o.method ?? "GET", headers: o.headers };
		if (o.body !== undefined && o.body !== null) {
			init.body = o.body;
			if (typeof o.body === "object" && "getReader" in o.body) init.duplex = "half";
		}
		const answered = service.handle(new Request(url, init), url, { cwdOf: async () => cwd }, e);
		// An answer nobody reads is cancelled when the test is over, so that no file is left open.
		void answered.then((r) => answers.push(r));
		return answered;
	};
	const log = () =>
		existsSync(join(top, "transfers.jsonl"))
			? readFileSync(join(top, "transfers.jsonl"), "utf8")
					.split("\n")
					.filter(Boolean)
					.map((l) => JSON.parse(l) as Record<string, unknown>)
			: [];
	return { top, home, proj, outside, data, service, clock, env, call, log };
}

const write = (path: string, text: string | Uint8Array, mode?: number) => {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text);
	if (mode !== undefined) chmodSync(path, mode);
};
const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const body = async (r: Response) => Buffer.from(await r.arrayBuffer());
const failed = async (r: Response) => ({
	status: r.status,
	...((await r.json()) as { code: string; error: string }),
	header: r.headers.get(ERROR_HEADER),
});
const dl = (
	w: ReturnType<typeof world>,
	path: string,
	e = w.env(),
	headers: Record<string, string> = {},
	method = "GET",
) => w.call(`download?path=${encodeURIComponent(path)}`, { method, headers }, e);

describe("the pure parts", () => {
	test("Range: a range, an open end, a tail, no range, many ranges, nonsense, past the end", () => {
		expect(parseRange("bytes=2-5", 10)).toEqual({ start: 2, end: 5 });
		expect(parseRange("bytes=7-", 10)).toEqual({ start: 7, end: 9 });
		expect(parseRange("bytes=2-500", 10)).toEqual({ start: 2, end: 9 });
		expect(parseRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
		expect(parseRange(null, 10)).toBe("all");
		expect(parseRange("bytes=0-1,4-5", 10)).toBe("all");
		expect(parseRange("items=1-2", 10)).toBe("all");
		expect(parseRange("bytes=5-2", 10)).toBe("all");
		expect(parseRange("bytes=10-12", 10)).toBe("unsatisfiable");
		expect(parseRange("bytes=-0", 10)).toBe("unsatisfiable");
		expect(parseRange("bytes=0-0", 0)).toBe("unsatisfiable");
	});

	test("If-Range: the etag it names, a date, and what is neither", () => {
		expect(ifRangeHolds(null, "1-2-3", 5000)).toBe(true);
		expect(ifRangeHolds('"1-2-3"', "1-2-3", 5000)).toBe(true);
		expect(ifRangeHolds('"1-2-4"', "1-2-3", 5000)).toBe(false);
		expect(ifRangeHolds('W/"1-2-3"', "1-2-3", 5000)).toBe(false);
		expect(ifRangeHolds(new Date(5000).toUTCString(), "1-2-3", 5000)).toBe(true);
		expect(ifRangeHolds(new Date(9000).toUTCString(), "1-2-3", 5000)).toBe(false);
		expect(ifRangeHolds("tomorrow", "1-2-3", 5000)).toBe(false);
	});
	test("what an upload leaves out is what the Files tab hides: the two rules are one", () => {
		const names = [
			"node_modules",
			"__pycache__",
			"dist",
			"build",
			"target",
			".git",
			".github",
			".env",
			".cache",
			".DS_Store",
			"src",
			"README.md",
			"Dist",
			"targets",
			"a.b",
		];
		for (const name of names)
			for (const isDirectory of [true, false])
				expect(isHiddenName(name, isDirectory), `${name} ${isDirectory ? "folder" : "file"}`).toBe(
					hiddenByDefault(name, isDirectory, join(scratch, name)),
				);
	});
	test("a file name in a header: ASCII for old programs, the real one encoded, and nothing that turns the text around", () => {
		const header = contentDisposition('evil\u202Egpj.sh "q"\n.txt');
		expect(header).toMatch(/^attachment; filename="[\x20-\x7e]*"; filename\*=UTF-8''[A-Za-z0-9%._-]*$/);
		expect(header).not.toContain("\u202e");
		expect(header).not.toContain("%E2%80%AE");
		expect(header).not.toContain("\n");
		const unicode = contentDisposition("报告 (2).pdf");
		expect(unicode).toContain(
			`filename*=UTF-8''${encodeURIComponent("报告 (2).pdf").replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
		);
		expect(decodeURIComponent(/filename\*=UTF-8''(.*)$/.exec(unicode)?.[1] ?? "")).toBe("报告 (2).pdf");
	});
});

describe("downloading a file", () => {
	test("sends the bytes as an attachment that is never shown: octet-stream, nosniff, sandbox, no-store, an etag", async () => {
		const w = world();
		write(join(w.proj, "sub", "page.html"), "<script>alert(1)</script>");
		const r = await dl(w, "sub/page.html");
		expect(r.status).toBe(200);
		expect((await body(r)).toString()).toBe("<script>alert(1)</script>");
		expect(r.headers.get("content-type")).toBe("application/octet-stream");
		expect(r.headers.get("content-disposition")).toStartWith('attachment; filename="page.html"');
		expect(r.headers.get("x-content-type-options")).toBe("nosniff");
		expect(r.headers.get("content-security-policy")).toBe("sandbox");
		expect(r.headers.get("cache-control")).toBe("no-store");
		expect(r.headers.get("accept-ranges")).toBe("bytes");
		expect(r.headers.get("content-length")).toBe("25");
		expect(r.headers.get("etag")).toMatch(/^"\d+-\d+-\d+"$/);
	});

	test("a file of many chunks arrives whole, and an empty one is sent as nothing", async () => {
		const w = world();
		const big = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);
		write(join(w.proj, "big.bin"), big);
		write(join(w.proj, "empty.txt"), "");
		expect(new Uint8Array(await body(await dl(w, "big.bin")))).toEqual(big);
		const empty = await dl(w, "empty.txt");
		expect(empty.status).toBe(200);
		expect((await body(empty)).length).toBe(0);
	});

	test("Range goes on where a download stopped; If-Range for another file sends the whole; past the end is 416; HEAD sends no body", async () => {
		const w = world();
		write(join(w.proj, "f.txt"), "0123456789");
		const part = await dl(w, "f.txt", w.env(), { range: "bytes=3-6" });
		expect(part.status).toBe(206);
		expect(part.headers.get("content-range")).toBe("bytes 3-6/10");
		expect((await body(part)).toString()).toBe("3456");
		const etag = part.headers.get("etag") as string;
		expect((await dl(w, "f.txt", w.env(), { range: "bytes=8-", "if-range": etag })).status).toBe(206);
		const changed = await dl(w, "f.txt", w.env(), { range: "bytes=8-", "if-range": '"1-1-1"' });
		expect(changed.status).toBe(200);
		expect((await body(changed)).toString()).toBe("0123456789");
		const past = await dl(w, "f.txt", w.env(), { range: "bytes=20-30" });
		expect(past.status).toBe(416);
		expect(past.headers.get("content-range")).toBe("bytes */10");
		const head = await dl(w, "f.txt", w.env(), {}, "HEAD");
		expect(head.status).toBe(200);
		expect(head.headers.get("content-length")).toBe("10");
		expect((await body(head)).length).toBe(0);
	});

	test("what is not a file: a folder is 415 (its ZIP is the way), a missing one is 404, a path with a NUL is 400", async () => {
		const w = world();
		mkdirSync(join(w.proj, "dir"));
		expect(await failed(await dl(w, "dir"))).toMatchObject({ status: 415, code: "notFile" });
		expect(await failed(await dl(w, "nope.txt"))).toMatchObject({ status: 404, code: "notFound" });
		expect(await failed(await dl(w, "a\0b"))).toMatchObject({ status: 400, code: "badRequest" });
	});

	test("what leads out of the folder is refused to every page: `..`, an absolute path, a link out, a link that goes out and comes back", async () => {
		const w = world();
		write(join(w.outside, "secret.txt"), "outside");
		symlinkSync(join(w.outside, "secret.txt"), join(w.proj, "out.txt"));
		symlinkSync(w.outside, join(w.proj, "outdir"));
		write(join(w.proj, "in.txt"), "inside");
		symlinkSync(join(w.proj, "in.txt"), join(w.proj, "alias.txt"));
		for (const local of [false, true]) {
			const e = w.env({ local });
			for (const path of [
				"../outside/secret.txt",
				`${w.outside}/secret.txt`,
				"out.txt",
				"outdir/secret.txt",
				"a/../../outside/secret.txt",
			]) {
				expect(await failed(await dl(w, path, e)), `${local ? "local" : "remote"} ${path}`).toMatchObject({
					status: 403,
					code: "outside",
				});
			}
			// A link that leads inside is followed, as the Files tab follows it.
			expect((await body(await dl(w, "alias.txt", e))).toString()).toBe("inside");
		}
	});

	test("a page that is not on this computer is sent no secret: by name, by a link's target, by a key in its text", async () => {
		const w = world();
		write(join(w.proj, ".env"), "KEY=1");
		write(join(w.proj, ".env.local"), "KEY=1");
		write(join(w.proj, "id_ed25519"), "x");
		write(join(w.proj, "deploy", "credentials.json"), "{}");
		write(join(w.proj, "server.p12"), "x");
		write(join(w.proj, ".ssh", "config"), "x");
		write(join(w.proj, "notes.txt"), "hello\n-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n");
		write(join(w.proj, "plain.txt"), "just text");
		symlinkSync(join(w.proj, ".env"), join(w.proj, "readme.txt"));
		for (const path of [
			".env",
			".env.local",
			"id_ed25519",
			"deploy/credentials.json",
			"server.p12",
			".ssh/config",
			"notes.txt",
			"readme.txt",
		]) {
			expect(await failed(await dl(w, path)), path).toMatchObject({ status: 403, code: "secret", header: "secret" });
		}
		expect((await dl(w, "plain.txt")).status).toBe(200);
		// The person at this computer sees what the Files tab shows them.
		expect((await dl(w, ".env", w.env({ local: true }))).status).toBe(200);
		expect((await dl(w, "notes.txt", w.env({ local: true }))).status).toBe(200);
	});

	test("what is hidden by default is for download: dist, node_modules, dotfiles; not in a conversation whose folder is the home folder", async () => {
		const w = world();
		write(join(w.proj, "dist", "app.js"), "a");
		write(join(w.proj, "node_modules", "left-pad", "index.js"), "b");
		write(join(w.proj, ".github", "ci.yml"), "c");
		write(join(w.proj, ".eslintrc"), "d");
		for (const path of ["dist/app.js", "node_modules/left-pad/index.js", ".github/ci.yml", ".eslintrc"]) {
			expect((await dl(w, path)).status, path).toBe(200);
		}
		const h = world({}, "home");
		write(join(h.home, "dist", "app.js"), "a");
		write(join(h.home, "notes.txt"), "n");
		expect(await failed(await dl(h, "dist/app.js"))).toMatchObject({ status: 403, code: "hidden" });
		expect((await dl(h, "notes.txt")).status).toBe(200);
		expect((await dl(h, "dist/app.js", h.env({ local: true }))).status).toBe(200);
	});

	test("a place nothing is carried out of unasked is refused: omp's folder, launch agents, the app's data, whatever the folder is", async () => {
		const w = world();
		write(join(w.proj, ".omp", "agent.yml"), "x");
		write(join(w.proj, "Library", "LaunchAgents", "a.plist"), "x");
		const state = join(w.proj, "state", "db.sqlite");
		write(state, "x");
		const e = w.env({ protect: [join(w.proj, "state")] });
		for (const path of [".omp/agent.yml", "Library/LaunchAgents/a.plist", "state/db.sqlite"]) {
			expect(await failed(await dl(w, path, e)), path).toMatchObject({ status: 403, code: "protected" });
		}
	});

	test("the switch: off sends nothing to a page that is not on this computer, download and full send; this computer's own page ignores it", async () => {
		const w = world();
		write(join(w.proj, "f.txt"), "x");
		for (const setting of ["download", "full"] as FileTransfer[])
			expect((await dl(w, "f.txt", w.env({ setting }))).status).toBe(200);
		expect(await failed(await dl(w, "f.txt", w.env({ setting: "off" })))).toMatchObject({
			status: 403,
			code: "off",
			header: "off",
		});
		expect((await dl(w, "f.txt", w.env({ setting: "off", local: true }))).status).toBe(200);
		// A `HEAD` that is refused carries its code in the header, and no body.
		const head = await dl(w, "f.txt", w.env({ setting: "off" }), {}, "HEAD");
		expect(head.status).toBe(403);
		expect(head.headers.get(ERROR_HEADER)).toBe("off");
		expect((await body(head)).length).toBe(0);
	});

	test("an answer ends when the Access session does: the first part comes, the rest never", async () => {
		const w = world({ limits: { chunkBytes: 1024 } as TransferOptions["limits"] });
		write(join(w.proj, "big.bin"), new Uint8Array(512 * 1024));
		const r = await dl(w, "big.bin", w.env({ validUntil: w.clock.now() + 50 }));
		const reader = (r.body as ReadableStream<Uint8Array>).getReader();
		expect((await reader.read()).done).toBe(false);
		// Real time passes (the stream's own timer is a real one), and the clock the service reads is moved past it too.
		w.clock.advance(1000);
		await Bun.sleep(120);
		await expect(
			(async () => {
				for (;;) if ((await reader.read()).done) return;
			})(),
		).rejects.toThrow();
		expect(w.log().at(-1)).toMatchObject({ kind: "download", status: "expired", who: "me@example.test" });
	});

	test("a client that leaves gives its place back (two answers at a time for one asker) and the log says it left", async () => {
		const w = world({ limits: { chunkBytes: 16 } as TransferOptions["limits"] });
		write(join(w.proj, "big.bin"), new Uint8Array(4096));
		const first = await dl(w, "big.bin");
		const second = await dl(w, "big.bin");
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		const third = await dl(w, "big.bin");
		expect(third.status).toBe(429);
		expect(third.headers.get("retry-after")).toBe("2");
		await first.body?.cancel();
		expect((await dl(w, "big.bin")).status).toBe(200);
		expect(w.log().some((l) => l.status === "aborted" && l.kind === "download")).toBe(true);
	});

	test("the log has who, the path inside the folder, the size and how it ended: no query string, no token", async () => {
		const w = world();
		write(join(w.proj, "sub", "f.txt"), "hello");
		await body(await dl(w, "sub/f.txt", w.env({ who: "net:192.168.1.7" })));
		const line = w.log().at(-1);
		expect(line).toMatchObject({
			kind: "download",
			who: "net:192.168.1.7",
			root: w.proj,
			path: "sub/f.txt",
			size: 5,
			status: "ok",
		});
		expect(JSON.stringify(line)).not.toContain("?");
		write(join(w.proj, ".env"), "KEY=1");
		expect((await dl(w, ".env")).status).toBe(403);
		expect((await dl(w, "../x")).status).toBe(403);
		// What the person's rule said no to is written down, with who asked; a request that only named nothing is not.
		const refused = w.log().filter((l) => String(l.status).startsWith("refused:"));
		expect(refused.map((l) => l.status)).toEqual(["refused:secret", "refused:outside"]);
		expect(refused[0]).toMatchObject({ who: "me@example.test", path: ".env" });
		expect((await dl(w, "missing.txt")).status).toBe(404);
		expect(w.log().filter((l) => String(l.status).startsWith("refused:"))).toHaveLength(2);
	});
});

const unzip = async (r: Response, top: string) => {
	const file = join(top, `z-${Math.random().toString(36).slice(2)}.zip`);
	writeFileSync(file, await body(r));
	const zip = await ZipReader.open(file);
	try {
		const names = zip.entries.map((e) => e.name).sort();
		const texts = new Map<string, string>();
		for (const name of names) texts.set(name, Buffer.from(await zip.bytes(name)).toString());
		return { names, text: async (name: string) => texts.get(name) ?? "" };
	} finally {
		await zip.close();
	}
};
const plan = async (w: ReturnType<typeof world>, path: string, extra: Record<string, unknown> = {}, e = w.env()) => {
	const r = await w.call(
		"archive",
		{ method: "POST", body: JSON.stringify({ path, ...extra }), headers: { "content-type": "application/json" } },
		e,
	);
	return { r, plan: r.status === 200 ? ((await r.clone().json()) as ArchivePlan) : null };
};

describe("a folder as a ZIP", () => {
	function tree() {
		const w = world();
		write(join(w.proj, "app", "a.txt"), "aaa");
		write(join(w.proj, "app", "src", "b.ts"), "bbbb");
		write(join(w.proj, "app", ".env"), "KEY=1");
		write(join(w.proj, "app", ".hidden", "h.txt"), "hh");
		write(join(w.proj, "app", "node_modules", "m", "i.js"), "m");
		write(join(w.proj, "app", "key.txt"), "-----BEGIN RSA PRIVATE KEY-----\nx\n");
		write(join(w.outside, "o.txt"), "outside");
		symlinkSync(join(w.outside, "o.txt"), join(w.proj, "app", "outlink.txt"));
		symlinkSync(w.outside, join(w.proj, "app", "outdir"));
		symlinkSync(join(w.proj, "app", "a.txt"), join(w.proj, "app", "inlink.txt"));
		Bun.spawnSync(["mkfifo", join(w.proj, "app", "pipe")]);
		return w;
	}

	test("the plan counts what goes in and what is left out and why, before anything is sent", async () => {
		const w = tree();
		const { plan: p } = await plan(w, "app");
		expect(p).toMatchObject({ name: "app.zip", hiddenAllowed: true, hidden: false });
		// a.txt, src/b.ts, key.txt (a key in its text is found when it is sent), the file link inside
		expect(p?.files).toBe(4);
		expect(p?.bytes).toBe(3 + 4 + 34 + 3);
		expect(p?.skipped).toEqual({ secret: 1, links: 2, special: 1, name: 0, hidden: 2 });
		expect(p?.ticket).toMatch(/^[0-9a-f]{32}$/);
		expect(p?.url).toBe(`/api/folder/archive/${p?.ticket}`);
	});

	test("the ZIP holds what the plan said, under the folder's name, and none of what is left out: no secret, no link out, no pipe", async () => {
		const w = tree();
		const { plan: p } = await plan(w, "app");
		const r = await w.call(`archive/${p?.ticket}`);
		expect(r.status).toBe(200);
		expect(r.headers.get("content-type")).toBe("application/zip");
		expect(r.headers.get("content-disposition")).toContain('filename="app.zip"');
		const z = await unzip(r, w.top);
		expect(z.names).toEqual(["app/a.txt", "app/inlink.txt", "app/src/b.ts"]);
		expect(await z.text("app/a.txt")).toBe("aaa");
		expect(await z.text("app/inlink.txt")).toBe("aaa");
		expect(await z.text("app/src/b.ts")).toBe("bbbb");
		expect(w.log().at(-1)).toMatchObject({ kind: "zip", status: "ok", files: 3, path: "app" });
	});

	test("hidden things come when asked for, below the folder; a folder that is itself `dist` is asked for by its path", async () => {
		const w = tree();
		write(join(w.proj, "dist", "bundle.js"), "js");
		write(join(w.proj, "dist", ".map", "m.json"), "{}");
		const all = (await plan(w, "app", { hidden: true })).plan;
		expect(all).toMatchObject({ hidden: true, hiddenAllowed: true });
		expect(all?.skipped.hidden).toBe(0);
		const z = await unzip(await w.call(`archive/${all?.ticket}`), w.top);
		expect(z.names).toEqual([
			"app/.hidden/h.txt",
			"app/a.txt",
			"app/inlink.txt",
			"app/node_modules/m/i.js",
			"app/src/b.ts",
		]);
		// `.env` is a secret whatever is asked.
		expect(z.names).not.toContain("app/.env");
		const dist = (await plan(w, "dist")).plan;
		expect(dist).toMatchObject({ name: "dist.zip", files: 1 });
		expect(dist?.skipped.hidden).toBe(1);
		expect((await unzip(await w.call(`archive/${dist?.ticket}`), w.top)).names).toEqual(["dist/bundle.js"]);
	});

	test("in a conversation whose folder is the home folder hidden things are never in: the plan says they cannot be asked for", async () => {
		const w = world({}, "home");
		write(join(w.home, "docs", "a.txt"), "a");
		write(join(w.home, "docs", ".git", "config"), "x");
		const p = (await plan(w, "docs", { hidden: true })).plan;
		expect(p).toMatchObject({ hiddenAllowed: false, hidden: false, files: 1 });
		expect(p?.skipped.hidden).toBe(1);
		expect((await unzip(await w.call(`archive/${p?.ticket}`), w.top)).names).toEqual(["docs/a.txt"]);
	});

	test("a name a ZIP cannot hold is left out and counted: a backslash, a control character, a direction override", async () => {
		const w = world();
		write(join(w.proj, "z", "ok.txt"), "ok");
		for (const name of ["a\\..\\evil.txt", "ctl\u0001.txt", "gpj\u202E.txt"]) write(join(w.proj, "z", name), "x");
		const p = (await plan(w, "z")).plan;
		expect(p?.skipped.name).toBe(3);
		const z = await unzip(await w.call(`archive/${p?.ticket}`), w.top);
		expect(z.names).toEqual(["z/ok.txt"]);
		for (const n of z.names) {
			expect(n.startsWith("/")).toBe(false);
			expect(n.split("/")).not.toContain("..");
		}
	});

	test("a ticket is for one answer, for the one who asked, for a few minutes", async () => {
		const w = tree();
		const { plan: p } = await plan(w, "app");
		expect(await failed(await w.call(`archive/${p?.ticket}`, {}, w.env({ who: "other@example.test" })))).toMatchObject({
			status: 404,
			code: "gone",
		});
		// Another asker's try did not use it up.
		expect((await w.call(`archive/${p?.ticket}`)).status).toBe(200);
		expect(await failed(await w.call(`archive/${p?.ticket}`))).toMatchObject({ status: 404, code: "gone" });
		const late = (await plan(w, "app")).plan;
		w.clock.advance(5 * 60_000 + 1);
		expect(await failed(await w.call(`archive/${late?.ticket}`))).toMatchObject({ status: 404, code: "gone" });
		expect(await failed(await w.call("archive/not-a-ticket"))).toMatchObject({ status: 404, code: "gone" });
	});

	test("too many files, or too many bytes, is 413 with what the walk had counted", async () => {
		const w = world({ limits: { archiveFiles: 3, archiveBytes: 10 } as TransferOptions["limits"] });
		for (const n of ["a", "b", "c", "d"]) write(join(w.proj, "many", `${n}.txt`), "x");
		const many = await plan(w, "many");
		expect(many.r.status).toBe(413);
		expect(await many.r.json()).toMatchObject({ code: "tooMany", counted: { files: 4 } });
		write(join(w.proj, "big", "a.bin"), new Uint8Array(11));
		const big = await plan(w, "big");
		expect(big.r.status).toBe(413);
		expect(await big.r.json()).toMatchObject({ code: "tooLarge", counted: { bytes: 11 } });
	});

	test("what is asked of a path is what the file download asks: a file is not a folder, outside is outside, a secret is a secret, the switch is the switch", async () => {
		const w = tree();
		write(join(w.proj, "f.txt"), "x");
		expect((await plan(w, "f.txt")).r.status).toBe(400);
		expect((await plan(w, "../outside")).r.status).toBe(403);
		expect((await plan(w, "app/.hidden")).r.status).toBe(200);
		write(join(w.proj, ".ssh", "keys"), "x");
		expect((await plan(w, ".ssh")).r.status).toBe(403);
		expect((await plan(w, "app", {}, w.env({ setting: "off" }))).r.status).toBe(403);
		const p = (await plan(w, "app")).plan;
		expect((await w.call(`archive/${p?.ticket}`, {}, w.env({ setting: "off" }))).status).toBe(403);
	});

	test("the files are opened again as they are sent: one that went is skipped; one that became a link is not followed", async () => {
		let swap: (() => void) | undefined;
		let opened = 0;
		const w = world({ hooks: { beforeOpen: () => void (++opened === 2 && swap?.()) } });
		write(join(w.proj, "d", "a.txt"), "aaa");
		write(join(w.proj, "d", "b.txt"), "bbb");
		write(join(w.proj, "d", "c.txt"), "ccc");
		write(join(w.outside, "secret.txt"), "outside");
		const p = (await plan(w, "d")).plan;
		expect(p?.files).toBe(3);
		swap = () => {
			// b.txt is replaced by a link out between the plan and its turn.
			renameSync(join(w.proj, "d", "b.txt"), join(w.proj, "d", "b.moved"));
			symlinkSync(join(w.outside, "secret.txt"), join(w.proj, "d", "b.txt"));
		};
		const z = await unzip(await w.call(`archive/${p?.ticket}`), w.top);
		expect(z.names).toEqual(["d/a.txt", "d/c.txt"]);
		for (const n of z.names) expect(await z.text(n)).not.toContain("outside");
		expect(w.log().at(-1)).toMatchObject({ kind: "zip", status: "ok", files: 2 });
	});

	test("an Access session that ends while a ZIP is sent ends the answer: the client sees an error, never a ZIP that looks whole", async () => {
		const w = world({ limits: { chunkBytes: 1024 } as TransferOptions["limits"] });
		write(join(w.proj, "d", "big.bin"), randomBytes(512 * 1024));
		const p = (await plan(w, "d")).plan;
		const r = await w.call(`archive/${p?.ticket}`, {}, w.env({ validUntil: w.clock.now() + 60 }));
		const reader = (r.body as ReadableStream<Uint8Array>).getReader();
		expect((await reader.read()).done).toBe(false);
		w.clock.advance(1000);
		await Bun.sleep(150);
		await expect(
			(async () => {
				for (;;) if ((await reader.read()).done) return;
			})(),
		).rejects.toThrow();
		expect(w.log().at(-1)).toMatchObject({ kind: "zip", status: "expired" });
	});

	test("room for a ticket is asked before the folder is walked; a walk holds a place while it goes on, and the ones past the places are 429", async () => {
		const w = world({ limits: { archiveFiles: 2 } as TransferOptions["limits"] });
		write(join(w.proj, "small", "a.txt"), "a");
		for (let n = 0; n < 5; n++) write(join(w.proj, "big", `f${n}.txt`), "x");
		// The asker has the tickets they may have: another plan is turned away before the walk, which would have said of
		// this folder that it holds too many files.
		for (let n = 0; n < 8; n++) expect((await plan(w, "small")).r.status).toBe(200);
		expect(await failed((await plan(w, "big")).r)).toMatchObject({ status: 429, code: "busy" });
		// Another asker has room, and for them the folder is what it is.
		const other = w.env({ who: "b@example.test" });
		expect(await failed((await plan(w, "big", {}, other)).r)).toMatchObject({ status: 413, code: "tooMany" });

		const v = world();
		for (let n = 0; n < 1200; n++) write(join(v.proj, "many", `f${n}.txt`), "x");
		const statuses = (await Promise.all([1, 2, 3].map(() => plan(v, "many")))).map((p) => p.r.status).sort();
		expect(statuses).toEqual([200, 200, 429]);
		// The places are given back when the walks end.
		expect((await plan(v, "many")).r.status).toBe(200);
	});
});

const up = (
	w: ReturnType<typeof world>,
	o: {
		dir?: string;
		name: string;
		size: number;
		id?: string;
		offset?: number;
		extra?: string;
		body: string | Uint8Array | ReadableStream<Uint8Array>;
	},
	e = w.env(),
) => {
	const q = new URLSearchParams({ dir: o.dir ?? "", name: o.name, size: String(o.size) });
	if (o.id) q.set("id", o.id);
	if (o.offset !== undefined) q.set("offset", String(o.offset));
	return w.call(`upload?${q}${o.extra ?? ""}`, { method: "POST", body: o.body as BodyInit }, e);
};
const saved = async (r: Response) => {
	expect(r.status, await r.clone().text()).toBe(200);
	return (await r.json()) as UploadSaved;
};
const staged = (dir: string) => readdirSync(dir).filter((n) => n.startsWith(".ompw-upload-"));

describe("uploading a file", () => {
	test("a small file arrives whole in one request: its bytes, no execute bit, its SHA-256, a path inside the folder", async () => {
		const w = world();
		const r = await saved(await up(w, { name: "notes.txt", size: 5, body: "hello" }));
		expect(r).toMatchObject({
			done: true,
			path: "notes.txt",
			name: "notes.txt",
			bytes: 5,
			sha256: sha("hello"),
			replaced: false,
		});
		const file = join(w.proj, "notes.txt");
		expect(readFileSync(file, "utf8")).toBe("hello");
		expect(statSync(file).mode & 0o111).toBe(0);
		expect(staged(w.proj)).toEqual([]);
		expect(w.log().at(-1)).toMatchObject({
			kind: "upload",
			who: "me@example.test",
			root: w.proj,
			path: "notes.txt",
			size: 5,
			sha256: sha("hello"),
			status: "ok",
		});
	});

	test("a folder that is not there is made, one folder at a time, inside the conversation's folder", async () => {
		const w = world();
		const r = await saved(await up(w, { dir: "a/b c/d", name: "f.txt", size: 1, body: "x" }));
		expect(r.path).toBe("a/b c/d/f.txt");
		expect(readFileSync(join(w.proj, "a", "b c", "d", "f.txt"), "utf8")).toBe("x");
		expect((statSync(join(w.proj, "a", "b c")).mode & 0o777).toString(8)).toBe((0o755 & ~process.umask()).toString(8));
	});

	test("a file of many pieces: a piece answers how far it got, a piece in the wrong place is 409 with where to go on, the end answers with the SHA-256 of all", async () => {
		const w = world();
		const text = "abcdefghijklmnopqrstuvwx";
		const first = await up(w, { name: "big.bin", size: text.length, body: text.slice(0, 8) });
		expect(first.status).toBe(202);
		const progress = (await first.json()) as UploadProgress;
		expect(progress).toMatchObject({ received: 8, size: 24 });
		const wrong = await up(w, { name: "big.bin", size: 24, id: progress.id, offset: 16, body: text.slice(16, 24) });
		expect(await wrong.json()).toMatchObject({ code: "offset", received: 8 });
		// A page that lost the answer asks.
		const state = await w.call(`upload/state?id=${progress.id}`);
		expect(await state.json()).toMatchObject({ id: progress.id, received: 8 });
		expect(
			(await up(w, { name: "big.bin", size: 24, id: progress.id, offset: 8, body: text.slice(8, 16) })).status,
		).toBe(202);
		const done = await saved(
			await up(w, { name: "big.bin", size: 24, id: progress.id, offset: 16, body: text.slice(16) }),
		);
		expect(done).toMatchObject({ bytes: 24, sha256: sha(text), path: "big.bin" });
		expect(readFileSync(join(w.proj, "big.bin"), "utf8")).toBe(text);
		expect(staged(w.proj)).toEqual([]);
		// The upload is over: it is not known any more.
		expect((await w.call(`upload/state?id=${progress.id}`)).status).toBe(404);
	});

	test("a piece that comes up short is taken back, and sent again from the same place; the SHA-256 is of what is kept", async () => {
		const w = world({ limits: { stallMs: 100 } as TransferOptions["limits"] });
		const first = (await (await up(w, { name: "f.bin", size: 12, body: "AAAA" + "BBBB" })).json()) as UploadProgress;
		expect(first.received).toBe(8);
		// The connection of the next piece stops after two bytes.
		const stalled = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(new TextEncoder().encode("XX"));
			},
		});
		const dropped = await up(w, { name: "f.bin", size: 12, id: first.id, offset: 8, body: stalled });
		expect(dropped.status).toBe(408);
		expect(((await (await w.call(`upload/state?id=${first.id}`)).json()) as UploadProgress).received).toBe(8);
		const done = await saved(await up(w, { name: "f.bin", size: 12, id: first.id, offset: 8, body: "CCCC" }));
		expect(done.sha256).toBe(sha("AAAABBBBCCCC"));
		expect(readFileSync(join(w.proj, "f.bin"), "utf8")).toBe("AAAABBBBCCCC");
	});

	test("a piece over the limit, or one that goes past the size, is refused before it is written", async () => {
		const w = world();
		expect(await failed(await up(w, { name: "f.bin", size: 100, body: "x" }))).toMatchObject({
			status: 413,
			code: "tooLarge",
		});
		expect(await failed(await up(w, { name: "f.bin", size: 20, body: "123456789" }))).toMatchObject({
			status: 413,
			code: "tooLarge",
		});
		const first = (await (await up(w, { name: "g.bin", size: 10, body: "12345678" })).json()) as UploadProgress;
		expect(await failed(await up(w, { name: "g.bin", size: 10, id: first.id, offset: 8, body: "xyz" }))).toMatchObject({
			status: 413,
		});
		expect(((await (await w.call(`upload/state?id=${first.id}`)).json()) as UploadProgress).received).toBe(8);
		// A size other than the one the file began with is not taken.
		expect((await up(w, { name: "g.bin", size: 11, id: first.id, offset: 8, body: "xy" })).status).toBe(400);
		expect(statSync(join(w.proj, ".")).isDirectory()).toBe(true);
	});

	test("a name that is taken is 409 with the next free one and what is there; nothing is written over it", async () => {
		const w = world();
		write(join(w.proj, "r.txt"), "old");
		write(join(w.proj, "r (1).txt"), "old1");
		const r = await up(w, { name: "r.txt", size: 3, body: "new" });
		expect(r.status).toBe(409);
		const info = (await r.json()) as {
			code: string;
			suggestion: string;
			existing: { size: number; etag: string; replaceable: boolean };
		};
		expect(info).toMatchObject({ code: "exists", suggestion: "r (2).txt", existing: { size: 3, replaceable: true } });
		expect(readFileSync(join(w.proj, "r.txt"), "utf8")).toBe("old");
		expect(staged(w.proj)).toEqual([]);
		// Keep both: the next free name.
		const kept = await saved(await up(w, { name: "r.txt", size: 3, body: "new", extra: "&exists=keep" }));
		expect(kept.name).toBe("r (2).txt");
		expect(readFileSync(join(w.proj, "r.txt"), "utf8")).toBe("old");
		expect(readFileSync(join(w.proj, "r (2).txt"), "utf8")).toBe("new");
		// Replace: only the file the page saw.
		const replaced = await saved(
			await up(w, { name: "r.txt", size: 4, body: "newr", extra: `&replace=${info.existing.etag}` }),
		);
		expect(replaced).toMatchObject({ replaced: true, name: "r.txt" });
		expect(readFileSync(join(w.proj, "r.txt"), "utf8")).toBe("newr");
		const stale = await up(w, { name: "r.txt", size: 1, body: "z", extra: `&replace=${info.existing.etag}` });
		expect(await failed(stale)).toMatchObject({ status: 412, code: "changed" });
		expect(readFileSync(join(w.proj, "r.txt"), "utf8")).toBe("newr");
	});

	test("the log names the file that was saved, not the one it was kept beside, and says when a file was replaced", async () => {
		const w = world();
		write(join(w.proj, "r.txt"), "old");
		symlinkSync(join(w.outside, "t.txt"), join(w.proj, "l.txt"));
		write(join(w.proj, "sub", "h.txt"), "old");
		const info = (await (await up(w, { name: "r.txt", size: 3, body: "new" })).json()) as {
			existing: { etag: string };
		};
		await saved(await up(w, { name: "r.txt", size: 3, body: "new", extra: "&exists=keep" }));
		expect(w.log().at(-1)).toMatchObject({ kind: "upload", path: "r (1).txt", status: "ok" });
		expect(w.log().at(-1)).not.toHaveProperty("replaced");
		await saved(await up(w, { name: "l.txt", size: 1, body: "x", extra: "&exists=keep" }));
		expect(w.log().at(-1)).toMatchObject({ path: "l (1).txt", status: "ok" });
		const kept = await saved(await up(w, { dir: "sub", name: "h.txt", size: 1, body: "x", extra: "&exists=keep" }));
		expect(kept.path).toBe("sub/h (1).txt");
		expect(w.log().at(-1)).toMatchObject({ path: "sub/h (1).txt", status: "ok" });
		// Replace: the file that was seen is what the line says was put in place of.
		const replaced = await saved(
			await up(w, { name: "r.txt", size: 4, body: "newr", extra: `&replace=${info.existing.etag}` }),
		);
		expect(replaced.replaced).toBe(true);
		expect(w.log().at(-1)).toMatchObject({ path: "r.txt", status: "ok", replaced: true, size: 4, sha256: sha("newr") });
		// A file that is new is not marked.
		await saved(await up(w, { name: "fresh.txt", size: 1, body: "x" }));
		expect(w.log().at(-1)).toMatchObject({ path: "fresh.txt", status: "ok" });
		expect(w.log().at(-1)).not.toHaveProperty("replaced");
	});

	test("a program is never replaced, nor a link, nor a folder; the answer says it cannot be", async () => {
		const w = world();
		write(join(w.proj, "run.sh"), "#!/bin/sh\n", 0o755);
		write(join(w.outside, "t.txt"), "target");
		symlinkSync(join(w.outside, "t.txt"), join(w.proj, "ln.txt"));
		mkdirSync(join(w.proj, "folder"));
		const exists = await up(w, { name: "run.sh", size: 1, body: "x" });
		expect(((await exists.json()) as { existing: { replaceable: boolean } }).existing.replaceable).toBe(false);
		for (const name of ["run.sh", "ln.txt", "folder"]) {
			const there = lstatSync(join(w.proj, name), { bigint: true });
			const etag = `${there.size}-${Math.floor(Number(there.mtimeMs))}-${there.ino}`;
			expect(await failed(await up(w, { name, size: 1, body: "x", extra: `&replace=${etag}` })), name).toMatchObject({
				status: 403,
				code: "refused",
			});
		}
		expect(readFileSync(join(w.outside, "t.txt"), "utf8")).toBe("target");
		expect(readFileSync(join(w.proj, "run.sh"), "utf8")).toBe("#!/bin/sh\n");
	});

	test("where a file may land: inside the folder only; `..`, an absolute path, a link (even one that leads inside), a file where a folder should be", async () => {
		const w = world();
		symlinkSync(w.outside, join(w.proj, "outlink"));
		mkdirSync(join(w.proj, "real"));
		symlinkSync(join(w.proj, "real"), join(w.proj, "inlink"));
		write(join(w.proj, "afile"), "x");
		const cases: [string, number, string][] = [
			["../outside", 403, "outside"],
			[w.outside, 403, "outside"],
			["real/../../outside", 403, "outside"],
			["outlink", 403, "refused"],
			["outlink/deeper", 403, "refused"],
			["inlink", 403, "refused"],
			["afile/sub", 403, "refused"],
		];
		for (const [dir, status, code] of cases) {
			expect(await failed(await up(w, { dir, name: "x.txt", size: 1, body: "x" })), dir).toMatchObject({
				status,
				code,
			});
		}
		expect(existsSync(join(w.outside, "x.txt"))).toBe(false);
		expect(readdirSync(w.outside)).toEqual([]);
		expect(await failed(await up(w, { dir: "a\0b", name: "x.txt", size: 1, body: "x" }))).toMatchObject({
			status: 400,
		});
	});

	test("what is hidden or a secret is not written to, nor into; a place nothing is written into unasked is not; the home folder takes no upload", async () => {
		const w = world();
		const cases: [{ dir?: string; name: string }, string[]][] = [
			[{ name: ".env" }, ["hidden"]],
			[{ name: ".zshrc" }, ["hidden"]],
			[{ dir: ".git/hooks", name: "pre-commit" }, ["hidden", "protected"]],
			[{ dir: "node_modules", name: "x.js" }, ["hidden"]],
			[{ dir: "dist", name: "x.js" }, ["hidden"]],
			[{ dir: ".ssh", name: "authorized_keys" }, ["protected", "hidden"]],
			[{ dir: ".omp", name: "x.yml" }, ["protected", "hidden"]],
			[{ dir: "keys", name: "id_rsa" }, ["secret"]],
			[{ dir: "x", name: "credentials.json" }, ["secret"]],
			[{ dir: "Library/LaunchAgents", name: "a.plist" }, ["protected"]],
		];
		for (const [o, codes] of cases) {
			const f = await failed(await up(w, { ...o, size: 1, body: "x" }));
			expect(f.status, JSON.stringify(o)).toBe(403);
			expect(codes, JSON.stringify(o)).toContain(f.code);
		}
		expect(existsSync(join(w.proj, ".env"))).toBe(false);
		expect(existsSync(join(w.proj, ".ssh"))).toBe(false);
		const h = world({}, "home");
		expect(await failed(await up(h, { name: "x.txt", size: 1, body: "x" }))).toMatchObject({
			status: 403,
			code: "homeFolder",
		});
		expect(await failed(await up(h, { dir: "docs", name: "x.txt", size: 1, body: "x" }))).toMatchObject({
			code: "homeFolder",
		});
		expect(existsSync(join(h.home, "docs"))).toBe(false);
	});

	test("what CI runs on a push is not written into: nothing below .github/workflows or .github/actions, whatever the case; the rest of .github is fine", async () => {
		const w = world();
		for (const dir of [
			".github/workflows",
			".github/actions",
			".github/actions/setup",
			".GitHub/Workflows",
			".github/WORKFLOWS/x",
		]) {
			expect(await failed(await up(w, { dir, name: "ci.yml", size: 1, body: "x" })), dir).toMatchObject({
				status: 403,
				code: "protected",
			});
		}
		// Nothing was made on the way to the refusal.
		expect(existsSync(join(w.proj, ".github"))).toBe(false);
		expect(existsSync(join(w.proj, ".GitHub"))).toBe(false);
		expect((await saved(await up(w, { dir: ".github", name: "CODEOWNERS", size: 1, body: "x" }))).path).toBe(
			".github/CODEOWNERS",
		);
		expect((await saved(await up(w, { dir: ".github/ISSUE_TEMPLATE", name: "bug.md", size: 1, body: "x" }))).path).toBe(
			".github/ISSUE_TEMPLATE/bug.md",
		);
		expect(existsSync(join(w.proj, ".github", "workflows"))).toBe(false);
	});

	test("the app's own data folders take no upload: this server's, the app's, the web version's, however it is reached", async () => {
		const w = world();
		const own = join(w.proj, "appdata");
		mkdirSync(own);
		const e = w.env({ dataDirs: [own, w.data] });
		expect(await failed(await up(w, { dir: "appdata", name: "x.txt", size: 1, body: "x" }, e))).toMatchObject({
			status: 403,
			code: "ownData",
		});
		expect(await failed(await up(w, { dir: "appdata/sub", name: "x.txt", size: 1, body: "x" }, e))).toMatchObject({
			status: 403,
			code: "ownData",
		});
		expect(existsSync(join(own, "sub"))).toBe(false);
		// A folder next to it, and the folder that holds it, are fine.
		expect((await up(w, { name: "ok.txt", size: 1, body: "x" }, e)).status).toBe(200);
	});

	test("names: one name only, nothing that turns it around, nothing too long; hidden by name is refused", async () => {
		const w = world();
		for (const name of ["", ".", "..", "a/b", "a\\b", "a\0b"]) {
			expect(await failed(await up(w, { name, size: 1, body: "x" })), JSON.stringify(name)).toMatchObject({
				status: 400,
				code: "badName",
			});
		}
		const turned = await saved(await up(w, { name: "evil\u202Egpj.sh", size: 1, body: "x" }));
		expect(turned.name).not.toContain("\u202e");
		const long = await saved(await up(w, { name: `${"é".repeat(200)}.txt`, size: 1, body: "x" }));
		expect(Buffer.byteLength(long.name)).toBeLessThanOrEqual(120);
		expect(long.name.endsWith(".txt")).toBe(true);
	});

	test("the switch: download-only and off refuse an upload from a page that is not on this computer; its own page is not asked", async () => {
		const w = world();
		expect(
			await failed(await up(w, { name: "a.txt", size: 1, body: "x" }, w.env({ setting: "download" }))),
		).toMatchObject({ status: 403, code: "uploadOff", header: "uploadOff" });
		expect(await failed(await up(w, { name: "a.txt", size: 1, body: "x" }, w.env({ setting: "off" })))).toMatchObject({
			status: 403,
			code: "off",
		});
		expect((await w.call(`upload/state?id=${"0".repeat(32)}`, {}, w.env({ setting: "download" }))).status).toBe(403);
		expect((await up(w, { name: "a.txt", size: 1, body: "x" }, w.env({ setting: "off", local: true }))).status).toBe(
			200,
		);
		expect(existsSync(join(w.proj, "a.txt"))).toBe(true);
		// What was refused is in the log.
		expect(w.log().some((l) => l.status === "refused:uploadOff")).toBe(true);
	});

	test("a full disk is 507 before anything is written; what a file leaves free is the larger of the reserve and its share", async () => {
		const free = (bytes: number) => async () => ({ free: bytes, total: 1000 * MiB });
		const w = world({
			statfs: free(2 * MiB),
			limits: { reserveBytes: MiB, reservePercent: 5 } as TransferOptions["limits"],
		});
		// 5% of 1000 MiB is 50 MiB: that is what must be left.
		expect(await failed(await up(w, { name: "a.txt", size: 1, body: "x" }))).toMatchObject({
			status: 507,
			code: "diskFull",
		});
		expect(readdirSync(w.proj)).toEqual([]);
		const roomy = world({ statfs: free(900 * MiB), limits: { reserveBytes: MiB } as TransferOptions["limits"] });
		expect((await up(roomy, { name: "a.txt", size: 1, body: "x" })).status).toBe(200);
	});

	test("what is begun and not finished counts at once: files begun together past the limit are 429, and a file that was refused or given up gives its bytes back", async () => {
		const w = world({ limits: { inFlightBytes: 100 } as TransferOptions["limits"] });
		const begun = await Promise.all([0, 1, 2, 3].map((n) => up(w, { name: `f${n}.bin`, size: 40, body: "12345678" })));
		expect(begun.map((r) => r.status).sort()).toEqual([202, 202, 429, 429]);
		const ids: string[] = [];
		for (const r of begun) {
			if (r.status === 202) ids.push(((await r.json()) as UploadProgress).id);
			else expect(await failed(r)).toMatchObject({ status: 429, code: "busy" });
		}
		// One is given up: its 40 bytes are free again, for one file and not for two.
		await w.call("upload/cancel", { method: "POST", body: JSON.stringify({ id: ids[0] }) });
		expect((await up(w, { name: "g.bin", size: 40, body: "12345678" })).status).toBe(202);
		expect((await up(w, { name: "h.bin", size: 40, body: "12345678" })).status).toBe(429);
		// A file that is refused after it was counted (its name is taken) gives its bytes back.
		const v = world({ limits: { inFlightBytes: 100 } as TransferOptions["limits"] }, "proj");
		write(join(v.proj, "taken.txt"), "old");
		expect((await up(v, { name: "taken.txt", size: 64, body: "12345678" })).status).toBe(409);
		expect((await up(v, { name: "ok.bin", size: 64, body: "12345678" })).status).toBe(202);
	});

	test("the disk check counts what the uploads going on will still write: two files that do not fit together are not both let in", async () => {
		const room = { statfs: async () => ({ free: 100, total: 1000 }), limits: { reserveBytes: 10, reservePercent: 0 } };
		// Together: the one that is counted first is let in.
		const together = world({ ...room, limits: room.limits as TransferOptions["limits"] });
		const both = await Promise.all(
			["a", "b"].map((n) => up(together, { name: `${n}.bin`, size: 60, body: "12345678" })),
		);
		expect(both.map((r) => r.status).sort()).toEqual([202, 507]);
		// One after the other: the second finds what the first has still to write (60 - 8 = 52 of the 100 free).
		const w = world({ ...room, limits: room.limits as TransferOptions["limits"] });
		expect((await up(w, { name: "a.bin", size: 60, body: "12345678" })).status).toBe(202);
		expect(await failed(await up(w, { name: "b.bin", size: 60, body: "12345678" }))).toMatchObject({
			status: 507,
			code: "diskFull",
		});
		// What is left is for a file that fits (100 - 52 - 20 = 28, over the 10 kept free).
		expect((await up(w, { name: "c.bin", size: 20, body: "12345678" })).status).toBe(202);
		expect(staged(w.proj)).toHaveLength(2);
	});

	test("an asker has four uploads going, the server eight; a fifth is 429 with when to come back, and finishing gives the place back", async () => {
		const w = world();
		const ids: string[] = [];
		for (let n = 0; n < 4; n++)
			ids.push(((await (await up(w, { name: `f${n}.bin`, size: 16, body: "12345678" })).json()) as UploadProgress).id);
		const fifth = await up(w, { name: "f4.bin", size: 16, body: "12345678" });
		expect(fifth.status).toBe(429);
		expect(fifth.headers.get("retry-after")).toBeTruthy();
		expect(readdirSync(w.proj).filter((n) => n === "f4.bin")).toEqual([]);
		// Another asker is not held up by this one.
		expect(
			(await up(w, { name: "other.bin", size: 16, body: "12345678" }, w.env({ who: "b@example.test" }))).status,
		).toBe(202);
		await saved(await up(w, { name: "f0.bin", size: 16, id: ids[0], offset: 8, body: "12345678" }));
		expect((await up(w, { name: "f4.bin", size: 16, body: "12345678" })).status).toBe(202);
	});

	test("an upload is its asker's: another asker's piece, state and cancel find nothing", async () => {
		const w = world();
		const first = (await (await up(w, { name: "f.bin", size: 16, body: "12345678" })).json()) as UploadProgress;
		const stranger = w.env({ who: "other@example.test" });
		expect((await w.call(`upload/state?id=${first.id}`, {}, stranger)).status).toBe(404);
		expect((await up(w, { name: "f.bin", size: 16, id: first.id, offset: 8, body: "12345678" }, stranger)).status).toBe(
			404,
		);
		await w.call("upload/cancel", { method: "POST", body: JSON.stringify({ id: first.id }) }, stranger);
		expect(((await (await w.call(`upload/state?id=${first.id}`)).json()) as UploadProgress).received).toBe(8);
	});

	test("cancel, idle expiry and the end of the server remove what was staged", async () => {
		const w = world();
		const a = (await (await up(w, { name: "a.bin", size: 16, body: "12345678" })).json()) as UploadProgress;
		expect(staged(w.proj)).toHaveLength(1);
		const cancelled = await w.call("upload/cancel", { method: "POST", body: JSON.stringify({ id: a.id }) });
		expect(cancelled.status).toBe(200);
		expect(staged(w.proj)).toEqual([]);
		expect((await w.call(`upload/state?id=${a.id}`)).status).toBe(404);
		await up(w, { name: "b.bin", size: 16, body: "12345678" });
		w.clock.advance(30 * 60_000 + 1);
		await w.service.uploads.expire();
		expect(staged(w.proj)).toEqual([]);
		expect(w.log().some((l) => l.kind === "upload" && l.status === "expired")).toBe(true);
		await up(w, { name: "c.bin", size: 16, body: "12345678" });
		await w.service.close();
		expect(staged(w.proj)).toEqual([]);
	});

	test("a staged file a crashed server left, a day old and named like ours, is swept; no other file is touched", async () => {
		// What is a day old is told by the file's own time against the service's clock: this one reads the real time.
		const w = world({ now: () => Date.now() });
		const stale = join(w.proj, `.ompw-upload-${"a".repeat(32)}`);
		const young = join(w.proj, `.ompw-upload-${"b".repeat(32)}`);
		const lookalike = join(w.proj, "notes.ompw-upload-old");
		for (const f of [stale, young, lookalike]) write(f, "x");
		const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
		for (const f of [stale, lookalike]) utimesSync(f, old, old);
		await saved(await up(w, { name: "a.txt", size: 1, body: "x" }));
		await w.service.uploads.swept();
		expect(existsSync(stale)).toBe(false);
		expect(existsSync(young)).toBe(true);
		expect(existsSync(lookalike)).toBe(true);
	});

	test("a folder swapped for a link between the first piece and the last: nothing lands outside, and nothing is left staged", async () => {
		const w = world({
			beforePublish: () => {
				renameSync(join(w.proj, "sub"), join(w.proj, "sub.moved"));
				symlinkSync(w.outside, join(w.proj, "sub"));
			},
		});
		const first = (await (
			await up(w, { dir: "sub", name: "f.bin", size: 16, body: "12345678" })
		).json()) as UploadProgress;
		const last = await up(w, { dir: "sub", name: "f.bin", size: 16, id: first.id, offset: 8, body: "12345678" });
		expect(await failed(last)).toMatchObject({ status: 403, code: "refused" });
		expect(readdirSync(w.outside)).toEqual([]);
		expect(existsSync(join(w.proj, "sub.moved", "f.bin"))).toBe(false);
	});

	test("a body that stops arriving is given up (408), not waited for", async () => {
		const w = world({ limits: { stallMs: 80 } as TransferOptions["limits"] });
		const never = new ReadableStream<Uint8Array>({ start() {} });
		expect(await failed(await up(w, { name: "f.bin", size: 4, body: never }))).toMatchObject({
			status: 408,
			code: "stalled",
		});
		expect(staged(w.proj)).toEqual([]);
		expect(readdirSync(w.proj)).toEqual([]);
	});

	test("what one request is: a wrong method, a missing size, a bad id", async () => {
		const w = world();
		expect((await w.call("upload?name=a&size=1", { method: "GET" })).status).toBe(405);
		expect((await w.call("upload?name=a", { method: "POST", body: "x" })).status).toBe(400);
		expect((await w.call("upload?name=a&size=x", { method: "POST", body: "x" })).status).toBe(400);
		expect((await w.call("upload/state?id=zzz")).status).toBe(404);
		expect((await w.call("download", { method: "POST" })).status).toBe(405);
		expect((await w.call("archive", { method: "GET" })).status).toBe(405);
		expect((await w.call("upload/other")).status).toBe(404);
	});
});

describe("the log", () => {
	test("is private (0600), appended to, never through a link, and moved aside when it is long", () => {
		const dir = mkdtempSync(join(scratch, "log-"));
		const file = join(dir, "transfers.jsonl");
		const log = new TransferLog(file, 200);
		const line = {
			t: "2026-10-25T00:00:00.000Z",
			kind: "download" as const,
			who: "me@example.test",
			root: "/r",
			path: "a/b.txt",
			status: "ok",
			ms: 1,
		};
		log.append(line);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		log.append(line);
		expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
		for (let n = 0; n < 4; n++) log.append(line);
		expect(existsSync(`${file}.1`)).toBe(true);
		expect(statSync(`${file}.1`).mode & 0o777).toBe(0o600);
		expect(readFileSync(file, "utf8").trim().split("\n").length).toBeLessThan(6);
		// A link where the log goes is not followed.
		const target = join(dir, "target.txt");
		writeFileSync(target, "keep\n");
		const linked = join(dir, "linked.jsonl");
		symlinkSync(target, linked);
		new TransferLog(linked).append(line);
		expect(readFileSync(target, "utf8")).toBe("keep\n");
	});
});
