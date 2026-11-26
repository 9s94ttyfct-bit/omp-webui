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
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CleanupDep, CleanupFolder, TrashPick, TrashResult } from "../../shared/delete-cleanup.ts";
import type { DiskConversation, DiskSpaceAnswer } from "../../shared/disk-space.ts";
import { writeSimpleSession } from "../support/fixtures.ts";
import { pollUntil } from "../support/poll.ts";
import { proxiedClient } from "../support/remote-client.ts";
import { startTestServer, type TestServer } from "../support/server.ts";

/**
 * The Disk space page's routes (docs/superpowers/specs/2026-11-26-disk-space-page-design.md): the rows of a projects folder,
 * the scan, and the cleanup dialog's preview and clean, with a stand-in for the Trash command (`OMP_WEBUI_TRASH_COMMAND`).
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "ompw-disk-space-")));
const projects = join(root, "projects");
mkdirSync(projects);
const bin = join(root, "trash.sh");
const binTrash = join(root, "trash");
mkdirSync(binTrash);
writeFileSync(bin, `#!/bin/sh\nmv "$1" "${binTrash}/$(basename "$1")-$$"\n`);
chmodSync(bin, 0o755);
const remoteConfig = join(root, "remote.json");
writeFileSync(remoteConfig, "{}");

let s: TestServer;
beforeAll(async () => {
	s = await startTestServer(
		0,
		{ OMP_WEBUI_TRASH_COMMAND: bin, OMP_WEBUI_REMOTE_CONFIG: remoteConfig },
		{ login: false },
	);
	expect((await post("/api/projects", { folder: projects })).status).toBe(200);
}, 60_000);
afterAll(async () => {
	await s?.stop();
	rmSync(root, { recursive: true, force: true });
});

const headers = () => ({ "x-omp-webui-token": s.accessToken, "x-omp-webui": "1", "content-type": "application/json" });
async function post<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
	const res = await fetch(`${s.url}${path}`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
	return { status: res.status, body: (await res.json()) as T };
}
async function rows(): Promise<DiskSpaceAnswer> {
	return (await (await fetch(`${s.url}/api/disk-space`, { headers: headers() })).json()) as DiskSpaceAnswer;
}

interface Preview {
	folder: string;
	conversations: (DiskConversation & { busy: boolean })[];
	mayTrash: boolean;
	trash: boolean;
	cleanup: { folder: CleanupFolder | null; deps: CleanupDep[] } | null;
}
interface Cleaned {
	deleted: string[];
	failed: { file: string; error: string }[];
	trashed: TrashResult;
}

let n = 0x90;
/** A project folder with something in it and a conversation in it; the server is waited for until it lists them. */
async function project(name: string): Promise<{ folder: string; file: string }> {
	const folder = join(projects, name);
	mkdirSync(join(folder, "node_modules", "x"), { recursive: true });
	writeFileSync(join(folder, "data.bin"), Buffer.alloc(64 * 1024, 1));
	const file = realpathSync(writeSimpleSession(s.agentDir, n++, `Work in ${name}`, undefined, folder));
	await pollUntil(
		async () => (await rows()).rows.some((r) => r.folder === folder && r.conversations === 1),
		`${name}'s row`,
	);
	return { folder, file };
}
const pickOf = (p: { path: string; real: string; git?: TrashPick["git"] }): TrashPick => ({
	path: p.path,
	real: p.real,
	git: p.git ?? null,
});

test("the rows list each project with its conversations, and a scan measures them", async () => {
	const { folder, file } = await project("measured");
	mkdirSync(join(projects, "empty"));
	expect((await post<{ started: boolean }>("/api/disk-space/scan", {})).status).toBe(200);
	await pollUntil(async () => {
		const a = await rows();
		return !a.scan.running && a.rows.find((r) => r.folder === folder)?.folderState === "measured";
	}, "the scan to measure the project");
	const a = await rows();
	expect(a.rows.find((r) => r.folder === folder)).toMatchObject({
		kind: "project",
		name: "measured",
		conversations: 1,
	});
	expect(a.rows.find((r) => r.folder === folder)?.folderBytes).toBeGreaterThan(60 * 1024);
	expect(a.rows.find((r) => r.folder === join(projects, "empty"))).toMatchObject({ kind: "project", conversations: 0 });
	expect(a.disk?.total).toBeGreaterThan(0);
	const p = await post<Preview>("/api/disk-space/preview", { folder });
	expect(p.body.conversations).toMatchObject([{ file, title: "Work in measured", busy: false }]);
	expect(p.body.cleanup?.folder).toMatchObject({ real: folder, refused: null });
	expect(p.body.cleanup?.deps).toMatchObject([{ kind: "node_modules" }]);
}, 60_000);

