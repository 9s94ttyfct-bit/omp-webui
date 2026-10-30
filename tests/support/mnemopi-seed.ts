import { MNEMOPI_SCHEMA } from "./mnemopi-schema.ts";

/**
 * What it takes to fill a Mnemopi database with memories, for any SQLite binding that has `exec` and `prepare(...).run(...)`:
 * `bun:sqlite` (the unit and contract tests) and `node:sqlite` (the browser specs, which run under Node). The tables,
 * indexes and triggers are the ones omp 18.12.6 itself creates (`mnemopi-schema.ts`). The databases are always in a temp
 * folder of a test's own, never in a real agent directory.
 */

export interface Sql {
	exec(sql: string): unknown;
	prepare(sql: string): { run(...params: unknown[]): unknown };
}

export interface SeedWorking {
	id: string;
	content: string;
	source?: string;
	/** ISO; default: a fixed day. */
	timestamp?: string;
	importance?: number;
	/** The metadata object omp stores as JSON (`session_id`, `cwd`, `context`, `tool`…); `null`: none. */
	metadata?: Record<string, unknown> | null;
	/** Metadata text as it is, for a record that is not valid JSON. */
	metadataText?: string;
	veracity?: string;
	memoryType?: string;
	validUntil?: string | null;
	supersededBy?: string | null;
	consolidatedAt?: string | null;
	/** An embedding row for it, as omp's own embedding makes. */
	embedded?: boolean;
}

export interface SeedEpisodic {
	id: string;
	content: string;
	source?: string;
	timestamp?: string;
	importance?: number;
	summaryOf?: string;
	metadata?: Record<string, unknown> | null;
	validUntil?: string | null;
	supersededBy?: string | null;
}

/** A day that is neither today nor near it, so that ordering and "retired" never depend on the clock. */
export const DAY = "2026-10-10T10:00:00.000Z";

/** The tables of a database omp made, in WAL mode (which is what lets omp and the page write to one at the same moment). */
export function applySchema(db: Sql): void {
	db.exec("PRAGMA journal_mode = WAL");
	for (const sql of MNEMOPI_SCHEMA) db.exec(sql);
}

export function insertWorking(db: Sql, bank: string, s: SeedWorking): void {
	db.prepare(
		`INSERT INTO working_memory
		 (id, content, source, timestamp, session_id, importance, metadata_json, veracity, memory_type, valid_until, superseded_by,
		  consolidated_at, scope, author_id, author_type, channel_id, trust_tier)
		 VALUES ($id, $content, $source, $timestamp, $bank, $importance, $meta, $veracity, $type, $validUntil, $supersededBy,
		         $consolidatedAt, 'bank', 'coding-agent', 'agent', $bank, 'STATED')`,
	).run({
		$id: s.id,
		$content: s.content,
		$source: s.source ?? "coding-agent-retain",
		$timestamp: s.timestamp ?? DAY,
		$bank: bank,
		$importance: s.importance ?? 0.75,
		$meta:
			s.metadataText ??
			(s.metadata === null
				? null
				: JSON.stringify(s.metadata ?? { session_id: "sess-1", cwd: "/work/app", context: null, tool: "retain" })),
		$veracity: s.veracity ?? "tool",
		$type: s.memoryType ?? "fact",
		$validUntil: s.validUntil ?? null,
		$supersededBy: s.supersededBy ?? null,
		$consolidatedAt: s.consolidatedAt ?? null,
	});
	if (s.embedded) {
		db.prepare(
			"INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, '[0.1,0.2]', 'test-model')",
		).run(s.id);
	}
}

export function insertEpisodic(db: Sql, bank: string, s: SeedEpisodic): void {
	db.prepare(
		`INSERT INTO episodic_memory
		 (id, content, source, timestamp, session_id, importance, metadata_json, summary_of, veracity, tier, memory_type, valid_until,
		  superseded_by, scope, author_id, author_type, channel_id, trust_tier)
		 VALUES ($id, $content, $source, $timestamp, $bank, $importance, $meta, $summaryOf, 'tool', 1, 'unknown', $validUntil,
		         $supersededBy, 'session', 'coding-agent', 'agent', $bank, 'STATED')`,
	).run({
		$id: s.id,
		$content: s.content,
		$source: s.source ?? "sleep_consolidation",
		$timestamp: s.timestamp ?? DAY,
		$bank: bank,
		$importance: s.importance ?? 0.6,
		$meta: JSON.stringify(s.metadata ?? { original_count: 1, source: "coding-agent-learn", llm_used: false }),
		$summaryOf: s.summaryOf ?? "",
		$validUntil: s.validUntil ?? null,
		$supersededBy: s.supersededBy ?? null,
	});
}

/** Rows that omp makes from a working memory (and that a deletion must take away with it). */
export function insertDerived(db: Sql, memoryId: string): void {
	db.prepare(
		"INSERT INTO facts (fact_id, session_id, subject, predicate, object, source_msg_id) VALUES (?, 's', 'sub', 'is', 'obj', ?)",
	).run(`fact-${memoryId}`, memoryId);
	db.prepare("INSERT INTO annotations (memory_id, kind, value) VALUES (?, 'occurred_on', '2026-10-10')").run(memoryId);
	db.prepare("INSERT INTO memoria_facts (session_id, key, value, source_memory_id) VALUES ('s', 'k', 'v', ?)").run(
		memoryId,
	);
	db.prepare(
		"INSERT INTO memoria_kg (session_id, subject, predicate, object, source_memory_id) VALUES ('s', 'a', 'b', 'c', ?)",
	).run(memoryId);
	db.prepare("INSERT INTO gists (id, text, memory_id) VALUES (?, 'gist', ?)").run(`gist_${memoryId}`, memoryId);
	db.prepare("INSERT INTO graph_edges (source, target, edge_type) VALUES (?, 'other', 'related')").run(memoryId);
	db.prepare("INSERT INTO graph_edges (source, target, edge_type) VALUES ('other', ?, 'related')").run(
		`fact-${memoryId}`,
	);
}
