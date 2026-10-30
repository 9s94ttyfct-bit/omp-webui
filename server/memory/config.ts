import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import { ConfigRead } from "../omp/config-read.ts";
import { QUICK_MS, run } from "../omp/run.ts";

/**
 * The settings of omp's that say where its memories are and how they are scoped, as `omp config list --json` prints them
 * (global config and omp's defaults: a folder's own `.omp/config.yml` is no part of a page that is about no folder).
 */
export interface MemorySettings {
	/** `memory.backend`: `off`, `local`, `hindsight`, `mnemopi` or `sharpshooter`; null when omp could not be asked. */
	backend: string | null;
	/** `mnemopi.scoping` (`global`, `per-project`, `per-project-tagged`); null when omp could not be asked. */
	scoping: string | null;
	/** `mnemopi.dbPath`, `~` expanded; null when it is not set (the store is in omp's agent directory). */
	dbPath: string | null;
	/** `dbPath` was set to a path that is not absolute: omp resolves it from the folder it runs in, which no page knows. */
	relativePath: boolean;
	/** `mnemopi.bank`: the base name of the shared bank; null when it is not set. */
	bank: string | null;
}

/** What omp's defaults are, for a page whose omp could not be asked. */
export const UNKNOWN_SETTINGS: MemorySettings = {
	backend: null,
	scoping: null,
	dbPath: null,
	relativePath: false,
	bank: null,
};

const settingOf = (doc: Record<string, unknown>, key: string): string | null => {
	const entry = doc[key];
	const value = isRecord(entry) ? entry.value : undefined;
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
};

export function parseSettings(doc: unknown): MemorySettings | null {
	if (!isRecord(doc)) return null;
	const raw = settingOf(doc, "mnemopi.dbPath");
	const expanded = raw === "~" ? homedir() : raw?.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
	return {
		backend: settingOf(doc, "memory.backend"),
		scoping: settingOf(doc, "mnemopi.scoping"),
		dbPath: expanded !== null && isAbsolute(expanded) ? expanded : null,
		relativePath: expanded !== null && !isAbsolute(expanded),
		bank: settingOf(doc, "mnemopi.bank"),
	};
}

/**
 * The settings, asked of omp once per state of its `config.yml` (a start of omp costs about a tenth of a second: a page that
 * lists and searches asks on every keystroke). Null when omp cannot say; that answer is not kept.
 */
export function memorySettings(bin: string, agentDir: string, dataDir: string): ConfigRead<MemorySettings> {
	return new ConfigRead(join(agentDir, "config.yml"), async () => {
		try {
			const ran = await run([bin, "config", "list", "--json"], {
				cwd: dataDir,
				env: { PI_CODING_AGENT_DIR: agentDir, NO_COLOR: "1" },
				timeoutMs: QUICK_MS,
			});
			if (ran.code !== 0) return null;
			return parseSettings(JSON.parse(ran.stdout));
		} catch {
			return null;
		}
	});
}
