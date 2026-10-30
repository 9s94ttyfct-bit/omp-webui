import { expect, test } from "bun:test";
import { PORT_WINDOW } from "../../server/instance.ts";
import {
	boundHosts,
	listenOnLoopback,
	loopbackCandidates,
	loopbackRequiredByApp,
	needsLoopbackListener,
} from "../../server/loopback-listener.ts";

/** A server bound to a network address also listens on 127.0.0.1 (#624): when, and on which port. */

test("only an address of a network, or a name of this computer on one, needs the loopback listener", () => {
	for (const host of ["192.168.1.5", "10.0.0.5", "fe80::1", "mymac.local", "169.254.3.4"])
		expect(needsLoopbackListener(host), host).toBe(true);
	// The loopback is the loopback; the empty name is what Bun listens on `localhost` for; the wildcards have the loopback already.
	for (const host of [
		"127.0.0.1",
		"127.1.2.3",
		"localhost",
		"::1",
		"[::1]",
		"::ffff:127.0.0.1",
		"",
		"0.0.0.0",
		"::",
		"[::]",
	])
		expect(needsLoopbackListener(host), host).toBe(false);
});

test("the address the gate is told of is the one of a network the server is bound to, and only that one (#634)", () => {
	expect(boundHosts("192.168.1.5")).toEqual(["192.168.1.5"]);
	expect(boundHosts("mymac.local")).toEqual(["mymac.local"]);
	// An IPv6 address is told bare: a URL writes it in brackets, and the classifier reads both.
	expect(boundHosts("fe80::1")).toEqual(["fe80::1"]);
	expect(boundHosts("[fe80::1]")).toEqual(["fe80::1"]);
	// The loopback, the empty name and the wildcards: no address of a network of its own.
	for (const host of ["127.0.0.1", "localhost", "::1", "", "0.0.0.0", "::", "[::]"])
		expect(boundHosts(host), host).toEqual([]);
	// What no URL could carry is not one address the server answers on.
	expect(boundHosts("a/b")).toEqual([]);
	expect(boundHosts("192.168.1.5 192.168.1.6")).toEqual([]);
});

test("the loopback port is the server's own, then the window above it, then any free one", () => {
	const all = loopbackCandidates(7878);
	expect(all[0]).toBe(7878);
	expect(all).toHaveLength(PORT_WINDOW + 2);
	expect(all.at(-2)).toBe(7878 + PORT_WINDOW);
	expect(all.at(-1)).toBe(0);
	// Never past the last port.
	expect(loopbackCandidates(65535)).toEqual([65535, 0]);
});

const taken = (port: number) => Object.assign(new Error(`port ${port} in use`), { code: "EADDRINUSE" });

test("it takes the port asked for when it is free, and says it did not move", () => {
	const asked: [string, number][] = [];
	const got = listenOnLoopback(7878, (host, port) => {
		asked.push([host, port]);
		return { port };
	});
	expect(asked).toEqual([["127.0.0.1", 7878]]);
	expect(got).toEqual({ server: { port: 7878 }, port: 7878, moved: false });
});

test("a port that is taken moves it to the next free one, and at last to any (the port the system chose is what is reported)", () => {
	const some = listenOnLoopback(7878, (_host, port) => {
		if (port < 7880) throw taken(port);
		return { port };
	});
	expect(some).toMatchObject({ port: 7880, moved: true });
	const none = listenOnLoopback(7878, (_host, port) => {
		if (port !== 0) throw taken(port);
		return { port: 54321 };
	});
	expect(none).toMatchObject({ port: 54321, moved: true });
});

test("a failure that is not a taken port, or no port at all, leaves the server without the loopback page and says so", () => {
	const warnings: string[] = [];
	const warn = console.warn;
	console.warn = (m: string) => void warnings.push(m);
	try {
		expect(
			listenOnLoopback(7878, () => {
				throw Object.assign(new Error("cannot assign"), { code: "EADDRNOTAVAIL" });
			}),
		).toBeNull();
		expect(
			listenOnLoopback(7878, (_h, port) => {
				throw taken(port);
			}),
		).toBeNull();
	} finally {
		console.warn = warn;
	}
	expect(warnings).toHaveLength(2);
	expect(warnings[0]).toContain("cannot assign");
	expect(warnings[1]).toContain("no free port");
});

test("the app (auto port) will not start on a network address with no loopback listener, the web version goes on", () => {
	const lan = { autoPort: true, host: "192.168.1.5" };
	const message = loopbackRequiredByApp(lan, null)?.message ?? "";
	expect(message).toContain("192.168.1.5");
	expect(message).toContain("unset OMP_WEBUI_HOST");
	// The listener is there; the web version; a host that has the loopback already: nothing to refuse.
	expect(loopbackRequiredByApp(lan, { server: {}, port: 7878, moved: false })).toBeNull();
	expect(loopbackRequiredByApp({ autoPort: false, host: "192.168.1.5" }, null)).toBeNull();
	for (const host of ["127.0.0.1", "localhost", "0.0.0.0", "::"])
		expect(loopbackRequiredByApp({ autoPort: true, host }, null), host).toBeNull();
});
