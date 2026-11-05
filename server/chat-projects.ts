import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type ChatProject,
	type ChatProjects,
	type ChatProjectsAnswer,
	newProjectId,
	PROJECT_LIMIT,
	PROJECT_SESSIONS_MAX,
	type ProjectNameProblem,
	parseChatProjects,
	parseProjectFolder,
	parseProjectName,
	parseSessionId,
	projectNameProblem,
	projectsFromGroups,
	serializeChatProjects,
} from "../shared/chat-projects.ts";
import { CodedError } from "../shared/error-info.ts";
import { isRecord } from "../shared/guards.ts";

/**
 * The sidebar's projects (`shared/chat-projects.ts`): `<data dir>/chat-projects.json`, this app's own data, next to the
 * archive and the favourite models. Nothing here touches a conversation or a folder.
 *
 * It is written whole — into a file beside it, mode 0600, moved into place — so a crash or a kill never leaves half a list;
 * a file that is not a list at all is kept beside itself as `.damaged` before the next change writes over it. A file that is
 * a list but carries entries that do not fit loses only those: the rest is the person's, and is shown.
 *
 * Every page is told of a change (`onChange` → `chat_projects` over the socket), as with the archive: the projects are the
 * person's, not one page's.
 *
 * The first read when the file is not there yet makes it from the project groups of #636 (`project-groups.json`, which is
 * left where it is): each group becomes a project of its name holding the conversations that ran in its folders
 * (`projectsFromGroups`). After that the old file is not read again.
 */

/** What is wrong with a request to change the projects: the whole change is refused, nothing is written. */
export class ChatProjectError extends CodedError {
	constructor(
		message: string,
		readonly status: number,
		code: "projectNameInvalid" | "projectFolderInvalid" | "projectSessionInvalid" | "projectUnknown" | "projectFull",
		params: Record<string, string | number> = {},
	) {
		super(message, code, params);
	}
}

const nameRefusal = (problem: ProjectNameProblem) =>
	new ChatProjectError(
		problem === "taken" ? "A project already has that name" : `A project cannot be called that: ${problem}`,
		400,
		"projectNameInvalid",
		{ problem },
	);

const unknown = () => new ChatProjectError("No such project", 404, "projectUnknown");

/** What a file holds, and whether anything in it had to be dropped. */
interface Loaded {
	projects: ChatProject[];
	excluded: string[];
	damaged: boolean;
}

/** What the store asks of the conversations: their ids and folders, for the move from project groups. */
export type SessionsOf = () => Promise<readonly { id: string; cwd: string }[]>;

