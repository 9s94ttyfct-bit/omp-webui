import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import type { McpInput, McpInstallOption, McpProblem, McpSearch, McpServerHit } from "../../shared/mcp-registry.ts";

/**
 * The MCP section of the Plugins page: the official MCP Registry searched from the server (never from the page), and a
 * server of it written into omp's MCP configuration at user scope (`<agent dir>/mcp.json`).
 *
 * omp has no command line to add an MCP server (only `/mcp add` inside a running omp, which cannot set environment
 * variables or headers), so the entry is written as omp's own `/mcp add` writes it (`packages/coding-agent/src/mcp/
 * config-writer.ts`, omp 18.16): the file read as JSON (a missing one is `{ mcpServers: {} }`), the new server added
 * under a name that is not taken, `$schema` first, and the whole written to a temporary file (mode 0600: it may hold
 * secrets) that then replaces it. A running omp connects its MCP servers when it starts, so conversations started
 * afterwards have it, and a running one after a restart.
 *
 * A registry entry is mapped to omp's config like this:
 * - an npm package: `npx -y <package>@<version>`; a PyPI package: `uvx <package>@<version>`; an OCI image: `docker run -i
 *   --rm [-e NAME…] <image>`. Runtime arguments go before the package, package arguments after it; environment variables
 *   go into `env`. The person is shown this whole command line (with the environment in front) before it is written.
 * - a remote: `type` `http` (streamable HTTP) or `sse`, its `url`, and its `headers`.
 * - `{name}` in a value (an argument, a variable, a header, a URL) is a value the person fills in; so is a variable, a
 *   header or an argument the registry gives no value for. Secret ones are shown as password fields.
 * - Everything else is refused, with why: a package kind omp-webui cannot run (nuget, cargo, mcpb…), a package from a
 *   registry other than npm's or PyPI's public one (also through a runtime argument such as `--registry` or
 *   `--index-url`), a runtime argument that makes `npx` or `uvx` fetch or run something else (`--package`, `--from`…), a
 *   package that serves HTTP itself, a remote transport omp does not speak, and a name or value that could be read as
 *   something else.
 */

const DEFAULT_REGISTRY = "https://registry.modelcontextprotocol.io";
/** How long the registry is given to answer. */
const FETCH_MS = 15_000;
/** The most of an answer that is read: a page of 20 servers is some tens of KiB. */
const MAX_BYTES = 2 * 1024 * 1024;
/** How many servers one page lists. */
const PAGE = 20;
/** Where omp's MCP config says its schema is (what omp's writer puts at the top of a file it writes). */
const MCP_SCHEMA =
	"https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json";

/** The registry's address: `OMPW_MCP_REGISTRY` (tests only: a stand-in served by the test) or the official one. */
export function registryBase(env: Record<string, string | undefined> = process.env): string {
	return (env.OMPW_MCP_REGISTRY || DEFAULT_REGISTRY).replace(/\/+$/, "");
}

/** A request the server refuses, or the registry could not answer: `status` is what the page gets. */
export class McpRegistryError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

// ------------------------------------------------------------------ what the registry says

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);

// biome-ignore lint/suspicious/noControlCharactersInRegex: this is the check for them
const CONTROL = /[\u0000-\u001f\u007f]/;
/** A package's name or image: one word, never a flag. */
const PACKAGE = /^[\w@.][\w@./:+~-]{0,299}$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,199}$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,200}$/;
const PLACEHOLDER = /\{([A-Za-z0-9_.-]{1,100})\}/g;

/** The public registries a package may come from (its `registryBaseUrl`, when it gives one). */
const PUBLIC_REGISTRY: Record<string, readonly string[]> = {
	npm: ["https://registry.npmjs.org"],
	pypi: ["https://pypi.org", "https://pypi.org/simple"],
	oci: [],
};

/** A value that may hold `{name}` placeholders, with what the registry says of each (its `variables`). */
interface Spec {
	name?: unknown;
	description?: unknown;
	isRequired?: unknown;
	isSecret?: unknown;
	default?: unknown;
	value?: unknown;
	valueHint?: unknown;
	placeholder?: unknown;
	format?: unknown;
	choices?: unknown;
	variables?: unknown;
	type?: unknown;
}

