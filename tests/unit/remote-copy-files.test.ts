// needs: posixFiles
import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { RemoteNotSignedIn, RemoteTooOld, RemoteUnsupported } from "../../server/remote-run/client.ts";
import { copyRemote, type RemoteCopyOptions } from "../../server/remote-run/copy-client.ts";
import { checkTarget, placeNew } from "../../server/remote-run/copy-place.ts";
import { RemoteFiles } from "../../server/remote-run/files.ts";
import { TransferLog } from "../../server/transfer-log.ts";
import { REMOTE_COPY_MAX_BYTES, REMOTE_COPY_ROUTE, RemoteCopyError } from "../../shared/remote-copy.ts";
import type { TransferRecord } from "../../shared/transfer.ts";
import { pollUntil } from "../support/poll.ts";
import { craftTar } from "../support/tar.ts";
import { tempDir } from "../support/temp-dirs.ts";

/**
 * `remote_copy` end to end: this computer's client (`server/remote-run/copy-client.ts`) against a stand-in for the other
 * computer that checks what it checks (the Access cookie, its own cookie, the page's Origin, the CSRF header) and answers its
 * routes with the real `RemoteFiles` (`server/remote-run/files.ts`) over a home folder of its own. Files and folders both
 * ways, what is refused (overwrite, too large, a tar entry that leads out, the home folder, the app's data), and a copy cut
 * off half way, which leaves nothing at either target.
 */

const scratch = tempDir("ompw-remote-copy-files-");
let n = 0;
const fresh = (name: string) => {
	const dir = join(scratch, `${name}-${n++}`);
	mkdirSync(dir, { recursive: true });
	return dir;
};

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const JWT = `${b64url({ alg: "RS256" })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 3600 })}.c2ln`;
const WHO = "me@example.com";
const NONE = { reserveBytes: 0, reservePercent: 0 };

const cookiesOf = (req: Request): Record<string, string> =>
	Object.fromEntries(
		(req.headers.get("cookie") ?? "")
			.split(";")
			.map((c) => c.trim().split("="))
			.filter((kv) => kv.length === 2),
	);

interface Fake {
	origin: string;
	home: string;
	data: string;
	files: RemoteFiles;
	/** The copy requests it was sent: method and path. */
	asked: string[];
	log(): TransferRecord[];
	/** Hold answers back: a download after its first chunk, an upload's pieces after the first, until `release`. */
	hold(): { held: Promise<void>; release(): void };
	stop(): Promise<void>;
}

const fakes: Fake[] = [];
afterEach(async () => {
	for (const f of fakes.splice(0)) await f.stop();
});

