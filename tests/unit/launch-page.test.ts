import { expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pageTarget, redirectPage, sweepPages } from "../../server/launch-page.ts";

/**
 * The launcher on Linux hands the browser a page that sends it on to the signed-in address, so that the data folder's
 * permanent token is in no command line, which every user of the machine can read (#287).
 */

const URL_WITH_TOKEN = "http://127.0.0.1:7878/?token=SECRET-TOKEN&x=1";

test("on Linux the browser is given a file that leads to the address, readable by this user only, and not the address", () => {
	const dir = mkdtempSync(join(tmpdir(), "ompw-launch-page-"));
	try {
		const target = pageTarget(URL_WITH_TOKEN, true, dir);
		expect(target).not.toContain("SECRET-TOKEN");
		expect(target.startsWith(dir)).toBe(true);
		const html = readFileSync(target, "utf8");
		expect(html).toContain(
			'<meta http-equiv="refresh" content="0;url=http://127.0.0.1:7878/?token=SECRET-TOKEN&amp;x=1">',
		);
		expect(statSync(target).mode & 0o077).toBe(0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("elsewhere the address itself is given, and nothing is written", () => {
	const dir = mkdtempSync(join(tmpdir(), "ompw-launch-page-"));
	try {
		expect(pageTarget(URL_WITH_TOKEN, false, dir)).toBe(URL_WITH_TOKEN);
		expect(readdirSync(dir)).toEqual([]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a page left by a launcher that ended is taken down by the next one, a fresh one and other files are kept", () => {
	const dir = mkdtempSync(join(tmpdir(), "ompw-launch-page-"));
	try {
		const old = join(dir, "open-old.html");
		const fresh = join(dir, "open-fresh.html");
		const other = join(dir, "token");
		for (const f of [old, fresh, other]) writeFileSync(f, "x");
		const longAgo = new Date(Date.now() - 10 * 60_000);
		utimesSync(old, longAgo, longAgo);
		sweepPages(dir);
		expect(existsSync(old)).toBe(false);
		expect(existsSync(fresh)).toBe(true);
		expect(existsSync(other)).toBe(true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the page escapes what would end its attribute", () => {
	expect(redirectPage('http://h/?a="b"&c=<d>')).toContain('content="0;url=http://h/?a=&quot;b&quot;&amp;c=&lt;d>">');
});
