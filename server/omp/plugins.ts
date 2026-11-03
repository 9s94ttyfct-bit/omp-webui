import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { isRecord } from "../../shared/guards.ts";
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
} from "../../shared/plugins.ts";
import type { Live, LivePool } from "../live.ts";
import { type Ran, RunTimeout, run, withTimeout } from "./run.ts";
import { reloadPlugins, serialized, validPlugin } from "./toggles.ts";

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

/**
 * `omp plugin discover <marketplace>`: `  <name>@<version>` (no `@` when the catalog gives no version), its description on
 * the line under it, indented further.
 */
export function parseDiscover(text: string, marketplace: string): Omit<CatalogPlugin, "installed">[] {
	const out: Omit<CatalogPlugin, "installed">[] = [];
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

export interface UpgradeAvailable {
	id: string;
	scope: PluginScope;
	from: string | null;
	to: string;
}

/** `omp plugin upgrade --dry-run`: `[dry-run] Would upgrade <id> (<scope>): <from> -> <to>` per marketplace plugin. */
export function parseUpgradePreview(text: string): UpgradeAvailable[] {
	const out: UpgradeAvailable[] = [];
	for (const line of Bun.stripANSI(text).split("\n")) {
		const m = /^\[dry-run\] Would upgrade (\S+) \((user|project)\): (.+?) -> (.+)$/.exec(line.trim());
		if (!m || !isPluginScope(m[2])) continue;
		const from = m[3] === "undefined" || m[3] === "?" ? null : m[3];
		out.push({ id: m[1], scope: m[2], from, to: m[4] });
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
	pool: LivePool;
	/** Why nothing may be changed now (an import writes the files omp runs on), or null. */
	held: () => Error | null;
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
export async function readPlugins(bin: string, cwd: string, home: string): Promise<PluginsData> {
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
	return {
		cwd,
		home: resolve(cwd) === resolve(home),
		installed,
		marketplaces: found.ok ? found.v.map((c) => c.m) : failed(found.e),
		catalog: found.ok
			? found.v.flatMap((c) => c.plugins.map((p) => ({ ...p, installed: scopesOf(`${p.name}@${p.marketplace}`) })))
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

interface JobPlan {
	args: string[];
	timeoutMs: number;
	/** Whether a running conversation loads what it changes (a marketplace's catalog it does not). */
	reload: boolean;
}

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
			if (body.name === undefined || body.name === null)
				return { args: ["plugin", "marketplace", "update"], timeoutMs: FETCH_MS, reload: false };
			if (!validMarketplace(body.name)) throw new PluginsError("Name the marketplace to update", 400);
			return { args: ["plugin", "marketplace", "update", body.name], timeoutMs: FETCH_MS, reload: false };
		}
	}
}

/** Start a job: it runs in the background, and its record says how far it is. */
function startJob(deps: PluginsDeps, action: PluginJobAction, plan: JobPlan, cwd: string): PluginJob {
	mayChange(deps);
	const job: PluginJob = {
		id: randomBytes(8).toString("hex"),
		action,
		command: shown(plan.args),
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
	void serialized(() => cli(deps.bin, plan.args, cwd, plan.timeoutMs, told))
		.then(
			async () => {
				if (plan.reload) job.reloads = await reloadConversations(deps.pool).catch(() => []);
				job.state = "done";
			},
			(e: unknown) => {
				job.state = "failed";
				job.error = e instanceof Error ? e.message : String(e);
			},
		)
		.finally(() => {
			job.endedAt = Date.now();
			if (running === job) running = null;
		});
	return job;
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
				return json(await readPlugins(deps.bin, cwd, deps.home));
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
			const plan = planJob(action, body, cwd, deps.home);
			return json({ job: startJob(deps, action, plan, cwd) }, 202);
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
	}
	return fail("Not found", 404);
}

/** `/api/plugins*`: open to every page that has the token, as the Commands & terminal page's runner is. */
export async function handlePlugins(req: Request, url: URL, deps: PluginsDeps): Promise<Response> {
	try {
		return await route(req, url, deps);
	} catch (e) {
		if (e instanceof PluginsError) return fail(e.message, e.status);
		return fail(e instanceof Error ? e.message : String(e), 500);
	}
}
