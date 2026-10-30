import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	ApprovalStore,
	configuredApprovalMode,
	ProcessOverlay,
	stripApprovalFlags,
} from "../../server/omp/approval.ts";
import { writeFakeHostOmp } from "../support/fake-host-omp.ts";

/** Per-conversation tool approval: the overlay omp reloads, the user's choices, and what a conversation starts in. */

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Every server sweeps the temp dir for the overlay directories of the servers that are gone, and these tests make
 * such directories: in the shared temp dir another test file's sweep could take them mid-test, so they use one of
 * their own.
 */
const sharedTmp = process.env.TMPDIR;
let ownTmp = "";
beforeAll(() => {
	ownTmp = mkdtempSync(join(tmpdir(), "ompw-approval-tmp-"));
	process.env.TMPDIR = ownTmp;
});
afterAll(() => {
	if (sharedTmp === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = sharedTmp;
	rmSync(ownTmp, { recursive: true, force: true });
});

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "ompw-approval-"));
	dirs.push(dir);
	return dir;
}

/** An `omp` whose `config get tools.approvalMode` prints `configured`. */
function ompPrinting(dir: string, configured?: string): string {
	return writeFakeHostOmp(dir, join(dir, "log"), { configured });
}

/** The mode `store` starts a conversation in (see `ApprovalStore.startingMode`). */
async function startedIn(store: ApprovalStore, ...args: Parameters<ApprovalStore["startingMode"]>) {
	return (await store.startingMode(...args)).mode;
}

test("flags that set the mode for the whole process are dropped: they would override the overlay", () => {
	expect(
		stripApprovalFlags([
			"--model=x",
			"--approval-mode=yolo",
			"--auto-approve",
			"--thinking",
			"high",
			"--approval-mode",
			"always-ask",
			"--yolo",
			"--plan-yolo",
		]),
	).toEqual(["--model=x", "--thinking", "high", "--plan-yolo"]);
	expect(stripApprovalFlags([])).toEqual([]);
});

test("a process overlay says its mode, is replaced in one step, and goes away", () => {
	const dir = scratch();
	const file = join(dir, "L1.yml");
	const overlay = new ProcessOverlay(file, "always-ask");
	expect(readFileSync(file, "utf8")).toContain("  approvalMode: always-ask\n");

	overlay.set("yolo");
	expect(overlay.mode).toBe("yolo");
	expect(readFileSync(file, "utf8")).toContain("approvalMode: yolo");
	// Replaced by renaming a finished file: no half-written copy is left behind for omp to read.
	expect(existsSync(`${file}.tmp`)).toBe(false);

	overlay.remove();
	expect(existsSync(file)).toBe(false);
	expect(() => overlay.remove()).not.toThrow();
});

test("an overlay that names no mode is still a mapping, which omp requires of every overlay", () => {
	const dir = scratch();
	const file = join(dir, "L2.yml");
	new ProcessOverlay(file, null);
	const text = readFileSync(file, "utf8");
	expect(text).not.toContain("approvalMode");
	expect(Bun.YAML.parse(text)).toEqual({ tools: { approval: { propose_goal: "allow" } } });
});

test("every overlay allows propose_goal, in each mode and after a change: omp would otherwise ask before the interview's own card", () => {
	const dir = scratch();
	for (const mode of ["always-ask", "always-ask-cached", "write", "yolo", null] as const) {
		const file = join(dir, `L-${mode}.yml`);
		const overlay = new ProcessOverlay(file, mode, 0);
		const allowed = { propose_goal: "allow" };
		expect(Bun.YAML.parse(readFileSync(file, "utf8"))).toEqual({
			tools: { approval: allowed, ...(mode ? { approvalMode: mode } : {}) },
		});
		void overlay.set("always-ask");
		expect(Bun.YAML.parse(readFileSync(file, "utf8"))).toEqual({
			tools: { approval: allowed, approvalMode: "always-ask" },
		});
	}
});

test("an overlay carries a conversation's preset: its roles, the config's roles it leaves out as null, and its thinking level", async () => {
	const dir = scratch();
	const file = join(dir, "L3.yml");
	const overlay = new ProcessOverlay(
		file,
		"write",
		0,
		null,
		{
			preset: "deep",
			roles: { default: "anthropic/claude-sonnet-4:high", "odd-role": "a/b,c/d" },
			defaultThinkingLevel: "low",
		},
		["smol", "slow", "default"],
	);
	const read = () => Bun.YAML.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	// `null` is omp's mark in an overlay that no lower layer's value applies; a role the preset sets is never one.
	expect(read()).toMatchObject({
		modelRoles: { default: "anthropic/claude-sonnet-4:high", "odd-role": "a/b,c/d", smol: null, slow: null },
		defaultThinkingLevel: "low",
		tools: { approvalMode: "write" },
	});

	// Back to the global config: nothing of the preset is left, and the rest of the overlay is as it was.
	await overlay.setModels(null, []);
	expect(read()).toEqual({ tools: { approval: { propose_goal: "allow" }, approvalMode: "write" } });
});

