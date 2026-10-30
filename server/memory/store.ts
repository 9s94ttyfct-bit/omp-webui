import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
	kindOf,
	MEMORY_CONTENT_MAX,
	MEMORY_KINDS,
	MEMORY_NAME,
	MEMORY_PREVIEW_CHARS,
	type MemoryBank,
	type MemoryDetail,
	type MemoryErrorCode,
	type MemoryItem,
	type MemoryKind,
	type MemoryList,
	type MemoryProvenance,
	type MemoryQuery,
	type MemoryScope,
	type MemoryStore,
	originOf,
	SOURCE_CONVERSATION,
	SOURCE_WEB,
} from "../../shared/memory.ts";

/**
 * omp's long-term memory (Mnemopi), read and written from the Memory page.
 *
 * omp has no command, and its RPC no request, that lists, reads or rewrites one memory: `/memory` works on the whole store
 * (`clear` wipes it), and `memory_edit` is a tool the *model* calls, inside a conversation, one that needs a model turn
 * and a Mnemopi session to be running. Its library (`@oh-my-pi/pi-mnemopi`) does the work, but omp is a compiled program
 * that exposes none of it, and linking the library here would tie this app to one omp's layout of the files (it migrates a
 * database it opens). So the page does what the library's own `updateWorking`, `forgetWorking`, `invalidate` and `remember`
 * do, as SQL, with these rules (all of which `tests/unit/memory-store.test.ts` holds to):
 *
 *   - A change is one SQLite transaction (`BEGIN IMMEDIATE`: the write lock is taken first, then the memory is read, its
 *     etag checked and the rows written), so omp writing to the same database at the same moment waits or is waited for
 *     (`busy_timeout`) and never sees half a change. Nothing is ever written outside a transaction.
 *   - A database is never created, migrated or repaired here: only one that exists, in the layout 18.12 makes (`layoutProblem`),
 *     is written to. A layout this does not know is read where it can be, and refused for writing.
 *   - Before a change, a copy of the bank's database is made by SQLite itself (`VACUUM INTO`, the way a consistent copy
 *     of a database in use is made), at most once every `BACKUP_GAP_MS` per bank, the newest `KEEP_BACKUPS` kept. A copy that
 *     cannot be made stops the change.
 *   - What omp does with a memory that its rewrites do not (the search index, the embedding, the facts and graph rows
 *     made from it) is done as omp does it: the index is kept by omp's own triggers; a rewritten text loses its embedding
 *     row, which omp's next start finds missing and makes again; a deletion removes what was made from the memory.
 */

export class MemoryError extends Error {
	constructor(
		message: string,
		readonly code: MemoryErrorCode,
		readonly status: number,
	) {
		super(message);
	}
}

/** The name omp gives the shared bank when `mnemopi.bank` does not name another. */
export const DEFAULT_SHARED_BANK = "default";
/** The file each bank's database is. */
const DB_FILE = "mnemopi.db";
/** The banks this app's own helper conversations (the context probe, Light mode) leave behind: not memories. */
const SCRATCH_BANK = /^ompw-/;

/** A copy of a bank's database is made at most this often (per bank), before a change. */
export const BACKUP_GAP_MS = 10 * 60_000;
/** A delete takes its copy sooner than that: a run of them shares one copy that holds every memory it deletes. */
export const DELETE_GAP_MS = 60_000;
/** How many copies of one bank are kept. */
export const KEEP_BACKUPS = 10;
/** How long a change waits for omp to let go of the database. */
const BUSY_MS = 5_000;

// ------------------------------------------------------------------ where the memories are

/** Where omp's memories are: the shared bank's database, and the folder the projects' banks are in. */
export interface MemoryLayout {
	sharedDb: string;
	banksDir: string;
	sharedBank: string;
}

/** omp's `sanitizeBankName` and `limitBankName`, which turn `mnemopi.bank` into the shared bank's name. */
function sharedBankName(configured: string | null): string {
	const raw = configured?.trim();
	if (!raw) return DEFAULT_SHARED_BANK;
	const clean = raw.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
	if (!clean) return DEFAULT_SHARED_BANK;
	if (clean.length <= 64) return clean;
	const hash = Bun.hash(clean).toString(36);
	const prefix = clean.slice(0, Math.max(1, 63 - hash.length)).replace(/-+$/g, "") || "bank";
	return `${prefix}-${hash}`;
}

/** The layout for omp's agent directory and its `mnemopi.dbPath` / `mnemopi.bank` settings (null: not set). */
export function layoutOf(agentDir: string, dbPath: string | null, bank: string | null): MemoryLayout {
	const sharedDb = dbPath ?? join(agentDir, "memories", "mnemopi", DB_FILE);
	return { sharedDb, banksDir: join(sharedDb, "..", "banks"), sharedBank: sharedBankName(bank) };
}

/** One database of memories. */
export interface BankFile {
	bank: string;
	scope: MemoryScope;
	path: string;
	scratch: boolean;
}

const isFile = (path: string): boolean => {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
};

