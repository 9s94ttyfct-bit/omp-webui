import { afterAll, beforeAll, expect, test } from "bun:test";
import { startTestServer, type TestServer } from "../support/server.ts";

/**
 * A family worker that gives no answer within its deadline must answer the request with an error, not leave it pending.
 * The deadline is 1 ms here: no worker is up and answering that fast, so every build is one that never came back in time.
 */

let s: TestServer;
const headers = () => ({ "x-omp-webui-token": s.accessToken, "accept-encoding": "gzip" });
beforeAll(async () => {
	s = await startTestServer(0, { OMP_WEBUI_FAMILY_DEADLINE_MS: "1" });
});
afterAll(async () => {
	await s?.stop();
});

for (const route of ["family", "session"]) {
	test(`/api/${route} answers 503 with a message when the worker does not answer in time`, async () => {
		const url = `${s.url}/api/${route}?file=${encodeURIComponent(s.fixtures.alpha)}`;
		const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(10_000) });
		expect(res.status).toBe(503);
		expect(res.headers.get("retry-after")).toBe("1");
		expect((await res.json()).error).toContain("gave no answer");
		// And again: a worker was started for this one, not left wedged for the next.
		const again = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(10_000) });
		expect(again.status).toBe(503);
	});
}

test("the server keeps answering other requests after a worker was stopped", async () => {
	const res = await fetch(`${s.url}/api/sessions`, { headers: headers() });
	expect(res.status).toBe(200);
	expect((await res.json()).length).toBeGreaterThan(0);
});