/** Where a way of running a server stands as it is worked out: the values it asks for, those missing, why it cannot be. */
class Plan {
	readonly inputs = new Map<string, McpInput>();
	readonly missing: string[] = [];
	problem: McpProblem | null = null;
	constructor(private readonly values: Readonly<Record<string, string>>) {}

	refuse(problem: McpProblem): void {
		this.problem ??= problem;
	}

	/** A value the person gives: theirs, else its default; null when empty (and noted as missing when required). */
	ask(
		key: string,
		kind: McpInput["kind"],
		label: string,
		spec: Spec,
		required: boolean,
		secret: boolean,
	): string | null {
		const known = this.inputs.get(key);
		const input: McpInput = known ?? {
			key,
			kind,
			label,
			description: str(spec.description),
			required,
			secret,
			default: str(spec.default),
			placeholder: str(spec.placeholder) ?? str(spec.valueHint),
			choices: Array.isArray(spec.choices) ? spec.choices.filter((c): c is string => typeof c === "string") : null,
		};
		if (known) {
			known.required ||= required;
			known.secret ||= secret;
		} else this.inputs.set(key, input);
		const given = this.values[key];
		const value = given !== undefined && given !== "" ? given : input.default;
		if (value === null || value === "") {
			if (input.required && !this.missing.includes(key)) this.missing.push(key);
			return null;
		}
		if (CONTROL.test(value)) this.refuse({ code: "invalid", detail: label });
		return value;
	}

	/**
	 * A value with `{name}` placeholders filled in: each is asked for (as the registry describes it in `variables`, else as
	 * required and secret as its owner is). Null when one is left empty.
	 */
	fill(text: string, owner: Spec, ownerLabel: string): string | null {
		const variables = isRecord(owner.variables) ? owner.variables : {};
		let empty = false;
		const out = text.replace(PLACEHOLDER, (whole, name: string) => {
			const declared = isRecord(variables[name]) ? (variables[name] as Spec) : null;
			// A declared placeholder, or any when the registry declares none (`Bearer {api_key}` is common without them).
			if (!declared && Object.keys(variables).length > 0) return whole;
			const spec: Spec = declared ?? { description: owner.description };
			const required = declared ? declared.isRequired === true || owner.isRequired === true : owner.isRequired === true;
			const secret = declared ? declared.isSecret === true || owner.isSecret === true : owner.isSecret === true;
			const value = this.ask(`var:${name}`, "var", `${name} (${ownerLabel})`, spec, required, secret);
			if (value === null) empty = true;
			return value ?? whole;
		});
		return empty ? null : out;
	}

	/** An environment variable or a header: its given value (filled in), else asked for. */
	named(kind: "env" | "header", spec: Spec): [name: string, value: string] | null {
		const name = str(spec.name);
		if (!name || !(kind === "env" ? ENV_NAME : HEADER_NAME).test(name)) {
			this.refuse({ code: "invalid", detail: String(spec.name ?? kind) });
			return null;
		}
		const required = spec.isRequired === true;
		const fixed = str(spec.value);
		const value = fixed
			? this.fill(fixed, spec, name)
			: this.ask(`${kind}:${name}`, kind, name, spec, required, spec.isSecret === true);
		return value === null ? null : [name, value];
	}

	/**
	 * Runtime or package arguments, in order: a fixed one as it is, the others asked for; an empty optional one is left out.
	 * `shown` is the same as the person is shown it: a fixed value as written, one to fill in as `{its label}`.
	 */
	args(specs: Record<string, unknown>[], prefix: string): { args: string[]; shown: string[] } {
		const out: string[] = [];
		const shown: string[] = [];
		for (const [i, raw] of specs.entries()) {
			const spec = raw as Spec;
			const name = str(spec.name);
			const named = spec.type === "named" || (spec.type !== "positional" && name?.startsWith("-") === true);
			const label = str(spec.valueHint) ?? name ?? `${prefix} ${i + 1}`;
			const fixed = typeof spec.value === "string" ? spec.value : null;
			if (named && (!name || !/^-{1,2}[\w.-]+$/.test(name))) {
				this.refuse({ code: "invalid", detail: name ?? label });
				continue;
			}
			// A named argument with nothing that says it takes a value is a flag on its own.
			if (
				named &&
				name &&
				fixed === null &&
				spec.valueHint === undefined &&
				spec.default === undefined &&
				!spec.format
			) {
				out.push(name);
				shown.push(name);
				continue;
			}
			const value =
				fixed !== null
					? this.fill(fixed, spec, label)
					: this.ask(`arg:${prefix}:${i}`, "arg", label, spec, spec.isRequired === true, spec.isSecret === true);
			shown.push(...(named && name ? [name] : []), fixed ?? `{${label}}`);
			if (value === null) continue;
			if (named && name) out.push(name, value);
			else out.push(value);
		}
		return { args: out, shown };
	}
}

