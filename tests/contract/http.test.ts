import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { MAX_WS_MESSAGE_BYTES } from "../../shared/protocol.ts";
import { hostEnv, isolatedEnv } from "../support/omp-env.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { serverTmp } from "../support/tmp.ts";
import { connect, request } from "../support/ws.ts";

/** The server's HTTP and WebSocket surface against the real server (and real omp, no model calls). */

const root = mkdtempSync(join(tmpdir(), "ompw-http-"));
const dist = join(root, "dist");
const index = join(dist, "index.html");
let s: TestServer;

const THEME_SCRIPT = "document.documentElement.dataset.theme = 'dark';";
const page = (inline: string) =>
	`<!doctype html>\n<html>\n<head>\n<script>${inline}</script>\n<script type="module" src="/assets/app-abc123.js"></script>\n</head>\n<body><div id="root"></div></body>\n</html>\n`;
const sha256 = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
const authed = { "x-omp-webui-token": "" };

beforeAll(async () => {
	mkdirSync(join(dist, "assets"), { recursive: true });
	writeFileSync(index, page(THEME_SCRIPT));
	writeFileSync(join(dist, "assets", "app-abc123.js"), "export {};\n");
	// The server serves this instead of the repository's build.
	s = await startTestServer(0, { OMP_WEBUI_DIST: dist });
	authed["x-omp-webui-token"] = s.accessToken;
}, 60_000);

afterAll(async () => {
	await s?.stop();
	rmSync(root, { recursive: true, force: true });
});

/** One directive of a Content-Security-Policy header, e.g. `img-src 'self' data:`. */
function directive(csp: string | null, name: string): string | undefined {
	return csp
		?.split(";")
		.map((d) => d.trim())
		.find((d) => d.startsWith(`${name} `));
}

test("a missing /assets/ file is a 404, not the app's index.html; app routes still get the app", async () => {
	const missing = await fetch(`${s.url}/assets/Settings-deadbeef.js`);
	expect(missing.status).toBe(404);
	expect(missing.headers.get("content-type") ?? "").not.toContain("html");
	expect(await missing.text()).not.toContain('id="root"');

	const present = await fetch(`${s.url}/assets/app-abc123.js`);
	expect(present.status).toBe(200);
	expect(await present.text()).toBe("export {};\n");

	const route = await fetch(`${s.url}/some/route`);
	expect(route.status).toBe(200);
	expect(await route.text()).toContain('id="root"');
});

test("every response carries a CSP that confines images and connections to the page's own origin", async () => {
	const csp = (await fetch(`${s.url}/`)).headers.get("content-security-policy");
	expect(directive(csp, "img-src")).toBe("img-src 'self' data: blob:");
	expect(directive(csp, "connect-src")).toBe(
		`connect-src 'self' ${s.url.replace("http:", "ws:")} ${s.url.replace("http:", "wss:")}`,
	);
	expect(directive(csp, "default-src")).toBe("default-src 'self'");
	// Scripts: the page's own and the hash of its inline script, never any inline script.
	expect(directive(csp, "script-src")).toContain(sha256(THEME_SCRIPT));
	expect(directive(csp, "script-src")).not.toContain("'unsafe-inline'");

	for (const path of ["/api/meta", "/api/missing", "/assets/app-abc123.js", "/assets/missing.js"]) {
		const res = await fetch(`${s.url}${path}`, { headers: authed });
		expect(directive(res.headers.get("content-security-policy"), "img-src")).toBe("img-src 'self' data: blob:");
	}
	const refused = await fetch(`${s.url}/api/meta`);
	expect(refused.status).toBe(401);
	expect(directive(refused.headers.get("content-security-policy"), "img-src")).toBe("img-src 'self' data: blob:");
});

test("the CSP allows exactly the inline scripts of the index.html being served, also after a rebuild", async () => {
	const edited = "document.documentElement.classList.toggle('dark', true);";
	writeFileSync(index, page(edited));
	// A rebuild writes a new file; make sure its modification time differs from the old one's.
	const later = Date.now() / 1000 + 5;
	utimesSync(index, later, later);

	const csp = (await fetch(`${s.url}/`)).headers.get("content-security-policy");
	expect(directive(csp, "script-src")).toContain(sha256(edited));
	expect(directive(csp, "script-src")).not.toContain(sha256(THEME_SCRIPT));
});

test("the WebSocket takes messages up to 32 MiB; a prompt with large images is not Bun's 16 MiB default", async () => {
	expect(MAX_WS_MESSAGE_BYTES).toBe(32 * 1024 * 1024);
	const ws = await connect(s);
	const closed = Promise.withResolvers<number>();
	ws.addEventListener("close", (ev) => closed.resolve(ev.code));

	// About 20 MiB: over the default, under the limit. The session does not exist, so omp is never involved.
	const prompt = { type: "prompt", message: "x".repeat(20 * 1024 * 1024) };
	const answered = request(ws, { t: "rpc", liveId: "none", command: prompt }).catch((e: Error) => e.message);
	expect(await Promise.race([answered, closed.promise.then((code) => `socket closed (${code})`)])).toBe(
		"Live session not found",
	);
	await expect(request(ws, { t: "list_lives" })).resolves.toEqual([]);

	// Over the limit the server drops the socket: 1009 (message too big), or 1006 when the client sees the
	// connection go while it is still sending.
	ws.send(
		JSON.stringify({ t: "rpc", liveId: "none", req: "r", command: { type: "x", pad: "x".repeat(33 * 1024 * 1024) } }),
	);
	expect([1006, 1009]).toContain(await closed.promise);
}, 60_000);

