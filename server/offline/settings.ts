import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodedError } from "../../shared/error-info.ts";
import { isRecord } from "../../shared/guards.ts";
import {
	BACKENDS,
	type Backend,
	classifyHost,
	DEFAULT_OFFLINE,
	isBackend,
	isLightModels,
	isMode,
	isThinkingLevel,
	type LightModels,
	type Mode,
	OFFLINE_TOOLS,
	type OfflineSettings,
} from "../../shared/offline.ts";

/**
 * A settings change that was refused. The message is English, for logs and API users; the page words the error from its
 * `code` and `params` (`shared/error-info.ts`), so what it shows never names a setting by its key path.
 */
export class SettingsError extends CodedError {}

const NAME = /^\S{1,100}$/;

/** A list of names (MCP servers, skills): non-blank, without whitespace, each once. */
function names(field: "mcp" | "skills" | "tools", v: unknown): string[] {
	if (!Array.isArray(v) || v.length > 200)
		throw new SettingsError(`${field} must be a list of names`, "settingsListInvalid", { field });
	const out = new Set<string>();
	for (const n of v) {
		if (typeof n !== "string" || !NAME.test(n))
			throw new SettingsError(`Invalid name in ${field}`, "settingsNameInvalid", { field });
		out.add(n);
	}
	return [...out];
}

/**
 * The address of a backend as omp is given it: http(s), a host with an optional port and path, none of the
 * credentials, query or fragment that would end up in messages. A bare host gets the `/v1` the OpenAI-compatible
 * API lives under; any other path is the user's own (a proxy in front of the server). Link-local addresses are
 * refused: cloud metadata services (credentials for the machine's role) answer there, and a model server never does.
 */
export function normalizeBaseUrl(backend: Backend, v: unknown): string {
	const invalid = new SettingsError(
		`baseUrls.${backend} must be an address like http://127.0.0.1:11434/v1`,
		"settingsAddressInvalid",
		{ backend },
	);
	if (typeof v !== "string" || v.length > 500) throw invalid;
	let url: URL;
	try {
		url = new URL(v.trim());
	} catch {
		throw invalid;
	}
	if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw invalid;
	if (classifyHost(url.hostname) === "link-local")
		throw new SettingsError(
			`baseUrls.${backend} is a link-local address (${url.hostname}), where no model server listens`,
			"settingsAddressLinkLocal",
			{ backend, host: url.hostname },
		);
	return `${url.origin}${url.pathname.replace(/\/+$/, "") || "/v1"}`;
}

/** `base` with the fields of `patch` replaced; a field that is not valid refuses the whole patch. */
export function mergeOffline(base: OfflineSettings, patch: unknown): OfflineSettings {
	if (patch === undefined) return base;
	if (!isRecord(patch)) throw new SettingsError("offline must be an object", "settingsOfflineShape");
	const out: OfflineSettings = { ...base, baseUrls: { ...base.baseUrls } };
	let modelGiven = false;
	for (const [key, value] of Object.entries(patch)) {
		switch (key) {
			case "backend":
				if (!isBackend(value))
					throw new SettingsError(`backend must be one of ${BACKENDS.join(", ")}`, "settingsBackendUnknown", {
						backends: BACKENDS.join(", "),
					});
				out.backend = value;
				break;
			case "baseUrls":
				if (!isRecord(value)) throw new SettingsError("baseUrls must be an object", "settingsBaseUrlsShape");
				for (const [backend, url] of Object.entries(value)) {
					if (!isBackend(backend))
						throw new SettingsError(`Unknown backend: ${backend}`, "settingsBaseUrlsBackendUnknown", { backend });
					out.baseUrls[backend] = url === null ? null : normalizeBaseUrl(backend, url);
				}
				break;
			case "model":
				if (value !== null && !(typeof value === "string" && /^\S{1,200}$/.test(value)))
					throw new SettingsError("model must be null or <backend>/<model id>", "settingsModelShape");
				out.model = value;
				modelGiven = true;
				break;
			case "thinking":
				if (!isThinkingLevel(value)) throw new SettingsError("Unknown thinking level", "settingsThinkingUnknown");
				out.thinking = value;
				break;
			case "mcp":
				out.mcp = names("mcp", value);
				break;
			case "skills":
				out.skills = names("skills", value);
				break;
			case "tools": {
				const tools = names("tools", value);
				const unknown = tools.find((t) => !OFFLINE_TOOLS.includes(t));
				if (unknown) throw new SettingsError(`Unknown tool: ${unknown}`, "settingsToolUnknown", { tool: unknown });
				if (!tools.length) throw new SettingsError("Light mode needs at least one tool", "settingsToolsNone");
				out.tools = tools;
				break;
			}
			case "agentsMd":
				if (typeof value !== "boolean")
					throw new SettingsError("agentsMd must be true or false", "settingsAgentsMdShape");
				out.agentsMd = value;
				break;
			default:
				throw new SettingsError(`Unknown offline setting: ${key}`, "settingsFieldUnknown", { setting: key });
		}
	}
	// A model is one of the chosen backend's. Choosing another backend leaves the old one's model behind.
	const prefix = `${out.backend}/`;
	if (out.model !== null && !(out.model.startsWith(prefix) && out.model.length > prefix.length)) {
		if (modelGiven)
			throw new SettingsError(`model must be null or ${prefix}<model id>`, "settingsModelOfBackend", {
				backend: out.backend,
			});
		out.model = null;
	}
	return out;
}

