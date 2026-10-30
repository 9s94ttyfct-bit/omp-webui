import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CodedError } from "../shared/error-info.ts";
import { isRecord } from "../shared/guards.ts";
import {
	type GroupNameProblem,
	groupNameProblem,
	newGroupId,
	type ProjectGroup,
	type ProjectGroups,
	type ProjectGroupsAnswer,
	parseGroupName,
	parseGroups,
	serializeGroups,
} from "../shared/project-groups.ts";

/**
 * The sidebar's project groups (#636): `<data dir>/project-groups.json`, this app's own data, next to the archive and the
 * favourite models. Nothing here touches a project folder.
 *
 * It is written whole — into a file beside it, mode 0600, moved into place — so a crash or a kill never leaves half a list;
 * a file that is not a list at all is kept beside itself as `.damaged` before the next change writes over it, as the lists
 * of strings are. A file that is a list but carries entries that do not fit loses only those (`parseGroups`): the rest is
 * the person's, and is shown.
 *
 * Every page is told of a change (`onChange` → `group_groups` over the socket), as with the archive: the groups are the
 * person's, not one page's.
 */

/** What is wrong with a request to change the groups: the whole change is refused, nothing is written. */
export class ProjectGroupError extends CodedError {
	constructor(
		message: string,
		readonly status: number,
		code: "groupNameInvalid" | "groupProjectInvalid" | "groupUnknown" | "groupFull" = "groupNameInvalid",
		params: Record<string, string | number> = {},
	) {
		super(message, code, params);
	}
}

const nameRefusal = (problem: GroupNameProblem) =>
	new ProjectGroupError(
		problem === "taken" ? "A group already has that name" : `A group cannot be called that: ${problem}`,
		400,
		"groupNameInvalid",
		{ problem },
	);

/** The most projects one group keeps, and the most a list of groups may hold in all: a sidebar, not a library. */
const PROJECTS_PER_GROUP = 500;
const PROJECTS_TOTAL = 5000;

/** A project folder: an absolute path, which is what a conversation's `cwd` is. */
function parseProjectPath(value: unknown): string | null {
	if (typeof value !== "string") return null;
	if (value === "" || value.length > 4096) return null;
	// A cwd is absolute: a page that names something else (a relative path, a URL) is not naming a project.
	if (!value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value)) return null;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: a newline or a NUL is not part of a path.
	if (/[\u0000-\u001f\u007f]/.test(value)) return null;
	return value.replace(/\/+$/, "") || "/";
}

/** What a file holds, and whether anything in it had to be dropped. */
interface Loaded {
	groups: ProjectGroup[];
	damaged: boolean;
}

export class ProjectGroupStore {
	private readonly file: string;
	private known: { stamp: string; loaded: Loaded } | null = null;
	/** Changes are made one after another: two would otherwise both read the file before the other wrote it. */
	private queue: Promise<unknown> = Promise.resolve();

	/** `onChange` runs after every change that was written: every open page is told, and asks again. */
	constructor(
		dataDir: string,
		private readonly onChange: () => void = () => {},
	) {
		this.file = join(dataDir, "project-groups.json");
	}

	/** The groups as a page sees them: the ones that fit, in their order. */
	list(): ProjectGroups {
		const loaded = this.load();
		return { groups: loaded.groups, problem: loaded.damaged ? "damaged" : null };
	}

	/** Make a group, at the end of the list. */
	create(name: string): Promise<ProjectGroupsAnswer> {
		return this.serial(() => {
			const loaded = this.load();
			const problem = groupNameProblem(loaded.groups, name);
			if (problem) throw nameRefusal(problem);
			const parsed = parseGroupName(name);
			if (!parsed.ok) throw nameRefusal(parsed.problem);
			const group: ProjectGroup = {
				id: newGroupId(loaded.groups.map((g) => g.id)),
				name: parsed.name,
				order: loaded.groups.length,
				collapsed: false,
				projects: [],
			};
			const groups = [...loaded.groups, group];
			this.write(loaded, groups);
			return { groups, problem: null, group };
		});
	}

