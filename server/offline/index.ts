import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ErrorInfo, errorInfoOf } from "../../shared/error-info.ts";
import { isRecord } from "../../shared/guards.ts";
import {
	BACKEND_NAMES,
	type Backend,
	type BackendInfo,
	type BackendModels,
	type ContextBreakdown,
	type ContextReport,
	foreignModelFlag,
	isBackend,
	isLightModels,
	isMode,
	type LightModels,
	type Measured,
	type Mode,
	type ModeState,
	type OfflineSettings,
	selectsModel,
} from "../../shared/offline.ts";
import type { Config } from "../config.ts";
import { ompVersion } from "../omp/cli.ts";
import {
	collectOfflineAgents,
	offlineModels,
	readUserConfig,
	readUserFiles,
	type UserFiles,
	writeOfflineAgent,
	writeYoursAgent,
} from "./agent.ts";
import { OfflineError, queryBackend, shown } from "./backend.ts";
import { measureContext } from "./context.ts";
import { LatestQueue } from "./latest-queue.ts";
import { ModeStore, mergeOffline, SettingsError } from "./settings.ts";

export { OfflineError } from "./backend.ts";
export { SettingsError } from "./settings.ts";

/** How a new omp process is started in a mode. */
export interface LaunchPlan {
	mode: Mode;
	/** What a Light process's models are; absent in Full. */
	lightModels?: LightModels;
	/** Put in front of the process's arguments. */
	args: string[];
	/** Added to its environment. */
	env: Record<string, string>;
}

export const FULL: LaunchPlan = { mode: "full", args: [], env: {} };

export interface LaunchRequest {
	/** The session file the process resumes, if it does. */
	resume: string | null;
	/** The arguments the caller gives the process (to see whether it chose a model itself). */
	args: string[];
	/** The mode the process is started in. */
	mode: Mode;
}

/** What the process pool needs of the mode: the one new conversations start in, and how to start a process in either. */
export interface Launcher {
	/** The mode new conversations start in. */
	readonly mode: Mode;
	/** Rejects with an `OfflineError` when the mode cannot be entered right now (the local server is down). */
	plan(req: LaunchRequest): Promise<LaunchPlan>;
	/**
	 * Remove what earlier plans left that no process uses. `inUse`: the agent directories (`PI_CODING_AGENT_DIR`) of the
	 * processes that run, and of the paused ones that outlive the server.
	 */
	collect?(inUse: readonly string[]): void;
}

/** Pick the model every role gets: the chosen one, or the first `backend` serves. `served` null: it could not say. */
export function chooseModel(backend: Backend, chosen: string | null, served: string[] | null): string {
	const name = BACKEND_NAMES[backend];
	if (chosen) {
		const id = chosen.slice(backend.length + 1);
		if (served && !served.includes(id)) {
			const message = `${name} does not serve ${id} (it serves: ${served.join(", ") || "no models"}). Choose another model in Settings › Full / Light.`;
			throw served.length
				? new OfflineError(message, "offlineModelNotServed", { backend, id, served: served.join(", ") })
				: new OfflineError(message, "offlineModelNotServedNone", { backend, id });
		}
		return chosen;
	}
	if (!served?.length) {
		if (served === null)
			throw new OfflineError(
				`Choose a model in Settings › Full / Light: ${name} did not list its models.`,
				"offlineChooseModel",
				{ backend },
			);
		throw new OfflineError(
			`${name} serves no models yet. Load or pull one in ${name}, or switch to Full, or to Light with your own models.`,
			"offlineNoModels",
			{ backend },
		);
	}
	return `${backend}/${served[0]}`;
}

/** A server in mcp.json that omp connects: not one the user switched off (`/mcp disable` writes `enabled: false`). */
function loads(server: unknown): boolean {
	return !(isRecord(server) && server.enabled === false);
}

/** Size and modification time of a file, to notice that it changed. */
function signature(path: string): string {
	try {
		const st = statSync(path);
		return `${st.mtimeMs}:${st.size}`;
	} catch {
		return "-";
	}
}

/** Where a program really is, with its size and modification time: it changes when the program is replaced. */
function binarySignature(bin: string): string {
	let real = bin;
	try {
		real = realpathSync(bin);
	} catch {
		// not a path that exists: a bare name omp was not found by, which is what it is
	}
	return `${real}:${signature(real)}`;
}

/** Most files looked at in one directory tree: a skills folder is small, a stray `node_modules` in it must not stall. */
const TREE_FILES = 4000;