/**
 * Runtime arguments that would make the runner fetch the package from somewhere else (`registry`), or fetch or run something
 * other than the package (`other`): long flags (also as `--flag=value`), and the letters of short ones (also bunched, `-yp`).
 */
const RUNNER_FLAGS: Record<string, { registry: RegExp; other: RegExp; short: { registry: string; other: string } }> = {
	npm: {
		registry: /^--(?:(?:@[^=]*:)?registry|userconfig|globalconfig)$/,
		other: /^--(?:package|call)$/,
		short: { registry: "", other: "pc" },
	},
	pypi: {
		registry: /^--(?:index-url|extra-index-url|index|default-index|find-links|config-file)$/,
		other: /^--(?:from|with|with-editable|with-requirements)$/,
		short: { registry: "if", other: "w" },
	},
};

/** Why the runtime arguments of an npm or PyPI package cannot be passed to `npx` or `uvx`; null: they can. */
function runnerProblem(kind: string, runtime: readonly string[]): McpProblem | null {
	const flags = RUNNER_FLAGS[kind];
	if (!flags) return null;
	for (const [i, token] of runtime.entries()) {
		const eq = token.indexOf("=");
		const flag = eq >= 0 ? token.slice(0, eq) : token;
		const value = eq >= 0 ? token.slice(eq + 1) : (runtime[i + 1] ?? flag);
		if (flag.startsWith("--")) {
			if (flags.registry.test(flag)) return { code: "private-registry", detail: value };
			if (flags.other.test(flag)) return { code: "invalid", detail: flag };
		} else if (/^-[A-Za-z]+$/.test(flag)) {
			const letters = [...flag.slice(1)];
			if (letters.some((l) => flags.short.registry.includes(l))) return { code: "private-registry", detail: value };
			if (letters.some((l) => flags.short.other.includes(l))) return { code: "invalid", detail: flag };
		}
	}
	return null;
}