test("a preset with no roles leaves `modelRoles` an empty mapping: null under that key would replace the config's roles", () => {
	const file = join(scratch(), "L4.yml");
	new ProcessOverlay(file, null, 0, null, { preset: "none", roles: {} }, []);
	expect(Bun.YAML.parse(readFileSync(file, "utf8"))).toMatchObject({ modelRoles: {} });
});

test("the preset a conversation was switched to is kept by its session file, and an entry omp could not apply is not one", () => {
	const dir = scratch();
	const store = new ApprovalStore(ompPrinting(dir), dir);
	const models = { preset: "deep", roles: { default: "a/b:high" }, defaultThinkingLevel: "low" as const };
	expect(store.sessionModels("/sessions/a.jsonl")).toBeNull();
	store.rememberModels("/sessions/a.jsonl", models);
	expect(new ApprovalStore(ompPrinting(dir), dir).sessionModels("/sessions/a.jsonl")).toEqual(models);
	expect(store.sessionModels("/sessions/b.jsonl")).toBeNull();

	// A hand-edited or damaged file costs the conversation its preset, not the store.
	writeFileSync(
		join(dir, "approval.json"),
		JSON.stringify({
			models: { "/sessions/a.jsonl": { preset: "deep", roles: { default: 7 } }, "/sessions/c.jsonl": models },
		}),
	);
	expect(store.sessionModels("/sessions/a.jsonl")).toBeNull();
	expect(store.sessionModels("/sessions/c.jsonl")).toEqual(models);
});

test("omp's own mode is read from `omp config get`, quoted or not, a newer omp's mode as omp names it", async () => {
	const dir = scratch();
	for (const [printed, mode] of [
		["always-ask", "always-ask"],
		["always-ask-cached", "always-ask-cached"],
		['"write"', "write"],
		["yolo", "yolo"],
		["sometimes", "sometimes"],
		[undefined, null],
	] as const) {
		expect(await configuredApprovalMode(ompPrinting(dir, printed))).toBe(mode);
	}
	expect(await configuredApprovalMode(join(dir, "no-such-omp"))).toBeNull();
});

test("a conversation starts in omp's own Ask and remember; a mode omp has that we do not know is left in force and named", async () => {
	const dir = scratch();
	const cached = new ApprovalStore(ompPrinting(dir, "always-ask-cached"), dir);
	expect(await cached.startingMode(dir, null)).toEqual({ mode: "always-ask-cached", omp: null });
	expect(await cached.startingMode(dir, null, "yolo")).toEqual({ mode: "yolo", omp: null });

	const newer = new ApprovalStore(ompPrinting(dir, "paranoid"), dir);
	expect(await newer.startingMode(dir, null)).toEqual({ mode: null, omp: "paranoid" });
	// What the user picked is never replaced by omp's own: nothing of it is shown then.
	newer.setDefault("write");
	expect(await newer.startingMode(dir, null)).toEqual({ mode: "write", omp: null });

	const silent = new ApprovalStore(join(dir, "no-such-omp"), scratch());
	expect(await silent.startingMode(dir, null)).toEqual({ mode: null, omp: null });
});

test("a conversation starts in the mode asked for, else the one the user chose for it, else their default, else omp's", async () => {
	const dir = scratch();
	const store = new ApprovalStore(ompPrinting(dir, "write"), dir);
	const file = "/sessions/a.jsonl";
	expect(await startedIn(store, dir, file)).toBe("write");

	store.setDefault("yolo");
	expect(await startedIn(store, dir, file)).toBe("yolo");
	expect(store.defaultMode()).toBe("yolo");

	store.rememberSession(file, "always-ask");
	expect(await startedIn(store, dir, file)).toBe("always-ask");
	// Another conversation has nothing remembered and follows the default.
	expect(await startedIn(store, dir, "/sessions/b.jsonl")).toBe("yolo");
	expect(await startedIn(store, dir, file, "write")).toBe("write");

	store.setDefault(null);
	expect(store.defaultMode()).toBeNull();
	expect(await startedIn(store, dir, "/sessions/b.jsonl")).toBe("write");
});

