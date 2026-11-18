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