/** What omp's config holds for one server. */
export type McpConfigEntry =
	| { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
	| { type: "http" | "sse"; url: string; headers?: Record<string, string> };

/** One way of running a server worked out, with the values given: the option, the entry it makes, what is missing. */
export interface MappedOption {
	option: McpInstallOption;
	/** null when it cannot be written (a problem) or values are missing. */
	entry: McpConfigEntry | null;
	/** The keys of the required inputs left empty. */
	missing: string[];
}

function mapPackage(pkg: Record<string, unknown>, index: number, values: Record<string, string>): MappedOption {
	const plan = new Plan(values);
	const kind = str(pkg.registryType) ?? "unknown";
	const identifier = str(pkg.identifier) ?? "";
	const version = str(pkg.version);
	const transport = isRecord(pkg.transport) ? (str(pkg.transport.type) ?? "stdio") : "stdio";
	const base = str(pkg.registryBaseUrl)?.replace(/\/+$/, "") ?? null;
	if (!(kind in PUBLIC_REGISTRY)) plan.refuse({ code: "registry", detail: kind });
	else if (base && !PUBLIC_REGISTRY[kind].includes(base)) plan.refuse({ code: "private-registry", detail: base });
	if (transport !== "stdio") plan.refuse({ code: "local-http", detail: transport });
	if (!PACKAGE.test(identifier) || (version !== null && !/^[\w.+~-]{1,100}$/.test(version)))
		plan.refuse({ code: "invalid", detail: identifier || kind });

	const runtime = plan.args(list(pkg.runtimeArguments), "runtime");
	const after = plan.args(list(pkg.packageArguments), "argument");
	const problem = runnerProblem(kind, runtime.args);
	if (problem) plan.refuse(problem);
	const env: Record<string, string> = {};
	const envShown: string[] = [];
	for (const spec of list(pkg.environmentVariables)) {
		const pair = plan.named("env", spec);
		if (pair) env[pair[0]] = pair[1];
		const name = str(spec.name);
		if (name && ENV_NAME.test(name)) envShown.push(`${name}=${str(spec.value) ?? `{${name}}`}`);
	}

	const pinned = version ? `${identifier}@${version}` : identifier;
	let command = "";
	let args: string[] = [];
	// The command line as the person is shown it before it is written: every argument, the environment in front.
	let shown: string[] = [kind, identifier];
	if (kind === "npm") {
		command = "npx";
		args = ["-y", ...runtime.args, pinned, ...after.args];
		shown = ["npx", "-y", ...runtime.shown, pinned, ...after.shown];
	} else if (kind === "pypi") {
		command = "uvx";
		args = [...runtime.args, pinned, ...after.args];
		shown = ["uvx", ...runtime.shown, pinned, ...after.shown];
	} else if (kind === "oci") {
		// The image's own tag, else the version as one.
		const tagged = /[:@][^/]*$/.test(identifier) || !version ? identifier : `${identifier}:${version}`;
		command = "docker";
		const passed = Object.keys(env).flatMap((name) => ["-e", name]);
		args = ["run", "-i", "--rm", ...runtime.args, ...passed, tagged, ...after.args];
		const named = envShown.flatMap((e) => ["-e", e.slice(0, e.indexOf("="))]);
		shown = ["docker", "run", "-i", "--rm", ...runtime.shown, ...named, tagged, ...after.shown];
	}
	const summary = [...envShown, ...shown].join(" ");
	const option: McpInstallOption = {
		id: `package:${index}`,
		kind,
		transport: "stdio",
		summary,
		inputs: [...plan.inputs.values()],
		problem: plan.problem,
	};
	const entry: McpConfigEntry | null =
		plan.problem || plan.missing.length > 0
			? null
			: { type: "stdio", command, ...(args.length ? { args } : {}), ...(Object.keys(env).length ? { env } : {}) };
	return { option, entry, missing: plan.missing };
}

function mapRemote(remote: Record<string, unknown>, index: number, values: Record<string, string>): MappedOption {
	const plan = new Plan(values);
	const transport = str(remote.type) ?? "";
	const type = transport === "streamable-http" ? "http" : transport === "sse" ? "sse" : null;
	if (!type) plan.refuse({ code: "transport", detail: transport || "?" });
	const template = str(remote.url) ?? "";
	const url = plan.fill(template, { ...(remote as Spec), isRequired: true }, "URL");
	if (url !== null && !/^https?:\/\/[^\s]+$/i.test(url)) plan.refuse({ code: "invalid", detail: "URL" });
	const headers: Record<string, string> = {};
	for (const spec of list(remote.headers)) {
		const pair = plan.named("header", spec);
		if (pair) headers[pair[0]] = pair[1];
	}
	const option: McpInstallOption = {
		id: `remote:${index}`,
		kind: "remote",
		transport: type ?? "http",
		summary: template,
		inputs: [...plan.inputs.values()],
		problem: plan.problem,
	};
	const entry: McpConfigEntry | null =
		plan.problem || plan.missing.length > 0 || !type || url === null
			? null
			: { type, url, ...(Object.keys(headers).length ? { headers } : {}) };
	return { option, entry, missing: plan.missing };
}

/** Every way of running a registry server (its packages, then its remotes), worked out with the values given. */
export function mapServer(server: Record<string, unknown>, values: Record<string, string> = {}): MappedOption[] {
	return [
		...list(server.packages).map((p, i) => mapPackage(p, i, values)),
		...list(server.remotes).map((r, i) => mapRemote(r, i, values)),
	];
}

/** Why a way of running a server cannot be added, in words (the page has its own, translated). */
export function problemText(problem: McpProblem): string {
	switch (problem.code) {
		case "registry":
			return `omp-webui cannot run ${problem.detail} packages: see the server's repository for how to run it`;
		case "private-registry":
			return `The package comes from ${problem.detail}, not npm's or PyPI's public registry`;
		case "local-http":
			return `The package serves ${problem.detail} itself: start it yourself and add its address`;
		case "transport":
			return `omp does not speak the ${problem.detail} transport`;
		case "invalid":
			return `${problem.detail} cannot be passed on as it is`;
	}
}

/** The name omp's config gives a registry server: the last part of its name, in the characters omp allows. */
export function configNameOf(registryName: string): string {
	const last = registryName.split("/").at(-1) ?? registryName;
	const name = last
		.replace(/[^A-Za-z0-9_.:-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[-.]+|-+$/g, "")
		.slice(0, 100);
	return name || "mcp-server";
}

/** A server's name in omp's config, as omp's own `/mcp add` allows it. */
export function validConfigName(name: unknown): name is string {
	return (
		typeof name === "string" &&
		name.length > 0 &&
		name.length <= 100 &&
		/^[a-zA-Z0-9_.:-]+(?: [a-zA-Z0-9_.:-]+)*$/.test(name)
	);
}

// ------------------------------------------------------------------ already configured

/** How a configured server runs: its command line, or its address without the query. */
function configuredRuns(entry: unknown): { args: string[]; url: string | null } {
	if (!isRecord(entry)) return { args: [], url: null };
	const args = [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])].filter(
		(a): a is string => typeof a === "string",
	);
	const url = typeof entry.url === "string" ? entry.url.split("?")[0].replace(/\/+$/, "") : null;
	return { args, url };
}

