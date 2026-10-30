import { afterAll, beforeAll, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestServer, type TestServer } from "../support/server.ts";
import { connect, request } from "../support/ws.ts";

/** What a hostile or broken client can do to the server: it must answer, and keep answering. */

const root = mkdtempSync(join(tmpdir(), "ompw-hardening-"));
const dist = join(root, "dist");
mkdirSync(dist);
writeFileSync(
	join(dist, "index.html"),
	'<!doctype html>\n<html><head></head><body><div id="root"></div></body></html>\n',
);
/** A dist whose index.html cannot be read: serving the page fails inside the server. */
const broken = join(root, "broken");
mkdirSync(join(broken, "index.html"), { recursive: true });

let s: TestServer;
let failing: TestServer;
beforeAll(async () => {
	s = await startTestServer(0, { OMP_WEBUI_DIST: dist });
	failing = await startTestServer(0, { OMP_WEBUI_DIST: broken });
}, 60_000);
afterAll(async () => {
	await s?.stop();
	await failing?.stop();
	rmSync(root, { recursive: true, force: true });
});

const authed = () => ({ "x-omp-webui-token": s.accessToken });
const meta = () => fetch(`${s.url}/api/meta`, { headers: authed() });

test("a WebSocket frame that is valid JSON but no message is ignored: the server and the connection carry on", async () => {
	const ws = await connect(s);
	try {
		// `null` used to end the whole server: every conversation in it, and the macOS app with it.
		for (const frame of [
			"null",
			"42",
			'"open"',
			"true",
			"[]",
			"[null]",
			"{}",
			'{"t":null}',
			'{"req":null}',
			"not json",
		]) {
			ws.send(frame);
		}
		// A request with a malformed field is answered with an error, not dropped.
		await expect(request(ws, { t: "attach", liveId: null })).rejects.toThrow("Live session not found");
		// The same connection still works, and so does the HTTP side.
		expect(await request<unknown[]>(ws, { t: "list_lives" })).toEqual([]);
		expect((await meta()).status).toBe(200);
	} finally {
		ws.close();
	}
	// A new connection is served too.
	const again = await connect(s);
	expect(await request<unknown[]>(again, { t: "list_lives" })).toEqual([]);
	again.close();
});

/** The status of `path` for a request that carries only this `Cookie` header. */
const withCookie = (path: string, cookie: string, server: TestServer = s) =>
	fetch(`${server.url}${path}`, { headers: { cookie } });

function socketWith(cookie: string, extra: Record<string, string> = {}): Promise<"open" | "refused"> {
	const ws = new WebSocket(`${s.url.replace("http", "ws")}/ws`, {
		headers: { Origin: s.url, Cookie: cookie, ...extra },
	} as unknown as string[]);
	return new Promise((resolve) => {
		ws.onopen = () => {
			ws.close();
			resolve("open");
		};
		ws.onerror = () => resolve("refused");
	});
}

test("a malformed ompw_token cookie is a plain 401, not an error page with the working directory in it", async () => {
	for (const path of ["/api/meta", "/api/sessions", "/"]) {
		const res = await withCookie(path, "ompw_token=%E0%A4%A");
		const body = await res.text();
		expect(res.status, path).toBe(path === "/" ? 200 : 401);
		expect(body, path).not.toContain("<pre");
		expect(body, path).not.toContain(process.cwd());
		expect(body, path).not.toContain(".ts:");
	}
	const refused = await withCookie("/api/meta", "ompw_token=%E0%A4%A");
	expect(refused.headers.get("content-type")).toContain("json");
	expect(await socketWith("ompw_token=%E0%A4%A")).toBe("refused");
});

