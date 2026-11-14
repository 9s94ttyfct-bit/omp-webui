import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	ISOLATED_DIR,
	ISOLATED_MARKER,
	ISOLATED_MARKER_BODY,
	ISOLATED_NOTE_VAR,
	type IsolationFacts,
	type IsolationRefusal,
	isolatedEnv,
	isolatedNote,
} from "../shared/isolated-env.ts";
import { platform } from "./platform/index.ts";
import { isWithin, type Protected, protectedReason } from "./sessions/cleanup-rules.ts";
import { realOf } from "./sessions/cleanup-scan.ts";

/**
 * Whether this computer offers isolated environments: not Windows, whose `PATH` and the tools' folders the variables are
 * not made for. Where it is not offered, no folder is isolated, whatever marker it holds (one made on another computer):
 * a process gets no variables there, and New chat shows no switch (`GET /api/isolation`).
 */
export const ISOLATION_SUPPORTED = platform.id !== "win32";

/**
 * A project folder's isolated environment, the server's part (docs/superpowers/specs/2026-11-14-isolated-project-env-design.md):
 * which folder a working folder's isolation is (`findIsolatedRoot`), the marker and the cargo links (`ensureIsolated`), the
 * variables a process started there gets (`envFor`), and which folders may be switched (`isolationRefusal`, `setIsolated`).
 */

const markerOf = (root: string) => join(root, ISOLATED_DIR, ISOLATED_MARKER);

/**
 * Whether `root/.ompw-env` (and its `cargo`, when there) is a folder of its own, not a link: a link would send what is
 * installed outside the project, and the Trash would take the link and leave all of it.
 */
function ownFolder(path: string): boolean | null {
	try {
		const st = lstatSync(path);
		return st.isDirectory() && !st.isSymbolicLink();
	} catch {
		return null;
	}
}

/** The nearest folder from `folder` up to `/` that holds the marker in a `.ompw-env` of its own, real; null when none does. */
export function findIsolatedRoot(folder: string): string | null {
	const real = ISOLATION_SUPPORTED ? realOf(folder) : null;
	if (!real) return null;
	for (let dir = real; ; dir = dirname(dir)) {
		if (ownFolder(join(dir, ISOLATED_DIR)) && existsSync(markerOf(dir))) return dir;
		if (dirname(dir) === dir) return null;
	}
}

/**
 * A worktree of an isolated project switched off in New chat: kept in its `.ompw-env`, so that it is not adopted again
 * (`worktreeToAdopt`) until it is switched on.
 */
const OPTED_OUT = "ompw-env.off";

/**
 * Whether the nearest `.git` above `folder` is a file: what a linked worktree (or a submodule) has, where a main worktree
 * has a folder. Looked at before git is asked, so that a folder in no worktree costs no process (every Terminal tab and
 * omp start asks).
 */
function inGitFileCheckout(folder: string): boolean {
	const real = realOf(folder);
	if (!real) return false;
	for (let dir = real; ; dir = dirname(dir)) {
		try {
			return lstatSync(join(dir, ".git")).isFile();
		} catch {
			// None here: look one folder up.
		}
		if (dirname(dir) === dir) return false;
	}
}

/** The top level of the linked git worktree `folder` is in, and whether its main worktree is isolated; null when it is in none. */
function linkedWorktree(folder: string): { top: string; mainIsolated: boolean } | null {
	if (!inGitFileCheckout(folder)) return null;
	let r: ReturnType<typeof Bun.spawnSync>;
	try {
		r = Bun.spawnSync(
			["git", "-C", folder, "rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir", "--show-toplevel"],
			{ stdout: "pipe", stderr: "ignore" },
		);
	} catch {
		// No git on `PATH`: no worktree to follow.
		return null;
	}
	if (r.exitCode !== 0 || !r.stdout) return null;
	const [common, own, top] = r.stdout.toString().trim().split("\n");
	if (!common || !own || !top || common === own) return null;
	// The main worktree is the folder its `.git` is in; a bare repository's worktrees have none to follow.
	if (!common.endsWith("/.git")) return null;
	return { top: realOf(top) ?? top, mainIsolated: findIsolatedRoot(dirname(common)) !== null };
}

/**
 * The top level of the linked git worktree `folder` is in, when its main worktree is isolated (option A: a worktree of an
 * isolated project gets its own isolated environment) and it was not switched off; null otherwise, and for the main
 * worktree itself.
 */
export function worktreeToAdopt(folder: string): string | null {
	if (!ISOLATION_SUPPORTED) return null;
	const wt = linkedWorktree(folder);
	if (!wt?.mainIsolated || existsSync(join(wt.top, ISOLATED_DIR, OPTED_OUT))) return null;
	return wt.top;
}

/** A link at `at` to `target`: made when `target` exists, put right when it is a wrong or broken link, kept otherwise. */
function ensureLink(at: string, target: string): void {
	if (!existsSync(target)) return;
	let stat: ReturnType<typeof lstatSync> | null = null;
	try {
		stat = lstatSync(at);
	} catch {
		stat = null;
	}
	if (stat && !stat.isSymbolicLink()) return; // the person's own file: left alone
	if (stat && readlinkSync(at) === target) return;
	if (stat) rmSync(at);
	symlinkSync(target, at);
}

/** The person's settings and logins a moved tool folder would otherwise lose, linked in: `.ompw-env` path → home path. */
const LINKED = [
	["cargo/config.toml", ".cargo/config.toml"],
	["cargo/credentials.toml", ".cargo/credentials.toml"],
	["huggingface/token", ".cache/huggingface/token"],
	["huggingface/stored_tokens", ".cache/huggingface/stored_tokens"],
] as const;

