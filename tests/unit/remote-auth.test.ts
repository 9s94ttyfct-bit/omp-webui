import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth } from "../../server/auth.ts";
import { RemoteAuth } from "../../server/remote-auth.ts";
import {
	type AccessKey,
	AUD,
	claims,
	EMAIL,
	HOSTNAME,
	ISSUER,
	type Jwks,
	makeKey,
	sign,
	startJwks,
	TEAM,
	withPayload,
} from "../support/access-jwt.ts";

/**
 * Which requests the public hostname lets in: only the ones that carry a valid Cloudflare Access token for this
 * application, from an allowed email, addressed to the configured hostname. Everything is checked against keys generated
 * here and served by a local stand-in for the team's certs endpoint.
 */

const MINUTE = 60_000;
const dirs: string[] = [];
let key: AccessKey;
let other: AccessKey;
let jwks: Jwks;

beforeAll(async () => {
	key = await makeKey("key-1");
	other = await makeKey("key-1"); // the same kid, another pair: what someone forging a token would use
	jwks = await startJwks([key]);
});
afterAll(() => jwks.stop());
afterEach(() => {
	jwks.keys = [key];
	jwks.mode = "ok";
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const GOOD = { enabled: true, hostname: HOSTNAME, team: TEAM, aud: AUD, emails: [EMAIL] };

interface World {
	remote: RemoteAuth;
	file: string;
	clock: { now: number };
	logged: string[];
	/** Rewrite the settings file. */
	write(settings: unknown): void;
	/** A request to `host` carrying `token` the way Cloudflare does (header), or as the cookie. */
	request(token: string | null, init?: { host?: string; origin?: string; cookie?: boolean }): Request;
	/** Claims of a valid token now. */
	claims(over?: Record<string, unknown>): Record<string, unknown>;
}

function world(settings: unknown = GOOD, options: { fetchTimeoutMs?: number } = {}): World {
	const dir = mkdtempSync(join(tmpdir(), "ompw-remote-"));
	dirs.push(dir);
	const file = join(dir, "remote.json");
	const clock = { now: Date.UTC(2026, 9, 21, 12, 0, 0) };
	const logged: string[] = [];
	const write = (value: unknown) => writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
	if (settings !== null) write(settings);
	return {
		remote: new RemoteAuth(file, { certsUrl: jwks.url, now: () => clock.now, log: (l) => logged.push(l), ...options }),
		file,
		clock,
		logged,
		write,
		request(token, init = {}) {
			const headers = new Headers({ host: init.host ?? HOSTNAME });
			if (init.origin) headers.set("origin", init.origin);
			if (token) {
				if (init.cookie) headers.set("cookie", `other=1; CF_Authorization=${token}`);
				else headers.set("cf-access-jwt-assertion", token);
			}
			return new Request(`http://${init.host ?? HOSTNAME}/api/meta`, { headers });
		},
		claims: (over) => claims(Math.floor(clock.now / 1000), over),
	};
}

describe("a valid token", () => {
	test("from the header Cloudflare adds is accepted, and says who it is from", async () => {
		const w = world();
		expect(await w.remote.verify(w.request(await sign(key, w.claims())))).toMatchObject({ email: EMAIL });
	});

	test("from the CF_Authorization cookie is accepted too", async () => {
		const w = world();
		expect(await w.remote.verify(w.request(await sign(key, w.claims()), { cookie: true }))).toMatchObject({
			email: EMAIL,
		});
	});

	test("says until when the token is good: its exp and the minute of skew, which an open socket is ended at (#548)", async () => {
		const w = world();
		const exp = Math.floor(w.clock.now / 1000) + 1234;
		const identity = await w.remote.verify(w.request(await sign(key, w.claims({ exp }))));
		expect(identity).toEqual({ email: EMAIL, validUntil: (exp + 60) * 1000 });
	});

	test("an email on the allow-list matches whatever its ASCII case, and is reported as the token has it", async () => {
		const w = world({ ...GOOD, emails: ["Other@Example.test", "ME@EXAMPLE.TEST"] });
		const token = await sign(key, w.claims({ email: "Me@Example.Test" }));
		expect(await w.remote.verify(w.request(token))).toMatchObject({ email: "Me@Example.Test" });
	});

	test("an email is compared as ASCII only: Unicode case folding never maps one address onto another (#551)", async () => {
		const w = world({ ...GOOD, emails: ["kate@example.test", "ice@example.test"] });
		for (const email of [
			"\u212Aate@example.test", // KELVIN SIGN: lowers to "k"
			"kate@example.test\u200b", // zero-width space after it
			"ka\u0442e@example.test", // Cyrillic te
			"\u0130ce@example.test", // I with dot above
			"ｋate@example.test", // fullwidth k
		]) {
			expect(await w.remote.verify(w.request(await sign(key, w.claims({ email })))), email).toBeNull();
		}
		expect(await w.remote.verify(w.request(await sign(key, w.claims({ email: "KATE@example.test" }))))).toMatchObject({
			email: "KATE@example.test",
		});
	});

	test("an allow-list entry that is not plain ASCII makes the whole file unusable: remote access stays off (#551)", async () => {
		const w = world({ ...GOOD, emails: ["\u212Aate@example.test"] });
		expect(w.remote.current()).toBeNull();
		expect(await w.remote.verify(w.request(await sign(key, w.claims({ email: "kate@example.test" }))))).toBeNull();
		// One bad entry is not half-read: a list that cannot be trusted is no list at all.
		const mixed = world({ ...GOOD, emails: ["\u212Aate@example.test", EMAIL] });
		expect(mixed.remote.current()).toBeNull();
	});

	test("the Origin of the page itself is accepted; Host is matched without regard to case", async () => {
		const w = world();
		const token = await sign(key, w.claims());
		expect(await w.remote.verify(w.request(token, { origin: `https://${HOSTNAME}` }))).not.toBeNull();
		expect(await w.remote.verify(w.request(token, { host: HOSTNAME.toUpperCase() }))).not.toBeNull();
	});

	test("an aud list that names the application among others is accepted", async () => {
		const w = world();
		const token = await sign(key, w.claims({ aud: ["f".repeat(64), AUD] }));
		expect(await w.remote.verify(w.request(token))).not.toBeNull();
	});

	test("exp and nbf may be off by up to a minute of clock skew, and no more", async () => {
		const w = world();
		const now = Math.floor(w.clock.now / 1000);
		const at = async (over: Record<string, unknown>) =>
			await w.remote.verify(w.request(await sign(key, w.claims(over))));
		expect(await at({ exp: now - 30 })).not.toBeNull();
		expect(await at({ nbf: now + 30 })).not.toBeNull();
		expect(await at({ exp: now - 90 })).toBeNull();
		expect(await at({ nbf: now + 90 })).toBeNull();
	});
});

describe("a request that is refused", () => {
	async function refused(w: World, token: string | null, init?: Parameters<World["request"]>[1]) {
		expect(await w.remote.verify(w.request(token, init))).toBeNull();
	}

	test("without a token: no header, no cookie", async () => {
		await refused(world(), null);
	});

	test("with a token that is not one", async () => {
		const w = world();
		for (const junk of ["x", "a.b.c", "a.b", "a.b.c.d", "...", "é.é.é", "a".repeat(20_000)]) await refused(w, junk);
	});

	test("with a bad signature: another key under the same kid, or a payload changed after signing", async () => {
		const w = world();
		await refused(w, await sign(other, w.claims()));
		const real = await sign(key, w.claims({ email: "someone@example.test" }));
		await refused(w, withPayload(real, w.claims()));
	});

	test("with a signature cut off or garbled", async () => {
		const w = world();
		const real = await sign(key, w.claims());
		await refused(w, real.slice(0, -10));
		await refused(w, `${real.slice(0, real.lastIndexOf(".") + 1)}AAAA`);
	});

	test("expired", async () => {
		const w = world();
		await refused(w, await sign(key, w.claims({ exp: Math.floor(w.clock.now / 1000) - 3600 })));
	});

	test("with no exp at all, or one that is no number", async () => {
		const w = world();
		await refused(w, await sign(key, w.claims({ exp: undefined })));
		await refused(w, await sign(key, w.claims({ exp: "9999999999" })));
	});

	test("not yet valid (nbf in the future)", async () => {
		const w = world();
		await refused(w, await sign(key, w.claims({ nbf: Math.floor(w.clock.now / 1000) + 3600 })));
	});

	test("for another application (wrong aud)", async () => {
		const w = world();
		await refused(w, await sign(key, w.claims({ aud: ["f".repeat(64)] })));
		await refused(w, await sign(key, w.claims({ aud: "f".repeat(64) })));
		await refused(w, await sign(key, w.claims({ aud: undefined })));
	});

	test("from another team (wrong iss)", async () => {
		const w = world();
		await refused(w, await sign(key, w.claims({ iss: "https://evil.cloudflareaccess.com" })));
		await refused(w, await sign(key, w.claims({ iss: `${ISSUER}/` })));
		await refused(w, await sign(key, w.claims({ iss: undefined })));
	});

	test("for an email that is not allowed, or none", async () => {
		const w = world();
		await refused(w, await sign(key, w.claims({ email: "intruder@example.test" })));
		await refused(w, await sign(key, w.claims({ email: "me@example.test.evil.test" })));
		await refused(w, await sign(key, w.claims({ email: undefined })));
		await refused(w, await sign(key, w.claims({ email: 42 })));
	});

	test("with an algorithm other than RS256, whatever the signature says", async () => {
		const w = world();
		const real = await sign(key, w.claims());
		const [, body, signature] = real.split(".");
		for (const alg of ["none", "HS256", "RS512", "rs256"]) {
			const head = Buffer.from(JSON.stringify({ alg, kid: key.kid })).toString("base64url");
			await refused(w, `${head}.${body}.${signature}`);
			await refused(w, `${head}.${body}.`);
		}
		await refused(w, await sign(key, w.claims(), { kid: undefined }));
	});

	test("to another Host: the port, a subdomain, a lookalike, none", async () => {
		const w = world();
		const token = await sign(key, w.claims());
		for (const host of [
			`${HOSTNAME}:443`,
			`${HOSTNAME}:7878`,
			`x.${HOSTNAME}`,
			`${HOSTNAME}.evil.test`,
			"127.0.0.1",
			"localhost",
		])
			await refused(w, token, { host });
		const noHost = new Request(`http://${HOSTNAME}/`, { headers: { "cf-access-jwt-assertion": token } });
		noHost.headers.delete("host");
		expect(await w.remote.verify(noHost)).toBeNull();
	});

	test("from another Origin: http, another host, a port, null", async () => {
		const w = world();
		const token = await sign(key, w.claims());
		for (const origin of [
			`http://${HOSTNAME}`,
			"https://evil.example.test",
			`https://${HOSTNAME}:8443`,
			`https://${HOSTNAME}.evil.test`,
			"null",
			"http://127.0.0.1:7878",
		])
			await refused(w, token, { origin });
	});

	test("when the header is wrong, a good cookie still counts; two bad ones do not", async () => {
		const w = world();
		const good = await sign(key, w.claims());
		const request = new Request(`http://${HOSTNAME}/`, {
			headers: { host: HOSTNAME, "cf-access-jwt-assertion": "garbage", cookie: `CF_Authorization=${good}` },
		});
		expect(await w.remote.verify(request)).not.toBeNull();
		const bad = await sign(other, w.claims());
		const two = new Request(`http://${HOSTNAME}/`, {
			headers: { host: HOSTNAME, "cf-access-jwt-assertion": bad, cookie: `CF_Authorization=${bad}` },
		});
		expect(await w.remote.verify(two)).toBeNull();
	});
});

describe("remote access that is off", () => {
	async function token(w: World) {
		return await sign(key, w.claims());
	}

	test("refuses a valid token: not enabled, no file, an unreadable file", async () => {
		for (const settings of [
			{ ...GOOD, enabled: false },
			{ ...GOOD, enabled: "yes" },
			null,
			"{not json",
			"[]",
			"null",
		]) {
			const w = world(settings);
			const request = w.request(await token(w));
			expect(await w.remote.verify(request), JSON.stringify(settings)).toBeNull();
			expect(w.remote.isPublicHost(HOSTNAME), JSON.stringify(settings)).toBe(false);
		}
	});

	test("refuses a valid token while anything it needs is missing or unusable", async () => {
		const bad: Record<string, unknown>[] = [
			{ ...GOOD, hostname: "" },
			{ ...GOOD, hostname: "localhost" },
			{ ...GOOD, hostname: "omp.example.test:443" },
			{ ...GOOD, hostname: "https://omp.example.test" },
			{ ...GOOD, team: "" },
			{ ...GOOD, team: "a.b" },
			{ ...GOOD, team: "acme/../x" },
			{ ...GOOD, aud: "" },
			{ ...GOOD, aud: 12 },
			{ ...GOOD, emails: [] },
			{ ...GOOD, emails: ["", "  "] },
			{ ...GOOD, emails: "me@example.test" },
		];
		for (const settings of bad) {
			const w = world(settings);
			expect(await w.remote.verify(w.request(await token(w))), JSON.stringify(settings)).toBeNull();
		}
	});

	test("the hostname is refused like any other foreign Host", () => {
		const w = world({ ...GOOD, enabled: false });
		expect(w.remote.isPublicHost(HOSTNAME)).toBe(false);
		expect(w.remote.current()).toBeNull();
	});

	test("turning it on or off in the file takes effect without a restart, and says so", async () => {
		const w = world({ ...GOOD, enabled: false });
		let changes = 0;
		w.remote.onChange(() => changes++);
		const valid = await token(w);
		expect(await w.remote.verify(w.request(valid))).toBeNull();

		w.write(GOOD);
		expect(await w.remote.verify(w.request(valid))).not.toBeNull();
		expect(w.remote.isPublicHost(HOSTNAME)).toBe(true);
		// A switch that does not decide who comes in is no change of the settings in force: the pages that are open stay.
		w.write({ ...GOOD, confirmRisky: true, fileTransfer: "off", remoteShell: false, autostart: true });
		expect(await w.remote.verify(w.request(valid))).not.toBeNull();
		expect(changes).toBe(1);

		w.write({ ...GOOD, emails: ["someone-else@example.test"] });
		expect(await w.remote.verify(w.request(valid))).toBeNull();

		w.write({ ...GOOD, enabled: false });
		expect(await w.remote.verify(w.request(valid))).toBeNull();
		expect(changes).toBe(3);
	});
});

describe("the team's keys", () => {
	test("are read once and kept, however many requests and however many at the same time", async () => {
		const w = world();
		const valid = await sign(key, w.claims());
		const before = jwks.hits;
		const answers = await Promise.all(Array.from({ length: 8 }, () => w.remote.verify(w.request(valid))));
		expect(answers.every((a) => a?.email === EMAIL)).toBe(true);
		expect(await w.remote.verify(w.request(valid))).not.toBeNull();
		expect(jwks.hits - before).toBe(1);
	});

	test("are read again for a kid they do not hold, at most once a minute", async () => {
		const w = world();
		const rotated = await makeKey("key-2");
		const first = await sign(key, w.claims());
		const second = await sign(rotated, w.claims());
		const before = jwks.hits;

		expect(await w.remote.verify(w.request(first))).not.toBeNull();
		// The team publishes a new key; nothing here knows yet.
		jwks.keys = [key, rotated];
		expect(await w.remote.verify(w.request(second))).toBeNull();
		expect(jwks.hits - before).toBe(1);

		// Asking again soon does not ask Cloudflare again: someone sending random kids must not make this a client of it.
		w.clock.now += 30_000;
		expect(await w.remote.verify(w.request(second))).toBeNull();
		expect(await w.remote.verify(w.request(await sign(await makeKey("key-3"), w.claims())))).toBeNull();
		expect(jwks.hits - before).toBe(1);

		// A minute after the last read, the unknown kid is looked for again, and found.
		w.clock.now += 31_000;
		expect(await w.remote.verify(w.request(second))).not.toBeNull();
		expect(jwks.hits - before).toBe(2);
		// The first key is still known.
		expect(await w.remote.verify(w.request(first))).not.toBeNull();
	});

	test("one a token names that nobody publishes is refused, and costs one read a minute", async () => {
		const w = world();
		const stranger = await sign(await makeKey("nobody"), w.claims());
		const before = jwks.hits;
		for (let i = 0; i < 5; i++) expect(await w.remote.verify(w.request(stranger))).toBeNull();
		expect(jwks.hits - before).toBe(1);
		w.clock.now += MINUTE + 1;
		expect(await w.remote.verify(w.request(stranger))).toBeNull();
		expect(jwks.hits - before).toBe(2);
	});

	test("a key the team withdrew stops being trusted once the keys are read again, within the hour", async () => {
		const w = world();
		const valid = await sign(key, w.claims());
		expect(await w.remote.verify(w.request(valid))).not.toBeNull();
		const replacement = await makeKey("key-9");
		jwks.keys = [replacement];

		w.clock.now += 30 * MINUTE;
		expect(await w.remote.verify(w.request(valid))).not.toBeNull(); // still held, not yet asked again
		w.clock.now += 31 * MINUTE;
		expect(await w.remote.verify(w.request(valid))).toBeNull();
		expect(await w.remote.verify(w.request(await sign(replacement, w.claims())))).not.toBeNull();
	});

	test("that cannot be had refuse the request, are tried again after a minute, and a key held before survives", async () => {
		const w = world();
		jwks.mode = "error";
		const valid = await sign(key, w.claims());
		const before = jwks.hits;
		expect(await w.remote.verify(w.request(valid))).toBeNull();
		expect(await w.remote.verify(w.request(valid))).toBeNull();
		expect(jwks.hits - before).toBe(1);

		jwks.mode = "ok";
		w.clock.now += MINUTE + 1;
		expect(await w.remote.verify(w.request(valid))).not.toBeNull();

		// Later the endpoint breaks: what is held keeps serving the people who are logged in.
		jwks.mode = "error";
		w.clock.now += 2 * 60 * MINUTE;
		expect(await w.remote.verify(w.request(await sign(key, w.claims())))).not.toBeNull();
	});

	test("that never answer do not hold the request longer than the timeout", async () => {
		const w = world(GOOD, { fetchTimeoutMs: 150 });
		jwks.mode = "hang";
		const started = performance.now();
		expect(await w.remote.verify(w.request(await sign(key, w.claims())))).toBeNull();
		expect(performance.now() - started).toBeLessThan(3000);
	});

	test("are not taken from a token's own claims: a token that carries its own jwk or jku is as good as any other", async () => {
		const w = world();
		const forged = await sign(other, w.claims(), { jwk: other.jwk, jku: "https://evil.example.test/keys" });
		expect(await w.remote.verify(w.request(forged))).toBeNull();
	});
});

describe("the log", () => {
	test("says once for each email and session that a remote page came in, with no token in it", async () => {
		const w = world();
		const now = Math.floor(w.clock.now / 1000);
		const first = await sign(key, w.claims());
		for (let i = 0; i < 3; i++) await w.remote.verify(w.request(first));
		expect(w.logged).toHaveLength(1);
		expect(w.logged[0]).toContain(EMAIL);
		expect(w.logged[0]).not.toContain(first);
		expect(w.logged[0]).not.toContain(first.split(".")[2]);

		await w.remote.verify(w.request(await sign(key, w.claims({ iat: now + 5 }))));
		expect(w.logged).toHaveLength(2);

		// Refused requests are not "access".
		await w.remote.verify(w.request(await sign(other, w.claims({ iat: now + 9 }))));
		expect(w.logged).toHaveLength(2);
	});
});

describe("the access-token cookie", () => {
	// A token in the environment: the data dir is never touched.
	const auth = new Auth(tmpdir(), { OMP_WEBUI_TOKEN: "secret-token" });

	test("is Secure when it goes through the tunnel, HttpOnly and SameSite=Strict always", () => {
		const secure = auth.cookieHeader(true);
		expect(secure).toStartWith("ompw_token=secret-token; Secure; HttpOnly; SameSite=Strict; Path=/");
		const local = auth.cookieHeader();
		expect(local).toStartWith("ompw_token=secret-token; HttpOnly; SameSite=Strict; Path=/");
		expect(local).not.toContain("Secure");
	});
});
