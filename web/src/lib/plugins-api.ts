import { isRecord } from "@shared/guards.ts";
import type { McpAdded, McpAddRequest, McpSearch } from "@shared/mcp-registry.ts";
import type {
	PluginCheck,
	PluginJob,
	PluginJobAction,
	PluginReload,
	PluginScope,
	PluginSetting,
	PluginsData,
	SkillFile,
	SkillSearch,
	SkillSwitchScope,
	SkillsData,
	UpdatesState,
} from "@shared/plugins.ts";

/**
 * `/api/plugins*`: omp's plugins, read and changed with omp's own CLI on the computer omp-webui runs on (see
 * `server/omp/plugins.ts`). Every request names the folder omp runs in (`cwd`; none: the home folder).
 */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, init);
	const body: unknown = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(isRecord(body) && typeof body.error === "string" ? body.error : res.statusText);
	return body as T;
}

const query = (params: Record<string, string | null>) => {
	const q = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
	const s = q.toString();
	return s ? `?${s}` : "";
};

const post = <T>(path: string, body: Record<string, unknown>) =>
	request<T>(path, {
		method: "POST",
		headers: { "content-type": "application/json", "x-omp-webui": "1" },
		body: JSON.stringify(body),
	});

/** What a job is asked with: its action and that action's arguments. */
export type JobRequest = { action: PluginJobAction } & Record<string, unknown>;

export const pluginsApi = {
	list: (cwd: string | null) => request<PluginsData>(`/api/plugins${query({ cwd })}`),
	doctor: (cwd: string | null) => request<{ checks: PluginCheck[] }>(`/api/plugins/doctor${query({ cwd })}`),
	config: (name: string, cwd: string | null) =>
		request<{ settings: PluginSetting[] }>(`/api/plugins/config${query({ name, cwd })}`),
	setEnabled: (id: string, scope: PluginScope | null, enabled: boolean, cwd: string | null) =>
		post<{ reloads: PluginReload[] }>("/api/plugins/enable", { id, scope, enabled, cwd }),
	setFeatures: (name: string, features: string[], cwd: string | null) =>
		post<{ reloads: PluginReload[] }>("/api/plugins/features", { name, features, cwd }),
	/** `value` null: the setting is taken off (its default applies). */
	setConfig: (name: string, key: string, value: string | null, cwd: string | null) =>
		post<{ settings: PluginSetting[]; reloads: PluginReload[] }>("/api/plugins/config", { name, key, value, cwd }),
	startJob: (job: JobRequest, cwd: string | null) =>
		post<{ job: PluginJob }>("/api/plugins/jobs", { ...job, cwd }).then((r) => r.job),
	job: (id: string) => request<{ job: PluginJob }>(`/api/plugins/jobs/${encodeURIComponent(id)}`).then((r) => r.job),
	/** The job running now, if any (a page opened while one runs follows it). */
	running: () => request<{ running: PluginJob | null }>("/api/plugins/jobs").then((r) => r.running),
	/** Every skill omp finds, on and off, for the folder (`omp skill list --json` and the `disabledExtensions` lists). */
	skills: (cwd: string | null) => request<SkillsData>(`/api/plugins/skills${query({ cwd })}`),
	/** Skills on or off in every folder without a list of its own (`global`), or in the project folder `cwd`. */
	setSkillsEnabled: (names: string[], enabled: boolean, scope: SkillSwitchScope, cwd: string | null) =>
		post<SkillsData>("/api/plugins/skills/enable", { names, enabled, scope, cwd }),
	/** The project folder's own list taken out: the global one applies there again. */
	globalSkillsHere: (cwd: string) => post<SkillsData>("/api/plugins/skills/use-global", { cwd }),
	/** A listed skill's `SKILL.md`, read only. */
	skillFile: (name: string, cwd: string | null) =>
		request<SkillFile>(`/api/plugins/skills/file${query({ name, cwd })}`),
	/** omp's skill registry (`omp skill search`). */
	searchSkills: (q: string, cwd: string | null) =>
		request<SkillSearch>(`/api/plugins/skills/search${query({ q, cwd })}`),
	/** The official MCP Registry, searched by the server; `cursor`: the next page. */
	searchMcp: (q: string, cursor: string | null, cwd: string | null) =>
		request<McpSearch>(`/api/plugins/mcp/search${query({ q, cursor, cwd })}`),
	/** Add one way of running a registry server to the user's `mcp.json`. */
	addMcp: (add: McpAddRequest, cwd: string | null) => post<McpAdded>("/api/plugins/mcp", { ...add, cwd }),
	/** The last update check, and the automatic update. */
	updates: () => request<UpdatesState>("/api/plugins/updates"),
	/** A check starts (marketplaces refreshed first); ask `updates` again until `checking` is false. */
	checkUpdates: () => post<UpdatesState>("/api/plugins/updates/check", {}),
};
