import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessOverlay } from "../../server/omp/approval.ts";

/** A running conversation's overlay stays while its process runs (#30): written again when something took it away. */

const work = mkdtempSync(join(tmpdir(), "ompw-overlay-keep-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const until = async (what: string, ok: () => boolean, ms = 3000) => {
	const end = Date.now() + ms;
	while (!ok()) {
		if (Date.now() > end) throw new Error(`timed out: ${what}`);
		await Bun.sleep(10);
	}
};

test("a file that was taken away, and its folder, come back with what the conversation was set to", async () => {
	const file = join(work, "run", "live-1.yml");
	const overlay = new ProcessOverlay(file, "yolo", 0);
	try {
		await overlay.set("yolo");
		const written = readFileSync(file, "utf8");
		overlay.keep(10);
		rmSync(join(work, "run"), { recursive: true, force: true });
		await until("the file is written again", () => existsSync(file));
		expect(readFileSync(file, "utf8")).toBe(written);
	} finally {
		overlay.remove();
	}
});

test("an overlay that was removed (its conversation ended) is not written again", async () => {
	const file = join(work, "ended", "live-2.yml");
	const overlay = new ProcessOverlay(file, "yolo", 0);
	await overlay.set("yolo");
	overlay.keep(10);
	overlay.remove();
	expect(existsSync(file)).toBe(false);
	await Bun.sleep(80);
	expect(existsSync(file)).toBe(false);
});

test("a file that is there is left as it is: the content and the modification time stay, the access time is renewed", async () => {
	const file = join(work, "stale", "live-3.yml");
	const overlay = new ProcessOverlay(file, "yolo", 0);
	try {
		await overlay.set("yolo");
		const long = new Date(Date.now() - 10 * 24 * 3_600_000);
		utimesSync(file, long, long);
		// Its time stamps were last renewed a day ago: due.
		(overlay as unknown as { stamped: number }).stamped = Date.now() - 24 * 3_600_000;
		const before = readFileSync(file, "utf8");
		overlay.check();
		const after = statSync(file);
		expect(readFileSync(file, "utf8")).toBe(before);
		expect(after.mtime.getTime()).toBe(long.getTime());
		expect(Date.now() - after.atime.getTime()).toBeLessThan(60_000);
	} finally {
		overlay.remove();
	}
});
