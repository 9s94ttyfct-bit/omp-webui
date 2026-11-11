import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../server/omp/run.ts";
import { platform } from "../../server/platform/index.ts";

/**
 * The Trash command the delete dialogs use on macOS (`/usr/bin/trash`, `platform.trash`): a folder given to it leaves its
 * place and is in the Trash, with what was in it. The test takes its folder out of the Trash again.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-trash-mac-"));
const name = `ompw-trash-probe-${process.pid}-${Date.now()}`;
const trashed = () => readdirSync(join(homedir(), ".Trash")).filter((f) => f.startsWith(name));
afterAll(() => {
	rmSync(root, { recursive: true, force: true });
	for (const f of existsSync(join(homedir(), ".Trash")) ? trashed() : [])
		rmSync(join(homedir(), ".Trash", f), { recursive: true, force: true });
});

test.skipIf(platform.id !== "darwin")("a folder given to the Trash command is in the Trash, whole", async () => {
	const command = platform.trash?.command();
	expect(command).toBe("/usr/bin/trash");
	const folder = join(root, name);
	mkdirSync(join(folder, "node_modules"), { recursive: true });
	writeFileSync(join(folder, "index.js"), "1");
	const r = await run([command as string, folder], { timeoutMs: 60_000 });
	expect(r.code).toBe(0);
	expect(existsSync(folder)).toBe(false);
	const [inTrash] = trashed();
	expect(inTrash).toBeDefined();
	expect(existsSync(join(homedir(), ".Trash", inTrash, "index.js"))).toBe(true);
});
