import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, readFile, readlink, stat as statFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import type { MigrateCategoryId, MigrateLeftOut, MigrateLeftOutReason } from "../../shared/migrate.ts";
import { countSecrets, type RedactFormat } from "./secrets.ts";
import { loginBytes } from "./sqlite.ts";

/**
 * Where everything that moves lives, on this machine and in the archive.
 *
 * The archive has one folder per place on disk:
 * - `agent/`: omp's agent directory (`PI_CODING_AGENT_DIR`, `~/.omp/agent`)
 * - `profiles/<name>/agent/`: the agent directory of a `--profile` (same layout)
 * - `omp/`: what omp keeps in `~/.omp` outside the agent directory (the plugins)
 * - `webui/`: this app's data directory
 * - `sessiondirs/<n>/`: a folder a conversation was started in with `--session-dir`
 * - `home/`: files under the home folder that belong to a login (`.cloudflared`)
 * What each file is for (its category) and how it is carried (its kind) follows from where it is.
 */

export interface Locations {
	home: string;
	/** The home folder with links resolved (omp records the folders it ran in that way); `home` when it has none. */
	homeReal?: string;
	agentDir: string;
	dataDir: string;
	/** The folders conversations were started in with `--session-dir` (absolute). */
	sessionDirs: string[];
}

export const configRootOf = (home: string): string => join(home, ".omp");

/** A file of a memory bank: the folder up to the bank's name (with `profiles/<name>/` for a profile's), the bank's name, and the file under it. */
export const MEMORY_BANK = /^((?:profiles\/[^/]+\/)?agent\/memories\/mnemopi\/banks\/)([^/]+)\/(.+)$/;

/** Whether `bank` (a folder's name under `memories/mnemopi/banks`) is the one omp makes for working in `folder`: its name and a hash of its path. */
export function bankIsOf(bank: string, folder: string): boolean {
	const dash = bank.lastIndexOf("-");
	const name = bank.slice(0, dash);
	const base = basename(folder);
	return (
		(base === name || base.replace(/[^A-Za-z0-9._-]+/g, "-") === name) &&
		Bun.hash(folder).toString(36) === bank.slice(dash + 1)
	);
}

/**
 * How a file is carried:
 * - `file`: its bytes (a transcript is cut at its last complete line)
 * - `sqlite`: a consistent snapshot of a database, never the file
 * - `config`: a configuration file, read as text (its home paths are rewritten, its secret values handled)
 * - `symlink`: a link, by its target
 * - `auth`: the logins of `agent.db` (only into the encrypted part)
 * - `secret`: a file that is a secret as a whole (only into the encrypted part)
 */
export type ItemKind = "file" | "sqlite" | "config" | "symlink" | "auth" | "secret";

export interface Item {
	/** The path in the archive. */
	path: string;
	/** Where it is on disk. */
	source: string;
	category: MigrateCategoryId;
	/**
	 * For a file that is a secret by its name (a `.env`, a key) and so is in `credentials`: the category of the folder it lies
	 * in. It travels only when that one is chosen too (the logins asked for are not a way to carry a skill's files that were left out).
	 */
	origin?: MigrateCategoryId;
	kind: ItemKind;
	size: number;
	mode: number;
	mtimeMs: number;
	/** A link's target as written. */
	target?: string;
	format?: RedactFormat;
}

/**
 * Where on the machine something that is left out lies. An export that draws on none of the categories that live there does
 * not say that it leaves it out: `agent` is omp's agent directory (and its profiles'), `omp` what omp keeps beside it
 * (`~/.omp`), `webui` this app's data folder, `sessions` the `--session-dir` folders.
 */
export type LeftOutArea = "agent" | "omp" | "webui" | "sessions";

const AREA_CATEGORIES: Record<LeftOutArea, readonly MigrateCategoryId[]> = {
	agent: ["conversations", "history", "memories", "settings", "customization"],
	omp: ["plugins"],
	webui: ["webui"],
	sessions: ["conversations"],
};

export interface LeftOutItem extends MigrateLeftOut {
	area: LeftOutArea;
}

/** What the page and the manifest are told is left out: only what lies where `held` draws from (all of it without `held`), without the area. */
export function leftOutOf(items: readonly LeftOutItem[], held?: ReadonlySet<MigrateCategoryId>): MigrateLeftOut[] {
	return items
		.filter((l) => held === undefined || AREA_CATEGORIES[l.area].some((c) => held.has(c)))
		.map(({ path, reason, bytes }) => ({ path, reason, bytes }));
}

