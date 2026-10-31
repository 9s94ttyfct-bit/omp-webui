import { existsSync } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, sep } from "node:path";
import { CONFLICT_LIMITS } from "../../../shared/guidance-conflict.ts";
import type { MemoryItem } from "../../../shared/memory.ts";
import type { SourceText } from "./conflict.ts";

/**
 * What the guidance conflict check compares the guidance with (`conflict.ts`): the context files omp loads for the
 * conversation's folder, and the memories omp keeps for that project.
 *
 * The files are found as omp 18.14's discovery finds them (read from its bundled source, not its documentation), each by
 * the discovery provider that loads it, so that one the person turned off in omp (`disabledProviders`) is not compared:
 *
 * - `agents-md` / `claude-md` / `custom-context` (`contextFiles.extra`): `AGENTS.md`, `CLAUDE.md` and the extra names in the
 *   folder and every folder above it, up to the repository's root, or up to the home folder when the folder is in it (a
 *   repository under the home folder walks up to the home folder; the home folder's own file counts only when the folder
 *   is in no repository, or the repository is the home folder). A folder whose name starts with `.` is skipped.
 * - `native`: `.omp/AGENTS.md` in the folder and those above it, up to the repository's root or the home folder (not
 *   the home folder's own), and the agent folder's `AGENTS.md` (`~/.omp/agent/AGENTS.md`).
 * - `claude`: `.claude/CLAUDE.md` in the folder, and `~/.claude/CLAUDE.md`.
 * - `agents`: `.agent/AGENTS.md` and `.agents/AGENTS.md` walked as `native`'s, and those of the home folder.
 * - `codex`: `~/.codex/AGENTS.md`. `gemini`: `.gemini/GEMINI.md` in the folder and `~/.gemini/GEMINI.md`.
 *   `opencode`: `~/.config/opencode/AGENTS.md`. `github`: `.github/copilot-instructions.md` in the folder and
 *   `~/.copilot/copilot-instructions.md`.
 *
 * A file found twice (a link, two names for one place) is read once. Empty files are left out.
 */

export interface ContextFileRules {
	home: string;
	/** omp's agent folder (`~/.omp/agent`). */
	agentDir: string;
	/** omp's `disabledProviders`: discovery providers whose files omp does not load. */
	disabled: readonly string[];
	/** omp's `contextFiles.extra`: more file names looked for as `AGENTS.md` is. */
	extra: readonly string[];
}

interface Found {
	path: string;
	level: "project" | "user";
}

/** Whether `child` is `parent` or inside it. */
const within = (parent: string, child: string): boolean => {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
};

/** The repository `cwd` is in: the nearest folder at or above it that holds `.git`; null when none does. */
export function repoRootOf(cwd: string): string | null {
	for (let dir = cwd; ; dir = dirname(dir)) {
		if (existsSync(join(dir, ".git"))) return dir;
		if (dirname(dir) === dir) return null;
	}
}

/** The folders of the `AGENTS.md` walk (omp's standalone context-file walk), nearest first. */
export function standaloneWalk(cwd: string, home: string, repo: string | null): string[] {
	const underHome = within(home, cwd);
	const repoIsHome = repo !== null && repo === home;
	const repoUnderHome = repo !== null && within(home, repo) && !repoIsHome;
	const toHome = repo !== null && underHome && repoUnderHome;
	const stop = toHome ? home : (repo ?? (underHome ? home : parse(cwd).root));
	const readStop = repo === null ? underHome : stop !== home || repoIsHome;
	const out: string[] = [];
	for (let dir = cwd; ; dir = dirname(dir)) {
		const atStop = dir === stop;
		const skip = (toHome && dir === home) || (atStop && !readStop) || basename(dir).startsWith(".");
		if (!skip) out.push(dir);
		if (atStop || dirname(dir) === dir) break;
	}
	return out;
}

/** The folders of the walk of `.omp`, `.agent` and `.agents`: the folder up to the repository or the home folder, not the home folder. */
export function dotWalk(cwd: string, home: string, repo: string | null): string[] {
	const out: string[] = [];
	for (let dir = cwd; ; dir = dirname(dir)) {
		if (dir !== home) out.push(dir);
		if (dir === (repo ?? home) || dirname(dir) === dir) break;
	}
	return out;
}

