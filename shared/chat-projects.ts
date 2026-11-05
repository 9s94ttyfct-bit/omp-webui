import { foldName } from "./fold-name.ts";
import { isRecord } from "./guards.ts";

/**
 * The sidebar's projects: named groups of conversations, as a chat app has them. A project has a name, an order, whether it
 * is folded, an optional folder (what its folder button shows in the Files panel, and where its new chats start) and the
 * conversations the person put in it. It is this app's own data — `<data dir>/chat-projects.json` — and nothing about it is
 * written near a conversation: putting one in a project does not move it to another folder.
 *
 * A conversation is named by its session id (`SessionSummary.id`, the id in its file's header), not by its file, so that
 * omp's `/move` or a renamed file keeps it where it is. A conversation is in at most one project.
 *
 * Membership (`projectsOf`): a conversation the person put in a project (or took out of one: `excluded`) is where they put
 * it. Any other conversation is where the conversation it was branched, forked or continued from is (`parentSession`, up
 * the chain), so a branch of a conversation in a project is in that project too, until it is moved or taken out itself.
 *
 * The file is read leniently and written whole, as the archive is: what fits is kept, so one bad entry an older or a
 * hand-edited file carries cannot take the rest of the person's projects with it. Ids of conversations that are gone are
 * kept (the file may come back, as an archived conversation's does) and ignored by the page.
 */

/** The most characters a project's name has (a name is a label: 60 is what a narrow sidebar shows). */
export const PROJECT_NAME_MAX = 60;

/** The most projects one file keeps: a list longer than this is not a sidebar's. */
export const PROJECT_LIMIT = 200;

/** The most conversations the projects hold in all, and the most conversations taken out of one that are remembered. */
export const PROJECT_SESSIONS_MAX = 20_000;

/** One project, as the server keeps it and the page shows it. */
export interface ChatProject {
	/** Stable across renames. */
	id: string;
	name: string;
	/** The folder its button shows in the Files panel and its new chats start in; null: none was set. */
	folder: string | null;
	/** Where it is in the list (lowest first). */
	order: number;
	/** Folded in the sidebar: its conversations are not shown. */
	collapsed: boolean;
	/** The session ids of the conversations the person put in it, in the order they were put there. */
	sessions: string[];
}

/** What `GET /api/chat-projects` answers and every change returns: the whole list, as the next read of it would be. */
export interface ChatProjects {
	projects: ChatProject[];
	/** Session ids taken out of a project on purpose: not in one, whatever the conversation they came from is in. */
	excluded: string[];
	/** Why the file could not be read at all, when it could not (null: it was read, or there was none). */
	problem: string | null;
}

/** What a change answers: the whole list, and the project it made or changed (`null` for a delete or a move out). */
export interface ChatProjectsAnswer extends ChatProjects {
	project: ChatProject | null;
}

/** What is wrong with a project name. */
export type ProjectNameProblem =
	/** Nothing typed (or only spaces). */
	| "empty"
	/** More than `PROJECT_NAME_MAX` characters. */
	| "tooLong"
	/** A control character, or a direction mark that would reorder the rest of the name. */
	| "invalid"
	/** A project is already called that (case, accents and width do not tell two names apart). */
	| "taken";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Characters no name may carry: a control character, and the bidi overrides that make a name read as another. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
const FORBIDDEN = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;

/** The name as it would be kept (trimmed), or why it is not one. Whether another project has it is `projectNameProblem`'s. */
export function parseProjectName(
	input: string,
): { ok: true; name: string } | { ok: false; problem: Exclude<ProjectNameProblem, "taken"> } {
	const name = input.trim();
	if (name === "") return { ok: false, problem: "empty" };
	let count = 0;
	for (const _ of graphemes.segment(name)) if (++count > PROJECT_NAME_MAX) return { ok: false, problem: "tooLong" };
	if (FORBIDDEN.test(name)) return { ok: false, problem: "invalid" };
	return { ok: true, name };
}

/**
 * Why `name` cannot be the name of a project in `projects` (`except`: the project being renamed, which may keep its own
 * name). The server asks this before it writes and the page before it asks the server, so the answer is the same on both.
 */
export function projectNameProblem(
	projects: readonly ChatProject[],
	name: string,
	except: string | null = null,
): ProjectNameProblem | null {
	const parsed = parseProjectName(name);
	if (!parsed.ok) return parsed.problem;
	const folded = foldName(parsed.name);
	return projects.some((p) => p.id !== except && foldName(p.name) === folded) ? "taken" : null;
}

/**
 * A folder as a project keeps it: an absolute path without a trailing slash, or null when `value` is not one. A root keeps
 * its separator (`/`, `C:\`, `C:/`): `C:` alone is the current folder of drive C, not its root.
 */