/** Path, size and modification time of every file under `dir` (links followed), to notice that one changed. */
function treeSignature(dir: string): string {
	const rows: string[] = [];
	const walk = (path: string, depth: number): void => {
		let names: string[];
		try {
			names = readdirSync(path).sort();
		} catch {
			return;
		}
		for (const name of names) {
			if (rows.length >= TREE_FILES) return;
			const child = join(path, name);
			try {
				const st = statSync(child);
				if (st.isDirectory()) {
					if (depth < 6) walk(child, depth + 1);
				} else rows.push(`${child}:${st.mtimeMs}:${st.size}`);
			} catch {
				// a dangling link: it is not a skill
			}
		}
	};
	walk(dir, 0);
	return digest(rows);
}

function digest(parts: unknown[]): string {
	return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

/** A saved measurement, as read back from disk. */
function isMeasured(v: unknown): v is Measured & { ok: true } {
	return (
		isRecord(v) &&
		v.ok === true &&
		typeof v.at === "number" &&
		isRecord(v.breakdown) &&
		typeof v.breakdown.window === "number" &&
		typeof v.breakdown.startTokens === "number" &&
		Array.isArray(v.breakdown.items)
	);
}

export class ModeService implements Launcher {
	private readonly store: ModeStore;
	/** `<data dir>/offline-agent`: the agent directories of the Light processes, one for each configuration they were started with. */
	readonly root: string;
	private readonly cacheFile: string;
	private readonly listeners = new Set<(state: ModeState) => void>();
	/** Light agent directories are written one at a time: two processes starting together must not interleave them. */
	private chain: Promise<unknown> = Promise.resolve();
	/** Measurements run one at a time, the newest request of each side being the one that counts. */
	private readonly measurements = new LatestQueue<Measured>();
	private readonly saved: Partial<Record<Mode, { fp: string; value: Measured & { ok: true } }>> = {};
	private version: { key: string; value: Promise<string> } | null = null;
	/** Which run of this server says the states, and how many it has said: see `ModeState.rev`. */
	private readonly boot = randomUUID();
	private rev = 0;

	constructor(
		private readonly cfg: Config,
		/** The models a session file recorded (`provider/id` each), for resuming it. */
		private readonly savedModels: (file: string) => Promise<string[] | null> = async () => null,
		/** Measures one fresh omp process (injected by tests; omp's own `/context` otherwise). */
		private readonly measureProcess: typeof measureContext = measureContext,
	) {
		this.store = new ModeStore(cfg.dataDir);
		this.root = join(cfg.dataDir, "offline-agent");
		this.cacheFile = join(cfg.dataDir, "context-measure.json");
		this.loadSaved();
	}

	/** The mode new conversations start in. */
	get mode(): Mode {
		return this.store.mode;
	}

	/** What Light's models are for the Light processes that start from now on. */
	get lightModels(): LightModels {
		return this.store.lightModels;
	}

	/** The Light settings as they are kept. */
	get offline(): OfflineSettings {
		return this.store.offline;
	}

	/** `fn` is told the new state after every change of the mode or of the Light settings, whoever made it. */
	onChange(fn: (state: ModeState) => void): void {
		this.listeners.add(fn);
	}

	state(): ModeState {
		const files = readUserFiles(this.cfg.agentDir);
		const info = (backend: Backend): BackendInfo => {
			try {
				const { provider, source } = this.provider(files, backend);
				return { baseUrl: shown(provider.baseUrl), source };
			} catch (e) {
				// An unreadable models.yml fails every backend alike, Ollama's and LM Studio's too: Settings says so rather
				// than that oMLX has no provider. Otherwise there is no oMLX provider, which Settings says as well.
				const coded = errorInfoOf(e);
				if (e instanceof Error && coded?.code === "offlineModelsUnreadable")
					return { baseUrl: null, source: null, error: { ...coded, message: e.message } };
				return { baseUrl: null, source: null };
			}
		};
		return {
			mode: this.store.mode,
			lightModels: this.store.lightModels,
			offline: this.store.offline,
			mcpServers: Object.keys(files.mcpServers),
			mcpOff: Object.keys(files.mcpServers).filter((name) => !loads(files.mcpServers[name])),
			missingMcp: this.store.offline.mcp.filter((name) => !Object.hasOwn(files.mcpServers, name)),
			backends: { omlx: info("omlx"), ollama: info("ollama"), "lm-studio": info("lm-studio") },
			boot: this.boot,
			// Counted as the state is made (nothing waits between reading the settings and numbering them), so the numbers
			// are the order the server saw things in.
			rev: ++this.rev,
		};
	}

	private get modelsPath(): string {
		return join(this.cfg.agentDir, "models.yml");
	}

	/** The provider of `backend` as a Light process on a local server gets it: models.yml's entry with the address from Settings. */
	private provider(files: UserFiles, backend: Backend, settings: OfflineSettings = this.store.offline) {
		return offlineModels(files.modelsYaml, this.modelsPath, backend, settings.baseUrls[backend]);
	}

	/**
	 * Apply a settings change. Light running on a local server (choosing it, choosing Light while it is the models, or
	 * another backend while Light uses it) needs the backend's provider in models.yml (oMLX; the others have one of their
	 * own), not the backend itself running. While Full is the mode the settings of the local server are only kept: Settings
	 * says what is missing, and choosing Light is the moment it is refused.
	 */
	update(patch: { mode?: unknown; lightModels?: unknown; offline?: unknown }): ModeState {
		const before = { mode: this.store.mode, lightModels: this.store.lightModels, backend: this.store.offline.backend };
		// A value that is none is refused by the store, whole, with the sentence that says what it must be.
		const mode = isMode(patch.mode) ? patch.mode : before.mode;
		const lightModels = isLightModels(patch.lightModels) ? patch.lightModels : before.lightModels;
		if (mode === "light" && lightModels === "local") {
			const next = mergeOffline(this.store.offline, patch.offline);
			if (before.mode !== "light" || before.lightModels !== "local" || next.backend !== before.backend)
				this.provider(readUserFiles(this.cfg.agentDir), next.backend, next);
		}
		const changed = this.store.update(patch);
		const state = this.state();
		if (changed) for (const fn of this.listeners) fn(state);
		return state;
	}

	/** The settings file was replaced under the running server (an import): read it again, and tell the pages. */
	reload(): void {
		const fresh = new ModeStore(this.cfg.dataDir);
		this.store.mode = fresh.mode;
		this.store.lightModels = fresh.lightModels;
		this.store.offline = fresh.offline;
		const state = this.state();
		for (const fn of this.listeners) fn(state);
	}

	async plan(req: LaunchRequest): Promise<LaunchPlan> {
		if (req.mode === "full") return FULL;
		return this.serial(() => (this.store.lightModels === "local" ? this.planOffline(req) : this.planYours()));
	}

	private serial<T>(work: () => Promise<T>): Promise<T> {
		const run = this.chain.then(work, work);
		this.chain = run.catch(() => {});
		return run;
	}

	/** Light with a local server's models: every model role on that server, and only what Light loads. */
	private async planOffline(req: LaunchRequest): Promise<LaunchPlan> {
		const settings = this.store.offline;
		const { backend } = settings;
		const foreign = foreignModelFlag(req.args, backend);
		if (foreign)
			throw new OfflineError(
				`Light mode on ${BACKEND_NAMES[backend]} runs on ${BACKEND_NAMES[backend]} models only, but ${foreign.flag} ${foreign.value} selects another one. Remove the flag, or switch to Full, or to Light with your own models.`,
				"offlineFlagForeignModel",
				{ backend, flag: foreign.flag, value: foreign.value },
			);
		const user = readUserFiles(this.cfg.agentDir);
		const { yaml, provider } = this.provider(user, backend);
		const model = chooseModel(backend, settings.model, await queryBackend(backend, provider));
		// The process's own directory, which nothing changes once it is made (see `writeOfflineAgent`): its name tells
		// the files it was started with, so an unused process started with other ones is not handed to a new chat.
		const { dir } = writeOfflineAgent({
			root: this.root,
			agentDir: this.cfg.agentDir,
			sessionsDir: this.cfg.sessionsDir,
			settings,
			model,
			user,
			modelsYaml: yaml,
		});
		const args = ["--tools", settings.tools.join(",")];
		// omp restores a session's own model, and a model of another provider is one a Light process on a local server must
		// not use: it would do so whenever that provider has credentials in the environment.
		if (req.resume && !selectsModel(req.args)) {
			const used = await this.savedModels(req.resume);
			if (used?.some((m) => !m.startsWith(`${backend}/`))) args.push("--model", model);
		}
		return { mode: "light", lightModels: "local", args, env: { PI_CODING_AGENT_DIR: dir } };
	}

	/**
	 * Light with the user's own models: their models, model roles and logins, as Full has them, and only what Light loads
	 * restricted. No local server is asked, and no model is chosen or forced: a resumed conversation keeps the one it ran on.
	 */
	private planYours(): Promise<LaunchPlan> {
		const settings = this.store.offline;
		const { dir } = writeYoursAgent({
			root: this.root,
			agentDir: this.cfg.agentDir,
			sessionsDir: this.cfg.sessionsDir,
			settings,
			user: readUserFiles(this.cfg.agentDir),
			configYaml: readUserConfig(this.cfg.agentDir),
		});
		return Promise.resolve({
			mode: "light",
			lightModels: "yours",
			args: ["--tools", settings.tools.join(",")],
			env: { PI_CODING_AGENT_DIR: dir },
		});
	}

	/** Remove the agent directories that no process uses; `inUse`: those of the running and of the paused ones. */
	collect(inUse: readonly string[], now?: number): string[] {
		return collectOfflineAgents(this.root, inUse, now);
	}

	/** The models `backend` (default: the selected one) serves now (`GET <baseUrl>/models`). */
	async backendModels(backend: Backend = this.store.offline.backend): Promise<BackendModels> {
		const { provider } = this.provider(readUserFiles(this.cfg.agentDir), backend);
		return { backend, baseUrl: shown(provider.baseUrl), models: (await queryBackend(backend, provider)) ?? [] };
	}

	/** The models the selected backend serves, shaped like omp's own model list (what the resume dialog offers instead of it). */
	async modelInfos(): Promise<{ provider: string; id: string; name: string }[]> {
		const { backend, models } = await this.backendModels();
		return models.map((id) => ({ provider: backend, id, name: id }));
	}

	// ------------------------------------------------------------------ context measurement

	/** A fresh process of each mode (Light as it is set up now), measured. A measurement is kept until what it depends on changes. */
	async context(force = false): Promise<ContextReport> {
		const [full, light] = await Promise.all([this.measured("full", force), this.measured("light", force)]);
		return { full, light };
	}

	private async measured(side: Mode, force: boolean): Promise<Measured> {
		try {
			const files = readUserFiles(this.cfg.agentDir);
			const fp = await this.fingerprint(side, files);
			const saved = this.saved[side];
			if (!force && saved?.fp === fp) return saved.value;
			return await this.measurements.request(side, fp, (signal) => this.measure(side, files, fp, signal));
		} catch (e) {
			return failedMeasure(e);
		}
	}

	private async measure(side: Mode, files: UserFiles, fp: string, signal: AbortSignal): Promise<Measured> {
		let breakdown: ContextBreakdown;
		try {
			if (side === "full") {
				breakdown = await this.measureProcess({
					bin: this.cfg.ompBin,
					args: [],
					servers: Object.keys(files.mcpServers).filter((name) => loads(files.mcpServers[name])),
					signal,
				});
			} else {
				const plan = await this.plan({ resume: null, args: [], mode: "light" });
				const servers = this.store.offline.mcp.filter(
					(name) => Object.hasOwn(files.mcpServers, name) && loads(files.mcpServers[name]),
				);
				breakdown = await this.measureProcess({
					bin: this.cfg.ompBin,
					args: plan.args,
					env: plan.env,
					servers,
					signal,
				});
			}
		} catch (e) {
			return failedMeasure(e);
		}
		const value: Measured & { ok: true } = { at: Date.now(), ok: true, breakdown };
		// Replaced while it ran: these are the numbers of what is no longer asked for.
		if (!signal.aborted) {
			this.saved[side] = { fp, value };
			this.saveSaved();
		}
		return value;
	}

	/**
	 * What `omp --version` says of the omp that is installed now. It is asked again when the program is not the one it was
	 * asked of (an install or an update, in the app or in a terminal, replaces it or the link to it): a measurement made
	 * with another omp is not this omp's, and its numbers (omp's own prompt and tool descriptions) change between
	 * releases. An answer that is "unknown" is not kept.
	 */
	private ompVersionNow(): Promise<string> {
		const key = binarySignature(this.cfg.ompBin);
		const known = this.version;
		if (known?.key === key) return known.value;
		const asked = { key, value: ompVersion(this.cfg.ompBin).catch(() => "unknown") };
		this.version = asked;
		void asked.value.then((v) => {
			if (v === "unknown" && this.version === asked) this.version = null;
		});
		return asked.value;
	}

	/**
	 * What a measurement depends on: omp itself, and for each mode the settings and files that shape a process. Light on a
	 * local server also depends on the model it will run (the first one the backend serves, when none is chosen), whose
	 * `contextWindow` is in its models.yml entry; Light on the user's own models, on their config.yml and models.yml, which
	 * its process is built from.
	 */
	private async fingerprint(side: Mode, files: UserFiles): Promise<string> {
		const version = await this.ompVersionNow();
		const dir = this.cfg.agentDir;
		const skills = treeSignature(join(dir, "skills"));
		if (side === "full")
			return digest([
				version,
				signature(join(dir, "mcp.json")),
				signature(join(dir, "config.yml")),
				signature(this.modelsPath),
				signature(join(dir, "AGENTS.md")),
				skills,
			]);
		const settings = this.store.offline;
		const servers = Object.fromEntries(
			settings.mcp
				.filter((name) => Object.hasOwn(files.mcpServers, name))
				.map((name) => [name, files.mcpServers[name]]),
		);
		if (this.store.lightModels === "yours")
			return digest([
				version,
				"yours",
				{ mcp: settings.mcp, tools: settings.tools, skills: settings.skills, agentsMd: settings.agentsMd },
				signature(join(dir, "config.yml")),
				signature(this.modelsPath),
				servers,
				settings.agentsMd ? files.agentsMd : null,
				settings.skills.length ? skills : null,
			]);
		const { backend } = settings;
		const { yaml, provider } = this.provider(files, backend);
		let model: string | null;
		try {
			model = chooseModel(backend, settings.model, await queryBackend(backend, provider));
		} catch {
			// the backend cannot say (down, or the chosen model is not served): measuring reports why.
			model = settings.model;
		}
		return digest([
			version,
			"local",
			settings,
			model,
			yaml,
			servers,
			settings.agentsMd ? files.agentsMd : null,
			settings.skills.length ? skills : null,
		]);
	}

	private loadSaved(): void {
		try {
			const doc: unknown = JSON.parse(readFileSync(this.cacheFile, "utf8"));
			if (!isRecord(doc)) return;
			// A measurement saved by an earlier version (`online`, `offline`) is not read: it is measured again.
			for (const side of ["full", "light"] as const) {
				const entry = doc[side];
				if (isRecord(entry) && typeof entry.fp === "string" && isMeasured(entry.value))
					this.saved[side] = { fp: entry.fp, value: entry.value };
			}
		} catch {
			// nothing saved yet, or not readable: measure again
		}
	}

	private saveSaved(): void {
		const tmp = `${this.cacheFile}.${process.pid}.tmp`;
		try {
			writeFileSync(tmp, JSON.stringify(this.saved), { mode: 0o600 });
			renameSync(tmp, this.cacheFile);
		} catch {
			// the measurement is still good for this run
		}
	}
}

/** A measurement that failed: the message, and the error's code and parameters when the page can word it itself. */
function failedMeasure(e: unknown): Measured {
	const errorInfo = errorInfoOf(e);
	return {
		at: Date.now(),
		ok: false,
		error: e instanceof Error ? e.message : String(e),
		...(errorInfo && { errorInfo }),
	};
}

/** The HTTP side: `/api/mode`, `/api/offline/models`, and `POST /api/offline/context` (it runs a process of each mode: a read it is not). */
export function createModeApi(
	modes: ModeService,
	respond: {
		json: (data: unknown, status?: number) => Response;
		fail: (error: string, status?: number, info?: ErrorInfo) => Response;
	},
): (req: Request, url: URL) => Promise<Response> {
	const { json, fail } = respond;
	return async (req, url) => {
		try {
			switch (url.pathname) {
				case "/api/mode": {
					if (req.method !== "POST") return json(modes.state());
					const body: unknown = await req.json().catch(() => null);
					if (!isRecord(body)) return fail("A JSON object is required");
					const unknown = Object.keys(body).find((k) => k !== "mode" && k !== "lightModels" && k !== "offline");
					if (unknown) return fail(`Unknown field: ${unknown}`);
					return json(modes.update(body));
				}
				case "/api/offline/models": {
					const backend = url.searchParams.get("backend");
					if (backend !== null && !isBackend(backend)) return fail(`Unknown backend: ${backend}`);
					return json(await modes.backendModels(backend ?? undefined));
				}
				case "/api/offline/context":
					if (req.method !== "POST") return fail("POST required", 405);
					return json(await modes.context(url.searchParams.get("force") === "1"));
			}
			return fail("Not found", 404);
		} catch (e) {
			// The code and parameters go with the English sentence: the page words the error itself.
			if (e instanceof SettingsError) return fail(e.message, 400, errorInfoOf(e) ?? undefined);
			// Not entering the mode is the caller's doing; a backend that does not answer is not.
			if (e instanceof OfflineError)
				return fail(e.message, req.method === "POST" ? 400 : 502, errorInfoOf(e) ?? undefined);
			return fail(e instanceof Error ? e.message : String(e), 500);
		}
	};
}
