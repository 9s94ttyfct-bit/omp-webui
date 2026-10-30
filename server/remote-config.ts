import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_REMOTE_CONFIG, parseRemoteConfig, type RemoteConfig, RemoteConfigError } from "../shared/remote.ts";

/** Where the settings are: `<data dir>/remote.json`, or the file `OMP_WEBUI_REMOTE_CONFIG` names (what the specs use). */
export function remoteConfigPath(dataDir: string, env: Record<string, string | undefined> = process.env): string {
	return env.OMP_WEBUI_REMOTE_CONFIG || join(dataDir, "remote.json");
}

/**
 * The remote access settings (`RemoteConfig`), kept in one small file that only its owner may read: it says who may
 * come in from outside and by which tunnel.
 *
 * The file, not this object, is the truth: the part of the server that decides who is let in reads the same file, and a
 * person may edit it. So it is read again at every `read`, never remembered. A file that cannot be trusted (not JSON,
 * not settings, a field that does not fit) reads as the defaults — remote access off — and the next change keeps a copy
 * of it beside the file (`.damaged`) before it writes: a half-read file would be a way in nobody chose.
 */
export class RemoteStore {
	constructor(private readonly file: string) {}

	/** The settings as the file holds them; the defaults when there is no file, or none that can be trusted. */
	read(): RemoteConfig {
		return this.load() ?? { ...DEFAULT_REMOTE_CONFIG };
	}

	/** `changes` merged into the settings and written. Refused whole (`RemoteConfigError`) when the result would not be trustworthy. */
	patch(changes: Partial<RemoteConfig>): RemoteConfig {
		const loaded = this.load();
		const next = parseRemoteConfig({ ...(loaded ?? DEFAULT_REMOTE_CONFIG), ...changes });
		mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
		// What could not be trusted is kept, not written over.
		if (loaded === null) this.keepDamaged();
		// Written whole and moved into place: a crash mid-write leaves the old file, never half of one.
		const temporary = `${this.file}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, `${JSON.stringify(next, null, "\t")}\n`, { mode: 0o600 });
			renameSync(temporary, this.file);
		} catch (e) {
			rmSync(temporary, { force: true });
			throw e;
		}
		return next;
	}

	/** The settings; the defaults when there is no file; null when the file is there but cannot be trusted. */
	private load(): RemoteConfig | null {
		let text: string;
		try {
			text = readFileSync(this.file, "utf8");
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_REMOTE_CONFIG };
			console.warn(`omp-webui: ${this.file} cannot be read (${(e as Error).message}): remote access stays off`);
			return null;
		}
		try {
			return parseRemoteConfig(JSON.parse(text));
		} catch (e) {
			const why = e instanceof RemoteConfigError ? e.message : "it is not JSON";
			console.warn(`omp-webui: ${this.file} is not usable (${why}): remote access stays off`);
			return null;
		}
	}

	private keepDamaged(): void {
		try {
			renameSync(this.file, `${this.file}.damaged`);
		} catch (e) {
			console.warn(`omp-webui: could not keep a copy of ${this.file}: ${(e as Error).message}`);
		}
	}
}