/** Every context file omp may load for `cwd`, by the rules above, whether or not it exists; nearest first, the person's own last. */
export function contextFileCandidates(
	cwd: string,
	rules: ContextFileRules,
	repo: string | null = repoRootOf(cwd),
): Found[] {
	const on = (provider: string) => !rules.disabled.includes(provider);
	const { home } = rules;
	const project: string[] = [];
	const names = [
		...(on("agents-md") ? ["AGENTS.md"] : []),
		...(on("claude-md") ? ["CLAUDE.md"] : []),
		...(on("custom-context") ? rules.extra.filter((n) => n && !n.includes("/") && !n.includes("\\")) : []),
	];
	for (const dir of standaloneWalk(cwd, home, repo)) for (const name of names) project.push(join(dir, name));
	for (const dir of dotWalk(cwd, home, repo)) {
		if (on("native")) project.push(join(dir, ".omp", "AGENTS.md"));
		if (on("agents")) project.push(join(dir, ".agent", "AGENTS.md"), join(dir, ".agents", "AGENTS.md"));
	}
	if (on("claude")) project.push(join(cwd, ".claude", "CLAUDE.md"));
	if (on("gemini")) project.push(join(cwd, ".gemini", "GEMINI.md"));
	if (on("github")) project.push(join(cwd, ".github", "copilot-instructions.md"));
	const user: string[] = [];
	if (on("native")) user.push(join(rules.agentDir, "AGENTS.md"));
	if (on("claude")) user.push(join(home, ".claude", "CLAUDE.md"));
	if (on("agents")) user.push(join(home, ".agent", "AGENTS.md"), join(home, ".agents", "AGENTS.md"));
	if (on("codex")) user.push(join(home, ".codex", "AGENTS.md"));
	if (on("gemini")) user.push(join(home, ".gemini", "GEMINI.md"));
	if (on("opencode")) user.push(join(home, ".config", "opencode", "AGENTS.md"));
	if (on("github"))
		user.push(join(process.env.COPILOT_HOME?.trim() || join(home, ".copilot"), "copilot-instructions.md"));
	return [
		...project.map((path) => ({ path, level: "project" as const })),
		...user.map((path) => ({ path, level: "user" as const })),
	];
}

/** The most of one file that is read: what the Files tab edits at most. A longer file is read in part and never changed. */
const READ_MAX = 1024 * 1024;

/** The beginning of the regular file `path` as UTF-8 (at most `READ_MAX` bytes), and whether there was more; null when it is not one. */
async function readText(path: string): Promise<{ text: string; more: boolean } | null> {
	try {
		const info = await stat(path);
		if (!info.isFile()) return null;
		const handle = await open(path, "r");
		try {
			const size = Math.min(info.size, READ_MAX);
			const buffer = Buffer.alloc(size);
			const { bytesRead } = await handle.read(buffer, 0, size, 0);
			return {
				text: buffer
					.subarray(0, bytesRead)
					.toString("utf8")
					.replace(/^\uFEFF/, ""),
				more: info.size > READ_MAX,
			};
		} finally {
			await handle.close();
		}
	} catch {
		return null;
	}
}

/** `path` as the page shows it: relative to the conversation's folder `cwd` when it is in it, else `~/…` under the home folder. */
export function labelOf(path: string, cwd: string, home: string): string {
	if (within(cwd, path)) return relative(cwd, path);
	return within(home, path) && path !== home ? `~/${relative(home, path)}` : path;
}

/**
 * The context files of `cwd` that exist and say something, as sources `f1`, `f2`…. `editable` says where the Files tab may
 * write one (its path relative to the conversation's folder), or null.
 */
export async function contextFiles(
	cwd: string,
	rules: ContextFileRules,
	editable: (abs: string) => Promise<string | null>,
): Promise<SourceText[]> {
	const out: SourceText[] = [];
	const seen = new Set<string>();
	for (const found of contextFileCandidates(cwd, rules)) {
		const real = await realpath(found.path).catch(() => null);
		if (!real || seen.has(real)) continue;
		seen.add(real);
		const read = await readText(real);
		if (!read?.text.trim()) continue;
		out.push({
			id: `f${out.length + 1}`,
			kind: "file",
			label: labelOf(found.path, cwd, rules.home),
			level: found.level,
			// A file read in part is never rewritten from that part.
			rel: read.more ? null : await editable(found.path),
			truncated: read.more,
			text: read.text,
		});
	}
	return out;
}

/** A memory's first words, for the page. */
const memoryLabel = (content: string): string => {
	const line = content.replace(/\s+/g, " ").trim();
	return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line;
};

/** The memories as sources `m1`, `m2`…, the newest first, at most `CONFLICT_LIMITS.memories`. */
export function memorySources(items: readonly MemoryItem[]): SourceText[] {
	return items.slice(0, CONFLICT_LIMITS.memories).map((m, i) => ({
		id: `m${i + 1}`,
		kind: "memory",
		label: memoryLabel(m.content),
		level: m.scope === "global" ? "user" : "project",
		rel: null,
		bank: m.bank,
		memoryId: m.id,
		truncated: m.truncated,
		text: m.content,
	}));
}