test("any ompw_token cookie that matches is accepted, wherever it stands among others", async () => {
	const good = encodeURIComponent(s.accessToken);
	for (const cookie of [
		`ompw_token=bad; ompw_token=${good}`,
		`ompw_token=${good}; ompw_token=bad`,
		`ompw_token=%E0%A4%A; ompw_token=${good}`,
		`other=1; ompw_token=; ompw_token=${good}; ompw_token=%E0`,
	]) {
		expect((await withCookie("/api/meta", cookie)).status, cookie).toBe(200);
		expect(await socketWith(cookie), cookie).toBe("open");
	}
	// Two wrong ones are still no token.
	expect((await withCookie("/api/meta", "ompw_token=bad; ompw_token=worse")).status).toBe(401);
	expect((await withCookie("/api/meta", `xompw_token=${good}`)).status).toBe(401);
});

test("an error inside the server is a plain 500 without its message or paths, whoever asks", async () => {
	const res = await withCookie("/", `ompw_token=${failing.accessToken}`, failing);
	const body = await res.text();
	expect(res.status).toBe(500);
	expect(res.headers.get("content-type")).toContain("json");
	expect(JSON.parse(body)).toEqual({ error: "Internal server error" });
	expect(body).not.toContain("EISDIR");
	expect(body).not.toContain(root);
	// And it is still up.
	expect(
		(await fetch(`${failing.url}/api/meta`, { headers: { "x-omp-webui-token": failing.accessToken } })).status,
	).toBe(200);
});

/** Every path under `dir` (links and sockets aside) that group or others can reach. */
function reachable(dir: string): string[] {
	const found: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		const info = lstatSync(path);
		if (info.isSymbolicLink() || info.isSocket()) continue;
		if (info.mode & 0o077) found.push(`${path} ${(info.mode & 0o777).toString(8)}`);
		if (info.isDirectory()) found.push(...reachable(path));
	}
	return found;
}

