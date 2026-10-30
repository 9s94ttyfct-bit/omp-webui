import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "../support/server.ts";

/** `GET /api/dirs` as the folder picker asks it: `~` is the server's home, mistakes get a short coded answer (#438). */

let s: TestServer;
beforeAll(async () => {
	s = await startTestServer();
}, 60_000);
afterAll(async () => {
	await s?.stop();
});

const dirs = async (path: string) => {
	const res = await fetch(`${s.url}/api/dirs?path=${encodeURIComponent(path)}`, {
		headers: { "x-omp-webui-token": s.accessToken },
	});
	return { status: res.status, body: await res.json() };
};

test("`~` is the home folder of the server, and a link to a folder is a folder", async () => {
	mkdirSync(join(s.home, "proj", "inner"), { recursive: true });
	symlinkSync(join(s.home, "proj"), join(s.home, "linked"));
	const home = await dirs("~");
	expect(home.status).toBe(200);
	expect(home.body.path).toBe(s.home);
	expect(home.body.dirs).toContain("proj");
	expect(home.body.dirs).toContain("linked");
	expect(home.body.omitted).toBe(0);
	expect((await dirs("~/linked")).body.dirs).toEqual(["inner"]);
});

test("a path that cannot be listed is a short coded answer, not the system's error with the server's folder", async () => {
	const missing = await dirs("~/nowhere");
	expect(missing.status).toBe(404);
	expect(missing.body).toEqual({
		error: `${join(s.home, "nowhere")} does not exist`,
		code: "dirNotFound",
		params: { path: join(s.home, "nowhere") },
	});
	const relative = await dirs("projects/x");
	expect(relative.status).toBe(400);
	expect(relative.body).toMatchObject({ code: "dirRelative", params: { path: "projects/x" } });
	const file = await dirs(join(s.agentDir, "config.yml"));
	expect(file.status).toBe(400);
	expect(file.body.code).toBe("dirNotFolder");
});
