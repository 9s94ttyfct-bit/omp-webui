import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalStore, ProcessOverlay } from "../../server/omp/approval.ts";
import { QueuedSubagents } from "../../server/omp/queued-subagents.ts";
import type { QueuedSubagent } from "../../shared/subagent-concurrency.ts";
import {
	CONCURRENCY_CHOICES,
	CONCURRENCY_KEY,
	callProgress,
	concurrencyOf,
	ompConcurrencyOf,
} from "../../shared/subagent-concurrency.ts";
import { agentRows, QUEUED } from "../../web/src/lib/subagents.ts";

/**
 * "Parallel subagents" (omp's `task.maxConcurrency`): what a page may set, how a conversation's own limit is written into
 * its overlay and kept, and how the subagents omp queued are told from omp's own progress records of a `task` call.
 */

const dirs: string[] = [];
const scratch = () => {
	const dir = mkdtempSync(join(tmpdir(), "ompw-concurrency-"));
	dirs.push(dir);
	return dir;
};
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("a limit is a whole number from 0 (no limit) to 16; omp's own value is read as any count", () => {
	expect(CONCURRENCY_CHOICES).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 0]);
	for (const ok of [0, 1, 16]) expect(concurrencyOf(ok)).toBe(ok);
	for (const bad of [-1, 17, 2.5, "4", null, undefined]) expect(concurrencyOf(bad)).toBeNull();
	expect(ompConcurrencyOf(32)).toBe(32);
	expect(ompConcurrencyOf(-3)).toBe(0);
	expect(ompConcurrencyOf("32")).toBeNull();
});

test("a conversation's limit is a `task.maxConcurrency` line of its overlay, beside its subagent models, and is kept by file", async () => {
	const dir = scratch();
	const file = join(dir, "L1.yml");
	const overlay = new ProcessOverlay(file, null, 0);
	expect(readFileSync(file, "utf8")).not.toContain("maxConcurrency");
	await overlay.setConcurrency(2);
	expect(overlay.settings[CONCURRENCY_KEY]).toBe(2);
	const yaml = Bun.YAML.parse(readFileSync(file, "utf8")) as { task?: Record<string, unknown> };
	expect(yaml.task?.maxConcurrency).toBe(2);
	await overlay.setConcurrency(0);
	expect((Bun.YAML.parse(readFileSync(file, "utf8")) as { task?: Record<string, unknown> }).task?.maxConcurrency).toBe(
		0,
	);
	await overlay.setConcurrency(null);
	expect(readFileSync(file, "utf8")).not.toContain("maxConcurrency");

	const store = new ApprovalStore("omp", scratch(), 0);
	expect(store.sessionConcurrency("/s/a.jsonl")).toBeNull();
	store.rememberConcurrency("/s/a.jsonl", 3);
	expect(store.sessionConcurrency("/s/a.jsonl")).toBe(3);
	store.rememberConcurrency("/s/a.jsonl", null);
	expect(store.sessionConcurrency("/s/a.jsonl")).toBeNull();
});

/** A `task` call's progress frame as omp sends it. */
const update = (call: string, statuses: Record<string, string>) => ({
	type: "tool_execution_update",
	toolCallId: call,
	toolName: "task",
	partialResult: {
		details: {
			progress: Object.entries(statuses).map(([id, status], index) => ({
				index,
				id,
				status,
				agent: "task",
				assignment: `${id}-TASK`,
			})),
		},
	},
});

test("omp's progress records say which subagents wait; a start, a settled session and the process's end take them away", async () => {
	const told: QueuedSubagent[][] = [];
	let at = 1000;
	const q = new QueuedSubagents(
		(list) => told.push(list),
		0,
		() => at++,
	);
	expect(callProgress(update("c", { A: "pending" }).partialResult.details)).toEqual([
		{ id: "A", pending: true, index: 0, agent: "task", assignment: "A-TASK" },
	]);
	q.frame(update("c1", { A: "running", B: "pending", C: "pending" }));
	expect(q.list.map((s) => s.id)).toEqual(["B", "C"]);
	expect(q.list[0]).toMatchObject({ parentToolCallId: "c1", agent: "task", assignment: "B-TASK", index: 1 });
	// The same subagent keeps when it began to wait.
	const since = q.list[0].since;
	q.frame(update("c1", { A: "completed", B: "pending", C: "pending" }));
	expect(q.list[0].since).toBe(since);
	// omp starts B: its call says so, or its lifecycle frame does first.
	q.frame({ type: "subagent_lifecycle", payload: { id: "B", status: "started" } });
	expect(q.list.map((s) => s.id)).toEqual(["C"]);
	q.frame(update("c1", { A: "completed", B: "running", C: "running" }));
	expect(q.list).toEqual([]);
	// Another tool's frames, and a frame with no progress, say nothing.
	q.frame(update("c2", { D: "pending" }));
	q.frame({ type: "tool_execution_update", toolCallId: "c2", toolName: "bash", partialResult: {} });
	q.frame({ type: "tool_execution_end", toolCallId: "c2", toolName: "task", result: { content: [] } });
	expect(q.list.map((s) => s.id)).toEqual(["D"]);
	// A subagent's own call (a nested one), dropped when that subagent is over.
	q.frame({ type: "subagent_event", payload: { id: "D", event: update("n1", { "D.E": "pending" }) } });
	expect(q.list.map((s) => s.id)).toEqual(["D", "D.E"]);
	q.frame({ type: "subagent_lifecycle", payload: { id: "D", status: "aborted" } });
	expect(q.list.map((s) => s.id)).toEqual(["D"]);
	q.frame({ type: "session_settled" });
	expect(q.list).toEqual([]);
	q.frame(update("c3", { F: "pending" }));
	// Told once the change has settled (here at once); the process's end tells the pages that nothing waits.
	await Bun.sleep(5);
	expect(told.at(-1)?.map((s) => s.id)).toEqual(["F"]);
	q.end();
	expect(q.list).toEqual([]);
	expect(told.at(-1)).toEqual([]);
});

test("a subagent pending only for the moment omp takes to give it a slot is never told as queued", async () => {
	const told: QueuedSubagent[][] = [];
	const q = new QueuedSubagents((list) => told.push(list), 30);
	q.frame(update("c1", { A: "pending", B: "pending" }));
	q.frame(update("c1", { A: "running", B: "running" }));
	await Bun.sleep(60);
	expect(told).toEqual([]);
	q.end();
});

test("the Agents list shows queued subagents after the running ones, not as running, until omp starts them", () => {
	const queued: QueuedSubagent[] = [
		{ id: "B", parentToolCallId: "c1", index: 1, agent: "task", assignment: "B-TASK", since: 1 },
		{ id: "C", parentToolCallId: "c1", index: 2, since: 2 },
	];
	const live = { A: { id: "A", status: "running", startedAt: 5, updatedAt: 5, parentToolCallId: "c1" } };
	const rows = agentRows([], live, queued);
	expect(rows.map((r) => [r.id, r.status, r.running])).toEqual([
		["A", "running", true],
		["B", QUEUED, false],
		["C", QUEUED, false],
	]);
	expect(rows[1].live).toMatchObject({ parentToolCallId: "c1", assignment: "B-TASK" });
	// Started: the live state wins over the server's list, which follows a moment later.
	const started = agentRows([], { ...live, B: { id: "B", status: "running", startedAt: 6, updatedAt: 6 } }, queued);
	expect(started.find((r) => r.id === "B")?.status).toBe("running");
});
