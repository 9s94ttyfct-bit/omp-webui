import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionPins } from "../../server/sessions/pins.ts";
import { SessionStore } from "../../server/sessions/store.ts";
import { type SeededFixtures, seedFixtures } from "../support/fixtures.ts";

/**
 * The sidebar's pins are omp's own list (`session-pins.json`, session ids, oldest pin first). Changing it is omp's `/pin`
 * (tests/contract/pins.test.ts); what is checked here is what is read from it, and when no omp is asked.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-pins-"));
const agentDir = join(root, "agent");
const dataDir = join(root, "data");
const pinsFile = join(agentDir, "session-pins.json");
let fixtures: SeededFixtures;
let store: SessionStore;
let pins: SessionPins;
let toggled: string[] = [];

beforeAll(async () => {
	mkdirSync(dataDir, { recursive: true });
	fixtures = seedFixtures(agentDir);
	store = new SessionStore(join(agentDir, "sessions"), join(root, "index.db"));
	await store.list();
	// An omp that is not there: a toggle that is asked for fails, and is remembered.
	pins = new SessionPins(agentDir, dataDir, store, {
		async togglePin({ file }) {
			toggled.push(file);
			throw new Error("no omp here");
		},
	});
});
afterAll(() => {
	pins.close();
	store.close();
	rmSync(root, { recursive: true, force: true });
});

const idOf = async (file: string) => (await store.get(file))?.id as string;

test("the pinned conversations are those of the ids in omp's list, the newest pin first; ids of no conversation are skipped", async () => {
	expect(await pins.list()).toEqual([]);
	const alpha = await idOf(fixtures.alpha);
	const gamma = await idOf(fixtures.gamma);
	writeFileSync(pinsFile, JSON.stringify([alpha, "01a00000-0000-7000-8000-00000000dead", gamma], null, "\t"));
	expect(await pins.list()).toEqual([fixtures.gamma, fixtures.alpha]);
});

test("a pin that is as asked is not asked of omp", async () => {
	toggled = [];
	expect(await pins.set(fixtures.alpha, true)).toEqual([fixtures.gamma, fixtures.alpha]);
	expect(await pins.set(fixtures.beta, false)).toEqual([fixtures.gamma, fixtures.alpha]);
	expect(toggled).toEqual([]);
	// One that is not, is: and when omp cannot do it, the answer is the error.
	await expect(pins.set(fixtures.beta, true)).rejects.toThrow("no omp here");
	expect(toggled).toEqual([fixtures.beta]);
});

test("a list that is not readable is not toggled from, and shows no pins meanwhile", async () => {
	toggled = [];
	for (const text of ["", '["01a00000-0000', '{"pins":[]}']) {
		writeFileSync(pinsFile, text);
		expect(await pins.list()).toEqual([]);
		await expect(pins.set(fixtures.beta, true)).rejects.toThrow("cannot be read");
	}
	expect(toggled).toEqual([]);
});

test("pins moved from the data dir that cannot be moved now stay where they are", async () => {
	writeFileSync(pinsFile, "[]");
	const legacy = join(dataDir, "pins.json");
	writeFileSync(legacy, JSON.stringify([fixtures.beta]));
	toggled = [];
	await expect(pins.adoptLegacy()).rejects.toThrow("no omp here");
	expect(await Bun.file(legacy).exists()).toBe(true);
	expect(toggled).toEqual([fixtures.beta]);
	rmSync(legacy);
});

test("a change to omp's list is announced, wherever it was made", async () => {
	const alpha = await idOf(fixtures.alpha);
	// What the page does on an announcement: read the list. It is announced when what is read is what omp wrote.
	const changed = new Promise<void>((resolve) =>
		pins.onChange(async () => {
			if ((await pins.list()).includes(fixtures.alpha)) resolve();
		}),
	);
	// A directory's watcher is live a moment after `watch` returns (later when the machine is busy), and a file that is
	// written before that is never reported, by this watcher or any other on the directory. So omp's write is made again
	// until one is heard: what is asked is that a write of that kind is announced, and that write is all that is repeated.
	// The pause between writes is real on purpose: the OS's file events cannot be driven by fake timers, and it is only how
	// long a write waits to be heard before the next is made (the announcement itself is what the test awaits).
	let heard = false;
	while (!heard) {
		// omp writes beside the file and renames over it, the terminal's `/pin` among them.
		writeFileSync(`${pinsFile}.tmp`, JSON.stringify([alpha]));
		renameSync(`${pinsFile}.tmp`, pinsFile);
		heard = await Promise.race([changed.then(() => true), Bun.sleep(250).then(() => false)]);
	}
});
