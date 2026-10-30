import { expect } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExport } from "../../server/migrate/export.ts";
import { ImportArchive, type ImportEnv, type ImportHooks } from "../../server/migrate/import.ts";
import type { Locations } from "../../server/migrate/layout.ts";
import type { ImportRequest, ImportSummary, MigrateDataCategoryId, MigrateProgress } from "../../shared/migrate.ts";
import type { Machine } from "./migrate-world.ts";

/** Export and import as the server does them, between made-up machines (see `migrate-world.ts`). */

export const locationsOf = (m: Machine): Locations => ({
	home: m.home,
	agentDir: m.agentDir,
	dataDir: m.dataDir,
	sessionDirs: m.sessionDirs,
});

const never = new AbortController().signal;

export const hooks = (over: Partial<ImportHooks> = {}): ImportHooks => ({
	busy: () => 0,
	endIdle: async () => 0,
	openElsewhere: async () => false,
	...over,
});

export function scratch(): { root: string; remove(): void; exportOf: typeof exportOf; importInto: typeof importInto } {
	const root = mkdtempSync(join(tmpdir(), "ompw-migrate-"));
	let n = 0;
	async function exportOf(
		m: Machine,
		options: {
			credentials?: boolean;
			wholeFile?: boolean;
			categories?: MigrateDataCategoryId[];
			password?: string;
			signal?: AbortSignal;
			onProgress?: (p: Partial<MigrateProgress>) => void;
		} = {},
	) {
		const out = join(root, `archive-${n++}.ompw`);
		const made = await runExport({
			loc: locationsOf(m),
			host: "old-mac",
			user: "jdoe",
			ompVersion: "18.12.5",
			serverVersion: "0.11.9",
			credentials: options.credentials ?? false,
			wholeFile: options.wholeFile,
			categories: options.categories,
			password: options.password,
			out,
			tmp: join(root, `tmp-${n++}`),
			signal: options.signal ?? never,
			onProgress: options.onProgress ?? (() => {}),
		});
		return { file: out, ...made };
	}
	async function importInto(
		m: Machine,
		file: string,
		request: Partial<ImportRequest> & { archivePassword?: string } = {},
		over: Partial<ImportHooks> = {},
		versions: { omp?: string; webui?: string } = {},
		envOver: Partial<ImportEnv> = {},
	): Promise<ImportSummary> {
		const { archivePassword, ...req } = request;
		const archive = await ImportArchive.open(file, { password: archivePassword });
		try {
			await archive.verify({ signal: never, onProgress: () => {} });
			const env = {
				loc: locationsOf(m),
				ompVersion: versions.omp ?? "18.12.5",
				serverVersion: versions.webui ?? "0.11.9",
				backups: join(m.dataDir, "migration-backups"),
				tmp: join(root, `import-tmp-${n++}`),
				signal: never,
				onProgress: () => {},
				hooks: hooks(over),
				...envOver,
			};
			const running = await archive.prepare({ mode: "merge", credentials: false, ...req }, env);
			return await running.run();
		} finally {
			await archive.close();
		}
	}
	return { root, remove: () => rmSync(root, { recursive: true, force: true }), exportOf, importInto };
}

export const text = (...p: string[]): string => readFileSync(join(...p), "utf8");

/**
 * Every file under `dir` with a fingerprint of its content, to say whether anything changed. SQLite's `-shm` is left out:
 * it is the index of the `-wal` in shared memory, and a reader of the database touches it without changing any data.
 * A running server removes files of its own while this walks (a SQLite `-journal`, a finished upload): one that is gone by
 * the time it is read is not in the tree, and a file that was in `before` and is not in `after` is still found by the caller.
 */
export function treeOf(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (d: string, rel: string): void => {
		try {
			for (const e of readdirSync(d, { withFileTypes: true })) {
				const r = rel ? `${rel}/${e.name}` : e.name;
				if (e.isDirectory()) walk(join(d, e.name), r);
				else if (e.name.endsWith("-shm")) continue;
				else if (e.isSymbolicLink()) out[r] = `link:${readlinkSync(join(d, e.name))}`;
				else out[r] = `${Bun.hash(readFileSync(join(d, e.name))).toString(36)}`;
			}
		} catch (e) {
			if ((e as { code?: string }).code !== "ENOENT") throw e;
		}
	};
	if (existsSync(dir)) walk(dir, "");
	return out;
}

/**
 * Everything that was in `before` is, byte for byte, still in `after`, except what a running server rewrites on its own
 * whatever is asked of it: its SQLite caches (`index.db` and the full-text `index.search.db`, with their `-wal`; the
 * background indexer fills them at its own pace, so how far it has got between two snapshots depends on machine load),
 * its pid record, and the upload area itself.
 */
export function expectUntouched(before: Record<string, string>, after: Record<string, string>): void {
	for (const k of Object.keys(before)) {
		if (/(^|\/)index(\.search)?\.db/.test(k) || k.endsWith(".pid") || k.includes("/migrate/")) continue;
		expect(after[k], k).toBe(before[k]);
	}
}
