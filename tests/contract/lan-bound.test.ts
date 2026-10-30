import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FakeCloudflared, makeFakeCloudflared } from "../support/fake-cloudflared.ts";
import { type FakeReleases, startFakeReleases } from "../support/fake-releases.ts";
import { lanAddress, type NetSocket, rawRequest, rawSocket } from "../support/lan-peer.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";

/**
 * A server that listens on a network address (#621), seen from the two sides docs/TECHNICAL.md speaks of.
 *
 * The sockets: what a page is told over the socket depends on whether it is this computer's (`WsData.local`): the
 * guard's settings and the app's updates are said to those pages only. Shown on a server on the loopback, where a page
 * on this computer is the control (it is told), and on one bound to the network address, where there is none.
 *
 * The owner: a server bound to a network address also listens on `127.0.0.1` (the same port, or the next free one when
 * another program holds it there), so its owner has a page on this computer, and it is the only one that has what is for
 * this computer alone (the peer decides, as everywhere). A `0.0.0.0` bind has the loopback page already, and its network
 * clients are refused: a Host that is neither a loopback name nor the bind address's own text is not served.
 *
 * The peers are real (see `lan-local.test.ts`): sockets and requests from this computer's network address.
 */

const LAN = lanAddress();
if (LAN === undefined) {
	console.warn("lan-bound: this computer has no IPv4 address on a network, so its cases are skipped");
}
const networkOnly = LAN === undefined ? describe.skip : describe;

const root = mkdtempSync(join(tmpdir(), "ompw-lan-bound-"));
const LATEST = "/repos/9s94ttyfct-bit/omp-webui/releases/latest";
let program: FakeCloudflared;