export interface Inventory {
	items: Item[];
	leftOut: LeftOutItem[];
	sessionDirs: { index: number; dir: string }[];
	profiles: string[];
	/** Configuration files with secret values in them, how many, and the category each is in. */
	secretFiles: { path: string; source: string; values: number; category: MigrateCategoryId }[];
}

/** The archive path of `parts` joined (always with `/`). */
const join2 = (...parts: string[]): string => parts.filter(Boolean).join("/");

/** `~` for the home folder in a path shown to the person. */
export function tilde(path: string, home: string): string {
	return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

const CONFIG_FORMATS: Record<string, RedactFormat> = {
	".json": "json",
	".yml": "yaml",
	".yaml": "yaml",
};

function formatOf(name: string): RedactFormat | undefined {
	const dot = name.lastIndexOf(".");
	return dot < 0 ? undefined : CONFIG_FORMATS[name.slice(dot)];
}

/** What a file in an agent directory is, by its name. `null`: not placed (the caller says why it is left out). */
type Placement =
	| { category: MigrateCategoryId; kind: ItemKind; format?: RedactFormat }
	| { left: MigrateLeftOutReason }
	| "ignore";

const AGENT_CONFIG = new Set([
	"config.yml",
	"config.yaml",
	"models.yml",
	"models.yaml",
	"mcp.json",
	".mcp.json",
	"lsp.json",
	"settings.json",
]);
const AGENT_CUSTOM_DIRS = new Set([
	"skills",
	"managed-skills",
	"agents",
	"commands",
	"rules",
	"prompts",
	"instructions",
	"hooks",
	"tools",
	"extensions",
	"themes",
]);
/** A name omp (or SQLite) makes beside the thing itself: not data. */
const SIDECAR = /(\.lock|-wal|-shm|-journal|\.sync\.lock)$|\.reset-[0-9a-f]+\.lock$/;

function placeAgent(name: string, isDir: boolean): Placement {
	if (SIDECAR.test(name)) return "ignore";
	if (isDir) {
		if (name === "sessions" || name === "blobs") return { category: "conversations", kind: "file" };
		if (name === "memories") return { category: "memories", kind: "file" };
		if (name === "predict") return { category: "history", kind: "file" };
		if (AGENT_CUSTOM_DIRS.has(name)) return { category: "customization", kind: "file" };
		if (name === "cache") return { left: "cache" };
		if (name === "terminal-sessions") return { left: "machine" };
		return { left: "unknown" };
	}
	if (name === "session-pins.json") return { category: "conversations", kind: "config", format: "json" };
	if (name === "history.db") return { category: "history", kind: "sqlite" };
	if (name === "agent.db") return { category: "credentials", kind: "auth" };
	if (name === "secrets.yml" || name === "secret-placeholder.key") return { category: "credentials", kind: "secret" };
	if (AGENT_CONFIG.has(name)) return { category: "settings", kind: "config", format: formatOf(name) };
	if (/^keybindings\.[A-Za-z]+$/.test(name)) return { category: "settings", kind: "config", format: "text" };
	// AGENTS.md, RULES.md, SYSTEM.md, SYSTEM_TEMPLATE.md, APPEND_SYSTEM.md, TITLE_SYSTEM.md …: what the user wrote for omp.
	if (/^[A-Za-z0-9_-]+\.md$/.test(name)) return { category: "settings", kind: "config", format: "text" };
	if (name === "models.db" || name === "skill-descriptions.db") return { left: "rebuilt" };
	if (name === "last-changelog-version") return { left: "machine" };
	return { left: "unknown" };
}

const DATA_FILES = new Set([
	"ui-prefs.json",
	"favorite-models.json",
	"archived.json",
	"project-groups.json",
	"approval.json",
	"guard.json",
	"session-roots.json",
	"mode.json",
	"interviews.json",
	"remote.json",
	// The model guidance of #641: the templates the person saved, and what each conversation was given of them. Both travel,
	// so that a conversation opened on the new computer carries the same standing instructions.
	"model-guidance.json",
	"model-guidance-sessions.json",
	// Unattended mode of #646: the conversations it is on for and the instruction the person set, and the questions the agents filed
	// for them. Both travel, so that the list of what waits for the person is the same on the new computer.
	"unattended.json",
	"questions.json",
	// The quota floors of #652 (the share of a usage window that may be left before the work is held, by provider): the person's own.
	"quota-floor.json",
]);

function placeData(name: string, isDir: boolean): Placement {
	if (SIDECAR.test(name) || /\.(tmp|new|damaged|broken)$/.test(name)) return "ignore";
	if (!isDir && DATA_FILES.has(name)) return { category: "webui", kind: "config", format: "json" };
	if (name === "index.db") return { left: "rebuilt" };
	// The Web Push key signs for this server and the subscriptions were made against it (and by this computer's browsers): neither
	// moves. Nor does the list of other Macs (#628): its `storeId`s name this computer's own WebKit sign-in stores, which the app
	// made here and which an archive cannot carry.
	if (
		name === "token" ||
		name === "omp.json" ||
		name === "server.pid" ||
		name === "push-vapid.json" ||
		name === "push-devices.json" ||
		name === "remote-macs.json" ||
		/^cloudflared\./.test(name)
	)
		return { left: "machine" };
	if (["relay", "parked", "omp-job", "migrate", "btw-fork"].includes(name) || name === "omp-overlay.yml")
		return { left: "runtime" };
	if (["exports", "offline-agent", "context-measure.json"].includes(name)) return { left: "cache" };
	if (name === "migration-backups" || name === "memory-backups") return { left: "runtime" };
	return { left: "unknown" };
}

function placeConfigRoot(name: string, isDir: boolean): Placement {
	if (SIDECAR.test(name)) return "ignore";
	if (name === "marketplaces.json") return { category: "plugins", kind: "config", format: "json" };
	if (name === "plugins" && isDir) return { category: "plugins", kind: "file" };
	if (name === "agent" || name === "profiles") return "ignore";
	if (["cache", "gpu_cache.json"].includes(name)) return { left: "cache" };
	if (["natives", "logs", "bin", "browser-profiles", "puppeteer", "ssh-control", "run"].includes(name))
		return { left: "runtime" };
	if (name === "install-id" || name === "remote-host") return { left: "machine" };
	if (/^(stats|autoqa)\.db/.test(name)) return { left: "rebuilt" };
	if (name === "skill-repos") return { left: "redownload" };
	return { left: "unknown" };
}

/** Plugin files: the registry, the installed plugins and their links; the marketplace catalogues are downloaded again. */
function placePlugin(rel: string, isDir: boolean): Placement | "descend" {
	const [first, second] = rel.split("/");
	if (rel === first && !isDir) {
		if (first === "installed_plugins.json" || first === "omp-plugins.lock.json")
			return { category: "plugins", kind: "config", format: "json" };
		return { left: "unknown" };
	}
	if (first === "node_modules") return "descend";
	if (first === "data") return "descend";
	if (first === "cache") {
		if (second === "marketplaces") return { left: "redownload" };
		if (second === "plugins") return "descend";
		return { left: "cache" };
	}
	return { left: "unknown" };
}

/**
 * Files whose name says they hold a secret: `.env` files, keys and certificates, a credentials file. They are listed in the
 * plan and left out of an archive made without credentials, whatever folder of omp's they are in; with credentials they
 * travel in the encrypted part.
 */
const SECRET_FILE: RegExp[] = [
	/^\.env(\..+)?$/i,
	/\.env$/i,
	/^\.(npmrc|netrc|pypirc|git-credentials|pgpass|htpasswd)$/i,
	/\.(pem|key|p12|pfx|jks|keystore|ppk|gpg)$/i,
	/^id_(rsa|dsa|ecdsa|ed25519)$/i,
	/^(credentials?|secrets?|service-account.*|auth|tokens?)\.(json|ya?ml|toml|ini|txt)$/i,
];

export function isSecretFileName(name: string): boolean {
	return SECRET_FILE.some((re) => re.test(name));
}

/** What an archive path is for: its category, and how it is carried. */
export interface PathPlacement {
	category: MigrateCategoryId;
	/** For a file that is a secret by its name (so its category is `credentials`): the category of the folder it lies in. */
	origin?: MigrateCategoryId;
	kind: ItemKind;
}

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** A segment of a path in an archive: a name, not a way to walk. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
const SANE_SEGMENT = /^(?!\.{1,2}$)[^/\\\u0000-\u001f]+$/;

function carried(placed: Placement | "descend" | undefined): PathPlacement | null {
	if (placed === "descend") return { category: "plugins", kind: "file" };
	if (!placed || placed === "ignore" || "left" in placed) return null;
	return { category: placed.category, kind: placed.kind };
}

function underAgent(rest: string[]): PathPlacement | null {
	const [first, ...tail] = rest;
	if (first === undefined) return null;
	const placed = carried(placeAgent(first, tail.length > 0));
	if (!placed) return null;
	if (placed.category === "memories" && /\.db$/.test(rest[rest.length - 1])) return { ...placed, kind: "sqlite" };
	return placed;
}

/**
 * What the exporter would have made of an archive path: the one rule for what an import accepts. A path the exporter's own
 * `place*` functions would not carry (a cache, a file of the machine, a place outside omp's and this app's folders) is
 * none, whatever the manifest says. The `--session-dir` index is checked by the caller against the manifest's list.
 */
export function placementOf(path: string): PathPlacement | null {
	const parts = path.split("/");
	if (!parts.every((p) => SANE_SEGMENT.test(p))) return null;
	const last = parts[parts.length - 1];
	if (SIDECAR.test(last)) return null;
	const [head, ...rest] = parts;
	let placed: PathPlacement | null;
	switch (head) {
		case "agent":
			placed = underAgent(rest);
			break;
		case "profiles": {
			const [name, agent, ...more] = rest;
			placed = name !== undefined && PROFILE_NAME.test(name) && agent === "agent" ? underAgent(more) : null;
			break;
		}
		case "omp": {
			const [first, ...tail] = rest;
			if (first === undefined) return null;
			if (tail.length === 0) placed = carried(placeConfigRoot(first, false));
			else placed = first === "plugins" ? carried(placePlugin(tail.join("/"), false)) : null;
			break;
		}
		case "webui":
			placed = rest.length === 1 ? carried(placeData(rest[0], false)) : null;
			break;
		case "sessiondirs":
			placed =
				rest.length >= 2 && /^(0|[1-9]\d{0,5})$/.test(rest[0]) ? { category: "conversations", kind: "file" } : null;
			break;
		default:
			return null;
	}
	// A secret by its name is a login whatever folder it lies in; the folder's own category is still the one that has to be chosen for it to travel.
	if (placed && placed.kind === "file" && isSecretFileName(last)) {
		return { category: "credentials", kind: "secret", origin: placed.category };
	}
	return placed;
}

/** Whether `path` is where a link to an installed plugin is made: `node_modules/<name>` or `node_modules/@scope/<name>`. */
export const PLUGIN_LINK = /^omp\/plugins\/node_modules\/(?:@[^/]+\/)?[^/@][^/]*$/;

/** A conversation's own transcript, or one beside it (a subagent's, an advisor's): a file of lines that is cut at a complete one. */
export const TRANSCRIPT_PATH = /(?:^|\/)sessions\/.+\.jsonl$|^sessiondirs\/\d+\/.+\.jsonl$/;

interface Walked {
	rel: string;
	full: string;
	stat: Stats;
	link: string | null;
}

/** Every file (and link) under `dir`, links not followed. Errors on one entry skip it; `onError` hears of them. */
async function* walk(dir: string, rel = "", onError?: (path: string, error: Error) => void): AsyncGenerator<Walked> {
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") onError?.(dir, e as Error);
		return;
	}
	entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	for (const entry of entries) {
		const full = join(dir, entry.name);
		const r = rel ? `${rel}/${entry.name}` : entry.name;
		let stat: Stats;
		try {
			stat = await lstat(full);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") onError?.(full, e as Error);
			continue;
		}
		if (stat.isSymbolicLink()) {
			try {
				yield { rel: r, full, stat, link: await readlink(full) };
			} catch (e) {
				onError?.(full, e as Error);
			}
		} else if (stat.isDirectory()) {
			yield* walk(full, r, onError);
		} else if (stat.isFile()) {
			yield { rel: r, full, stat, link: null };
		}
	}
}

