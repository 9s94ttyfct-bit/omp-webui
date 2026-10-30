import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { dropGroupAndOther } from "../private.ts";
import { type Folder, holdsConversation } from "./folders.ts";

/**
 * The folders conversations are kept in besides omp's own agent directory: the ones the server has started omp with
 * `--session-dir <dir>`, and the agent directories of the profiles it has started omp with (`--profile <name>`).
 *
 * A conversation started with one of those keeps its transcript where the server does not look by itself, so it would
 * run and then be lost to the page: the sidebar never lists it and, once its process is gone, it cannot be reopened.
 * The server therefore remembers the folders it has started omp with (in its own data dir, so they survive a restart)
 * and reads them like its own sessions directory.
 *
 * The roots are what the *server* has started omp with, not every folder that holds a conversation: a folder the user
 * names in a terminal is that terminal's own business, and nothing here would list it.
 */

/** How a root was named, and what it means for the conversations in it. */
export type RootKind = "session-dir" | "profile";

/** A folder conversations are kept in, and how it came to be known. */
export interface SessionRoot {
	/** The absolute path of the folder the session files are in. */
	dir: string;
	kind: RootKind;
	/** The profile's name (for a `profile` root); the session directory's path (for a `session-dir` root). */
	name: string;
	/**
	 * The agent directory the conversations of this root belong to: the profile's own (a profile keeps its auth,
	 * settings and images there) for a `profile` root; the server's own for a `session-dir` root (only the place the
	 * transcripts are kept moves there).
	 */
	agentDir: string;
	/** When the server last saw the folder used. */
	usedAt: number;
}

/** What is remembered about the roots: a list of them, newest first. */
interface RootsFile {
	roots: SessionRoot[];
}

/** The file the roots are kept in, in the server's own data dir. */
const FILE = "session-roots.json";

/**
 * A root that holds no conversation is forgotten when it has not been used for this long (a week): a folder omp was
 * started with and never wrote to. One that holds a conversation is never forgotten, however long ago it was used:
 * forgetting it would take every conversation in it out of the sidebar, the search and the reopening.
 */
const UNUSED_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The path a file is really at: the links in it are resolved, so that a file found under it and the folder itself
 * are the same path. The part that does not exist yet (a folder omp has not written to yet) is left as it is.
 */
export function canonical(p: string): string {
	let at = resolve(p);
	const rest: string[] = [];
	for (;;) {
		try {
			const real = realpathSync(at);
			return rest.length ? join(real, ...rest.reverse()) : real;
		} catch {
			const parent = dirname(at);
			if (parent === at) return p;
			rest.push(basename(at));
			at = parent;
		}
	}
}

/**
 * A profile's own agent directory: a profile keeps its auth, settings, caches and conversations there, apart from
 * the server's own. It is under the *user's* home (omp 18.12.4: `~/.omp/profiles/<name>/agent`), not under the agent
 * directory the process was pointed at: a profile is the user's own, wherever the server runs.
 */
export function profileAgentDir(profile: string, home = homedir()): string {
	return join(canonical(home), ".omp", "profiles", profile, "agent");
}

/** Where a profile's conversations are: its own agent directory's `sessions/` folder. */
export function profileSessionsDir(profile: string, home = homedir()): string {
	return join(profileAgentDir(profile, home), "sessions");
}

/**
 * The roots the server remembers, in its data dir. The file is written whole each time a root is added, and read
 * when the server starts: a file that cannot be read is kept aside and a new one is made, so a damaged file never
 * stops the server from listing the conversations it knows.
 */
export class SessionRoots {
	private roots: SessionRoot[] = [];

	constructor(
		private readonly dataDir: string,
		/** The home directory the profiles are under (the user's own, not the server's). */
		private readonly home: string = homedir(),
		/** The server's own agent directory: where the conversations of a `--session-dir` root keep their images. */
		private readonly agentDir: string = join(canonical(home), ".omp", "agent"),
	) {
		this.read();
	}

	/** The file the roots are in. */
	private get path(): string {
		return join(this.dataDir, FILE);
	}

	private read(): void {
		let text: string;
		try {
			text = readFileSync(this.path, "utf8");
		} catch (e) {
			// No file yet (a fresh data dir): there are no roots, and the file is made when the first one is added.
			// Any other failure is a file that is there and that is not read: it is kept, not written over.
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.keepAside(e);
			return;
		}
		let list: unknown;
		try {
			list = (JSON.parse(text) as Partial<RootsFile> | null)?.roots;
		} catch {
			list = null;
		}
		// Cut off, or not a list of roots: kept aside, so the conversations it names are not lost, only not listed yet.
		if (!Array.isArray(list)) {
			this.keepAside(new Error("it is not a list of roots"));
			return;
		}
		this.roots = list.filter(isRoot);
	}

	/** The file was replaced under the running server (an import brought another machine's): read it again. */
	reload(): void {
		this.roots = [];
		this.read();
	}

	/** The roots as the folders the store reads, with the layout each has. */
	folders(): Folder[] {
		return this.roots.map(folderOf);
	}

	/** The roots as they are now, newest first. */
	list(): SessionRoot[] {
		return [...this.roots].sort((a, b) => b.usedAt - a.usedAt);
	}

	/**
	 * Remember a root: the folder conversations started with `--session-dir <dir>` or `--profile <name>` are kept in.
	 * The same root again is refreshed, not duplicated.
	 */
	add(root: Omit<SessionRoot, "usedAt"> & { usedAt?: number }): SessionRoot {
		const dir = canonical(root.dir);
		const at = root.usedAt ?? Date.now();
		const found = this.roots.find((r) => r.dir === dir);
		const entry: SessionRoot = { ...root, dir, usedAt: at };
		if (found) Object.assign(found, entry);
		else this.roots.unshift(entry);
		this.prune(at);
		this.write();
		return entry;
	}