beforeAll(() => {
	program = makeFakeCloudflared(join(root, "cf"), { installed: false });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The settings every server of this file has: nothing real is run (cloudflared and brew are stand-ins). */
const baseEnv = (): Record<string, string> => ({
	OMP_WEBUI_CLOUDFLARED: program.bin,
	OMP_WEBUI_BREW: program.brew,
});

const portOf = (server: TestServer) => Number(new URL(server.url).port);

/** The three members both kinds of socket (a browser's, and the one made from a network address) have. */
interface Events {
	addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
	send(data: string): void;
	close(): void;
}

/** What a page's socket is told, kind by kind, and a way to know that everything the server sent before now has come. */
interface Heard {
	said(): string[];
	sync(): Promise<void>;
	close(): void;
}

/** Listens to `socket` from now on, and to what it was already told (a socket made from a network address keeps it). */
function hear(socket: NetSocket | WebSocket): Heard {
	// A union of the two kinds' overloaded signatures cannot be called as it is: both have exactly these members.
	const events = socket as unknown as Events;
	const said: string[] = [];
	const answers = new Map<string, () => void>();
	const note = (text: string) => {
		const m = JSON.parse(text) as { t?: string; req?: string };
		if (m.t) said.push(m.t);
		if (m.t === "reply" && m.req) answers.get(m.req)?.();
	};
	if ("received" in socket) for (const text of socket.received) note(text);
	events.addEventListener("message", (ev) => note(String(ev.data)));
	let sent = 0;
	return {
		said: () => said,
		// One connection delivers in order: the answer to a question asked now comes after everything said before it.
		sync() {
			const req = `sync-${++sent}`;
			const answered = Promise.withResolvers<void>();
			answers.set(req, answered.resolve);
			events.send(JSON.stringify({ t: "list_lives", req }));
			return answered.promise;
		},
		close: () => events.close(),
	};
}

/** A socket of a page on this computer's loopback, with what `extra` adds to its request (a proxy's header, say). */
async function openLoopback(server: TestServer, extra: Record<string, string> = {}): Promise<Heard> {
	const ws = new WebSocket(`${server.url.replace("http", "ws")}/ws`, {
		headers: { Origin: server.url, Cookie: `ompw_token=${server.accessToken}`, ...extra },
	} as unknown as string[]);
	// Listening starts before it is open: the server's first words (`hello`) come with the upgrade.
	const heard = hear(ws);
	const opened = Promise.withResolvers<Heard>();
	ws.onopen = () => opened.resolve(heard);
	ws.onerror = () => opened.reject(new Error("the server refused the socket"));
	return opened.promise;
}

/** A socket of a page on the network: from this computer's network address when it is to the loopback server. */
async function openNetwork(host: string, port: number, token: string, from?: string): Promise<Heard> {
	const socket = await rawSocket({
		host,
		port,
		from,
		headers: { origin: `http://${host}:${port}`, cookie: `ompw_token=${token}` },
	});
	if (!socket) throw new Error("the server refused the socket of a page on the network");
	return hear(socket);
}

const tokenHeaders = (server: TestServer, post = false) => ({
	"x-omp-webui-token": server.accessToken,
	...(post ? { "x-omp-webui": "1", "content-type": "application/json" } : {}),
});

networkOnly("the sockets of pages that are not this computer's", () => {
	let fake: FakeReleases;
	let loop: TestServer;
	let bound: TestServer;

	beforeAll(async () => {
		fake = await startFakeReleases();
		fake.publish({ tag: "v99.0.0" });
		// The server looks for a release soon after it starts, and finds this one: a page on this computer is told.
		const env = { ...baseEnv(), OMP_WEBUI_APP_UPDATE_API: fake.url, OMP_WEBUI_APP_UPDATE_FIRST_MS: "100" };
		[loop, bound] = await Promise.all([
			startTestServer(0, env, { login: false }),
			startTestServer(0, { ...env, OMP_WEBUI_HOST: LAN as string }, { login: false }),
		]);
	}, 120_000);

	afterAll(async () => {
		await loop?.stop();
		await bound?.stop();
		await fake?.stop();
	});

	const get = (server: TestServer, path: string) => fetch(`${server.url}${path}`, { headers: tokenHeaders(server) });
	const post = (server: TestServer, path: string, body: unknown) =>
		fetch(`${server.url}${path}`, {
			method: "POST",
			headers: tokenHeaders(server, true),
			body: JSON.stringify(body),
		});

	test("on a server on the loopback: a page on this computer is told of the updater and the guard; a page on the network, and one behind a proxy, are not", async () => {
		const here = await openLoopback(loop);
		const proxied = await openLoopback(loop, { "x-forwarded-for": "203.0.113.9" });
		const away = await openNetwork("127.0.0.1", portOf(loop), loop.accessToken, LAN);
		const all = [here, proxied, away];
		try {
			await pollUntil(async () => {
				const state: { state: { newer: boolean } } = await (await get(loop, "/api/update")).json();
				return state.state.newer;
			}, "the server to find the newer release");
			// Said when it was found, or at once to a socket that opened after: the page on this computer has it either way.
			await Promise.all(all.map((h) => h.sync()));
			expect(here.said()).toContain("app_update");
			// A change of the updater's state is said to the pages on this computer.
			const before = here.said().filter((t) => t === "app_update").length;
			expect((await post(loop, "/api/update/dismiss", {})).status).toBe(200);
			await Promise.all(all.map((h) => h.sync()));
			expect(here.said().filter((t) => t === "app_update").length).toBeGreaterThan(before);
			// So is the guard's settings.
			expect((await post(loop, "/api/guard", { mode: "off" })).status).toBe(200);
			await Promise.all(all.map((h) => h.sync()));
			expect(here.said()).toContain("guard_config");

			for (const [name, page] of [
				["a page behind a proxy", proxied],
				["a page on the network", away],
			] as const) {
				expect(page.said(), name).toContain("hello");
				expect(page.said(), name).not.toContain("app_update");
				expect(page.said(), name).not.toContain("guard_config");
			}

			// Sockets opened now, with the release known: the same.
			const late = [
				await openLoopback(loop),
				await openLoopback(loop, { "x-forwarded-for": "203.0.113.9" }),
				await openNetwork("127.0.0.1", portOf(loop), loop.accessToken, LAN),
			];
			all.push(...late);
			await Promise.all(late.map((h) => h.sync()));
			expect(late[0]?.said()).toContain("app_update");
			expect(late[1]?.said()).not.toContain("app_update");
			expect(late[2]?.said()).not.toContain("app_update");
		} finally {
			for (const h of all) h.close();
		}
	}, 60_000);

	test("on a server bound to the network address: the page on this computer (127.0.0.1) is told of the updater and the guard, a page on the network is not and cannot ask for it", async () => {
		const port = portOf(bound);
		// The server has looked for the release, so that there is something to say (it said it to a page on this computer, above).
		await pollUntil(
			() => fake.requests.filter((r) => r.path === LATEST).length >= 2,
			"both servers to look for the release",
		);
		const here = await openLoopback(bound);
		const away = await openNetwork(LAN as string, port, bound.accessToken);
		try {
			for (const route of ["/api/update/dismiss", "/api/guard"]) {
				const res = await rawRequest({
					host: LAN as string,
					port,
					method: "POST",
					path: route,
					headers: { ...tokenHeaders(bound, true) },
					body: JSON.stringify({ mode: "off" }),
				});
				expect(res.status, route).toBe(403);
			}
			// The page on this computer may: and is told what changed.
			expect((await post(bound, "/api/guard", { mode: "off" })).status).toBe(200);
			// The server answers the three after what it said before, whatever that was.
			await Promise.all([here.sync(), away.sync()]);
			await Promise.all([here.sync(), away.sync()]);
			await Promise.all([here.sync(), away.sync()]);
			expect(here.said()).toContain("app_update");
			expect(here.said()).toContain("guard_config");
			expect(away.said()).toContain("hello");
			expect(away.said()).not.toContain("app_update");
			expect(away.said()).not.toContain("guard_config");
		} finally {
			here.close();
			away.close();
		}
	}, 60_000);
});

networkOnly("the owner of a server bound to a network address", () => {
	const dataDir = join(root, "owner-data");
	const projects = join(root, "owner-projects");
	/** The files the settings are kept in: where they are when nothing says otherwise (a data dir, no file of its own). */
	const settingsEnv = (): Record<string, string> => ({
		...baseEnv(),
		OMP_WEBUI_DATA_DIR: dataDir,
		// The test server names a guard file of its own; empty is the default place, `<data dir>/guard.json`.
		OMP_WEBUI_GUARD_CONFIG: "",
	});

	test("has the page on this computer at 127.0.0.1 on the same port, and the network's page is refused what is for this computer alone", async () => {
		mkdirSync(dataDir, { recursive: true });
		mkdirSync(projects, { recursive: true });
		const bound = await startTestServer(0, { ...settingsEnv(), OMP_WEBUI_HOST: LAN as string }, { login: false });
		try {
			const port = portOf(bound);
			const here = (path: string, init: RequestInit = {}) =>
				fetch(`http://127.0.0.1:${port}${path}`, {
					...init,
					headers: { ...tokenHeaders(bound, init.method === "POST"), ...init.headers },
				});
			const ask = (path: string, host = `${LAN}:${port}`) =>
				rawRequest({ host: LAN as string, port, path, headers: { ...tokenHeaders(bound), host } });
			// The owner's page: the loopback, the same port, and this computer's own.
			const meta = (await (await here("/api/meta")).json()) as { remote: boolean; local: boolean };
			expect(meta).toMatchObject({ local: true, remote: false });
			expect((await here("/api/guard")).status).toBe(200);
			expect((await here("/api/remote")).status).toBe(200);
			// What it changes is kept in the data directory, and is the server's own settings.
			const set = (path: string, body: unknown) => here(path, { method: "POST", body: JSON.stringify(body) });
			expect((await set("/api/guard", { mode: "ask" })).status).toBe(200);
			expect((await set("/api/remote/config", { hostname: "owner.example.com" })).status).toBe(200);
			expect((await set("/api/projects", { folder: projects })).status).toBe(200);
			expect(JSON.parse(readFileSync(join(dataDir, "guard.json"), "utf8")).mode).toBe("ask");
			expect(JSON.parse(readFileSync(join(dataDir, "remote.json"), "utf8")).hostname).toBe("owner.example.com");
			expect(JSON.parse(readFileSync(join(dataDir, "projects-folder.json"), "utf8"))).toMatchObject({
				folder: projects,
			});

			// The network's page: the address it was started with, named exactly, is served as a remote page. Any other name is not.
			const away = await ask("/api/meta");
			expect(away.status).toBe(200);
			expect(((await away.json()) as { local: boolean }).local).toBe(false);
			expect((await ask("/api/meta", `mymac.local:${port}`)).status).toBe(403);
			// ... and it cannot use what is for this computer alone, however it names the server.
			expect((await ask("/api/guard")).status).toBe(403);
			expect((await ask("/api/remote")).status).toBe(403);
			expect((await ask("/api/guard", `127.0.0.1:${port}`)).status).toBe(403);
			// The projects folder is read by both: what the owner set is in force.
			expect(((await (await ask("/api/projects")).json()) as { folder: string }).folder).toBe(projects);
			// The decision is the connection's, also on the loopback listener: a peer that is this computer's network address, or a proxy's header, is not the owner.
			const fromNetwork = await rawRequest({
				host: "127.0.0.1",
				port,
				from: LAN as string,
				path: "/api/guard",
				headers: tokenHeaders(bound),
			});
			expect(fromNetwork.status).toBe(403);
			expect((await here("/api/guard", { headers: { "x-forwarded-for": "203.0.113.9" } })).status).toBe(403);

			// Both pages are printed, and which is the local one is said. The banner is printed line by line: the test server is
			// ready at its first, and the `Open:` lines may come in a read of their own (a loaded machine).
			await pollUntil(() => bound.output().includes("(the network: a remote page"), "the banner's last line");
			const banner = bound.output();
			expect(banner).toContain(`omp-webui listening on http://${LAN}:${port} `);
			expect(banner).toContain(`omp-webui also listening on http://127.0.0.1:${port}:`);
			expect(banner).toContain(`Open: http://127.0.0.1:${port}/?token=${bound.accessToken}  (this computer)`);
			expect(banner).toMatch(
				new RegExp(`Open: http://${LAN}:${port}/\\?token=${bound.accessToken}  \\(the network: a remote page`),
			);
		} finally {
			await bound.stop();
		}
	}, 120_000);

	test("when its port is taken on 127.0.0.1 the page on this computer is on the next free one, which the banner and the record say", async () => {
		// Another program holds 127.0.0.1:<port>; the network address is free on that port.
		const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("not omp-webui") });
		const taken = blocker.port as number;
		try {
			const bound = await startTestServer(taken, { ...baseEnv(), OMP_WEBUI_HOST: LAN as string }, { login: false });
			try {
				await pollUntil(() => bound.output().includes("(the network: a remote page"), "the banner's last line");
				const banner = bound.output();
				expect(banner).toContain(`omp-webui listening on http://${LAN}:${taken} `);
				const local = Number(/omp-webui also listening on http:\/\/127\.0\.0\.1:(\d+):/.exec(banner)?.[1]);
				expect(local).toBeGreaterThan(0);
				expect(local).not.toBe(taken);
				expect(banner).toContain(`port ${taken} was taken on 127.0.0.1`);
				expect(banner).toContain(`Open: http://127.0.0.1:${local}/?token=${bound.accessToken}  (this computer)`);
				// The other program still answers on its port; the page on this computer is on the one the banner says.
				expect(await (await fetch(`http://127.0.0.1:${taken}/`)).text()).toBe("not omp-webui");
				const meta = await fetch(`http://127.0.0.1:${local}/api/meta`, { headers: tokenHeaders(bound) });
				expect(((await meta.json()) as { local: boolean }).local).toBe(true);
				expect((await fetch(`http://127.0.0.1:${local}/api/guard`, { headers: tokenHeaders(bound) })).status).toBe(200);
				// The network's page is on the port that was asked for, and is still the network's.
				const away = await rawRequest({
					host: LAN as string,
					port: taken,
					path: "/api/guard",
					headers: { ...tokenHeaders(bound), host: `${LAN}:${taken}` },
				});
				expect(away.status).toBe(403);
				// Other servers' gates learn of the port from the record.
				const record = JSON.parse(readFileSync(join(bound.root, "data", "server.pid"), "utf8"));
				expect(record).toMatchObject({ port: taken, localPort: local });
			} finally {
				await bound.stop();
			}
		} finally {
			blocker.stop(true);
		}
	}, 120_000);

	test("with a `0.0.0.0` bind has the page on this computer at 127.0.0.1, and its network clients, which name it by the network address, are refused", async () => {
		const all = await startTestServer(0, { ...baseEnv(), OMP_WEBUI_HOST: "0.0.0.0" }, { login: false });
		try {
			const port = portOf(all);
			const here = await fetch(`http://127.0.0.1:${port}/api/guard`, { headers: tokenHeaders(all) });
			expect(here.status).toBe(200);
			const meta = await fetch(`http://127.0.0.1:${port}/api/meta`, { headers: tokenHeaders(all) });
			expect(((await meta.json()) as { local: boolean }).local).toBe(true);
			// Named by the network address, which is neither a loopback name nor the text `0.0.0.0`: not served at all.
			const away = await rawRequest({
				host: LAN as string,
				port,
				path: "/api/meta",
				headers: tokenHeaders(all),
			});
			expect(away.status).toBe(403);
			// Named by a loopback name from the network it is served, as a remote page, and not this computer's.
			const spoofed = await rawRequest({
				host: LAN as string,
				port,
				path: "/api/guard",
				headers: { ...tokenHeaders(all), host: `127.0.0.1:${port}` },
			});
			expect(spoofed.status).toBe(403);
		} finally {
			await all.stop();
		}
	}, 120_000);
});