/** Bytes and file count of everything under `path` (for what is left out). */
async function sizeOf(path: string, stat?: Stats): Promise<number> {
	try {
		const st = stat ?? (await lstat(path));
		if (!st.isDirectory()) return st.size;
	} catch {
		return 0;
	}
	let total = 0;
	for await (const f of walk(path)) total += f.stat.size;
	return total;
}

async function statFollow(path: string): Promise<Stats | null> {
	try {
		return await statFile(path);
	} catch {
		return null;
	}
}

/** One agent directory's items, put under `prefix` in the archive. */
async function agentItems(
	agentDir: string,
	prefix: string,
	inv: Inventory,
	home: string,
	onError: (path: string, error: Error) => void,
): Promise<void> {
	let top: Dirent[];
	try {
		top = await readdir(agentDir, { withFileTypes: true });
	} catch {
		return;
	}
	const bankLeft = new Map<string, number>();
	for (const entry of top) {
		const full = join(agentDir, entry.name);
		const stat = await lstat(full).catch(() => null);
		if (!stat) continue;
		// A folder of omp's that is a link to somewhere else (a dotfiles repository) is the folder it links to.
		const isDir = stat.isDirectory() || (stat.isSymbolicLink() && (await statFollow(full))?.isDirectory() === true);
		const placed = placeAgent(entry.name, isDir);
		if (placed === "ignore") continue;
		if ("left" in placed) {
			inv.leftOut.push({
				path: tilde(full, home),
				reason: placed.left,
				bytes: await sizeOf(full, stat),
				area: "agent",
			});
			continue;
		}
		if (!isDir) {
			inv.items.push(itemOf(join2(prefix, entry.name), full, stat, placed, null));
			continue;
		}
		for await (const f of walk(full, "", onError)) {
			const rel = `${entry.name}/${f.rel}`;
			if (SIDECAR.test(basename(f.rel))) continue;
			// A link inside such a folder points at something this archive does not hold: it is told, not carried.
			if (f.link !== null) {
				inv.leftOut.push({ path: tilde(f.full, home), reason: "machine", bytes: 0, area: "agent" });
				continue;
			}
			// The scratch banks of this app's own helper conversations (the context probe, Light mode): not memories.
			const bank = /^memories\/mnemopi\/banks\/(ompw-[^/]+)\//.exec(rel);
			if (bank) {
				const where = tilde(join(agentDir, "memories", "mnemopi", "banks", bank[1]), home);
				bankLeft.set(where, (bankLeft.get(where) ?? 0) + f.stat.size);
				continue;
			}
			const kind: ItemKind = placed.category === "memories" && /\.db$/.test(f.rel) ? "sqlite" : placed.kind;
			inv.items.push(itemOf(join2(prefix, rel), f.full, f.stat, { ...placed, kind }, f.link));
		}
	}
	for (const [path, bytes] of bankLeft) inv.leftOut.push({ path, reason: "cache", bytes, area: "agent" });
}