/** Every bank that has a database: the shared one first, then the projects' by name. */
export function bankFiles(layout: MemoryLayout): BankFile[] {
	const out: BankFile[] = [];
	if (isFile(layout.sharedDb))
		out.push({ bank: layout.sharedBank, scope: "global", path: layout.sharedDb, scratch: false });
	let names: string[] = [];
	try {
		names = readdirSync(layout.banksDir, { withFileTypes: true })
			// A link is not followed: a bank is a folder omp made, and a name may not lead out of the store.
			.filter((e) => e.isDirectory() && MEMORY_NAME.test(e.name) && e.name !== layout.sharedBank)
			.map((e) => e.name)
			.sort();
	} catch {
		// No folder of banks: nothing but the shared one.
	}
	for (const name of names) {
		const path = join(layout.banksDir, name, DB_FILE);
		if (isFile(path)) out.push({ bank: name, scope: "project", path, scratch: SCRATCH_BANK.test(name) });
	}
	return out;
}

/** The bank a request names, among those that exist and are not scratch ones; null for any other name. */
export function findBank(layout: MemoryLayout, bank: unknown): BankFile | null {
	if (typeof bank !== "string" || !MEMORY_NAME.test(bank)) return null;
	return bankFiles(layout).find((b) => b.bank === bank && !b.scratch) ?? null;
}

// ------------------------------------------------------------------ reading

const isCantOpen = (e: unknown): boolean => {
	const err = e as { code?: string; message?: string };
	return err?.code === "SQLITE_CANTOPEN" || /unable to open database file/i.test(err?.message ?? "");
};

/**
 * A database in WAL mode that no process has open has no `-shm` file, and SQLite will not give a read-only connection to
 * one: the connection opens, and its first read fails with "unable to open database file", because it has to make that
 * file. omp's own connections leave theirs behind, but a copy of a store does not, and neither may the close of the last
 * connection. Then the database is opened read-write and `query_only` is set: this connection can write no row. It is not
 * touchless, though: opening a WAL database runs SQLite's ordinary WAL recovery (a `-wal` that was copied with it is
 * applied and truncated, a `-shm` is made), which is what omp itself does the next time it opens the database.
 */
function openRead(path: string): Database {
	let db = new Database(path, { readonly: true });
	try {
		db.exec("PRAGMA busy_timeout = 250");
		db.query("SELECT 1 FROM sqlite_master LIMIT 1").get();
	} catch (e) {
		db.close();
		if (!isCantOpen(e)) throw e;
		db = new Database(path, { readwrite: true });
		db.exec("PRAGMA query_only = 1");
		db.exec("PRAGMA busy_timeout = 250");
	}
	return db;
}

const quote = (s: string): string => `'${s.replaceAll("'", "''")}'`;

/** A consistent copy of the database, made on the connection `openRead` gives (so it does not need a `-shm` left behind). */
function copyDatabase(path: string, dest: string): void {
	const db = openRead(path);
	try {
		db.exec(`VACUUM INTO ${quote(dest)}`);
	} finally {
		db.close();
	}
	chmodSync(dest, 0o600);
}

function withRead<T>(path: string, fn: (db: Database) => T): T {
	let db: Database;
	try {
		db = openRead(path);
	} catch (e) {
		throw new MemoryError(`The memory database could not be opened: ${(e as Error).message}`, "unreadable", 500);
	}
	try {
		return fn(db);
	} catch (e) {
		if (e instanceof MemoryError) throw e;
		throw new MemoryError(`The memory database could not be read: ${(e as Error).message}`, "unreadable", 500);
	} finally {
		db.close();
	}
}

const columnsOf = (db: Database, table: string): Set<string> =>
	new Set(
		db
			.query<{ name: string }, []>(`PRAGMA table_info(${table})`)
			.all()
			.map((c) => c.name),
	);

const hasTable = (db: Database, name: string): boolean =>
	db
		.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?")
		.get(name)?.n === 1;

const triggersOf = (db: Database): Set<string> =>
	new Set(
		db
			.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'trigger'")
			.all()
			.map((t) => t.name),
	);

const WORKING_NEEDS = [
	"id",
	"content",
	"embed_text",
	"source",
	"timestamp",
	"session_id",
	"importance",
	"metadata_json",
	"veracity",
	"memory_type",
	"scope",
	"author_id",
	"author_type",
	"channel_id",
	"trust_tier",
	"valid_until",
	"superseded_by",
	"consolidated_at",
];
const EPISODIC_NEEDS = ["id", "content", "valid_until", "superseded_by"];
/** omp's triggers that keep the full-text index of the working memories in step with their text. */
const WORKING_TRIGGERS = ["wm_ai", "wm_au", "wm_ad"];

/** The tables and columns `purgeArtifacts` deletes from (omp's own purge of what is made from a memory). */
const PURGE_COLUMNS: readonly (readonly [string, readonly string[]])[] = [
	["facts", ["fact_id", "source_msg_id"]],
	["annotations", ["memory_id"]],
	["memory_embeddings", ["memory_id"]],
	["memoria_facts", ["source_memory_id"]],
	["memoria_instructions", ["source_memory_id"]],
	["memoria_kg", ["source_memory_id"]],
	["memoria_preferences", ["source_memory_id"]],
	["memoria_timelines", ["source_memory_id"]],
	["gists", ["memory_id"]],
	["graph_edges", ["source", "target"]],
];
/** Every table omp 18.12 makes: the ones above, and those that omp's own purge leaves alone too. */
const KNOWN_TABLES = new Set([
	...PURGE_COLUMNS.map(([t]) => t),
	"working_memory",
	"episodic_memory",
	"scratchpad",
	"consolidation_log",
	"memory_validations",
	"triples",
]);
/** The columns by which a table names a memory. */
const REFERENCE_COLUMNS = ["memory_id", "source_memory_id", "source_msg_id"];