/** The version `mode.json` is written in. */
export const MODE_FILE_VERSION = 2;

/** What `mode.json` holds, once read. */
export interface SavedMode {
	mode: Mode;
	lightModels: LightModels;
	offline: OfflineSettings;
	/** The file was from before version 2 (it was read as version 1 and migrated): it is written again in the new one. */
	migrated: boolean;
}

/**
 * Read what `mode.json` held. Version 2 says `mode` as `full` or `light` and `lightModels` as `yours` or `local`. A file
 * with no `version` is version 1, from when the modes were Online and Offline: Offline becomes Light with a local server's
 * models (what it ran on), Online becomes Full (with the default Light models, which a version 1 file had no word for). The
 * backend, addresses, model and the rest of the settings are kept as they were. A file this version cannot make sense of
 * throws: the caller takes the defaults.
 */
export function readModeFile(saved: Record<string, unknown>): SavedMode {
	// A file from before the backend choice has no `backend`: oMLX, which is what it was written for (`mergeOffline`).
	const offline = mergeOffline(DEFAULT_OFFLINE, saved.offline);
	if (saved.version === undefined) {
		const offlineMode = saved.mode === "offline";
		return {
			mode: offlineMode ? "light" : "full",
			lightModels: offlineMode ? "local" : "yours",
			offline,
			migrated: true,
		};
	}
	return {
		mode: isMode(saved.mode) ? saved.mode : "full",
		lightModels: isLightModels(saved.lightModels) ? saved.lightModels : "yours",
		offline,
		migrated: false,
	};
}

/**
 * The mode new conversations start in, what Light's models are and the Light settings, as JSON in the web UI's own data
 * dir (like pins and favorite models): the choice outlives the server, and every browser tab sees the same one.
 */
export class ModeStore {
	private readonly file: string;
	mode: Mode = "full";
	lightModels: LightModels = "yours";
	offline: OfflineSettings = structuredClone(DEFAULT_OFFLINE);

	constructor(dataDir: string) {
		this.file = join(dataDir, "mode.json");
		if (!existsSync(this.file)) return;
		try {
			const saved: unknown = JSON.parse(readFileSync(this.file, "utf8"));
			if (!isRecord(saved)) return;
			// A file this version cannot make sense of means the defaults, not a server that will not start.
			const read = readModeFile(saved);
			this.mode = read.mode;
			this.lightModels = read.lightModels;
			this.offline = read.offline;
			if (read.migrated) {
				try {
					this.write();
				} catch {
					// Not written now: it is read as version 1 again next time, and the next change writes it.
				}
			}
		} catch {
			this.mode = "full";
			this.lightModels = "yours";
			this.offline = structuredClone(DEFAULT_OFFLINE);
		}
	}

	private write(): void {
		const tmp = `${this.file}.${process.pid}.tmp`;
		const { mode, lightModels, offline } = this;
		writeFileSync(tmp, `${JSON.stringify({ version: MODE_FILE_VERSION, mode, lightModels, offline }, null, 2)}\n`, {
			mode: 0o600,
		});
		renameSync(tmp, this.file);
	}

	/** Apply a change (all of it or none) and save it; true when the mode, Light's models or any of the Light settings changed. */
	update(patch: { mode?: unknown; lightModels?: unknown; offline?: unknown }): boolean {
		let mode = this.mode;
		if (patch.mode !== undefined) {
			if (!isMode(patch.mode)) throw new SettingsError("mode must be full or light", "settingsModeUnknown");
			mode = patch.mode;
		}
		let lightModels = this.lightModels;
		if (patch.lightModels !== undefined) {
			if (!isLightModels(patch.lightModels))
				throw new SettingsError("lightModels must be yours or local", "settingsLightModelsUnknown");
			lightModels = patch.lightModels;
		}
		const offline = mergeOffline(this.offline, patch.offline);
		const changed =
			mode !== this.mode ||
			lightModels !== this.lightModels ||
			JSON.stringify(offline) !== JSON.stringify(this.offline);
		this.mode = mode;
		this.lightModels = lightModels;
		this.offline = offline;
		this.write();
		return changed;
	}
}