function fakeRemote(o: { os?: string; old?: boolean; full?: boolean; headers?: Record<string, string> } = {}): Fake {
	const home = fresh("remote-home");
	const data = join(home, ".omp-webui");
	mkdirSync(data);
	const logFile = join(data, "transfers.jsonl");
	const files = new RemoteFiles({
		log: new TransferLog(logFile),
		places: { home, dataDirs: [data] },
		reserve: NONE,
		...(o.full ? { spaceOf: async () => ({ free: 0, total: 1e9 }) } : {}),
	});
	let gate: { opened: () => void; held: Promise<void>; release: Promise<void> } | null = null;
	const fake: Fake = {
		origin: "",
		home,
		data,
		files,
		asked: [],
		log: () =>
			existsSync(logFile)
				? readFileSync(logFile, "utf8")
						.split("\n")
						.filter(Boolean)
						.map((l) => JSON.parse(l) as TransferRecord)
				: [],
		hold() {
			const held = Promise.withResolvers<void>();
			const released = Promise.withResolvers<void>();
			gate = { opened: held.resolve, held: held.promise, release: released.promise };
			return { held: held.promise, release: released.resolve };
		},
		stop: async () => {},
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const cookies = cookiesOf(req);
			if (cookies.CF_Authorization !== JWT) return new Response(null, { status: 302, headers: { location: "/login" } });
			if (url.pathname === "/")
				return new Response("<!doctype html>", { headers: { "set-cookie": "ompw_token=tok; Path=/; HttpOnly" } });
			if (req.headers.get("origin") !== fake.origin) return new Response("Forbidden", { status: 403 });
			if (cookies.ompw_token !== "tok") return new Response("Unauthorized", { status: 401 });
			if (url.pathname === "/api/diagnostics") return Response.json({ os: o.os ?? "linux 6.1.0 (x64)" });
			if (url.pathname !== REMOTE_COPY_ROUTE && !url.pathname.startsWith(`${REMOTE_COPY_ROUTE}/`))
				return Response.json({ error: "Not found" }, { status: 404 });
			if (o.old) return Response.json({ error: "Not found" }, { status: 404 });
			if (req.method !== "GET" && req.headers.get("x-omp-webui") !== "1")
				return Response.json({ error: "Missing CSRF header" }, { status: 403 });
			fake.asked.push(`${req.method} ${url.pathname === REMOTE_COPY_ROUTE ? "begin" : "upload"}`);
			const g = gate;
			if (g && req.method === "PUT" && url.searchParams.get("offset") !== "0") {
				g.opened();
				await g.release;
			}
			const res = await files.handle(req, url, WHO);
			// A computer that says something else of what it sends than what it sends.
			if (o.headers && req.method === "GET") for (const [k, v] of Object.entries(o.headers)) res.headers.set(k, v);
			if (!g || req.method !== "GET" || !res.body) return res;
			// The first chunk, then nothing until the test lets the rest go.
			const reader = res.body.getReader();
			let first = true;
			return new Response(
				new ReadableStream({
					async pull(c) {
						if (!first) {
							g.opened();
							await g.release;
						}
						first = false;
						const { done, value } = await reader.read();
						if (done) c.close();
						else c.enqueue(value);
					},
					cancel: (r) => reader.cancel(r),
				}),
				{ headers: res.headers },
			);
		},
	});
	fake.origin = `http://127.0.0.1:${server.port}`;
	fake.stop = async () => {
		server.stop(true);
		await files.close();
	};
	fakes.push(fake);
	return fake;
}

function here() {
	const home = fresh("local-home");
	const data = join(home, "Library", "Application Support", "omp-webui");
	const proj = join(home, "proj");
	mkdirSync(data, { recursive: true });
	mkdirSync(proj);
	return { home, data, proj };
}

function copy(
	fake: Fake,
	local: ReturnType<typeof here>,
	o: Partial<RemoteCopyOptions> & Pick<RemoteCopyOptions, "direction" | "local" | "remote">,
) {
	return copyRemote({
		host: "omp.example.com",
		jwt: JWT,
		origin: fake.origin,
		overwrite: false,
		places: { home: local.home, dataDirs: [local.data] },
		reserve: NONE,
		signal: new AbortController().signal,
		...o,
	});
}

/** What `job` threw. */
async function thrown(job: Promise<unknown>): Promise<unknown> {
	try {
		await job;
	} catch (e) {
		return e;
	}
	throw new Error("it did not throw");
}

const staged = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(".ompw-")) : []);

function folder(root: string): void {
	mkdirSync(join(root, "sub/deeper"), { recursive: true });
	writeFileSync(join(root, "index.html"), "<h1>hi</h1>\n");
	writeFileSync(join(root, "sub/deeper/data.bin"), Buffer.alloc(300_000, 3));
	symlinkSync("deeper/data.bin", join(root, "sub/latest"));
	symlinkSync("/etc/hosts", join(root, "hosts"));
}

