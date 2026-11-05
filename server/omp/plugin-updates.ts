import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import type { PluginScope, PluginUpdate, UncheckedUpdate } from "../../shared/plugins.ts";
import { parseSkillList } from "./plugin-skills.ts";
import { npmPackageLatest } from "./update.ts";

/**
 * What the Plugins page's Updates section and the automatic update find newer, with omp's own CLI where it can tell:
 *
 * - **Marketplaces**: their catalogs are fetched again first (`omp plugin marketplace update`), which only rewrites the
 *   catalogs omp caches; what follows reads the new ones.
 * - **Marketplace plugins**: `omp plugin upgrade --dry-run`, in the home folder for the user's and in each project folder
 *   for that project's.
 * - **npm plugins** (the user's only; omp installs none per project): `latest` for a package installed by name or version
 *   range, from the registry npm and omp would install it from (`registryFor`), with its credentials. One installed from
 *   git, a URL or a folder has no version to compare, and one the registry cannot tell of fails: both are listed as not
 *   checked, and its own Upgrade reinstalls it.
 * - **Registry skills** (`omp skill install`): skills.omp.sh's `latest` (`omp skill info --json`) against the version in
 *   omp's store, for the user's (`-g`) and each project's. omp has no dry run for them.
 *
 * Each source is read on its own: one that fails is an error line, the rest still count.
 */

/** Runs omp's CLI (`args`, in `cwd`) and gives what it printed; throws with omp's words when it failed. */
export type RunOmp = (args: string[], cwd: string) => Promise<string>;

/** The npm registry's `latest` version of a package; throws when it cannot be told. */
export type NpmLatest = (name: string) => Promise<string>;

export const updateKey = (u: Pick<PluginUpdate, "kind" | "scope" | "folder" | "id">): string =>
	`${u.kind}\u0000${u.scope}\u0000${u.folder ?? ""}\u0000${u.id}`;

/** Whether `candidate` is a newer version than `installed` (semver; text that is not one never counts as newer). */
export function newer(candidate: string, installed: string | null): boolean {
	if (installed === null) return true;
	try {
		return Bun.semver.order(candidate, installed) > 0;
	} catch {
		return false;
	}
}

export interface UpgradeAvailable {
	id: string;
	scope: PluginScope;
	from: string | null;
	to: string;
}

/**
 * `omp plugin upgrade --dry-run`, a line per marketplace plugin with a newer version: `[dry-run] Would upgrade <id>
 * (<scope>): <from> -> <to>` (omp 18.16), or the same without the prefix, indented (`  <id> (<scope>): <from> -> <to>`,
 * omp 18.12).
 */
export function parseUpgradePreview(text: string): UpgradeAvailable[] {
	const out: UpgradeAvailable[] = [];
	for (const line of Bun.stripANSI(text).split("\n")) {
		const m = /^(?:\[dry-run\] Would upgrade )?(\S+@\S+) \((user|project)\): (.+?) -> (.+)$/.exec(line.trim());
		if (!m || (m[2] !== "user" && m[2] !== "project")) continue;
		out.push({ id: m[1], scope: m[2], from: m[3] === "undefined" || m[3] === "?" ? null : m[3], to: m[4] });
	}
	return out;
}

/** `omp skill info @scope/name --json`: the package, whose `distTags.latest` is the version `update` goes to. */
export function latestOfSkill(doc: unknown): string | null {
	if (!isRecord(doc) || !isRecord(doc.distTags)) return null;
	const latest = doc.distTags.latest;
	return typeof latest === "string" && latest !== "" ? latest : null;
}

/**
 * How an npm plugin was asked for, from the plugins folder's `package.json` (`dependencies`): a name or a version range is
 * checked against the registry; a git, URL, folder or alias spec is not.
 */
export function npmSpecKind(spec: string | null): "registry" | "git" {
	if (spec === null || spec === "" || spec === "latest" || spec === "*") return "registry";
	return /^[\^~<>=\d.x* |-]+$/.test(spec) || /^[a-z][\w.-]*$/i.test(spec) ? "registry" : "git";
}

/** The spec each npm plugin was installed with: the `package.json` next to the `node_modules` it is in. */
function npmSpecs(paths: (string | null)[]): Map<string, string> {
	const out = new Map<string, string>();
	const read = new Set<string>();
	for (const path of paths) {
		const at = path?.lastIndexOf("node_modules") ?? -1;
		if (!path || at < 0) continue;
		const manifest = join(dirname(path.slice(0, at + "node_modules".length)), "package.json");
		if (read.has(manifest) || !existsSync(manifest)) continue;
		read.add(manifest);
		try {
			const doc: unknown = JSON.parse(readFileSync(manifest, "utf8"));
			const deps = isRecord(doc) && isRecord(doc.dependencies) ? doc.dependencies : {};
			for (const [name, spec] of Object.entries(deps)) if (typeof spec === "string") out.set(name, spec);
		} catch {}
	}
	return out;
}

const lineOf = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 300);

export interface CheckResult {
	updates: PluginUpdate[];
	unchecked: UncheckedUpdate[];
	errors: string[];
}

export interface CheckDeps {
	run: RunOmp;
	npmLatest: NpmLatest;
	home: string;
	/** Project folders whose own plugins and skills are checked too. */
	folders: string[];
}

