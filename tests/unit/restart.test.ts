import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import restartSession, {
	RESTART_ACCEPTED_RESULT,
	RESTART_DESCRIPTION,
	RESTART_FILE_ENV,
	RESTART_SESSION_TOOL,
} from "../../server/omp/restart/extension.ts";
import { installRestartExtension, RestartService, restartPaths } from "../../server/omp/restart/install.ts";
import {
	KEEP_SETTLED_MS,
	newRestartId,
	type RestartRequest,
	RestartStateError,
	RestartStore,
	requestOf,
} from "../../server/omp/restart/store.ts";
import {
	parseRestartMessage,
	RESTART_LIMITS,
	RESTART_MAX,
	RESTART_REFUSALS,
	RESTART_TOOL,
	RESTART_WINDOW_MS,
	refusalMessage,
	restartArgsOf,
	restartMessage,
} from "../../shared/restart.ts";

/**
 * `restart_session` (`shared/restart.ts`) piece by piece: the request store and its state machine (one way only, written
 * down at each step, read back by the next server, the limit of three an hour), the messages the agent is sent and how the
 * page reads them back, the call's arguments as the server keeps them, and the extension's own side (main agent only, the
 * limit from its file).
 */

const root = mkdtempSync(join(tmpdir(), "ompw-restart-unit-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const dir = () => mkdtempSync(join(root, "d-"));

const FIELDS = {
	by: "agent",
	liveId: "L1-x",
	session: "/s/a.jsonl",
	cwd: "/w",
	mode: "full",
	reason: "stuck",
	continueWith: "go on",
	force: false,
	state: "requested",
} as const;

describe("the request store", () => {
	test("a request goes requested → restarting → resumed → delivered, stamped at each step and read back by the next server", () => {
		const data = dir();
		let now = 1_000;
		const store = new RestartStore(data, () => now);
		const r = store.create(FIELDS);
		expect(r.id).toMatch(/^r-[0-9a-f]{16}$/);
		expect(r.requestedAt).toBe(1_000);
		now = 2_000;
		store.move(r.id, "restarting");
		now = 3_000;
		store.move(r.id, "resumed", { newLiveId: "L2-y" });
		expect(store.open().map((x) => x.id)).toEqual([r.id]);
		now = 4_000;
		store.move(r.id, "delivered");
		const back = new RestartStore(data, () => now).get(r.id);
		expect(back).toMatchObject({
			state: "delivered",
			newLiveId: "L2-y",
			requestedAt: 1_000,
			restartingAt: 2_000,
			resumedAt: 3_000,
			settledAt: 4_000,
		});
		expect(new RestartStore(data, () => now).open()).toEqual([]);
	});

	test("it never goes back, nor skips a step, nor leaves a settled state", () => {
		const store = new RestartStore(dir());
		const r = store.create(FIELDS);
		expect(() => store.move(r.id, "resumed")).toThrow(RestartStateError);
		expect(() => store.move(r.id, "delivered")).toThrow(RestartStateError);
		store.move(r.id, "restarting");
		expect(() => store.move(r.id, "requested")).toThrow(RestartStateError);
		expect(() => store.move(r.id, "refused")).toThrow(RestartStateError);
		store.move(r.id, "failed", { error: "omp did not end" });
		for (const to of ["requested", "restarting", "resumed", "delivered", "refused", "failed"] as const)
			expect(() => store.move(r.id, to)).toThrow(RestartStateError);
		expect(() => store.move("r-0000000000000000", "restarting")).toThrow(RestartStateError);
	});

	test("the request that waits is the process's own, and a second call changes its words", () => {
		const store = new RestartStore(dir());
		const r = store.create(FIELDS);
		expect(store.waiting("L1-x")?.id).toBe(r.id);
		expect(store.waiting("L9-z")).toBeUndefined();
		store.patch(r.id, { reason: "still stuck", continueWith: "go on again", force: true });
		expect(store.waiting("L1-x")).toMatchObject({ reason: "still stuck", continueWith: "go on again", force: true });
		store.move(r.id, "refused", { refusal: "paused" });
		expect(store.waiting("L1-x")).toBeUndefined();
	});

	test("the limit: three restarts the agent asked for in an hour, refused ones and the person's not counted", () => {
		let now = 10 * RESTART_WINDOW_MS;
		const store = new RestartStore(dir(), () => now);
		const session = FIELDS.session;
		store.create({ ...FIELDS, by: "user", continueWith: null });
		const refused = store.create(FIELDS);
		store.move(refused.id, "refused", { refusal: "subagents" });
		store.create({ ...FIELDS, session: "/s/other.jsonl" });
		expect(store.blockedUntil(session)).toBeNull();
		const first = store.create(FIELDS);
		now += 1_000;
		store.create(FIELDS);
		now += 1_000;
		expect(store.blockedUntil(session)).toBeNull();
		const third = store.create(FIELDS);
		// The oldest of the three leaves the window an hour after it was asked for.
		expect(store.blockedUntil(session)).toBe(first.requestedAt + RESTART_WINDOW_MS);
		// One asked for again (the same turn's second call) does not count against itself.
		expect(store.blockedUntil(session, third.id)).toBeNull();
		now = first.requestedAt + RESTART_WINDOW_MS + 1;
		expect(store.blockedUntil(session)).toBeNull();
		expect(RESTART_MAX).toBe(3);
	});

	test("settled records older than a day go; open ones stay; damaged files are left out", () => {
		const data = dir();
		let now = 5 * KEEP_SETTLED_MS;
		const store = new RestartStore(data, () => now);
		const done = store.create(FIELDS);
		store.move(done.id, "refused", { refusal: "asking" });
		const open = store.create(FIELDS);
		const folder = join(data, "restart", "requests");
		writeFileSync(join(folder, "r-1111111111111111.json"), "{not json");
		writeFileSync(join(folder, "r-2222222222222222.json"), JSON.stringify({ version: 1, id: "r-2222222222222222" }));
		now += KEEP_SETTLED_MS + 1;
		const back = new RestartStore(data, () => now);
		expect(back.get(done.id)).toBeUndefined();
		expect(existsSync(join(folder, `${done.id}.json`))).toBe(false);
		expect(back.get(open.id)?.state).toBe("requested");
		expect(back.list().map((r) => r.id)).toEqual([open.id]);
	});

	test("what a record must hold to be read", () => {
		const good: RestartRequest = { version: 1, id: newRestartId(), requestedAt: 1, ...FIELDS };
		expect(requestOf(good)).toEqual(good);
		expect(requestOf({ ...good, id: "../../etc" })).toBeNull();
		expect(requestOf({ ...good, state: "done" })).toBeNull();
		expect(requestOf({ ...good, mode: "turbo" })).toBeNull();
		expect(requestOf({ ...good, session: "" })).toBeNull();
		expect(requestOf({ ...good, refusal: "bored" })).toBeNull();
		expect(requestOf({ ...good, continueWith: 3 })).toBeNull();
		expect(requestOf({ ...good, version: 2 })).toBeNull();
	});
});

describe("the messages", () => {
	test("the restart's message names the request, says it is the agent's own, and is read back as a divider", () => {
		const id = newRestartId();
		const text = restartMessage(id, "bash\nhangs", "Check X.\nThen Y.");
		expect(text.split("\n")[0]).toBe(`[omp-webui restart ${id}] Restarted by the agent: bash hangs`);
		expect(text).toContain("it is not from the person");
		expect(parseRestartMessage(text)).toEqual({
			kind: "restarted",
			id,
			reason: "bash hangs",
			continueWith: "Check X.\nThen Y.",
		});
	});

	test("every refusal says why and what to do, and is read back", () => {
		const id = newRestartId();
		for (const why of RESTART_REFUSALS) {
			const text = refusalMessage(id, why, "stuck");
			expect(text).toStartWith(`[omp-webui restart-refused ${id} ${why}] Restart refused: `);
			expect(text).toContain("Nothing was ended");
			expect(parseRestartMessage(text)).toEqual({ kind: "refused", id, why });
		}
		expect(refusalMessage(id, "subagents", "x")).toContain("force: true");
	});

	test("any other message is not one", () => {
		for (const text of [
			"hello",
			"[omp-webui restart r-123] Restarted by the agent: x",
			"see [omp-webui restart r-0123456789abcdef] Restarted by the agent: x",
			"[omp-webui restart r-0123456789abcdef] Something else",
			"[omp-webui restart-refused r-0123456789abcdef bored] Restart refused: x",
		])
			expect(parseRestartMessage(text)).toBeNull();
	});

	test("the call's arguments are held to their limits; a call without a reason or a next step is none", () => {
		expect(restartArgsOf({ reason: "  stuck\n  badly ", continue_with: " go on ", force: true })).toEqual({
			reason: "stuck badly",
			continueWith: "go on",
			force: true,
		});
		expect(restartArgsOf({ reason: "x", continue_with: "y", force: "yes" })?.force).toBe(false);
		const long = restartArgsOf({ reason: "r".repeat(1_000), continue_with: "c".repeat(10_000) });
		expect(long?.reason).toHaveLength(RESTART_LIMITS.reason);
		expect(long?.continueWith).toHaveLength(RESTART_LIMITS.continueWith);
		expect(restartArgsOf({ reason: "x" })).toBeNull();
		expect(restartArgsOf({ continue_with: "y" })).toBeNull();
		expect(restartArgsOf({ reason: " ", continue_with: "y" })).toBeNull();
		expect(restartArgsOf(null)).toBeNull();
	});
});

describe("the extension", () => {
	interface Loaded {
		tool: Record<string, unknown>;
		active: string[];
		turn(kind: string | undefined): Promise<unknown>;
		run(kind?: string): Promise<{ content: { text: string }[] }>;
	}
	function load(file: string | undefined): Loaded {
		const before = process.env[RESTART_FILE_ENV];
		if (file === undefined) delete process.env[RESTART_FILE_ENV];
		else process.env[RESTART_FILE_ENV] = file;
		try {
			const tools: Record<string, unknown>[] = [];
			const active = ["read", "bash"];
			let handler: ((e: unknown, ctx: unknown) => Promise<unknown>) | undefined;
			restartSession({
				on: (_event, h) => {
					handler = h as typeof handler;
				},
				registerTool: (t) => {
					tools.push(t);
				},
				getActiveTools: () => [...active],
				setActiveTools: (names) => {
					active.splice(0, active.length, ...names);
				},
			});
			const tool = tools[0] as Record<string, unknown>;
			const execute = tool.execute as (...args: unknown[]) => Promise<{ content: { text: string }[] }>;
			return {
				tool,
				active,
				turn: async (kind) => handler?.({ systemPrompt: [] }, kind ? { agent: { kind } } : {}),
				run: (kind) => execute("call-1", {}, undefined, undefined, kind ? { agent: { kind } } : undefined),
			};
		} finally {
			if (before === undefined) delete process.env[RESTART_FILE_ENV];
			else process.env[RESTART_FILE_ENV] = before;
		}
	}

	test("the tool is registered inactive and needs no approval; only the main agent's turn makes it active", async () => {
		const ext = load(undefined);
		expect(ext.tool).toMatchObject({ name: RESTART_TOOL, defaultInactive: true, approval: "read" });
		expect(ext.tool.description).toBe(RESTART_DESCRIPTION);
		await ext.turn("sub");
		await ext.turn(undefined);
		expect(ext.active).toEqual(["read", "bash"]);
		expect(await ext.turn("main")).toBeUndefined();
		expect(ext.active).toEqual(["read", "bash", RESTART_TOOL]);
		await ext.turn("main");
		expect(ext.active.filter((n) => n === RESTART_TOOL)).toHaveLength(1);
	});

	test("a call returns at once with the result that tells the agent to end its turn; another agent's is refused", async () => {
		const ext = load(undefined);
		expect((await ext.run("main")).content[0]?.text).toBe(RESTART_ACCEPTED_RESULT);
		expect((await ext.run()).content[0]?.text).toBe(RESTART_ACCEPTED_RESULT);
		await expect(ext.run("sub")).rejects.toThrow("main agent");
	});

	test("the limit the server wrote makes the call the tool's error until it is over", async () => {
		const service = new RestartService(dir());
		const file = service.fileFor("L1-x");
		service.writeLimit(file, Date.now() + 60_000);
		await expect(load(file).run("main")).rejects.toThrow(`restarted ${RESTART_MAX} times in the last hour`);
		service.writeLimit(file, Date.now() - 1);
		expect((await load(file).run("main")).content[0]?.text).toBe(RESTART_ACCEPTED_RESULT);
		service.writeLimit(file, null);
		expect((await load(file).run("main")).content[0]?.text).toBe(RESTART_ACCEPTED_RESULT);
		// A file that is not there, or not one, is no limit.
		writeFileSync(file, "nonsense");
		expect((await load(file).run("main")).content[0]?.text).toBe(RESTART_ACCEPTED_RESULT);
		service.removeLimit(file);
		expect((await load(file).run("main")).content[0]?.text).toBe(RESTART_ACCEPTED_RESULT);
	});

	test("what the extension says by itself is what the server says", () => {
		expect(RESTART_SESSION_TOOL).toBe(RESTART_TOOL);
		expect(RESTART_DESCRIPTION).toContain(`At most ${RESTART_MAX} restarts per conversation per hour`);
		expect(RESTART_ACCEPTED_RESULT).toContain("End your turn now");
	});

	test("it is installed under the data folder, written again only when it changed", () => {
		const data = dir();
		const path = installRestartExtension(data);
		expect(path).toBe(restartPaths(data).extension);
		expect(readFileSync(path, "utf8")).toBe(
			readFileSync(join(import.meta.dir, "../../server/omp/restart/extension.ts"), "utf8"),
		);
		expect(new RestartService(data).ensure()).toBe(true);
		const broken = dir();
		mkdirSync(join(broken, "restart"), { recursive: true });
		writeFileSync(join(broken, "restart", "server"), "not a folder");
		expect(() => installRestartExtension(broken)).toThrow();
	});
});