/**
 * The name of a configured server that runs this registry server: one that runs one of its packages (any version), or one
 * at one of its remote addresses. Null: none. A server that only has the same name is not it (the dialog says the name is
 * taken).
 */
export function configuredAs(
	server: Record<string, unknown>,
	configured: Readonly<Record<string, unknown>>,
): string | null {
	// A package at any version: `pkg`, `pkg@1.2.3`, `pkg==1.2.3`, an image with any tag.
	const unversioned = (p: string) => p.replace(/(?:==|[:@])[^/]*$/, "");
	const packages = list(server.packages)
		.map((p) => str(p.identifier))
		.filter((p): p is string => p !== null)
		.map(unversioned);
	// A templated address (`https://{tenant}.example.com/mcp`) matches on what comes before its first placeholder, when
	// that names a host.
	const remotes = list(server.remotes)
		.map((r) => str(r.url)?.split("?")[0].replace(/\/+$/, "") ?? null)
		.filter((u): u is string => u !== null)
		.map((u) => ({ prefix: u.includes("{") ? u.slice(0, u.indexOf("{")) : null, url: u }))
		.filter((r) => r.prefix === null || /^https?:\/\/[^/{]+[./]/.test(r.prefix));
	for (const [key, entry] of Object.entries(configured)) {
		const runs = configuredRuns(entry);
		if (packages.some((p) => runs.args.some((a) => unversioned(a) === p))) return key;
		const url = runs.url;
		if (url !== null && remotes.some((r) => (r.prefix !== null ? url.startsWith(r.prefix) : url === r.url))) return key;
	}
	return null;
}

// ------------------------------------------------------------------ the registry

/** An answer's body as JSON, read up to `MAX_BYTES`. */
async function readJson(res: Response): Promise<unknown> {
	const reader = res.body?.getReader();
	if (!reader) return null;
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_BYTES) {
			await reader.cancel().catch(() => {});
			throw new McpRegistryError("The MCP Registry answered with more than this reads", 502);
		}
		chunks.push(value);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new McpRegistryError("The MCP Registry did not answer with JSON", 502);
	}
}

async function registryGet(path: string, base: string): Promise<unknown> {
	let res: Response;
	try {
		res = await fetch(`${base}${path}`, {
			headers: { accept: "application/json" },
			redirect: "follow",
			signal: AbortSignal.timeout(FETCH_MS),
		});
	} catch (e) {
		const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
		throw new McpRegistryError(
			timedOut ? "The MCP Registry did not answer in time" : `The MCP Registry could not be reached: ${String(e)}`,
			timedOut ? 504 : 502,
		);
	}
	if (res.status === 404) throw new McpRegistryError("The MCP Registry has no such server", 404);
	if (!res.ok) throw new McpRegistryError(`The MCP Registry answered ${res.status}`, 502);
	return readJson(res);
}

