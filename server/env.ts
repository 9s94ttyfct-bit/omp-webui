/**
 * The environment a child process (omp, a terminal, git, gh) starts with: ours minus the `OMP_WEBUI_*` settings that
 * configure this server. They are not the child's to inherit — an omp that starts its own web UI from a conversation
 * would otherwise hop ports, share the data dir and token, and overwrite this server's pid file.
 */
export function childEnv(
	extra: Record<string, string | undefined> = {},
	base: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(base)) {
		if (!key.startsWith("OMP_WEBUI_")) env[key] = value;
	}
	return { ...env, ...extra };
}