/**
 * Make `root` isolated, or keep it so: the marker, a `.gitignore` that has git ignore `.ompw-env`, and links to the person's
 * cargo settings and login and Hugging Face tokens (`CARGO_HOME` and `HF_HOME` move, and they would otherwise be lost).
 * Safe to run again.
 */
export function ensureIsolated(root: string, home: string = homedir()): void {
	const e = join(root, ISOLATED_DIR);
	if ([e, join(e, "cargo"), join(e, "huggingface")].some((d) => ownFolder(d) === false))
		throw new IsolationError("linked");
	mkdirSync(join(e, "cargo"), { recursive: true });
	mkdirSync(join(e, "huggingface"), { recursive: true });
	if (!existsSync(markerOf(root))) writeFileSync(markerOf(root), ISOLATED_MARKER_BODY);
	if (!existsSync(join(e, ".gitignore"))) writeFileSync(join(e, ".gitignore"), "*\n");
	rmSync(join(e, OPTED_OUT), { force: true });
	for (const [inside, own] of LINKED) ensureLink(join(e, inside), join(home, own));
}

/** What is read of the computer for the variables. */
export function isolationFacts(
	env: Record<string, string | undefined> = process.env,
	home: string = homedir(),
): IsolationFacts {
	return { nvm: Boolean(env.NVM_DIR) || existsSync(join(home, ".nvm", "nvm.sh")) };
}

/**
 * The isolation of a process about to start in `cwd`: its root, the variables to add (with `PATH` built on `basePath`) and
 * the agent's note in `OMPW_ISOLATED_NOTE`; null when `cwd` is not in an isolated folder. Writes the marker of a worktree it
 * adopts and the cargo links; a folder that cannot be written still gets its variables.
 */
export function envFor(
	cwd: string,
	basePath: string,
	opts: { env?: Record<string, string | undefined>; home?: string } = {},
): { root: string; env: Record<string, string> } | null {
	const home = opts.home ?? homedir();
	let root = findIsolatedRoot(cwd);
	const adopt = root === null ? worktreeToAdopt(cwd) : null;
	root ??= adopt;
	if (!root) return null;
	try {
		ensureIsolated(root, home);
	} catch (e) {
		console.error(`omp-webui: could not prepare the isolated environment of ${root}: ${(e as Error).message}`);
		// A worktree that could not be adopted, or a `.ompw-env` that is a link, is not isolated.
		if (adopt || e instanceof IsolationError) return null;
	}
	const { env, covered } = isolatedEnv(root, isolationFacts(opts.env ?? process.env, home), basePath);
	return { root, env: { ...env, [ISOLATED_NOTE_VAR]: isolatedNote(root, covered) } };
}

/** What the rules need: the folders never offered, the projects folder, and the other conversations' and projects' folders (all real). */
export interface IsolationContext {
	protect: Protected;
	projectsFolder: string | null;
	others: readonly string[];
}

/** Why the real folder `real` may not be switched on, or null. A folder inside an isolated one is that one's, not refused. */
export function isolationRefusal(real: string, ctx: IsolationContext): IsolationRefusal | null {
	if (protectedReason(real, ctx.protect) !== null) return "protected";
	if (ctx.projectsFolder !== null && real === ctx.projectsFolder) return "projectsFolder";
	if (ctx.others.some((o) => o !== real && isWithin(o, real))) return "containsOther";
	return null;
}

/**
 * What New chat shows for a folder: the isolated folder it is in, or will be (a worktree of an isolated project, adopted
 * when a process starts there); null: none. And why it could not be switched on.
 */
export function isolationState(
	folder: string,
	ctx: IsolationContext,
): { root: string | null; refused: IsolationRefusal | null } {
	const root = findIsolatedRoot(folder) ?? worktreeToAdopt(folder);
	if (root) return { root, refused: null };
	const real = realOf(folder);
	return { root: null, refused: real ? isolationRefusal(real, ctx) : "protected" };
}

/** An error the page shows as is. */
export class IsolationError extends Error {
	constructor(readonly refused: IsolationRefusal) {
		super(`This folder cannot have an isolated environment (${refused})`);
	}
}

/**
 * Switch the isolation of `folder`'s folder: on writes the marker (unless the folder is in an isolated one already, which
 * is then the one; a worktree of an isolated project at its top level), off removes the nearest marker file only (what
 * was installed stays until the folder is trashed), or, for a worktree that would be adopted, notes that it is off.
 * Returns the root that changed or holds, null when nothing is isolated now.
 */
export function setIsolated(
	folder: string,
	on: boolean,
	ctx: IsolationContext,
	home: string = homedir(),
): string | null {
	const root = findIsolatedRoot(folder);
	if (!on) {
		// What was installed stays until the folder goes to the Trash; the note keeps it listed in the delete dialog and keeps
		// a worktree from being adopted again.
		const off = (top: string) => {
			if (ownFolder(join(top, ISOLATED_DIR)) === false) return;
			mkdirSync(join(top, ISOLATED_DIR), { recursive: true });
			writeFileSync(join(top, ISOLATED_DIR, OPTED_OUT), "");
			if (!existsSync(join(top, ISOLATED_DIR, ".gitignore")))
				writeFileSync(join(top, ISOLATED_DIR, ".gitignore"), "*\n");
		};
		if (root) {
			rmSync(markerOf(root), { force: true });
			off(root);
		}
		const adopt = worktreeToAdopt(folder);
		if (adopt) off(adopt);
		return null;
	}
	if (root) return root;
	const wt = linkedWorktree(folder);
	const target = wt?.mainIsolated ? wt.top : realOf(folder);
	const refused = target ? isolationRefusal(target, ctx) : "protected";
	if (refused || !target) throw new IsolationError(refused ?? "protected");
	ensureIsolated(target, home);
	return target;
}
