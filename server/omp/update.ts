import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { InstallMethod, OmpRelease } from "../../shared/omp-install.ts";
import { NPM_PACKAGE } from "./install.ts";
import { QUICK_MS, run } from "./run.ts";

/**
 * Which omp release is the latest, looked up the way `omp update` itself looks it up (`getLatestRelease` and
 * `fetchBuild` in omp's `cli/update-cli.ts` and `cli/build-service.ts`), on the channel omp's `update.channel`
 * setting names (`stable`, or `canary`):
 *
 * - a package-manager install (Homebrew, bun, npm, mise, Nix) asks the npm registry for the `latest` dist-tag of
 *   `@oh-my-pi/pi-coding-agent` (`canary` on the canary channel), at the registry the user's own `.npmrc`,
 *   `bunfig.toml` and environment name;
 * - omp's standalone binary asks omp's build service for the newest build of that channel for this platform
 *   (`PI_BUILD_URL` moves it, as it does for omp).
 *
 * Only the lookup is repeated here. Installing is `omp update`'s job (see `OmpLifecycle`): it alone knows how to
 * move each kind of install to a release.
 */

export type UpdateChannel = "stable" | "canary";

type Env = Record<string, string | undefined>;
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org/";
export const DEFAULT_BUILD_URL = "https://build.stencil.so";
const LOOKUP_TIMEOUT_MS = 30_000;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * The channel omp's own `update.channel` says, as `omp config get` prints it, read in `cwd` with the environment
 * `base` — where `omp update` will run, since that is where it reads the setting. omp takes a value it does not know,
 * or a setting it cannot read, for `stable`, and so does this.
 */
export async function configuredUpdateChannel(
	bin: string,
	cwd: string,
	base: Env,
	timeoutMs = QUICK_MS,
): Promise<UpdateChannel> {
	try {
		const ran = await run([bin, "config", "get", "update.channel"], { cwd, base, timeoutMs });
		return ran.code === 0 && ran.stdout.trim().replace(/^"|"$/g, "") === "canary" ? "canary" : "stable";
	} catch {
		return "stable";
	}
}

/** omp's release notes for a version, on GitHub (every release tag `vX.Y.Z` has one). */
export function changelogUrl(version: string): string {
	return `https://github.com/can1357/oh-my-pi/releases/tag/v${version}`;
}

// ------------------------------------------------------------------ the npm registry

interface Registry {
	url: string;
	authorization?: string;
}

/** A registry setting and where it was read: what an error names, so a bad one can be found without printing a credential. */
interface RegistryEntry {
	url: string;
	source: string;
	/** Credentials attached to the entry itself (bunfig `token`, or `username` and `password`). */
	authorization?: string;
}

/** `.npmrc`: `key = value` lines, `;` and `#` comments, `${VAR}` filled from the environment (see `expandNpmrcEnv`). */
export function parseNpmrc(text: string, env: Env, source = ".npmrc"): Map<string, string> {
	const config = new Map<string, string>();
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith(";") || line.startsWith("#") || line.startsWith("[")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = expandNpmrcEnv(line.slice(0, eq).trim(), env, source);
		let value = line.slice(eq + 1).trim();
		if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0])
			value = value.slice(1, -1);
		config.set(key, expandNpmrcEnv(value, env, source));
	}
	return config;
}

/**
 * npm's rules for `${VAR}`: it must be set, or the config is an error (npm and `omp update` both stop there);
 * `${VAR?}` is empty when it is not; `\${` stays as written. The error names the variable and the file, never a value.
 */
function expandNpmrcEnv(value: string, env: Env, source: string): string {
	return value.replace(/(\\*)\$\{([^${}?]+)(\?)?\}/g, (match, slashes: string, name: string, optional?: string) => {
		if (slashes.length % 2 === 1) return match.slice(1);
		const resolved = envLookup(env, name);
		if (resolved !== undefined) return slashes + resolved;
		if (optional) return slashes;
		throw new Error(`Failed to replace env in config: \${${name}} (${source})`);
	});
}