/** Tables this page does not know that name a memory: deleting the memory would leave rows of theirs pointing at nothing. */
function unknownMemoryTables(db: Database): string[] {
	const rows = db
		.query<{ name: string; sql: string | null }, []>(
			"SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
		)
		.all();
	const virtuals = rows.filter((r) => /CREATE\s+VIRTUAL/i.test(r.sql ?? "")).map((r) => r.name);
	return rows
		.filter((r) => !KNOWN_TABLES.has(r.name) && !virtuals.some((v) => r.name === v || r.name.startsWith(`${v}_`)))
		.filter((r) => {
			const columns = columnsOf(db, `"${r.name.replaceAll('"', '""')}"`);
			return REFERENCE_COLUMNS.some((c) => columns.has(c));
		})
		.map((r) => r.name);
}
/**
 * Why a database cannot be written to safely, or null when it can: its tables, the columns a change touches, and the
 * triggers that keep omp's search index in step must be those of omp 18.12 (the layout this was written against).
 */
export function layoutProblem(db: Database): string | null {
	const lacks: string[] = [];
	for (const [table, needs] of [
		["working_memory", WORKING_NEEDS],
		["episodic_memory", EPISODIC_NEEDS],
	] as const) {
		if (!hasTable(db, table)) {
			lacks.push(`the table ${table}`);
			continue;
		}
		const have = columnsOf(db, table);
		const missing = needs.filter((c) => !have.has(c));
		if (missing.length > 0) lacks.push(`${table}.${missing.join(", ")}`);
	}
	if (!hasTable(db, "fts_working")) lacks.push("the index fts_working");
	const triggers = triggersOf(db);
	const noTrigger = WORKING_TRIGGERS.filter((t) => !triggers.has(t));
	if (noTrigger.length > 0) lacks.push(`the triggers ${noTrigger.join(", ")}`);
	for (const [table, needs] of PURGE_COLUMNS) {
		if (!hasTable(db, table)) continue;
		const have = columnsOf(db, table);
		const missing = needs.filter((c) => !have.has(c));
		if (missing.length > 0) lacks.push(`${table}.${missing.join(", ")}`);
	}
	const unknown = unknownMemoryTables(db);
	if (unknown.length > 0)
		lacks.push(`tables that refer to memories and that this page does not know how to clean (${unknown.join(", ")})`);
	return lacks.length === 0 ? null : `this database lacks ${lacks.join("; ")}`;
}