function itemOf(
	path: string,
	source: string,
	stat: Stats,
	placed: { category: MigrateCategoryId; kind: ItemKind; format?: RedactFormat },
	link: string | null,
): Item {
	let origin: MigrateCategoryId | undefined;
	if (link === null && placed.kind === "file" && isSecretFileName(basename(path))) {
		origin = placed.category;
		placed = { category: "credentials", kind: "secret" };
	}
	if (link !== null) {
		return {
			path,
			source,
			category: placed.category,
			kind: "symlink",
			size: 0,
			mode: 0o777,
			mtimeMs: stat.mtimeMs,
			target: link,
		};
	}
	return {
		path,
		source,
		category: placed.category,
		origin,
		kind: placed.kind,
		size: stat.size,
		mode: stat.mode & 0o777,
		mtimeMs: stat.mtimeMs,
		format: placed.format,
	};
}

/** Everything an export would carry, and what it leaves out. Reads directory entries and sizes, never file contents (but the configuration files, for their secrets). */
export async function inventory(
	loc: Locations,
	onError: (path: string, error: Error) => void = () => {},
): Promise<Inventory> {
	const inv: Inventory = { items: [], leftOut: [], sessionDirs: [], profiles: [], secretFiles: [] };
	const root = configRootOf(loc.home);

	await agentItems(loc.agentDir, "agent", inv, loc.home, onError);

	// Profiles: each one's agent directory is laid out like the main one.
	try {
		for (const p of await readdir(join(root, "profiles"), { withFileTypes: true })) {
			const dir = join(root, "profiles", p.name, "agent");
			if (!p.isDirectory() || !(await lstat(dir).catch(() => null))?.isDirectory()) continue;
			inv.profiles.push(p.name);
			await agentItems(dir, join2("profiles", p.name, "agent"), inv, loc.home, onError);
		}
	} catch {
		// no profiles
	}

	// What omp keeps beside the agent directory.
	try {
		for (const entry of await readdir(root, { withFileTypes: true })) {
			const full = join(root, entry.name);
			const stat = await lstat(full).catch(() => null);
			if (!stat) continue;
			const placed = placeConfigRoot(entry.name, stat.isDirectory());
			if (placed === "ignore") continue;
			if ("left" in placed) {
				// `agent` is the agent directory itself when it is somewhere else: nothing is left out for it.
				inv.leftOut.push({
					path: tilde(full, loc.home),
					reason: placed.left,
					bytes: await sizeOf(full, stat),
					area: "omp",
				});
				continue;
			}
			if (!stat.isDirectory()) {
				inv.items.push(itemOf(join2("omp", entry.name), full, stat, placed, null));
				continue;
			}
			const pluginRoots = [join(root, "plugins"), join(loc.homeReal ?? loc.home, ".omp", "plugins")];
			const note = (path: string, reason: MigrateLeftOutReason, bytes: number): void => {
				const found = inv.leftOut.find((l) => l.path === path);
				if (found) found.bytes += bytes;
				else inv.leftOut.push({ path, reason, bytes, area: "omp" });
			};
			for await (const f of walk(full, "", onError)) {
				const verdict = placePlugin(f.rel, false);
				if (verdict === "ignore") continue;
				if (verdict === "descend") {
					const where = join2("omp", entry.name, f.rel);
					if (f.rel.startsWith("node_modules/")) {
						// A plugin is linked in from its folder in the cache; a link to anywhere else is a plugin of this
						// machine's (`omp plugin link`), and a package npm put here is downloaded again.
						const target = f.link === null ? null : resolve(dirname(f.full), f.link);
						if (target !== null && pluginRoots.some((r) => target.startsWith(`${r}/`))) {
							inv.items.push({
								path: where,
								source: f.full,
								category: "plugins",
								kind: "symlink",
								size: 0,
								mode: 0o777,
								mtimeMs: f.stat.mtimeMs,
								target,
							});
						} else if (f.link !== null) {
							note(tilde(f.full, loc.home), "machine", 0);
						} else {
							note(tilde(join(full, f.rel.split("/").slice(0, 2).join("/")), loc.home), "redownload", f.stat.size);
						}
					} else if (f.link !== null) {
						note(tilde(f.full, loc.home), "machine", 0);
					} else {
						inv.items.push(itemOf(where, f.full, f.stat, { category: "plugins", kind: "file" }, null));
					}
				} else if ("left" in verdict) {
					const where = tilde(
						join(
							full,
							f.rel
								.split("/")
								.slice(0, f.rel.startsWith("cache/") ? 2 : 1)
								.join("/"),
						),
						loc.home,
					);
					note(where, verdict.left, f.stat.size);
				} else {
					inv.items.push(itemOf(join2("omp", entry.name, f.rel), f.full, f.stat, verdict, f.link));
				}
			}
		}
	} catch {
		// no ~/.omp
	}

	// This app's own data.
	try {
		for (const entry of await readdir(loc.dataDir, { withFileTypes: true })) {
			const full = join(loc.dataDir, entry.name);
			const stat = await lstat(full).catch(() => null);
			if (!stat) continue;
			const placed = placeData(entry.name, stat.isDirectory());
			if (placed === "ignore") continue;
			if ("left" in placed) {
				inv.leftOut.push({
					path: tilde(full, loc.home),
					reason: placed.left,
					bytes: await sizeOf(full, stat),
					area: "webui",
				});
				continue;
			}
			inv.items.push(itemOf(join2("webui", entry.name), full, stat, placed, null));
		}
	} catch {
		// no data dir yet
	}

	// Folders conversations were started in with `--session-dir`.
	for (const dir of loc.sessionDirs) {
		if (!(await lstat(dir).catch(() => null))?.isDirectory()) continue;
		// A folder that is the agent directory's own sessions would be carried twice.
		if (resolve(dir) === resolve(loc.agentDir, "sessions")) continue;
		const index = inv.sessionDirs.length;
		inv.sessionDirs.push({ index, dir });
		for await (const f of walk(dir, "", onError)) {
			if (f.link !== null) {
				inv.leftOut.push({ path: tilde(f.full, loc.home), reason: "machine", bytes: 0, area: "sessions" });
				continue;
			}
			inv.items.push(
				itemOf(
					join2("sessiondirs", String(index), f.rel),
					f.full,
					f.stat,
					{ category: "conversations", kind: "file" },
					f.link,
				),
			);
		}
	}

	// A login of the remote access tunnel.
	const cloudflared = join(loc.home, ".cloudflared");
	const tunnel = await tunnelId(loc.dataDir);
	for (const name of ["cert.pem", tunnel ? `${tunnel}.json` : ""]) {
		if (!name) continue;
		const full = join(cloudflared, name);
		const stat = await lstat(full).catch(() => null);
		if (stat?.isFile())
			inv.items.push(
				itemOf(join2("home", ".cloudflared", name), full, stat, { category: "credentials", kind: "secret" }, null),
			);
	}

	// What goes in the archive of a login database is its logins, not the usage records beside them.
	for (const item of inv.items) if (item.kind === "auth") item.size = loginBytes(item.source);
	inv.items.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	inv.leftOut.sort((a, b) => (a.path < b.path ? -1 : 1));

	// Configuration files with secret values in them.
	for (const item of inv.items) {
		if (item.kind !== "config" || !item.format || item.size > 4 * 1024 * 1024) continue;
		const text = await readFile(item.source, "utf8").catch(() => null);
		if (text === null) continue;
		const values = countSecrets(text, item.format);
		if (values > 0) inv.secretFiles.push({ path: item.path, source: item.source, values, category: item.category });
	}
	return inv;
}

