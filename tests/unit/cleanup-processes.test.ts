// needs: posixShell
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkingFolder } from "../../server/platform/types.ts";
import { type CleanupWorld, DeleteCleanup } from "../../server/sessions/cleanup.ts";

/**
 * What the omp of a conversation being deleted started (its MCP servers, in its folder) is not someone else working there:
 * the folder is offered, and moved once they have ended. One that outlives the delete (a dev server) keeps the folder.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "ompw-cleanup-processes-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// A stand-in for the Trash command: removes what it is given.
const trash = join(root, "trash.sh");
writeFileSync(trash, '#!/bin/sh\nrm -rf "$1"\n');
chmodSync(trash, 0o755);

const FILE = "/sessions/chat.jsonl";
const OMP = 4100;

function world(folder: string, processes: () => WorkingFolder[], lives: CleanupWorld["lives"]): CleanupWorld {
	return {
		protect: { home: "/nonexistent-home", data: [] },
		trash: { command: () => trash, workingFolders: async () => processes() },
		conversations: async () => [{ file: FILE, cwd: folder, title: "Chat" }],
		lives,
		projects: async () => [],
		projectsFolder: async () => "/nonexistent-projects",
		terminalPids: () => new Set(),
		ownPids: () => new Set(),
	};
}

const omp = (cwd: string): WorkingFolder => ({ pid: OMP, ppid: 1, name: "omp", cwd });
const mcp = (cwd: string, ppid: number): WorkingFolder => ({ pid: 4101, ppid, name: "uv", cwd });

test("the deleted conversation's MCP servers do not hold its folder, and it moves once they have ended", async () => {
	const folder = join(root, "chat");
	mkdirSync(folder);
	let deleted = false;
	let polls = 0;
	const cleanup = new DeleteCleanup(
		world(
			folder,
			// Before the delete the MCP server is omp's; after it, it is alone for a moment, then gone.
			() => (deleted ? (polls++ < 2 ? [mcp(folder, 1)] : []) : [omp(folder), mcp(folder, OMP)]),
			() => (deleted ? [] : [{ file: FILE, cwd: folder, pid: OMP }]),
		),
	);
	const [p] = (await cleanup.preview([{ file: FILE, cwd: folder }])).previews;
	expect(p.folder).toMatchObject({ refused: null, usedBy: [] });

	deleted = true;
	const done = await cleanup.moveAfter(
		[{ file: FILE, cwd: folder }],
		new Map([[FILE, [{ path: folder, real: folder, git: null }]]]),
	);
	expect(done[FILE]).toEqual({ moved: [folder], notMoved: [] });
	expect(existsSync(folder)).toBe(false);
}, 30_000);

test("a process the conversation started that goes on after the delete keeps the folder, and is named", async () => {
	const folder = join(root, "server");
	mkdirSync(folder);
	const cleanup = new DeleteCleanup(
		world(
			folder,
			() => [{ pid: 4200, ppid: 1, name: "node", cwd: folder }],
			() => [],
		),
	);
	const done = await cleanup.moveAfter(
		[{ file: FILE, cwd: folder }],
		new Map([[FILE, [{ path: folder, real: folder, git: null }]]]),
	);
	expect(done[FILE].moved).toEqual([]);
	expect(done[FILE].notMoved).toMatchObject([{ path: folder, error: expect.stringContaining("node (pid 4200)") }]);
	expect(existsSync(folder)).toBe(true);
}, 30_000);
