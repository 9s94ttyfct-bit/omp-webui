import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import type { InstalledSkill, SkillSwitchScope, SkillsData } from "../../shared/plugins.ts";
import { runJson } from "./loaded.ts";
import { type ListedSkill, parseSkillList } from "./plugin-skills.ts";
import { globalDisabled, serialized, setGlobalDisabled, switched } from "./toggles.ts";

/**
 * The Skills section's switches. A skill is off where `skill:<name>` is in omp's `disabledExtensions`: the global
 * list (`~/.omp/agent/config.yml`, written with `omp config set`, as the terminal's Extension Control Center does), or
 * a project folder's own list in `<folder>/.omp/config.yml`, which replaces the global one in that folder. omp's CLI
 * writes only the global layer, so a project's list is edited here, in place, keeping the rest of the file as it is.
 *
 * `omp skill list` leaves out what the list in force turns off. To show those too, omp is also asked in a folder of
 * this app's own whose `.omp/config.yml` sets an empty list: there every skill but the folder's own project skills is
 * listed.
 */

export interface SkillSwitchDeps {
	bin: string;
	home: string;
	/** A folder with no `.omp` of its own (this app's data folder): the global value of a setting is read there. */
	neutral: string;
}

const SKILL = "skill:";
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const skillNames = (list: string[]): string[] =>
	list.filter((id) => id.startsWith(SKILL)).map((id) => id.slice(SKILL.length));

/** The folder where omp lists every skill: its project layer turns none off. Made on first use. */
function probeFolder(neutral: string): string {
	const dir = join(neutral, "skill-probe");
	const file = join(dir, ".omp", "config.yml");
	let current = "";
	try {
		current = readFileSync(file, "utf8");
	} catch {}
	const want = "# omp-webui: lists every skill, the ones the global list turns off too\ndisabledExtensions: []\n";
	if (current !== want) {
		mkdirSync(join(dir, ".omp"), { recursive: true });
		writeFileSync(file, want);
	}
	return dir;
}

/** The project folder's own list (its `.omp` layer, as omp reads it), or null where it has none. */
async function projectList(d: SkillSwitchDeps, cwd: string): Promise<string[] | null> {
	if (resolve(cwd) === resolve(d.home)) return null;
	const doc = await runJson(d.bin, ["config", "list", "--scope", "project", "--json"], cwd, {});
	const entry = isRecord(doc) ? doc.disabledExtensions : undefined;
	return isRecord(entry) && Array.isArray(entry.value) ? ids(entry.value) : null;
}

/**
 * Every skill: those omp lists in the folder (`here`, what is on there, project skills included), then those it lists
 * where no list turns any off (`all`), then those a list turns off that omp no longer finds, known by name only.
 */
export function mergeSkills(
	here: ListedSkill[],
	all: ListedSkill[],
	globalOff: string[],
	projectOff: string[] | null,
): InstalledSkill[] {
	const g = new Set(skillNames(globalOff));
	const p = projectOff ? new Set(skillNames(projectOff)) : null;
	const seen = new Set<string>();
	const out: InstalledSkill[] = [];
	const add = (s: ListedSkill, nameOnly = false) => {
		if (seen.has(s.name)) return;
		seen.add(s.name);
		out.push({ ...s, offGlobally: g.has(s.name), offInProject: p ? p.has(s.name) : null, nameOnly });
	};
	for (const s of here) add(s);
	for (const s of all) add(s);
	const unknown = [...new Set([...g, ...(p ?? [])])].filter((n) => !seen.has(n)).sort((a, b) => a.localeCompare(b));
	for (const name of unknown)
		add({ name, description: null, provider: "", level: "", path: null, hidden: false, registry: null }, true);
	return out;
}

export async function readSkills(d: SkillSwitchDeps, cwd: string): Promise<SkillsData> {
	const [here, all, global, project] = await Promise.all([
		runJson(d.bin, ["skill", "list", "--json"], cwd, {}).then(parseSkillList),
		runJson(d.bin, ["skill", "list", "--json"], probeFolder(d.neutral), {}).then(parseSkillList),
		globalDisabled(d.bin, d.neutral, {}),
		projectList(d, cwd),
	]);
	return {
		installed: mergeSkills(here, all, global, project),
		project: resolve(cwd) !== resolve(d.home),
		projectList: project !== null,
	};
}

/** Why a project's config file is not changed: it is not what this can edit safely. */
export class ProjectConfigError extends Error {}

/**
 * `text` (a `config.yml`) with its top-level `disabledExtensions` replaced by `list`, or taken out (`null`), every other
 * line as it was. Checked by parsing both: anything else changing, or the key not reading back as `list`, throws.
 */