/** The id of the tunnel remote access set up, if it did (its credentials file is named after it). */
async function tunnelId(dataDir: string): Promise<string | null> {
	try {
		const settings: unknown = JSON.parse(await readFile(join(dataDir, "remote.json"), "utf8"));
		const id = isRecord(settings) ? settings.tunnelId : null;
		return typeof id === "string" && /^[0-9a-f-]{36}$/.test(id) ? id : null;
	} catch {
		return null;
	}
}

/**
 * Where an archive path goes on this machine; null for one that names no place of ours. What an import writes is only what
 * the exporter's own rules would have carried (`placementOf`), and only in the folders below: omp's agent directory and its
 * profiles', the plugins' folder, this app's data folder, and the `--session-dir` folders `sessionDirs` names.
 */
export function destinationOf(path: string, loc: Locations, sessionDirs: ReadonlyMap<number, string>): string | null {
	if (placementOf(path) === null) return null;
	const [head, ...rest] = path.split("/");
	const root = configRootOf(loc.home);
	switch (head) {
		case "agent":
			return inside(loc.agentDir, rest);
		case "profiles": {
			const [name, , ...more] = rest;
			return inside(join(root, "profiles", name, "agent"), more);
		}
		case "omp":
			return inside(root, rest);
		case "webui":
			return inside(loc.dataDir, rest);
		case "sessiondirs": {
			const [index, ...more] = rest;
			const dir = sessionDirs.get(Number(index));
			return dir ? inside(dir, more) : null;
		}
		default:
			return null;
	}
}

/** The tunnel's two files, which only the encrypted part may hold. */
const CLOUDFLARED =
	/^home\/\.cloudflared\/(?:cert\.pem|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json)$/;

/**
 * Where a file of the encrypted part goes: a login database, a secret file, or a configuration file that could not be
 * cleaned of its secrets, each in the place the exporter takes it from; or one of the tunnel's two files. Anything else is
 * none: the part is as little to be trusted as the manifest.
 */
export function bundleDestination(
	path: string,
	kind: "auth" | "secret" | "config",
	loc: Locations,
	sessionDirs: ReadonlyMap<number, string>,
): string | null {
	if (CLOUDFLARED.test(path)) return kind === "secret" ? join(loc.home, ".cloudflared", path.split("/")[2]) : null;
	const placed = placementOf(path);
	if (placed === null) return null;
	if (kind === "config" ? placed.kind === "auth" || placed.kind === "secret" : placed.kind !== kind) return null;
	return destinationOf(path, loc, sessionDirs);
}

function inside(base: string, parts: string[]): string | null {
	if (parts.length === 0) return null;
	const full = resolve(base, ...parts);
	return full.startsWith(base + sep) ? full : null;
}
