import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FOLDER_LIMITS, type FolderFile, type FolderFound, type FolderListing } from "../../shared/folder.ts";
import { type AccessKey, AUD, EMAIL, HOSTNAME, type Jwks, makeKey, startJwks, TEAM } from "../support/access-jwt.ts";
import { writeChatSession } from "../support/chat-session.ts";
import { remoteClient } from "../support/remote-client.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { connect } from "../support/ws.ts";

/**
 * `/api/folder/*` against the real server: a conversation's folder listed one folder at a time, read, searched and
 * watched; what no page can reach (a path that climbs out, an absolute one, a link that leads out, a folder the page
 * names itself); and the two actions that hand a file to macOS, which a page that came through the tunnel never gets.
 *
 *   work/
 *     proj/        the conversation's folder (a git repository)
 *     secret/      outside it
 *     outside.txt  outside it
 */

const root = mkdtempSync(join(tmpdir(), "ompw-folder-http-"));
let s: TestServer;
let key: AccessKey;
let jwks: Jwks;
let work: string;
let proj: string;
/** The conversation that works in `proj`, by its session file. */
let file: string;
let remote: ReturnType<typeof remoteClient>;

const write = (rel: string, data: string | Uint8Array, base = proj) => {
	const path = join(base, rel);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, data);
};