	/** Give a group another name. Its place, its projects and whether it is folded do not change. */
	rename(id: string, name: string): Promise<ProjectGroupsAnswer> {
		return this.serial(() => {
			const loaded = this.load();
			const at = loaded.groups.findIndex((g) => g.id === id);
			if (at < 0) throw new ProjectGroupError("No such group", 404, "groupUnknown");
			const problem = groupNameProblem(loaded.groups, name, id);
			if (problem) throw nameRefusal(problem);
			const parsed = parseGroupName(name);
			if (!parsed.ok) throw nameRefusal(parsed.problem);
			const before = loaded.groups[at] as ProjectGroup;
			const group: ProjectGroup = { ...before, name: parsed.name };
			const groups = loaded.groups.with(at, group);
			if (group.name !== before.name) this.write(loaded, groups);
			return { groups: group.name === before.name ? loaded.groups : groups, problem: null, group };
		});
	}

	/** Fold a group in the sidebar, or open it. */
	setCollapsed(id: string, collapsed: boolean): Promise<ProjectGroupsAnswer> {
		return this.serial(() => {
			const loaded = this.load();
			const at = loaded.groups.findIndex((g) => g.id === id);
			if (at < 0) throw new ProjectGroupError("No such group", 404, "groupUnknown");
			const before = loaded.groups[at] as ProjectGroup;
			if (before.collapsed === collapsed) return { groups: loaded.groups, problem: null, group: before };
			const group: ProjectGroup = { ...before, collapsed };
			const groups = loaded.groups.with(at, group);
			this.write(loaded, groups);
			return { groups, problem: null, group };
		});
	}

	/**
	 * Put a project in a group (`group`: its id, or null for the top level). A project is in one group: naming one it is
	 * already in moves it to `at` (or to the end). Its folder is not looked at: a project the sidebar does not show right
	 * now is still kept where the person put it (`parseGroups` keeps it too).
	 */
	move(cwd: string, group: string | null, at: number | null = null): Promise<ProjectGroupsAnswer> {
		return this.serial(() => {
			const loaded = this.load();
			const path = parseProjectPath(cwd);
			if (!path) throw new ProjectGroupError("A project is named by its folder", 400, "groupProjectInvalid");
			let target: ProjectGroup | null = null;
			if (group !== null) {
				target = loaded.groups.find((g) => g.id === group) ?? null;
				if (!target) throw new ProjectGroupError("No such group", 404, "groupUnknown");
			}
			const holder = loaded.groups.find((g) => g.projects.includes(path)) ?? null;
			const from = holder ? holder.projects.indexOf(path) : -1;
			const place = at === null || !Number.isFinite(at) ? null : Math.max(0, Math.trunc(at));
			const stay = (): ProjectGroupsAnswer => ({ groups: loaded.groups, problem: null, group: holder });

			// Already in this group (or at the top level, which no group names), and not asked to move within it.
			if (holder?.id === target?.id && place === null) return stay();
			if (!holder && !target) return stay();
			// This group gains the project: the room it needs.
			if (target && holder?.id !== target.id && target.projects.length >= PROJECTS_PER_GROUP)
				throw new ProjectGroupError("That group is full", 409, "groupFull");
			// A project no group has joins the ones the groups hold.
			if (!holder && loaded.groups.reduce((n, g) => n + g.projects.length, 0) >= PROJECTS_TOTAL)
				throw new ProjectGroupError("The groups hold as many projects as they can", 409, "groupFull");

			let moved = false;
			const groups = loaded.groups.map((g) => {
				const rest = g.projects.filter((p) => p !== path);
				const dropped = rest.length !== g.projects.length;
				if (g.id !== target?.id) {
					if (!dropped) return g;
					moved = true;
					return { ...g, projects: rest };
				}
				const to = place === null ? rest.length : Math.min(place, rest.length);
				// In the group it is already in, at the place it already has: nothing changes.
				if (dropped && to === from) {
					moved = false;
					return { ...g, projects: rest.toSpliced(to, 0, path) };
				}
				moved = true;
				return { ...g, projects: to >= rest.length ? [...rest, path] : rest.toSpliced(to, 0, path) };
			});
			if (!moved) return stay();
			this.write(loaded, groups);
			return { groups, problem: null, group: groups.find((g) => g.id === target?.id) ?? null };
		});
	}

