// needs: posixShell
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkingFolder } from "../../server/platform/types.ts";
import { type CleanupWorld, DeleteCleanup } from "../../server/sessions/cleanup.ts";

/**
 * The Disk space page's folder cleanup (docs/superpowers/specs/2026-11-26-disk-space-page-design.md, "The one rule that
 * differs"): only what is alive blocks the move, and the move checks everything again as things are then.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "ompw-cleanup-folder-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// A stand-in for the Trash command: removes what it is given.
const trash = join(root, "trash.sh");
writeFileSync(trash, '#!/bin/sh\nrm -rf "$1"\n');
chmodSync(trash, 0o755);

interface Stage {
	processes: WorkingFolder[];
	lives: { file: string | null; cwd: string; pid: number | null }[];
	conversations: { file: string; cwd: string; title: string }[];
}

function cleanup(stage: Stage): DeleteCleanup {
	const world: CleanupWorld = {
		protect: { home: "/nonexistent-home", data: [] },
		trash: { command: () => trash, workingFolders: async () => stage.processes },
		conversations: async () => stage.conversations,
		lives: () => stage.lives,
		projects: async () => [],
		projectsFolder: async () => "/nonexistent-projects",
		terminalPids: () => new Set(),
		ownPids: () => new Set(),
	};
	return new DeleteCleanup(world);
}

let n = 0;
const folder = () => {
	const f = join(root, `p${n++}`);
	mkdirSync(f);
	return f;
};
const pick = (f: string) => ({ path: f, real: f, git: null });

test("a folder where only stopped conversations ran is offered, and moves", async () => {
	const f = folder();
	const c = cleanup({ processes: [], lives: [], conversations: [{ file: "/s/old.jsonl", cwd: f, title: "Old" }] });
	const p = await c.previewFolder(f, [], []);
	expect(p.trash).toBe(true);
	expect(p.folder).toMatchObject({ real: f, refused: null, usedBy: [] });
	expect(await c.moveFolder(f, [pick(f)], [], [])).toEqual({ moved: [f], notMoved: [] });
	expect(existsSync(f)).toBe(false);
});

test("a live omp in it is inUse, unless its conversation is being deleted", async () => {
	const f = folder();
	const stage: Stage = {
		processes: [{ pid: 500, ppid: 1, name: "omp", cwd: f }],
		lives: [{ file: "/s/live.jsonl", cwd: f, pid: 500 }],
		conversations: [{ file: "/s/live.jsonl", cwd: f, title: "Live" }],
	};
	const c = cleanup(stage);
	expect((await c.previewFolder(f, [], [])).folder).toMatchObject({
		refused: "inUse",
		usedBy: [{ kind: "conversation", name: "Live" }],
	});
	expect((await c.previewFolder(f, ["/s/live.jsonl"], [])).folder).toMatchObject({ refused: null });
});

test("a conversation file kept in it is holdsConversations", async () => {
	const f = folder();
	const c = cleanup({
		processes: [],
		lives: [],
		conversations: [{ file: join(f, "s.jsonl"), cwd: "/elsewhere", title: "X" }],
	});
	expect((await c.previewFolder(f, [], [])).folder).toMatchObject({ refused: "holdsConversations" });
});

test("a process that started in it after the preview stops the move, and is named", async () => {
	const f = folder();
	const stage: Stage = { processes: [], lives: [], conversations: [] };
	const c = cleanup(stage);
	expect((await c.previewFolder(f, [], [])).folder).toMatchObject({ refused: null });
	stage.processes = [{ pid: 600, ppid: 1, name: "node", cwd: f }];
	const r = await c.moveFolder(f, [pick(f)], [], []);
	expect(r.moved).toEqual([]);
	expect(r.notMoved).toMatchObject([{ path: f, error: expect.stringContaining("node (pid 600)") }]);
	expect(existsSync(f)).toBe(true);
}, 30_000);

test("a folder replaced since the preview, or a path that is not its own, is not moved", async () => {
	const f = folder();
	const other = folder();
	const c = cleanup({ processes: [], lives: [], conversations: [] });
	const r = await c.moveFolder(f, [{ path: f, real: join(root, "was-here"), git: null }, pick(other)], [], []);
	expect(r.moved).toEqual([]);
	expect(r.notMoved.map((x) => x.path)).toEqual([f, other]);
	expect(existsSync(f) && existsSync(other)).toBe(true);
});
