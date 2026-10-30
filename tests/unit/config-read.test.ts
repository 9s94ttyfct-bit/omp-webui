import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigRead } from "../../server/omp/config-read.ts";

/**
 * A read of omp's config (`omp config get`) costs a whole omp start (about 0.15 s and 140 MB). Everyone who asks while
 * the file it reads is as it was shares one run, and a change to the file is seen at once, not on a timer.
 */

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function configFile(text: string): string {
	const dir = mkdtempSync(join(tmpdir(), "ompw-config-read-"));
	dirs.push(dir);
	const file = join(dir, "config.yml");
	writeFileSync(file, text);
	return file;
}

/** A read of the file's text that is counted, and held open until the test lets it answer. */
function counted(file: string) {
	const gates: (() => void)[] = [];
	const starts: (() => void)[] = [];
	let reads = 0;
	const read = async (): Promise<string> => {
		reads++;
		const text = await Bun.file(file).text();
		const gate = Promise.withResolvers<void>();
		gates.push(gate.resolve);
		for (const started of starts.splice(0)) started();
		await gate.promise;
		return text;
	};
	return {
		read,
		reads: () => reads,
		/** Resolves once a read has taken the file's text (it is then waiting to be answered). */
		nextStart: () => new Promise<void>((resolve) => starts.push(resolve)),
		answer: () => {
			for (const open of gates.splice(0)) open();
		},
	};
}

test("everyone who asks at once shares one read, and asking again while the file is as it was reads nothing", async () => {
	const file = configFile("a: 1\n");
	const probe = counted(file);
	const config = new ConfigRead(file, probe.read);

	// What a reconnect does: one question for omp's own value and one for each conversation shown.
	const began = probe.nextStart();
	const burst = Array.from({ length: 11 }, () => config.get());
	await began;
	probe.answer();
	expect(await Promise.all(burst)).toEqual(Array(11).fill("a: 1\n"));
	expect(probe.reads()).toBe(1);

	// A popover that opens later finds it.
	expect(await config.get()).toBe("a: 1\n");
	expect(probe.reads()).toBe(1);
});

test("a change to the file is read at once: nothing waits for a timer or a file event", async () => {
	const file = configFile("a: 1\n");
	const probe = counted(file);
	const config = new ConfigRead(file, probe.read);
	const began = probe.nextStart();
	const first = config.get();
	await began;
	probe.answer();
	expect(await first).toBe("a: 1\n");

	// The terminal changed omp's config; the very next question gets the new value.
	writeFileSync(file, "a: 2\nb: 3\n");
	const nextBegan = probe.nextStart();
	const second = config.get();
	await nextBegan;
	probe.answer();
	expect(await second).toBe("a: 2\nb: 3\n");
	expect(probe.reads()).toBe(2);
});

test("a question after the file changed never joins a read that began before the change", async () => {
	const file = configFile("a: 1\n");
	const probe = counted(file);
	const config = new ConfigRead(file, probe.read);
	const began = probe.nextStart();
	const early = config.get();
	// The read has taken the old text when the file changes.
	await began;
	writeFileSync(file, "a: 2\nb: 3\n");
	const lateBegan = probe.nextStart();
	const late = config.get();
	await lateBegan;
	probe.answer();
	expect(await early).toBe("a: 1\n");
	expect(await late).toBe("a: 2\nb: 3\n");
	expect(probe.reads()).toBe(2);
	// The old answer is not what is kept for the new file.
	expect(await config.get()).toBe("a: 2\nb: 3\n");
	expect(probe.reads()).toBe(2);
});

test("an answer omp could not give is not kept: the next question asks again", async () => {
	const file = configFile("a: 1\n");
	let reads = 0;
	const config = new ConfigRead<string>(file, async () => (++reads === 1 ? null : "a: 1\n"));
	expect(await config.get()).toBeNull();
	expect(await config.get()).toBe("a: 1\n");
	expect(await config.get()).toBe("a: 1\n");
	expect(reads).toBe(2);
});

test("a file that is not there yet is a state of its own: it is read, and read again once it exists", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ompw-config-read-"));
	dirs.push(dir);
	const file = join(dir, "config.yml");
	let reads = 0;
	const config = new ConfigRead<number>(file, async () => ++reads);
	expect(await config.get()).toBe(1);
	expect(await config.get()).toBe(1);
	writeFileSync(file, "a: 1\n");
	expect(await config.get()).toBe(2);
});