const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function metaOf(json: unknown): Record<string, unknown> {
	if (typeof json !== "string" || json === "") return {};
	try {
		const parsed: unknown = JSON.parse(json);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/** The project's folder name for a bank: from the memories' own folders, else the bank's name without omp's hash suffix. */
function labelOf(bank: string, scope: MemoryScope, cwds: string[]): string {
	if (scope === "global") return bank;
	const first = cwds[0];
	if (first) return basename(first) || first;
	return bank.replace(/-[0-9a-z]{6,13}$/, "") || bank;
}

function bytesOf(path: string): number {
	let total = 0;
	for (const file of [path, `${path}-wal`]) {
		try {
			total += statSync(file).size;
		} catch {
			// No such file.
		}
	}
	return total;
}

/** A bank's counts, its folders and whether this page may write to it. A bank that cannot be read says why. */
export function bankInfo(file: BankFile, now: string): MemoryBank {
	const base = {
		bank: file.bank,
		scope: file.scope,
		bytes: bytesOf(file.path),
	};
	try {
		return withRead(file.path, (db) => {
			const wcols = hasTable(db, "working_memory") ? columnsOf(db, "working_memory") : new Set<string>();
			const ecols = hasTable(db, "episodic_memory") ? columnsOf(db, "episodic_memory") : new Set<string>();
			const retired = (cols: Set<string>) =>
				cols.has("valid_until") && cols.has("superseded_by")
					? "COUNT(CASE WHEN superseded_by IS NOT NULL OR (valid_until IS NOT NULL AND valid_until <= $now) THEN 1 END)"
					: "0";
			const count = (table: string, cols: Set<string>) =>
				cols.size === 0
					? { n: 0, retired: 0 }
					: (db
							.query<{ n: number; retired: number }, [{ $now: string }]>(
								`SELECT COUNT(*) AS n, ${retired(cols)} AS retired FROM ${table}`,
							)
							.get({ $now: now }) ?? { n: 0, retired: 0 });
			const working = count("working_memory", wcols);
			const episodic = count("episodic_memory", ecols);
			let cwds: string[] = [];
			if (wcols.has("metadata_json")) {
				// `json_valid` guards the extraction in a CASE: SQLite does not promise to stop at a false operand of AND.
				cwds = db
					.query<{ cwd: string }, []>(
						`SELECT cwd, COUNT(*) AS n FROM (
							SELECT CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.cwd') END AS cwd FROM working_memory
						 ) WHERE typeof(cwd) = 'text' AND cwd != '' GROUP BY cwd ORDER BY n DESC LIMIT 5`,
					)
					.all()
					.map((r) => r.cwd);
			}
			return {
				...base,
				label: labelOf(file.bank, file.scope, cwds),
				cwds,
				working: working.n,
				episodic: episodic.n,
				retired: working.retired + episodic.retired,
				writeProblem: layoutProblem(db),
			};
		});
	} catch (e) {
		return {
			...base,
			label: labelOf(file.bank, file.scope, []),
			cwds: [],
			working: 0,
			episodic: 0,
			retired: 0,
			writeProblem: null,
			error: (e as Error).message,
		};
	}
}

/** What the page lists of each kind of memory (the columns a list reads; a layout that lacks one reads it as null). */
const WORKING_LIST = [
	"source",
	"timestamp",
	"created_at",
	"importance",
	"metadata_json",
	"valid_until",
	"superseded_by",
];
const EPISODIC_LIST = WORKING_LIST;

/** A column the table has, or a null in its place. */
const col = (cols: Set<string>, name: string): string => (cols.has(name) ? name : `NULL AS ${name}`);

interface ListRow {
	id: string;
	head: string | null;
	len: number | null;
	source: string | null;
	timestamp: string | null;
	created_at: string | null;
	importance: number | null;
	metadata_json: string | null;
	valid_until: string | null;
	superseded_by: string | null;
}

/** The filters of a list, as the SQL of one table: the search, whether retired ones count, and (for the list) the kind. */
function conditions(cols: Set<string>, query: MemoryQuery, kind: "any" | "note" | "conversation"): string[] {
	const out: string[] = [];
	if (cols.has("valid_until") && cols.has("superseded_by")) {
		const retired = "(superseded_by IS NOT NULL OR (valid_until IS NOT NULL AND valid_until <= $now))";
		if (query.retired === "active") out.push(`NOT ${retired}`);
		else if (query.retired === "retired") out.push(retired);
	} else if (query.retired === "retired") {
		out.push("0");
	}
	if (query.q !== "") {
		const parts = ["instr(lower(content), $q) > 0", "instr(id, $raw) > 0"];
		if (cols.has("metadata_json")) {
			parts.push(
				`instr(lower(CASE WHEN json_valid(metadata_json) THEN COALESCE(json_extract(metadata_json, '$.context'), '') || ' ' || COALESCE(json_extract(metadata_json, '$.cwd'), '') ELSE '' END), $q) > 0`,
			);
		}
		out.push(`(${parts.join(" OR ")})`);
	}
	if (kind !== "any" && cols.has("source")) {
		out.push(kind === "conversation" ? "source IS $conv" : "source IS NOT $conv");
	}
	return out;
}

function listParams(query: MemoryQuery, now: string, withLimit?: number): Record<string, string | number> {
	const params: Record<string, string | number> = { $now: now, $conv: SOURCE_CONVERSATION };
	if (query.q !== "") {
		params.$q = query.q.toLowerCase();
		params.$raw = query.q;
	}
	if (withLimit !== undefined) {
		params.$limit = withLimit;
		params.$head = MEMORY_PREVIEW_CHARS;
	}
	return params;
}

const where = (parts: string[]): string => (parts.length === 0 ? "" : ` WHERE ${parts.join(" AND ")}`);

function provenanceOf(store: MemoryStore, source: string | null, meta: Record<string, unknown>): MemoryProvenance {
	return {
		source,
		origin: originOf(source),
		tool: store === "working" ? text(meta.tool) : null,
		sessionId: store === "working" ? text(meta.session_id) : null,
		cwd: store === "working" ? text(meta.cwd) : null,
		context: store === "working" ? text(meta.context) : null,
	};
}

function itemOf(row: ListRow, store: MemoryStore, file: BankFile, now: string): MemoryItem {
	const meta = metaOf(row.metadata_json);
	const full = row.len ?? row.head?.length ?? 0;
	return {
		bank: file.bank,
		id: row.id,
		store,
		kind: kindOf(store, row.source),
		scope: file.scope,
		content: row.head ?? "",
		length: full,
		// SQLite's `length()` counts characters (code points), a JS string's `.length` UTF-16 units: compared as the same thing.
		truncated: full > [...(row.head ?? "")].length,
		importance: num(row.importance),
		createdAt: row.timestamp ?? row.created_at ?? null,
		retired: row.superseded_by !== null || (row.valid_until !== null && row.valid_until <= now),
		provenance: provenanceOf(store, row.source, meta),
	};
}

/** The memories that match `query`, newest first, across the banks it names. */
export function listMemories(layout: MemoryLayout, query: MemoryQuery, now = new Date().toISOString()): MemoryList {
	const banks = bankFiles(layout).filter(
		(b) =>
			!b.scratch && (query.scope === "all" || b.scope === query.scope) && (query.bank === "" || b.bank === query.bank),
	);
	const wantNote = query.kinds.includes("note");
	const wantConversation = query.kinds.includes("conversation");
	const wantConsolidated = query.kinds.includes("consolidated");
	const counts: Record<MemoryKind, number> = { note: 0, conversation: 0, consolidated: 0 };
	const unreadable: string[] = [];
	const items: MemoryItem[] = [];
	const take = query.limit + query.offset;
	for (const file of banks) {
		try {
			withRead(file.path, (db) => {
				if (hasTable(db, "working_memory")) {
					const cols = columnsOf(db, "working_memory");
					// A layout with no `source` has no conversation excerpts to tell apart: all are notes.
					const noteIf = cols.has("source") ? "source IS NOT $conv" : "1";
					const conversationIf = cols.has("source") ? "source IS $conv" : "0";
					const sums = db
						.query<{ note: number; conversation: number }, [Record<string, string | number>]>(
							`SELECT COALESCE(SUM(CASE WHEN ${noteIf} THEN 1 ELSE 0 END), 0) AS note,
							        COALESCE(SUM(CASE WHEN ${conversationIf} THEN 1 ELSE 0 END), 0) AS conversation
							 FROM working_memory${where(conditions(cols, query, "any"))}`,
						)
						.get(listParams(query, now));
					counts.note += sums?.note ?? 0;
					counts.conversation += sums?.conversation ?? 0;
					const kind = wantNote && wantConversation ? "any" : wantNote ? "note" : "conversation";
					if (wantNote || wantConversation) {
						const rows = db
							.query<ListRow, [Record<string, string | number>]>(
								`SELECT id, substr(content, 1, $head) AS head, length(content) AS len, ${WORKING_LIST.map((c) => col(cols, c)).join(", ")}
								 FROM working_memory${where(conditions(cols, query, kind))}
								 ORDER BY COALESCE(timestamp, created_at) DESC, id LIMIT $limit`,
							)
							.all(listParams(query, now, take));
						for (const r of rows) items.push(itemOf(r, "working", file, now));
					}
				}
				if (hasTable(db, "episodic_memory")) {
					const cols = columnsOf(db, "episodic_memory");
					const n = db
						.query<{ n: number }, [Record<string, string | number>]>(
							`SELECT COUNT(*) AS n FROM episodic_memory${where(conditions(cols, query, "any"))}`,
						)
						.get(listParams(query, now));
					counts.consolidated += n?.n ?? 0;
					if (wantConsolidated) {
						const rows = db
							.query<ListRow, [Record<string, string | number>]>(
								`SELECT id, substr(content, 1, $head) AS head, length(content) AS len, ${EPISODIC_LIST.map((c) => col(cols, c)).join(", ")}
								 FROM episodic_memory${where(conditions(cols, query, "any"))}
								 ORDER BY COALESCE(timestamp, created_at) DESC, id LIMIT $limit`,
							)
							.all(listParams(query, now, take));
						for (const r of rows) items.push(itemOf(r, "episodic", file, now));
					}
				}
			});
		} catch {
			unreadable.push(file.bank);
		}
	}
	items.sort(
		(a, b) =>
			(b.createdAt ?? "").localeCompare(a.createdAt ?? "") || a.bank.localeCompare(b.bank) || a.id.localeCompare(b.id),
	);
	const total = MEMORY_KINDS.filter((k) => query.kinds.includes(k)).reduce((n, k) => n + counts[k], 0);
	return { items: items.slice(query.offset, query.offset + query.limit), total, counts, unreadable };
}

type Row = Record<string, unknown>;

/** What a change must carry back: the state the page read, as a short digest of what a change would overwrite. */
export function etagOf(row: Row): string {
	return createHash("sha1")
		.update(
			JSON.stringify([row.content ?? null, row.importance ?? null, row.valid_until ?? null, row.superseded_by ?? null]),
		)
		.digest("hex")
		.slice(0, 16);
}

/** The row of a memory: in the table named, or (none named) the working table and then the episodic one, as omp looks. */
function findRow(db: Database, id: string, store?: MemoryStore): { store: MemoryStore; row: Row } | null {
	for (const s of store ? [store] : (["working", "episodic"] as const)) {
		const table = s === "working" ? "working_memory" : "episodic_memory";
		if (!hasTable(db, table)) continue;
		const row = db.query<Row, [string]>(`SELECT * FROM ${table} WHERE id = ?`).get(id);
		if (row) return { store: s, row };
	}
	return null;
}

function detailOf(db: Database, file: BankFile, found: { store: MemoryStore; row: Row }, now: string): MemoryDetail {
	const { store, row } = found;
	const content = typeof row.content === "string" ? row.content : "";
	const source = text(row.source);
	const meta = metaOf(row.metadata_json);
	const provenance = provenanceOf(store, source, meta);
	const summaryOf: MemoryDetail["summaryOf"] = [];
	const consolidatedInto: string[] = [];
	if (store === "episodic") {
		const ids = (text(row.summary_of) ?? "").split(/[\s,;]+/).filter((s) => MEMORY_NAME.test(s));
		for (const id of ids.slice(0, 20)) {
			const from = hasTable(db, "working_memory")
				? db
						.query<{ metadata_json: string | null }, [string]>("SELECT metadata_json FROM working_memory WHERE id = ?")
						.get(id)
				: null;
			summaryOf.push({ id, exists: from !== null });
			if (from && provenance.sessionId === null) {
				const m = metaOf(from.metadata_json);
				provenance.sessionId = text(m.session_id);
				provenance.cwd = text(m.cwd);
				provenance.context = text(m.context);
				provenance.tool = text(m.tool);
			}
		}
	} else if (hasTable(db, "episodic_memory") && columnsOf(db, "episodic_memory").has("summary_of")) {
		for (const r of db
			.query<{ id: string }, [string]>("SELECT id FROM episodic_memory WHERE instr(summary_of, ?) > 0 LIMIT 10")
			.all(String(row.id))) {
			consolidatedInto.push(r.id);
		}
	}
	const writable = layoutProblem(db) === null;
	const item: MemoryItem = itemOf(
		{
			id: String(row.id),
			head: content,
			len: content.length,
			source,
			timestamp: text(row.timestamp),
			created_at: text(row.created_at),
			importance: num(row.importance),
			metadata_json: typeof row.metadata_json === "string" ? row.metadata_json : null,
			valid_until: text(row.valid_until),
			superseded_by: text(row.superseded_by),
		},
		store,
		file,
		now,
	);
	return {
		...item,
		provenance,
		veracity: text(row.veracity),
		memoryType: text(row.memory_type),
		trustTier: text(row.trust_tier),
		author: text(row.author_id),
		consolidatedAt: text(row.consolidated_at),
		validUntil: text(row.valid_until),
		supersededBy: text(row.superseded_by),
		recallCount: num(row.recall_count),
		lastRecalled: text(row.last_recalled),
		summaryOf,
		consolidatedInto,
		etag: etagOf(row),
		editable: store === "working" && writable,
		retirable: writable,
	};
}

/** One memory in full, or null when the bank holds none with that id. */
export function readMemory(file: BankFile, id: string, now = new Date().toISOString()): MemoryDetail | null {
	return withRead(file.path, (db) => {
		const found = findRow(db, id);
		return found ? detailOf(db, file, found, now) : null;
	});
}

// ------------------------------------------------------------------ writing

/** What omp's `purgeWorkingMemoryArtifacts` removes along with a working memory: what was made from it. */
function purgeArtifacts(db: Database, id: string): void {
	const refs = new Set<string>([id, `gist_${id}`]);
	if (hasTable(db, "facts")) {
		for (const f of db
			.query<{ fact_id: string }, [string]>("SELECT fact_id FROM facts WHERE source_msg_id = ?")
			.all(id)) {
			refs.add(f.fact_id);
		}
		db.query("DELETE FROM facts WHERE source_msg_id = ?").run(id);
	}
	if (hasTable(db, "annotations")) db.query("DELETE FROM annotations WHERE memory_id = ?").run(id);
	if (hasTable(db, "memory_embeddings")) db.query("DELETE FROM memory_embeddings WHERE memory_id = ?").run(id);
	for (const table of [
		"memoria_facts",
		"memoria_instructions",
		"memoria_kg",
		"memoria_preferences",
		"memoria_timelines",
	]) {
		if (hasTable(db, table)) db.query(`DELETE FROM ${table} WHERE source_memory_id = ?`).run(id);
	}
	if (hasTable(db, "gists")) db.query("DELETE FROM gists WHERE memory_id = ?").run(id);
	if (hasTable(db, "graph_edges")) {
		for (const ref of refs) db.query("DELETE FROM graph_edges WHERE source = ? OR target = ?").run(ref, ref);
	}
}

const isBusy = (e: unknown): boolean => {
	const err = e as { code?: string; message?: string };
	return (
		err?.code === "SQLITE_BUSY" ||
		err?.code === "SQLITE_LOCKED" ||
		/database is locked|database table is locked/i.test(err?.message ?? "")
	);
};

/** A bank's copies, newest first, as their names say (`YYYYMMDDTHHMMSSZ[-n].db`); anything else in the folder is not one. */
function copiesIn(dir: string): { name: string; at: number; n: number }[] {
	const found: { name: string; at: number; n: number }[] = [];
	for (const name of readdirSync(dir)) {
		const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z(?:-(\d+))?\.db$/.exec(name);
		if (!m || !lstatSync(join(dir, name)).isFile()) continue;
		found.push({
			name,
			at: Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])),
			n: m[7] ? Number(m[7]) : 0,
		});
	}
	return found.sort((a, b) => b.at - a.at || b.n - a.n);
}