describe("a file", () => {
	test("goes to the other computer, into folders made for it, and comes back the same; both are logged there", async () => {
		const fake = fakeRemote();
		const local = here();
		writeFileSync(join(local.proj, "notes.txt"), "über\n");
		const to = await copy(fake, local, {
			direction: "to",
			local: join(local.proj, "notes.txt"),
			remote: "~/in/notes.txt",
		});
		expect(to).toMatchObject({ kind: "file", files: 1, bytes: 6, leftOut: 0, replaced: false });
		expect(to.from).toBe(join(local.proj, "notes.txt"));
		expect(to.to).toBe(join(fake.home, "in/notes.txt"));
		expect(readFileSync(join(fake.home, "in/notes.txt"), "utf8")).toBe("über\n");

		const back = await copy(fake, local, {
			direction: "from",
			local: join(local.proj, "back/notes.txt"),
			remote: join(fake.home, "in/notes.txt"),
		});
		expect(back).toMatchObject({ kind: "file", files: 1, bytes: 6, from: join(fake.home, "in/notes.txt") });
		expect(readFileSync(join(local.proj, "back/notes.txt"), "utf8")).toBe("über\n");
		expect(staged(join(local.proj, "back"))).toEqual([]);
		expect(staged(join(fake.home, "in"))).toEqual([]);
		await pollUntil(() => fake.log().some((r) => r.kind === "copy-send"), "the send to be logged");
		expect(fake.log().map((r) => [r.kind, r.who, r.path, r.status, r.size])).toEqual([
			["copy-receive", WHO, join(fake.home, "in/notes.txt"), "ok", 6],
			["copy-send", WHO, join(fake.home, "in/notes.txt"), "ok", 6],
		]);
	});

	test("an empty file, and pieces smaller than the file", async () => {
		const fake = fakeRemote();
		const local = here();
		writeFileSync(join(local.proj, "empty"), "");
		writeFileSync(join(local.proj, "big.bin"), Buffer.alloc(200_000, 9));
		await copy(fake, local, { direction: "to", local: join(local.proj, "empty"), remote: "empty" });
		expect(readFileSync(join(fake.home, "empty"), "utf8")).toBe("");
		await copy(fake, local, {
			direction: "to",
			local: join(local.proj, "big.bin"),
			remote: "big.bin",
			pieceBytes: 65_536,
		});
		expect(readFileSync(join(fake.home, "big.bin")).equals(Buffer.alloc(200_000, 9))).toBe(true);
		expect(fake.asked.filter((a) => a === "PUT upload")).toHaveLength(4);
	});
});

describe("a folder", () => {
	test("goes whole with its folders and the links inside it; a link that leads out is left out and counted", async () => {
		const fake = fakeRemote();
		const local = here();
		folder(join(local.proj, "site"));
		const to = await copy(fake, local, {
			direction: "to",
			local: join(local.proj, "site"),
			remote: "~/www/site",
			pieceBytes: 100_000,
		});
		expect(to).toMatchObject({ kind: "folder", files: 2, bytes: 300_012, leftOut: 1, replaced: false });
		const there = join(fake.home, "www/site");
		expect(readFileSync(join(there, "index.html"), "utf8")).toBe("<h1>hi</h1>\n");
		expect(readlinkSync(join(there, "sub/latest"))).toBe("deeper/data.bin");
		expect(readFileSync(join(there, "sub/latest")).length).toBe(300_000);
		expect(lstatSync(join(there, "hosts"), { throwIfNoEntry: false })).toBeUndefined();

		const back = await copy(fake, local, { direction: "from", local: join(local.proj, "site2"), remote: "~/www/site" });
		expect(back).toMatchObject({ kind: "folder", files: 2, bytes: 300_012, leftOut: 0 });
		expect(readFileSync(join(local.proj, "site2/sub/deeper/data.bin")).equals(Buffer.alloc(300_000, 3))).toBe(true);
		expect(readlinkSync(join(local.proj, "site2/sub/latest"))).toBe("deeper/data.bin");
		expect(staged(local.proj)).toEqual([]);
		expect(staged(join(fake.home, "www"))).toEqual([]);
	});
});

