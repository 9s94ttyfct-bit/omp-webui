import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth } from "../../server/auth.ts";

/** The access token: an unusable token file must never switch authentication off. */

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dataDir(token?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "ompw-auth-"));
	dirs.push(dir);
	if (token !== undefined) writeFileSync(join(dir, "token"), token);
	return dir;
}

const request = (token?: string) =>
	new Request("http://127.0.0.1/api/meta", { headers: token === undefined ? {} : { "x-omp-webui-token": token } });

describe("a token file with no token in it", () => {
	for (const blank of ["", "\n", "  \t\n "]) {
		test(`${JSON.stringify(blank)} is treated as missing: a new token is generated and required`, () => {
			const dir = dataDir(blank);
			const auth = new Auth(dir, {});

			const token = auth.token as string;
			expect(token.length).toBeGreaterThanOrEqual(24);
			expect(auth.enabled).toBe(true);
			expect(readFileSync(join(dir, "token"), "utf8")).toBe(token);
			expect(statSync(join(dir, "token")).mode & 0o777).toBe(0o600);

			expect(auth.allowed(request())).toBe(false);
			expect(auth.allowed(request(""))).toBe(false);
			expect(auth.allowed(request("wrong"))).toBe(false);
			expect(auth.matches("")).toBe(false);
			expect(auth.matches(null)).toBe(false);
			expect(auth.allowed(request(token))).toBe(true);

			// The generated token is kept for the next start.
			expect(new Auth(dir, {}).token).toBe(token);
		});
	}
});

test("a stored token is kept, ignoring surrounding whitespace", () => {
	const auth = new Auth(dataDir("secret-token\n"), {});
	expect(auth.token).toBe("secret-token");
	expect(auth.allowed(request())).toBe(false);
	expect(auth.allowed(request("secret-token"))).toBe(true);
});

test("OMP_WEBUI_AUTH=off is the only way to run without a token", () => {
	const auth = new Auth(dataDir(""), { OMP_WEBUI_AUTH: "off" });
	expect(auth.token).toBeNull();
	expect(auth.enabled).toBe(false);
	expect(auth.allowed(request())).toBe(true);
});

describe("the cookie", () => {
	const cookie = (value: string) => new Request("http://127.0.0.1/api/meta", { headers: { cookie: value } });
	const auth = new Auth(dataDir("secret-token"), {});

	test("one that cannot be decoded presents nothing, and does not fail the request", () => {
		expect(auth.presented(cookie("ompw_token=%E0%A4%A"))).toEqual([]);
		expect(auth.allowed(cookie("ompw_token=%E0%A4%A"))).toBe(false);
		expect(auth.allowed(cookie("ompw_token=%"))).toBe(false);
	});

	test("every ompw_token cookie counts: another page's cookie in front of the real one does not shadow it", () => {
		expect(auth.presented(cookie("a=1; ompw_token=bad; ompw_token=secret%2Dtoken; xompw_token=no"))).toEqual([
			"bad",
			"secret-token",
		]);
		for (const value of [
			"ompw_token=bad; ompw_token=secret-token",
			"ompw_token=secret-token; ompw_token=bad",
			"ompw_token=%E0%A4%A; ompw_token=secret-token",
			"ompw_token=; ompw_token=secret-token",
		]) {
			expect(auth.allowed(cookie(value)), value).toBe(true);
		}
		expect(auth.allowed(cookie("ompw_token=bad; ompw_token=worse"))).toBe(false);
		expect(auth.allowed(cookie("xompw_token=secret-token"))).toBe(false);
	});

	test("the header and a cookie are alternatives: either one that matches lets the request in", () => {
		const both = new Request("http://127.0.0.1/api/meta", {
			headers: { "x-omp-webui-token": "wrong", cookie: "ompw_token=secret-token" },
		});
		expect(auth.allowed(both)).toBe(true);
	});
});