export interface WriterOptions {
	/** Copies are made at most this often per bank. */
	backupGapMs?: number;
	/** How many copies of one bank are kept. */
	keepBackups?: number;
	/** How long a change waits for omp to release the database. */
	busyMs?: number;
	clock?: () => Date;
}

/** What a change was done to, and whether a copy of the database was made first. */
interface Done {
	backedUp: boolean;
}

export class MemoryWriter {
	readonly #backups: string;
	readonly #options: Required<WriterOptions>;
	/** One change at a time per database: a change reads, checks and writes, and its copy is made before it. */
	readonly #queue = new Map<string, Promise<unknown>>();

	constructor(dataDir: string, options: WriterOptions = {}) {
		this.#backups = join(dataDir, "memory-backups");
		this.#options = {
			backupGapMs: options.backupGapMs ?? BACKUP_GAP_MS,
			keepBackups: options.keepBackups ?? KEEP_BACKUPS,
			busyMs: options.busyMs ?? BUSY_MS,
			clock: options.clock ?? (() => new Date()),
		};
	}

	/** Where the copies of `bank`'s database are kept. */
	backupDir(bank: string): string {
		return join(this.#backups, bank);
	}

	#serialize<T>(path: string, fn: () => T | Promise<T>): Promise<T> {
		const run = (this.#queue.get(path) ?? Promise.resolve()).then(fn, fn);
		const settled = run.then(
			() => {},
			() => {},
		);
		this.#queue.set(path, settled);
		void settled.then(() => {
			if (this.#queue.get(path) === settled) this.#queue.delete(path);
		});
		return run;
	}

	/**
	 * A copy of the database before a change: at most one per `gapMs`, and none when the newest copy already holds what is
	 * about to change (a memory that predates it: `rowAt`). A delete allows itself a copy sooner than an edit
	 * (`DELETE_GAP_MS`), so a run of deletes shares a copy that holds every memory the run takes away. A copy named for a
	 * time that has not come (the clock was set back) does not count as one: it would stop every copy until then.
	 */
	#backup(file: BankFile, need: { gapMs?: number; rowAt?: number | null }): boolean {
		const dir = this.backupDir(file.bank);
		const now = this.#options.clock();
		const gap = need.gapMs ?? this.#options.backupGapMs;
		try {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			// The age of a copy is told by its name, which the same clock made: a copied or touched file says nothing.
			const copies = copiesIn(dir);
			const newest = copies.find((c) => c.at <= now.getTime());
			const recent = newest !== undefined && now.getTime() - newest.at < gap;
			const holdsRow = need.rowAt == null || (newest !== undefined && need.rowAt <= newest.at);
			if (recent && holdsRow) return false;
			const stamp = now
				.toISOString()
				.replace(/[-:]/g, "")
				.replace(/\.\d+Z$/, "Z");
			// Two in one second are numbered after the highest there is, so that the later one never ranks as the older.
			const sameSecond = copies.filter((c) => c.at === Math.floor(now.getTime() / 1000) * 1000);
			const next = sameSecond.length === 0 ? 0 : Math.max(...sameSecond.map((c) => c.n)) + 1;
			const dest = join(dir, next === 0 ? `${stamp}.db` : `${stamp}-${next}.db`);
			copyDatabase(file.path, dest);
			this.#prune(dir, now.getTime());
			return true;
		} catch (e) {
			throw new MemoryError(
				`A copy of the memory database could not be made first, so nothing was changed: ${(e as Error).message}`,
				"backup",
				500,
			);
		}
	}

	/** Keep the newest copies (one named for a time to come is the oldest); only files named as this makes them, in its own folder. */
	#prune(dir: string, now: number): void {
		const all = copiesIn(dir);
		const ordered = [...all.filter((c) => c.at <= now), ...all.filter((c) => c.at > now)];
		for (const old of ordered.slice(this.#options.keepBackups)) {
			try {
				unlinkSync(join(dir, old.name));
			} catch {
				// Left for the next time.
			}
		}
	}

	/**
	 * `fn` inside one write transaction on the bank's database, after its layout was checked and a copy made. The wait for
	 * omp to release the database is made of short tries with the event loop free in between: a database omp keeps locked
	 * for seconds (a consolidation) must not stop the server for seconds. The copy is made once the lock is held, so a
	 * change that gives up (the lock was omp's too long) has taken no copy and pruned none.
	 */
	write<T>(
		file: BankFile,
		fn: (db: Database, now: string) => T,
		need: { gapMs?: number; rowAt?: number | null } = {},
	): Promise<{ value: T } & Done> {
		return this.#serialize(file.path, async () => {
			const problem = withRead(file.path, layoutProblem);
			if (problem !== null) {
				throw new MemoryError(
					`This memory database is not in a layout this page knows how to change (${problem}). Change it in omp, with its memory_edit tool.`,
					"layout",
					409,
				);
			}
			let db: Database;
			try {
				db = new Database(file.path, { readwrite: true });
			} catch (e) {
				throw new MemoryError(`The memory database could not be opened: ${(e as Error).message}`, "unreadable", 500);
			}
			const busy = () => new MemoryError("omp is writing to its memory right now. Try again in a moment.", "busy", 503);
			try {
				db.exec("PRAGMA busy_timeout = 20");
				const deadline = Date.now() + Math.max(0, this.#options.busyMs);
				for (;;) {
					try {
						db.exec("BEGIN IMMEDIATE");
						break;
					} catch (e) {
						if (!isBusy(e)) throw e;
						if (Date.now() >= deadline) throw busy();
						await sleep(25);
					}
				}
				try {
					const backedUp = this.#backup(file, need);
					const value = fn(db, this.#options.clock().toISOString());
					db.exec("COMMIT");
					return { value, backedUp };
				} catch (e) {
					try {
						db.exec("ROLLBACK");
					} catch {
						// The transaction is already over.
					}
					throw e;
				}
			} catch (e) {
				if (e instanceof MemoryError) throw e;
				if (isBusy(e)) throw busy();
				throw new MemoryError(`The change could not be made: ${(e as Error).message}`, "unreadable", 500);
			} finally {
				db.close();
			}
		});
	}

	/** Add a working memory (omp's `remember`, as its `memory.save` and `retain` call it). Returns its id. */
	async add(
		file: BankFile,
		input: { content: string; importance: number; context: string | null; cwd: string | null },
	): Promise<{ id: string } & Done> {
		if (input.content.length > MEMORY_CONTENT_MAX) throw tooLong();
		const id = randomBytes(8).toString("hex");
		const { backedUp } = await this.write(file, (db, now) => {
			db.query(
				`INSERT INTO working_memory
				 (id, content, source, timestamp, session_id, importance, metadata_json, veracity, memory_type, consolidated_at,
				  scope, author_id, author_type, channel_id, trust_tier)
				 VALUES ($id, $content, $source, $now, $bank, $importance, $meta, 'stated', 'fact', $now, 'bank', $source, 'user', $bank, 'STATED')`,
			).run({
				$id: id,
				$content: input.content,
				$source: SOURCE_WEB,
				$now: now,
				$bank: file.bank,
				$importance: input.importance,
				$meta: JSON.stringify({ cwd: input.cwd, context: input.context, operation: "web-ui" }),
			});
		});
		return { id, backedUp };
	}

	/** Rewrite a working memory's text and/or importance (omp's `updateWorking`). */
	async update(
		file: BankFile,
		id: string,
		etag: string,
		change: { content?: string; importance?: number },
	): Promise<Done> {
		if (change.content !== undefined && change.content.length > MEMORY_CONTENT_MAX) throw tooLong();
		const rowAt = withRead(file.path, (db) => {
			const at = Date.parse(String(findRow(db, id)?.row.timestamp ?? ""));
			return Number.isFinite(at) ? at : null;
		});
		return this.write(
			file,
			(db) => {
				const found = findRow(db, id);
				if (!found) throw notFound();
				if (found.store !== "working") throw notEditable();
				if (etagOf(found.row) !== etag) throw stale();
				const sets: string[] = [];
				const params: Record<string, string | number> = { $id: id };
				if (change.content !== undefined) {
					sets.push("content = $content", "embed_text = NULL");
					params.$content = change.content;
				}
				if (change.importance !== undefined) {
					sets.push("importance = $importance");
					params.$importance = change.importance;
				}
				if (sets.length === 0) return;
				db.query(`UPDATE working_memory SET ${sets.join(", ")} WHERE id = $id`).run(params);
				// omp makes a rewritten text's embedding again (in its own process); until it does, the old one would still be
				// found for the old words. Its next start finds a memory with no embedding and makes one.
				if (change.content !== undefined && hasTable(db, "memory_embeddings")) {
					db.query("DELETE FROM memory_embeddings WHERE memory_id = ?").run(id);
				}
			},
			{ rowAt },
		).then(({ backedUp }) => ({ backedUp }));
	}

	/** Retire a memory of either table (omp's `invalidate`): it stays in the bank and is not recalled. */
	retire(file: BankFile, id: string, etag: string | null): Promise<Done> {
		return this.write(file, (db, now) => {
			const found = findRow(db, id);
			if (!found) throw notFound();
			if (etag !== null && etagOf(found.row) !== etag) throw stale();
			const table = found.store === "working" ? "working_memory" : "episodic_memory";
			db.query(`UPDATE ${table} SET valid_until = $now, superseded_by = NULL WHERE id = $id`).run({
				$now: now,
				$id: id,
			});
		}).then(({ backedUp }) => ({ backedUp }));
	}

	/** Bring a retired memory back: it is recalled again. */
	restore(file: BankFile, id: string, etag: string | null): Promise<Done> {
		return this.write(file, (db) => {
			const found = findRow(db, id);
			if (!found) throw notFound();
			if (etag !== null && etagOf(found.row) !== etag) throw stale();
			const table = found.store === "working" ? "working_memory" : "episodic_memory";
			db.query(`UPDATE ${table} SET valid_until = NULL, superseded_by = NULL WHERE id = $id`).run({ $id: id });
		}).then(({ backedUp }) => ({ backedUp }));
	}

	/** Delete a working memory and what was made from it (omp's `forgetWorking`). A consolidated one is retired, not deleted. */
	async remove(
		file: BankFile,
		id: string,
		etag: string,
		options: { retireConsolidated?: boolean } = {},
	): Promise<Done> {
		// A delete takes a copy when the newest one is more than `DELETE_GAP_MS` old, or when the memory is newer than that
		// copy (it does not hold it). A run of deletes within the gap shares one copy, which holds every memory it deletes.
		const rowAt = withRead(file.path, (db) => {
			const at = Date.parse(String(findRow(db, id)?.row.timestamp ?? ""));
			return Number.isFinite(at) ? at : null;
		});
		const { backedUp } = await this.write(
			file,
			(db, now) => {
				const found = findRow(db, id);
				if (!found) throw notFound();
				if (found.store !== "working") throw notEditable();
				if (etagOf(found.row) !== etag) throw stale();
				// What omp made of it is retired in the same transaction, so that the text is not left recalled by a copy. A
				// summary omp already retired or replaced is left as omp left it (as omp's own `invalidate` does).
				if (options.retireConsolidated && hasTable(db, "episodic_memory")) {
					db.query(
						`UPDATE episodic_memory SET valid_until = $now
						 WHERE instr(summary_of, $id) > 0 AND superseded_by IS NULL AND (valid_until IS NULL OR valid_until > $now)`,
					).run({ $now: now, $id: id });
				}
				db.query("DELETE FROM working_memory WHERE id = ?").run(id);
				purgeArtifacts(db, id);
			},
			{ gapMs: DELETE_GAP_MS, rowAt },
		);
		return { backedUp };
	}
}

const notFound = () => new MemoryError("That memory is not in the store (any more).", "notFound", 404);
const stale = () =>
	new MemoryError(
		"That memory changed since it was opened here. It has been read again; look at it and try again.",
		"stale",
		409,
	);
const notEditable = () =>
	new MemoryError(
		"A consolidated memory is not rewritten or deleted (omp's own memory_edit does not either). Retire it instead.",
		"notEditable",
		409,
	);
const tooLong = () => new MemoryError(`A memory may hold at most ${MEMORY_CONTENT_MAX} characters.`, "tooLong", 413);
