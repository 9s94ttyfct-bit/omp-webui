import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import type { McpAdded } from "../../shared/mcp-registry.ts";
import {
	type CatalogPlugin,
	type InstalledPlugin,
	isPluginScope,
	PLUGIN_JOB_ACTIONS,
	type PluginCheck,
	type PluginFeature,
	type PluginJob,
	type PluginJobAction,
	type PluginMarketplace,
	type PluginReload,
	type PluginScope,
	type PluginSetting,
	type PluginsData,
	type PluginsFailure,
	type PluginUpdate,
	type UpdatesState,
} from "../../shared/plugins.ts";
import type { Live, LivePool } from "../live.ts";
import { mcpConfigs } from "./loaded.ts";
import {
	addToMcpConfig,
	fetchServer,
	McpRegistryError,
	mapServer,
	problemText,
	searchRegistry,
	validConfigName,
} from "./mcp-registry.ts";
import {
	asksToConfirmScripts,
	parseSkillSearch,
	validSkillId,
	validSkillQuery,
	validSkillSpec,
} from "./plugin-skills.ts";
import {
	type CheckResult,
	checkUpdates,
	type NpmLatest,
	parseUpgradePreview,
	type UpgradeAvailable,
	updateStep,
} from "./plugin-updates.ts";
import { type Ran, RunTimeout, run, withTimeout } from "./run.ts";
import {
	followGlobalList,
	ProjectConfigError,
	readSkillFile,
	readSkills,
	type SkillSwitchDeps,
	switchSkills,
} from "./skill-switches.ts";
import { reloadPlugins, serialized, validPlugin, validSkill } from "./toggles.ts";

/**
 * The Plugins page (`#/plugins`): omp's plugins, listed and changed with omp's own CLI (`omp plugin …`), never by editing
 * its files. The CLI runs as the Commands & terminal page runs it: the server's omp, with the server's environment (its
 * HOME, where omp keeps its plugins under `~/.omp/plugins`, and its agent directory), in the home folder or in the project
 * folder the page names (its project-scoped plugins are listed with the user's, and a project install goes there).
 *
 * Every argument is checked before it is put on omp's command line, which is run without a shell: a name, a spec or a value
 * that starts with `-` would be read by omp as a flag (and one it does not know is dropped without a word), so none is let
 * through. What omp prints when it fails is what the page shows.
 *
 * A change that takes long (an install, an upgrade, a marketplace's catalog fetched with git) is a job: the request starts
 * it and answers at once, and the page reads what omp prints as it goes (`GET /api/plugins/jobs/<id>`). One change at a time,
 * in turn with the Loaded dialog's switches (`serialized`). After a change a running conversation loads, every running Full
 * conversation is told to `/reload-plugins`; which ones did, and which need a restart, is part of the answer.
 */

/** A listing or a quick change: omp answers in well under a second. */
const QUICK_MS = 30_000;
/** What fetches: an npm or git install, an upgrade, a marketplace's catalog cloned with git. */
const FETCH_MS = 10 * 60_000;
/** A change on disk only: an uninstall, removing a marketplace, the doctor's repairs. */
const LOCAL_MS = 2 * 60_000;
/** How long a conversation is given to reload its plugins. */
const RELOAD_MS = 20_000;
/** How much of what a job printed is kept: its last part. */
const OUTPUT_CHARS = 64 * 1024;
/** How many finished jobs are kept for a page to read. */
const KEPT_JOBS = 20;
/** The longest text taken for a spec, a source or a value. */
const MAX_TEXT = 1000;

// ------------------------------------------------------------------ arguments

// biome-ignore lint/suspicious/noControlCharactersInRegex: this is the check for them
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * What the person typed to install (`pkg`, `pkg@1.2.3`, `pkg[feat]`, `github:user/repo#v1`, a git URL, a local path,
 * `name@marketplace`) or to add a marketplace (`owner/repo`, a URL, a local folder): one line, not a flag. A path that
 * starts with `~/` is taken from the home folder, which omp does not do itself. null: not something omp may be given.
 */
export function pluginSpec(raw: unknown, home: string): string | null {
	if (typeof raw !== "string") return null;
	const spec = raw.trim();
	if (spec === "" || spec.length > MAX_TEXT || spec.startsWith("-") || CONTROL.test(spec)) return null;
	if (spec === "~") return home;
	return spec.startsWith("~/") ? join(home, spec.slice(2)) : spec;
}

/** A marketplace's name, as omp names one from its catalog. */
const MARKETPLACE_NAME = /^[\w][\w.-]{0,99}$/u;
export const validMarketplace = (v: unknown): v is string => typeof v === "string" && MARKETPLACE_NAME.test(v);

/** A feature's name: never a comma (omp splits the list on them) nor a flag. */
const FEATURE_NAME = /^[\w][\w.-]{0,99}$/u;
export const validFeature = (v: unknown): v is string => typeof v === "string" && FEATURE_NAME.test(v);

/** A setting's key. */
const CONFIG_KEY = /^[\w][\w.-]{0,199}$/u;
export const validConfigKey = (v: unknown): v is string => typeof v === "string" && CONFIG_KEY.test(v);

/**
 * Why a setting's value cannot be given to omp, or null when it can. omp's CLI drops an argument that starts with `-`
 * (it reads it as a flag it does not know), so such a value would be set to something else without a word.
 */
export function configValueProblem(v: unknown): string | null {
	if (typeof v !== "string") return "The value must be text";
	if (v.length > MAX_TEXT) return "The value is too long";
	if (CONTROL.test(v)) return "The value must be one line";
	if (v.trimStart().startsWith("-")) return "omp's CLI cannot set a value that starts with “-”";
	return null;
}

// ------------------------------------------------------------------ what omp prints

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** The text omp printed, without its colours and its status signs (`✔`, `✘`). */
export function plainOutput(text: string): string {
	return Bun.stripANSI(text)
		.split("\n")
		.map((l) => l.replace(/^\s*[✔✘⚠✓✗]\s*/u, "").trimEnd())
		.join("\n")
		.trim();
}