test("the data dir is 0700 and everything the server keeps in it is 0600 or 0700, after start and after writes", async () => {
	const data = join(s.root, "data");
	const post = (path: string, body: unknown) =>
		fetch(`${s.url}${path}`, {
			method: "POST",
			headers: { ...authed(), "x-omp-webui": "1", "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	expect(statSync(data).mode & 0o777).toBe(0o700);
	// The index is there from the start, with the journal files SQLite keeps beside it.
	for (const name of ["index.db", "index.db-wal", "index.db-shm", "ui-prefs.json", "server.pid"]) {
		expect(statSync(join(data, name)).mode & 0o777, name).toBe(0o600);
	}

	// Every store the page writes.
	expect((await post("/api/archive", { files: [s.fixtures.beta], archived: true })).status).toBe(200);
	expect((await post("/api/favorite-models", { model: "anthropic/claude-haiku-5-5", on: true })).status).toBe(200);
	expect((await post("/api/approval", { mode: "write" })).status).toBe(200);
	expect((await post("/api/prefs", { changes: { "ompw.theme": "dark" } })).status).toBe(200);
	// The model guidance templates (#641): a change of them is a file in the data dir like any other store's.
	expect(
		(
			await post("/api/model-guidance", {
				template: { id: "hardening-template", name: "Hardening", text: "One at a time." },
			})
		).status,
	).toBe(200);
	// Unattended mode (#646): what the person set is a file in the data dir like any other store's (the questions the agents
	// file are checked against a real conversation, in `unattended-answer.test.ts`).
	expect((await post("/api/unattended", { instruction: "Hardening: file everything." })).status).toBe(200);
	await fetch(`${s.url}/api/search?q=fixture`, { headers: authed() });
	for (const name of [
		"archived.json",
		"favorite-models.json",
		"approval.json",
		"ui-prefs.json",
		"model-guidance.json",
		"unattended.json",
	]) {
		expect(statSync(join(data, name)).mode & 0o777, name).toBe(0o600);
	}
	expect(reachable(data)).toEqual([]);
});

const siteHeader = (site: string) => ({ ...authed(), "sec-fetch-site": site });

test("the API and the socket refuse a page of another port or site, token or not; the page's own origin and non-browsers are served", async () => {
	for (const site of ["same-site", "cross-site"]) {
		// A no-cors GET from a page on another localhost port: no Origin, the cookie rides along.
		for (const path of ["/api/meta", "/api/sessions", "/api/stats", "/api/offline/models"]) {
			const res = await fetch(`${s.url}${path}`, { headers: siteHeader(site) });
			expect(res.status, `${site} ${path}`).toBe(403);
		}
		const post = await fetch(`${s.url}/api/pins`, {
			method: "POST",
			headers: { ...siteHeader(site), "x-omp-webui": "1", "content-type": "application/json" },
			body: JSON.stringify({ file: s.fixtures.gamma, pinned: true }),
		});
		expect(post.status, site).toBe(403);
		const cookie = await fetch(`${s.url}/api/meta`, {
			headers: { cookie: `ompw_token=${s.accessToken}`, "sec-fetch-site": site },
		});
		expect(cookie.status, `cookie ${site}`).toBe(403);
		expect(await socketWith(`ompw_token=${s.accessToken}`, { "Sec-Fetch-Site": site }), `socket ${site}`).toBe(
			"refused",
		);
		// The token cannot be exchanged for a cookie from there either.
		const auth = await fetch(`${s.url}/api/auth`, {
			method: "POST",
			headers: { "sec-fetch-site": site, "x-omp-webui": "1", "content-type": "application/json" },
			body: JSON.stringify({ token: s.accessToken }),
		});
		expect(auth.status, `auth ${site}`).toBe(403);
		expect(auth.headers.get("set-cookie")).toBeNull();
	}
	// Nothing was pinned by the refused request.
	expect(await (await fetch(`${s.url}/api/pins`, { headers: authed() })).json()).not.toContain(s.fixtures.gamma);

	for (const site of ["same-origin", "none"]) {
		expect((await fetch(`${s.url}/api/meta`, { headers: siteHeader(site) })).status, site).toBe(200);
		expect(await socketWith(`ompw_token=${s.accessToken}`, { "Sec-Fetch-Site": site }), `socket ${site}`).toBe("open");
	}
	// No header at all: the macOS shell, curl, a test.
	expect((await meta()).status).toBe(200);

	// The page and the token link are no API: a link from another site must still open them.
	const page = await fetch(`${s.url}/`, { headers: { "sec-fetch-site": "cross-site" } });
	expect(page.status).toBe(200);
	const link = await fetch(`${s.url}/?token=${encodeURIComponent(s.accessToken)}`, {
		redirect: "manual",
		headers: { "sec-fetch-site": "cross-site" },
	});
	expect(link.status).toBe(303);
	expect(link.headers.get("set-cookie")).toContain("ompw_token=");
});

test("what starts work of its own is a POST: a GET of it is refused, and a POST needs the CSRF header", async () => {
	const work = encodeURIComponent(s.work);
	for (const path of [
		"/api/stats?force=1",
		"/api/usage?provider=anthropic&force=1",
		"/api/models?force=1",
		`/api/git?cwd=${work}&pr=1`,
		`/api/git?cwd=${work}&fresh=1`,
		`/api/git?cwd=${work}&pr=1&fresh=1`,
		"/api/offline/context",
		"/api/offline/context?force=1",
	]) {
		const res = await fetch(`${s.url}${path}`, { headers: authed() });
		expect(res.status, `GET ${path}`).toBe(405);
		expect(await res.json()).toEqual({ error: "POST required" });
		// Without the header a browser would not have preflighted it: nothing starts.
		const bare = await fetch(`${s.url}${path}`, { method: "POST", headers: authed() });
		expect(bare.status, `POST ${path} without header`).toBe(403);
	}
	// The plain reads are still reads.
	expect((await fetch(`${s.url}/api/git?cwd=${work}`, { headers: authed() })).status).toBe(200);
	const withHeader = { ...authed(), "x-omp-webui": "1" };
	const git = await fetch(`${s.url}/api/git?cwd=${work}&pr=1&fresh=1`, { method: "POST", headers: withHeader });
	expect(git.status).toBe(200);
	expect(await git.json()).toEqual({ git: null, pr: null });
	const usage = await fetch(`${s.url}/api/usage?provider=anthropic&force=1`, { method: "POST", headers: withHeader });
	expect(usage.status).toBe(200);
	expect(Array.isArray(await usage.json())).toBe(true);
});