/** One check, after the marketplaces were refreshed (the caller does that, in turn with every other change). */
export async function checkUpdates(d: CheckDeps): Promise<CheckResult> {
	const updates: PluginUpdate[] = [];
	const unchecked: UncheckedUpdate[] = [];
	const errors: string[] = [];
	const home = resolve(d.home);
	const places: { cwd: string; folder: string | null; scope: PluginScope }[] = [
		{ cwd: home, folder: null, scope: "user" },
		...d.folders.filter((f) => resolve(f) !== home).map((f) => ({ cwd: f, folder: f, scope: "project" as const })),
	];
	const add = (u: Omit<PluginUpdate, "key">) => {
		const key = updateKey(u);
		if (!updates.some((x) => x.key === key)) updates.push({ ...u, key });
	};
	const where = (folder: string | null) => (folder ? ` (${folder})` : "");

	await Promise.all(
		places.map(async (p) => {
			// Marketplace plugins: each folder lists the user's too; only its own scope is taken from it.
			try {
				for (const u of parseUpgradePreview(await d.run(["plugin", "upgrade", "--dry-run"], p.cwd)))
					if (u.scope === p.scope)
						add({
							kind: "plugin",
							id: u.id,
							source: "marketplace",
							scope: p.scope,
							folder: p.folder,
							from: u.from,
							to: u.to,
						});
			} catch (e) {
				errors.push(`plugins${where(p.folder)}: ${lineOf(e)}`);
			}
			// Registry skills.
			try {
				const listed = parseSkillList(JSON.parse(await d.run(["skill", "list", "--json"], p.cwd)));
				const mine = listed.filter((s) => s.registry && (s.level === p.scope || (!s.level && p.scope === "user")));
				await Promise.all(
					mine.map(async (s) => {
						const reg = s.registry;
						if (!reg) return;
						try {
							const latest = latestOfSkill(JSON.parse(await d.run(["skill", "info", reg.id, "--json"], p.cwd)));
							if (latest && newer(latest, reg.version))
								add({
									kind: "skill",
									id: reg.id,
									source: "registry",
									scope: p.scope,
									folder: p.folder,
									from: reg.version,
									to: latest,
								});
						} catch (e) {
							unchecked.push({
								kind: "skill",
								id: reg.id,
								scope: p.scope,
								folder: p.folder,
								reason: "error",
								detail: lineOf(e),
							});
						}
					}),
				);
			} catch (e) {
				errors.push(`skills${where(p.folder)}: ${lineOf(e)}`);
			}
		}),
	);

	// npm plugins: the user's only.
	try {
		const doc: unknown = JSON.parse(await d.run(["plugin", "list", "--json"], home));
		const npm = (isRecord(doc) && Array.isArray(doc.npm) ? doc.npm : []).filter(
			(p): p is Record<string, unknown> => isRecord(p) && typeof p.name === "string",
		);
		const specs = npmSpecs(npm.map((p) => (typeof p.path === "string" ? p.path : null)));
		await Promise.all(
			npm.map(async (p) => {
				const name = p.name as string;
				const path = typeof p.path === "string" ? p.path : null;
				// A linked folder is the person's own copy: there is nothing to fetch.
				if (path && isLinked(path)) return;
				const version = typeof p.version === "string" ? p.version : null;
				if (npmSpecKind(specs.get(name) ?? null) === "git") {
					unchecked.push({
						kind: "plugin",
						id: name,
						scope: "user",
						folder: null,
						reason: "git",
						detail: specs.get(name) ?? null,
					});
					return;
				}
				try {
					const latest = await d.npmLatest(name);
					if (newer(latest, version))
						add({ kind: "plugin", id: name, source: "npm", scope: "user", folder: null, from: version, to: latest });
				} catch (e) {
					unchecked.push({ kind: "plugin", id: name, scope: "user", folder: null, reason: "error", detail: lineOf(e) });
				}
			}),
		);
	} catch (e) {
		errors.push(`npm plugins: ${lineOf(e)}`);
	}

	// Plugins before skills; the user's before each project's; then by name.
	const order = (a: Ordered, b: Ordered) =>
		a.kind.localeCompare(b.kind) ||
		Number(a.folder !== null) - Number(b.folder !== null) ||
		(a.folder ?? "").localeCompare(b.folder ?? "") ||
		a.id.localeCompare(b.id);
	updates.sort(order);
	unchecked.sort(order);
	return { updates, unchecked, errors: errors.sort() };
}

type Ordered = { kind: string; folder: string | null; id: string };

/** A folder linked in (`omp plugin link`): the person's own copy, with nothing to fetch. */
function isLinked(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * An npm package's `latest`, within 15 s, from the registry npm and omp would install it from (a scope's own registry in
 * `.npmrc` or `bunfig.toml`, `npm_config_registry`…), with its credentials. One the registry does not have throws, so it
 * is listed as not checked, never as up to date.
 */
export function registryLatest(env: Record<string, string | undefined> = process.env, home = homedir()): NpmLatest {
	return (name) => npmPackageLatest(name, env, home, 15_000);
}

/** The command that brings one update in: run in its folder (the home folder for the user's). */
export function updateStep(u: PluginUpdate, home: string): { args: string[]; cwd: string } {
	const cwd = u.folder ?? home;
	if (u.kind === "skill") return { args: ["skill", "update", u.id, ...(u.scope === "user" ? ["-g"] : [])], cwd };
	if (u.source === "npm") return { args: ["plugin", "upgrade", u.id], cwd };
	return { args: ["plugin", "upgrade", u.id, "--scope", u.scope], cwd };
}