	/** The roots that are worth keeping: one that holds a conversation, or that was used lately. */
	private prune(now: number): void {
		this.roots = this.roots.filter((r) => now - r.usedAt <= UNUSED_MS || holdsConversation(folderOf(r)));
	}

	/** Write the roots down, so that a server that starts later knows them too. */
	private write(): void {
		try {
			mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
			const file = this.path;
			const text = `${JSON.stringify({ roots: this.list() } satisfies RootsFile, null, "\t")}\n`;
			// Written aside and renamed into place: a file that is being written is never read half-written.
			const aside = `${file}.new`;
			writeFileSync(aside, text, { mode: 0o600 });
			dropGroupAndOther(aside);
			renameSync(aside, file);
		} catch (e) {
			console.warn(`omp-webui: the session folders could not be written down: ${(e as Error).message}`);
		}
	}

	/** A file that cannot be read is kept beside the new one, so that nothing is lost. */
	private keepAside(why: unknown): void {
		const aside = `${this.path}.broken`;
		try {
			renameSync(this.path, aside);
			console.warn(
				`omp-webui: ${this.path} could not be read (${why instanceof Error ? why.message : String(why)}); it was moved to ${aside}`,
			);
		} catch {
			// it is already gone
		}
	}

	/**
	 * The roots for the flags of a new conversation that runs in `cwd`: what `--session-dir <dir>` and `--profile <name>`
	 * in `args` mean as folders of conversations. A flag that is not there gives no root.
	 */
	rootsFor(args: string[], cwd: string): Omit<SessionRoot, "usedAt">[] {
		const out: Omit<SessionRoot, "usedAt">[] = [];
		for (const arg of args) {
			const [flag, value] = splitFlag(arg);
			if (!value) continue;
			if (flag === "--session-dir") {
				// omp resolves a relative value against the folder it runs in (and does not expand `~`).
				const dir = canonical(resolve(cwd, value));
				// A value that is there and is not a folder (a pasted transcript path) fails in omp, and holds nothing.
				if (isFile(dir)) continue;
				out.push({ dir, kind: "session-dir", name: dir, agentDir: this.agentDir });
			} else if (flag === "--profile" && value) {
				const agent = profileAgentDir(value, this.home);
				out.push({
					dir: join(agent, "sessions"),
					kind: "profile",
					name: value,
					agentDir: agent,
				});
			}
		}
		return out;
	}

	/**
	 * Remember the folders the flags of a new conversation that runs in `cwd` name: what `--session-dir <dir>` and
	 * `--profile <name>` mean as folders of conversations. A flag that names nothing (an empty value) is ignored.
	 */
	note(args: string[], cwd: string): SessionRoot[] {
		const out: SessionRoot[] = [];
		for (const root of this.rootsFor(args, cwd)) {
			out.push(this.add(root));
		}
		return out;
	}

	/** The root a session file is in, or null when it is in none of them. */
	rootOf(file: string): SessionRoot | null {
		// The file is compared as it really is: the path a client holds may have a link in it (`/var` is a link to
		// `/private/var` on macOS), and the roots are the real paths.
		const at = canonical(file);
		for (const root of this.roots) {
			const rel = relativeTo(root.dir, at);
			if (rel) return root;
		}
		return null;
	}

	/**
	 * The flags an omp must be started with for the conversation in `file`: a profile's conversation is run with its
	 * own profile (its auth, settings and images are there, not in the server's own agent directory), a
	 * `--session-dir` one with the directory it is kept in.
	 */
	flagsFor(file: string): string[] {
		const root = this.rootOf(file);
		if (!root) return [];
		if (root.kind === "profile") return [`--profile=${root.name}`];
		return [`--session-dir=${root.dir}`];
	}

	/**
	 * The agent directory the conversation in `file` belongs to: the profile's own for a profile's conversation (its
	 * images are there), the server's own otherwise.
	 */
	agentDirFor(file: string): string {
		return this.rootOf(file)?.agentDir ?? this.agentDir;
	}
}

/** Whether `path` is there and is not a directory. */
function isFile(path: string): boolean {
	try {
		return !statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** How the conversations are laid out in a root: a `--session-dir` is flat, a profile's folder is in buckets. */
function folderOf(root: SessionRoot): Folder {
	return { dir: root.dir, flat: root.kind === "session-dir" };
}

/** Whether `file` is inside `dir` (and not the folder itself), and the path it is at there. */
function relativeTo(dir: string, file: string): string | null {
	const rel = file.startsWith(`${dir}/`) ? file.slice(dir.length + 1) : null;
	return rel && !rel.startsWith("..") ? rel : null;
}

/** A flag and its value, both as written (`--profile=x` and `--profile x` alike). */
function splitFlag(arg: string): [string, string | null] {
	const eq = arg.indexOf("=");
	if (eq >= 0) return [arg.slice(0, eq), arg.slice(eq + 1)];
	return [arg, null];
}

/** Whether a record read from the file is a root. */
function isRoot(r: unknown): r is SessionRoot {
	if (!r || typeof r !== "object") return false;
	const root = r as Partial<SessionRoot>;
	return (
		typeof root.dir === "string" &&
		(root.kind === "session-dir" || root.kind === "profile") &&
		typeof root.name === "string" &&
		typeof root.agentDir === "string" &&
		typeof root.usedAt === "number"
	);
}
