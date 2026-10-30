import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTestServer, type TestServer } from "../support/server.ts";

/** Cookies and SameSite ignore ports: the Origin check is the only guard against other localhost pages. */

let s: TestServer;
beforeAll(async () => {
	s = await startTestServer();
}, 60_000);
afterAll(async () => {
	await s?.stop();
});

function connect(origin: string): Promise<"open" | "refused"> {
	const ws = new WebSocket(`${s.url.replace("http", "ws")}/ws`, {
		// Bun's WebSocket accepts request headers.
		headers: { Origin: origin, Cookie: `ompw_token=${s.accessToken}` },
	} as unknown as string[]);
	return new Promise((resolve) => {
		ws.onopen = () => {
			ws.close();
			resolve("open");
		};
		ws.onerror = () => resolve("refused");
	});
}

describe("origin check", () => {
	test("a page on another localhost port cannot open the WebSocket, even with the cookie", async () => {
		expect(await connect("http://127.0.0.1:3000")).toBe("refused");
		expect(await connect(s.url.replace("127.0.0.1", "localhost"))).toBe("refused");
	});

	test("the UI's own origin can", async () => {
		expect(await connect(s.url)).toBe("open");
	});

	test("API requests from another port are refused", async () => {
		const headers = { "x-omp-webui-token": s.accessToken };
		expect(
			(await fetch(`${s.url}/api/meta`, { headers: { ...headers, Origin: "http://127.0.0.1:3000" } })).status,
		).toBe(403);
		expect((await fetch(`${s.url}/api/meta`, { headers: { ...headers, Origin: s.url } })).status).toBe(200);
	});
});
