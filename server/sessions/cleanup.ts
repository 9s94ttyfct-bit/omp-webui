import { existsSync } from "node:fs";
import type {
	CleanupDep,
	CleanupFolder,
	DeletePreview,
	DeletePreviewAnswer,
	TrashPick,
	TrashResult,
	UsedBy,
} from "../../shared/delete-cleanup.ts";
import { run } from "../omp/run.ts";
import type { TrashOps } from "../platform/types.ts";
import { depUse, type FolderUser, folderUse, isWithin, type Protected, protectedReason } from "./cleanup-rules.ts";
import { gitRisk, isFolder, isWorktreeTop, listDependencies, moreAtRisk, realOf, sizeOf } from "./cleanup-scan.ts";

/**
 * What a delete may move to the Trash, and the moves (docs/superpowers/specs/2026-11-11-delete-session-folder-design.md).
 * The preview says what each conversation of a delete would offer; after omp has deleted them, `moveAfter` checks every
 * ticked path again, as things are then, and moves only what still passes. Nothing the preview said is trusted.
 */

/** How long measuring one folder's size may take before the dialog shows it as unknown. */
const SIZE_MS = 3000;
/** How long the Trash command may take for one path (a large folder on another volume is copied). */
const TRASH_MS = 120_000;
/** How long a move waits for the processes a deleted conversation's omp started to end, and how often it looks. */
const SETTLE_MS = 5000;
const SETTLE_STEP_MS = 250;

/** Whether what runs in `folders` (or inside them) is processes only, which may be ones still ending. */
function onlyProcessesIn(folders: string[], users: Users): boolean {
	const inside = users.active.filter((u) => folders.some((f) => isWithin(u.real, f)));
	return inside.length > 0 && inside.every((u) => u.who.kind === "process");
}

/** A conversation of the request: its file, and the folder it works in. */
export interface CleanupTarget {
	file: string;
	cwd: string;
	/** The session omp went on with after deleting this one (`SessionActions.delete`): not someone else working there. */
	startedInstead?: string | null;
}

/** What the cleanup asks of the server. */
export interface CleanupWorld {
	/** The real home folder, and the data folders never offered (omp-webui's, omp's home). */
	protect: Protected;
	trash: TrashOps | null;
	/** Every recorded conversation: its file, folder and title. */
	conversations(): Promise<{ file: string; cwd: string; title: string }[]>;
	/** The conversations' processes the server holds that have not ended (a new chat has no file yet). */
	lives(): { file: string | null; cwd: string; pid: number | null }[];
	/** The sidebar's projects with a folder. */
	projects(): Promise<{ name: string; folder: string }[]>;
	/** The projects folder, where New chat makes each new project's folder (`Protected.shared`). */
	projectsFolder(): Promise<string>;
	/** The shells of the Terminal tabs. */
	terminalPids(): Set<number>;
	/** Processes of the server's own (itself, its relays): never anyone's use of a folder. */
	ownPids(): Set<number>;
}

interface Users {
	/** Everything that works in a folder (conversations, projects, processes). */
	all: FolderUser[];
	/** What runs now (conversations' processes, Terminal tabs, processes). */
	active: FolderUser[];
	/** False: the processes could not be listed; no folder is offered or moved. */
	checked: boolean;
	/** The rules of what is never offered, with the projects folder as it is now. */
	protect: Protected;
}

export class DeleteCleanup {
	constructor(private readonly world: CleanupWorld) {}

	/** Whether this computer moves anything to the Trash. */
	get available(): boolean {
		return (this.world.trash?.command() ?? null) !== null;
	}

