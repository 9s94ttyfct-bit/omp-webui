import { Database } from "bun:sqlite";

/**
 * Stands in for omp while a test changes the same database: a process of its own that keeps inserting working memories the
 * way omp's `remember` does (one write transaction each, the write lock taken first, `busy_timeout` set), for as long as it
 * takes to write `count` of them. It prints `started` once it is writing and `done <n>` when it is finished.
 *
 *   bun tests/support/omp-writer.ts <database> <bank> <count> [pause-ms]
 */
const [path, bank, countText, pauseText] = process.argv.slice(2);
const count = Number(countText);
const pause = Number(pauseText ?? 2);
const db = new Database(path);
db.exec("PRAGMA busy_timeout = 8000");
let written = 0;
for (let i = 0; i < count; i++) {
	db.exec("BEGIN IMMEDIATE");
	db.query(
		`INSERT INTO working_memory
		 (id, content, source, timestamp, session_id, importance, metadata_json, veracity, memory_type, scope, author_id, author_type, channel_id, trust_tier)
		 VALUES ($id, $content, 'coding-agent-transcript', $ts, $bank, 0.65, '{"cwd":"/work/app"}', 'unknown', 'episode', 'bank', 'coding-agent', 'agent', $bank, 'STATED')`,
	).run({
		$id: `omp${String(i).padStart(5, "0")}`,
		$content: `a turn omp kept ${i}`,
		$ts: new Date(Date.UTC(2026, 9, 20, 0, 0, i)).toISOString(),
		$bank: bank,
	});
	db.exec("COMMIT");
	written++;
	if (i === 0) console.log("started");
	if (pause > 0) Bun.sleepSync(pause);
}
db.close();
console.log(`done ${written}`);
