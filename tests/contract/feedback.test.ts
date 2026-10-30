import { afterAll, beforeAll, expect, test } from "bun:test";
import { userInfo } from "node:os";
import { startTestServer, type TestServer } from "../support/server.ts";

/** `/api/diagnostics` (for a bug report) and `/api/repo` (the star prompt's gate), against a stand-in for GitHub's API. */

let github: ReturnType<typeof Bun.serve>;
let s: TestServer;
const asked: { path: string; auth: string | null }[] = [];
let isPublic = false;
let down = false;

beforeAll(async () => {
	github = Bun.serve({
		port: 0,
		fetch(req) {
			asked.push({ path: new URL(req.url).pathname, auth: req.headers.get("authorization") });
			if (down) return new Response("unavailable", { status: 503 });
			return isPublic ? Response.json({ private: false }) : new Response("Not Found", { status: 404 });
		},
	});
	s = await startTestServer(0, { OMP_WEBUI_GITHUB_API: `http://127.0.0.1:${github.port}` });
}, 60_000);
afterAll(async () => {
	await s?.stop();
	github?.stop(true);
});

const get = (path: string) =>
	fetch(`${s.url}${path}`, { headers: { "x-omp-webui-token": s.accessToken, Origin: s.url } });

test("/api/meta names the OS user, for the report to leave out", async () => {
	const m: { user: string; home: string } = await (await get("/api/meta")).json();
	expect(typeof m.user).toBe("string");
	expect(m.user).toBe(userInfo().username);
});

test("/api/diagnostics names the machine and the mode", async () => {
	const r = await get("/api/diagnostics");
	expect(r.status).toBe(200);
	const d: { os: string; mode: string } = await r.json();
	expect(d.os).toMatch(/^(macOS \d+(\.\d+)*|\w+ \S+) \(\w+\)$/);
	expect(d.mode).toBe("full");
});

test("/api/repo is false while GitHub hides the repository, asked anonymously, and the answer is kept", async () => {
	const r = await get("/api/repo");
	expect(r.status).toBe(200);
	expect(await r.json()).toEqual({ public: false });
	expect(asked).toEqual([{ path: "/repos/9s94ttyfct-bit/omp-webui", auth: null }]);
	// Public from now on, but the day's answer stands.
	isPublic = true;
	expect(await (await get("/api/repo")).json()).toEqual({ public: false });
	expect(asked).toHaveLength(1);
});

test("/api/repo is true once GitHub shows the repository (a fresh server asks again)", async () => {
	await s.restart();
	expect(await (await get("/api/repo")).json()).toEqual({ public: true });
	expect(asked).toHaveLength(2);
});

test("/api/repo is null, not false, when GitHub cannot be asked, so the page asks again later", async () => {
	down = true;
	await s.restart();
	expect(await (await get("/api/repo")).json()).toEqual({ public: null });
});
