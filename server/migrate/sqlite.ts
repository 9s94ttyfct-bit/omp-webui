import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, existsSync, renameSync, rmSync } from "node:fs";
import type { PathMap } from "./rewrite.ts";

/**
 * omp's databases (`history.db`, `agent.db`, the memory banks) are in WAL mode and open in running processes: a file
 * copy of one is not a database (the newest changes are in `-wal`). A snapshot is made by SQLite itself (`VACUUM INTO`
 * from a read-only connection reads one consistent state while the writers go on), and an import changes a database only
 * through SQL or by putting a whole snapshot in place with the old `-wal` and `-shm` gone.
 */

const quote = (s: string): string => `'${s.replaceAll("'", "''")}'`;
const ident = (s: string): string => `"${s.replaceAll('"', '""')}"`;

/** A consistent copy of the database at `src`, written to `dest` (which must not exist). */
export function snapshotDb(src: string, dest: string): void {
	const db = new Database(src, { readonly: true });
	try {
		db.exec("PRAGMA busy_timeout = 5000");
		db.exec(`VACUUM INTO ${quote(dest)}`);
	} finally {
		db.close();
	}
	chmodSync(dest, 0o600);
}

function count(db: Database, sql: string): number {
	return db.query<{ n: number }, []>(sql).get()?.n ?? 0;
}

/** The names of the tables in `db` that are real ones (not SQLite's own, and not the shadow tables of a full-text index). */
function tablesOf(db: Database): string[] {
	const rows = db
		.query<{ name: string; sql: string | null }, []>(
			"SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
		)
		.all();
	const virtuals = rows.filter((r) => /CREATE\s+VIRTUAL/i.test(r.sql ?? "")).map((r) => r.name);
	return rows.filter((r) => !virtuals.some((v) => r.name.startsWith(`${v}_`))).map((r) => r.name);
}

function columnsOf(db: Database, table: string, schema = "main"): string[] {
	return db
		.query<{ name: string }, []>(`PRAGMA ${ident(schema)}.table_info(${ident(table)})`)
		.all()
		.map((c) => c.name);
}

/** The tables whose rows are logins; everything else in `agent.db` is usage, quota and cache state. */
const CREDENTIAL_TABLES = ["auth_credentials", "schema_version", "auth_schema_version", "auth_change_revision"];

/**
 * A snapshot of `agent.db` with only the logins in it (the other tables are emptied, their layout stays), written to
 * `dest`: usage records, quota windows and caches belong to the machine they were measured on.
 */
export function authSnapshot(src: string, dest: string): { credentials: number; providers: string[] } {
	snapshotDb(src, dest);
	const db = new Database(dest);
	try {
		db.exec("PRAGMA recursive_triggers = OFF");
		for (const t of tablesOf(db)) if (!CREDENTIAL_TABLES.includes(t)) db.exec(`DELETE FROM ${ident(t)}`);
		const providers = db
			.query<{ provider: string }, []>("SELECT DISTINCT provider FROM auth_credentials")
			.all()
			.map((r) => r.provider);
		const credentials = count(db, "SELECT COUNT(*) AS n FROM auth_credentials");
		db.exec("VACUUM");
		return { credentials, providers };
	} finally {
		db.close();
	}
}

/** How many bytes the logins of the `agent.db` at `path` are (0 when it cannot be read: it is not the archive's size to know). */
export function loginBytes(path: string): number {
	try {
		const db = new Database(path, { readonly: true });
		try {
			return count(
				db,
				"SELECT COALESCE(SUM(LENGTH(provider) + LENGTH(credential_type) + LENGTH(data)), 0) AS n FROM auth_credentials",
			);
		} finally {
			db.close();
		}
	} catch {
		return 0;
	}
}

export type RestoreResult = { restored: number; providers: string[] } | { skipped: "omp-older" | "absent" };

function authVersion(db: Database): number {
	return db.query<{ version: number }, []>("SELECT version FROM auth_schema_version WHERE id = 1").get()?.version ?? 0;
}

/**
 * The logins of `snapshot` (from `authSnapshot`) put into the `agent.db` at `dest`. Where there is none the snapshot
 * becomes it. Where there is one, logins it does not have are added (and in `replace` the archive's version of a login
 * both have wins); omp's own triggers keep its revision counter. A database that keeps logins in a newer layout than
 * this omp's is left alone.
 */