	/**
	 * Remove a group. Its projects are not touched: they are the top level's again, which is where the sidebar looks for
	 * one no group names. Nothing on disk is changed, and no project folder is read.
	 */
	remove(id: string): Promise<ProjectGroupsAnswer> {
		return this.serial(() => {
			const loaded = this.load();
			const at = loaded.groups.findIndex((g) => g.id === id);
			if (at < 0) throw new ProjectGroupError("No such group", 404, "groupUnknown");
			const groups = loaded.groups.toSpliced(at, 1).map((g, order) => (g.order === order ? g : { ...g, order }));
			this.write(loaded, groups);
			return { groups, problem: null, group: null };
		});
	}

	/** Move a group up or down the list (`delta`: -1 or 1), swapping places with its neighbour. */
	reorder(id: string, delta: number): Promise<ProjectGroupsAnswer> {
		return this.serial(() => {
			const loaded = this.load();
			const at = loaded.groups.findIndex((g) => g.id === id);
			if (at < 0) throw new ProjectGroupError("No such group", 404, "groupUnknown");
			const to = Math.max(0, Math.min(loaded.groups.length - 1, at + (delta < 0 ? -1 : 1)));
			if (to === at) return { groups: loaded.groups, problem: null, group: loaded.groups[at] ?? null };
			const groups = loaded.groups
				.toSpliced(at, 1)
				.toSpliced(to, 0, loaded.groups[at] as ProjectGroup)
				.map((g, order) => ({ ...g, order }));
			this.write(loaded, groups);
			return { groups, problem: null, group: groups[to] ?? null };
		});
	}

	/** One change at a time, in the order they were asked for. */
	private serial<T>(run: () => T): Promise<T> {
		const answer = this.queue.then(run);
		this.queue = answer.catch(() => {});
		return answer;
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
		if (stamp === "none") loaded = { groups: [], damaged: false };
		else {
			try {
				const text = readFileSync(this.file, "utf8");
				let raw: unknown;
				try {
					raw = JSON.parse(text);
				} catch {
					raw = null;
				}
				const groups = parseGroups(raw);
				if (groups === null) {
					console.warn(`omp-webui: ${this.file} is not a list of groups; no group is listed`);
					loaded = { groups: [], damaged: true };
				} else {
					// Everything the file held came through: no entry had to be dropped.
					const held = isRecord(raw) && Array.isArray(raw.groups) ? raw.groups.length : 0;
					loaded = { groups, damaged: held !== groups.length };
					if (loaded.damaged) console.warn(`omp-webui: ${this.file} is not all usable: the groups that fit are listed`);
				}
			} catch (e) {
				console.warn(`omp-webui: ${this.file} cannot be read (${(e as Error).message}): no group is listed`);
				loaded = { groups: [], damaged: true };
			}
		}
		this.known = { stamp, loaded };
		return loaded;
	}

	/** Write the list whole and move it into place; a file that was not a list is kept beside it. */
	private write(before: Loaded, groups: ProjectGroup[]): void {
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
			writeFileSync(temporary, serializeGroups(groups), { mode: 0o600 });
			// The mode asked for is cut by the umask; the list is private whatever it is.
			chmodSync(temporary, 0o600);
			renameSync(temporary, this.file);
		} catch (e) {
			rmSync(temporary, { force: true });
			throw e;
		}
		this.known = { stamp: this.stamp(), loaded: { groups, damaged: false } };
		this.onChange();
	}
}
