import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ensurePrivateDir } from "./private.ts";

/**
 * Runtime configuration. Everything omp-owned is located through omp's own
 * documented environment (`PI_CODING_AGENT_DIR`), so the UI follows whatever
 * agent directory the spawned omp processes use.
 */
export interface Config {
	ompBin: string;
	agentDir: string;
	sessionsDir: string;
	dataDir: string;
	host: string;
	port: number;
	distDir: string;
	/** On a taken port, take a free one instead (and clean up this data dir's own stale server). */
	autoPort: boolean;
	/** Exit when this process (the macOS app shell) is gone. */
	parentPid: number | null;
}

function canonical(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return resolve(p);
	}
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
	const agentDir = canonical(env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent"));
	const dataDir = resolve(env.OMP_WEBUI_DATA_DIR ?? join(homedir(), ".omp-webui"));
	ensurePrivateDir(dataDir);
	// Loading the configuration creates nothing inside omp's agent dir; a missing sessions dir lists as empty.
	const sessionsDir = join(agentDir, "sessions");
	return {
		ompBin: env.OMP_BIN ?? "omp",
		agentDir,
		sessionsDir: canonical(sessionsDir),
		dataDir,
		host: env.OMP_WEBUI_HOST ?? "127.0.0.1",
		port: Number(env.OMP_WEBUI_PORT ?? 7878),
		// Built web assets; the macOS app ships them inside its bundle and passes the path.
		distDir: resolve(env.OMP_WEBUI_DIST ?? join(import.meta.dir, "..", "dist", "web")),
		autoPort: env.OMP_WEBUI_AUTO_PORT === "1",
		parentPid: env.OMP_WEBUI_PARENT_PID ? Number(env.OMP_WEBUI_PARENT_PID) : null,
	};
}
