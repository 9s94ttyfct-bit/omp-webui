import { isRecord } from "../../shared/guards.ts";
import type { InstalledSkill, SkillHit, SkillSearch } from "../../shared/plugins.ts";

/**
 * The Skills section of the Plugins page: what `omp skill …` prints (omp 18.16), and the arguments it is given. omp's
 * registry, skills.omp.sh, is its own channel for skills (`omp skill search|install|uninstall`); `omp skill list --json`
 * lists every skill omp discovers, wherever it found it (plugins, `~/.omp/agent/skills`, `~/.claude/skills`, the registry…).
 */

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** A registry skill's id, as omp checks it (`@scope/name`). */
const SKILL_ID = /^@[a-z0-9][a-z0-9_]{2,31}\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const validSkillId = (v: unknown): v is string => typeof v === "string" && SKILL_ID.test(v);

/** What `omp skill install` is given: `@scope/name`, optionally `@<version, range or tag>` (one word). */
export function validSkillSpec(v: unknown): v is string {
	if (typeof v !== "string") return false;
	const at = v.indexOf("@", 1);
	return at < 0 ? SKILL_ID.test(v) : SKILL_ID.test(v.slice(0, at)) && /^[\w.^~<>=*|+-]{1,100}$/.test(v.slice(at + 1));
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: this is the check for them
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A search: one line of text, never a flag. */
export function validSkillQuery(v: unknown): v is string {
	return typeof v === "string" && v.trim() !== "" && v.length <= 200 && !v.startsWith("-") && !CONTROL.test(v);
}

/**
 * Where omp keeps a registry skill: its store, `…/skillshare/@scope/name/<version>/SKILL.md`. Its id and version are read
 * from there (`omp skill list --json` gives a skill's name, not its registry id).
 */
const STORE_PATH = /[\\/](@[a-z0-9][a-z0-9_]{2,31})[\\/]([a-z0-9]+(?:-[a-z0-9]+)*)[\\/]([^\\/]+)[\\/]SKILL\.md$/;

/** `omp skill list --json`: `{ skills: [{ name, description, filePath, baseDir, source: "<provider>:<level>", hide }] }`. */
export function parseSkillList(doc: unknown): InstalledSkill[] {
	if (!isRecord(doc) || !Array.isArray(doc.skills))
		throw new Error("omp skill list answered in a form this does not know");
	return doc.skills.flatMap((s): InstalledSkill[] => {
		if (!isRecord(s) || typeof s.name !== "string") return [];
		const source = str(s.source) ?? "";
		const colon = source.lastIndexOf(":");
		const provider = colon > 0 ? source.slice(0, colon) : source;
		const level = colon > 0 ? source.slice(colon + 1) : "";
		const path = str(s.filePath);
		const stored = provider === "skillshare" && path ? STORE_PATH.exec(path) : null;
		return [
			{
				name: s.name,
				description: str(s.description),
				provider,
				level,
				path,
				hidden: s.hide === true,
				registry: stored ? { id: `${stored[1]}/${stored[2]}`, version: stored[3] } : null,
			},
		];
	});
}

/** `omp skill search <query> --json`: `{ total, page, perPage, hits: [{ scope, name, version, description, … }] }`. */
export function parseSkillSearch(doc: unknown): SkillSearch {
	if (!isRecord(doc) || !Array.isArray(doc.hits))
		throw new Error("omp skill search answered in a form this does not know");
	const hits = doc.hits.flatMap((h): SkillHit[] => {
		if (!isRecord(h) || typeof h.scope !== "string" || typeof h.name !== "string") return [];
		const id = `@${h.scope}/${h.name}`;
		if (!validSkillId(id)) return [];
		return [
			{
				id,
				version: str(h.version),
				description: str(h.description),
				weeklyDownloads: typeof h.weeklyDownloads === "number" ? h.weeklyDownloads : null,
				publisher: isRecord(h.publisher) ? str(h.publisher.username) : null,
				keywords: Array.isArray(h.keywords) ? h.keywords.filter((k): k is string => typeof k === "string") : [],
				deprecated: str(h.deprecated),
			},
		];
	});
	return { total: typeof doc.total === "number" ? doc.total : hits.length, hits };
}

/**
 * Whether omp refused an install because the skill ships scripts and nobody could confirm (it asks only on a terminal):
 * the page then lists what omp printed and, if the person agrees, installs it again with `--yes`.
 */
export function asksToConfirmScripts(error: string): boolean {
	return /ships scripts:/.test(error) && /--yes/.test(error);
}
