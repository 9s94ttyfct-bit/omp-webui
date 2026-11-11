// needs: posixShell
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeletePreviewAnswer, TrashPick, TrashResult } from "../../shared/delete-cleanup.ts";
import { writeSimpleSession } from "../support/fixtures.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";

/**
 * Deleting a conversation with its folder or dependency folders (docs/superpowers/specs/2026-11-11-delete-session-folder-design.md),
 * through the routes, with a stand-in for the Trash command (`OMP_WEBUI_TRASH_COMMAND`): a script that moves what it is
 * given into a folder of the test's, and fails for a path named `refuse-me`. No model is called.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "ompw-delete-cleanup-")));
const bin = join(root, "trash.sh");
const bin_trash = join(root, "trash");
mkdirSync(bin_trash);
writeFileSync(
	bin,
	`#!/bin/sh\ncase "$1" in *refuse-me*) echo "no room in the Trash" >&2; exit 3;; esac\nmv "$1" "${bin_trash}/$(basename "$1")-$$"\n`,
);
chmodSync(bin, 0o755);

let s: TestServer;
beforeAll(async () => {
	s = await startTestServer(0, { OMP_WEBUI_TRASH_COMMAND: bin }, { login: false });
}, 60_000);
afterAll(async () => {
	await s?.stop();
	rmSync(root, { recursive: true, force: true });
});

async function post<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
	const res = await fetch(`${s.url}${path}`, {
		method: "POST",
		headers: { "x-omp-webui-token": s.accessToken, "x-omp-webui": "1", "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: res.status, body: (await res.json()) as T };
}
/** The conversations the test wrote: the server is waited for until it lists every one still on disk. */
const written: string[] = [];
async function listed(): Promise<void> {
	await pollUntil(async () => {
		const res = await fetch(`${s.url}/api/sessions`, { headers: { "x-omp-webui-token": s.accessToken } });
		const files = new Set(((await res.json()) as { file: string }[]).map((x) => x.file));
		return written.every((f) => !existsSync(f) || files.has(f));
	}, "the server to list the conversations written");
}
const preview = async (files: string[]) => {
	await listed();
	return post<DeletePreviewAnswer>("/api/session/delete-preview", { files });
};
const remove = async (file: string, trash: TrashPick[]) => {
	await listed();
	return post<{ ok: true; trashed?: TrashResult }>("/api/session/delete", { file, trash });
};

let n = 0x60;
/** A conversation that worked in `cwd`, by the real path of its file (the server lists files by theirs). */
function session(title: string, cwd: string): string {
	const file = realpathSync(writeSimpleSession(s.agentDir, n++, title, undefined, cwd));
	written.push(file);
	return file;
}
/** A conversation that worked in a new folder of its own (with `node_modules` in it), and that folder. */
function conversationInFolder(name: string, folder = join(root, name)): { file: string; folder: string } {
	mkdirSync(join(folder, "node_modules", "left-pad"), { recursive: true });
	writeFileSync(join(folder, "index.js"), "1");
	return { file: session(`Work in ${name}`, folder), folder };
}
const pickOf = (p: { path: string; real: string; git?: TrashPick["git"] }): TrashPick => ({
	path: p.path,
	real: p.real,
	git: p.git ?? null,
});
const inTrash = (name: string) => readdirSync(bin_trash).some((f) => f.startsWith(`${name}-`));

test("a conversation's own folder is offered with its size and dependency folders, and moves once omp deleted it", async () => {
	const { file, folder } = conversationInFolder("alone");
	const answer = await preview([file]);
	expect(answer.status).toBe(200);
	expect(answer.body.trash).toBe(true);
	const [p] = answer.body.previews;
	expect(p.file).toBe(file);
	expect(p.folder).toMatchObject({ path: folder, real: folder, refused: null, usedBy: [], git: null });
	expect(p.folder?.bytes).toBeGreaterThan(0);
	expect(p.deps).toMatchObject([{ path: join(folder, "node_modules"), kind: "node_modules", refused: null }]);

	const done = await remove(file, [pickOf(p.folder as TrashPick)]);
	expect(done.status).toBe(200);
	expect(done.body.trashed).toEqual({ moved: [folder], notMoved: [] });
	expect(existsSync(file)).toBe(false);
	expect(existsSync(folder)).toBe(false);
	expect(inTrash("alone")).toBe(true);
}, 60_000);