/** npm reads `npm_config_*` names case-insensitively; an exact match wins. */
function envLookup(env: Env, name: string): string | undefined {
	if (env[name]) return env[name];
	const lower = name.toLowerCase();
	for (const [key, value] of Object.entries(env)) if (value && key.toLowerCase() === lower) return value;
	return undefined;
}

/** A config file that usually does not exist: absent is `undefined`; one that cannot be read is an error, as in omp. */
function readOptional(file: string): string | undefined {
	try {
		return readFileSync(file, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw e;
	}
}

/** bunfig expands `$VAR` and `${VAR}` in its strings; an unset variable is empty. */
function expandBunfigEnv(value: string, env: Env): string {
	return value.replace(
		/\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g,
		(_m, a?: string, b?: string) => envLookup(env, (a ?? b) as string) ?? "",
	);
}

/** A bunfig registry is a URL, `{ url, token }` or `{ url, username, password }`; the credentials become its `authorization`. */
function bunfigEntry(value: unknown, env: Env, source: string): RegistryEntry | undefined {
	if (typeof value === "string") return value ? { url: expandBunfigEnv(value, env), source } : undefined;
	const o = record(value);
	if (!o || typeof o.url !== "string") return undefined;
	const entry: RegistryEntry = { url: expandBunfigEnv(o.url, env), source };
	if (typeof o.token === "string" && o.token) {
		entry.authorization = `Bearer ${expandBunfigEnv(o.token, env)}`;
	} else if (typeof o.username === "string" && typeof o.password === "string") {
		entry.authorization = `Basic ${btoa(`${expandBunfigEnv(o.username, env)}:${expandBunfigEnv(o.password, env)}`)}`;
	}
	return entry;
}

/** The global `bunfig.toml`'s `install.registry` and `install.scopes`. One that cannot be parsed is an error, as in omp. */
function readBunfig(env: Env, home: string): { registry?: RegistryEntry; scopes: Map<string, RegistryEntry> } {
	const xdg = envLookup(env, "XDG_CONFIG_HOME");
	for (const file of [xdg ? join(xdg, ".bunfig.toml") : null, join(home, ".bunfig.toml")]) {
		const text = file ? readOptional(file) : undefined;
		if (file === null || text === undefined) continue;
		let parsed: unknown;
		try {
			parsed = Bun.TOML.parse(text);
		} catch (e) {
			throw new Error(`Failed to parse ${file}: ${(e as Error).message}`);
		}
		const install = record(record(parsed)?.install);
		const scopes = new Map<string, RegistryEntry>();
		for (const [name, value] of Object.entries(record(install?.scopes) ?? {})) {
			const entry = bunfigEntry(value, env, file);
			if (entry) scopes.set(name.startsWith("@") ? name : `@${name}`, entry);
		}
		return { registry: install ? bunfigEntry(install.registry, env, file) : undefined, scopes };
	}
	return { scopes: new Map() };
}

/**
 * npm's credential lookup: `//host/path/:_authToken`, `:_auth`, or `:username` with `:_password` (base64, as npm
 * writes it), walking up the path of the registry's URL so a token for `//host/` also covers `//host/npm/feed/`.
 */
function npmrcAuthorization(npmrc: Map<string, string>, url: URL): string | undefined {
	const segments = url.pathname.split("/").filter(Boolean);
	for (let n = segments.length; n >= 0; n--) {
		const prefix = `//${url.host}/${segments
			.slice(0, n)
			.map((s) => `${s}/`)
			.join("")}`;
		const token = npmrc.get(`${prefix}:_authToken`);
		if (token) return `Bearer ${token}`;
		const basic = npmrc.get(`${prefix}:_auth`);
		if (basic) return `Basic ${basic}`;
		const username = npmrc.get(`${prefix}:username`);
		const password = npmrc.get(`${prefix}:_password`);
		if (username && password) {
			let plain: string;
			try {
				plain = atob(password);
			} catch {
				throw new Error(`The _password of ${prefix} in .npmrc is not base64-encoded`);
			}
			return `Basic ${btoa(`${username}:${plain}`)}`;
		}
	}
	return undefined;
}

/**
 * The registry that serves `pkg`, by omp's order: a registry set for the package's scope (`.npmrc`, then
 * `bunfig.toml`); else the environment (`npm_config_registry`, `BUN_CONFIG_REGISTRY`); else `registry` in
 * `.npmrc`; else `install.registry` in `bunfig.toml`; else npmjs. Credentials are omp's too: those of the bunfig
 * entry, else the ones in the URL, else the `.npmrc` ones for its host. Project-level config is not read, as omp
 * does not: an update changes the global install, whatever folder the app was started in. Whatever is wrong in
 * the config throws, as it does for `omp update`; the message names the file, never a credential.
 */
export function registryFor(pkg: string, env: Env = process.env, home: string = homedir()): Registry {
	const npmrcPath = envLookup(env, "npm_config_userconfig") ?? join(home, ".npmrc");
	const npmrcText = readOptional(npmrcPath);
	const npmrc = npmrcText === undefined ? new Map<string, string>() : parseNpmrc(npmrcText, env, npmrcPath);
	const bunfig = readBunfig(env, home);
	const scope = pkg.startsWith("@") ? pkg.slice(0, pkg.indexOf("/")) : undefined;
	const named = (url: string | undefined, source: string): RegistryEntry | undefined =>
		url ? { url, source } : undefined;
	const entry: RegistryEntry = (scope
		? (named(npmrc.get(`${scope}:registry`), npmrcPath) ?? bunfig.scopes.get(scope))
		: undefined) ??
		named(envLookup(env, "npm_config_registry") ?? envLookup(env, "BUN_CONFIG_REGISTRY"), "environment") ??
		named(npmrc.get("registry"), npmrcPath) ??
		bunfig.registry ?? { url: DEFAULT_NPM_REGISTRY, source: "default" };
	let url: URL;
	try {
		url = new URL(entry.url);
	} catch {
		// `https://user:pw@host` in a message goes without its credentials.
		throw new Error(`Invalid npm registry URL "${entry.url.replace(/\/\/[^/?#\s]*@/, "//")}" (from ${entry.source})`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error(`Unsupported npm registry protocol "${url.protocol}" (from ${entry.source}); expected http(s)`);
	}
	if (!url.pathname.endsWith("/")) url.pathname += "/";
	let authorization = entry.authorization;
	if (!authorization && url.username) {
		authorization = `Basic ${btoa(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`)}`;
	}
	url.username = "";
	url.password = "";
	return { url: url.href, authorization: authorization ?? npmrcAuthorization(npmrc, url) };
}

interface Lookup {
	fetch: Fetch;
	timeoutMs: number;
	headers: Record<string, string>;
}

async function getJson(url: string, lookup: Lookup): Promise<{ status: number; body: unknown }> {
	const res = await lookup.fetch(url, { headers: lookup.headers, signal: AbortSignal.timeout(lookup.timeoutMs) });
	const body: unknown = await res.json().catch(() => undefined);
	return { status: res.status, body };
}

function record(v: unknown): Record<string, unknown> | null {
	return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** The newest version of `pkg` on its registry for `channel`: its `latest` dist-tag, or its `canary` one. */
async function npmLatest(pkg: string, env: Env, home: string, lookup: Lookup, channel: UpdateChannel): Promise<string> {
	const registry = registryFor(pkg, env, home);
	const headers = { ...lookup.headers, ...(registry.authorization ? { authorization: registry.authorization } : {}) };
	const withAuth = { ...lookup, headers };
	const base = `${registry.url}${pkg.replace("/", "%2f")}`;
	const custom = registry.url !== DEFAULT_NPM_REGISTRY;
	const distTag = channel === "canary" ? "canary" : "latest";
	const noCanary = () => new Error(`No canary release has been published for ${pkg} yet. Try \`omp update --stable\`.`);
	const fromPackument = (packument: Record<string, unknown>): string | undefined => {
		const tag = record(packument["dist-tags"])?.[distTag];
		return typeof tag === "string" ? tag : undefined;
	};
	let { status, body } = await getJson(`${base}/${distTag}`, withAuth);
	let data = record(body);
	// Some registries answer the dist-tag shortcut with the whole packument, others do not serve it at all.
	if (data && record(data["dist-tags"])) {
		const version = fromPackument(data);
		if (version) return version;
	}
	if (!data?.version && custom && (status === 200 || [400, 404, 405].includes(status))) {
		({ status, body } = await getJson(base, withAuth));
		data = record(body);
		const version = data ? fromPackument(data) : undefined;
		if (status === 200 && version) return version;
		if (status === 200 && channel === "canary" && record(data?.["dist-tags"])) throw noCanary();
	}
	if (status === 404 && channel === "canary") throw noCanary();
	if (status < 200 || status >= 300) {
		const hint =
			status === 401 || status === 403 ? "; check the registry credentials in your .npmrc or .bunfig.toml" : "";
		throw new Error(`Failed to fetch release info for ${pkg} from ${registry.url}: HTTP ${status}${hint}`);
	}
	if (typeof data?.version !== "string")
		throw new Error(`Malformed npm registry response for ${pkg} from ${registry.url}`);
	return data.version;
}

