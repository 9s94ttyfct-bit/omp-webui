import { expect, test } from "bun:test";
import { REMOTE_PING_MS, remotePingMs } from "../../server/remote-keepalive.ts";

/**
 * How often the server pings a remote page's socket. Cloudflare cuts a WebSocket that has carried nothing for about
 * 100 s, so the default must leave room for a lost ping or two; tests scale it down with
 * `OMP_WEBUI_REMOTE_KEEPALIVE_MS`.
 */

test("the default interval is well inside Cloudflare's 100 s, with room for a ping to be lost", () => {
	expect(remotePingMs({})).toBe(REMOTE_PING_MS);
	expect(REMOTE_PING_MS * 2).toBeLessThan(100_000);
});

test("the environment sets it, and anything that is not a positive number is ignored", () => {
	expect(remotePingMs({ OMP_WEBUI_REMOTE_KEEPALIVE_MS: "250" })).toBe(250);
	for (const bad of ["", "0", "-5", "soon", "NaN", "Infinity"])
		expect(remotePingMs({ OMP_WEBUI_REMOTE_KEEPALIVE_MS: bad }), bad).toBe(REMOTE_PING_MS);
});
