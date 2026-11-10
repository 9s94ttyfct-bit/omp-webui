import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import { MAC_LIMIT, type MacListing, type MacProblem, type MacRecord, type SavedMac } from "../../shared/macs.ts";
import { lanAddress, rawRequest } from "../support/lan-peer.ts";
import { expectMode } from "../support/modes.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { connect } from "../support/ws.ts";

/**
 * The list of the other Macs this one knows (#628): `<data dir>/remote-macs.json`, read by every page in `/api/meta` and changed
 * through `/api/macs*` from this computer alone. What the macOS app saved before the server kept the list (its file, UPPER-case
 * UUIDs included) is the list from the first start. No secret is in it, and the file is private.
 *
 * The writers' refusals (a page on the network, a page through the tunnel, a request that says it is on the loopback) are
 * also tried against every route in `lan-local.test.ts`; here they are tried against a list that has something in it, and
 * the list is read back to show nothing moved.
 */

let s: TestServer;
const LAN = lanAddress();
const file = () => join(s.root, "data", "remote-macs.json");

beforeAll(async () => {
	s = await startTestServer(0, {}, { login: false });
}, 120_000);
afterAll(async () => {
	await s?.stop();
});

const headers = (write: boolean, extra: Record<string, string> = {}): Record<string, string> => ({
	"x-omp-webui-token": s.accessToken,
	...(write ? { "x-omp-webui": "1", "content-type": "application/json" } : {}),
	...extra,
});

/** A request from this computer: a connection from 127.0.0.1 that names the server by its loopback address. */
const here = (path: string, method = "GET", body?: unknown) =>
	fetch(`${s.url}${path}`, {
		method,
		headers: headers(method !== "GET"),
		body: body === undefined ? undefined : JSON.stringify(body),
	});

/** A request the way it arrives through the tunnel: a loopback connection (cloudflared's) with what Cloudflare adds. */
const tunnel = (path: string, method = "GET", body?: unknown) =>
	fetch(`${s.url}${path}`, {
		method,
		headers: headers(method !== "GET", { "cf-ray": "8c1f2d3e4a5b6c7d-FRA", "cf-connecting-ip": "203.0.113.9" }),
		body: body === undefined ? undefined : JSON.stringify(body),
	});

const meta = async () => (await (await here("/api/meta")).json()) as { macs: MacListing[]; local: boolean };
const stored = () => JSON.parse(readFileSync(file(), "utf8")) as { version: number; macs: MacRecord[] };

async function add(name: string, address: string): Promise<MacRecord> {
	const res = await here("/api/macs", "POST", { name, address });
	expect(res.status, `${name}: ${await res.clone().text()}`).toBe(200);
	return ((await res.json()) as { mac: MacRecord }).mac;
}