/** The server of a registry item, unless the registry marks it deleted. */
function serverOf(item: unknown): Record<string, unknown> | null {
	if (!isRecord(item) || !isRecord(item.server) || typeof item.server.name !== "string") return null;
	const meta = isRecord(item._meta) ? item._meta["io.modelcontextprotocol.registry/official"] : null;
	if (isRecord(meta) && meta.status === "deleted") return null;
	return item.server;
}

/** One server as the page lists it. */
export function hitOf(server: Record<string, unknown>, configured: Readonly<Record<string, unknown>>): McpServerHit {
	const name = str(server.name) ?? "";
	const repository = isRecord(server.repository) ? str(server.repository.url) : null;
	return {
		name,
		title: str(server.title),
		description: str(server.description),
		version: str(server.version) ?? "",
		repository: repository && /^https:\/\//.test(repository) ? repository : null,
		website: str(server.websiteUrl)?.startsWith("https://") ? str(server.websiteUrl) : null,
		options: mapServer(server).map((m) => m.option),
		configName: configNameOf(name),
		added: configuredAs(server, configured),
	};
}

/** A text to search the registry for, or a cursor: one line, not too long. */
const validQuery = (v: string) => v.length <= 200 && !CONTROL.test(v);

/** One page of the registry's latest servers that match `query` (all of them when it is empty). */
export async function searchRegistry(
	query: string,
	cursor: string | null,
	configured: Readonly<Record<string, unknown>>,
	base = registryBase(),
): Promise<Omit<McpSearch, "taken">> {
	if (!validQuery(query) || (cursor !== null && !validQuery(cursor)))
		throw new McpRegistryError("The search must be one line of text", 400);
	const q = new URLSearchParams({ limit: String(PAGE), version: "latest" });
	if (query.trim()) q.set("search", query.trim());
	if (cursor) q.set("cursor", cursor);
	const doc = await registryGet(`/v0/servers?${q}`, base);
	if (!isRecord(doc)) throw new McpRegistryError("The MCP Registry answered in a form this does not know", 502);
	const servers = (Array.isArray(doc.servers) ? doc.servers : [])
		.map(serverOf)
		.filter((s): s is Record<string, unknown> => s !== null);
	const meta = isRecord(doc.metadata) ? doc.metadata : {};
	return { servers: servers.map((s) => hitOf(s, configured)), nextCursor: str(meta.nextCursor) };
}

/** One server of the registry, at one version. */
export async function fetchServer(
	name: string,
	version: string,
	base = registryBase(),
): Promise<Record<string, unknown>> {
	if (!name || !version || !validQuery(name) || !validQuery(version))
		throw new McpRegistryError("Name the server and its version", 400);
	const doc = await registryGet(
		`/v0/servers/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`,
		base,
	);
	const server = serverOf(doc);
	if (!server || server.name !== name) throw new McpRegistryError("The MCP Registry has no such server", 404);
	return server;
}

// ------------------------------------------------------------------ omp's config

/**
 * Add one server to an `mcp.json`, as omp's own writer does: refused when the name is taken or the file is not a JSON
 * object (omp's own commands say what is wrong with it), `$schema` first, written whole to a temporary file that replaces it.
 */
export async function addToMcpConfig(file: string, name: string, entry: McpConfigEntry): Promise<void> {
	let doc: Record<string, unknown> = { mcpServers: {} };
	try {
		const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
		if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers)))
			throw new McpRegistryError(`${file} is not an MCP configuration omp reads: fix it first`, 409);
		doc = parsed;
	} catch (e) {
		if (e instanceof McpRegistryError) throw e;
		if (!(isRecord(e) && e.code === "ENOENT"))
			throw new McpRegistryError(`${file} could not be read as JSON: fix it first`, 409);
	}
	const servers = isRecord(doc.mcpServers) ? doc.mcpServers : {};
	if (Object.hasOwn(servers, name))
		throw new McpRegistryError(`A server named "${name}" is already in ${file}: choose another name`, 409);
	const next = { $schema: doc.$schema ?? MCP_SCHEMA, ...doc, mcpServers: { ...servers, [name]: entry } };
	await mkdir(dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temp, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
		await rename(temp, file);
	} catch (e) {
		await rm(temp, { force: true }).catch(() => {});
		throw e;
	}
}
