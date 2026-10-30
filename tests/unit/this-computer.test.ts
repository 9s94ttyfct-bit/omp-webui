import { describe, expect, test } from "bun:test";
import { isLocalOnlyRoute, isLoopbackPeer, isThisComputer } from "../../server/this-computer.ts";

/**
 * What decides that a page is on this computer (#621): the address its socket is from, and nothing it says. The Host and
 * the proxy headers can only take a loopback connection out of it (the tunnel's cloudflared connects from the loopback),
 * never put a network one in.
 */

const asked = (host: string, peer: string | undefined, headers: Record<string, string> = {}) =>
	isThisComputer(new Request("http://x/api/guard", { headers: { host, ...headers } }), peer);

describe("isLoopbackPeer", () => {
	test("127.0.0.0/8, ::1 and the IPv4 loopback in its IPv6 form", () => {
		for (const peer of ["127.0.0.1", "127.0.0.2", "127.255.255.254", "::1", "::ffff:127.0.0.1", "::ffff:127.4.5.6"])
			expect(isLoopbackPeer(peer), peer).toBe(true);
	});

	test("no other address, spelling or lookalike", () => {
		for (const peer of [
			undefined,
			"",
			"localhost",
			"0.0.0.0",
			"::",
			"10.0.0.5",
			"172.16.3.4",
			"192.168.1.20",
			"169.254.1.1",
			"128.0.0.1",
			"1127.0.0.1",
			"127.0.0",
			"127.0.0.1.5",
			"127.0.0.1 ",
			"::2",
			"fe80::1",
			"fe80::1%en0",
			"::ffff:192.168.1.20",
			"::ffff:10.0.0.5",
			"::ffff:127.0.0.1.evil",
			"::127.0.0.1",
		])
			expect(isLoopbackPeer(peer), String(peer)).toBe(false);
	});
});

describe("isThisComputer is the socket's say", () => {
	test("a network peer is not this computer, whatever the request says it is", () => {
		for (const peer of ["192.168.1.20", "10.0.0.5", "::ffff:192.168.1.20", "fe80::1", undefined]) {
			for (const host of ["127.0.0.1:7878", "localhost:7878", "[::1]:7878", "192.168.1.20:7878", "127.0.0.1"])
				expect(asked(host, peer), `${host} from ${peer}`).toBe(false);
			// A header that says the request is from the loopback, or from nowhere in particular, puts no network peer in.
			for (const headers of <Record<string, string>[]>[
				{ "x-forwarded-for": "127.0.0.1" },
				{ "x-real-ip": "127.0.0.1" },
				{ forwarded: "for=127.0.0.1" },
				{ origin: "http://127.0.0.1:7878" },
				{ referer: "http://127.0.0.1:7878/" },
				{ "x-forwarded-host": "127.0.0.1:7878" },
				{ "sec-fetch-site": "same-origin" },
				{ "x-omp-webui": "1" },
			])
				expect(asked("127.0.0.1:7878", peer, headers), `${JSON.stringify(headers)} from ${peer}`).toBe(false);
		}
	});

	test("a loopback peer is this computer unless it is a proxy's, or names the server by another name", () => {
		for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.0.0.2"]) {
			expect(asked("127.0.0.1:7878", peer), peer).toBe(true);
			expect(asked("127.0.0.1:7878", peer, { origin: "http://127.0.0.1:7878", "sec-fetch-site": "same-origin" })).toBe(
				true,
			);
			for (const headers of <Record<string, string>[]>[
				{ "x-forwarded-for": "192.168.1.20" },
				{ "x-forwarded-proto": "https" },
				{ "x-real-ip": "192.168.1.20" },
				{ forwarded: "for=192.168.1.20" },
				{ via: "1.1 proxy" },
				{ "cf-connecting-ip": "203.0.113.9" },
				{ "cdn-loop": "cloudflare" },
			])
				expect(asked("127.0.0.1:7878", peer, headers), `${JSON.stringify(headers)} from ${peer}`).toBe(false);
			expect(asked("192.168.1.20:7878", peer), `LAN name from ${peer}`).toBe(false);
			expect(asked("omp.example.com", peer), `public name from ${peer}`).toBe(false);
		}
	});
});

describe("isLocalOnlyRoute", () => {
	test("the tunnel's settings, the guard, the app's updates and moving to another computer, with everything under them", () => {
		for (const path of [
			"/api/remote",
			"/api/remote/config",
			"/api/remote/ai/start",
			"/api/guard",
			"/api/guard/log",
			"/api/guard/decisions",
			"/api/update",
			"/api/update/check",
			"/api/update/install",
			"/api/migrate",
			"/api/migrate/state",
			"/api/migrate/export",
			"/api/migrate/import/upload",
			// What omp remembers: private, and a write goes into every later conversation's prompt.
			"/api/memory",
			"/api/memory/items",
			// The list of saved Macs: pages read it in `/api/meta`, and every route here changes it.
			"/api/macs",
			"/api/macs/0f8fad5b-d9cb-469f-a165-70867728950e",
			"/api/macs/0f8fad5b-d9cb-469f-a165-70867728950e/rename",
			// What the macOS app is told on its own: the titles of the conversations that need somebody.
			"/api/shell",
			"/api/shell/events",
		])
			expect(isLocalOnlyRoute(path), path).toBe(true);
	});

	test("no other route, nor one that only starts with the same letters", () => {
		for (const path of [
			"/",
			"/api",
			"/api/meta",
			"/api/sessions",
			"/api/folder/list",
			"/api/folder/open",
			"/api/remotely",
			"/api/remote-control",
			"/api/guards",
			"/api/guarded/x",
			"/api/updates",
			"/api/updated",
			"/api/migrated",
			"/api/migration/state",
			// Only the route, and what is under it: a route that merely starts with the same letters is another one.
			"/api/memoryx",
			"/api/macsx",
			"/api/mac",
			"/api/memories",
			"/api/shellfish",
			"/api/auth",
			"/ws",
			"/assets/api/guard",
			"/API/GUARD",
		])
			expect(isLocalOnlyRoute(path), path).toBe(false);
	});
});
