import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Live, LivePool } from "../../server/live.ts";
import { isRecord } from "../../shared/guards.ts";
import { writeFakeHostOmp } from "../support/fake-host-omp.ts";
import { fakeConfig } from "../support/fake-omp.ts";

/**
 * What the server tells a tab that attaches to a process that is in the middle of something (a reload, a second tab, a
 * reconnect): the dialogs that wait for an answer, the reply being written (#363), and that this is all of it, so that
 * the tab drops what it still holds beyond it (#362); and the revision it stamps on what it sends (#360). Against a
 * scripted omp, no model.
 */

const dirs: string[] = [];
const pools: LivePool[] = [];

afterEach(async () => {
	for (const pool of pools.splice(0)) await pool.shutdown();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(): Promise<Live> {
	const dir = mkdtempSync(join(tmpdir(), "ompw-pool-resync-"));
	dirs.push(dir);
	const log = join(dir, "log");
	writeFileSync(log, "");
	const bin = writeFakeHostOmp(dir, log, {});
	const pool = new LivePool(fakeConfig(dir, bin), null, null, null);
	pools.push(pool);
	return pool.open({ kind: "new", cwd: tmpdir() }, async () => tmpdir());
}

/** A tab: everything the server sent it, and a way to wait for one kind of frame. */
function tab(live: Live, subscribed = true) {
	const got: Record<string, unknown>[] = [];
	const sub = { send: (m: unknown) => got.push(m as Record<string, unknown>) };
	if (subscribed) live.subscribers.add(sub);
	const frames = () => got.flatMap((m) => (m.t === "frame" && isRecord(m.frame) ? [m.frame] : []));
	return { sub, got, frames, seen: (type: string) => until(() => frames().some((f) => f.type === type)) };
}

/** What a process that has said nothing of what it keeps (see `HeldState`) holds. */
const NOTHING_HELD = { compacting: false, statuses: [], widgets: [], bashes: [] };

/** Let the event loop turn (no wall-clock wait) until `condition` holds; the scripted omp answers within a few turns. */
async function until(condition: () => boolean): Promise<void> {
	const deadline = performance.now() + 10_000;
	while (!condition()) {
		if (performance.now() > deadline) throw new Error("the condition never held");
		const turn = Promise.withResolvers<void>();
		setImmediate(turn.resolve);
		await turn.promise;
	}
}

const deltaOf = (f: Record<string, unknown>) =>
	isRecord(f.assistantMessageEvent) ? f.assistantMessageEvent.delta : undefined;
/** The type of what a tab was sent: its frame's, else the message's own. */
const kindOf = (m: Record<string, unknown>) => (m.t === "frame" && isRecord(m.frame) ? m.frame.type : m.t);

test("a tab that attaches while a reply is being written is sent the message so far, the increments of a block joined", async () => {
	const live = await start();
	const first = tab(live);
	await live.rpc({ type: "prompt", message: "stream" });
	await until(() => first.frames().filter((f) => f.type === "message_update").length === 3);

	const late = tab(live, false);
	live.resync(late.sub);
	expect(late.got.map(kindOf)).toEqual(["message_start", "message_update", "message_update", "attached"]);
	const [began, opened, text] = late.frames();
	expect(began).toMatchObject({ messageId: "m1", message: { role: "assistant", content: [], timestamp: 5 } });
	expect(opened.assistantMessageEvent).toMatchObject({ type: "text_start", contentIndex: 0 });
	// What the tab that was there heard in two pieces is one for the tab that comes late.
	expect(text.assistantMessageEvent).toMatchObject({ type: "text_delta", contentIndex: 0 });
	expect(deltaOf(text)).toBe("The quick brown fox");
	expect(late.got.at(-1)).toEqual({
		t: "attached",
		liveId: live.info.liveId,
		dialogs: [],
		message: "m1",
		held: NOTHING_HELD,
	});
	// Nothing was changed for the tab that was already there.
	expect(
		first
			.frames()
			.filter((f) => f.type === "message_update")
			.map(deltaOf),
	).toEqual([undefined, "The quick ", "brown fox"]);
});

test("once the message has ended nothing of it is sent: the tab is told there is no message in flight", async () => {
	const live = await start();
	const first = tab(live);
	await live.rpc({ type: "prompt", message: "stream" });
	await first.seen("message_update");
	await live.rpc({ type: "prompt", message: "finish" });
	await first.seen("session_settled");

	const late = tab(live, false);
	live.resync(late.sub);
	expect(late.got).toEqual([
		{ t: "attached", liveId: live.info.liveId, dialogs: [], message: null, held: NOTHING_HELD },
	]);
});

test("the dialogs that still wait are sent, and listed: what a tab holds beyond the list was settled while it was away", async () => {
	const live = await start();
	const first = tab(live);
	await live.rpc({ type: "prompt", message: "call" });
	await first.seen("host_tool_call");

	const late = tab(live, false);
	live.resync(late.sub);
	expect(late.frames().map((f) => f.type)).toEqual(["host_tool_call"]);
	expect(late.got.at(-1)).toEqual({
		t: "attached",
		liveId: live.info.liveId,
		dialogs: ["h1"],
		message: null,
		held: NOTHING_HELD,
	});

	// Answered (by whichever tab): the next tab to attach is told there is nothing to answer.
	live.respondUI({ id: "h1", result: { content: [{ type: "text", text: "ok" }] } });
	const again = tab(live, false);
	live.resync(again.sub);
	expect(again.got).toEqual([
		{ t: "attached", liveId: live.info.liveId, dialogs: [], message: null, held: NOTHING_HELD },
	]);
});

test("the revision moves with every frame that could come with a rewrite of an entry, and not with a streamed one", async () => {
	const live = await start();
	const watcher = tab(live);
	const before = live.info.revision as number;
	expect(before).toBeGreaterThan(0);
	await live.rpc({ type: "prompt", message: "stream" });
	await until(() => watcher.frames().filter((f) => f.type === "message_update").length === 3);

	// Each frame says the revision as it stood when it was sent: increments leave it where the frame before it had put it.
	const stamped = watcher.got.flatMap((m) => (m.t === "frame" ? [{ type: kindOf(m), rev: m.rev }] : []));
	expect(stamped.map((s) => s.type)).toEqual([
		"agent_start",
		"message_start",
		"message_update",
		"message_update",
		"message_update",
	]);
	const [agentStart, messageStart, ...updates] = stamped.map((s) => s.rev as number);
	expect(agentStart).toBeGreaterThan(before);
	expect(messageStart).toBe(agentStart + 1);
	expect(updates).toEqual([messageStart, messageStart, messageStart]);
	expect(live.info.revision).toBe(messageStart);

	await live.rpc({ type: "prompt", message: "finish" });
	await watcher.seen("session_settled");
	expect(live.info.revision as number).toBeGreaterThan(messageStart);
	// The frames a tab is sent when it attaches are not stamped: they are not news of the revision.
	const late = tab(live, false);
	live.resync(late.sub);
	expect(late.got.every((m) => !("rev" in m))).toBe(true);
});
