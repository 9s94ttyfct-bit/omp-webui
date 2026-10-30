import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Live, LivePool } from "../../server/live.ts";
import { isRecord } from "../../shared/guards.ts";
import { writeFakeHostOmp } from "../support/fake-host-omp.ts";
import { fakeConfig } from "../support/fake-omp.ts";

/**
 * What omp says once (a compaction under way, the status lines and widgets of extensions, a `!command` that runs, when a
 * turn began) is kept by the server and told to a tab that attaches afterwards, with the names of all of it so that the tab
 * drops what it shows beyond (#587). Against a scripted omp, no model.
 */

const dirs: string[] = [];
const pools: LivePool[] = [];

afterEach(async () => {
	for (const pool of pools.splice(0)) await pool.shutdown();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(): Promise<Live> {
	const dir = mkdtempSync(join(tmpdir(), "ompw-pool-held-"));
	dirs.push(dir);
	const log = join(dir, "log");
	writeFileSync(log, "");
	const bin = writeFakeHostOmp(dir, log, {});
	const pool = new LivePool(fakeConfig(dir, bin), null, null, null);
	pools.push(pool);
	return pool.open({ kind: "new", cwd: tmpdir() }, async () => tmpdir());
}

/** A tab: everything the server sent it. */
function tab(live: Live, subscribed = true) {
	const got: Record<string, unknown>[] = [];
	const sub = { send: (m: unknown) => got.push(m as Record<string, unknown>) };
	if (subscribed) live.subscribers.add(sub);
	const frames = () => got.flatMap((m) => (m.t === "frame" && isRecord(m.frame) ? [m.frame] : []));
	return { sub, got, frames, seen: (type: string) => until(() => frames().some((f) => f.type === type)) };
}

async function until(condition: () => boolean): Promise<void> {
	const deadline = performance.now() + 10_000;
	while (!condition()) {
		if (performance.now() > deadline) throw new Error("the condition never held");
		const turn = Promise.withResolvers<void>();
		setImmediate(turn.resolve);
		await turn.promise;
	}
}

const say = (live: Live, ...frames: Record<string, unknown>[]) => live.rpc({ type: "emit_frames", frames });

/** What a tab that attached now is told: the frames, and the names of what the server holds. */
function attach(live: Live) {
	const late = tab(live, false);
	live.resync(late.sub);
	const last = late.got.at(-1);
	const held = isRecord(last) && isRecord(last.held) ? last.held : {};
	return { frames: late.frames(), held };
}

const status = (key: string, text?: string) => ({
	type: "extension_ui_request",
	id: `s-${key}`,
	method: "setStatus",
	statusKey: key,
	...(text === undefined ? {} : { statusText: text }),
});
const widget = (key: string, lines: string[]) => ({
	type: "extension_ui_request",
	id: `w-${key}`,
	method: "setWidget",
	widgetKey: key,
	widgetLines: lines,
});

test("a compaction that is under way is told to a tab that attaches, and is no more once it ends or the session settles", async () => {
	const live = await start();
	const first = tab(live);
	await say(live, { type: "auto_compaction_start", reason: "threshold", action: "context-full" });
	await first.seen("auto_compaction_start");

	const during = attach(live);
	expect(during.frames.map((f) => f.type)).toEqual(["auto_compaction_start"]);
	expect(during.held).toMatchObject({ compacting: true });

	await say(live, { type: "auto_compaction_end", action: "context-full", result: { tokensBefore: 1 } });
	await first.seen("auto_compaction_end");
	expect(attach(live)).toMatchObject({ frames: [], held: { compacting: false } });

	// A compaction whose end omp never said ends at the settled session, as it does on a page.
	await say(live, { type: "auto_compaction_start" });
	await until(() => attach(live).held.compacting === true);
	await say(live, { type: "session_settled" });
	await until(() => attach(live).held.compacting === false);
});

test("the status lines and widgets of extensions are told to a tab that attaches, by key, until the extension takes them away", async () => {
	const live = await start();
	const first = tab(live);
	await say(live, status("lint", "Lint: 3 warnings"), status("build", "Building"), widget("todo", ["one", "two"]));
	await until(() => first.frames().filter((f) => f.type === "extension_ui_request").length === 3);

	const late = attach(live);
	expect(late.frames.map((f) => String(f.id)).sort()).toEqual(["s-build", "s-lint", "w-todo"]);
	expect(late.held).toMatchObject({ statuses: ["lint", "build"], widgets: ["todo"] });

	await say(live, status("build"), widget("todo", []));
	await until(() => first.frames().filter((f) => f.type === "extension_ui_request").length === 5);
	const after = attach(live);
	expect(after.frames.map((f) => String(f.id))).toEqual(["s-lint"]);
	expect(after.held).toMatchObject({ statuses: ["lint"], widgets: [] });
});

test("a !command that runs is told to every tab, the one that sent it too, and to one that attaches meanwhile, until omp answers it", async () => {
	const live = await start();
	const first = tab(live);
	const sent = live.rpc({ type: "bash", command: "hold sleep 5" });
	await first.seen("bash_started");
	const [started] = first.frames().filter((f) => f.type === "bash_started");
	expect(started).toMatchObject({ command: "hold sleep 5", startedAt: expect.any(Number) });

	// A tab that attaches while it runs is told it runs, with the name the others know it by.
	const late = attach(live);
	expect(late.frames).toEqual([started]);
	expect(late.held).toMatchObject({ bashes: [started.id] });

	// Another runs beside it: omp runs commands side by side.
	const second = live.rpc({ type: "bash", command: "hold sleep 6" });
	await until(() => first.frames().filter((f) => f.type === "bash_started").length === 2);
	expect(attach(live).held.bashes).toHaveLength(2);

	await live.rpc({ type: "release_bash" });
	await Promise.all([sent, second]);
	expect(first.frames().filter((f) => f.type === "bash_ended")).toHaveLength(2);
	expect(attach(live)).toMatchObject({ frames: [], held: { bashes: [] } });
});

test("the turn's start is stamped when it begins, kept through a turn omp carries on, and dropped when the turn ends", async () => {
	const live = await start();
	expect(live.info.turnStartedAt).toBeUndefined();
	const before = Date.now();
	await live.rpc({ type: "prompt", message: "stream" });
	await until(() => live.info.turnStartedAt !== undefined);
	const began = live.info.turnStartedAt as number;
	expect(began).toBeGreaterThanOrEqual(before);
	expect(live.attached().turnStartedAt).toBe(began);

	// omp stops the agent without finishing the turn and starts it again: one turn, one clock.
	await say(live, { type: "agent_end", isTerminal: false });
	// (the frames omp prints before it answers `emit_frames` reach the server before the answer: no wait is needed)
	await say(live, { type: "agent_start" });
	await until(() => live.info.streaming);
	expect(live.info.turnStartedAt).toBe(began);

	await live.rpc({ type: "prompt", message: "finish" });
	await until(() => !live.info.streaming);
	expect(live.info.turnStartedAt).toBeUndefined();
});