test("a folder another conversation works in is not offered nor moved, but its dependency folders are", async () => {
	const { file, folder } = conversationInFolder("shared");
	session("Also in shared", folder);
	const [p] = (await preview([file])).body.previews;
	expect(p.folder).toMatchObject({ refused: "inUse", usedBy: [{ kind: "conversation", name: "Also in shared" }] });
	expect(p.deps).toMatchObject([{ kind: "node_modules", refused: null }]);

	// A page that sends the folder anyway: the conversation is deleted, the folder stays, the dependency folder goes.
	const done = await remove(file, [pickOf(p.folder as TrashPick), pickOf(p.deps[0])]);
	expect(done.status).toBe(200);
	expect(done.body.trashed?.moved).toEqual([join(folder, "node_modules")]);
	expect(done.body.trashed?.notMoved).toMatchObject([{ path: folder, error: expect.stringContaining("in use") }]);
	expect(existsSync(file)).toBe(false);
	expect(existsSync(join(folder, "index.js"))).toBe(true);
	expect(existsSync(join(folder, "node_modules"))).toBe(false);
}, 60_000);

test("two conversations deleted together in one folder: it is offered once, and moves", async () => {
	const { file: a, folder } = conversationInFolder("pair");
	const b = session("Second in pair", folder);
	const answer = (await preview([a, b])).body;
	expect(answer.previews[0].folder).toMatchObject({ refused: null });
	expect(answer.previews[1]).toEqual({ file: b, folder: null, deps: [] });

	const done = await post<{ deleted: string[]; trashed: Record<string, TrashResult> }>("/api/sessions/delete", {
		files: [a, b],
		trash: { [a]: [pickOf(answer.previews[0].folder as TrashPick)] },
	});
	expect(done.body.deleted.sort()).toEqual([a, b].sort());
	expect(done.body.trashed[a]).toEqual({ moved: [folder], notMoved: [] });
	expect(existsSync(folder)).toBe(false);
}, 60_000);

test("a path that is not the conversation's, or a link swapped since the preview, is not moved", async () => {
	const { file, folder } = conversationInFolder("linked-real");
	const link = join(root, "linked");
	symlinkSync(folder, link);
	const conv = session("Through a link", link);
	const [p] = (await preview([conv])).body.previews;
	expect(p.folder).toMatchObject({ path: link, real: folder, refused: "inUse" });
	// The other conversation in the real folder goes first, so that only the swap stands in the way.
	expect((await remove(file, [])).status).toBe(200);
	const other = conversationInFolder("other");
	rmSync(link);
	symlinkSync(other.folder, link);
	const elsewhere = join(root, "not-its-own");
	mkdirSync(elsewhere);
	const done = await remove(conv, [
		pickOf({ ...(p.folder as TrashPick), real: folder }),
		pickOf({ path: elsewhere, real: elsewhere }),
	]);
	expect(done.body.trashed?.moved).toEqual([]);
	expect(done.body.trashed?.notMoved.map((m) => m.path).sort()).toEqual([elsewhere, link].sort());
	expect(existsSync(folder)).toBe(true);
	expect(existsSync(other.folder)).toBe(true);
	expect(existsSync(elsewhere)).toBe(true);
}, 60_000);

test("git work added after the preview stops the move", async () => {
	const { file, folder } = conversationInFolder("repo");
	const git = (...args: string[]) =>
		Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: folder });
	git("init", "-q");
	writeFileSync(join(folder, ".gitignore"), "node_modules/\n");
	git("add", ".");
	git("commit", "-q", "-m", "init");
	const [p] = (await preview([file])).body.previews;
	expect(p.folder?.git).toEqual({ uncommitted: 0, unpushed: 1 });
	writeFileSync(join(folder, "new.txt"), "work");
	const done = await remove(file, [pickOf(p.folder as TrashPick)]);
	expect(done.body.trashed?.notMoved).toMatchObject([{ path: folder, error: expect.stringContaining("Git") }]);
	expect(existsSync(join(folder, "new.txt"))).toBe(true);
}, 60_000);

test("a Trash command that fails leaves the folder and says why; the conversation stays deleted", async () => {
	const { file, folder } = conversationInFolder("refuse-me");
	const [p] = (await preview([file])).body.previews;
	const done = await remove(file, [pickOf(p.folder as TrashPick)]);
	expect(done.status).toBe(200);
	expect(done.body.trashed?.notMoved).toEqual([{ path: folder, error: "no room in the Trash" }]);
	expect(existsSync(file)).toBe(false);
	expect(existsSync(folder)).toBe(true);
}, 60_000);
