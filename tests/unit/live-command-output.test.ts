import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Live, LivePool } from "../../server/live.ts";
import { isRecord } from "../../shared/guards.ts";
import { fakeConfig, writeFakeOmp } from "../support/fake-omp.ts";
import { removeScratch } from "../support/scratch.ts";

/**
 * What a builtin command prints (`command_output`) when the server runs one of its own (`Live.command`: auto-title's
 * `/rename`, which prints when the model has a title) while a page runs another: each printout goes where its command
 * came from. Against a scripted omp, no model.
 */

const dirs: string[] = [];
const pools: LivePool[] = [];

afterEach(async () => {
	for (const pool of pools.splice(0)) await pool.shutdown();
	for (const d of dirs.splice(0)) removeScratch(d);
});

/** A tab that listens: every frame the server sent it. */
function tab(live: Live): Record<string, unknown>[] {
	const frames: Record<string, unknown>[] = [];
	live.subscribers.add({
		send: (m: unknown) => {
			const msg = m as Record<string, unknown>;
			if (msg.t === "frame" && isRecord(msg.frame)) frames.push(msg.frame);
		},
	});
	return frames;
}

test("a page's builtin command typed while the server waits for its /rename's title prints on the pages, and the title does not (#51)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ompw-live-command-"));
	dirs.push(dir);
	const bin = writeFakeOmp(dir, {
		builtins: {
			// The title comes when the model has one: after omp answered the command.
			"/rename": { text: 'Session renamed to "A title"', afterMs: 300 },
			"/session": { text: "Session: fake" },
		},
	});
	const pool = new LivePool(fakeConfig(dir, bin));
	pools.push(pool);
	const live = await pool.open({ kind: "new", cwd: tmpdir() }, async () => null);
	const frames = tab(live);
	const title = live.command("/rename", {}, 45_000);
	const typed = await live.rpc({ type: "prompt", message: "/session" });
	expect(typed.success).toBe(true);
	expect(await title).toBe('Session renamed to "A title"');
	const printed = frames.filter((f) => f.type === "command_output").map((f) => f.text);
	expect(printed).toEqual(["Session: fake"]);
});