test("ticking only the folder moves it and deletes no conversation", async () => {
	const { folder, file } = await project("folder-only");
	const p = await post<Preview>("/api/disk-space/preview", { folder });
	const done = await post<Cleaned>("/api/disk-space/clean", {
		folder,
		files: [],
		trash: [pickOf(p.body.cleanup?.folder as CleanupFolder)],
	});
	expect(done.status).toBe(200);
	expect(done.body).toEqual({ deleted: [], failed: [], trashed: { moved: [folder], notMoved: [] } });
	expect(existsSync(folder)).toBe(false);
	expect(existsSync(file)).toBe(true);
	expect(readdirSync(binTrash).some((f) => f.startsWith("folder-only-"))).toBe(true);
}, 60_000);

test("ticking only conversations deletes them and moves nothing", async () => {
	const { folder, file } = await project("conversations-only");
	const done = await post<Cleaned>("/api/disk-space/clean", { folder, files: [file], trash: [] });
	expect(done.body).toEqual({ deleted: [file], failed: [], trashed: { moved: [], notMoved: [] } });
	expect(existsSync(file)).toBe(false);
	expect(existsSync(folder)).toBe(true);
}, 60_000);

test("a file that is not the row's is refused and nothing is done", async () => {
	const a = await project("row-a");
	const b = await project("row-b");
	const done = await post<{ error: string }>("/api/disk-space/clean", {
		folder: a.folder,
		files: [a.file, b.file],
		trash: [],
	});
	expect(done.status).toBe(400);
	expect(existsSync(a.file) && existsSync(b.file)).toBe(true);
	expect((await post("/api/disk-space/preview", { folder: join(root, "no-row") })).status).toBe(404);
}, 60_000);

test("a path the preview did not give, or a folder replaced since, is not moved", async () => {
	const { folder } = await project("replaced");
	const elsewhere = join(root, "elsewhere");
	mkdirSync(elsewhere);
	const done = await post<Cleaned>("/api/disk-space/clean", {
		folder,
		files: [],
		trash: [{ path: folder, real: join(root, "was-here"), git: null }, pickOf({ path: elsewhere, real: elsewhere })],
	});
	expect(done.body.trashed.moved).toEqual([]);
	expect(done.body.trashed.notMoved.map((x) => x.path)).toEqual([folder, elsewhere]);
	expect(existsSync(folder) && existsSync(elsewhere)).toBe(true);
}, 60_000);

test("a page that holds only the token is offered no Trash and cannot move", async () => {
	const { folder, file } = await project("token-page");
	const p = await post<Preview>("/api/disk-space/preview", { folder });
	const picks = [pickOf(p.body.cleanup?.folder as CleanupFolder)];
	const phone = proxiedClient(s);
	const asPhone = (path: string, body: unknown) =>
		phone.fetch(
			path,
			{ method: "POST", headers: { "x-omp-webui": "1", "content-type": "application/json" } },
			JSON.stringify(body),
		);
	writeFileSync(remoteConfig, JSON.stringify({ fileTransfer: "off" }));
	try {
		await pollUntil(
			async () => ((await (await asPhone("/api/disk-space/preview", { folder })).json()) as Preview).mayTrash === false,
			"the token page to be offered no Trash",
		);
		expect(((await (await asPhone("/api/disk-space/preview", { folder })).json()) as Preview).cleanup).toBeNull();
		expect((await asPhone("/api/disk-space/clean", { folder, files: [file], trash: picks })).status).toBe(403);
		expect(existsSync(file) && existsSync(folder)).toBe(true);
	} finally {
		writeFileSync(remoteConfig, "{}");
	}
}, 60_000);