/** `omp plugin marketplace list`: `  <name>  <source>` under a heading, or a line that says there is none. */
export function parseMarketplaceList(text: string): PluginMarketplace[] {
	const out: PluginMarketplace[] = [];
	for (const line of Bun.stripANSI(text).split("\n")) {
		const m = /^ {2}(\S+) {2,}(\S.*)$/.exec(line);
		if (m) out.push({ name: m[1], source: m[2].trim() });
	}
	return out;
}

/** What `omp plugin discover` says of a plugin; the rest of a `CatalogPlugin` is added by `readPlugins`. */
export type DiscoveredPlugin = Pick<CatalogPlugin, "name" | "version" | "description" | "marketplace">;

/**
 * `omp plugin discover <marketplace>`: `  <name>@<version>` (no `@` when the catalog gives no version), its description on
 * the line under it, indented further.
 */
export function parseDiscover(text: string, marketplace: string): DiscoveredPlugin[] {
	const out: DiscoveredPlugin[] = [];
	for (const line of Bun.stripANSI(text).split("\n")) {
		const description = /^ {4}(\S.*)$/.exec(line);
		const last = out.at(-1);
		if (description && last) {
			last.description = last.description ? `${last.description} ${description[1].trim()}` : description[1].trim();
			continue;
		}
		const entry = /^ {2}(\S+)$/.exec(line);
		if (!entry) continue;
		// A scoped name (`@scope/name`) starts with `@`: the version is after the last one, never the first.
		const at = entry[1].lastIndexOf("@");
		out.push(
			at > 0
				? { name: entry[1].slice(0, at), version: entry[1].slice(at + 1) || null, description: null, marketplace }
				: { name: entry[1], version: null, description: null, marketplace },
		);
	}
	return out;
}

/** What a marketplace's cached catalog says of a plugin besides what `omp plugin discover` prints. */
export type CatalogDetails = Pick<CatalogPlugin, "category" | "author" | "homepage" | "tags" | "skills">;

const NO_DETAILS: CatalogDetails = { category: null, author: null, homepage: null, tags: [], skills: 0 };

const lowerWords = (v: unknown): string[] =>
	Array.isArray(v)
		? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim().toLowerCase())
		: [];

/**
 * One marketplace's catalog (`marketplace.json`, as omp caches it): each plugin's category, author, homepage, tags and
 * keywords, and how many skills it lists, by plugin name. Anything not in the shape is left out, never an error.
 */
export function parseCatalogDetails(doc: unknown): Map<string, CatalogDetails> {
	const out = new Map<string, CatalogDetails>();
	if (!isRecord(doc) || !Array.isArray(doc.plugins)) return out;
	for (const p of doc.plugins) {
		if (!isRecord(p) || typeof p.name !== "string") continue;
		const author = isRecord(p.author) ? p.author.name : p.author;
		const homepage = typeof p.homepage === "string" && /^https?:\/\//.test(p.homepage) ? p.homepage : null;
		out.set(p.name, {
			category: typeof p.category === "string" && p.category.trim() ? p.category.trim().toLowerCase() : null,
			author: typeof author === "string" && author.trim() ? author.trim() : null,
			homepage,
			tags: [...new Set([...lowerWords(p.tags), ...lowerWords(p.keywords)])],
			skills: Array.isArray(p.skills) ? p.skills.length : 0,
		});
	}
	return out;
}