// ------------------------------------------------------------------ the build service

/** The build service's name for this platform (`macos-arm64`, `linux-x86_64`, `linux-musl-arm64`). */
export function buildTarget(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
	musl = false,
): string {
	const os =
		platform === "darwin"
			? "macos"
			: platform === "linux"
				? musl
					? "linux-musl"
					: "linux"
				: platform === "win32"
					? "windows"
					: null;
	const cpu = arch === "x64" ? "x86_64" : arch === "arm64" ? "arm64" : null;
	if (!os || !cpu) throw new Error(`Unsupported platform: ${platform} ${arch}`);
	return `${os}-${cpu}`;
}

async function buildLatest(env: Env, lookup: Lookup, channel: UpdateChannel): Promise<string> {
	const origin = (env.PI_BUILD_URL ?? "").trim().replace(/\/+$/, "") || DEFAULT_BUILD_URL;
	const musl = process.platform === "linux" && existsSync("/etc/alpine-release");
	const target = buildTarget(process.platform, process.arch, musl);
	const url = `${origin}/api/products/omp/latest/${target}?channel=${channel}`;
	const { status, body } = await getJson(url, lookup);
	if (status === 404 && record(body)?.error === "no_build") {
		const back = channel === "canary" ? " Try `omp update --stable`." : "";
		throw new Error(`No omp build is published on ${origin} for ${target} yet.${back}`);
	}
	if (status < 200 || status >= 300) throw new Error(`${origin} answered HTTP ${status} for the latest omp build`);
	const version = record(record(body)?.build)?.version;
	if (typeof version !== "string" || !SEMVER.test(version))
		throw new Error(`Invalid answer from ${origin} for the latest omp build`);
	return version;
}