/** Whether `path` is a folder now (links followed). */
function isFolder(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

export class ChatProjectStore {
	private readonly file: string;
	private readonly groupsFile: string;
	private known: { stamp: string; loaded: Loaded } | null = null;
	/** Changes are made one after another: two would otherwise both read the file before the other wrote it. */
	private queue: Promise<unknown> = Promise.resolve();
	/** The move from project groups, done once (the first read waits for it). */
	private migrated: Promise<void> | null = null;

	/** `onChange` runs after every change that was written: every open page is told, and asks again. */
	constructor(
		dataDir: string,
		private readonly sessionsOf: SessionsOf,
		private readonly onChange: () => void = () => {},
		/** Whether a folder may be a project's (tests replace the file system's answer). */
		private readonly folderExists: (path: string) => boolean = isFolder,
	) {
		this.file = join(dataDir, "chat-projects.json");
		this.groupsFile = join(dataDir, "project-groups.json");
	}

	/** The projects as a page sees them. */
	async list(): Promise<ChatProjects> {
		await this.migrate();
		const loaded = this.load();
		return { projects: loaded.projects, excluded: loaded.excluded, problem: loaded.damaged ? "damaged" : null };
	}

	/** The folder of a project (the Files panel of its folder button), or null: no such project, or it has none. */
	async folderOf(id: string): Promise<string | null> {
		await this.migrate();
		return this.load().projects.find((p) => p.id === id)?.folder ?? null;
	}

	/** Make a project at the end of the list, with a folder and conversations put in it at once when they are given. */
	create(name: string, folder: string | null = null, sessions: readonly unknown[] = []): Promise<ChatProjectsAnswer> {
		return this.change((loaded) => {
			if (loaded.projects.length >= PROJECT_LIMIT)
				throw new ChatProjectError("There are as many projects as there can be", 409, "projectFull");
			const parsed = this.name(loaded.projects, name, null);
			const project: ChatProject = {
				id: newProjectId(loaded.projects.map((p) => p.id)),
				name: parsed,
				folder: folder === null ? null : this.folder(folder),
				order: loaded.projects.length,
				collapsed: false,
				sessions: [],
			};
			return this.placed({ ...loaded, projects: [...loaded.projects, project] }, this.ids(sessions), project.id);
		});
	}

	/** Give a project another name. Its place, its conversations and whether it is folded do not change. */
	rename(id: string, name: string): Promise<ChatProjectsAnswer> {
		return this.change((loaded) => {
			const at = this.at(loaded, id);
			const parsed = this.name(loaded.projects, name, id);
			return this.with(loaded, at, { name: parsed });
		});
	}

	/** Set the project's folder (an existing folder), or take it away (`null`). */
	setFolder(id: string, folder: string | null): Promise<ChatProjectsAnswer> {
		return this.change((loaded) => {
			const at = this.at(loaded, id);
			return this.with(loaded, at, { folder: folder === null ? null : this.folder(folder) });
		});
	}

	/** Fold a project in the sidebar, or open it. */
	setCollapsed(id: string, collapsed: boolean): Promise<ChatProjectsAnswer> {
		return this.change((loaded) => this.with(loaded, this.at(loaded, id), { collapsed }));
	}

	/**
	 * Put conversations (their session ids) in a project, or with `project` null take them out of every project. Taken out,
	 * they are remembered as out (`excluded`), so a branch is not in its parent's project after the person took it out.
	 */
	assign(sessions: readonly unknown[], project: string | null): Promise<ChatProjectsAnswer> {
		return this.change((loaded) => {
			if (project !== null) this.at(loaded, project);
			return this.placed(loaded, this.ids(sessions), project);
		});
	}

	/** Remove a project. Its conversations are in no project again (back in the sidebar's list by date); none is touched. */
	remove(id: string): Promise<ChatProjectsAnswer> {
		return this.change((loaded) => {
			const at = this.at(loaded, id);
			const projects = loaded.projects.toSpliced(at, 1).map((p, order) => (p.order === order ? p : { ...p, order }));
			return { next: { ...loaded, projects }, project: null };
		});
	}

	/** Move a project up or down the list (`delta`: -1 or 1), swapping places with its neighbour. */
	reorder(id: string, delta: number): Promise<ChatProjectsAnswer> {
		return this.change((loaded) => {
			const at = this.at(loaded, id);
			const to = Math.max(0, Math.min(loaded.projects.length - 1, at + (delta < 0 ? -1 : 1)));
			if (to === at) return { next: loaded, project: loaded.projects[at] ?? null };
			const projects = loaded.projects
				.toSpliced(at, 1)
				.toSpliced(to, 0, loaded.projects[at] as ChatProject)
				.map((p, order) => ({ ...p, order }));
			return { next: { ...loaded, projects }, project: projects[to] ?? null };
		});
	}

	private at(loaded: Loaded, id: string): number {
		const at = loaded.projects.findIndex((p) => p.id === id);
		if (at < 0) throw unknown();
		return at;
	}

	private name(projects: readonly ChatProject[], name: string, except: string | null): string {
		const problem = projectNameProblem(projects, name, except);
		if (problem) throw nameRefusal(problem);
		const parsed = parseProjectName(name);
		if (!parsed.ok) throw nameRefusal(parsed.problem);
		return parsed.name;
	}

	/** A folder a project may have: an absolute path that is a folder now (it may go later: the page says so then). */
	private folder(value: string): string {
		const folder = parseProjectFolder(value);
		if (!folder || !this.folderExists(folder))
			throw new ChatProjectError("A project's folder is an existing folder", 400, "projectFolderInvalid");
		return folder;
	}

	private ids(values: readonly unknown[]): string[] {
		const ids = values.map(parseSessionId);
		if (ids.some((id) => id === null))
			throw new ChatProjectError("A conversation is named by its session id", 400, "projectSessionInvalid");
		return [...new Set(ids as string[])];
	}

	private with(loaded: Loaded, at: number, patch: Partial<ChatProject>): { next: Loaded; project: ChatProject } {
		const project = { ...(loaded.projects[at] as ChatProject), ...patch };
		return { next: { ...loaded, projects: loaded.projects.with(at, project) }, project };
	}

	/** `ids` out of every project, then into `project` (or remembered as out of all of them, for null). */
	private placed(
		loaded: Loaded,
		ids: readonly string[],
		project: string | null,
	): { next: Loaded; project: ChatProject | null } {
		const moving = new Set(ids);
		const projects = loaded.projects.map((p) => {
			const rest = p.sessions.filter((s) => !moving.has(s));
			if (p.id === project) return { ...p, sessions: [...rest, ...ids] };
			return rest.length === p.sessions.length ? p : { ...p, sessions: rest };
		});
		const held = projects.reduce((n, p) => n + p.sessions.length, 0);
		if (held > PROJECT_SESSIONS_MAX)
			throw new ChatProjectError("The projects hold as many conversations as they can", 409, "projectFull");
		const kept = loaded.excluded.filter((s) => !moving.has(s));
		// The oldest of what was taken out goes first when the list is full: it is the least likely to have a branch made now.
		const excluded = project === null ? [...kept, ...ids].slice(-PROJECT_SESSIONS_MAX) : kept;
		return {
			next: { ...loaded, projects, excluded },
			project: projects.find((p) => p.id === project) ?? null,
		};
	}

	/** One change at a time: `run` answers the list it leaves; it is written when it differs from what was there. */
	private change(run: (loaded: Loaded) => { next: Loaded; project: ChatProject | null }): Promise<ChatProjectsAnswer> {
		const answer = this.queue
			.then(() => this.migrate())
			.then(() => {
				const loaded = this.load();
				const { next, project } = run(loaded);
				const same =
					!loaded.damaged &&
					serializeChatProjects(next.projects, next.excluded) ===
						serializeChatProjects(loaded.projects, loaded.excluded);
				if (!same) this.write(loaded, next);
				return { projects: next.projects, excluded: next.excluded, problem: null, project };
			});
		this.queue = answer.catch(() => {});
		return answer;
	}

	/**
	 * The project groups of #636 as projects, when there is no list of projects yet (once per server). Conversations that
	 * cannot be listed now leave the move for the next look: made without them, every project would stay empty for good.
	 */
	private migrate(): Promise<void> {
		this.migrated ??= (async () => {
			if (existsSync(this.file) || !existsSync(this.groupsFile)) return;
			let raw: unknown;
			try {
				raw = JSON.parse(readFileSync(this.groupsFile, "utf8"));
			} catch (e) {
				console.warn(
					`omp-webui: ${this.groupsFile} cannot be read (${(e as Error).message}): no group became a project`,
				);
				return;
			}
			let sessions: readonly { id: string; cwd: string }[];
			try {
				sessions = await this.sessionsOf();
			} catch (e) {
				console.warn(
					`omp-webui: the conversations could not be listed for the projects (${(e as Error).message}): tried again later`,
				);
				this.migrated = null;
				return;
			}
			const projects = projectsFromGroups(raw, sessions);
			if (projects === null) {
				console.warn(`omp-webui: ${this.groupsFile} is not a list of groups: no group became a project`);
				return;
			}
			// Written even when no group made a project: the file being there is what says the move was made.
			if (!existsSync(this.file))
				this.write({ projects: [], excluded: [], damaged: false }, { projects, excluded: [], damaged: false });
		})();
		return this.migrated;
	}

	private stamp(): string {
		try {
			const info = statSync(this.file);
			return `${info.mtimeMs}:${info.size}:${info.ino}`;
		} catch {
			return "none";
		}
	}

	/** The file as it is now: read again when it changed since it was last read. */
	private load(): Loaded {
		const stamp = this.stamp();
		if (this.known?.stamp === stamp) return this.known.loaded;
		let loaded: Loaded;
		if (stamp === "none") loaded = { projects: [], excluded: [], damaged: false };
		else {
			try {
				let raw: unknown;
				try {
					raw = JSON.parse(readFileSync(this.file, "utf8"));
				} catch {
					raw = null;
				}
				const parsed = parseChatProjects(raw);
				if (parsed === null) {
					console.warn(`omp-webui: ${this.file} is not a list of projects; no project is listed`);
					loaded = { projects: [], excluded: [], damaged: true };
				} else {
					// Everything the file held came through: no project had to be dropped.
					const held = isRecord(raw) && Array.isArray(raw.projects) ? raw.projects.length : 0;
					loaded = { ...parsed, damaged: held !== parsed.projects.length };
					if (loaded.damaged)
						console.warn(`omp-webui: ${this.file} is not all usable: the projects that fit are listed`);
				}
			} catch (e) {
				console.warn(`omp-webui: ${this.file} cannot be read (${(e as Error).message}): no project is listed`);
				loaded = { projects: [], excluded: [], damaged: true };
			}
		}
		this.known = { stamp, loaded };
		return loaded;
	}

	/** Write the list whole and move it into place; a file that was not a list is kept beside it. */
	private write(before: Loaded, next: Loaded): void {
		mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
		if (before.damaged && existsSync(this.file)) {
			try {
				renameSync(this.file, `${this.file}.damaged`);
			} catch (e) {
				console.warn(`omp-webui: could not keep a copy of ${this.file}: ${(e as Error).message}`);
			}
		}
		const temporary = `${this.file}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, serializeChatProjects(next.projects, next.excluded), { mode: 0o600 });
			// The mode asked for is cut by the umask; the list is private whatever it is.
			chmodSync(temporary, 0o600);
			renameSync(temporary, this.file);
		} catch (e) {
			rmSync(temporary, { force: true });
			throw e;
		}
		this.known = { stamp: this.stamp(), loaded: { projects: next.projects, excluded: next.excluded, damaged: false } };
		this.onChange();
	}
}