function readJsonFile(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

/**
 * The details of every configured marketplace's catalog, by `name@marketplace`: omp lists its marketplaces in
 * `marketplaces.json` beside its agent directory, each with the path of its cached catalog. What cannot be read gives
 * no details.
 */
export function readCatalogDetails(agentDir: string): Map<string, CatalogDetails> {
	const out = new Map<string, CatalogDetails>();
	const registry = readJsonFile(join(dirname(agentDir), "marketplaces.json"));
	const list = isRecord(registry) && Array.isArray(registry.marketplaces) ? registry.marketplaces : [];
	for (const m of list) {
		if (!isRecord(m) || typeof m.name !== "string" || typeof m.catalogPath !== "string") continue;
		for (const [name, d] of parseCatalogDetails(readJsonFile(m.catalogPath))) out.set(`${name}@${m.name}`, d);
	}
	return out;
}

/** The features a manifest declares and which are on: the chosen ones, else the defaults (`enabledFeatures` null). */
export function featuresOf(manifest: unknown, enabledFeatures: unknown): PluginFeature[] {
	const declared = isRecord(manifest) && isRecord(manifest.features) ? manifest.features : {};
	const chosen = Array.isArray(enabledFeatures)
		? new Set(enabledFeatures.filter((f): f is string => typeof f === "string"))
		: null;
	return Object.entries(declared).map(([name, spec]) => {
		const isDefault = isRecord(spec) && spec.default === true;
		return {
			name,
			description: isRecord(spec) ? str(spec.description) : null,
			default: isDefault,
			enabled: chosen ? chosen.has(name) : isDefault,
		};
	});
}

/** `name@marketplace`, split at the last `@` (a scoped package name starts with one). */
export function splitMarketplaceId(id: string): { name: string; marketplace: string } | null {
	const at = id.lastIndexOf("@");
	return at > 0 ? { name: id.slice(0, at), marketplace: id.slice(at + 1) } : null;
}

/** Whether a path is a link (a plugin `omp plugin link` or a path install put in place). */
function isLink(path: string | null): boolean {
	if (!path) return false;
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

/** The `description` of a plugin's own `package.json`, which `omp plugin list --json` does not carry. */
function packageDescription(path: string | null): string | null {
	if (!path) return null;
	try {
		const pkg: unknown = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
		return isRecord(pkg) ? str(pkg.description) : null;
	} catch {
		return null;
	}
}

/**
 * `omp plugin list --json`: `npm` (git installs too; a link to a local folder is `linked`) and `marketplace` plugins, each
 * with the newer version its catalog has (`upgrades`) and its description (the catalog's, else its `package.json`'s).
 */
export function parseInstalled(
	doc: unknown,
	upgrades: readonly UpgradeAvailable[] = [],
	descriptions: (id: string, path: string | null) => string | null = (_, path) => packageDescription(path),
	linked: (path: string | null) => boolean = isLink,
): InstalledPlugin[] {
	if (!isRecord(doc)) throw new Error("omp plugin list answered in a form this does not know");
	const out: InstalledPlugin[] = [];
	for (const p of Array.isArray(doc.npm) ? doc.npm : []) {
		if (!isRecord(p) || typeof p.name !== "string") continue;
		const path = str(p.path);
		const manifest = isRecord(p.manifest) ? p.manifest : {};
		out.push({
			id: p.name,
			name: p.name,
			source: linked(path) ? "linked" : "npm",
			marketplace: null,
			scope: "user",
			version: str(p.version),
			description: str(manifest.description) ?? descriptions(p.name, path),
			enabled: p.enabled !== false,
			path,
			features: featuresOf(manifest, p.enabledFeatures),
			hasSettings: isRecord(manifest.settings) && Object.keys(manifest.settings).length > 0,
			upgrade: null,
		});
	}
	for (const p of Array.isArray(doc.marketplace) ? doc.marketplace : []) {
		if (!isRecord(p) || typeof p.id !== "string") continue;
		const entry = Array.isArray(p.entries) && isRecord(p.entries[0]) ? p.entries[0] : {};
		const scope = isPluginScope(p.scope) ? p.scope : isPluginScope(entry.scope) ? entry.scope : "user";
		const split = splitMarketplaceId(p.id);
		const path = str(entry.installPath);
		const newer = upgrades.find((u) => u.id === p.id && u.scope === scope);
		out.push({
			id: p.id,
			name: split?.name ?? p.id,
			source: "marketplace",
			marketplace: split?.marketplace ?? null,
			scope,
			version: str(entry.version),
			description: descriptions(p.id, path),
			// A marketplace plugin's switch is on each of its entries (`omp plugin disable` writes it there).
			enabled: p.enabled !== false && entry.enabled !== false,
			...(p.shadowedBy === "project" ? { shadowedBy: "project" as const } : {}),
			path,
			features: [],
			hasSettings: false,
			upgrade: newer ? { from: newer.from, to: newer.to } : null,
		});
	}
	return out;
}

/** `omp plugin doctor --json`: one check per line of the terminal's health check. */
export function parseDoctor(doc: unknown): PluginCheck[] {
	if (!Array.isArray(doc)) throw new Error("omp plugin doctor answered in a form this does not know");
	return doc.flatMap((c): PluginCheck[] => {
		if (!isRecord(c) || typeof c.name !== "string") return [];
		const status = c.status === "ok" || c.status === "warning" || c.status === "error" ? c.status : "warning";
		return [{ name: c.name, status, message: str(c.message) ?? "", ...(c.fixed === true ? { fixed: true } : {}) }];
	});
}

/**
 * `omp plugin config list <name> --json`: `{ settings, schema }`, the values the person set and what the plugin declares.
 * A secret one's value stays here: the page is told only whether it is set.
 */
export function parseConfig(doc: unknown): PluginSetting[] {
	if (!isRecord(doc)) throw new Error("omp plugin config answered in a form this does not know");
	const values = isRecord(doc.settings) ? doc.settings : {};
	const schema = isRecord(doc.schema) ? doc.schema : {};
	const keys = [...new Set([...Object.keys(schema), ...Object.keys(values)])];
	return keys.map((key) => {
		const spec = isRecord(schema[key]) ? schema[key] : {};
		const secret = spec.secret === true;
		const set = Object.hasOwn(values, key);
		const value = set ? values[key] : spec.default;
		return {
			key,
			type: str(spec.type),
			description: str(spec.description),
			env: str(spec.env),
			secret,
			set,
			value:
				secret || value === undefined || value === null
					? null
					: typeof value === "string"
						? value
						: JSON.stringify(value),
		};
	});
}

// ------------------------------------------------------------------ running omp's CLI

/** A request the server refuses, or a change omp refused: the message is omp's own where it said why. */
export class PluginsError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

export interface PluginsDeps {
	bin: string;
	/** The home folder: omp's CLI runs there when no project is named. */
	home: string;
	/** omp's agent directory: its `mcp.json` is the user's MCP config, where the MCP section adds a server. */
	agentDir: string;
	/** A folder with no `.omp` of its own (this app's data folder): omp's global settings are read and written there. */
	neutral: string;
	pool: LivePool;
	/** Why nothing may be changed now (an import writes the files omp runs on), or null. */
	held: () => Error | null;
	updates: UpdatesDeps;
}

/** What the update check and the automatic update read from the rest of the server. */
export interface UpdatesDeps {
	/** `ompw.extensionsAutoUpdate` is on. */
	autoOn: () => boolean;
	/** The conversations an install would reload under them (`conversationsHeld`). */
	conversations: () => NonNullable<UpdatesState["auto"]["waitingFor"]>;
	/** Project folders with plugins or skills of their own (from the conversations' folders). */
	folders: () => Promise<string[]>;
	npmLatest: NpmLatest;
}

/** omp's words for a command that failed: what it printed to stderr, else to stdout. */
function failure(stdout: string, stderr: string, args: string[], code: number): string {
	const said = plainOutput(stderr) || plainOutput(stdout);
	return said ? said.slice(-2000) : `omp ${args.join(" ")} exited with code ${code}`;
}

async function cli(
	bin: string,
	args: string[],
	cwd: string,
	timeoutMs = QUICK_MS,
	onOutput?: (text: string) => void,
): Promise<string> {
	let ran: Ran;
	try {
		ran = await run([bin, ...args], { cwd, env: { NO_COLOR: "1", FORCE_COLOR: "0" }, timeoutMs, onOutput });
	} catch (e) {
		if (e instanceof RunTimeout)
			throw new PluginsError(`omp ${args.slice(0, 3).join(" ")} did not finish in time`, 504);
		throw e;
	}
	if (ran.code !== 0) throw new PluginsError(failure(ran.stdout, ran.stderr, args, ran.code), 422);
	return ran.stdout;
}

async function cliJson(bin: string, args: string[], cwd: string): Promise<unknown> {
	const out = await cli(bin, args, cwd);
	try {
		return JSON.parse(out);
	} catch {
		throw new PluginsError(`omp ${args.join(" ")} did not print JSON`, 502);
	}
}

const failed = (e: unknown): PluginsFailure => ({ error: e instanceof Error ? e.message : String(e) });

/** The folder omp's CLI runs in: the one the request names (it must exist), else the home folder. */
function folderOf(raw: unknown, home: string): string {
	if (raw === undefined || raw === null || raw === "") return home;
	if (typeof raw !== "string" || !isAbsolute(raw) || CONTROL.test(raw))
		throw new PluginsError("The folder must be an absolute path", 400);
	const dir = resolve(raw);
	let isDir = false;
	try {
		isDir = statSync(dir).isDirectory();
	} catch {}
	if (!isDir) throw new PluginsError(`Folder no longer exists: ${dir}`, 409);
	return dir;
}

/** A project install needs a project: the home folder's `.omp` is where omp keeps the user's own plugins. */
function scopeOf(raw: unknown, cwd: string, home: string): PluginScope | null {
	if (raw === undefined || raw === null) return null;
	if (!isPluginScope(raw)) throw new PluginsError("scope must be user or project", 400);
	if (raw === "project" && resolve(cwd) === resolve(home))
		throw new PluginsError("Choose a project folder for a project-scoped plugin", 400);
	return raw;
}

// ------------------------------------------------------------------ reading

/** Everything the page lists, each part on its own. */
export async function readPlugins(bin: string, cwd: string, home: string, agentDir: string): Promise<PluginsData> {
	const marketplaces = cli(bin, ["plugin", "marketplace", "list"], cwd).then(parseMarketplaceList);
	const upgrades = cli(bin, ["plugin", "upgrade", "--dry-run"], cwd).then(parseUpgradePreview);
	const list = cliJson(bin, ["plugin", "list", "--json"], cwd);
	// Each marketplace's catalog on its own: one that cannot be read is marked, the others are listed.
	const catalogs = marketplaces.then((all) =>
		Promise.all(
			all.map(async (m) => {
				try {
					return { m, plugins: parseDiscover(await cli(bin, ["plugin", "discover", m.name], cwd), m.name) };
				} catch (e) {
					return { m: { ...m, error: failed(e).error }, plugins: [] };
				}
			}),
		),
	);
	const [listed, found, upgradeAnswer] = await Promise.all([
		list.then(
			(v) => ({ ok: true as const, v }),
			(e) => ({ ok: false as const, e }),
		),
		catalogs.then(
			(v) => ({ ok: true as const, v }),
			(e) => ({ ok: false as const, e }),
		),
		upgrades.then(
			(v) => ({ ok: true as const, v }),
			(e) => ({ ok: false as const, e }),
		),
	]);
	const catalogText = new Map<string, string>();
	if (found.ok)
		for (const { plugins } of found.v)
			for (const p of plugins) if (p.description) catalogText.set(`${p.name}@${p.marketplace}`, p.description);
	let installed: InstalledPlugin[] | PluginsFailure;
	try {
		if (!listed.ok) throw listed.e;
		installed = parseInstalled(
			listed.v,
			upgradeAnswer.ok ? upgradeAnswer.v : [],
			(id, path) => catalogText.get(id) ?? packageDescription(path),
		);
	} catch (e) {
		installed = failed(e);
	}
	const scopesOf = (id: string): PluginScope[] =>
		Array.isArray(installed) ? installed.filter((p) => p.id === id).map((p) => p.scope) : [];
	const details = found.ok ? readCatalogDetails(agentDir) : new Map<string, CatalogDetails>();
	return {
		cwd,
		home: resolve(cwd) === resolve(home),
		installed,
		marketplaces: found.ok ? found.v.map((c) => c.m) : failed(found.e),
		catalog: found.ok
			? found.v.flatMap((c) =>
					c.plugins.map((p) => {
						const id = `${p.name}@${p.marketplace}`;
						return { ...p, ...(details.get(id) ?? NO_DETAILS), installed: scopesOf(id) };
					}),
				)
			: failed(found.e),
		upgradeError: upgradeAnswer.ok ? null : failed(upgradeAnswer.e).error,
	};
}

// ------------------------------------------------------------------ after a change

/**
 * Every running Full conversation is told to reload its plugins (a Light one loads none). A paused one is frozen and is
 * left so: it sees the change once it is resumed and restarted, as one whose omp has no `/reload-plugins` does.
 */
export async function reloadConversations(pool: LivePool): Promise<PluginReload[]> {
	const lives = pool
		.list()
		.filter((info) => !info.exited && info.mode !== "light")
		.map((info) => pool.get(info.liveId))
		.filter((live): live is Live => live !== undefined && !live.client.closing);
	return Promise.all(
		lives.map(async (live): Promise<PluginReload> => {
			const base = { liveId: live.info.liveId, sessionFile: live.info.sessionFile ?? null };
			if (live.info.pausedAt !== null) return { ...base, state: "paused" };
			try {
				const done = await withTimeout(reloadPlugins(live, false), RELOAD_MS, "reload-plugins");
				return { ...base, state: done ? "reloaded" : "restart" };
			} catch {
				return { ...base, state: "restart" };
			}
		}),
	);
}

// ------------------------------------------------------------------ jobs

const jobs = new Map<string, PluginJob>();
let running: PluginJob | null = null;

function keep(job: PluginJob): void {
	jobs.set(job.id, job);
	for (const id of jobs.keys()) {
		if (jobs.size <= KEPT_JOBS) break;
		if (jobs.get(id)?.state !== "running") jobs.delete(id);
	}
}

/** Nothing else may change omp's plugins while a job does, nor while an import writes the files omp runs on. */
function mayChange(deps: PluginsDeps): void {
	const held = deps.held();
	if (held) throw new PluginsError(held.message, 409);
	if (running) throw new PluginsError("Another plugin change is running: wait for it to finish", 409);
}

/** How a command is shown: as typed in a terminal, a value with spaces quoted. */
function shown(args: string[]): string {
	return ["omp", ...args].map((a) => (/[\s"']/.test(a) ? `'${a.replaceAll("'", "'\\''")}'` : a)).join(" ");
}

/** One command of a job, in `cwd` (the job's folder when none). */
interface JobStep {
	args: string[];
	cwd?: string;
}

/** What a job runs: one command, or several in turn (each runs even when one before it failed). */
type JobPlan = {
	timeoutMs: number;
	/** Whether a running conversation loads what it changes (a marketplace's catalog it does not). */
	reload: boolean;
} & ({ args: string[] } | { steps: JobStep[] });

/** The commands a job runs, in turn. */
export const stepsOf = (plan: JobPlan): JobStep[] => ("steps" in plan ? plan.steps : [{ args: plan.args }]);

/** The command a job runs, from what the page asked: every argument checked. */
export function planJob(action: PluginJobAction, body: Record<string, unknown>, cwd: string, home: string): JobPlan {
	switch (action) {
		case "install": {
			const spec = pluginSpec(body.spec, home);
			if (!spec) throw new PluginsError("Name a package, a git URL, a folder or name@marketplace (not a flag)", 400);
			const scope = scopeOf(body.scope, cwd, home);
			const args = ["plugin", "install", spec, ...(scope ? ["--scope", scope] : [])];
			if (body.force === true) args.push("--force");
			return { args, timeoutMs: FETCH_MS, reload: true };
		}
		case "uninstall": {
			if (!validPlugin(body.id)) throw new PluginsError("Name the plugin to uninstall", 400);
			const scope = scopeOf(body.scope, cwd, home);
			return {
				args: ["plugin", "uninstall", body.id, ...(scope ? ["--scope", scope] : [])],
				timeoutMs: LOCAL_MS,
				reload: true,
			};
		}
		case "upgrade": {
			// None named: every marketplace plugin with a newer version (omp's `upgrade` without a target).
			if (body.id === undefined || body.id === null)
				return { args: ["plugin", "upgrade"], timeoutMs: FETCH_MS, reload: true };
			if (!validPlugin(body.id)) throw new PluginsError("Name the plugin to upgrade", 400);
			const scope = scopeOf(body.scope, cwd, home);
			return {
				args: ["plugin", "upgrade", body.id, ...(scope ? ["--scope", scope] : [])],
				timeoutMs: FETCH_MS,
				reload: true,
			};
		}
		case "doctor-fix":
			return { args: ["plugin", "doctor", "--fix"], timeoutMs: FETCH_MS, reload: true };
		case "marketplace-add": {
			const source = pluginSpec(body.source, home);
			if (!source) throw new PluginsError("Name the marketplace as owner/repo, a URL or a folder (not a flag)", 400);
			return { args: ["plugin", "marketplace", "add", source], timeoutMs: FETCH_MS, reload: false };
		}
		case "marketplace-remove": {
			if (!validMarketplace(body.name)) throw new PluginsError("Name the marketplace to remove", 400);
			return { args: ["plugin", "marketplace", "remove", body.name], timeoutMs: LOCAL_MS, reload: false };
		}
		case "marketplace-update": {
			// Several named: each in turn (`names`); none: every one (omp's `update` without a name).
			if (Array.isArray(body.names)) {
				const names = [...new Set(body.names)];
				if (names.length === 0 || names.length > 100 || !names.every(validMarketplace))
					throw new PluginsError("Name the marketplaces to update", 400);
				return {
					steps: names.map((name) => ({ args: ["plugin", "marketplace", "update", name] })),
					timeoutMs: FETCH_MS,
					reload: false,
				};
			}
			if (body.name === undefined || body.name === null)
				return { args: ["plugin", "marketplace", "update"], timeoutMs: FETCH_MS, reload: false };
			if (!validMarketplace(body.name)) throw new PluginsError("Name the marketplace to update", 400);
			return { args: ["plugin", "marketplace", "update", body.name], timeoutMs: FETCH_MS, reload: false };
		}
		case "skill-install": {
			if (!validSkillSpec(body.spec)) throw new PluginsError("Name the skill as @scope/name[@version]", 400);
			// The user's skills unless a project is chosen: without `-g` omp installs into the folder's `.omp/skills.json`.
			const scope = scopeOf(body.scope, cwd, home) ?? "user";
			const args = ["skill", "install", body.spec, ...(scope === "user" ? ["-g"] : [])];
			// Only after the person agreed to what omp listed (see `PluginJob.confirm`).
			if (body.yes === true) args.push("-y");
			return { args, timeoutMs: FETCH_MS, reload: true };
		}
		case "skill-uninstall": {
			if (!validSkillId(body.id)) throw new PluginsError("Name the skill to uninstall as @scope/name", 400);
			const scope = scopeOf(body.scope, cwd, home) ?? "user";
			return {
				args: ["skill", "uninstall", body.id, ...(scope === "user" ? ["-g"] : [])],
				timeoutMs: LOCAL_MS,
				reload: true,
			};
		}
		case "update":
			// What is updated is the last check's (`planUpdate`), never what the page names beyond its keys.
			throw new PluginsError("An update is planned from the last check", 500);
	}
}

/** Start a job: it runs in the background, and its record says how far it is. */
function startJob(
	deps: PluginsDeps,
	action: PluginJobAction,
	plan: JobPlan,
	cwd: string,
	after?: (job: PluginJob, failed: ReadonlySet<number>) => void,
): PluginJob {
	mayChange(deps);
	const steps = stepsOf(plan);
	const job: PluginJob = {
		id: randomBytes(8).toString("hex"),
		action,
		command: steps.map((s) => shown(s.args)).join("\n"),
		state: "running",
		output: "",
		error: null,
		startedAt: Date.now(),
		endedAt: null,
		reloads: [],
	};
	running = job;
	keep(job);
	const told = (text: string) => {
		const next = job.output + Bun.stripANSI(text);
		job.output = next.length > OUTPUT_CHARS ? next.slice(-OUTPUT_CHARS) : next;
	};
	const failed = new Set<number>();
	const run = async () => {
		const failures: string[] = [];
		for (const [i, step] of steps.entries()) {
			// A job of several steps shows each command before what it printed.
			if (steps.length > 1) told(`${job.output ? "\n" : ""}$ ${shown(step.args)}\n`);
			try {
				await cli(deps.bin, step.args, step.cwd ?? cwd, plan.timeoutMs, told);
			} catch (e) {
				failed.add(i);
				if (steps.length === 1) throw e;
				failures.push(`${shown(step.args)}: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		if (failures.length > 0) throw new Error(failures.join("\n"));
	};
	void (async () => {
		let error: string | null = null;
		try {
			await serialized(run);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
		// Even after a step failed, what the others changed is loaded; the job ends once that is done.
		if (plan.reload && failed.size < steps.length) job.reloads = await reloadConversations(deps.pool).catch(() => []);
		job.error = error;
		if (error !== null && action === "skill-install" && asksToConfirmScripts(error)) job.confirm = "scripts";
		job.endedAt = Date.now();
		job.state = error === null ? "done" : "failed";
		if (running === job) running = null;
		try {
			after?.(job, failed);
		} finally {
			if (pendingInstall) setTimeout(() => tryAutoInstall(), 0);
		}
	})();
	return job;
}

// ------------------------------------------------------------------ updates

/** A test's shorter interval (`OMPW_EXTENSIONS_*_MS`), read when it is due, else the real one. */
const interval = (env: string, ms: number) => (): number => Number(process.env[env]) || ms;
/** How often the automatic update looks, and how soon after it was turned on (or the server started). */
const checkEveryMs = interval("OMPW_EXTENSIONS_CHECK_MS", 6 * 60 * 60_000);
const firstCheckMs = interval("OMPW_EXTENSIONS_FIRST_CHECK_MS", 60_000);
/** How often an install that is due looks again whether the conversations are idle. */
const retryInstallMs = interval("OMPW_EXTENSIONS_RETRY_MS", 30_000);

type Held = NonNullable<UpdatesState["auto"]["waitingFor"]>;

let lastCheck: (CheckResult & { at: number; folders: string[] }) | null = null;
let checking: Promise<void> | null = null;
let autoDeps: PluginsDeps | null = null;
let checkTimer: ReturnType<typeof setTimeout> | null = null;
let nextCheckAt: number | null = null;
/** The automatic update found something newer and installs it once nothing is busy. */
let pendingInstall = false;
let installTimer: ReturnType<typeof setTimeout> | null = null;
let waitingFor: Held | null = null;
let autoLast: UpdatesState["auto"]["last"] = null;

function updatesState(deps: PluginsDeps): UpdatesState {
	return {
		checking: checking !== null,
		checkedAt: lastCheck?.at ?? null,
		updates: lastCheck?.updates ?? [],
		unchecked: lastCheck?.unchecked ?? [],
		errors: lastCheck?.errors ?? [],
		folders: lastCheck?.folders ?? [],
		auto: { on: deps.updates.autoOn(), nextCheckAt, waitingFor, last: autoLast },
	};
}

/**
 * A check: the marketplaces' catalogs are fetched again (in turn with every change, as a job's are), then each source is
 * read (`checkUpdates`). One at a time: a second ask while one runs waits for it.
 */
function check(deps: PluginsDeps): Promise<void> {
	checking ??= (async () => {
		try {
			const errors: string[] = [];
			const marketplaces = await cli(deps.bin, ["plugin", "marketplace", "list"], deps.home)
				.then(parseMarketplaceList)
				.catch((e: unknown) => {
					errors.push(`marketplaces: ${failed(e).error.split("\n")[0]}`);
					return [];
				});
			if (marketplaces.length > 0)
				await serialized(() => cli(deps.bin, ["plugin", "marketplace", "update"], deps.home, FETCH_MS)).catch(
					(e: unknown) => errors.push(`marketplaces: ${failed(e).error.split("\n")[0]}`),
				);
			const folders = await deps.updates.folders().catch(() => []);
			const found = await checkUpdates({
				run: (args, cwd) => cli(deps.bin, args, cwd),
				npmLatest: deps.updates.npmLatest,
				home: deps.home,
				folders,
			});
			lastCheck = { ...found, errors: [...errors, ...found.errors], at: Date.now(), folders };
		} finally {
			checking = null;
		}
	})();
	return checking;
}

/** The updates the page asked for (by key, or every one), as the last check found them. */
function planUpdate(body: Record<string, unknown>, home: string): { plan: JobPlan; chosen: PluginUpdate[] } {
	const all = lastCheck?.updates ?? [];
	const keys = body.keys === "all" ? all.map((u) => u.key) : body.keys;
	if (!Array.isArray(keys) || keys.length === 0 || !keys.every((k) => typeof k === "string"))
		throw new PluginsError('Name the updates to install (keys, or "all")', 400);
	const chosen = all.filter((u) => keys.includes(u.key));
	if (chosen.length !== new Set(keys).size)
		throw new PluginsError("Some of these updates are no longer listed: check again", 409);
	return {
		plan: { steps: chosen.map((u) => updateStep(u, home)), timeoutMs: FETCH_MS, reload: true },
		chosen,
	};
}

/** Start an update job; what it brought in leaves the list. */
function startUpdate(deps: PluginsDeps, body: Record<string, unknown>, auto: boolean): PluginJob {
	const { plan, chosen } = planUpdate(body, deps.home);
	const job = startJob(deps, "update", plan, deps.home, (done, failedSteps) => {
		const installed = new Set(chosen.filter((_, i) => !failedSteps.has(i)).map((u) => u.key));
		if (lastCheck) lastCheck = { ...lastCheck, updates: lastCheck.updates.filter((u) => !installed.has(u.key)) };
		if (auto) autoLast = { at: Date.now(), count: installed.size, error: done.error };
	});
	if (auto) job.auto = true;
	return job;
}

const busyCount = (h: Held): number => h.working + h.asking + h.paused + h.waiting;

/** A due automatic install starts once no conversation works, asks, is paused or waits, and no other change runs. */
function tryAutoInstall(): void {
	if (installTimer) clearTimeout(installTimer);
	installTimer = null;
	const deps = autoDeps;
	if (!deps || !pendingInstall || !deps.updates.autoOn()) {
		pendingInstall = false;
		waitingFor = null;
		return;
	}
	if ((lastCheck?.updates.length ?? 0) === 0) {
		pendingInstall = false;
		waitingFor = null;
		return;
	}
	const held = deps.updates.conversations();
	waitingFor = busyCount(held) > 0 ? held : null;
	if (!waitingFor && !running && !deps.held() && !checking) {
		pendingInstall = false;
		try {
			startUpdate(deps, { keys: "all" }, true);
			return;
		} catch (e) {
			autoLast = { at: Date.now(), count: 0, error: failed(e).error };
			return;
		}
	}
	installTimer = setTimeout(tryAutoInstall, retryInstallMs());
	installTimer.unref?.();
}

function scheduleCheck(inMs: number): void {
	if (checkTimer) clearTimeout(checkTimer);
	nextCheckAt = Date.now() + inMs;
	checkTimer = setTimeout(() => void autoCheck(), inMs);
	checkTimer.unref?.();
}

async function autoCheck(): Promise<void> {
	const deps = autoDeps;
	if (!deps?.updates.autoOn()) return;
	try {
		await check(deps);
	} catch (e) {
		autoLast = { at: Date.now(), count: 0, error: failed(e).error };
	}
	if (!deps.updates.autoOn()) return;
	scheduleCheck(checkEveryMs());
	pendingInstall = (lastCheck?.updates.length ?? 0) > 0;
	tryAutoInstall();
}

/**
 * The automatic update (`ompw.extensionsAutoUpdate`), started at the server's start and again whenever the setting
 * changes: on, it looks soon (or when the last look is 6 hours old) and then every 6 hours, and installs everything newer
 * once nothing is busy (what a check already found, at once); off, it stops, and nothing it waited to install is installed.
 */
export function autoUpdates(deps: PluginsDeps): void {
	autoDeps = deps;
	if (!deps.updates.autoOn()) {
		if (checkTimer) clearTimeout(checkTimer);
		if (installTimer) clearTimeout(installTimer);
		checkTimer = installTimer = null;
		nextCheckAt = null;
		pendingInstall = false;
		waitingFor = null;
		return;
	}
	if (checkTimer) return;
	const age = lastCheck ? Date.now() - lastCheck.at : Number.POSITIVE_INFINITY;
	scheduleCheck(Math.max(firstCheckMs(), checkEveryMs() - age));
	if ((lastCheck?.updates.length ?? 0) > 0) {
		pendingInstall = true;
		tryAutoInstall();
	}
}

// ------------------------------------------------------------------ quick changes

/** A quick change: in turn with every other, then the running conversations reload. */
async function change(deps: PluginsDeps, args: string[], cwd: string): Promise<PluginReload[]> {
	mayChange(deps);
	await serialized(() => cli(deps.bin, args, cwd));
	return reloadConversations(deps.pool);
}

/**
 * The arguments that leave exactly `wanted` on. `--set` replaces the list; an empty list cannot be set (omp reads `--set ""`
 * as no flag), so all of them are taken off the chosen list instead (none chosen counts as none there).
 */
export function featureArgs(name: string, wanted: string[], available: string[]): string[] {
	return wanted.length > 0
		? ["plugin", "features", name, "--set", wanted.join(",")]
		: ["plugin", "features", name, "--disable", available.join(",")];
}

// ------------------------------------------------------------------ routes

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const fail = (error: string, status: number) => json({ error }, status);

async function bodyOf(req: Request): Promise<Record<string, unknown>> {
	const body: unknown = await req.json().catch(() => null);
	if (!isRecord(body)) throw new PluginsError("The body must be a JSON object", 400);
	return body;
}

const JOBS_PREFIX = "/api/plugins/jobs/";

async function route(req: Request, url: URL, deps: PluginsDeps): Promise<Response> {
	const p = url.pathname;
	const q = url.searchParams;
	if (p.startsWith(JOBS_PREFIX)) {
		const job = jobs.get(p.slice(JOBS_PREFIX.length));
		return job ? json({ job }) : fail("No such job", 404);
	}
	if (req.method === "GET") {
		const cwd = folderOf(q.get("cwd"), deps.home);
		switch (p) {
			case "/api/plugins":
				return json(await readPlugins(deps.bin, cwd, deps.home, deps.agentDir));
			case "/api/plugins/doctor":
				return json({ checks: parseDoctor(await cliJson(deps.bin, ["plugin", "doctor", "--json"], cwd)) });
			case "/api/plugins/config": {
				const name = q.get("name");
				if (!validPlugin(name)) return fail("Name the plugin", 400);
				return json({
					settings: parseConfig(await cliJson(deps.bin, ["plugin", "config", "list", name, "--json"], cwd)),
				});
			}
			case "/api/plugins/jobs":
				return json({ running });
			case "/api/plugins/updates":
				return json(updatesState(deps));
			case "/api/plugins/skills":
				return json(await readSkills(skillDeps(deps), cwd));
			case "/api/plugins/skills/file": {
				const name = q.get("name");
				if (!validSkill(name)) return fail("Name the skill", 400);
				const file = await readSkillFile(skillDeps(deps), cwd, name);
				return file ? json(file) : fail(`omp lists no SKILL.md for ${name}`, 404);
			}
			case "/api/plugins/skills/search": {
				const query = q.get("q");
				if (!validSkillQuery(query)) return fail("Search for a word or two (not a flag)", 400);
				return json(parseSkillSearch(await cliJson(deps.bin, ["skill", "search", query.trim(), "--json"], cwd)));
			}
			case "/api/plugins/mcp/search": {
				const configs = await mcpConfigs(deps.agentDir, cwd);
				const found = await searchRegistry(q.get("q") ?? "", q.get("cursor") || null, {
					...configs.project.servers,
					...configs.user.servers,
				});
				return json({ ...found, taken: Object.keys(configs.user.servers) });
			}
		}
		return fail("Not found", 404);
	}
	if (req.method !== "POST") return fail("POST required", 405);
	const body = await bodyOf(req);
	const cwd = folderOf(body.cwd, deps.home);
	switch (p) {
		case "/api/plugins/jobs": {
			const action = PLUGIN_JOB_ACTIONS.find((a) => a === body.action);
			if (!action) return fail(`action must be one of ${PLUGIN_JOB_ACTIONS.join(", ")}`, 400);
			if (action === "update") return json({ job: startUpdate(deps, body, false) }, 202);
			const plan = planJob(action, body, cwd, deps.home);
			return json({ job: startJob(deps, action, plan, cwd) }, 202);
		}
		case "/api/plugins/updates/check": {
			const held = deps.held();
			if (held) return fail(held.message, 409);
			// Answered at once: the page asks again (`GET /api/plugins/updates`) until `checking` is false. With the
			// automatic update on, what it finds is installed as an automatic check's would be.
			void check(deps)
				.then(() => {
					if (!deps.updates.autoOn() || (lastCheck?.updates.length ?? 0) === 0) return;
					autoDeps ??= deps;
					pendingInstall = true;
					tryAutoInstall();
				})
				.catch(() => {});
			return json(updatesState(deps), 202);
		}
		case "/api/plugins/enable": {
			if (!validPlugin(body.id) || typeof body.enabled !== "boolean") return fail("id and enabled required", 400);
			const scope = scopeOf(body.scope, cwd, deps.home);
			const args = ["plugin", body.enabled ? "enable" : "disable", ...(scope ? ["--scope", scope] : []), body.id];
			return json({ reloads: await change(deps, args, cwd) });
		}
		case "/api/plugins/features": {
			const name = body.name;
			if (!validPlugin(name)) return fail("Name the plugin", 400);
			if (!Array.isArray(body.features) || !body.features.every(validFeature))
				return fail("features must be a list of feature names", 400);
			const wanted = [...new Set(body.features.filter(validFeature))];
			const now = await cliJson(deps.bin, ["plugin", "features", name, "--json"], cwd);
			const available =
				isRecord(now) && Array.isArray(now.availableFeatures) ? now.availableFeatures.filter(validFeature) : [];
			if (available.length === 0) return fail(`${name} has no optional features`, 400);
			const unknown = wanted.filter((f) => !available.includes(f));
			if (unknown.length) return fail(`${name} has no feature ${unknown.join(", ")}`, 400);
			return json({ reloads: await change(deps, featureArgs(name, wanted, available), cwd) });
		}
		case "/api/plugins/config": {
			const name = body.name;
			if (!validPlugin(name)) return fail("Name the plugin", 400);
			if (!validConfigKey(body.key)) return fail("Name the setting", 400);
			const value = body.value;
			let args: string[];
			if (value === null) args = ["plugin", "config", "delete", name, body.key];
			else {
				const problem = configValueProblem(value);
				if (problem || typeof value !== "string") return fail(problem ?? "The value must be text", 400);
				args = ["plugin", "config", "set", name, body.key, value];
			}
			const reloads = await change(deps, args, cwd);
			const settings = parseConfig(await cliJson(deps.bin, ["plugin", "config", "list", name, "--json"], cwd));
			return json({ settings, reloads });
		}
		case "/api/plugins/mcp":
			return json(await addMcpServer(deps, body));
		case "/api/plugins/skills/enable": {
			const { names, enabled, scope } = body;
			if (!Array.isArray(names) || names.length === 0 || names.length > 500 || !names.every(validSkill))
				return fail("names must be a list of skill names", 400);
			if (typeof enabled !== "boolean") return fail("enabled required", 400);
			if (scope !== "global" && scope !== "project") return fail("scope must be global or project", 400);
			mayChange(deps);
			await projectConfig(() => switchSkills(skillDeps(deps), cwd, [...new Set(names)], enabled, scope));
			return json(await readSkills(skillDeps(deps), cwd));
		}
		case "/api/plugins/skills/use-global": {
			mayChange(deps);
			await projectConfig(() => followGlobalList(skillDeps(deps), cwd));
			return json(await readSkills(skillDeps(deps), cwd));
		}
	}
	return fail("Not found", 404);
}

const skillDeps = (deps: PluginsDeps): SkillSwitchDeps => ({ bin: deps.bin, home: deps.home, neutral: deps.neutral });

/** A project's config this does not change (or that omp reads elsewhere too): the page shows why. */
async function projectConfig(work: () => Promise<void>): Promise<void> {
	try {
		await work();
	} catch (e) {
		if (e instanceof ProjectConfigError) throw new PluginsError(e.message, 409);
		throw e;
	}
}

/** The values a way of running an MCP server was given: text by its input's key, none of them a control character. */
function mcpValues(raw: unknown): Record<string, string> {
	if (raw === undefined || raw === null) return {};
	if (!isRecord(raw)) throw new PluginsError("values must be an object of texts", 400);
	const entries = Object.entries(raw);
	if (entries.length > 100) throw new PluginsError("Too many values", 400);
	for (const [key, value] of entries) {
		if (key.length > 200 || typeof value !== "string" || value.length > 8000 || CONTROL.test(value))
			// The value itself is never repeated: it may be a secret.
			throw new PluginsError(`The value of ${key.slice(0, 200)} must be one line of text`, 400);
	}
	return raw as Record<string, string>;
}

/**
 * Add one way of running a registry server to the user's `mcp.json`. The entry is worked out from the registry's own
 * answer, fetched again here (never from what the page sends), with the values the person gave.
 */
async function addMcpServer(deps: PluginsDeps, body: Record<string, unknown>): Promise<McpAdded> {
	const { server, version, option, name } = body;
	if (typeof server !== "string" || typeof version !== "string") throw new PluginsError("Name the server", 400);
	if (typeof option !== "string" || !/^(?:package|remote):\d{1,3}$/.test(option))
		throw new PluginsError("Choose how to run it", 400);
	if (!validConfigName(name))
		throw new PluginsError(
			"The name may hold letters, digits, dashes, underscores, dots, colons and single spaces (100 at most)",
			400,
		);
	const values = mcpValues(body.values);
	mayChange(deps);
	const mapped = mapServer(await fetchServer(server, version), values).find((m) => m.option.id === option);
	if (!mapped) throw new PluginsError(`${server} has no ${option}`, 404);
	if (mapped.option.problem) throw new PluginsError(problemText(mapped.option.problem), 422);
	if (mapped.missing.length > 0 || !mapped.entry) {
		const labels = mapped.missing.map((key) => mapped.option.inputs.find((i) => i.key === key)?.label ?? key);
		throw new PluginsError(`Fill in ${labels.join(", ")}`, 400);
	}
	const entry = mapped.entry;
	const file = join(deps.agentDir, "mcp.json");
	await serialized(() => addToMcpConfig(file, name, entry));
	return { name, file };
}

/** `/api/plugins*`: open to every page that has the token, as the Commands & terminal page's runner is. */
export async function handlePlugins(req: Request, url: URL, deps: PluginsDeps): Promise<Response> {
	try {
		return await route(req, url, deps);
	} catch (e) {
		if (e instanceof PluginsError || e instanceof McpRegistryError) return fail(e.message, e.status);
		return fail(e instanceof Error ? e.message : String(e), 500);
	}
}
