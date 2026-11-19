import { open, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { CONFLICT_LIMITS } from "../../../shared/guidance-conflict.ts";
import type { MemoryItem } from "../../../shared/memory.ts";
import type { SourceText } from "./conflict.ts";
import type { LoadedFile } from "./loaded-context.ts";

/**
 * What the guidance conflict check compares the guidance with (`conflict.ts`): the context files omp loads for the
 * conversation's folder, and the memories omp keeps for that project.
 *
 * The files are the ones omp itself says it gives the agent (`loaded-context.ts`, #308), each with the text the agent
 * sees: an `@` import is already replaced by what it names. Empty files are left out.
 */

/** Whether `child` is `parent` or inside it. */
const within = (parent: string, child: string): boolean => {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
};

/** The folders omp's discovery providers keep their file in, beside the folder it is for (`.omp/AGENTS.md`, `~/.claude/CLAUDE.md`). */
const PROVIDER_DIRS = new Set([".omp", ".agent", ".agents", ".claude", ".gemini", ".github"]);

/**
 * Whether `path` is the person's own (a file of their home folder or omp's agent folder, for every folder) or the project's
 * (in the folder or one above it).
 */
export function levelOf(path: string, cwd: string, home: string): "project" | "user" {
	const dir = dirname(path);
	const base = PROVIDER_DIRS.has(basename(dir)) ? dirname(dir) : dir;
	if (base === home && base !== dir) return "user";
	return within(base, cwd) ? "project" : "user";
}

/** The most of one file that is read to tell whether it is what omp gave the agent: what the Files tab edits at most. */
const READ_MAX = 1024 * 1024;

/** The beginning of the regular file `path` as UTF-8 (at most `READ_MAX` bytes); null when it is not one. */
async function readText(path: string): Promise<string | null> {
	try {
		const info = await stat(path);
		if (!info.isFile() || info.size > READ_MAX) return null;
		const handle = await open(path, "r");
		try {
			const buffer = Buffer.alloc(info.size);
			const { bytesRead } = await handle.read(buffer, 0, info.size, 0);
			return buffer
				.subarray(0, bytesRead)
				.toString("utf8")
				.replace(/^\uFEFF/, "");
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
 * The context files omp gave the agent for `cwd` that say something, as sources `f1`, `f2`…, in the order omp lists them.
 * `editable` says where the Files tab may write one (its path relative to the conversation's folder), or null. A change is
 * proposed for a file only when its text is what the file holds: a file with an `@` import in it reads longer to the agent
 * than it is on the disk, and a change found in the imported text cannot be made in the file.
 */
export async function contextSources(
	loaded: readonly LoadedFile[],
	cwd: string,
	home: string,
	editable: (abs: string) => Promise<string | null>,
): Promise<SourceText[]> {
	const out: SourceText[] = [];
	const seen = new Set<string>();
	// omp names a place as the process saw it (a `/var` that is `/private/var`): files and folder are compared as they are really.
	const realCwd = await realpath(cwd).catch(() => cwd);
	const realHome = await realpath(home).catch(() => home);
	for (const file of loaded) {
		const real = await realpath(file.path).catch(() => file.path);
		if (seen.has(real) || !file.text.trim()) continue;
		seen.add(real);
		const onDisk = await readText(real);
		// Where the file is, by its own name (a link to it elsewhere is still named where omp found it).
		const place = join(await realpath(dirname(file.path)).catch(() => dirname(file.path)), basename(file.path));
		out.push({
			id: `f${out.length + 1}`,
			kind: "file",
			label: labelOf(place, realCwd, realHome),
			level: levelOf(place, realCwd, realHome),
			rel: onDisk !== null && onDisk.trim() === file.text.trim() ? await editable(file.path) : null,
			truncated: false,
			text: file.text,
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
