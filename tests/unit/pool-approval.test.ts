import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Live, LivePool } from "../../server/live.ts";
import { ApprovalStore, OMP_RELOAD_MS } from "../../server/omp/approval.ts";
import type { OpenTarget } from "../../shared/protocol.ts";
import { writeFakeHostOmp } from "../support/fake-host-omp.ts";
import { fakeConfig } from "../support/fake-omp.ts";

/**
 * What the server does for tool approval and for host tools, against a scripted omp: the overlay each process gets,
 * what a mode change does to it, and how a tool call the web UI serves is held, replayed and answered.
 */

const dirs: string[] = [];
const pools: LivePool[] = [];

afterEach(async () => {
	for (const pool of pools.splice(0)) await pool.shutdown();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Every server sweeps the temp dir for the overlay directories of the servers that are gone, and these tests start
 * servers: in the shared temp dir another test file's sweep could take their overlays away mid-test, so they use one
 * of their own.
 */
const sharedTmp = process.env.TMPDIR;
let ownTmp = "";
beforeAll(() => {
	ownTmp = mkdtempSync(join(tmpdir(), "ompw-pool-approval-tmp-"));
	process.env.TMPDIR = ownTmp;
});
afterAll(() => {
	if (sharedTmp === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = sharedTmp;
	rmSync(ownTmp, { recursive: true, force: true });
});

function setup(options: { approvals?: boolean; configured?: string | null; goal?: string } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "ompw-pool-approval-"));
	dirs.push(dir);
	const log = join(dir, "log");
	writeFileSync(log, "");
	const configured = options.configured === null ? undefined : (options.configured ?? "write");
	const bin = writeFakeHostOmp(dir, log, { configured, goal: options.goal });
	// No wait for omp's reload: these tests are about what is written, not about how long it takes.
	const approval = options.approvals === false ? null : new ApprovalStore(bin, dir, 0);
	const pool = new LivePool(fakeConfig(dir, bin), null, null, approval);
	pools.push(pool);
	const sessionFile = join(dir, "session.jsonl");
	writeFileSync(sessionFile, "");
	/** Every line the fake omp logged: its argv, and each frame it received. */
	const logged = () =>
		readFileSync(log, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as { argv?: string[]; in?: Record<string, unknown> });
	const received = (type: string) => logged().flatMap((l) => (l.in?.type === type ? [l.in] : []));
	/** Open a conversation; a saved one runs where `tmpdir()` is. */
	const open = (target: OpenTarget) => pool.open(target, async () => tmpdir());
	/** A server started again on the same data dir: its pool knows nothing of the one before, but the disk. */
	const restart = () => {
		const again = new LivePool(fakeConfig(dir, bin), null, null, approval);
		pools.push(again);
		return { pool: again, open: (target: OpenTarget) => again.open(target, async () => tmpdir()) };
	};
	return { dir, pool, open, restart, approval, sessionFile, logged, received };
}

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

/** The overlay file passed as the last `--config`. */
function overlayOf(argv: string[]): string {
	expect(argv.at(-2)).toBe("--config");
	return argv.at(-1) as string;
}

// ------------------------------------------------------------------ approval modes

test("omp is given longer to reload a changed overlay than its own 200 ms debounce", () => {
	expect(OMP_RELOAD_MS).toBeGreaterThanOrEqual(300);
});

test("a new conversation starts in the mode asked for, with an overlay of its own passed last", async () => {
	const { open, logged } = setup();
	const live = await open({
		kind: "new",
		cwd: tmpdir(),
		// What the web UI's own switcher replaces: as flags they would beat the overlay.
		args: ["--approval-mode=yolo", "--model", "x", "--yolo"],
		approvalMode: "always-ask",
	});
	expect(live.info.approvalMode).toBe("always-ask");
	const argv = logged()[0].argv as string[];
	expect(argv.slice(0, 4)).toEqual(["--mode", "rpc-ui", "--model", "x"]);
	const file = overlayOf(argv);
	expect(readFileSync(file, "utf8")).toContain("approvalMode: always-ask");
	// What the UI lists as the process's arguments is what was asked for, not the plumbing.
	expect(live.info.args).toEqual(["--model", "x"]);
});

test("without a request a conversation starts in the user's default, else in the mode omp's own settings give", async () => {
	const { open, approval } = setup({ configured: "write" });
	expect((await open({ kind: "new", cwd: tmpdir() })).info.approvalMode).toBe("write");
	(approval as ApprovalStore).setDefault("yolo");
	expect((await open({ kind: "new", cwd: tmpdir() })).info.approvalMode).toBe("yolo");
	// A mode that is not one is ignored rather than passed to omp.
	const bad = { kind: "new" as const, cwd: tmpdir(), approvalMode: "reckless" as never };
	expect((await open(bad)).info.approvalMode).toBe("yolo");
});

test("when omp cannot say what it would do, no mode is claimed and the overlay leaves the setting alone", async () => {
	const { open, logged } = setup({ configured: null });
	const live = await open({ kind: "new", cwd: tmpdir() });
	expect(live.info.approvalMode).toBeUndefined();
	expect(readFileSync(overlayOf(logged()[0].argv as string[]), "utf8")).not.toContain("approvalMode");
});

test("Ask and remember is a mode of its own: asked for, or omp's own, it is written to the overlay and claimed", async () => {
	const { open, logged } = setup({ configured: "always-ask-cached" });
	const own = await open({ kind: "new", cwd: tmpdir() });
	expect(own.info.approvalMode).toBe("always-ask-cached");
	expect(own.info.approvalOmp).toBeUndefined();
	expect(readFileSync(overlayOf(logged()[0].argv as string[]), "utf8")).toContain("approvalMode: always-ask-cached");

	const asked = await open({ kind: "new", cwd: tmpdir(), args: ["--model", "x"], approvalMode: "always-ask-cached" });
	expect(asked.info.approvalMode).toBe("always-ask-cached");
	await asked.setApprovalMode("write");
	await asked.setApprovalMode("always-ask-cached");
	const second = logged().filter((l) => l.argv)[1].argv as string[];
	expect(readFileSync(overlayOf(second), "utf8")).toContain("approvalMode: always-ask-cached");
});

test("a mode a newer omp has stays in force and is named, until the user picks one", async () => {
	const { open, logged } = setup({ configured: "paranoid" });
	const live = await open({ kind: "new", cwd: tmpdir() });
	// Nothing of ours is written: omp keeps the setting it was given.
	expect(live.info.approvalMode).toBeUndefined();
	expect(live.info.approvalOmp).toBe("paranoid");
	expect(readFileSync(overlayOf(logged()[0].argv as string[]), "utf8")).not.toContain("approvalMode");

	await live.setApprovalMode("write");
	expect(live.info.approvalMode).toBe("write");
	expect(live.info.approvalOmp).toBeUndefined();
});

test("a mode change rewrites the overlay at once and is announced once omp has had time to reload it", async () => {
	const { pool, open, logged } = setup();
	const live = await open({ kind: "new", cwd: tmpdir(), approvalMode: "yolo" });
	const file = overlayOf(logged()[0].argv as string[]);
	const announced: (string | undefined)[] = [];
	pool.onAnnounce((info) => announced.push(info.approvalMode));

	const change = live.setApprovalMode("always-ask");
	// The file is in place already; what omp is told to do is not shown as "in force" before it has reloaded.
	expect(readFileSync(file, "utf8")).toContain("approvalMode: always-ask");
	expect(live.info.approvalMode).toBe("yolo");
	expect(announced).not.toContain("always-ask");
	await change;
	expect(live.info.approvalMode).toBe("always-ask");
	expect(announced).toContain("always-ask");

	// Asking for the mode it is in rewrites nothing and announces nothing.
	announced.length = 0;
	await live.setApprovalMode("always-ask");
	expect(announced).toEqual([]);
});

test("a process a reloaded page left unused is taken over in the mode the next page asks for", async () => {
	const { open, approval, logged } = setup({ configured: "write" });
	const first = await open({ kind: "new", cwd: tmpdir(), approvalMode: "always-ask" });
	expect(first.info.approvalMode).toBe("always-ask");
	const file = overlayOf(logged()[0].argv as string[]);

	const second = await open({ kind: "new", cwd: tmpdir(), approvalMode: "yolo" });
	expect(second).toBe(first);
	expect(second.info.approvalMode).toBe("yolo");
	expect(readFileSync(file, "utf8")).toContain("approvalMode: yolo");
	// What the user picked is kept for the conversation.
	expect((approval as ApprovalStore).sessionMode(second.info.sessionFile as string)).toBe("yolo");

	// A page that picked nothing gets what a new conversation starts in, and keeps nothing for it.
	const third = await open({ kind: "new", cwd: tmpdir() });
	expect(third).toBe(first);
	expect(third.info.approvalMode).toBe("write");
	expect((approval as ApprovalStore).sessionMode(third.info.sessionFile as string)).toBe("yolo");
});

test("a spare closed while it is being taken over is replaced by a new process, not handed out dead", async () => {
	const { open, approval } = setup({ configured: "write" });
	const first = await open({ kind: "new", cwd: tmpdir() });
	// The page that left it closes it (over its own socket) while the next page's open looks up the mode.
	const store = approval as ApprovalStore;
	const startingMode = store.startingMode.bind(store);
	store.startingMode = (...args) => {
		first.client.close();
		return startingMode(...args);
	};
	const live = await open({ kind: "new", cwd: tmpdir(), approvalMode: "yolo" });
	expect(live).not.toBe(first);
	expect(live.info.exited).toBe(false);
	expect(live.info.approvalMode).toBe("yolo");
});

test("a spare closed while its mode is being changed is replaced too", async () => {
	const { open } = setup({ configured: "write" });
	const first = await open({ kind: "new", cwd: tmpdir() });
	const setMode = first.setApprovalMode.bind(first);
	first.setApprovalMode = (...args) => {
		first.client.close();
		return setMode(...args);
	};
	const live = await open({ kind: "new", cwd: tmpdir(), approvalMode: "yolo" });
	expect(live).not.toBe(first);
	expect(live.info.approvalMode).toBe("yolo");
});

test("two pages opening at once don't take the same spare", async () => {
	const { open } = setup({ configured: "write" });
	const first = await open({ kind: "new", cwd: tmpdir() });
	const [a, b] = await Promise.all([open({ kind: "new", cwd: tmpdir() }), open({ kind: "new", cwd: tmpdir() })]);
	expect(a).not.toBe(b);
	expect([a, b]).toContain(first);
});

test("a new conversation started in a mode the page picked keeps it for when it is resumed", async () => {
	const { open, approval } = setup();
	const live = await open({ kind: "new", cwd: tmpdir(), approvalMode: "always-ask" });
	expect((approval as ApprovalStore).sessionMode(live.info.sessionFile as string)).toBe("always-ask");
});

test("two quick changes leave the last one in force", async () => {
	const { open, logged } = setup();
	const live = await open({ kind: "new", cwd: tmpdir(), approvalMode: "yolo" });
	const file = overlayOf(logged()[0].argv as string[]);
	await Promise.all([live.setApprovalMode("write"), live.setApprovalMode("always-ask")]);
	expect(live.info.approvalMode).toBe("always-ask");
	expect(readFileSync(file, "utf8")).toContain("approvalMode: always-ask");
});

test("the user's choice is kept as soon as it is made, before omp has had time to reload it", async () => {
	const { open, approval, sessionFile } = setup({ configured: "yolo" });
	const live = await open({ kind: "resume", sessionFile });
	const change = live.setApprovalMode("always-ask");
	// Not announced as in force yet, but already what the conversation resumes in if its process ends now.
	expect((approval as ApprovalStore).sessionMode(realpathSync(sessionFile))).toBe("always-ask");
	expect(live.info.approvalMode).toBe("yolo");
	await change;
});

test("a conversation resumes in the mode the user last picked for it", async () => {
	const { open, sessionFile } = setup({ configured: "yolo" });
	const target = { kind: "resume" as const, sessionFile };
	const first = await open(target);
	expect(first.info.sessionFile).toBe(realpathSync(sessionFile));
	expect(first.info.approvalMode).toBe("yolo");
	await first.setApprovalMode("always-ask");
	first.client.close();
	await first.client.whenExited;

	const second = await open(target);
	expect(second).not.toBe(first);
	expect(second.info.approvalMode).toBe("always-ask");
});

test("an overlay goes away with its process", async () => {
	const { open, logged } = setup();
	const live = await open({ kind: "new", cwd: tmpdir() });
	const file = overlayOf(logged()[0].argv as string[]);
	expect(existsSync(file)).toBe(true);
	live.client.close();
	await live.client.whenExited;
	await until(() => !existsSync(file));
});

test("a pool without approval modes starts omp on its own settings and refuses a change", async () => {
	const { open, logged } = setup({ approvals: false });
	const live = await open({ kind: "new", cwd: tmpdir(), args: ["--approval-mode=always-ask"] });
	expect(live.info.approvalMode).toBeUndefined();
	// Nothing manages the mode here, so the user's own flag is left as they gave it.
	expect(logged()[0].argv).toEqual(["--mode", "rpc-ui", "--approval-mode=always-ask"]);
	await expect(live.setApprovalMode("yolo")).rejects.toThrow(/does not take permission modes/);
});

test("a process that has exited takes no change", async () => {
	const { open } = setup();
	const live = await open({ kind: "new", cwd: tmpdir() });
	live.client.close();
	await live.client.whenExited;
	await expect(live.setApprovalMode("yolo")).rejects.toThrow(/not running/);
});

// ------------------------------------------------------------------ host tool calls

/** A tab: what the server sent it, and a way to wait for a frame of one kind. */
function tab(live: Live) {
	const got: Record<string, unknown>[] = [];
	const sub = { send: (m: unknown) => got.push(m as Record<string, unknown>) };
	live.subscribers.add(sub);
	const frames = () => got.flatMap((m) => (m.t === "frame" ? [m.frame as Record<string, unknown>] : []));
	return { sub, frames, seen: (type: string) => until(() => frames().some((f) => f.type === type)) };
}

const text = (s: string) => ({ content: [{ type: "text", text: s }] });

test("a host tool call waits for the user like a dialog: the process is busy, a late tab gets it, the answer is its result", async () => {
	const { open, received } = setup();
	const live = await open({ kind: "new", cwd: tmpdir() });
	const first = tab(live);
	expect(live.busy).toBe(false);
	await live.rpc({ type: "prompt", message: "call" });
	await first.seen("host_tool_call");
	expect(first.frames().find((f) => f.type === "host_tool_call")).toMatchObject({ id: "h1", toolName: "propose_goal" });

	// Nobody watches and nothing runs, yet the process must not be taken for idle: the user still has to decide.
	live.subscribers.delete(first.sub);
	expect(live.busy).toBe(true);

	// A tab that attaches later (a reload) is shown the call again.
	const late = tab(live);
	live.resync(late.sub);
	expect(late.frames().find((f) => f.type === "host_tool_call")).toMatchObject({ id: "h1" });

	live.respondUI({ id: "h1", result: text("The user confirmed the goal.") });
	await until(() => received("host_tool_result").length === 1);
	expect(received("host_tool_result")[0]).toEqual({
		type: "host_tool_result",
		id: "h1",
		result: text("The user confirmed the goal."),
	});
	expect(live.busy).toBe(false);
	// Every other tab is told it is settled, so none keeps showing it.
	expect(late.frames().find((f) => f.method === "cancel")).toMatchObject({ targetId: "h1" });
});

test("a result that reports an error says so", async () => {
	const { open, received } = setup();
	const live = await open({ kind: "new", cwd: tmpdir() });
	const watcher = tab(live);
	await live.rpc({ type: "prompt", message: "call" });
	await watcher.seen("host_tool_call");
	live.respondUI({ id: "h1", result: text("propose_goal needs a non-empty objective."), isError: true });
	await until(() => received("host_tool_result").length === 1);
	expect(received("host_tool_result")[0]).toMatchObject({ id: "h1", isError: true });
});

test("when omp gives up on a call the process is no longer waiting, and a late answer to it is dropped", async () => {
	const { open, received } = setup();
	const live = await open({ kind: "new", cwd: tmpdir() });
	const watcher = tab(live);
	await live.rpc({ type: "prompt", message: "call" });
	await watcher.seen("host_tool_call");
	expect(live.busy).toBe(true);
	await live.rpc({ type: "prompt", message: "cancel" });
	await watcher.seen("host_tool_cancel");
	expect(live.busy).toBe(false);

	live.respondUI({ id: "h1", result: text("too late") });
	// A dialog answer, sent afterwards, shows the log has caught up with everything before it.
	live.respondUI({ id: "u1", value: "x" });
	await until(() => received("extension_ui_response").length === 1);
	expect(received("host_tool_result")).toEqual([]);
});

test("an answer to a dialog still goes out as a dialog response", async () => {
	const { open, received } = setup();
	const live = await open({ kind: "new", cwd: tmpdir() });
	live.respondUI({ id: "ui-1", confirmed: true });
	await until(() => received("extension_ui_response").length === 1);
	expect(received("extension_ui_response")[0]).toEqual({ type: "extension_ui_response", id: "ui-1", confirmed: true });
});

// ------------------------------------------------------------------ a conversation that moves to another session file

/** The session file omp moves to after `n` moves from `file` (see the fake omp). */
const movedTo = (file: string, n: number) => `${file.replace(/\.jsonl$/, "")}-${n}.jsonl`;

test("the mode the user picked follows the conversation when it branches or forks to a new session file", async () => {
	const { open, approval, sessionFile } = setup({ configured: "yolo" });
	const store = approval as ApprovalStore;
	const live = await open({ kind: "resume", sessionFile });
	await live.setApprovalMode("always-ask");
	const original = realpathSync(sessionFile);
	expect(store.sessionMode(original)).toBe("always-ask");

	for (const [n, type] of [
		[1, "branch"],
		[2, "fork"],
	] as const) {
		await live.rpc({ type });
		await until(() => live.info.sessionFile === movedTo(original, n));
		// The process keeps running in the mode, and the new file would resume in it too.
		expect(live.info.approvalMode).toBe("always-ask");
		expect(store.sessionMode(movedTo(original, n))).toBe("always-ask");
	}
	// The conversation it came from keeps its own.
	expect(store.sessionMode(original)).toBe("always-ask");
});

test("a conversation the user never picked a mode for leaves nothing behind when it branches", async () => {
	const { open, approval, sessionFile } = setup({ configured: "yolo" });
	const live = await open({ kind: "resume", sessionFile });
	const original = realpathSync(sessionFile);
	await live.rpc({ type: "branch" });
	await until(() => live.info.sessionFile === movedTo(original, 1));
	expect((approval as ApprovalStore).sessionMode(movedTo(original, 1))).toBeNull();
});

test("a pick the destination already has is not overwritten by the one the conversation came with", async () => {
	const { open, approval, sessionFile } = setup({ configured: "yolo" });
	const store = approval as ApprovalStore;
	const original = realpathSync(sessionFile);
	store.rememberSession(movedTo(original, 1), "write");
	const live = await open({ kind: "resume", sessionFile });
	await live.setApprovalMode("always-ask");
	await live.rpc({ type: "branch" });
	await until(() => live.info.sessionFile === movedTo(original, 1));
	expect(store.sessionMode(movedTo(original, 1))).toBe("write");
});

// ------------------------------------------------------------------ a guided interview outlives its process

const proposeTool = { name: "propose_goal", label: "Propose goal", description: "d", parameters: {} };

/** The names of the tools each `set_host_tools` the fake omp received handed over, oldest first. */
const toolSets = (received: (type: string) => Record<string, unknown>[]) =>
	received("set_host_tools").map((f) => (f.tools as { name: string }[]).map((t) => t.name));

test("a conversation that was interviewing gets the guided-goal tool back when it is resumed in a new process", async () => {
	const { open, received, sessionFile } = setup();
	const target = { kind: "resume" as const, sessionFile };
	const first = await open(target);
	await first.rpc({ type: "set_host_tools", tools: [proposeTool] });
	// The process goes away: reaped as idle, closed for the terminal, killed with the server.
	first.client.close();
	await first.client.whenExited;

	const second = await open(target);
	expect(second).not.toBe(first);
	expect(toolSets(received)).toEqual([["propose_goal"], ["propose_goal"]]);
	// And again: the interview is still open until it ends.
	second.client.close();
	await second.client.whenExited;
	await open(target);
	expect(toolSets(received)).toHaveLength(3);
});

test("the interview is remembered across a restart of the server", async () => {
	const { pool, open, restart, received, sessionFile } = setup();
	const target = { kind: "resume" as const, sessionFile };
	const first = await open(target);
	await first.rpc({ type: "set_host_tools", tools: [proposeTool] });
	await pool.shutdown();

	await restart().open(target);
	expect(toolSets(received)).toEqual([["propose_goal"], ["propose_goal"]]);
});

test("a conversation whose interview ended is resumed as an ordinary one", async () => {
	const { open, received, sessionFile } = setup();
	const target = { kind: "resume" as const, sessionFile };
	// Confirmed, cancelled or set directly: each of them takes the tool away.
	const first = await open(target);
	await first.rpc({ type: "set_host_tools", tools: [proposeTool] });
	await first.rpc({ type: "set_host_tools", tools: [] });
	first.client.close();
	await first.client.whenExited;
	await open(target);
	expect(toolSets(received)).toEqual([["propose_goal"], []]);
});

test("creating a goal ends the interview even if the tool is still held", async () => {
	const { open, received, sessionFile } = setup();
	const target = { kind: "resume" as const, sessionFile };
	const first = await open(target);
	await first.rpc({ type: "set_host_tools", tools: [proposeTool] });
	await first.rpc({ type: "goal", op: "create", objective: "Ship it" });
	first.client.close();
	await first.client.whenExited;
	await open(target);
	expect(toolSets(received)).toEqual([["propose_goal"]]);
});

test("a conversation that has a goal by now (set in the terminal) is not put back in an interview", async () => {
	const { open, received, sessionFile } = setup({ goal: "active" });
	const target = { kind: "resume" as const, sessionFile };
	const first = await open(target);
	await first.rpc({ type: "set_host_tools", tools: [proposeTool] });
	first.client.close();
	await first.client.whenExited;
	await open(target);
	expect(toolSets(received)).toEqual([["propose_goal"]]);
	// And it stays forgotten once the goal is gone.
	const again = await open(target);
	again.client.close();
	await again.client.whenExited;
	await open(target);
	expect(toolSets(received)).toEqual([["propose_goal"]]);
});

test("an interview moves with the conversation when it branches", async () => {
	const { open, received, sessionFile } = setup();
	const first = await open({ kind: "resume", sessionFile });
	const original = realpathSync(sessionFile);
	await first.rpc({ type: "set_host_tools", tools: [proposeTool] });
	await first.rpc({ type: "branch" });
	await until(() => first.info.sessionFile === movedTo(original, 1));
	first.client.close();
	await first.client.whenExited;

	// omp writes the branch's file; resuming that one finds the interview where it was left.
	writeFileSync(movedTo(original, 1), "");
	await open({ kind: "resume", sessionFile: movedTo(original, 1) });
	expect(toolSets(received)).toEqual([["propose_goal"], ["propose_goal"]]);
});