export function restoreAuth(dest: string, snapshot: string, mode: "merge" | "replace"): RestoreResult {
	const source = new Database(snapshot, { readonly: true });
	let sourceVersion: number;
	let providers: string[];
	let total: number;
	try {
		sourceVersion = authVersion(source);
		providers = source
			.query<{ provider: string }, []>("SELECT DISTINCT provider FROM auth_credentials")
			.all()
			.map((r) => r.provider);
		total = count(source, "SELECT COUNT(*) AS n FROM auth_credentials");
	} finally {
		source.close();
	}
	if (!existsSync(dest)) {
		copyFileSync(snapshot, dest);
		chmodSync(dest, 0o600);
		return { restored: total, providers };
	}
	const db = new Database(dest);
	try {
		db.exec("PRAGMA busy_timeout = 5000");
		const names = tablesOf(db);
		if (!names.includes("auth_credentials") || !names.includes("auth_schema_version")) return { skipped: "absent" };
		if (sourceVersion > authVersion(db)) return { skipped: "omp-older" };
		db.exec(`ATTACH DATABASE ${quote(snapshot)} AS archive`);
		const dstCols = columnsOf(db, "auth_credentials");
		const cols = columnsOf(db, "auth_credentials", "archive").filter((c) => c !== "id" && dstCols.includes(c));
		const same =
			"s.provider = d.provider AND s.credential_type = d.credential_type AND s.identity_key IS NOT NULL AND d.identity_key = s.identity_key";
		db.exec("BEGIN IMMEDIATE");
		try {
			if (mode === "replace") {
				// A login the archive has under an identity (an account) replaces the same account's here.
				const sets = cols
					.filter((c) => !["provider", "credential_type", "identity_key", "created_at"].includes(c))
					.map(
						(c) =>
							`${ident(c)} = (SELECT s.${ident(c)} FROM archive.auth_credentials s WHERE ${same.replaceAll("d.", "main.auth_credentials.")})`,
					);
				if (sets.length > 0) {
					db.exec(
						`UPDATE main.auth_credentials SET ${sets.join(", ")} WHERE identity_key IS NOT NULL AND EXISTS (SELECT 1 FROM archive.auth_credentials s WHERE ${same.replaceAll("d.", "main.auth_credentials.")})`,
					);
				}
			}
			db.exec(
				`INSERT INTO main.auth_credentials (${cols.map(ident).join(", ")}) SELECT ${cols.map((c) => `s.${ident(c)}`).join(", ")} FROM archive.auth_credentials s WHERE NOT EXISTS (SELECT 1 FROM main.auth_credentials d WHERE d.provider = s.provider AND d.credential_type = s.credential_type AND ((s.identity_key IS NOT NULL AND d.identity_key = s.identity_key) OR (s.identity_key IS NULL AND d.data = s.data)))`,
			);
			db.exec("COMMIT");
		} catch (e) {
			db.exec("ROLLBACK");
			throw e;
		}
		db.exec("DETACH DATABASE archive");
		return { restored: total, providers };
	} finally {
		db.close();
	}
}

/** Put the snapshot at `tmp` in place of the database at `dest`: its `-wal` and `-shm` describe the old file and go. */
export function replaceDbFile(dest: string, tmp: string): void {
	rmSync(`${dest}-wal`, { force: true });
	rmSync(`${dest}-shm`, { force: true });
	chmodSync(tmp, 0o600);
	renameSync(tmp, dest);
}

/** The DDL of `tables` (with their triggers and indexes) in `from` that `into` does not have yet, created in `into`. */
function ensureTables(into: Database, from: Database, tables: string[]): void {
	const have = new Set(tablesOf(into));
	for (const t of tables) {
		if (have.has(t)) continue;
		const rows = from
			.query<{ sql: string }, [string, string]>(
				"SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND tbl_name = ? AND name NOT LIKE 'sqlite_%' AND NOT (type = 'table' AND name != ?) ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END",
			)
			.all(t, t);
		for (const r of rows) into.exec(r.sql);
	}
}

/** The folders a prompt history (or a recap) was made in: every distinct `cwd` in the database at `path`. */
export function foldersOf(path: string): string[] {
	const db = new Database(path, { readonly: true });
	try {
		const out = new Set<string>();
		const have = new Set(tablesOf(db));
		for (const table of ["history", "session_recaps"]) {
			if (!have.has(table) || !columnsOf(db, table).includes("cwd")) continue;
			for (const r of db
				.query<{ v: string }, []>(`SELECT DISTINCT cwd AS v FROM ${ident(table)} WHERE cwd IS NOT NULL`)
				.all()) {
				out.add(r.v);
			}
		}
		return [...out];
	} finally {
		db.close();
	}
}

