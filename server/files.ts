import { existsSync, realpathSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * File paths under a working directory for `@file` mention completion. omp
 * itself expands `@path` mentions in prompts (as `fileMention` messages); this
 * only suggests paths, confined to the directory.
 *
 * The working directory may be a home folder with millions of files in caches
 * and libraries, so the walk is bounded: it goes breadth first (shallow files
 * come first), never enters hidden, dependency or build directories, stops at
 * an entry or time limit with what it has, and concurrent requests for one
 * directory share a single walk.
 */

/** The part of a directory entry the walk looks at; `readdir(…, { withFileTypes: true })` returns these. */
export interface DirEntry {
	name: string;
	isFile(): boolean;
	isDirectory(): boolean;
}
export type ReadDir = (dir: string) => Promise<DirEntry[]>;

export interface ScanLimits {
	/** Files kept. */
	maxFiles: number;
	/** Directory entries looked at, kept or not. */
	maxEntries: number;
	/** Time to walk, in ms; a directory that never answers must not hold up the request. */
	maxMs: number;
}

export const SCAN_LIMITS: ScanLimits = { maxFiles: 20_000, maxEntries: 100_000, maxMs: 1500 };
const CONCURRENCY = 8;
/**
 * A list is reused while requests keep coming (one is sent per keystroke after `@`), and only that long: a file the
 * agent has just written is wanted the next time `@` is typed. A walk is a few directory reads for a project, and bounded
 * by `SCAN_LIMITS` for a home folder.
 */
const BURST_MS = 1000;
const CACHED_DIRS = 8;

/** Dependency and build output; never walked, whatever the project. */
const SKIP_DIRS = new Set(["node_modules", "__pycache__", "dist", "build", "target"]);
/** Hidden directories (`.git`, `.cache`, `.venv`, …) are skipped, except the one people point omp at. */
const KEPT_HIDDEN_DIRS = new Set([".github"]);

function canonical(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

/** `~/Library` (macOS) holds caches and app data by the hundred thousand; none of it is a project file. */
const SKIP_PATHS = new Set(process.platform === "darwin" ? [join(canonical(homedir()), "Library")] : []);

function skipped(name: string, path: string): boolean {
	if (SKIP_DIRS.has(name) || SKIP_PATHS.has(path)) return true;
	return name.startsWith(".") && !KEPT_HIDDEN_DIRS.has(name);
}

/**
 * Whether the Files tab leaves an entry out until the page asks for everything: a folder the `@` walk never enters
 * (dependency and build output, hidden folders but `.github`), and any dotfile. `path` is the entry's absolute path.
 */
export function hiddenByDefault(name: string, isDirectory: boolean, path: string): boolean {
	return isDirectory ? skipped(name, path) : name.startsWith(".");
}

/** The folders the walk does not enter; it is told by the folder's name and absolute path. */
export type SkipRule = (name: string, path: string) => boolean;

/** The rule of a walk that is told to show everything: only a repository's own data (`.git`) and `~/Library` stay out. */
export const skipRepositoryData: SkipRule = (name, path) => name === ".git" || SKIP_PATHS.has(path);

const readDirEntries: ReadDir = (dir) => readdir(dir, { withFileTypes: true });

export interface ScanResult {
	/** Relative to the root, sorted. */
	files: string[];
	/** False when a limit ended the walk: `files` are the shallowest ones, and the next walk may find more. */
	complete: boolean;
}

/**
 * The files under `root` (symlinks are not followed), relative to it and sorted. When a limit is hit
 * the walk ends and returns what it found so far; being breadth first, that is the shallowest files.
 */
export async function scanFiles(
	root: string,
	limits: ScanLimits = SCAN_LIMITS,
	readDir: ReadDir = readDirEntries,
	skip: SkipRule = skipped,
): Promise<ScanResult> {
	const files: string[] = [];
	/** Directories still to read, relative to `root`, in breadth-first order. */
	const queue = [""];
	let next = 0;
	let reading = 0;
	let entries = 0;
	let finished = false;
	let complete = true;
	const done = Promise.withResolvers<void>();
	const finish = () => {
		finished = true;
		done.resolve();
	};
	/** A limit, not the end of the tree, ends the walk. */
	const cut = () => {
		complete = false;
		finish();
	};

	const visit = async (dir: string) => {
		let list: DirEntry[];
		try {
			list = await readDir(dir ? join(root, dir) : root);
		} catch {
			return; // unreadable (permissions, vanished)
		}
		for (const entry of list) {
			if (finished) return;
			if (++entries > limits.maxEntries) return cut();
			const path = dir ? `${dir}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (!skip(entry.name, join(root, path))) queue.push(path);
			} else if (entry.isFile()) {
				files.push(path);
				if (files.length >= limits.maxFiles) return cut();
			}
		}
	};

	const pump = () => {
		while (!finished && reading < CONCURRENCY && next < queue.length) {
			reading++;
			void visit(queue[next++]).finally(() => {
				reading--;
				pump();
			});
		}
		if (reading === 0) finish();
	};
	const timer = setTimeout(cut, limits.maxMs);
	pump();
	await done.promise;
	clearTimeout(timer);
	return { files: files.sort(), complete };
}

/**
 * Scan results by directory, kept for a burst of requests only; one scan at a time per directory. A walk that a limit cut
 * short is not kept at all: the next request walks again, and may get further.
 */
export class FileIndex {
	private readonly cache = new Map<string, { at: number; files: string[] }>();
	private readonly scans = new Map<string, Promise<ScanResult>>();

	constructor(private readonly scan: (dir: string) => Promise<ScanResult> = (dir) => scanFiles(dir)) {}

	async list(dir: string): Promise<string[]> {
		return (await this.walk(dir)).files;
	}

	/**
	 * `list` with whether the walk ended at its limits (the Files tab's filter says so). `fresh`: walk again, whatever is
	 * kept or being walked, because something was seen to change: a walk that began earlier does not keep its older answer
	 * over this one's.
	 */
	walk(dir: string, fresh = false): Promise<ScanResult> {
		if (!fresh) {
			const hit = this.cache.get(dir);
			if (hit && Date.now() - hit.at < BURST_MS) return Promise.resolve({ files: hit.files, complete: true });
			const running = this.scans.get(dir);
			if (running) return running;
		}
		this.cache.delete(dir);
		const scan: Promise<ScanResult> = this.scan(dir)
			.then((result) => {
				if (result.complete && this.scans.get(dir) === scan) this.remember(dir, result.files);
				return result;
			})
			.finally(() => {
				if (this.scans.get(dir) === scan) this.scans.delete(dir);
			});
		this.scans.set(dir, scan);
		return scan;
	}

	private remember(dir: string, files: string[]): void {
		const now = Date.now();
		this.cache.delete(dir);
		for (const [d, entry] of this.cache) if (now - entry.at >= BURST_MS) this.cache.delete(d);
		// Map order is insertion order: the first keys are the oldest.
		for (const d of this.cache.keys()) {
			if (this.cache.size < CACHED_DIRS) break;
			this.cache.delete(d);
		}
		this.cache.set(dir, { at: now, files });
	}
}

const index = new FileIndex();

export async function suggestFiles(cwd: string, query: string, limit = 50): Promise<string[]> {
	const dir = realpathSync(resolve(cwd));
	if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error("Not a directory");
	const q = query.toLowerCase();
	const files = await index.list(dir);
	const scored: { f: string; score: number }[] = [];
	for (const f of files) {
		const lower = f.toLowerCase();
		const base = lower.slice(lower.lastIndexOf("/") + 1);
		const score = !q ? 1 : lower.startsWith(q) ? 0 : base.startsWith(q) ? 1 : lower.includes(q) ? 2 : -1;
		if (score >= 0) scored.push({ f, score });
	}
	scored.sort((a, b) => a.score - b.score || a.f.length - b.f.length);
	return scored.slice(0, limit).map((s) => s.f);
}
