import { request, wrote } from "./model-config.ts";

/**
 * The writes only Settings › Presets makes on a preset, each answered with the global configuration as it is after. The
 * composer's menu saves a preset and sets the default (`modelConfig`); these are kept apart so that the first page does not
 * carry them.
 */
export const presetActions = {
	rename: (from: string, to: string) => request("/api/model-config/preset/rename", { from, to }).then(wrote),
	duplicate: (from: string, to: string) => request("/api/model-config/preset/duplicate", { from, to }).then(wrote),
	remove: (name: string) => request("/api/model-config/preset/delete", { name }).then(wrote),
	apply: (name: string) => request("/api/model-config/preset/apply", { name }).then(wrote),
	/** Replaces the subagent models a preset carries (none: the preset carries none). */
	setAgents: (name: string, agentModelOverrides: Record<string, string>) =>
		request("/api/model-config/preset/agents", { name, agentModelOverrides }).then(wrote),
	/**
	 * Rewrites one preset's roles, default thinking level (null: the preset sets none) and subagent models in one write; the
	 * rest of its entry is kept.
	 */
	edit: (
		name: string,
		edit: {
			roles: Record<string, string>;
			defaultThinkingLevel: string | null;
			agentModelOverrides: Record<string, string>;
		},
	) => request("/api/model-config/preset/edit", { name, ...edit }).then(wrote),
};