	/**
	 * Who works where, leaving out the conversations of `leaving` (they are being deleted), their omp processes and what
	 * those started (MCP servers, a tool's shell): the delete ends them. One that outlives its omp is counted again once
	 * it is on its own (`moveAfter` looks after the delete).
	 */
	private async users(leaving: Set<string>): Promise<Users> {
		const all: FolderUser[] = [];
		const active: FolderUser[] = [];
		const reals = new Map<string, string | null>();
		const realCached = (p: string) => {
			if (!reals.has(p)) reals.set(p, realOf(p));
			return reals.get(p) ?? null;
		};
		const titles = new Map<string, string>();
		for (const c of await this.world.conversations()) {
			titles.set(c.file, c.title);
			if (leaving.has(c.file)) continue;
			const real = realCached(c.cwd);
			if (real) all.push({ real, who: { kind: "conversation", name: c.title } });
		}
		const livePids = new Set<number>();
		const leavingPids = new Set<number>();
		for (const l of this.world.lives()) {
			if (l.pid !== null) livePids.add(l.pid);
			if (l.file !== null && leaving.has(l.file)) {
				if (l.pid !== null) leavingPids.add(l.pid);
				continue;
			}
			const real = realCached(l.cwd);
			if (!real) continue;
			// A new chat has no title yet: the dialog names it as one.
			const u: FolderUser = { real, who: { kind: "conversation", name: (l.file && titles.get(l.file)) || "" } };
			all.push(u);
			active.push(u);
		}
		for (const p of await this.world.projects()) {
			const real = realCached(p.folder);
			if (real) all.push({ real, who: { kind: "project", name: p.name } });
		}
		const folders = (await this.world.trash?.workingFolders()) ?? null;
		const own = this.world.ownPids();
		const terminals = this.world.terminalPids();
		const parent = new Map((folders ?? []).map((w) => [w.pid, w.ppid]));
		const startedByLeaving = (pid: number): boolean => {
			for (let p = parent.get(pid), depth = 0; p !== undefined && p > 1 && depth < 64; p = parent.get(p), depth++)
				if (leavingPids.has(p)) return true;
			return false;
		};
		for (const w of folders ?? []) {
			// A conversation's own omp is that conversation (counted above, or being deleted).
			if (own.has(w.pid) || livePids.has(w.pid) || startedByLeaving(w.pid)) continue;
			const who: UsedBy = terminals.has(w.pid)
				? { kind: "terminal", name: w.name, pid: w.pid }
				: { kind: "process", name: w.name, pid: w.pid };
			const u: FolderUser = { real: w.cwd, who };
			all.push(u);
			active.push(u);
		}
		const projectsFolder = realOf(await this.world.projectsFolder());
		const protect = { ...this.world.protect, shared: projectsFolder ? [projectsFolder] : [] };
		return { all, active, checked: folders !== null, protect };
	}

	/** What each of `targets` would offer; a folder (or dependency folder) two of them share is offered by the first. */
	async preview(targets: CleanupTarget[]): Promise<DeletePreviewAnswer> {
		if (!this.available)
			return { trash: false, previews: targets.map((t) => ({ file: t.file, folder: null, deps: [] })) };
		const users = await this.users(new Set(targets.map((t) => t.file)));
		const offered = new Set<string>();
		const previews: DeletePreview[] = [];
		for (const t of targets) previews.push(await this.previewOne(t, users, offered));
		return { trash: true, previews };
	}

	private async previewOne(t: CleanupTarget, users: Users, offered: Set<string>): Promise<DeletePreview> {
		const real = realOf(t.cwd);
		if (real === null || !isFolder(real) || offered.has(real)) return { file: t.file, folder: null, deps: [] };
		offered.add(real);
		const guarded = protectedReason(real, this.world.protect);
		const use = folderUse(real, users.all, users.protect);
		const refused = guarded ?? (users.checked ? use.refused : "unchecked");
		const [bytes, git, worktree] = guarded
			? [null, null, false]
			: await Promise.all([sizeOf(real, SIZE_MS), gitRisk(real), isWorktreeTop(real)]);
		const folder: CleanupFolder = {
			path: t.cwd,
			real,
			bytes,
			refused,
			usedBy: guarded ? [] : use.usedBy,
			git,
			worktree,
		};
		// The home folder or a system folder: what is in it is other projects', not this conversation's.
		if (guarded) return { file: t.file, folder, deps: [] };
		const deps: CleanupDep[] = [];
		const blockers = depUse(real, users.active);
		for (const d of await listDependencies(real)) {
			const depReal = realOf(d.path);
			if (depReal === null || offered.has(depReal) || protectedReason(depReal, this.world.protect)) continue;
			offered.add(depReal);
			deps.push({
				path: d.path,
				real: depReal,
				kind: d.kind,
				bytes: null,
				refused: !users.checked ? "unchecked" : blockers.length ? "inUse" : null,
				usedBy: blockers,
			});
		}
		await Promise.all(
			deps.map(async (d) => {
				d.bytes = await sizeOf(d.real, SIZE_MS);
			}),
		);
		return { file: t.file, folder, deps };
	}

