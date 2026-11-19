import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SemanticService } from "../../server/semantic/service.ts";
import { UpdateCancelled } from "../../server/update/steps.ts";
import { removeScratch } from "../support/scratch.ts";

/**
 * "Turn off and delete" while the install is still unpacking: `tar` does not stop when the install is cancelled, and what it
 * moves into place once it finishes must not outlive the deletion.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-semservice-"));
afterAll(() => removeScratch(root));

test("turning off during an unpack leaves nothing of it behind", async () => {
	const data = join(root, "data");
	mkdirSync(data, { recursive: true });
	const { promise: unpacked, resolve: finishUnpack } = Promise.withResolvers<void>();
	let started = false;
	const service = new SemanticService({
		dataDir: data,
		ftsPath: join(data, "index.search.db"),
		describe: async () => new Map(),
		supported: true,
		// An unpack that pays no attention to the signal, moves the build in when it is done, and only then sees the cancel.
		install: async (dir) => {
			started = true;
			await unpacked;
			mkdirSync(join(dir, "runtime-b1"), { recursive: true });
			writeFileSync(join(dir, "runtime-b1", "llama-server"), "x");
			throw new UpdateCancelled();
		},
	});
	service.turnOn();
	expect(started).toBe(true);
	const off = service.turnOff();
	setTimeout(finishUnpack, 50);
	await off;
	// Whatever the unpack does once it finishes has been done by now.
	await unpacked;
	await Bun.sleep(20);
	expect(existsSync(service.dir)).toBe(false);
	expect(service.status(true).state).toBe("off");
});

test("a folder and a date bound are applied before the closest conversations are taken (#211)", async () => {
	const data = join(root, "data-scope");
	mkdirSync(data, { recursive: true });
	const raw = (n: number) => ({
		file: `/s/${n}.jsonl`,
		entryId: `e${n}`,
		role: "user",
		snippet: `s${n}`,
		timestamp: "",
		score: 1 - n / 100,
	});
	const known = new Map<string, { title: string; cwd: string; modifiedAt: number }>([
		// The nearest conversations are in another project; the ones in `/p` are further down and one is old.
		...[1, 2, 3, 4, 5].map((n) => [`/s/${n}.jsonl`, { title: `t${n}`, cwd: "/other", modifiedAt: 5000 }] as const),
		["/s/6.jsonl", { title: "t6", cwd: "/p", modifiedAt: 5000 }] as const,
		["/s/7.jsonl", { title: "t7", cwd: "/p", modifiedAt: 100 }] as const,
		["/s/8.jsonl", { title: "t8", cwd: "/p", modifiedAt: 6000 }] as const,
	]);
	const asked: number[] = [];
	const service = new SemanticService({
		dataDir: data,
		ftsPath: join(data, "index.search.db"),
		describe: async () => known,
		supported: true,
	});
	// The index is a stand-in that answers as many conversations as it is asked for, nearest first.
	(service as unknown as { index: unknown }).index = {
		search: async (_q: string, max: number) => {
			asked.push(max);
			return [1, 2, 3, 4, 5, 6, 7, 8].slice(0, max).map(raw);
		},
	};
	// Unscoped: the closest `max` of all, as before.
	expect((await service.search("query", 3)).map((h) => h.file)).toEqual(["/s/1.jsonl", "/s/2.jsonl", "/s/3.jsonl"]);
	expect(asked).toEqual([3]);
	// A folder: the nearest of that folder, though five others are nearer than any of them.
	expect((await service.search("query", 2, undefined, { folder: "/p" })).map((h) => h.file)).toEqual([
		"/s/6.jsonl",
		"/s/7.jsonl",
	]);
	// A folder and a date: the old one is out too.
	expect((await service.search("query", 5, undefined, { folder: "/p", since: 1000 })).map((h) => h.file)).toEqual([
		"/s/6.jsonl",
		"/s/8.jsonl",
	]);
	// The index was asked for more than `max` when scoped, so there is something to choose from.
	expect(asked[1]).toBeGreaterThan(2);
});
