import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AccessKey,
	AUD,
	claims,
	EMAIL,
	HOSTNAME,
	type Jwks,
	makeKey,
	sign,
	startJwks,
	TEAM,
} from "../support/access-jwt.ts";
import { startTestServer, type TestServer } from "../support/server.ts";

/**
 * The lazy remote chain against the real server: a server that starts with remote access off has loaded none of it,
 * and the first request that comes through the public hostname is verified (not let in) as soon as the settings turn
 * remote access on. Turning it off again closes the door at once.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-remote-lazy-"));
const settingsFile = join(root, "remote.json");
const dist = join(root, "dist");
const GOOD = { enabled: true, hostname: HOSTNAME, team: TEAM, aud: AUD, emails: [EMAIL] };
let key: AccessKey;
let jwks: Jwks;
let s: TestServer;

const now = () => Math.floor(Date.now() / 1000);
/** The settings as they are written to the file. */
const setSettings = (over: Record<string, unknown> = {}) =>
	writeFileSync(settingsFile, JSON.stringify({ ...GOOD, ...over }));

beforeAll(async () => {
	key = await makeKey("kid-1");
	jwks = await startJwks([key]);
	mkdirSync(join(dist, "assets"), { recursive: true });
	writeFileSync(
		join(dist, "index.html"),
		'<!doctype html>\n<html><head></head><body><div id="root"></div></body></html>\n',
	);
	// No settings file at all: the server starts with remote access off, and loads none of its chain.
	s = await startTestServer(
		0,
		{
			OMP_WEBUI_REMOTE_CONFIG: settingsFile,
			OMP_WEBUI_ACCESS_CERTS_URL: jwks.url,
			OMP_WEBUI_DIST: dist,
		},
		{ login: false },
	);
}, 60_000);

afterAll(async () => {
	await s?.stop();
	jwks?.stop();
	rmSync(root, { recursive: true, force: true });
});

/** A request the way the tunnel carries it: the public hostname as Host, the Access token in a header. */
async function viaTunnel(path: string, jwt?: string | null): Promise<Response> {
	const headers: Record<string, string> = {
		host: HOSTNAME,
		origin: `https://${HOSTNAME}`,
		cookie: `ompw_token=${s.accessToken}`,
	};
	const token = jwt === undefined ? await sign(key, claims(now())) : jwt;
	if (token) headers["cf-access-jwt-assertion"] = token;
	return fetch(`${s.url}${path}`, { headers, redirect: "manual" });
}

/** A request from the person at this computer. */
const local = (path: string) => fetch(`${s.url}${path}`, { headers: { "x-omp-webui-token": s.accessToken } });

describe("a server started with remote access off", () => {
	test("serves the person at this computer, and nobody on the public hostname", async () => {
		expect((await local("/api/meta")).status).toBe(200);
		expect((await viaTunnel("/api/meta")).status).toBe(403);
	});
});

describe("remote access turned on after the server started", () => {
	test("the first request through the public hostname is verified: no token and a bad one are refused, a good one is served", async () => {
		// The settings are written while the server runs: nobody restarts it, and the chain is not loaded yet.
		setSettings();

		// The first request through the public hostname: it must be verified, not let in.
		expect((await viaTunnel("/api/meta", null)).status).toBe(403);
		expect((await viaTunnel("/api/meta", "not.a.jwt")).status).toBe(403);

		// The same request with a valid Access token is served, and the answer says the page is remote.
		const good = await viaTunnel("/api/meta");
		expect(good.status).toBe(200);
		expect((await good.json()).remote).toBe(true);
	});

	test("the person at this computer is served as before", async () => {
		expect((await local("/api/meta")).status).toBe(200);
	});
});

describe("remote access turned off again", () => {
	test("the public hostname is refused at once, and stays refused", async () => {
		setSettings({ enabled: false });
		expect((await viaTunnel("/api/meta")).status).toBe(403);
		expect((await local("/api/meta")).status).toBe(200);
	});
});
