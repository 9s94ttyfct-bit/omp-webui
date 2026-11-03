import { isRecord } from "@shared/guards.ts";
import type {
	PluginCheck,
	PluginJob,
	PluginJobAction,
	PluginReload,
	PluginScope,
	PluginSetting,
	PluginsData,
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
};
