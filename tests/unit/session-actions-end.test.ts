// needs: posixShell
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LivePool } from "../../server/live.ts";
import { SessionActions } from "../../server/sessions/actions.ts";
import { fakeConfig, writeFakeOmp } from "../support/fake-omp.ts";
import { removeScratch } from "../support/scratch.ts";

/**
 * A rename runs through a short-lived omp of the server's own, which holds the conversation's write lease while it lives.
 * The rename answers once that omp has ended, not once it has answered: a delete asked right after it would otherwise find
 * the lease held by a process that is not the pool's, take it for a terminal's and refuse (seen on a slow CI runner).
 */

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompw-actions-end-"));
});
afterEach(() => {
	removeScratch(dir);
});

test("a rename answers once its short-lived omp has ended, not once it has answered", async () => {
	// It takes a while to end once its stdin closes, as omp does writing its last entries.
	const bin = writeFakeOmp(dir, { slowClose: 1500 });
	const cfg = fakeConfig(dir, bin);
	const actions = new SessionActions(cfg, new LivePool(cfg));
	const started = Date.now();
	await actions.rename({ file: join(dir, "s.jsonl"), id: "01a00000-0000-7000-8000-00000000b2b2", cwd: dir }, "title");
	expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
	// No process runs the fake any more.
	expect(Bun.spawnSync(["pgrep", "-f", bin]).stdout.toString().trim()).toBe("");
});

/** What `SessionActions.move` asks of a process: one that moves to the folder it is told, and counts its ends. */
function stubLive(cwd: string, onRpc?: (live: { subscribers: Set<unknown> }) => void) {
	const live = {
		info: { cwd, sessionFile: join(cwd, "s.jsonl"), exited: false },
		holding: null,
		busy: false,
		subscribers: new Set<unknown>(),
		ended: 0,
		async rpc(command: { message: string }) {
			onRpc?.(live);
			live.info.cwd = command.message.slice("/move ".length);
			return { type: "response", command: "prompt", success: true };
		},
		async end() {
			live.ended++;
		},
	};
	return live;
}

test("a process started for a move is ended after it, unless a page took it up meanwhile", async () => {
	const cfg = fakeConfig(dir, writeFakeOmp(dir));
	const actions = new SessionActions(cfg, new LivePool(cfg));
	const alone = stubLive("/a");
	const moved = await actions.move({
		target: null,
		running: undefined,
		folder: "/b",
		open: async () => alone as never,
	});
	expect(moved.cwd).toBe("/b");
	expect(alone.ended).toBe(1);

	// The pool hands the running process to a page that opens the conversation while the move runs: it is that page's now.
	const shared = stubLive("/a", (live) => live.subscribers.add("page"));
	await actions.move({ target: null, running: undefined, folder: "/b", open: async () => shared as never });
	expect(shared.ended).toBe(0);
});
