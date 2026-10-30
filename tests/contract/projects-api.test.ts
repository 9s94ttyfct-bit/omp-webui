import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectCreated, ProjectsInfo } from "../../shared/projects.ts";
import { type AccessKey, AUD, EMAIL, HOSTNAME, type Jwks, makeKey, startJwks, TEAM } from "../support/access-jwt.ts";
import { type RemoteClient, remoteClient } from "../support/remote-client.ts";
import { startTestServer, type TestServer } from "../support/server.ts";

/**
 * `/api/projects` and `/api/projects/new` (#615) against the real server: the projects folder and "New project folder".
 * `~` and the default are the server's home (the test's own, never the real one). A page on this computer chooses the
 * folder and makes project folders; a page that came through the tunnel (or arrives with a proxy's headers) sees the
 * folder and makes project folders in it, and cannot move it.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-projects-http-"));
let s: TestServer;
let key: AccessKey;
let jwks: Jwks;
let remote: RemoteClient;

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
}, 60_000);
afterAll(async () => {
	await s?.stop();
	rmSync(root, { recursive: true, force: true });
});

const JSON_POST = { "x-omp-webui": "1", "content-type": "application/json" };
const here = () => ({ "x-omp-webui-token": s.accessToken });
const hereJson = () => ({ ...here(), ...JSON_POST });

async function info(): Promise<ProjectsInfo> {
	const res = await fetch(`${s.url}/api/projects`, { headers: here() });
	expect(res.status).toBe(200);
	return res.json();
}
const set = (folder: string | null, extra: Record<string, string> = {}) =>
	fetch(`${s.url}/api/projects`, {
		method: "POST",
		headers: { ...hereJson(), ...extra },
		body: JSON.stringify({ folder }),
	});
const make = (name: unknown, extra: Record<string, string> = {}) =>
	fetch(`${s.url}/api/projects/new`, {
		method: "POST",
		headers: { ...hereJson(), ...extra },
		body: JSON.stringify({ name }),
	});

test("nothing chosen is ~/omp, shown while it is not there, and made by the first project folder", async () => {
	const usual = join(s.home, "omp");
	expect(existsSync(usual)).toBe(false);
	expect(await info()).toEqual({ folder: usual, isDefault: true, exists: true });
	// Looking made nothing.
	expect(existsSync(usual)).toBe(false);
	const res = await make("first");
	expect(res.status).toBe(200);
	const made = (await res.json()) as ProjectCreated;
	expect(made.path).toBe(join(usual, "first"));
	expect(existsSync(made.path)).toBe(true);
	expect(made.info.folder).toBe(usual);
	expect(await info()).toEqual({ folder: usual, isDefault: true, exists: true });
});

test("a name that is taken, or that is a path, is a coded 4xx that changes nothing", async () => {
	const before = readdirSync(s.home).sort();
	const inside = readdirSync(join(s.home, "omp")).sort();
	const taken = await make("first");
	expect(taken.status).toBe(409);
	expect(await taken.json()).toMatchObject({ problem: "exists" });
	for (const [name, problem] of [
		["../escape", "separator"],
		["a/b", "separator"],
		["..", "dot"],
		[".hidden", "dot"],
		["", "empty"],
		["x".repeat(101), "tooLong"],
		[42, "invalid"],
	] as const) {
		const res = await make(name);
		expect(res.status, JSON.stringify(name)).toBe(400);
		expect(await res.json(), JSON.stringify(name)).toMatchObject({ problem });
	}
	expect(readdirSync(s.home).sort()).toEqual(before);
	expect(readdirSync(join(s.home, "omp")).sort()).toEqual(inside);
});

test("the projects folder is chosen by the page on this computer, `~` is the server's home, and null is the default", async () => {
	mkdirSync(join(s.home, "work"));
	const chosen = await set("~/work");
	expect(chosen.status).toBe(200);
	expect(await chosen.json()).toEqual({ folder: join(s.home, "work"), isDefault: false, exists: true });
	expect(JSON.parse(readFileSync(join(s.root, "data", "projects-folder.json"), "utf8"))).toEqual({
		folder: join(s.home, "work"),
	});
	expect(((await (await make("second")).json()) as ProjectCreated).path).toBe(join(s.home, "work", "second"));
	expect(await (await set(null)).json()).toEqual({ folder: join(s.home, "omp"), isDefault: true, exists: true });
});

test("a folder that cannot be the projects folder is refused with the folder picker's codes, and the setting stays", async () => {
	await set("~/work");
	for (const [path, status, code] of [
		["relative", 400, "dirRelative"],
		["~/missing", 404, "dirNotFound"],
	] as const) {
		const res = await set(path);
		expect(res.status, path).toBe(status);
		expect(await res.json(), path).toMatchObject({ code });
	}
	const notFolder = await set(join(s.agentDir, "config.yml"));
	expect([400, 404]).toContain(notFolder.status);
	const shape = await set(7 as unknown as string);
	expect(shape.status).toBe(400);
	expect(await shape.json()).toMatchObject({ code: "projectsFolderShape" });
	expect((await info()).folder).toBe(join(s.home, "work"));
});

test("this computer's page is `local` in meta, and the tunnel's and a proxied request are not", async () => {
	const own = await fetch(`${s.url}/api/meta`, { headers: here() });
	expect(await own.json()).toMatchObject({ local: true, remote: false });
	const tunnel = await remote.fetch("/api/meta");
	expect(await tunnel.json()).toMatchObject({ local: false, remote: true });
	const proxied = await fetch(`${s.url}/api/meta`, { headers: { ...here(), "x-forwarded-for": "203.0.113.9" } });
	// Not this computer's, so a remote page's: the app shows it what a remote page is shown, and the server refuses it what
	// is for this computer alone (#621; a page on the network is told the same, see `lan-local.test.ts`).
	expect(await proxied.json()).toMatchObject({ local: false, remote: true });
});

test("a page that came through the tunnel sees the folder and makes project folders in it, and cannot move it", async () => {
	const seen = await remote.fetch("/api/projects");
	expect(seen.status).toBe(200);
	expect(((await seen.json()) as ProjectsInfo).folder).toBe(join(s.home, "work"));

	const moved = await remote.fetch(
		"/api/projects",
		{ method: "POST", headers: JSON_POST },
		JSON.stringify({ folder: s.home }),
	);
	expect(moved.status).toBe(403);
	// Coded, so that a page in Chinese words it.
	expect(await moved.json()).toMatchObject({ code: "projectsNotHere" });
	expect((await info()).folder).toBe(join(s.home, "work"));

	const made = await remote.fetch(
		"/api/projects/new",
		{ method: "POST", headers: JSON_POST },
		JSON.stringify({ name: "from-the-phone" }),
	);
	expect(made.status).toBe(200);
	expect(((await made.json()) as ProjectCreated).path).toBe(join(s.home, "work", "from-the-phone"));
	// The same rules: a path out is refused for it as for anyone.
	const out = await remote.fetch(
		"/api/projects/new",
		{ method: "POST", headers: JSON_POST },
		JSON.stringify({ name: "../../escape" }),
	);
	expect(out.status).toBe(400);
	expect(existsSync(join(s.home, "escape"))).toBe(false);
});

test("a request that carries what a proxy adds is not this computer's: it cannot move the folder either", async () => {
	for (const header of ["cf-ray", "x-forwarded-for", "forwarded", "via"]) {
		const res = await set(s.home, { [header]: "203.0.113.9" });
		expect(res.status, header).toBe(403);
		expect(await res.json(), header).toMatchObject({ code: "projectsNotHere" });
	}
	expect((await info()).folder).toBe(join(s.home, "work"));
});

test("the projects folder is a POST with the page's own header, like every change", async () => {
	const noCsrf = await fetch(`${s.url}/api/projects/new`, {
		method: "POST",
		headers: { ...here(), "content-type": "application/json" },
		body: JSON.stringify({ name: "nocsrf" }),
	});
	expect(noCsrf.status).toBe(403);
	expect(existsSync(join(s.home, "work", "nocsrf"))).toBe(false);
});
