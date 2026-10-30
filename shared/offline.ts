/**
 * Full and Light mode, as the server and the browser share them.
 *
 * Full: a new omp process starts with the user's own omp configuration. Light: it starts in an agent directory of the
 * web UI's own (server/offline/agent.ts) in which only the selected MCP servers, tools and skills are loaded, so that
 * little of the model's context window goes to them. Light's models are either the user's own (`yours`: their
 * models.yml and model roles, as Full has them) or those of one local server (`local`: oMLX, Ollama or LM Studio, every
 * model role on it). The mode is the process's own: it keeps the one it was started in, and a conversation is switched
 * by restarting its omp (see `LivePool.switchMode`). The server also keeps the mode new conversations start in.
 */

import type { ErrorInfo } from "./error-info.ts";

export const MODES = ["full", "light"] as const;
export type Mode = (typeof MODES)[number];

export function isMode(v: unknown): v is Mode {
	return MODES.some((m) => m === v);
}

/** What Light runs on: the user's own models, or a local server's. */
export const LIGHT_MODELS = ["yours", "local"] as const;
export type LightModels = (typeof LIGHT_MODELS)[number];

export function isLightModels(v: unknown): v is LightModels {
	return LIGHT_MODELS.some((m) => m === v);
}

/** How a process was started: Light says what its models are (`lightModels` is absent in Full). */
export interface RunKind {
	mode: Mode;
	lightModels?: LightModels;
}

/** Whether the process runs on a local server's models (Light with `local`): no presets, no cloud quota, and its models are the server's. */
export function runsLocal(kind: RunKind | null | undefined): boolean {
	return kind?.mode === "light" && kind.lightModels === "local";
}

/**
 * The local servers Light can run on (Light's models "Local server"). Each is also the id of the omp provider that serves
 * its models: a provider of that name in the user's models.yml, or (Ollama, LM Studio) one the web UI makes up.
 */
export const BACKENDS = ["omlx", "ollama", "lm-studio"] as const;
export type Backend = (typeof BACKENDS)[number];

export function isBackend(v: unknown): v is Backend {
	return BACKENDS.some((b) => b === v);
}

/** What each backend calls itself, in messages and in Settings. */
export const BACKEND_NAMES: Record<Backend, string> = { omlx: "oMLX", ollama: "Ollama", "lm-studio": "LM Studio" };

/**
 * Where each backend listens unless told otherwise. oMLX has none: its address and API key are the user's own, in
 * the `omlx` provider of models.yml.
 */
export const DEFAULT_BASE_URLS: Record<Backend, string | null> = {
	omlx: null,
	ollama: "http://127.0.0.1:11434/v1",
	"lm-studio": "http://127.0.0.1:1234/v1",
};

/** What `defaultThinkingLevel` accepts. */
export const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max", "auto"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(v: unknown): v is ThinkingLevel {
	return THINKING_LEVELS.some((level) => level === v);
}

/** The tools a Light process keeps unless told otherwise. */
export const CORE_TOOLS = ["read", "bash", "edit", "write", "grep", "glob", "todo"] as const;
/**
 * Further built-in tools the Light settings offer: the ones omp enables without any other setting. omp stops
 * with an error on a name it does not know or has not enabled, so this list is the whole menu, and the contract
 * tests start omp with all of it.
 */
export const OPTIONAL_TOOLS = ["ask", "eval", "lsp", "task", "wait", "debug"] as const;
export const OFFLINE_TOOLS: readonly string[] = [...CORE_TOOLS, ...OPTIONAL_TOOLS];

/** Light keeps the REA tools and skill unless told otherwise. */
export const DEFAULT_MCP_SERVERS: readonly string[] = ["rea"];
export const DEFAULT_SKILLS: readonly string[] = ["reverse-engineer-anything"];

/**
 * What Light loads (`mcp`, `tools`, `skills`, `agentsMd`) and the local server's setup (`backend`, `baseUrls`, `model`,
 * `thinking`), which only Light with a local server's models uses. (The name is from when this was all there was of it.)
 */
export interface OfflineSettings {
	/** The local server Light conversations run on when Light's models are `local`. */
	backend: Backend;
	/**
	 * The address of each backend as set in Settings; null: the `baseUrl` of its provider in models.yml, else the
	 * backend's default (`DEFAULT_BASE_URLS`).
	 */
	baseUrls: Record<Backend, string | null>;
	/** `<backend>/<id>`; null: the first model the backend serves. */
	model: string | null;
	thinking: ThinkingLevel;
	/** Names of the user's MCP servers (their mcp.json) a Light process loads. */
	mcp: string[];
	/** Built-in tools (`omp --tools`). */
	tools: string[];
	/** Skill names or globs (`skills.includeSkills`); none: no skills at all. */
	skills: string[];
	/** Also load the user's own AGENTS.md. */
	agentsMd: boolean;
}