	/**
	 * Moves the ticked paths of the conversations omp deleted (`deleted`), each checked again now: it must still be that
	 * conversation's folder or a dependency folder found in it, at the real path the preview showed, pass every check
	 * against what works where now, and (a folder) hold no more git work than the dialog showed. Picks of a conversation
	 * that was not deleted are refused.
	 */
	async moveAfter(deleted: CleanupTarget[], picks: Map<string, TrashPick[]>): Promise<Record<string, TrashResult>> {
		const out: Record<string, TrashResult> = {};
		const gone = new Set(deleted.map((t) => t.file));
		for (const [file, list] of picks) {
			if (!gone.has(file) && list.length)
				out[file] = {
					moved: [],
					notMoved: list.map((p) => ({ path: p.path, error: "The conversation was not deleted." })),
				};
		}
		const todo = deleted.filter((t) => (picks.get(t.file) ?? []).length > 0);
		if (todo.length === 0) return out;
		const command = this.world.trash?.command() ?? null;
		// The empty sessions omp went on with after the deletes are the deleted conversations', not someone else's.
		const started = deleted.flatMap((t) => (t.startedInstead ? [t.startedInstead] : []));
		const leaving = new Set([...gone, ...started]);
		// What a deleted conversation's omp started (its MCP servers) ends a moment after it: a process alone in a picked
		// folder is waited for, a while. One still there then (a dev server) is in use, and the folder stays.
		const folders = todo.map((t) => realOf(t.cwd)).filter((f): f is string => f !== null);
		let users = await this.users(leaving);
		for (let waited = 0; waited < SETTLE_MS && onlyProcessesIn(folders, users); waited += SETTLE_STEP_MS) {
			await Bun.sleep(SETTLE_STEP_MS);
			users = await this.users(leaving);
		}
		for (const t of todo) out[t.file] = await this.moveOne(t, picks.get(t.file) ?? [], users, command);
		return out;
	}

	private async moveOne(
		t: CleanupTarget,
		picks: TrashPick[],
		users: Users,
		command: string | null,
	): Promise<TrashResult> {
		const result: TrashResult = { moved: [], notMoved: [] };
		const refuse = (p: TrashPick, error: string) => result.notMoved.push({ path: p.path, error });
		const folder = realOf(t.cwd);
		const movedFolder: string[] = [];
		// The folder first: a dependency folder in a folder that went with it is moved already.
		const ordered = [...picks].sort((a, b) => Number(b.real === folder) - Number(a.real === folder));
		let deps: string[] | null = null;
		for (const p of ordered) {
			if (movedFolder.some((m) => isWithin(p.real, m))) continue;
			if (command === null) {
				refuse(p, "This computer has no Trash command.");
				continue;
			}
			const now = realOf(p.path);
			if (now === null || now !== p.real || !isFolder(now)) {
				refuse(p, "It is not the folder the dialog showed any more.");
				continue;
			}
			if (folder === null || protectedReason(folder, this.world.protect)) {
				refuse(p, "The conversation's folder may not be cleaned up.");
				continue;
			}
			if (!users.checked) {
				refuse(p, "The running processes could not be checked.");
				continue;
			}
			if (now === folder) {
				const use = folderUse(now, users.all, users.protect);
				if (use.refused) {
					refuse(p, `It is in use: ${use.usedBy.map(describe).join(", ")}.`);
					continue;
				}
				if (moreAtRisk(await gitRisk(now), p.git)) {
					refuse(p, "Git has more uncommitted or unpushed work in it than the dialog showed.");
					continue;
				}
			} else {
				deps ??= (await listDependencies(folder)).map((d) => realOf(d.path)).filter((r): r is string => r !== null);
				if (!deps.includes(now) || protectedReason(now, this.world.protect)) {
					refuse(p, "It is not a dependency folder of the conversation's folder.");
					continue;
				}
				const blockers = depUse(folder, users.active);
				if (blockers.length) {
					refuse(p, `Something runs in the folder: ${blockers.map(describe).join(", ")}.`);
					continue;
				}
			}
			const error = await moveToTrash(command, now);
			if (error) refuse(p, error);
			else {
				result.moved.push(p.path);
				if (now === folder) movedFolder.push(now);
			}
		}
		return result;
	}
}

/** A user as an error message names it. */
function describe(u: UsedBy): string {
	if (u.kind === "terminal") return "a Terminal tab";
	if (u.kind === "process") return `${u.name || "a process"} (pid ${u.pid})`;
	return `${u.kind} “${u.name}”`;
}

/** Runs the Trash command on `path`; the error, or null once the path is gone. */
async function moveToTrash(command: string, path: string): Promise<string | null> {
	try {
		const r = await run([command, path], { timeoutMs: TRASH_MS });
		if (r.code !== 0) return (r.stderr || r.stdout).trim() || `The Trash command failed (exit ${r.code}).`;
	} catch (e) {
		return (e as Error).message;
	}
	return existsSync(path) ? "The Trash command left it where it was." : null;
}