describe("what is refused", () => {
	test("something at the target, unless overwrite: then it is replaced whole, a folder not merged into", async () => {
		const fake = fakeRemote();
		const local = here();
		folder(join(local.proj, "site"));
		mkdirSync(join(fake.home, "site"));
		writeFileSync(join(fake.home, "site/old.txt"), "old");
		const e = await thrown(copy(fake, local, { direction: "to", local: join(local.proj, "site"), remote: "~/site" }));
		expect(e).toBeInstanceOf(RemoteCopyError);
		expect(e).toMatchObject({ code: "exists", there: true });
		expect((e as Error).message).toContain("overwrite: true");
		expect(fake.asked).toEqual(["POST begin"]);

		const r = await copy(fake, local, {
			direction: "to",
			local: join(local.proj, "site"),
			remote: "~/site",
			overwrite: true,
		});
		expect(r.replaced).toBe(true);
		expect(readdirSync(join(fake.home, "site")).sort()).toEqual(["index.html", "sub"]);
		expect(staged(fake.home)).toEqual([]);

		// This computer's target, before anything is asked of the other one.
		writeFileSync(join(local.proj, "taken"), "mine");
		fake.asked.length = 0;
		const mine = await thrown(
			copy(fake, local, { direction: "from", local: join(local.proj, "taken"), remote: "~/site" }),
		);
		expect(mine).toMatchObject({ code: "exists", there: false });
		expect(fake.asked).toEqual([]);
		await copy(fake, local, {
			direction: "from",
			local: join(local.proj, "taken"),
			remote: "~/site/index.html",
			overwrite: true,
		});
		expect(readFileSync(join(local.proj, "taken"), "utf8")).toBe("<h1>hi</h1>\n");
	});

	test("more than 2 GB, either way, before any of it is sent", async () => {
		const fake = fakeRemote();
		const local = here();
		// Sparse: as large as it says, and no room taken.
		writeFileSync(join(local.proj, "huge"), "");
		truncateSync(join(local.proj, "huge"), REMOTE_COPY_MAX_BYTES + 1);
		const out = await thrown(copy(fake, local, { direction: "to", local: join(local.proj, "huge"), remote: "~/huge" }));
		expect(out).toMatchObject({ code: "tooLarge", there: false });
		expect(fake.asked).toEqual([]);
		writeFileSync(join(fake.home, "huge"), "");
		truncateSync(join(fake.home, "huge"), REMOTE_COPY_MAX_BYTES + 1);
		const back = await thrown(
			copy(fake, local, { direction: "from", local: join(local.proj, "huge2"), remote: "~/huge" }),
		);
		expect(back).toMatchObject({ code: "tooLarge", there: true });
		expect(existsSync(join(local.proj, "huge2"))).toBe(false);
	});

	test("the home folder, what holds it, and the app's data, on either computer", async () => {
		const fake = fakeRemote();
		const local = here();
		writeFileSync(join(local.proj, "f"), "x");
		for (const remote of ["~", fake.home, "/", "~/.omp-webui/x", join(fake.data, "..", ".omp-webui")]) {
			const e = await thrown(
				copy(fake, local, { direction: "to", local: join(local.proj, "f"), remote, overwrite: true }),
			);
			expect(e).toMatchObject({ there: true });
			expect(["broad", "ownData"]).toContain((e as RemoteCopyError).code);
		}
		for (const target of [local.home, join(local.data, "f")]) {
			const e = await thrown(copy(fake, local, { direction: "from", local: target, remote: "~", overwrite: true }));
			expect(e).toMatchObject({ there: false });
			expect(["broad", "ownData"]).toContain((e as RemoteCopyError).code);
		}
	});

	test("a tar entry that leads out: nothing is written outside, and what arrived is removed", async () => {
		const fake = fakeRemote();
		const target = join(fake.home, "dest");
		const ask = (path: string, init: RequestInit = {}) =>
			fetch(`${fake.origin}${path}`, {
				...init,
				headers: { cookie: `CF_Authorization=${JWT}; ompw_token=tok`, origin: fake.origin, "x-omp-webui": "1" },
			});
		for (const tar of [
			craftTar([{ name: "../escaped.txt", body: "x" }]),
			craftTar([
				{ name: "ok", type: "5" },
				{ name: "ok/l", type: "2", link: "../../.." },
			]),
		]) {
			const q = new URLSearchParams({ path: target, kind: "folder", size: String(tar.length), bytes: "1" });
			const begun = (await (await ask(`${REMOTE_COPY_ROUTE}?${q}`, { method: "POST" })).json()) as { id: string };
			const put = await ask(`${REMOTE_COPY_ROUTE}/${begun.id}?offset=0`, { method: "PUT", body: tar });
			expect(put.status).toBe(400);
			expect(await put.json()).toMatchObject({ code: "badArchive" });
			const done = await ask(`${REMOTE_COPY_ROUTE}/${begun.id}`, { method: "POST" });
			expect(done.status).toBe(404);
		}
		expect(existsSync(join(fake.home, "escaped.txt"))).toBe(false);
		expect(existsSync(target)).toBe(false);
		expect(staged(fake.home)).toEqual([]);
		expect(fake.log().map((r) => r.status)).toEqual(["refused:badArchive", "refused:badArchive"]);
	});

	test("a sign-in the computer does not take, a computer that runs Windows, one that runs an older omp-webui", async () => {
		const local = here();
		writeFileSync(join(local.proj, "f"), "x");
		const args = { direction: "to" as const, local: join(local.proj, "f"), remote: "~/f" };
		expect(await thrown(copy(fakeRemote(), local, { ...args, jwt: "a.b.c" }))).toBeInstanceOf(RemoteNotSignedIn);
		expect(await thrown(copy(fakeRemote({ os: "win32 10.0 (x64)" }), local, args))).toBeInstanceOf(RemoteUnsupported);
		expect(await thrown(copy(fakeRemote({ old: true }), local, args))).toBeInstanceOf(RemoteTooOld);
	});
});