/** A change to the Light settings: the fields it names, and of `baseUrls` the backends it names. */
export type OfflinePatch = Partial<Omit<OfflineSettings, "baseUrls">> & {
	baseUrls?: Partial<Record<Backend, string | null>>;
};

export const DEFAULT_OFFLINE: OfflineSettings = {
	backend: "omlx",
	baseUrls: { omlx: null, ollama: null, "lm-studio": null },
	model: null,
	thinking: "medium",
	mcp: [...DEFAULT_MCP_SERVERS],
	tools: [...CORE_TOOLS],
	skills: [...DEFAULT_SKILLS],
	agentsMd: false,
};

/**
 * omp flags that pick a model or provider. In a Light process on a local server they would win over the models the
 * agent directory sets (`enabledModels` does not restrict them), so only the chosen backend's may be given, and
 * New chat does not offer them while that is what Light means.
 */
export const MODEL_FLAGS: readonly string[] = [
	"--model",
	"--smol",
	"--slow",
	"--plan",
	"--models",
	"--provider",
	"--plan-yolo-into",
	"--prewalk-into",
];

/** The model-selecting flags in `args` (`--model x` and `--model=x` alike) and what each is given. */
function modelFlagUses(args: readonly string[]): { flag: string; value: string | null }[] {
	const uses: { flag: string; value: string | null }[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") break;
		if (!arg.startsWith("--")) continue;
		const eq = arg.indexOf("=");
		const flag = eq < 0 ? arg : arg.slice(0, eq);
		if (!MODEL_FLAGS.includes(flag)) continue;
		uses.push({ flag, value: eq >= 0 ? arg.slice(eq + 1) : (args[i + 1] ?? null) });
	}
	return uses;
}

/** Whether `args` choose a model themselves (a process resumed with one does not get the local server's model forced on it). */
export function selectsModel(args: readonly string[]): boolean {
	return modelFlagUses(args).some((u) => u.flag === "--model");
}

/** The first flag of `args` that selects a model or provider that is not `backend`'s, which a Light process on that backend must not use. */
export function foreignModelFlag(args: readonly string[], backend: Backend): { flag: string; value: string } | null {
	for (const { flag, value } of modelFlagUses(args)) {
		if (value === null) continue;
		const ok =
			flag === "--provider" ? value === backend : value.split(",").every((m) => m.trim().startsWith(`${backend}/`));
		if (!ok) return { flag, value };
	}
	return null;
}

/**
 * Where an address leads, as far as its host tells. `loopback`, `private` and `local` stay on this machine or its
 * network; `public` leaves it (prompts and file contents go there); `link-local` is refused outright: it is where cloud
 * metadata services listen, and a model server is never there.
 */
export type HostClass = "loopback" | "private" | "local" | "public" | "link-local";

/** Names of cloud metadata services, which resolve to a link-local address. */
const METADATA_HOSTS: Record<string, true> = { "metadata.google.internal": true, "metadata.goog": true };
/** Cloud metadata services outside the link-local range (Alibaba Cloud, Oracle Cloud). */
const METADATA_V4: Record<string, true> = { "100.100.100.200": true, "192.0.0.192": true };
/** Names that only resolve on a local network. */
const LOCAL_SUFFIXES = [".local", ".lan", ".home.arpa"];

function parseV4(text: string): number[] | null {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
	if (!m) return null;
	const parts = m.slice(1).map(Number);
	return parts.every((n) => n <= 255) ? parts : null;
}

function classifyV4(parts: number[]): HostClass {
	const [a, b] = parts;
	if (Object.hasOwn(METADATA_V4, parts.join("."))) return "link-local";
	if (a === 127 || a === 0) return "loopback";
	if (a === 169 && b === 254) return "link-local";
	if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
	// Carrier-grade NAT, where Tailscale and other overlay networks take their addresses from.
	if (a === 100 && b >= 64 && b <= 127) return "private";
	return "public";
}

