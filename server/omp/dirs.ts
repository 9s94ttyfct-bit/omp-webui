import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PlatformId } from "../../shared/platform.ts";
import { platformId } from "../platform/capabilities.ts";

/** Where omp keeps what the server reads of it, for one agent directory or profile. */
export interface OmpDirs {
	/** omp's config root: `<home>/<PI_CONFIG_DIR, else .omp>`. */
	configRoot: string;
	/** The agent directory: `PI_CODING_AGENT_DIR`, else `<config root>/agent` (a profile's: `<config root>/profiles/<name>/agent`). */
	agentDir: string;
	/** Where omp writes the conversations. */
	sessionsDir: string;
	/** Where omp keeps its memories (`mnemopi/` below it). */
	memoriesDir: string;
}

/** The platforms where omp follows the XDG variables (`xdgPlatform` in its `DirResolver`, 18.22 and 19 alike): not Windows. */
export const XDG_PLATFORMS: readonly PlatformId[] = ["linux", "darwin"];

/**
 * omp's directories as omp 18.x decides them (`DirResolver` in packages/utils/src/dirs.ts): the config root is a folder
 * of the home named by `PI_CONFIG_DIR` (else `.omp`), the agent directory `PI_CODING_AGENT_DIR` (ignored for a profile)
 * or the default one under the root. Only while the agent directory is the default one, the XDG layout
 * (`omp config init-xdg`) takes over: an existing `$XDG_DATA_HOME/omp` (a profile's `…/omp/profiles/<name>`) holds the
 * conversations, an existing `$XDG_STATE_HOME/omp` the memories. The server's omp processes inherit its environment, so
 * they write where this says (#303).
 */
export function ompDirs(
	env: Readonly<Record<string, string | undefined>>,
	home: string,
	profile?: string,
	platform: PlatformId = platformId,
): OmpDirs {
	const configRoot = join(home, env.PI_CONFIG_DIR || ".omp");
	const root = profile ? join(configRoot, "profiles", profile) : configRoot;
	const standard = join(root, "agent");
	const override = profile ? undefined : env.PI_CODING_AGENT_DIR;
	const agentDir = override ? resolve(override) : standard;
	// omp compares the paths as written (resolved, not followed through links).
	const xdg = (key: "XDG_DATA_HOME" | "XDG_STATE_HOME"): string | null => {
		const base = env[key];
		if (agentDir !== standard || !base || !XDG_PLATFORMS.includes(platform)) return null;
		const dir = profile ? join(base, "omp", "profiles", profile) : join(base, "omp");
		return existsSync(dir) ? dir : null;
	};
	return {
		configRoot,
		agentDir,
		sessionsDir: join(xdg("XDG_DATA_HOME") ?? agentDir, "sessions"),
		memoriesDir: join(xdg("XDG_STATE_HOME") ?? agentDir, "memories"),
	};
}