/** `cwd`-like columns of the database at `path` rewritten in place with `map`: one UPDATE per distinct old value. */
export function rewriteColumnsAt(path: string, columns: { table: string; column: string }[], map: PathMap): number {
	const db = new Database(path);
	try {
		let changed = 0;
		const have = new Set(tablesOf(db));
		for (const { table, column } of columns) {
			if (!have.has(table) || !columnsOf(db, table).includes(column)) continue;
			const rows = db
				.query<{ v: string }, []>(
					`SELECT DISTINCT ${ident(column)} AS v FROM ${ident(table)} WHERE ${ident(column)} IS NOT NULL`,
				)
				.all();
			const update = db.prepare(`UPDATE ${ident(table)} SET ${ident(column)} = ? WHERE ${ident(column)} = ?`);
			for (const { v } of rows) {
				const next = map.map(v);
				if (next !== v) {
					update.run(next, v);
					changed++;
				}
			}
		}
		return changed;
	} finally {
		db.close();
	}
}

/** What `mergeHistory` did. */
export interface HistoryMerge {
	prompts: number;
	titles: number;
	recaps: number;
	/** Rows changed or added by any statement: zero when the archive had nothing this database lacked. */
	changes: number;
}

/**
 * The prompt history, conversation titles and recaps of the snapshot at `archive` put into the `history.db` at `dest`
 * (made when it is not there). A prompt, or a title of a conversation, that is in both stays as it is here (in `replace`
 * the archive's wins); recaps are added when this Mac does not have the same one for that conversation.
 */
export function mergeHistory(dest: string, archive: string, mode: "merge" | "replace"): HistoryMerge {
	const db = new Database(dest, { create: true });
	try {
		db.exec("PRAGMA busy_timeout = 5000");
		const from = new Database(archive, { readonly: true });
		try {
			ensureTables(db, from, ["history", "session_titles", "session_recaps"]);
		} finally {
			from.close();
		}
		db.exec(`ATTACH DATABASE ${quote(archive)} AS archive`);
		// What the archive has and this database has too (a history.db that omp has not made every table of yet lacks some).
		const both = (table: string): boolean =>
			columnsOf(db, table).length > 0 && columnsOf(db, table, "archive").length > 0;
		const before = {
			prompts: both("history") ? count(db, "SELECT COUNT(*) AS n FROM main.history") : 0,
			titles: both("session_titles") ? count(db, "SELECT COUNT(*) AS n FROM main.session_titles") : 0,
			recaps: both("session_recaps") ? count(db, "SELECT COUNT(*) AS n FROM main.session_recaps") : 0,
		};
		const shared = (table: string, skip: string[]): string[] =>
			columnsOf(db, table).filter((c) => !skip.includes(c) && columnsOf(db, table, "archive").includes(c));
		const pick = (cols: string[]) => cols.map(ident).join(", ");
		// A row both have is updated only where it differs, so that an archive that adds nothing changes nothing.
		const onConflict = (key: string, cols: string[]): string => {
			const others = cols.filter((c) => c !== key);
			if (mode !== "replace" || others.length === 0) return "NOTHING";
			const differs = others.map((c) => `${ident(c)} IS NOT excluded.${ident(c)}`).join(" OR ");
			return `UPDATE SET ${others.map((c) => `${ident(c)} = excluded.${ident(c)}`).join(", ")} WHERE ${differs}`;
		};
		const changesBefore = count(db, "SELECT total_changes() AS n");
		db.exec("BEGIN IMMEDIATE");
		try {
			if (both("history")) {
				const h = shared("history", ["id"]);
				db.exec(
					`INSERT INTO main.history (${pick(h)}) SELECT ${pick(h)} FROM archive.history WHERE true ON CONFLICT(prompt) DO ${onConflict("prompt", h)}`,
				);
			}
			if (both("session_titles")) {
				const t = shared("session_titles", []);
				db.exec(
					`INSERT INTO main.session_titles (${pick(t)}) SELECT ${pick(t)} FROM archive.session_titles WHERE true ON CONFLICT(session_id) DO ${onConflict("session_id", t)}`,
				);
			}
			if (both("session_recaps")) {
				const r = shared("session_recaps", ["id"]);
				db.exec(
					`INSERT INTO main.session_recaps (${pick(r)}) SELECT ${r.map((c) => `s.${ident(c)}`).join(", ")} FROM archive.session_recaps s WHERE NOT EXISTS (SELECT 1 FROM main.session_recaps d WHERE d.session_id = s.session_id AND d.recap = s.recap)`,
				);
			}
			db.exec("COMMIT");
		} catch (e) {
			db.exec("ROLLBACK");
			throw e;
		}
		return {
			prompts: both("history") ? count(db, "SELECT COUNT(*) AS n FROM main.history") - before.prompts : 0,
			titles: both("session_titles") ? count(db, "SELECT COUNT(*) AS n FROM main.session_titles") - before.titles : 0,
			recaps: both("session_recaps") ? count(db, "SELECT COUNT(*) AS n FROM main.session_recaps") - before.recaps : 0,
			changes: count(db, "SELECT total_changes() AS n") - changesBefore,
		};
	} finally {
		db.close();
	}
}