test("the choices are kept in the data dir, survive a new store, and ignore what is not a mode", async () => {
	const dir = scratch();
	const bin = ompPrinting(dir, "yolo");
	new ApprovalStore(bin, dir).rememberSession("/sessions/a.jsonl", "always-ask");
	const again = new ApprovalStore(bin, dir);
	expect(again.sessionMode("/sessions/a.jsonl")).toBe("always-ask");

	writeFileSync(
		join(dir, "approval.json"),
		JSON.stringify({ default: "maybe", sessions: { "/x.jsonl": "write", "/y.jsonl": "sometimes" } }),
	);
	expect(again.defaultMode()).toBeNull();
	expect(again.sessionMode("/x.jsonl")).toBe("write");
	expect(again.sessionMode("/y.jsonl")).toBeNull();

	writeFileSync(join(dir, "approval.json"), "not json");
	expect(again.defaultMode()).toBeNull();
	expect(await startedIn(again, dir, "/x.jsonl")).toBe("yolo");
});

test("only the 500 conversations whose mode was set last are remembered", () => {
	const dir = scratch();
	const store = new ApprovalStore(ompPrinting(dir), dir);
	for (let i = 0; i < 505; i++) store.rememberSession(`/sessions/${i}.jsonl`, "write");
	expect(store.sessionMode("/sessions/0.jsonl")).toBeNull();
	expect(store.sessionMode("/sessions/4.jsonl")).toBeNull();
	expect(store.sessionMode("/sessions/5.jsonl")).toBe("write");
	// Choosing again for an old one moves it to the newest end.
	store.rememberSession("/sessions/5.jsonl", "yolo");
	store.rememberSession("/sessions/505.jsonl", "write");
	expect(store.sessionMode("/sessions/5.jsonl")).toBe("yolo");
	expect(store.sessionMode("/sessions/6.jsonl")).toBeNull();
});

test("a server's overlays live in a directory of its own, and the one a dead server left behind is cleaned up", async () => {
	const dir = scratch();
	const dead = Bun.spawn(["true"]);
	await dead.exited;
	const stale = join(tmpdir(), `ompw-live-${dead.pid}-stale`);
	const foreign = join(tmpdir(), `ompw-live-${process.pid}-other-server`);
	for (const d of [stale, foreign]) {
		mkdirSync(d, { recursive: true });
		dirs.push(d);
	}
	const overlay = await new ApprovalStore(ompPrinting(dir), dir).create("L9", "yolo");
	expect(dirname(overlay.file)).toMatch(new RegExp(`ompw-live-${process.pid}-`));
	expect(existsSync(overlay.file)).toBe(true);
	expect(existsSync(stale)).toBe(false);
	// A directory whose server is still running is not touched.
	expect(existsSync(foreign)).toBe(true);
	rmSync(dirname(overlay.file), { recursive: true, force: true });
});

test("a dead server's overlay directory that cannot be removed is skipped with a note, and a conversation still starts", async () => {
	// root removes anything: there would be nothing to skip.
	if (process.getuid?.() === 0) return;
	const dir = scratch();
	const dead = Bun.spawn(["true"]);
	await dead.exited;
	const stuck = join(tmpdir(), `ompw-live-${dead.pid}-stuck`);
	const removable = join(tmpdir(), `ompw-live-${dead.pid}-removable`);
	mkdirSync(join(stuck, "inner"), { recursive: true });
	mkdirSync(removable, { recursive: true });
	// A mode-000 directory: its contents cannot even be listed, so removing it fails with EACCES.
	chmodSync(stuck, 0o000);
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	let overlayFile: string | null = null;
	try {
		overlayFile = (await new ApprovalStore(ompPrinting(dir), dir).create("L10", "yolo")).file;
		expect(existsSync(overlayFile)).toBe(true);
		// The one that could be removed still was, and the one that could not is left where it is, with its name in the log.
		expect(existsSync(removable)).toBe(false);
		expect(existsSync(stuck)).toBe(true);
		expect(warn.mock.calls.some(([line]) => String(line).includes(stuck))).toBe(true);
	} finally {
		warn.mockRestore();
		chmodSync(stuck, 0o700);
		rmSync(stuck, { recursive: true, force: true });
		rmSync(removable, { recursive: true, force: true });
		if (overlayFile) rmSync(dirname(overlayFile), { recursive: true, force: true });
	}
});