function git(...args: string[]): void {
	const ran = Bun.spawnSync(
		["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
		{ cwd: proj, stdout: "pipe", stderr: "pipe" },
	);
	if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr.toString()}`);
}

beforeAll(async () => {
	key = await makeKey("kid-1");
	jwks = await startJwks([key]);
	const settings = join(root, "remote.json");
	writeFileSync(settings, JSON.stringify({ enabled: true, hostname: HOSTNAME, team: TEAM, aud: AUD, emails: [EMAIL] }));
	s = await startTestServer(
		0,
		{ OMP_WEBUI_REMOTE_CONFIG: settings, OMP_WEBUI_ACCESS_CERTS_URL: jwks.url },
		{ login: false },
	);
	remote = remoteClient(s, key);
	work = realpathSync(s.work);
	proj = join(work, "proj");
	mkdirSync(proj, { recursive: true });
	mkdirSync(join(work, "secret"));
	writeFileSync(join(work, "secret", "key.txt"), "the secret");
	writeFileSync(join(work, "outside.txt"), "outside");
	mkdirSync(join(work, "proj-evil"));
	writeFileSync(join(work, "proj-evil", "x.txt"), "evil");

	write("README.md", "# Title\n\nSome *words*.\n");
	write("src/app.ts", "export const a = 1;\n");
	write("src/util/helper.ts", "export const h = 1;\n");
	write("docs/guide.md", "guide\n");
	write(".gitignore", "gen/\n*.log\n");
	write("data.bin", new Uint8Array([0, 1, 2, 3, 0, 255]));
	write("pic.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]));
	write("big.txt", `${"line of text\n".repeat(FOLDER_LIMITS.textBytes / 13 + 1000)}`);
	write("run.sh", "#!/bin/sh\necho hi\n");
	chmodSync(join(proj, "run.sh"), 0o755);
	symlinkSync(join(work, "secret"), join(proj, "link-dir"));
	symlinkSync(join(work, "outside.txt"), join(proj, "link-file"));
	symlinkSync(join(work, "proj-evil"), join(proj, "link-evil"));
	symlinkSync(join(proj, "src"), join(proj, "link-src"));
	git("init", "-q", "-b", "main");
	git("add", ".");
	git("commit", "-q", "-m", "first");
	// After the commit: a modified file, a new one, an ignored folder and file, a dependency folder.
	write("README.md", "# Title\n\nChanged.\n");
	write("src/new.ts", "export const n = 1;\n");
	write("gen/out.js", "x");
	write("debug.log", "x");
	write("node_modules/dep/index.js", "x");
	file = writeChatSession(s.agentDir, {
		n: 91,
		title: "Files probe",
		cwd: proj,
		turns: [{ prompt: "hi", reply: "ok" }],
	});
}, 90_000);

afterAll(async () => {
	await s?.stop();
	jwks?.stop();
	rmSync(root, { recursive: true, force: true });
});

const headers = () => ({ "x-omp-webui-token": s.accessToken, "x-omp-webui": "1" });

/** `GET /api/folder/<route>` for the conversation (by its file, unless `over` says otherwise), as a local page. */
async function ask(route: string, query: Record<string, string> = {}, over: Record<string, string | null> = {}) {
	const params = new URLSearchParams({ file, ...query });
	for (const [k, v] of Object.entries(over)) {
		if (v === null) params.delete(k);
		else params.set(k, v);
	}
	const res = await fetch(`${s.url}/api/folder/${route}?${params}`, { headers: headers() });
	return res;
}
const list = async (path = "", extra: Record<string, string> = {}) => {
	const res = await ask("list", { path, ...extra });
	return { status: res.status, body: (await res.json()) as FolderListing & { error?: string } };
};
const read = async (path: string) => {
	const res = await ask("file", { path });
	return { status: res.status, body: (await res.json()) as FolderFile & { error?: string } };
};

describe("listing", () => {
	test("the folder's own entries come one folder at a time: folders first, hidden ones left out and counted", async () => {
		const { status, body } = await list();
		expect(status).toBe(200);
		expect(body.root).toBe(proj);
		expect(body.path).toBe("");
		const names = body.entries.map((e) => `${e.kind === "dir" ? "/" : ""}${e.name}`);
		expect(names).toEqual([
			"/docs",
			"/link-src",
			"/src",
			"big.txt",
			"data.bin",
			"link-dir",
			"link-evil",
			"link-file",
			"pic.png",
			"README.md",
			"run.sh",
		]);
		// .git, .gitignore, node_modules, gen (ignored) and debug.log (ignored)
		expect(body.hiddenCount).toBe(5);
		expect(body.git).toBe(true);
		expect(body.truncated).toBe(false);
		// What is inside a folder is not in its parent's listing.
		expect(JSON.stringify(body)).not.toContain("helper.ts");
	});

	test("a folder lists on its own, with the path it was asked by", async () => {
		const { body } = await list("src");
		expect(body.path).toBe("src");
		expect(body.entries.map((e) => e.name)).toEqual(["util", "app.ts", "new.ts"]);
		expect((await list("src/util")).body.entries.map((e) => e.name)).toEqual(["helper.ts"]);
	});

	test("git marks: a modified file, a new one, and the folders that hold them", async () => {
		const top = (await list()).body;
		expect(Object.fromEntries(top.entries.filter((e) => e.git).map((e) => [e.name, e.git]))).toEqual({
			"README.md": "modified",
			src: "changed",
		});
		expect(Object.fromEntries((await list("src")).body.entries.map((e) => [e.name, e.git ?? null]))).toEqual({
			util: null,
			"app.ts": null,
			"new.ts": "untracked",
		});
	});

	test("everything is listed when asked, with the hidden ones marked", async () => {
		const { body } = await list("", { all: "1" });
		expect(body.hiddenCount).toBe(0);
		expect(body.entries.filter((e) => e.hidden).map((e) => e.name)).toEqual([
			".git",
			"gen",
			"node_modules",
			".gitignore",
			"debug.log",
		]);
	});

	test("a link inside is a folder like any other, one that leads out is a leaf", async () => {
		const byName = Object.fromEntries((await list()).body.entries.map((e) => [e.name, e]));
		expect(byName["link-src"]).toMatchObject({ kind: "dir", link: "in" });
		expect(byName["link-dir"]).toMatchObject({ kind: "file", link: "out" });
		expect(byName["link-evil"]).toMatchObject({ kind: "file", link: "out" });
		expect((await list("link-src")).body.entries.map((e) => e.name)).toEqual(["util", "app.ts", "new.ts"]);
	});

	test("a file is not a folder, a missing folder is not found", async () => {
		expect((await list("README.md")).status).toBe(400);
		expect((await list("nowhere")).status).toBe(404);
	});
});

describe("reading", () => {
	test("a text file comes with what it opens as", async () => {
		const { status, body } = await read("src/app.ts");
		expect(status).toBe(200);
		expect(body).toMatchObject({
			kind: "text",
			text: "export const a = 1;\n",
			view: "code",
			truncated: false,
			size: 20,
		});
		expect((await read("README.md")).body).toMatchObject({ kind: "text", view: "markdown" });
	});

	test("a large file is cut at its first megabyte, and says so", async () => {
		const { body } = await read("big.txt");
		expect(body.kind).toBe("text");
		if (body.kind !== "text") return;
		expect(body.truncated).toBe(true);
		expect(body.size).toBeGreaterThan(FOLDER_LIMITS.textBytes);
		expect(Buffer.byteLength(body.text)).toBeLessThanOrEqual(FOLDER_LIMITS.textBytes);
		expect(Buffer.byteLength(body.text)).toBeGreaterThan(FOLDER_LIMITS.textBytes - 100);
	});

	test("a binary file is its size alone, an image is named by its type and served as an image and nothing else", async () => {
		expect((await read("data.bin")).body).toMatchObject({ kind: "binary", size: 6 });
		expect((await read("pic.png")).body).toMatchObject({ kind: "image", mime: "image/png" });
		const raw = await ask("raw", { path: "pic.png" });
		expect(raw.status).toBe(200);
		expect(raw.headers.get("content-type")).toBe("image/png");
		expect(raw.headers.get("x-content-type-options")).toBe("nosniff");
		expect(new Uint8Array(await raw.arrayBuffer()).slice(0, 4)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
		// The raw route is for images: a text file is refused, and so is a page that asks for one it names with an image's name.
		expect((await ask("raw", { path: "src/app.ts" })).status).toBe(415);
	});

	test("what is not a regular file is not read", async () => {
		expect((await read("src")).status).toBe(415);
	});
});

describe("find", () => {
	test("names the files whose path holds what is typed, best first, with their git marks", async () => {
		const res = await ask("find", { q: "APP" });
		const found = (await res.json()) as FolderFound;
		expect(found.matches).toEqual([{ path: "src/app.ts" }]);
		const news = (await (await ask("find", { q: "new" })).json()) as FolderFound;
		expect(news.matches).toEqual([{ path: "src/new.ts", git: "untracked" }]);
		expect(news).toMatchObject({ truncated: false, partial: false });
	});

	test("what is hidden is searched only when everything is asked for", async () => {
		const some = (await (await ask("find", { q: "index" })).json()) as FolderFound;
		expect(some.matches).toEqual([]);
		const all = (await (await ask("find", { q: "index", all: "1" })).json()) as FolderFound;
		expect(all.matches.map((m) => m.path)).toEqual(["node_modules/dep/index.js"]);
		const ignored = (await (await ask("find", { q: "out", all: "1" })).json()) as FolderFound;
		expect(ignored.matches.map((m) => m.path)).toContain("gen/out.js");
		expect(((await (await ask("find", { q: "out" })).json()) as FolderFound).matches.map((m) => m.path)).not.toContain(
			"gen/out.js",
		);
	});
});

describe("what no page can reach", () => {
	const OUT = [
		"..",
		"../secret/key.txt",
		"../outside.txt",
		"%2e%2e/secret/key.txt",
		"src/../../outside.txt",
		"src/../README.md",
		"/etc/passwd",
		join("..", "proj-evil", "x.txt"),
		"link-dir/key.txt",
		"link-dir",
		"link-file",
		"link-evil/x.txt",
		"link-dir/not-there.png",
	];

	for (const route of ["list", "file", "raw"]) {
		test(`${route}: ${OUT.length} ways out are all refused (403), and nothing of what is outside is in the answer`, async () => {
			for (const path of OUT) {
				const res = await ask(route, { path: path.replaceAll("%2e", ".") });
				const text = await res.text();
				expect(res.status, `${route} ${path}`).toBe(403);
				expect(text, `${route} ${path}`).not.toContain("the secret");
				expect(text, `${route} ${path}`).not.toContain("outside");
				expect(text, `${route} ${path}`).not.toContain("evil");
			}
		});
	}

	test("a path a file system cannot hold is a bad request", async () => {
		expect((await ask("file", { path: "a\0b" })).status).toBe(400);
		expect((await ask("file", { path: "x".repeat(5000) })).status).toBe(400);
	});

	test("a link that was made after the page looked is refused too: nothing is remembered between requests", async () => {
		write("later.txt", "ok");
		expect((await read("later.txt")).status).toBe(200);
		unlinkSync(join(proj, "later.txt"));
		symlinkSync(join(work, "secret", "key.txt"), join(proj, "later.txt"));
		expect((await read("later.txt")).status).toBe(403);
		unlinkSync(join(proj, "later.txt"));
	});

	test("the page names the conversation, never the folder: a `cwd` or `root` it makes up is not read", async () => {
		for (const extra of [{ cwd: work }, { cwd: "/" }, { root: "/" }, { dir: "/etc" }] as Record<string, string>[]) {
			const { status, body } = await list("", extra);
			expect(status).toBe(200);
			expect(body.root).toBe(proj);
		}
		const res = await ask("file", { path: "../secret/key.txt", cwd: work });
		expect(res.status).toBe(403);
	});

	test("a conversation that is not one of the server's is not found, whatever it is called", async () => {
		for (const over of [{ file: join(work, "outside.txt") }, { file: "/etc/passwd" }, { file: "" }, { file: null }]) {
			const res = await ask("list", {}, over);
			expect(res.status, JSON.stringify(over)).toBe(404);
		}
		const live = await fetch(`${s.url}/api/folder/list?live=not-a-live-id`, { headers: headers() });
		expect(live.status).toBe(404);
	});

	test("it answers the page of this server and a request that carries the token only", async () => {
		const noToken = await fetch(`${s.url}/api/folder/list?file=${encodeURIComponent(file)}`);
		expect(noToken.status).toBe(401);
		const crossSite = await fetch(`${s.url}/api/folder/list?file=${encodeURIComponent(file)}`, {
			headers: { ...headers(), "sec-fetch-site": "cross-site" },
		});
		expect(crossSite.status).toBe(403);
	});

	test("only what the Files tab asks for is POST or GET: a look at git that skips what is kept is a POST", async () => {
		const query = new URLSearchParams({ file, path: "" });
		const get = await fetch(`${s.url}/api/folder/list?${query}&fresh=1`, { headers: headers() });
		expect(get.status).toBe(405);
		const post = await fetch(`${s.url}/api/folder/list?${query}&fresh=1`, { method: "POST", headers: headers() });
		expect(post.status).toBe(200);
		const plainPost = await fetch(`${s.url}/api/folder/list?${query}`, { method: "POST", headers: headers() });
		expect(plainPost.status).toBe(405);
	});
});

describe("open and reveal", () => {
	const open = (body: Record<string, unknown>, init: { headers?: Record<string, string> } = {}) =>
		fetch(`${s.url}/api/folder/open`, {
			method: "POST",
			headers: { ...headers(), "content-type": "application/json", ...init.headers },
			body: JSON.stringify({ file, ...body }),
		});
	/**
	 * What this computer's page is told when it asks for what it may not have. Opening is the macOS `open`: elsewhere the
	 * server says so first, whatever the request names (the walls it would meet are tests/unit/folder.test.ts).
	 */
	const refused = async (res: Response, status: number, error: string, label: string, dir = false) => {
		const told =
			process.platform === "darwin"
				? { status, error }
				: { status: 501, error: `Opening ${dir ? "folders" : "files"} from the page is only available on macOS` };
		expect(res.status, label).toBe(told.status);
		expect(await res.json(), label).toEqual({ error: told.error });
	};

	test("a page of this computer may ask, but nothing is executed: an executable is refused even here", async () => {
		await refused(await open({ path: "run.sh" }), 403, "An executable file is never opened", "run.sh");
	});

	test("a path outside the folder is refused as everywhere else", async () => {
		for (const path of ["../outside.txt", "/etc/hosts", "link-file", "link-dir"]) {
			for (const reveal of [false, true]) {
				await refused(await open({ path, reveal }), 403, "Outside the folder", `${path} ${reveal}`);
			}
		}
	});

	test("it is a POST, and the page's own", async () => {
		const get = await fetch(`${s.url}/api/folder/open?file=${encodeURIComponent(file)}&path=README.md`, {
			headers: headers(),
		});
		expect(get.status).toBe(405);
		const noCsrf = await fetch(`${s.url}/api/folder/open`, {
			method: "POST",
			headers: { "x-omp-webui-token": s.accessToken, "content-type": "application/json" },
			body: JSON.stringify({ file, path: "README.md" }),
		});
		expect(noCsrf.status).toBe(403);
	});

	test("a page that came through the tunnel is refused, with what only this computer's page may do named, and nothing is opened", async () => {
		// The file is an executable, so that even a server that let this through would run nothing: the refusal is told
		// from that one by what it says.
		for (const reveal of [false, true]) {
			const res = await remote.fetch(
				"/api/folder/open",
				{ method: "POST", headers: { "x-omp-webui": "1", "content-type": "application/json" } },
				JSON.stringify({ file, path: "run.sh", reveal }),
			);
			expect(res.status).toBe(403);
			expect(await res.json()).toEqual({ error: "Opening files is only for the page on this computer" });
		}
	});

	test("a request that carries what Cloudflare adds is not this computer's, even with a loopback Host", async () => {
		for (const header of ["cf-ray", "cf-connecting-ip", "cdn-loop"]) {
			const res = await open({ path: "run.sh" }, { headers: { [header]: "x" } });
			expect(res.status, header).toBe(403);
			expect(await res.json(), header).toEqual({ error: "Opening files is only for the page on this computer" });
		}
	});

	test("nor is one that carries what another reverse proxy on this machine adds", async () => {
		for (const header of [
			"x-forwarded-for",
			"x-forwarded-host",
			"x-forwarded-proto",
			"forwarded",
			"via",
			"x-real-ip",
		]) {
			for (const reveal of [false, true]) {
				const res = await open({ path: "run.sh", reveal }, { headers: { [header]: "203.0.113.9" } });
				expect(res.status, header).toBe(403);
				expect(await res.json(), header).toEqual({ error: "Opening files is only for the page on this computer" });
			}
		}
	});

	test("the tunnel's page reads what a local page does, and is told it cannot open", async () => {
		const res = await remote.fetch(`/api/folder/file?file=${encodeURIComponent(file)}&path=README.md`);
		expect(res.status).toBe(200);
		expect(((await res.json()) as FolderFile).local).toBe(false);
		const local = (await read("README.md")).body;
		expect(local.local).toBe(process.platform === "darwin");
		// Reading is the conversation's folder for it too, and the same walls stand.
		const out = await remote.fetch(`/api/folder/file?file=${encodeURIComponent(file)}&path=../outside.txt`);
		expect(out.status).toBe(403);
		const link = await remote.fetch(`/api/folder/file?file=${encodeURIComponent(file)}&path=link-file`);
		expect(link.status).toBe(403);
	});

	// The folder action. Nothing here may ever be let through to `open` (it would show a Finder window on the machine that
	// runs the test): a page that is not this computer's is refused at the gate, and what this computer's page asks for is
	// outside the folder or a file, so that it is refused before anything is handed over. That the folder itself is opened
	// by the real path, with the spawn replaced, is tests/unit/folder.test.ts.
	test("the folder action: a page that came through the tunnel is refused, for the conversation's folder and any other", async () => {
		for (const path of ["", "src", "src/app.ts", "../secret", "/etc"]) {
			const res = await remote.fetch(
				"/api/folder/open",
				{ method: "POST", headers: { "x-omp-webui": "1", "content-type": "application/json" } },
				JSON.stringify({ file, path, dir: true }),
			);
			expect(res.status, path).toBe(403);
			expect(await res.json(), path).toEqual({ error: "Opening files is only for the page on this computer" });
		}
		for (const header of ["cf-ray", "x-forwarded-for", "forwarded", "via", "x-real-ip"]) {
			const res = await open({ path: "", dir: true }, { headers: { [header]: "203.0.113.9" } });
			expect(res.status, header).toBe(403);
			expect(await res.json(), header).toEqual({ error: "Opening files is only for the page on this computer" });
		}
	});

	test("the folder action: this computer's page is refused a folder outside the conversation's, by `..`, a path or a link", async () => {
		for (const path of ["..", "../secret", "/", "/etc", "link-dir", "link-dir/key.txt", "link-evil", "link-file"]) {
			await refused(await open({ path, dir: true }), 403, "Outside the folder", path, true);
		}
	});

	test("the folder action: a file is not a folder, whatever it is, and a folder that is not there is not found", async () => {
		for (const path of ["README.md", "src/app.ts", "run.sh", "pic.png", "data.bin"]) {
			await refused(await open({ path, dir: true }), 400, "Only folders are opened", path, true);
		}
		const mac = process.platform === "darwin";
		expect((await open({ path: "no-such-folder", dir: true })).status).toBe(mac ? 404 : 501);
		expect((await open({ path: 5, dir: true })).status).toBe(mac ? 400 : 501);
		// The conversation is looked up before the system is asked anything: one the server does not know is not found anywhere.
		expect((await open({ file: "no-such-conversation.jsonl", path: "", dir: true })).status).toBe(404);
	});

	test("the listing tells this computer's page it may open folders, and the tunnel's page nothing", async () => {
		const here = await list();
		expect(here.body.local).toBe(process.platform === "darwin" ? true : undefined);
		const res = await remote.fetch(`/api/folder/list?file=${encodeURIComponent(file)}&path=`);
		expect(res.status).toBe(200);
		const there = (await res.json()) as FolderListing;
		expect(there.guarded).toBe(true);
		expect(there.local).toBeUndefined();
	});
});

describe("a page that is not this computer's", () => {
	/** Secret by their names, and keys by their text (called like anything), and what is only hidden. */
	const SECRETS = ["id_rsa", "credentials.json", "secrets.yml", ".env", ".npmrc", ".netrc", "store.p12"];
	const PEM = "-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----\n";
	const KEYS = ["server.pem", "deploy.key"];
	const HIDDEN = [".hidden-note", ".config/tool/hosts.yml", "node_modules/dep/index.js"];
	const PLAIN = ["notes.txt", "keyboard.key", "id_helper.ts"];
	beforeAll(() => {
		for (const name of SECRETS) write(`probe/${name}`, "SECRET");
		for (const name of KEYS) write(`probe/${name}`, PEM);
		for (const name of HIDDEN) write(`probe/${name}`, "HIDDEN-ONLY");
		for (const name of PLAIN) write(`probe/${name}`, "plain");
		write("probe/.ssh/config", "SECRET");
		write("probe/id_rsa.png", "not a picture");
		symlinkSync(join(proj, "probe/.env"), join(proj, "probe/innocent.txt"));
	});
	// The filter's list of files is kept for a moment: the files made above are walked for again, as the page does once
	// something changed (a POST that skips what is kept).
	beforeAll(async () => {
		for (const all of ["", "&all=1"]) {
			const walked = await fetch(`${s.url}/api/folder/find?file=${encodeURIComponent(file)}&q=probe/&fresh=1${all}`, {
				method: "POST",
				headers: headers(),
			});
			expect(walked.status).toBe(200);
		}
	});
	afterAll(() => rmSync(join(proj, "probe"), { recursive: true, force: true }));

	const q = (route: string, query: Record<string, string>) =>
		`/api/folder/${route}?${new URLSearchParams({ file, ...query })}`;
	/** The page through the tunnel, and the page on this computer behind a proxy that says where the request came from. */
	const guardedPages: [string, (path: string) => Promise<Response>][] = [
		["through the tunnel", (path) => remote.fetch(path)],
		[
			"behind a proxy",
			(path) => fetch(`${s.url}${path}`, { headers: { ...headers(), "x-forwarded-for": "203.0.113.9" } }),
		],
	];

	for (const [who, get] of guardedPages) {
		test(`${who}: what is hidden stays hidden whatever is asked for, and secrets are not listed`, async () => {
			const res = await get(q("list", { path: "probe", all: "1" }));
			expect(res.status).toBe(200);
			const listing = (await res.json()) as FolderListing;
			expect(listing.guarded).toBe(true);
			expect(listing.entries.map((e) => e.name)).toEqual([
				"deploy.key",
				"id_helper.ts",
				"innocent.txt",
				"keyboard.key",
				"notes.txt",
				"server.pem",
			]);
			expect(listing.hiddenCount).toBeGreaterThan(0);
			expect(listing.entries.some((e) => e.hidden)).toBe(false);
			// Not at the top either: .git and node_modules and the dotfiles stay out with everything asked for.
			const top = (await (await get(q("list", { path: "", all: "1" }))).json()) as FolderListing;
			for (const hidden of [".git", ".gitignore", "gen", "node_modules", "debug.log"])
				expect(
					top.entries.map((e) => e.name),
					hidden,
				).not.toContain(hidden);
		});

		test(`${who}: the filter finds neither what is hidden nor a secret, with everything asked for`, async () => {
			const found = (await (await get(q("find", { q: "probe/", all: "1" }))).json()) as FolderFound;
			// (The walk lists files, not links: `innocent.txt`, a link, is not among them.)
			expect(found.matches.map((m) => m.path).sort()).toEqual(
				["deploy.key", "id_helper.ts", "keyboard.key", "notes.txt", "server.pem"].map((n) => `probe/${n}`),
			);
			const inDependency = (await (await get(q("find", { q: "index", all: "1" }))).json()) as FolderFound;
			expect(inDependency.matches).toEqual([]);
		});

		test(`${who}: what looks like a secret is not read, whatever it is called, nor a link to it, nor a key by its text, nor a picture by such a name`, async () => {
			const refused = [
				...SECRETS.map((n) => `probe/${n}`),
				...KEYS.map((n) => `probe/${n}`),
				"probe/.ssh/config",
				"probe/.ssh",
				"probe/innocent.txt",
				".git/config",
			];
			for (const path of refused) {
				for (const route of ["file", "list"]) {
					const res = await get(q(route, { path, all: "1" }));
					const text = await res.text();
					// A folder is not a file and a file not a folder: what matters is that no secret comes back.
					expect(text, `${route} ${path}`).not.toContain("SECRET");
					if (route === "file") expect(res.status, `${route} ${path}`).toBe(403);
				}
			}
			expect((await get(q("raw", { path: "probe/id_rsa.png" }))).status).toBe(403);
			// What its listing leaves out (hidden by default) is not read by its path either, though it is no secret by name.
			for (const path of [...HIDDEN, ".git/HEAD"].map((n) => (n.startsWith(".git") ? n : `probe/${n}`))) {
				for (const route of ["file", "list"]) {
					const res = await get(q(route, { path, all: "1" }));
					expect(await res.text(), `${route} ${path}`).not.toContain("HIDDEN-ONLY");
					if (route === "file") expect(res.status, `${route} ${path}`).toBe(403);
				}
			}
			// What is neither is read, whatever its name sounds like.
			for (const name of PLAIN) expect((await get(q("file", { path: `probe/${name}` }))).status, name).toBe(200);
		});
	}

	test("the page on this computer is given all of it", async () => {
		const listing = (await (await ask("list", { path: "probe", all: "1" })).json()) as FolderListing;
		expect(listing.guarded).toBeUndefined();
		const names = listing.entries.map((e) => e.name);
		for (const name of [...SECRETS, ...KEYS, ".ssh", ".hidden-note", ".config", "node_modules", "innocent.txt"])
			expect(names, name).toContain(name);
		for (const name of SECRETS)
			expect((await read(`probe/${name}`)).body).toMatchObject({ kind: "text", text: "SECRET" });
		for (const name of KEYS) expect((await read(`probe/${name}`)).body).toMatchObject({ kind: "text", text: PEM });
		for (const name of HIDDEN)
			expect((await read(`probe/${name}`)).body).toMatchObject({ kind: "text", text: "HIDDEN-ONLY" });
		expect((await read(".git/config")).status).toBe(200);
		expect((await read("probe/innocent.txt")).body).toMatchObject({ text: "SECRET" });
		expect((await ask("raw", { path: "probe/id_rsa.png" })).status).toBe(200);
	});
});

describe("hostile files run nothing", () => {
	const HTML =
		'<!doctype html><html><body><script>window.__pwn = "html"</script><img src=x onerror="window.__pwn=1"></body></html>';
	beforeAll(() => {
		write("hostile/evil.md", `<script>window.__pwn = "md"</script>\n\n[x](javascript:window.__pwn=1)\n`);
		write(
			"hostile/evil.svg",
			'<svg xmlns="http://www.w3.org/2000/svg" onload="window.__pwn=1"><script>window.__pwn=1</script></svg>',
		);
		write("hostile/evil.png", HTML);
		write("hostile/evil.html", HTML);
	});
	afterAll(() => rmSync(join(proj, "hostile"), { recursive: true, force: true }));

	test("the image route serves only a raster picture, as an image, never to be sniffed into a page", async () => {
		// A page dressed as a picture is still served as a picture: the browser fails to draw it and shows nothing.
		const png = await ask("raw", { path: "hostile/evil.png" });
		expect(png.status).toBe(200);
		expect(png.headers.get("content-type")).toBe("image/png");
		expect(png.headers.get("x-content-type-options")).toBe("nosniff");
		expect(png.headers.get("content-disposition")).toBeNull();
		expect(await png.text()).toBe(HTML);
		// A drawing that can hold scripts, a text, a page: none of them is served by it, whatever they are called.
		for (const name of ["evil.svg", "evil.md", "evil.html"]) {
			const res = await ask("raw", { path: `hostile/${name}` });
			expect(res.status, name).toBe(415);
			expect(res.headers.get("content-type"), name).toBe("application/json");
			expect(await res.json(), name).toEqual({ error: "Not an image" });
		}
	});

	test("through the tunnel it is the same", async () => {
		const png = await remote.fetch(`/api/folder/raw?file=${encodeURIComponent(file)}&path=hostile/evil.png`);
		expect(png.headers.get("content-type")).toBe("image/png");
		expect(png.headers.get("x-content-type-options")).toBe("nosniff");
		for (const name of ["evil.svg", "evil.md", "evil.html"]) {
			const res = await remote.fetch(`/api/folder/raw?file=${encodeURIComponent(file)}&path=hostile/${name}`);
			expect(res.status, name).toBe(415);
		}
	});

	test("the document route serves a PDF or a Word file's bytes as an opaque download, never as a document to open (#697)", async () => {
		// A page dressed as a PDF: the page reads the bytes with `fetch`, and a browser sent to the address saves them.
		write("hostile/evil.pdf", HTML);
		write("hostile/evil.docx", HTML);
		for (const name of ["evil.pdf", "evil.docx"]) {
			const res = await ask("doc", { path: `hostile/${name}` });
			expect(res.status, name).toBe(200);
			expect(res.headers.get("content-type"), name).toBe("application/octet-stream");
			expect(res.headers.get("content-disposition"), name).toBe("attachment");
			expect(res.headers.get("x-content-type-options"), name).toBe("nosniff");
			expect(await res.text(), name).toBe(HTML);
			const tunnel = await remote.fetch(`/api/folder/doc?file=${encodeURIComponent(file)}&path=hostile/${name}`);
			expect(tunnel.status, name).toBe(200);
			expect(tunnel.headers.get("content-type"), name).toBe("application/octet-stream");
			expect(tunnel.headers.get("content-disposition"), name).toBe("attachment");
		}
		// Nothing else is served by it, whatever it is called or holds.
		for (const name of ["evil.svg", "evil.md", "evil.html", "evil.png"]) {
			const res = await ask("doc", { path: `hostile/${name}` });
			expect(res.status, name).toBe(415);
			expect(await res.json(), name).toEqual({ error: "Not a PDF or Word document" });
		}
		expect((await read("hostile/evil.pdf")).body).toMatchObject({ kind: "document", type: "pdf" });
		expect((await read("hostile/evil.docx")).body).toMatchObject({ kind: "document", type: "docx" });
	});

	test("the file route gives their text as JSON, which nothing renders on its own", async () => {
		for (const [name, view] of [
			["evil.md", "markdown"],
			["evil.svg", "svg"],
			["evil.html", "code"],
		] as const) {
			const res = await ask("file", { path: `hostile/${name}` });
			expect(res.headers.get("content-type"), name).toBe("application/json");
			expect(await res.json(), name).toMatchObject({ kind: "text", view });
		}
		expect((await read("hostile/evil.png")).body).toMatchObject({ kind: "image", mime: "image/png" });
	});
});

describe("watching", () => {
	type Change = { t: string; root: string };

	/**
	 * The next `folder_changed` the socket is sent, or null when none comes within `within` ms. Used to wait for one (the
	 * limit is only a bound) and, with a short limit, to see that none comes: an absence cannot be awaited, so that is a
	 * real wait, and the windows are as short as the server's debounce (250 ms) allows.
	 */
	function nextChange(ws: WebSocket, within: number): Promise<Change | null> {
		const { promise, resolve } = Promise.withResolvers<Change | null>();
		const timer = setTimeout(() => {
			ws.removeEventListener("message", on);
			resolve(null);
		}, within);
		function on(ev: MessageEvent) {
			const m = JSON.parse(String(ev.data));
			if (m.t !== "folder_changed") return;
			clearTimeout(timer);
			ws.removeEventListener("message", on);
			resolve(m);
		}
		ws.addEventListener("message", on);
		return promise;
	}

	let probes = 0;
	/**
	 * Say what the page has open, and wait until the server is watching it: the server does not acknowledge a watch, so a
	 * file is made in `probe` (one of `dirs`) until a change is heard.
	 */
	async function watching(ws: WebSocket, dirs: string[], probe: string): Promise<void> {
		ws.send(JSON.stringify({ t: "folder_watch", file, dirs }));
		for (let i = 0; i < 10; i++) {
			const heard = nextChange(ws, 1500);
			write(`${probe}/probe${++probes}.tmp`, "x");
			if (await heard) return;
		}
		throw new Error("the server did not watch what was asked");
	}

	/** No change comes within the debounce and some more. */
	const quiet = async (ws: WebSocket) => expect(await nextChange(ws, 700)).toBeNull();

	test("the folders a page has open are watched: a change in one tells it once, a change in another does not", async () => {
		const ws = await connect(s);
		try {
			await watching(ws, ["", "src"], "src");
			const first = nextChange(ws, 5000);
			write("src/created.ts", "x");
			expect(await first).toEqual({ t: "folder_changed", root: proj });
			// A burst of writes is one message.
			const burst = nextChange(ws, 5000);
			for (let i = 0; i < 5; i++) write(`src/burst${i}.ts`, "x");
			expect((await burst)?.t).toBe("folder_changed");
			await quiet(ws);
			// A folder that is not open says nothing.
			write("docs/quiet.md", "x");
			await quiet(ws);
			// Opened, it speaks.
			await watching(ws, ["docs"], "docs");
			// Closed (the tab was), nothing is watched.
			ws.send(JSON.stringify({ t: "folder_watch", dirs: [] }));
			write("docs/after.md", "x");
			await quiet(ws);
			write("docs/after2.md", "x");
			await quiet(ws);
		} finally {
			ws.close();
		}
	});

	test("what is not inside the folder, or not a conversation, is not watched", async () => {
		const ws = await connect(s);
		try {
			ws.send(JSON.stringify({ t: "folder_watch", file, dirs: ["../secret", "link-dir", "/etc"] }));
			write("../secret/new.txt", "x", proj);
			await quiet(ws);
			ws.send(JSON.stringify({ t: "folder_watch", file: "/etc/passwd", dirs: [""] }));
			write("src/other.ts", "x");
			await quiet(ws);
		} finally {
			ws.close();
		}
	});

	test("a page that goes away takes its watches with it, and the next page's work", async () => {
		const ws = await connect(s);
		await watching(ws, ["", "src", "docs"], "docs");
		ws.close();
		expect((await list()).status).toBe(200);
		const again = await connect(s);
		try {
			await watching(again, [""], "");
		} finally {
			again.close();
		}
	});
});
