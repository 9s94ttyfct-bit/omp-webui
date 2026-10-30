import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUBAGENT_UPDATE_MS, SubagentCoalescer, type Timers } from "../../server/coalesce.ts";
import { LivePool } from "../../server/live.ts";
import type { OmpFrame } from "../../shared/protocol.ts";
import { fakeConfig, writeFakeOmp } from "../support/fake-omp.ts";
import { pollUntil } from "../support/poll.ts";

/**
 * A subagent streaming text makes omp send a frame per token, each holding the whole message so far. The server
 * keeps the newest per subagent and sends it at most every 100 ms; every other frame goes through in order.
 */

/** A clock the test moves by hand. */
function virtualTimers() {
	let now = 0;
	let pending: { at: number; fn: () => void } | null = null;
	const timers: Timers = {
		set: (fn, ms) => {
			pending = { at: now + ms, fn };
			return pending;
		},
		clear: (h) => {
			if (pending === h) pending = null;
		},
	};
	return {
		timers,
		advance(ms: number) {
			now += ms;
			if (pending && pending.at <= now) {
				const { fn } = pending;
				pending = null;
				fn();
			}
		},
	};
}

const update = (id: string, text: string): OmpFrame => ({
	type: "subagent_event",
	payload: {
		id,
		event: {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", partial: { role: "assistant", text } },
		},
	},
});
const other = (type: string, id: string, event: Record<string, unknown> = {}): OmpFrame => ({
	type,
	payload: { id, event, progress: { id } },
});
const textOf = (f: OmpFrame) =>
	(f.payload as { event: { assistantMessageEvent: { partial: { text: string } } } }).event.assistantMessageEvent.partial
		.text;

function setup() {
	const clock = virtualTimers();
	const sent: OmpFrame[] = [];
	const c = new SubagentCoalescer((f) => sent.push(f), clock.timers);
	return { clock, sent, c };
}

test("a thousand message updates in a second become about ten frames, the last of them the latest", () => {
	const { clock, sent, c } = setup();
	for (let i = 1; i <= 1000; i++) {
		c.push(update("Scout", `t${i}`));
		clock.advance(1);
	}
	clock.advance(SUBAGENT_UPDATE_MS);
	expect(sent.length).toBeGreaterThanOrEqual(9);
	expect(sent.length).toBeLessThanOrEqual(11);
	expect(textOf(sent.at(-1) as OmpFrame)).toBe("t1000");
	// What is sent only moves forward.
	const seen = sent.map((f) => Number(textOf(f).slice(1)));
	expect(seen).toEqual([...seen].sort((a, b) => a - b));
});

test("any other frame of the subagent goes out after the update held for it, never before", () => {
	const { sent, c } = setup();
	c.push(update("Scout", "a"));
	c.push(update("Scout", "b"));
	c.push(other("subagent_event", "Scout", { type: "message_end" }));
	expect(sent.map((f) => f.type)).toEqual(["subagent_event", "subagent_event"]);
	expect(textOf(sent[0])).toBe("b");
	expect((sent[1].payload as { event: { type: string } }).event.type).toBe("message_end");

	c.push(update("Scout", "c"));
	c.push(other("subagent_progress", "Scout"));
	c.push(update("Scout", "d"));
	c.push(other("subagent_lifecycle", "Scout"));
	expect(sent.slice(2).map((f) => f.type)).toEqual([
		"subagent_event",
		"subagent_progress",
		"subagent_event",
		"subagent_lifecycle",
	]);
});

test("subagents are held apart, and other frames are not delayed", () => {
	const { clock, sent, c } = setup();
	c.push(update("A", "a1"));
	c.push(update("B", "b1"));
	c.push({ type: "message_update", message: {} });
	expect(sent.map((f) => f.type)).toEqual(["message_update"]);
	c.push(other("subagent_event", "B", { type: "tool_execution_start" }));
	expect(sent.map((f) => f.type)).toEqual(["message_update", "subagent_event", "subagent_event"]);
	expect(textOf(sent[1])).toBe("b1");
	clock.advance(SUBAGENT_UPDATE_MS);
	expect(textOf(sent.at(-1) as OmpFrame)).toBe("a1");
	expect(sent.length).toBe(4);
});

test("an update that is not a whole snapshot is passed on, not merged", () => {
	const { sent, c } = setup();
	const delta: OmpFrame = {
		type: "subagent_event",
		payload: { id: "A", event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } } },
	};
	c.push(delta);
	c.push(delta);
	expect(sent.length).toBe(2);
});

test("flush sends what is held, once", () => {
	const { clock, sent, c } = setup();
	c.push(update("A", "a1"));
	c.flush();
	c.flush();
	clock.advance(SUBAGENT_UPDATE_MS * 2);
	expect(sent.length).toBe(1);
});

// ------------------------------------------------------------------ through a process

const dirs: string[] = [];
const pools: LivePool[] = [];
afterEach(async () => {
	for (const pool of pools.splice(0)) await pool.shutdown();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("a live process broadcasts a burst of subagent updates as one frame, with the final state", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ompw-coalesce-"));
	dirs.push(dir);
	const pool = new LivePool(fakeConfig(dir, writeFakeOmp(dir)));
	pools.push(pool);
	const sessionFile = join(dir, "session.jsonl");
	writeFileSync(sessionFile, "");
	const live = await pool.open({ kind: "resume", sessionFile }, async () => dir);
	const got: OmpFrame[] = [];
	live.subscribers.add({
		send: (m) => {
			const msg = m as { t: string; frame: OmpFrame };
			if (msg.t === "frame") got.push(msg.frame);
		},
	});
	const frames = [
		...Array.from({ length: 50 }, (_, i) => update("Scout", `t${i + 1}`)),
		other("subagent_lifecycle", "Scout"),
	];
	await live.rpc({ type: "emit_frames", frames });
	// The lifecycle frame is the last omp sends: once it is here every update has been through the server.
	await pollUntil(() => got.some((f) => f.type === "subagent_lifecycle"), "the lifecycle frame to arrive");
	const updates = got.filter((f) => f.type === "subagent_event");
	// 50 updates in a few chunks of omp's output: about two frames when the machine is idle (the first at once, the rest
	// when its 100 ms are up, or with the lifecycle frame). How many windows the chunks fall in depends on what else it
	// is running, so only far fewer than the 50 sent is asserted; the exact rule is tested above with a clock of its own.
	expect(updates.length).toBeLessThan(10);
	expect(textOf(updates.at(-1) as OmpFrame)).toBe("t50");
	// The lifecycle frame was sent after the update that was held when it came.
	expect(got.map((f) => f.type).slice(-2)).toEqual(["subagent_event", "subagent_lifecycle"]);
});