/** The list as a page that is not this computer's sees it, and as it is on disk: both must be as they were. */
const snapshot = async () => ({ page: await meta(), disk: existsSync(file()) ? readFileSync(file(), "utf8") : null });

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
/** A token of Access's shape for a Mac's sign-in (its signature is not one: the remote computer checks it, not this server). */
const SIGN_IN_EXP = Math.floor(Date.now() / 1000) + 6 * 3600;
const SIGN_IN = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({ exp: SIGN_IN_EXP, email: "me@example.com" })}.c2ln`;

describe("the list", () => {
	test("is empty at first: meta lists no Mac and there is no file", async () => {
		expect((await meta()).macs).toEqual([]);
		expect(existsSync(file())).toBe(false);
	});

	test("a Mac is added by name and address, listed in meta without what only the app needs, and kept in a private file", async () => {
		const mac = await add("  Studio  ", "HTTPS://Studio.Example.COM/");
		expect(mac).toMatchObject({ name: "Studio", host: "studio.example.com", team: null, lastConnected: null });
		expect(mac.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(mac.storeId).not.toBe(mac.id);

		// A page is told what it needs to open the Mac, and no more: not the team, not the app's data store; and until when this
		// server holds its sign-in (none yet).
		const listed = (await meta()).macs;
		expect(listed).toEqual([
			{ id: mac.id, name: "Studio", host: "studio.example.com", lastConnected: null, signedInUntil: null },
		]);
		expect(Object.keys(listed[0] as object).sort()).toEqual(["host", "id", "lastConnected", "name", "signedInUntil"]);

		expectMode(file(), 0o600);
		expectMode(join(s.root, "data"), 0o700);
		const kept = stored();
		expect(kept.version).toBe(1);
		expect(Object.keys(kept.macs[0] as object).sort()).toEqual([
			"added",
			"host",
			"id",
			"lastConnected",
			"name",
			"storeId",
			"team",
		]);
		// Nothing of the server's own is in it: no token, no cookie, no key.
		expect(readFileSync(file(), "utf8")).not.toContain(s.accessToken);
	});

	test("refuses what the rules refuse, with the rule, and changes nothing", async () => {
		const before = await snapshot();
		const refused: [unknown, MacProblem][] = [
			[
				{ name: "", address: "a.example.com" },
				{ kind: "name", code: "empty" },
			],
			[
				{ name: "x".repeat(61), address: "a.example.com" },
				{ kind: "name", code: "too-long" },
			],
			[
				{ name: "Mac\u202EA", address: "a.example.com" },
				{ kind: "name", code: "characters" },
			],
			[
				{ name: "studio", address: "a.example.com" },
				{ kind: "name", code: "taken", taken: "Studio" },
			],
			[
				{ name: "Other", address: "studio.example.com" },
				{ kind: "host-taken", name: "Studio" },
			],
			[
				{ name: "Other", address: "127.0.0.1" },
				{ kind: "address", code: "ip-address" },
			],
			[
				{ name: "Other", address: "omp.example.com:8443" },
				{ kind: "address", code: "port" },
			],
			[
				{ name: "Other", address: "http://omp.example.com" },
				{ kind: "address", code: "not-https" },
			],
			[
				{ name: "Other", address: "printer.local" },
				{ kind: "address", code: "local-name" },
			],
			[
				{ name: "Other", address: "team.cloudflareaccess.com" },
				{ kind: "address", code: "access-domain" },
			],
		];
		for (const [body, problem] of refused) {
			const res = await here("/api/macs", "POST", body);
			expect(res.status, JSON.stringify(body)).toBe(400);
			const answer = (await res.json()) as { error: string; problem?: unknown };
			expect(answer.problem, JSON.stringify(body)).toEqual(problem);
			expect(answer.error.length).toBeGreaterThan(0);
		}
		// A body that is no object, or no JSON, is refused too.
		for (const raw of ["[]", "not json", '"x"'])
			expect(
				(await fetch(`${s.url}/api/macs`, { method: "POST", headers: headers(true), body: raw })).status,
				raw,
			).toBe(400);
		expect(await snapshot()).toEqual(before);
	});

	test("renames, notes a connection and pins the team once, by id in either case", async () => {
		const [mac] = (await meta()).macs;
		const id = (mac as SavedMac).id;
		const renamed = await here(`/api/macs/${id}/rename`, "POST", { name: "Studio Mac" });
		expect(renamed.status).toBe(200);
		expect(((await renamed.json()) as { mac: MacRecord }).mac.name).toBe("Studio Mac");
		// A name another Mac has is refused; its own name in another case is its own.
		await add("Laptop", "laptop.example.com");
		const clash = await here(`/api/macs/${id}/rename`, "POST", { name: "laptop" });
		expect(clash.status).toBe(400);
		expect(((await clash.json()) as { problem: MacProblem }).problem).toEqual({
			kind: "name",
			code: "taken",
			taken: "Laptop",
		});
		expect((await here(`/api/macs/${id}/rename`, "POST", { name: "STUDIO MAC" })).status).toBe(200);

		const connected = await here(`/api/macs/${id.toUpperCase()}/connected`, "POST");
		expect(connected.status).toBe(200);
		const at = ((await connected.json()) as { mac: MacRecord }).mac.lastConnected;
		expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
		expect((await meta()).macs.find((m) => m.id === id)?.lastConnected).toBe(at);

		expect(
			((await (await here(`/api/macs/${id}/team`, "POST", { team: "myteam" })).json()) as { mac: MacRecord }).mac.team,
		).toBe("myteam");
		// The first team is the one kept; what is no team is not kept.
		expect(
			((await (await here(`/api/macs/${id}/team`, "POST", { team: "other" })).json()) as { mac: MacRecord }).mac.team,
		).toBe("myteam");
		expect(stored().macs.find((m) => m.id === id)?.team).toBe("myteam");
		expect((await here(`/api/macs/${id}/rename`, "POST", { name: "Studio Mac" })).status).toBe(200);
	});

	test("answers an id it does not have with 404, a method it does not take with 405, and a path it does not have with 404", async () => {
		const ghost = "0f8fad5b-d9cb-469f-a165-70867728950e";
		expect((await here(`/api/macs/${ghost}/rename`, "POST", { name: "x" })).status).toBe(404);
		expect((await here(`/api/macs/${ghost}`, "DELETE")).status).toBe(404);
		expect((await here("/api/macs")).status).toBe(405);
		expect((await here("/api/macs", "DELETE")).status).toBe(405);
		expect((await here("/api/macs/not-an-id", "DELETE")).status).toBe(404);
		expect((await here(`/api/macs/${ghost}/unknown`, "POST", {})).status).toBe(404);
	});

	test("every page is told when the list changed, so a switcher open on another page follows", async () => {
		const ws = await connect(s);
		try {
			const { promise: told, resolve } = Promise.withResolvers<void>();
			ws.addEventListener("message", (ev) => {
				const message: unknown = JSON.parse(String(ev.data));
				if (isRecord(message) && message.t === "macs_changed") resolve();
			});
			await add("Third", "third.example.com");
			await told;
		} finally {
			ws.close();
		}
	});

	test("a Mac is removed from the list and from the file", async () => {
		const third = (await meta()).macs.find((m) => m.name === "Third") as SavedMac;
		expect((await here(`/api/macs/${third.id}`, "DELETE")).status).toBe(200);
		expect((await meta()).macs.map((m) => m.name)).toEqual(["Studio Mac", "Laptop"]);
		expect(stored().macs.map((m) => m.name)).toEqual(["Studio Mac", "Laptop"]);
	});

	test("holds at most ten", async () => {
		const have = (await meta()).macs.length;
		for (let i = have; i < MAC_LIMIT; i++) await add(`Extra ${i}`, `extra${i}.example.com`);
		const res = await here("/api/macs", "POST", { name: "One too many", address: "toomany.example.com" });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { problem: MacProblem }).problem).toEqual({ kind: "full" });
		expect((await meta()).macs.length).toBe(MAC_LIMIT);
	});
});

describe("a Mac's sign-in, handed over by the app on this computer", () => {
	test("is kept in memory, listed in meta as a date and never as the token, and taken back", async () => {
		const [studio] = (await meta()).macs as [MacListing];
		const res = await here(`/api/macs/${studio.id.toUpperCase()}/sign-in`, "POST", { jwt: SIGN_IN });
		expect(res.status).toBe(200);
		const until = new Date(SIGN_IN_EXP * 1000).toISOString();
		expect(await res.json()).toEqual({ signedInUntil: until });
		const listed = (await meta()).macs.find((m) => m.id === studio.id);
		expect(listed?.signedInUntil).toBe(until);
		expect(JSON.stringify(await meta())).not.toContain(SIGN_IN);
		// Nothing of it is written: not in the list's file, nor in any other file of the data dir.
		for (const name of readdirSync(join(s.root, "data"), { recursive: true }).map(String)) {
			const path = join(s.root, "data", name);
			if (!existsSync(path) || !statSync(path).isFile()) continue;
			expect(readFileSync(path, "utf8").includes(SIGN_IN), name).toBe(false);
		}
		expect((await here(`/api/macs/${studio.id}/sign-in`, "DELETE")).status).toBe(204);
		expect((await meta()).macs.find((m) => m.id === studio.id)?.signedInUntil).toBeNull();
	});

	test("a token that is not one, or has lapsed, is refused with 400; an id not on the list with 404", async () => {
		const [studio] = (await meta()).macs as [MacListing];
		expect((await here(`/api/macs/${studio.id}/sign-in`, "POST", { jwt: "garbage-value" })).status).toBe(400);
		const lapsed = `${b64url({ alg: "RS256" })}.${b64url({ exp: SIGN_IN_EXP - 7 * 3600 })}.c2ln`;
		expect((await here(`/api/macs/${studio.id}/sign-in`, "POST", { jwt: lapsed })).status).toBe(400);
		expect((await here(`/api/macs/${studio.id}/sign-in`, "POST", {})).status).toBe(400);
		expect((await meta()).macs.find((m) => m.id === studio.id)?.signedInUntil).toBeNull();
		const ghost = "0f8fad5b-d9cb-469f-a165-70867728950e";
		expect((await here(`/api/macs/${ghost}/sign-in`, "POST", { jwt: SIGN_IN })).status).toBe(404);
	});
});

describe("a conversation's remote computers", () => {
	test("are changed from the person's own page only, and only for a conversation that runs", async () => {
		const tunnelled = await tunnel("/api/remote-run/live", "POST", { liveId: "L0", macIds: [] });
		expect(tunnelled.status).toBe(403);
		expect(((await tunnelled.json()) as { error: string }).error).toContain("Remote computers");
		expect((await here("/api/remote-run/live", "POST", { liveId: "L0", macIds: [] })).status).toBe(404);
		expect((await here("/api/remote-run/live")).status).toBe(405);
	});
});

describe("another computer copying files from and to this one (remote_copy)", () => {
	const ask = (path: string, method = "GET", body?: Uint8Array<ArrayBuffer>, through = false) =>
		fetch(`${s.url}${path}`, {
			method,
			headers: headers(
				method !== "GET",
				through ? { "cf-ray": "8c1f2d3e4a5b6c7d-FRA", "cf-connecting-ip": "203.0.113.9" } : {},
			),
			body,
		});
	const logged = () =>
		readFileSync(join(s.root, "data", "transfers.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as { kind: string; who: string; path: string; status: string });

	test("a page that holds only the token is refused every copy route, and nothing is read or written", async () => {
		writeFileSync(join(s.home, "secret.txt"), "mine");
		for (const [method, path] of [
			["GET", "/api/remote-run/file?path=~/secret.txt"],
			["POST", "/api/remote-run/file?path=~/dropped.txt&kind=file&size=1&bytes=1"],
			["PUT", "/api/remote-run/file/0123456789abcdef0123456789abcdef?offset=0"],
			["DELETE", "/api/remote-run/file/0123456789abcdef0123456789abcdef"],
		]) {
			const res = await ask(path, method, undefined, true);
			expect(res.status, `${method} ${path}`).toBe(403);
			expect(((await res.json()) as { error: string }).error).toContain("Remote computers");
		}
		expect(existsSync(join(s.home, "dropped.txt"))).toBe(false);
	});

	test("the person's own page reads a file and puts one in place, in pieces; both are logged", async () => {
		writeFileSync(join(s.home, "hello.txt"), "hello\n");
		const got = await ask("/api/remote-run/file?path=~/hello.txt");
		expect(got.status).toBe(200);
		expect(got.headers.get("x-omp-webui-kind")).toBe("file");
		expect(await got.text()).toBe("hello\n");

		const body = new TextEncoder().encode("copied\n");
		const begun = await ask(
			`/api/remote-run/file?path=~/in/copied.txt&kind=file&size=${body.length}&bytes=${body.length}`,
			"POST",
		);
		expect(begun.status).toBe(200);
		const { id } = (await begun.json()) as { id: string };
		expect((await ask(`/api/remote-run/file/${id}?offset=0`, "PUT", body)).status).toBe(200);
		const done = await ask(`/api/remote-run/file/${id}`, "POST");
		expect(await done.json()).toMatchObject({ kind: "file", files: 1, bytes: body.length, replaced: false });
		expect(readFileSync(join(s.home, "in", "copied.txt"), "utf8")).toBe("copied\n");
		// Not again, unless asked.
		const again = await ask(`/api/remote-run/file?path=~/in/copied.txt&kind=file&size=1&bytes=1`, "POST");
		expect(again.status).toBe(409);
		expect(await again.json()).toMatchObject({ code: "exists" });
		// Nor into the app's own data.
		const data = await ask(
			`/api/remote-run/file?path=${encodeURIComponent(join(s.root, "data", "x"))}&kind=file&size=1&bytes=1`,
			"POST",
		);
		expect(data.status).toBe(403);
		const lines = logged().filter((l) => l.kind.startsWith("copy-"));
		expect(lines.map((l) => [l.kind, l.who, l.status])).toEqual([
			["copy-send", "local", "ok"],
			["copy-receive", "local", "ok"],
			["copy-receive", "local", "refused:exists"],
			["copy-receive", "local", "refused:ownData"],
		]);
	});
});

describe("a page that is not this computer's", () => {
	test("reads the list in meta and is refused every route that changes it, whatever it holds", async () => {
		const [studio] = (await meta()).macs as [MacListing];
		const before = await snapshot();
		const attempts: [string, string, unknown][] = [
			["POST", "/api/macs", { name: "Intruder", address: "evil.example.com" }],
			["POST", `/api/macs/${studio.id}/rename`, { name: "Renamed" }],
			["POST", `/api/macs/${studio.id}/connected`, {}],
			["POST", `/api/macs/${studio.id}/team`, { team: "evil" }],
			["DELETE", `/api/macs/${studio.id}`, undefined],
			["POST", `/api/macs/${studio.id}/sign-in`, { jwt: SIGN_IN }],
			["DELETE", `/api/macs/${studio.id}/sign-in`, undefined],
			["GET", "/api/macs", undefined],
		];
		// Through the tunnel: a loopback connection that carries what Cloudflare adds.
		for (const [method, path, body] of attempts)
			expect((await tunnel(path, method, body)).status, `tunnel ${method} ${path}`).toBe(403);
		// Through a proxy that rewrote the Host to the loopback name.
		for (const [method, path, body] of attempts) {
			const res = await fetch(`${s.url}${path}`, {
				method,
				headers: headers(method !== "GET", { "x-forwarded-for": "198.51.100.7" }),
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			expect(res.status, `proxy ${method} ${path}`).toBe(403);
		}
		expect(await snapshot()).toEqual(before);

		// What it may do is read: the same list, through meta, as a page that came in through the tunnel (and is told so).
		const told = await (await tunnel("/api/meta")).json();
		expect(told.remote).toBe(true);
		expect(told.macs).toEqual(before.page.macs);
	});

	test.skipIf(LAN === undefined)(
		"a peer on the network is refused them too, and a request that says it is the loopback does not make it one",
		async () => {
			const [studio] = (await meta()).macs as [MacListing];
			const before = await snapshot();
			const port = Number(new URL(s.url).port);
			const from = (method: string, path: string, body: unknown, extra: Record<string, string> = {}) =>
				rawRequest({
					host: "127.0.0.1",
					port,
					from: LAN,
					method,
					path,
					headers: headers(method !== "GET", extra),
					body: body === undefined ? undefined : JSON.stringify(body),
				});
			const extras: Record<string, string>[] = [{}, { "sec-fetch-site": "same-origin" }, { origin: s.url }];
			for (const extra of extras) {
				expect((await from("POST", "/api/macs", { name: "Intruder", address: "evil.example.com" }, extra)).status).toBe(
					403,
				);
				expect((await from("POST", `/api/macs/${studio.id}/rename`, { name: "Renamed" }, extra)).status).toBe(403);
				expect((await from("DELETE", `/api/macs/${studio.id}`, undefined, extra)).status).toBe(403);
				expect((await from("POST", `/api/macs/${studio.id}/sign-in`, { jwt: SIGN_IN }, extra)).status).toBe(403);
			}
			expect(await snapshot()).toEqual(before);
		},
	);

	test("a page with no token is not served the list at all", async () => {
		expect(
			(await fetch(`${s.url}/api/macs`, { method: "POST", headers: { "x-omp-webui": "1" }, body: "{}" })).status,
		).toBe(401);
		expect((await fetch(`${s.url}/api/meta`)).status).toBe(401);
	});
});

describe("what the macOS app saved before the server kept the list", () => {
	let old: TestServer;
	beforeAll(async () => {
		old = await startTestServer(0, {}, { login: false });
		// The file as v0.11.12's app wrote it: UPPER-case UUIDs, a pinned team, a connection time, one entry the rules refuse.
		const data = join(old.root, "data");
		mkdirSync(data, { recursive: true });
		writeFileSync(
			join(data, "remote-macs.json"),
			`${JSON.stringify(
				{
					version: 1,
					macs: [
						{
							added: "2026-10-23T09:00:00Z",
							host: "omp.example.com",
							id: "6F1C1B7E-7B7A-4E0B-9E27-0C7E0A6C1D11",
							lastConnected: "2026-10-24T18:30:00Z",
							name: "Mac A",
							storeId: "A4B2C3D4-0000-4000-8000-0123456789AB",
							team: "myteam",
						},
						{
							added: "2026-10-23T09:00:00Z",
							host: "127.0.0.1",
							id: "6F1C1B7E-7B7A-4E0B-9E27-0C7E0A6C1D12",
							lastConnected: null,
							name: "Not a Mac",
							storeId: "A4B2C3D4-0000-4000-8000-0123456789AC",
							team: null,
						},
					],
				},
				null,
				2,
			)}\n`,
			{ mode: 0o600 },
		);
	}, 120_000);
	afterAll(async () => {
		await old?.stop();
	});

	test("is the list from the first request: the entries that fit are listed, as they are, and the file is kept as it was until a change", async () => {
		const text = readFileSync(join(old.root, "data", "remote-macs.json"), "utf8");
		const res = await fetch(`${old.url}/api/meta`, { headers: { "x-omp-webui-token": old.accessToken } });
		const listed = ((await res.json()) as { macs: MacListing[] }).macs;
		expect(listed).toEqual([
			{
				id: "6F1C1B7E-7B7A-4E0B-9E27-0C7E0A6C1D11",
				name: "Mac A",
				host: "omp.example.com",
				lastConnected: "2026-10-24T18:30:00Z",
				signedInUntil: null,
			},
		]);
		expect(readFileSync(join(old.root, "data", "remote-macs.json"), "utf8")).toBe(text);

		// The first change writes the list whole and keeps what could not be trusted beside it; the Mac keeps its identifiers.
		const add = await fetch(`${old.url}/api/macs`, {
			method: "POST",
			headers: { "x-omp-webui-token": old.accessToken, "x-omp-webui": "1", "content-type": "application/json" },
			body: JSON.stringify({ name: "Mac B", address: "b.example.com" }),
		});
		expect(add.status).toBe(200);
		const after = JSON.parse(readFileSync(join(old.root, "data", "remote-macs.json"), "utf8")) as { macs: MacRecord[] };
		expect(after.macs[0]).toMatchObject({
			id: "6F1C1B7E-7B7A-4E0B-9E27-0C7E0A6C1D11",
			storeId: "A4B2C3D4-0000-4000-8000-0123456789AB",
			team: "myteam",
		});
		expect(readdirSync(join(old.root, "data")).filter((n) => n.startsWith("remote-macs.json"))).toContain(
			"remote-macs.json.damaged",
		);
		expect(readFileSync(join(old.root, "data", "remote-macs.json.damaged"), "utf8")).toBe(text);
		expectMode(join(old.root, "data", "remote-macs.json"), 0o600);
	});
});