test("concurrent exports each return their own session, and nothing is left on disk", async () => {
	const files = Object.values(s.fixtures);
	const responses = await Promise.all(
		files.map((file) =>
			fetch(`${s.url}/api/export?file=${encodeURIComponent(file)}`, {
				method: "POST",
				headers: { ...authed, "x-omp-webui": "1" },
			}),
		),
	);

	for (const [i, res] of responses.entries()) {
		expect(res.status).toBe(200);
		expect(res.headers.get("content-disposition")).toBe(
			`attachment; filename="omp-session-${basename(files[i], ".jsonl")}.html"`,
		);
		expect(await res.text()).toContain("<html");
	}
	// The HTML holds the whole transcript: no export may outlive its request.
	expect(readdirSync(join(s.root, "data", "exports"))).toEqual([]);
}, 60_000);

test("an export folder left by earlier versions or a crash is cleaned up by the next export", async () => {
	const exports = join(s.root, "data", "exports");
	const legacy = join(exports, "omp-session-old.html");
	const crashed = join(exports, "export-crashed");
	writeFileSync(legacy, "<html>old</html>");
	mkdirSync(crashed);
	writeFileSync(join(crashed, "half.html"), "<html>half</html>");
	const longAgo = Date.now() / 1000 - 2 * 3600;
	utimesSync(crashed, longAgo, longAgo);

	const res = await fetch(`${s.url}/api/export?file=${encodeURIComponent(s.fixtures.alpha)}`, {
		method: "POST",
		headers: { ...authed, "x-omp-webui": "1" },
	});
	expect(res.status).toBe(200);
	expect(readdirSync(exports)).toEqual([]);
}, 60_000);

test("/api/search answers an array, narrows to one conversation with `file`, and 404s an unknown file", async () => {
	const get = (query: string) => fetch(`${s.url}/api/search?${query}`, { headers: authed });
	const all = await get("q=zebra&limit=nope");
	expect(all.status).toBe(200);
	const hits = (await all.json()) as { file: string }[];
	expect(hits.length).toBeGreaterThan(0);

	// Hits carry the server's canonical path (the fixture dir may sit behind a symlink, e.g. /var on macOS).
	const canonical = hits[0].file;
	const scoped = await get(`q=zebra&file=${encodeURIComponent(canonical)}`);
	expect(scoped.status).toBe(200);
	const inFile = (await scoped.json()) as { file: string }[];
	expect(inFile.length).toBeGreaterThan(0);
	expect(inFile.every((h) => h.file === canonical)).toBe(true);

	expect((await get(`q=zebra&file=${encodeURIComponent("/etc/hostname")}`)).status).toBe(404);
});

test("a token file with no token in it does not switch authentication off", async () => {
	const dir = mkdtempSync(join(root, "blank-token-"));
	writeFileSync(join(dir, "token"), "\n");
	const env = await isolatedEnv(join(root, "blank-token-home"));
	const proc = Bun.spawn(["bun", join(import.meta.dir, "../../server/main.ts")], {
		env: {
			...hostEnv(),
			...env,
			// The temp dir of this server: one of its own, so that the server of another data dir (another test file
			// running in parallel) never sweeps the overlay directories of this one's dead servers (#461).
			TMPDIR: serverTmp(env.TMPDIR, dir),
			OMP_WEBUI_DATA_DIR: dir,
			OMP_WEBUI_PORT: "0",
			OMP_WEBUI_TOKEN: "",
			OMP_WEBUI_AUTH: "",
		},
		stdout: "pipe",
		stderr: "inherit",
	});
	try {
		// The startup banner names the link to open: wait for it.
		const reader = proc.stdout.getReader();
		let banner = "";
		while (!banner.includes("Open: ") && !banner.includes("Authentication disabled")) {
			const { value, done } = await reader.read();
			if (done) throw new Error(`server exited before it was ready: ${banner}`);
			banner += new TextDecoder().decode(value);
		}
		reader.releaseLock();

		const token = /\?token=(\S+)/.exec(banner)?.[1];
		const origin = /Open: (http:\/\/[^/\s]+)\//.exec(banner)?.[1];
		expect(origin).toBeDefined();
		expect(banner).not.toContain("Authentication disabled");
		expect(token?.length).toBeGreaterThanOrEqual(24);
		expect(await Bun.file(join(dir, "token")).text()).toBe(token as string);

		expect((await fetch(`${origin}/api/meta`)).status).toBe(401);
		expect((await fetch(`${origin}/api/meta`, { headers: { "x-omp-webui-token": "" } })).status).toBe(401);
		expect((await fetch(`${origin}/api/meta`, { headers: { "x-omp-webui-token": token as string } })).status).toBe(200);
	} finally {
		proc.kill("SIGTERM");
		await proc.exited;
	}
}, 60_000);