export function parseProjectFolder(value: unknown): string | null {
	if (typeof value !== "string" || value === "" || value.length > 4096) return null;
	if (!value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value)) return null;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: a newline or a NUL is not part of a path.
	if (/[\u0000-\u001f\u007f]/.test(value)) return null;
	const drive = /^[A-Za-z]:([\\/])[\\/]*$/.exec(value);
	if (drive) return `${value.slice(0, 2)}${drive[1]}`;
	return value.replace(/[\\/]+$/, "") || "/";
}

/** A session id as the file keeps it: what a header's `id` is (not empty, short, no control character), or null. */
export function parseSessionId(value: unknown): string | null {
	if (typeof value !== "string" || value === "" || value.length > 200) return null;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: an id is one printable word.
	if (/[\u0000-\u001f\u007f\s]/.test(value)) return null;
	return value;
}

/** The id a new project gets: it names nothing on disk, so it only has to be unique and stay put across renames. */
export function newProjectId(taken: readonly string[]): string {
	const used = new Set(taken);
	for (;;) {
		const id = crypto.randomUUID();
		if (!used.has(id)) return id;
	}
}

/**
 * The list from what the file holds, keeping what fits. `null` is no answer at all (the file is not JSON, or is not an
 * object with a list of projects): the caller says so, and keeps the file rather than writing over a person's projects.
 *
 * - A project without an id or a usable name is dropped, and so is one with a name another has (the first keeps it).
 * - A conversation is in one project: the first project naming it keeps it (`order` decides which is first); an id the
 *   projects hold is not `excluded`.
 * - `order` that is not a finite number is the project's place in the file; `collapsed` that is not `true` is not folded; a
 *   folder that is not an absolute path is none.
 */
export function parseChatProjects(value: unknown): { projects: ChatProject[]; excluded: string[] } | null {
	if (!isRecord(value) || !Array.isArray(value.projects)) return null;
	const out: ChatProject[] = [];
	const ids = new Set<string>();
	const names = new Set<string>();
	for (const [at, entry] of value.projects.entries()) {
		if (out.length >= PROJECT_LIMIT) break;
		if (!isRecord(entry)) continue;
		const id = typeof entry.id === "string" && entry.id !== "" ? entry.id : null;
		if (!id || ids.has(id)) continue;
		const parsed = typeof entry.name === "string" ? parseProjectName(entry.name) : null;
		if (!parsed?.ok) continue;
		const folded = foldName(parsed.name);
		if (names.has(folded)) continue;
		ids.add(id);
		names.add(folded);
		const sessions = Array.isArray(entry.sessions)
			? entry.sessions.map(parseSessionId).filter((s): s is string => s !== null)
			: [];
		const order = typeof entry.order === "number" && Number.isFinite(entry.order) ? entry.order : at;
		out.push({
			id,
			name: parsed.name,
			folder: parseProjectFolder(entry.folder),
			order,
			collapsed: entry.collapsed === true,
			sessions,
		});
	}
	const claimed = new Set<string>();
	let room = PROJECT_SESSIONS_MAX;
	const projects = out
		.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
		.map((p) => {
			const sessions = p.sessions.filter((s) => {
				if (claimed.has(s) || room <= 0) return false;
				claimed.add(s);
				room--;
				return true;
			});
			return sessions.length === p.sessions.length ? p : { ...p, sessions };
		});
	const excluded = Array.isArray(value.excluded)
		? [...new Set(value.excluded.map(parseSessionId).filter((s): s is string => s !== null && !claimed.has(s)))].slice(
				-PROJECT_SESSIONS_MAX,
			)
		: [];
	return { projects, excluded };
}

/** The file's text: what `parseChatProjects` reads back as the same list. */
export function serializeChatProjects(projects: readonly ChatProject[], excluded: readonly string[]): string {
	const ordered = projects
		.toSorted((a, b) => a.order - b.order)
		.map((p, order) => ({
			id: p.id,
			name: p.name,
			folder: p.folder,
			order,
			collapsed: p.collapsed,
			sessions: [...p.sessions],
		}));
	return `${JSON.stringify({ version: 1, projects: ordered, excluded: [...excluded] }, null, "\t")}\n`;
}

/** What membership needs to know of a conversation: its file (the key the page shows it by), its id and its parent. */
export interface ProjectMember {
	file: string;
	id: string;
	/** The conversation it came from (a branch, a fork, a "Continue from here" copy): its file path or its id. */
	parentSession: string | null;
}

/** Where a conversation is: its project, and whether it is there because the conversation it came from is (`inherited`). */
export interface Membership {
	project: string;
	inherited: boolean;
}

/** The id at the end of an omp session file's name (`<time>_<id>.jsonl`), for a parent named by a file that has moved. */
const ID_IN_FILE = /_([0-9A-Za-z-]{8,})\.jsonl$/;

/** How far up a chain of parents is looked: a chain longer than this is a loop a hand edit made, not a family. */
const CHAIN_MAX = 64;

