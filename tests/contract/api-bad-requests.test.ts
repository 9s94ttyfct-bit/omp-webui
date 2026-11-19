import { afterAll, beforeAll, expect, test } from "bun:test";
import { startTestServer, type TestServer } from "../support/server.ts";

/**
 * A request that cannot be read is a 400, never a 500 with the parser's words (#245): a body that is not JSON, one that is
 * `null`, an array or a string, and a command name that is none. A real failure inside a route is logged (method and path,
 * not the query) and a page that is not the person's own is not given its words.
 */

let s: TestServer;
beforeAll(async () => {
	s = await startTestServer(0, {}, { login: false });
}, 120_000);
afterAll(async () => {
	await s?.stop();
});

const post = (path: string, body: string): Promise<Response> =>
	fetch(`${s.url}${path}`, {
		method: "POST",
		headers: { "x-omp-webui-token": s.accessToken, "x-omp-webui": "1", "content-type": "application/json" },
		body,
	});

const ROUTES = [
	"/api/pins",
	"/api/favorite-models",
	"/api/approval",
	"/api/usage-reset-wait",
	"/api/usage-reset-wait/session",
	"/api/session/delete-preview",
	"/api/session/rename",
	"/api/session/delete",
	"/api/sessions/delete",
	"/api/archive",
	"/api/chat-projects",
	"/api/chat-projects/create",
	"/api/chat-projects/rename",
	"/api/chat-projects/folder",
	"/api/chat-projects/collapse",
	"/api/chat-projects/assign",
	"/api/chat-projects/reorder",
	"/api/chat-projects/delete",
];

test("a POST whose body is not a JSON object is answered 400, on every route that reads one", async () => {
	for (const route of ROUTES) {
		for (const body of ["{", "null", "[]", '"x"']) {
			const res = await post(route, body);
			expect(res.status, `${route} ${body}: ${await res.clone().text()}`).toBe(400);
		}
	}
});

test("a command name that is none is a 400 for the help of a command", async () => {
	for (const cmd of ["", "a b c", "../x", "x;y"]) {
		const res = await fetch(`${s.url}/api/cli/help?cmd=${encodeURIComponent(cmd)}`, {
			headers: { "x-omp-webui-token": s.accessToken },
		});
		expect(res.status, cmd).toBe(400);
	}
});

test("a null body to the sign-in is no token, not a failure", async () => {
	const res = await fetch(`${s.url}/api/auth`, {
		method: "POST",
		headers: { "x-omp-webui": "1", "content-type": "application/json" },
		body: "null",
	});
	expect(res.status).toBe(401);
	expect(s.errors()).not.toContain("TypeError");
});