describe("a copy cut off half way", () => {
	test("from the other computer: nothing is left here, not even what had arrived", async () => {
		const fake = fakeRemote();
		const local = here();
		writeFileSync(join(fake.home, "big.bin"), Buffer.alloc(4 * 1024 * 1024, 1));
		const { held, release } = fake.hold();
		const stop = new AbortController();
		const job = thrown(
			copy(fake, local, {
				direction: "from",
				local: join(local.proj, "big.bin"),
				remote: "~/big.bin",
				signal: stop.signal,
			}),
		);
		await held;
		await pollUntil(() => staged(local.proj).length === 1, "the copy to be under way here");
		stop.abort();
		expect(await job).toBeDefined();
		release();
		expect(existsSync(join(local.proj, "big.bin"))).toBe(false);
		expect(staged(local.proj)).toEqual([]);
		await pollUntil(() => fake.log().some((r) => r.kind === "copy-send"), "the send to be logged");
		expect(fake.log().at(-1)?.status).not.toBe("ok");
	});

	test("to the other computer: it is given up there, and nothing is left at its target", async () => {
		const fake = fakeRemote();
		const local = here();
		writeFileSync(join(local.proj, "big.bin"), Buffer.alloc(1024 * 1024, 2));
		const { held, release } = fake.hold();
		const stop = new AbortController();
		const job = thrown(
			copy(fake, local, {
				direction: "to",
				local: join(local.proj, "big.bin"),
				remote: "~/big.bin",
				pieceBytes: 65_536,
				signal: stop.signal,
			}),
		);
		await held;
		expect(staged(fake.home)).toHaveLength(1);
		stop.abort();
		expect(await job).toBeDefined();
		release();
		await pollUntil(() => fake.log().some((r) => r.status === "aborted"), "the copy to be given up there");
		expect(existsSync(join(fake.home, "big.bin"))).toBe(false);
		expect(staged(fake.home)).toEqual([]);
	});
});

