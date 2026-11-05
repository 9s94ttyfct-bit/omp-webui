import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holdStart } from "../../server/instance.ts";

/**
 * The start of a data folder's server is held by one launcher at a time (`holdStart`, #175): a second one waits for the first
 * to let go, and a hold left by a process that is gone stands in nobody's way.
 */

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const scratch = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "ompw-start-lock-"));
	dirs.push(dir);
	return dir;
};

test("a second launcher waits until the first lets go, then holds the start itself", async () => {
	const dir = scratch();
	const letGo = await holdStart(dir);
	let held = false;
	const second = holdStart(dir).then((release) => {
		held = true;
		return release;
	});
	// That it is still waiting can only be seen by letting real time pass: it polls the hold on the clock.
	await Bun.sleep(400);
	expect(held).toBe(false);
	letGo();
	const release = await second;
	expect(held).toBe(true);
	release();
	// Nothing is left in the folder: neither the hold nor the file it was made from.
	expect(readdirSync(dir)).toEqual([]);
});

test("a hold kept longer than the wait allows is an error that names its process", async () => {
	const dir = scratch();
	const letGo = await holdStart(dir);
	try {
		await expect(holdStart(dir, 300)).rejects.toThrow(`another omp-webui (pid ${process.pid}) is still starting`);
	} finally {
		letGo();
	}
});

test("a hold left by a process that is gone, or one that cannot be read, is taken over at once", async () => {
	for (const left of [
		// 2^22 is above any pid macOS and Linux hand out.
		JSON.stringify({ pid: 4_194_304, command: "omp-webui" }),
		// This process's pid with another command: the pid was reused.
		JSON.stringify({ pid: process.pid, command: "something else" }),
		"{",
	]) {
		const dir = scratch();
		writeFileSync(join(dir, "start.lock"), left);
		const started = Date.now();
		const letGo = await holdStart(dir, 5_000);
		expect(Date.now() - started).toBeLessThan(2_000);
		letGo();
		expect(existsSync(join(dir, "start.lock"))).toBe(false);
	}
});

test("the data folder is made when there is none", async () => {
	const dir = join(scratch(), "new", "data");
	const letGo = await holdStart(dir);
	expect(existsSync(join(dir, "start.lock"))).toBe(true);
	letGo();
});