// ------------------------------------------------------------------ the lookup

export interface ReleaseLookup {
	/** How the installed omp was installed; decides whom to ask. */
	method: InstallMethod | null;
	env?: Env;
	home?: string;
	fetch?: Fetch;
	timeoutMs?: number;
	/** Sent as `User-Agent`. */
	userAgent: string;
	/** The channel omp's `update.channel` names (`configuredUpdateChannel`); `stable`, omp's default, when not given. */
	channel?: UpdateChannel;
}

/** The latest omp release of the channel for this install; throws with a sentence for the user when it cannot be told. */
export async function latestRelease(
	opts: ReleaseLookup,
): Promise<Pick<OmpRelease, "latest" | "changelogUrl" | "source">> {
	const env = opts.env ?? process.env;
	const channel = opts.channel ?? "stable";
	const lookup: Lookup = {
		fetch: opts.fetch ?? fetch,
		timeoutMs: opts.timeoutMs ?? LOOKUP_TIMEOUT_MS,
		headers: { accept: "application/json", "user-agent": opts.userAgent },
	};
	try {
		const standalone = opts.method === "installer";
		const latest = standalone
			? await buildLatest(env, lookup, channel)
			: await npmLatest(NPM_PACKAGE, env, opts.home ?? homedir(), lookup, channel);
		return { latest, changelogUrl: changelogUrl(latest), source: standalone ? "build-service" : "npm" };
	} catch (e) {
		if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
			throw new Error("Timed out looking up the latest omp release");
		}
		throw e;
	}
}