describe("the home folder and the app's data are told by what they are, not by how their path is spelt", () => {
	test("on a volume without case, another spelling of either is refused, here and there, and nothing is moved", async () => {
		const top = fresh("case");
		const home = join(top, "Home");
		const data = join(top, "data", ".omp-webui");
		mkdirSync(join(home, "proj"), { recursive: true });
		mkdirSync(data, { recursive: true });
		writeFileSync(join(home, "keep"), "mine");
		const places = { home, dataDirs: [data] };
		// Where the volume tells case apart these are other folders, and may be written.
		const caseless = existsSync(join(top, "HOME"));
		for (const abs of [
			join(top, "HOME"),
			`${join(top, "home")}/`,
			join(top, "data", ".OMP-WEBUI"),
			join(top, "DATA"),
		]) {
			const e = await thrown(checkTarget(abs, true, places)).catch((x: unknown) => x);
			if (caseless) expect(["broad", "ownData"], abs).toContain((e as RemoteCopyError).code);
		}
		// Inside the home folder, however it is spelt, is where a copy goes.
		expect(await checkTarget(join(home, "proj", "x"), true, places)).toBeNull();

		const fake = fakeRemote();
		const local = here();
		writeFileSync(join(local.proj, "f"), "x");
		writeFileSync(join(fake.home, "keep"), "theirs");
		const upper = join(fake.home, "..", fake.home.split("/").at(-1)?.toUpperCase() ?? "");
		if (existsSync(upper)) {
			const e = await thrown(
				copy(fake, local, { direction: "to", local: join(local.proj, "f"), remote: upper, overwrite: true }),
			);
			expect(e).toMatchObject({ code: "broad", there: true });
			const mine = join(local.home, "..", local.home.split("/").at(-1)?.toUpperCase() ?? "");
			const back = await thrown(
				copy(fake, local, { direction: "from", local: mine, remote: "~/keep", overwrite: true }),
			);
			expect(back).toMatchObject({ code: "broad", there: false });
		}
		expect(readFileSync(join(fake.home, "keep"), "utf8")).toBe("theirs");
		expect(existsSync(join(local.proj, "f"))).toBe(true);
	});
});

describe("a computer that says it sends less than it sends", () => {
	test("is held to what it said: a folder's files, or a file, past it are refused, and nothing is left here", async () => {
		const lying = fakeRemote({ headers: { "x-omp-webui-bytes": "1" } });
		const local = here();
		folder(join(lying.home, "site"));
		writeFileSync(join(lying.home, "f.txt"), "six b\n");
		const site = await thrown(
			copy(lying, local, { direction: "from", local: join(local.proj, "new/site"), remote: "~/site" }),
		);
		expect(site).toMatchObject({ code: "tooLarge", there: true });
		expect((site as Error).message).toContain("said it holds");
		const file = await thrown(
			copy(lying, local, { direction: "from", local: join(local.proj, "f.txt"), remote: "~/f.txt" }),
		);
		expect(file).toMatchObject({ code: "changed" });
		expect(readdirSync(local.proj)).toEqual([]);
	});
});