export function withDisabledList(text: string, list: string[] | null): string {
	const before = text.trim() === "" ? {} : Bun.YAML.parse(text);
	if (!isRecord(before)) throw new ProjectConfigError("its top level is not a mapping");
	const lines = text.split("\n");
	const start = lines.findIndex((l) => /^disabledExtensions\s*:/.test(l));
	const block =
		list === null
			? []
			: list.length === 0
				? ["disabledExtensions: []"]
				: ["disabledExtensions:", ...list.map((id) => `  - ${JSON.stringify(id)}`)];
	let next: string[];
	if (start >= 0) {
		let end = start + 1;
		// The key's value: its indented lines and list items, up to the next key, blank line or top-level comment.
		while (end < lines.length && /^(\s+\S|-)/.test(lines[end])) end++;
		next = [...lines.slice(0, start), ...block, ...lines.slice(end)];
	} else {
		if (list === null) return text;
		const body = text === "" || text.endsWith("\n") ? lines.slice(0, -1) : lines;
		next = [...(text === "" ? [] : body), ...block, ""];
	}
	const out = next.join("\n");
	const after = out.trim() === "" ? {} : Bun.YAML.parse(out);
	// Every other key as it was (JSON leaves an undefined key out), and the list reading back as written.
	const others = (doc: Record<string, unknown>) => JSON.stringify({ ...doc, disabledExtensions: undefined });
	if (
		!isRecord(after) ||
		others(before) !== others(after) ||
		JSON.stringify(after.disabledExtensions ?? null) !== JSON.stringify(list)
	)
		throw new ProjectConfigError("its disabledExtensions is not written in a form this can change");
	return out;
}

/** Write the project folder's own list (`null`: take it out, so the global list applies there again). */
async function writeProjectList(d: SkillSwitchDeps, cwd: string, list: string[] | null): Promise<void> {
	const dir = join(cwd, ".omp");
	const file = join(dir, "config.yml");
	let text = "";
	try {
		text = readFileSync(file, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		if (list === null) return;
	}
	let out: string;
	try {
		out = withDisabledList(text, list);
	} catch (e) {
		throw new ProjectConfigError(`${file} was not changed: ${e instanceof Error ? e.message : String(e)}`);
	}
	if (out === text) return;
	mkdirSync(dir, { recursive: true });
	const tmp = `${file}.omp-webui-${process.pid}.tmp`;
	writeFileSync(tmp, out);
	renameSync(tmp, file);
	// omp may read the project layer from somewhere else as well: what it reads now must be what was written.
	const read = await projectList(d, cwd);
	if (JSON.stringify(read) !== JSON.stringify(list))
		throw new ProjectConfigError(`${file} was written, but omp reads another list there (another config file sets it)`);
}

/**
 * Turn skills on or off in every folder without a list of its own (`global`), or in one project folder (`project`).
 * A project with no list of its own starts from a copy of the global list, which it then replaces: what is off
 * everywhere stays off there.
 */
export async function switchSkills(
	d: SkillSwitchDeps,
	cwd: string,
	names: string[],
	enabled: boolean,
	scope: SkillSwitchScope,
): Promise<void> {
	if (scope === "project" && resolve(cwd) === resolve(d.home))
		throw new ProjectConfigError("The home folder has no project list");
	await serialized(async () => {
		if (scope === "global") {
			const current = await globalDisabled(d.bin, d.neutral, {});
			const next = switched(current, names, enabled);
			if (JSON.stringify(next) === JSON.stringify(current)) return;
			await setGlobalDisabled(d.bin, d.neutral, {}, next);
			return;
		}
		const current = (await projectList(d, cwd)) ?? (await globalDisabled(d.bin, d.neutral, {}));
		await writeProjectList(d, cwd, switched(current, names, enabled));
	});
}

/** Take the project folder's own list out: the global list applies there again. */
export function followGlobalList(d: SkillSwitchDeps, cwd: string): Promise<void> {
	return serialized(() => writeProjectList(d, cwd, null));
}

/** At most this much of a `SKILL.md` is shown. */
const SKILL_FILE_MAX = 256 * 1024;

/**
 * A skill's `SKILL.md`, read for the page: only the file omp names for a skill it lists (never a path the page sends),
 * cut at 256 KiB.
 */
export async function readSkillFile(
	d: SkillSwitchDeps,
	cwd: string,
	name: string,
): Promise<{ path: string; text: string; cut: boolean } | null> {
	const skill = (await readSkills(d, cwd)).installed.find((s) => s.name === name && s.path);
	if (!skill?.path) return null;
	const file = Bun.file(skill.path);
	const size = file.size;
	const text = await file.slice(0, SKILL_FILE_MAX).text();
	return { path: skill.path, text, cut: size > SKILL_FILE_MAX };
}