/** The eight 16-bit groups of an IPv6 address (`::` expanded, a dotted-quad tail converted); null when it is not one. */
function parseV6(text: string): number[] | null {
	let rest = text.split("%")[0];
	const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(rest);
	if (tail) {
		const v4 = parseV4(tail[1]);
		if (!v4) return null;
		rest = `${rest.slice(0, -tail[1].length)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
	}
	const halves = rest.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] === "" ? [] : halves[0].split(":");
	const after = halves.length === 2 && halves[1] !== "" ? halves[1].split(":") : [];
	const missing = 8 - head.length - after.length;
	if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
	const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...after];
	const nums = all.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN));
	return nums.some(Number.isNaN) ? null : nums;
}

function classifyV6(g: number[]): HostClass {
	// The IPv4 address in the last 32 bits, for the forms that carry one (mapped, and NAT64's prefix).
	const embedded = classifyV4([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255]);
	if (g.slice(0, 7).every((n) => n === 0) && g[7] <= 1) return "loopback";
	if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) return embedded;
	if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((n) => n === 0)) return embedded;
	if ((g[0] & 0xffc0) === 0xfe80) return "link-local";
	// AWS's IPv6 metadata service is in a unique-local prefix of its own.
	if (g[0] === 0xfd00 && g[1] === 0x0ec2) return "link-local";
	if ((g[0] & 0xfe00) === 0xfc00) return "private";
	return "public";
}

/** Where the host `hostname` (as `URL.hostname` gives it: IPv6 in brackets) leads. */
export function classifyHost(hostname: string): HostClass {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	if (Object.hasOwn(METADATA_HOSTS, host)) return "link-local";
	if (host.startsWith("[") && host.endsWith("]")) {
		const groups = parseV6(host.slice(1, -1));
		// An address this cannot read is not one that is known to stay home.
		return groups ? classifyV6(groups) : "public";
	}
	const v4 = parseV4(host);
	if (v4) return classifyV4(v4);
	if (host === "localhost" || host.endsWith(".localhost")) return "loopback";
	// A name without a dot resolves through the local network's own resolver (`http://studio:8000`).
	if (!host.includes(".") || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return "local";
	return "public";
}

/** Where `url` leads; null when it is not an address. */
export function classifyUrl(url: string): HostClass | null {
	try {
		return classifyHost(new URL(url).hostname);
	} catch {
		return null;
	}
}

/** Where a backend's address comes from. */
export type BaseUrlSource = "settings" | "models.yml" | "default";

/** What Settings is told of one backend. */
export interface BackendInfo {
	/** The address Light processes on this backend use, without credentials, query or fragment; null: there is none to use yet (oMLX without a provider). */
	baseUrl: string | null;
	source: BaseUrlSource | null;
	/** Why there is no address though the backend needs none from the user: models.yml could not be read (code, parameters and the English sentence). */
	error?: ErrorInfo & { message: string };
}

/** `GET /api/mode` and `POST /api/mode`. */
export interface ModeState {
	/** The mode new conversations start in (New chat's Full / Light, and Settings › Full / Light). */
	mode: Mode;
	/** What Light's models are, for the Light processes that start from now on. */
	lightModels: LightModels;
	/** What Light loads, and the local server's setup. */
	offline: OfflineSettings;
	/** The MCP servers in the user's mcp.json: what the Light checklist offers. */
	mcpServers: string[];
	/**
	 * The ones among them that omp has switched off (`enabled: false`: the Loaded dialog's switch, `/mcp disable`):
	 * Light loads none of those, checked or not.
	 */
	mcpOff: string[];
	/** Selected Light MCP servers (`offline.mcp`) that mcp.json no longer has: Light loads without them. */
	missingMcp: string[];
	/** Each backend's address as Light processes on a local server would use it. */
	backends: Record<Backend, BackendInfo>;
	/**
	 * Which run of the server said this (`boot`), and the order it said things in (`rev` counts up with every statement).
	 * A page gets the state twice over: announced on the socket when anything changes, and as the answer to a request
	 * (a read, or its own save). The answer is the state as of the moment the server handled the request, and the two
	 * travel on separate connections, so an answer can arrive after an announcement that is newer than it; a page keeps
	 * the one with the higher `rev`. A new run of the server counts from the start again, which its `boot` tells apart.
	 */
	boot: string;
	rev: number;
}

/** `GET /api/offline/models[?backend=<id>]`: the model ids a backend (default: the selected one) serves right now. */
export interface BackendModels {
	backend: Backend;
	baseUrl: string;
	models: string[];
}

export interface ContextItem {
	label: string;
	tokens: number;
}

/** The rows of omp's `/context` that are no content: the space left, and what auto-compaction keeps free. */
export const RESERVED_ROWS = /^(Free|Auto-compact)/i;

/** omp's `/context` for a fresh process: where the model's context window goes before the first message. */
export interface ContextBreakdown {
	window: number;
	/** Tokens in use at the start: everything but the free space and the auto-compact buffer. */
	startTokens: number;
	items: ContextItem[];
	/** A selected MCP server had not registered its tools yet when the numbers were taken. */
	incomplete: boolean;
}

export type Measured = { at: number } & (
	| { ok: true; breakdown: ContextBreakdown }
	| { ok: false; error: string; errorInfo?: ErrorInfo }
);

/** `POST /api/offline/context`: a fresh process of each mode, measured (Light as it is set up now). */
export interface ContextReport {
	full: Measured;
	light: Measured;
}