describe("putting a copy in place", () => {
	test("never replaces what came at the target after it was looked at: a file, an empty folder, a full one", async () => {
		const dir = fresh("place");
		writeFileSync(join(dir, "staged"), "new");
		writeFileSync(join(dir, "theirs"), "theirs");
		expect(await thrown(placeNew(join(dir, "staged"), join(dir, "theirs")))).toMatchObject({ code: "exists" });
		expect(readFileSync(join(dir, "theirs"), "utf8")).toBe("theirs");
		expect(readFileSync(join(dir, "staged"), "utf8")).toBe("new");

		mkdirSync(join(dir, "sd"));
		writeFileSync(join(dir, "sd", "a"), "a");
		mkdirSync(join(dir, "empty"));
		mkdirSync(join(dir, "full"));
		writeFileSync(join(dir, "full", "b"), "b");
		for (const target of ["empty", "full", "theirs"])
			expect(await thrown(placeNew(join(dir, "sd"), join(dir, target))), target).toMatchObject({ code: "exists" });
		expect(readdirSync(join(dir, "empty"))).toEqual([]);
		expect(readdirSync(join(dir, "full"))).toEqual(["b"]);
		expect(readFileSync(join(dir, "theirs"), "utf8")).toBe("theirs");
		expect(readdirSync(join(dir, "sd"))).toEqual(["a"]);

		// Where nothing is, it is put, and the staged name is gone.
		await placeNew(join(dir, "sd"), join(dir, "new-dir"));
		await placeNew(join(dir, "staged"), join(dir, "new-file"));
		expect(readFileSync(join(dir, "new-dir", "a"), "utf8")).toBe("a");
		expect(readFileSync(join(dir, "new-file"), "utf8")).toBe("new");
		expect(existsSync(join(dir, "sd")) || existsSync(join(dir, "staged"))).toBe(false);
	});

	test("a disk without room is found before any folder is made, on either side", async () => {
		const fake = fakeRemote();
		const local = here();
		writeFileSync(join(fake.home, "f"), "x");
		const here_ = await thrown(
			copy(fake, local, {
				direction: "from",
				local: join(local.proj, "a/b/c"),
				remote: "~/f",
				spaceOf: async () => ({ free: 0, total: 1e9 }),
			}),
		);
		expect(here_).toMatchObject({ code: "diskFull", there: false });
		expect(existsSync(join(local.proj, "a"))).toBe(false);
		const full = fakeRemote({ full: true });
		writeFileSync(join(local.proj, "f"), "x");
		const there = await thrown(copy(full, local, { direction: "to", local: join(local.proj, "f"), remote: "~/a/b/c" }));
		expect(there).toMatchObject({ code: "diskFull", there: true });
		expect(existsSync(join(full.home, "a"))).toBe(false);
	});
});

describe("an upload whose piece stalls", () => {
	test("is given up once no byte has come for the idle time, the stalled request included, and leaves nothing", async () => {
		let now = 1_000;
		const home = fresh("stall-home");
		const data = join(home, ".omp-webui");
		mkdirSync(data);
		const files = new RemoteFiles({
			log: new TransferLog(join(data, "transfers.jsonl")),
			places: { home, dataDirs: [data] },
			reserve: NONE,
			now: () => now,
			idleMs: 1_000,
		});
		try {
			const ask = (path: string, init: RequestInit = {}) => {
				const req = new Request(`http://omp.example.com${path}`, init);
				return files.handle(req, new URL(req.url), WHO);
			};
			const begun = (await (
				await ask(`${REMOTE_COPY_ROUTE}?path=~/big&kind=file&size=10&bytes=10`, { method: "POST" })
			).json()) as {
				id: string;
			};
			// Four bytes, then nothing, and the request never ends.
			const body = new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(new Uint8Array(4)) });
			const put = ask(`${REMOTE_COPY_ROUTE}/${begun.id}?offset=0`, {
				method: "PUT",
				body,
				duplex: "half",
			} as RequestInit);
			await pollUntil(
				() => staged(home).length === 1 && lstatSync(join(home, staged(home)[0] ?? "")).size === 4,
				"the piece to arrive",
			);
			now += 500;
			await files.expire();
			expect(staged(home)).toHaveLength(1);
			now += 2_000;
			await files.expire();
			const res = await put;
			expect(res.status).toBe(404);
			expect(staged(home)).toEqual([]);
			expect(existsSync(join(home, "big"))).toBe(false);
			const finish = await ask(`${REMOTE_COPY_ROUTE}/${begun.id}`, { method: "POST" });
			expect(finish.status).toBe(404);
			const log = readFileSync(join(data, "transfers.jsonl"), "utf8").trim().split("\n");
			expect(JSON.parse(log.at(-1) ?? "{}")).toMatchObject({ kind: "copy-receive", status: "expired" });
		} finally {
			await files.close();
		}
	});
});