/**
 * Each conversation's project, by file (a conversation in none is not in the map). One the person put somewhere (a project,
 * or out of every project: `excluded`) is there; any other is where its parent is, up the `parentSession` chain. A parent
 * is found by its file, else by its id (a header may name either), else by the id in its file's name.
 */
export function projectsOf(
	sessions: readonly ProjectMember[],
	projects: readonly ChatProject[],
	excluded: readonly string[],
): Map<string, Membership> {
	const placed = new Map<string, string | null>();
	for (const project of projects) for (const id of project.sessions) if (!placed.has(id)) placed.set(id, project.id);
	for (const id of excluded) if (!placed.has(id)) placed.set(id, null);
	const byFile = new Map<string, ProjectMember>();
	const byId = new Map<string, ProjectMember>();
	for (const s of sessions) {
		byFile.set(s.file, s);
		if (!byId.has(s.id)) byId.set(s.id, s);
	}
	const parentOf = (s: ProjectMember): ProjectMember | null => {
		const p = s.parentSession;
		if (!p) return null;
		return byFile.get(p) ?? byId.get(p) ?? byId.get(ID_IN_FILE.exec(p)?.[1] ?? "") ?? null;
	};
	const known = new Map<string, string | null>();
	const resolve = (s: ProjectMember): string | null => {
		const chain: ProjectMember[] = [];
		let at: ProjectMember | null = s;
		let found: string | null = null;
		while (at && chain.length < CHAIN_MAX) {
			const kept = known.get(at.file);
			if (kept !== undefined) {
				found = kept;
				break;
			}
			const own = placed.get(at.id);
			if (own !== undefined) {
				found = own;
				chain.push(at);
				break;
			}
			chain.push(at);
			const next = parentOf(at);
			// A conversation named as its own ancestor: the chain ends where it loops.
			at = next && !chain.includes(next) ? next : null;
		}
		for (const c of chain) known.set(c.file, found);
		return found;
	};
	const out = new Map<string, Membership>();
	for (const s of sessions) {
		const project = resolve(s);
		if (project !== null) out.set(s.file, { project, inherited: placed.get(s.id) === undefined });
	}
	return out;
}

/**
 * The Files panel of a project (its folder button) names the project where a conversation's names its session file: the
 * server finds the folder in its own list of projects (`chatProjectOfScope`), so a page never names a folder to be listed.
 */
const PROJECT_SCOPE = "chat-project:";

export const chatProjectScope = (id: string): string => `${PROJECT_SCOPE}${id}`;

/** The project a Files-panel scope names, or null when it names a conversation. */
export function chatProjectOfScope(file: string | null): string | null {
	return file?.startsWith(PROJECT_SCOPE) ? file.slice(PROJECT_SCOPE.length) || null : null;
}

/**
 * The projects the sidebar's project groups (#636, `<data dir>/project-groups.json`) become, the first time the list of
 * projects is read: one project per group with the group's name; in it, the conversations whose folder is one of the
 * group's folders; its folder, the group's folder when it had exactly one. Null: the file is not a list of groups.
 */
export function projectsFromGroups(
	value: unknown,
	sessions: readonly { id: string; cwd: string }[],
): ChatProject[] | null {
	if (!isRecord(value) || !Array.isArray(value.groups)) return null;
	const out: ChatProject[] = [];
	const names = new Set<string>();
	const ids = new Set<string>();
	const claimedFolders = new Set<string>();
	const groups = value.groups
		.filter(isRecord)
		.map((g, at) => ({ g, order: typeof g.order === "number" && Number.isFinite(g.order) ? g.order : at }))
		.sort((a, b) => a.order - b.order);
	for (const { g } of groups) {
		if (out.length >= PROJECT_LIMIT) break;
		const parsed = typeof g.name === "string" ? parseProjectName(g.name) : null;
		if (!parsed?.ok) continue;
		const folded = foldName(parsed.name);
		if (names.has(folded)) continue;
		names.add(folded);
		const id = typeof g.id === "string" && g.id !== "" && !ids.has(g.id) ? g.id : newProjectId([...ids]);
		ids.add(id);
		// A folder is in one group: the first that names it, as the groups were shown.
		const folders = (Array.isArray(g.projects) ? g.projects : [])
			.map(parseProjectFolder)
			.filter((f): f is string => f !== null && !claimedFolders.has(f));
		for (const f of folders) claimedFolders.add(f);
		const unique = [...new Set(folders)];
		const inGroup = new Set(unique);
		const members = sessions.filter((s) => inGroup.has(parseProjectFolder(s.cwd) ?? s.cwd)).map((s) => s.id);
		out.push({
			id,
			name: parsed.name,
			folder: unique.length === 1 ? (unique[0] as string) : null,
			order: out.length,
			collapsed: g.collapsed === true,
			sessions: [...new Set(members)],
		});
	}
	return out;
}
