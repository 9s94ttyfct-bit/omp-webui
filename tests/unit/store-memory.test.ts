import { heapStats } from "bun:jsc";
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../server/sessions/store.ts";
import { removeScratch } from "../support/scratch.ts";

/**
 * What the list of conversations keeps in the server for as long as it runs: a summary per conversation, not what the
 * conversation said. A summary's preview is the first 240 characters of the first message, and a slice in JavaScriptCore
 * shares the string it was cut from: a preview kept as a slice held the whole first message (a pasted log, a file) of
 * every conversation summarized since the start (A-029, #9).
 */

const root = mkdtempSync(join(tmpdir(), "ompw-store-memory-"));
afterAll(() => removeScratch(root));

const MESSAGES = 24;
const MESSAGE_CHARS = 1 << 20;

/** The main thread's JavaScript heap after a full collection, in MB. */
function heapMb(): number {
	Bun.gc(true);
	Bun.gc(true);
	return heapStats().heapSize / 2 ** 20;
}

test("listing keeps each conversation's preview, not its whole first message", async () => {
	const bucket = join(root, "sessions", "-tmp-x");
	mkdirSync(bucket, { recursive: true });
	for (let n = 0; n < MESSAGES; n++) {
		const id = `01a00000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
		const header = { type: "session", version: 3, id, timestamp: "2026-01-09T00:00:00.000Z", cwd: "/tmp/x" };
		const text = `${n} ${"x".repeat(MESSAGE_CHARS)}`;
		const message = { type: "message", id: `u${n}`, parentId: null, timestamp: "2026-01-09T00:00:01.000Z" };
		const user = { ...message, message: { role: "user", content: [{ type: "text", text }] } };
		writeFileSync(
			join(bucket, `2026-01-09T00-00-00-000Z_${id}.jsonl`),
			`${JSON.stringify(header)}\n${JSON.stringify(user)}\n`,
		);
	}
	const before = heapMb();
	const store = new SessionStore(join(root, "sessions"), join(root, "index.db"));
	try {
		const rows = await store.list();
		expect(rows).toHaveLength(MESSAGES);
		expect(rows.every((r) => r.preview.length === 240)).toBe(true);
		// The 24 previews are a few KB; the messages they were cut from are 24 MB (kept as slices: +25.5 MB).
		expect(heapMb() - before).toBeLessThan(8);
	} finally {
		store.close();
	}
});
