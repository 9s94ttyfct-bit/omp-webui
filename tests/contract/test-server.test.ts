import { afterAll, expect, test } from "bun:test";
import { startTestServer, type TestServer } from "../support/server.ts";

const servers: TestServer[] = [];
afterAll(async () => {
	await Promise.all(servers.map((server) => server.stop()));
});

test("test servers choose independent ports, preserve an explicit restart port, and can request a new one", async () => {
	const started = await Promise.all([startTestServer(), startTestServer()]);
	servers.push(...started);
	const [first, second] = started;
	expect(new URL(first.url).port).not.toBe("0");
	expect(first.url).not.toBe(second.url);
	const original = first.url;
	await first.restart();
	expect(first.url).toBe(original);
	await first.restart(0);
	expect(new URL(first.url).port).not.toBe("0");
	expect(first.url).not.toBe(second.url);
	for (const server of started) {
		const response = await fetch(`${server.url}/api/meta`, {
			headers: { "x-omp-webui-token": server.accessToken },
		});
		expect(response.ok).toBe(true);
	}
}, 60_000);
