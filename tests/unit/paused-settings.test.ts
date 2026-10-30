import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Live, LivePool } from "../../server/live.ts";
import { ParkedStore } from "../../server/omp/parked.ts";
import type { PanelState } from "../../shared/panel-state.ts";
import { fakeConfig, writeFakeOmp } from "../support/fake-omp.ts";
import { pollUntil } from "../support/poll.ts";

/**
 * A frozen omp cannot be asked for its state, so the settings the session panel shows (the rows omp reports, and the
 * model whose provider says which tier fast mode is) are asked of it as it is frozen, kept true to what a user's action
 * changes while it is, written into the record of the paused conversation and told to a page that attaches (#619).
 */

const dirs: string[] = [];
const pools: LivePool[] = [];

afterEach(async () => {
	for (const pool of pools.splice(0)) {
		// A process left frozen would never read the closed stdin.
		for (const l of pool.list()) if (l.pid !== null) Bun.spawnSync(["kill", "-CONT", String(l.pid)]);
		await pool.shutdown();
	}
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const MODEL = {
	id: "claude-opus-5-5",
	name: "Opus 5.5",
	provider: "anthropic",
	api: "anthropic-messages",
	reasoning: true,
	contextWindow: 1_000_000,
	// What the panel does not read of a model stays out of the record.
	cost: { input: 5, output: 25 },
};

/** What omp reports besides the panel's settings: the record keeps none of it. */
const REPORTED = {
	model: MODEL,
	thinkingLevel: "high",
	steeringMode: "all",
	followUpMode: "one-at-a-time",
	interruptMode: "wait",
	autoCompactionEnabled: false,
	fastModeEnabled: true,
	fastModeActive: true,
	slowModeSupported: true,
	slowModeEnabled: true,
	slowModeScope: "session",
	todoPhases: [{ name: "Build", tasks: [] }],
	contextUsage: { tokens: 1, contextWindow: 2, percent: 0 },
	systemPrompt: "x".repeat(2_000),
};

const KEPT: PanelState = {
	model: {
		id: "claude-opus-5-5",
		name: "Opus 5.5",
		provider: "anthropic",
		api: "anthropic-messages",
		reasoning: true,
		contextWindow: 1_000_000,
	},
	steeringMode: "all",
	followUpMode: "one-at-a-time",
	interruptMode: "wait",
	autoCompactionEnabled: false,
	fastModeEnabled: true,
	fastModeActive: true,
	slowModeSupported: true,
	slowModeEnabled: true,
	slowModeScope: "session",
};

async function conversation(): Promise<{ dir: string; bin: string; cwd: string }> {
	const dir = mkdtempSync(join(tmpdir(), "ompw-paused-settings-"));
	dirs.push(dir);
	const bin = writeFakeOmp(dir, { state: REPORTED });
	const cwd = join(dir, "work");
	mkdirSync(cwd);
	return { dir, bin, cwd };
}

const said = (live: Live, state: Record<string, unknown>) =>
	live.rpc({ type: "set_state", state }, { user: live.info.pausedAt !== null });

test("a conversation that runs tells a page nothing of its state: omp answers for itself", async () => {
	const { dir, bin, cwd } = await conversation();
	const pool = new LivePool(fakeConfig(dir, bin));
	pools.push(pool);
	const live = await pool.open({ kind: "new", cwd }, async () => null);
	expect(live.attached().state).toBeUndefined();
	await live.refreshState();
	expect(live.attached().state).toBeUndefined();
});

test("pausing asks omp for its state first: the panel's part of it is what a page that attaches is told, and the rest is not kept", async () => {
	const { dir, bin, cwd } = await conversation();
	const pool = new LivePool(fakeConfig(dir, bin));
	pools.push(pool);
	const live = await pool.open({ kind: "new", cwd }, async () => null);
	// What the server last heard of omp is old by the time it is frozen: a setting changed in omp's own way meanwhile.
	await said(live, { steeringMode: "one-at-a-time" });
	await live.refreshState();
	await said(live, { steeringMode: "all" });

	await live.pause();
	expect(live.attached().state).toEqual(KEPT);
	// Written in the record the next server finds, and nothing else of the state.
	const [record] = pool.parked.list();
	expect(record.state).toEqual(KEPT);
	expect(JSON.stringify(record)).not.toContain("systemPrompt");
	expect(JSON.stringify(record)).not.toContain("todoPhases");
	expect(JSON.stringify(record)).not.toContain('"cost"');

	// Resumed, omp answers for itself again: the record and the reply let go of it.
	await live.resume();
	expect(live.attached().state).toBeUndefined();
});

test("a paused conversation's settings survive the server, are what the next one tells and answers a look at the state with, and a resume lets go of them", async () => {
	const { dir, bin, cwd } = await conversation();
	const first = new LivePool(fakeConfig(dir, bin));
	pools.push(first);
	const live = await first.open({ kind: "new", cwd }, async () => null);
	await live.pause();
	expect(await first.parkKept()).toBe(1);

	const second = new LivePool(fakeConfig(dir, bin));
	pools.push(second);
	expect(await second.adopt()).toBe(1);
	const adopted = second.get(live.info.liveId) as Live;
	expect(adopted.info.pausedAt).not.toBeNull();
	expect(adopted.attached().state).toEqual(KEPT);
	// A default made in another conversation looks at this one without running it (`lookState(false)`): without what the
	// record says it would be held at whatever the configuration says, which is not what it was paused with.
	expect(await adopted.lookState(false)).toMatchObject({ steeringMode: "all", fastModeEnabled: true });

	await adopted.resume();
	expect(adopted.attached().state).toBeUndefined();
	await adopted.pause();
	// Frozen again, it says what omp says now.
	expect(adopted.attached().state).toEqual(KEPT);
});

test("what a user's action changes while the conversation is paused is in what a page is told and in the record", async () => {
	const { dir, bin, cwd } = await conversation();
	const pool = new LivePool(fakeConfig(dir, bin));
	pools.push(pool);
	const live = await pool.open({ kind: "new", cwd }, async () => null);
	await live.pause();

	// A setting omp does not announce: the server folds in what it saw changed, as a page does.
	const set = await live.rpc({ type: "set_follow_up_mode", mode: "all" }, { user: true });
	expect(set.success).toBe(true);
	await pollUntil(() => pool.parked.list()[0]?.state?.followUpMode === "all", "the record to follow the change");
	expect(live.attached().state).toEqual({ ...KEPT, followUpMode: "all" });
	expect(live.info.pausedAt).not.toBeNull();

	// A model chosen while paused is what the snapshot and the record say at once, without a page's own read riding the
	// thaw: the fast-mode row reads the model's provider.
	const picked = await live.rpc({ type: "set_model", provider: "openai", modelId: "gpt-picked" }, { user: true });
	expect(picked.success).toBe(true);
	expect(live.attached().state?.model).toMatchObject({ id: "gpt-picked", provider: "openai" });
	await pollUntil(() => pool.parked.list()[0]?.state?.model?.id === "gpt-picked", "the record to follow the model");
	expect(pool.parked.list()[0]?.state?.model?.provider).toBe("openai");
	expect(live.info.pausedAt).not.toBeNull();

	// A state omp gives while it runs for an action replaces what was kept.
	await said(live, { steeringMode: "one-at-a-time", fastModeEnabled: false });
	const read = await live.rpc({ type: "get_state" }, { user: true });
	expect(read.success).toBe(true);
	await pollUntil(
		() => pool.parked.list()[0]?.state?.steeringMode === "one-at-a-time",
		"the record to follow the state",
	);
	expect(live.attached().state).toMatchObject({ steeringMode: "one-at-a-time", fastModeEnabled: false });

	// A read the page makes by itself is refused while omp is frozen, and changes nothing of what is kept.
	const refused = await live.rpc({ type: "get_state" });
	expect(refused.success).toBe(false);
	expect(live.attached().state).toMatchObject({ steeringMode: "one-at-a-time" });
});

test("a record whose state is damaged still comes back, with what in it is sound", () => {
	const dir = mkdtempSync(join(tmpdir(), "ompw-paused-record-"));
	dirs.push(dir);
	const store = new ParkedStore(dir);
	const base = {
		version: 1 as const,
		liveId: "L1",
		omp: { pid: 1, identity: "a" },
		relay: { pid: 2, identity: "b" },
		socket: "/tmp/x.sock",
		owner: null,
		cwd: "/",
		args: [],
		env: {},
		mode: "full" as const,
		startedAt: 1,
		pausedAt: 1,
		sessionFile: null,
		sessionId: null,
		streaming: false,
		overlay: null,
		interviewing: false,
		pendingUI: [],
		descendants: [],
	};
	store.save({ ...base, state: KEPT });
	expect(store.list()[0].state).toEqual(KEPT);

	// A record an older server wrote has none, and neither has one that says nothing the panel reads.
	store.save(base);
	expect(store.list()[0].state).toBeUndefined();
	store.save({ ...base, state: { todoPhases: [], systemPrompt: "x" } as never });
	expect(store.list()[0].state).toBeUndefined();
	for (const damaged of [null, "all", 7, [], { steeringMode: 3 }]) {
		store.save({ ...base, state: damaged as never });
		expect(store.list()[0].state).toBeUndefined();
	}

	// A damaged field costs that field, not the record or the rest.
	store.save({
		...base,
		state: {
			steeringMode: "all",
			followUpMode: 4,
			interruptMode: "",
			autoCompactionEnabled: "yes",
			fastModeEnabled: false,
			slowModeScope: "everywhere",
			model: { id: "m", provider: 3 },
		} as never,
	});
	expect(store.list()[0].state).toEqual({ steeringMode: "all", fastModeEnabled: false });
	store.save({
		...base,
		state: { model: { id: "m", provider: "p", contextWindow: -1, thinking: { efforts: ["low", 2] } } } as never,
	});
	expect(store.list()[0].state).toEqual({ model: { id: "m", provider: "p" } });
});
