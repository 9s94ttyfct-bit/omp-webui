import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuardLog, GuardSettings } from "../../server/guard.ts";
import { LivePool } from "../../server/live.ts";
import { ApprovalStore } from "../../server/omp/approval.ts";
import { RiskState } from "../../server/omp/gate/state.ts";
import { UnattendedService } from "../../server/omp/unattended/service.ts";
import {
	DEFAULT_GUARD_CONFIG,
	type GuardConfig,
	GuardConfigError,
	type GuardDecision,
	type GuardWord,
	parseDecision,
	parseGuardConfig,
	parseGuardPatch,
	parseGuardWord,
	reviewerSelectors,
} from "../../shared/guard.ts";
import { isRecord } from "../../shared/guards.ts";
import { writeFakeHostOmp } from "../support/fake-host-omp.ts";
import { fakeConfig } from "../support/fake-omp.ts";

/**
 * "Guard dangerous commands" (#609) on the server's side, with no omp: the settings (which an agent cannot turn off by
 * changing a file), the log of decisions, and what each process's gate is told. The gate itself is `guard-gate.test.ts`,
 * the real omp is `tests/contract/guard.test.ts`.
 */

const dirs: string[] = [];
const pools: LivePool[] = [];
afterEach(async () => {
	for (const pool of pools.splice(0)) await pool.shutdown();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
// The server sweeps the temp dir for the overlay directories of servers that are gone: these tests use a temp dir of their own.
const sharedTmp = process.env.TMPDIR;
let ownTmp = "";
beforeAll(() => {
	ownTmp = mkdtempSync(join(tmpdir(), "ompw-guard-tmp-"));
	process.env.TMPDIR = ownTmp;
});
afterAll(() => {
	if (sharedTmp === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = sharedTmp;
	rmSync(ownTmp, { recursive: true, force: true });
});
const scratch = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "ompw-guard-srv-"));
	dirs.push(dir);
	return dir;
};

// ------------------------------------------------------------------ the settings

describe("the settings", () => {
	test("a fresh install guards: the reviewer decides, and the person is asked when none can be reached or one denies", () => {
		expect(DEFAULT_GUARD_CONFIG).toEqual({
			mode: "reviewer",
			reviewer: "",
			askWhenUnavailable: true,
			askWhenDenied: true,
		});
		expect(new GuardSettings(scratch()).get()).toEqual(DEFAULT_GUARD_CONFIG);
	});

	test("a change is checked, kept in the data folder, and read again by the next server", () => {
		const dir = scratch();
		const settings = new GuardSettings(dir);
		expect(settings.set({ mode: "ask" })).toEqual({
			mode: "ask",
			reviewer: "",
			askWhenUnavailable: true,
			askWhenDenied: true,
		});
		expect(
			settings.set({
				reviewer: "  openai/gpt-5-mini, anthropic/claude-haiku-5  ",
				askWhenUnavailable: false,
				askWhenDenied: false,
			}),
		).toEqual({
			mode: "ask",
			reviewer: "openai/gpt-5-mini, anthropic/claude-haiku-5",
			askWhenUnavailable: false,
			askWhenDenied: false,
		});
		expect(JSON.parse(readFileSync(join(dir, "guard.json"), "utf8"))).toMatchObject({
			mode: "ask",
			askWhenUnavailable: false,
			askWhenDenied: false,
		});
		expect(new GuardSettings(dir).get()).toEqual(settings.get());
		// The file is the server's, not the world's: private to the user.
		expect(statSync(join(dir, "guard.json")).mode & 0o777).toBe(0o600);
	});

	test("what the person tuned is kept in the same file at 0600, read again by the next server, and restored to the default by null", () => {
		const dir = scratch();
		const settings = new GuardSettings(dir);
		const kept = settings.setRules({
			policy: { text: "Reading: allow.\nElse: block." },
			thresholds: { delete_outside: "block" },
			cases: [{ id: "u-1", label: "mine", command: "ls", expect: "harmless" }],
		});
		expect(kept.policy).toMatchObject({ text: "Reading: allow.\nElse: block." });
		const file = join(dir, "guard.json");
		expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
			mode: "reviewer",
			thresholds: { delete_outside: "block" },
		});
		expect(statSync(file).mode & 0o777).toBe(0o600);
		// A change of the mode leaves the rules alone, and the next server reads all of it.
		settings.set({ mode: "ask" });
		expect(new GuardSettings(dir).rules()).toEqual(kept);
		expect(new GuardSettings(dir).get().mode).toBe("ask");
		// Restore default: the rules go, the rest stays; the default is not written to the file at all.
		settings.setRules({ policy: null });
		expect(JSON.parse(readFileSync(file, "utf8")).policy).toBeUndefined();
		expect(settings.rules().thresholds).toEqual({ delete_outside: "block" });
		expect(statSync(file).mode & 0o777).toBe(0o600);
		// Refused: nothing changes and the file is as it was.
		const before = readFileSync(file, "utf8");
		expect(() => settings.setRules({ thresholds: { protected: "allow" } })).toThrow(GuardConfigError);
		expect(() => settings.setRules({ policy: { text: "" } })).toThrow(GuardConfigError);
		expect(readFileSync(file, "utf8")).toBe(before);
	});

	test("rules loosened in the file behind the server's back are written over, as the mode is", () => {
		const dir = scratch();
		const file = join(dir, "guard.json");
		const settings = new GuardSettings(dir);
		settings.setRules({ thresholds: { delete_outside: "block" }, policy: { text: "Everything: block." } });
		writeFileSync(
			file,
			JSON.stringify({
				mode: "reviewer",
				reviewer: "",
				askWhenUnavailable: true,
				thresholds: { delete_outside: "allow" },
			}),
		);
		expect(settings.verify()).toBe(true);
		const again = JSON.parse(readFileSync(file, "utf8"));
		expect(again.thresholds).toEqual({ delete_outside: "block" });
		expect(again.policy.text).toBe("Everything: block.");
	});

	test.each<[string, unknown]>([
		["not an object", "off"],
		["an array", []],
		["null", null],
		["an unknown mode", { mode: "disabled" }],
		["a mode of another type", { mode: 1 }],
		["an unknown setting", { mod: "off" }],
		["a reviewer that is not text", { reviewer: 3 }],
		["a reviewer with a control character", { reviewer: "a/b\u0007" }],
		["a reviewer that is far too long", { reviewer: "x".repeat(600) }],
		["a switch that is not a boolean", { askWhenUnavailable: "no" }],
		["a denial switch that is not a boolean", { askWhenDenied: 1 }],
	])("a change that is %s is refused and changes nothing", (_name, patch) => {
		const dir = scratch();
		const settings = new GuardSettings(dir);
		expect(() => settings.set(patch)).toThrow(GuardConfigError);
		expect(settings.get()).toEqual(DEFAULT_GUARD_CONFIG);
		expect(existsSync(join(dir, "guard.json"))).toBe(false);
	});

	test("a file that says something the settings cannot read is the guard on, never off", () => {
		for (const raw of [
			null,
			"off",
			[],
			{},
			{ mode: "disabled" },
			{ mode: 0 },
			{ mode: "Off" },
			{ mode: "off ", reviewer: 7 },
		]) {
			expect(parseGuardConfig(raw).mode, JSON.stringify(raw)).toBe("reviewer");
		}
		expect(parseGuardConfig({ mode: "off" }).mode).toBe("off");
		expect(parseGuardConfig({ mode: "ask", reviewer: "a/b", askWhenUnavailable: false })).toEqual({
			mode: "ask",
			reviewer: "a/b",
			askWhenUnavailable: false,
			askWhenDenied: true,
		});
		// Only an explicit false turns the fallback off, and the question after a denial.
		expect(parseGuardConfig({ askWhenUnavailable: 0 }).askWhenUnavailable).toBe(true);
		expect(parseGuardConfig({ askWhenDenied: "no" }).askWhenDenied).toBe(true);
		expect(parseGuardConfig({ askWhenDenied: false }).askWhenDenied).toBe(false);
		// A server that starts on a file it cannot parse guards.
		const dir = scratch();
		writeFileSync(join(dir, "guard.json"), "{ not json");
		expect(new GuardSettings(dir).get().mode).toBe("reviewer");
	});

	test("a file that was changed behind the server's back is written again from what the server holds", () => {
		const dir = scratch();
		const file = join(dir, "guard.json");
		const settings = new GuardSettings(dir);
		settings.set({ mode: "reviewer", reviewer: "openai/gpt-5-mini" });
		expect(settings.verify()).toBe(false);
		// An agent turns the guard off in the file.
		writeFileSync(file, JSON.stringify({ mode: "off" }));
		expect(settings.verify()).toBe(true);
		expect(settings.get().mode).toBe("reviewer");
		expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ mode: "reviewer", reviewer: "openai/gpt-5-mini" });
		// The file taken away is put back; one that says the same thing is left alone.
		rmSync(file);
		expect(settings.verify()).toBe(true);
		expect(existsSync(file)).toBe(true);
		writeFileSync(file, `${JSON.stringify(settings.get())}  `);
		expect(settings.verify()).toBe(false);
		expect(settings.get().reviewer).toBe("openai/gpt-5-mini");
	});

	test("takes a file the person put there when it is told to (`reload`), and `verify` leaves that alone afterwards", () => {
		const dir = scratch();
		const file = join(dir, "guard.json");
		const settings = new GuardSettings(dir);
		settings.set({ mode: "reviewer", reviewer: "openai/gpt-5-mini" });
		// Move to another computer replaced the file with the one that came from the other Mac.
		const imported: GuardConfig = {
			mode: "ask",
			reviewer: "moved/one",
			askWhenUnavailable: false,
			askWhenDenied: false,
		};
		writeFileSync(file, `${JSON.stringify(imported)}\n`);
		// Left alone, the next look would write the server's own settings over it (that is what an agent's plant gets).
		expect(settings.reload()).toEqual(imported);
		expect(settings.get()).toEqual(imported);
		// The file is the server's own now: the looks after it leave it, and a change behind its back is written again with it.
		expect(settings.verify()).toBe(false);
		expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject(imported);
		writeFileSync(file, JSON.stringify({ mode: "off" }));
		expect(settings.verify()).toBe(true);
		expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject(imported);
	});

	test("the settings are where an environment variable says, which is how a test keeps its own", () => {
		const dir = scratch();
		const saved = process.env.OMP_WEBUI_GUARD_CONFIG;
		process.env.OMP_WEBUI_GUARD_CONFIG = join(dir, "elsewhere.json");
		try {
			const settings = new GuardSettings(join(dir, "data"));
			expect(settings.file).toBe(join(dir, "elsewhere.json"));
			settings.set({ mode: "off" });
			expect(existsSync(join(dir, "elsewhere.json"))).toBe(true);
			expect(existsSync(join(dir, "data", "guard.json"))).toBe(false);
		} finally {
			if (saved === undefined) delete process.env.OMP_WEBUI_GUARD_CONFIG;
			else process.env.OMP_WEBUI_GUARD_CONFIG = saved;
		}
	});

	test("the reviewer setting is a chain: its selectors, in order, blanks left out", () => {
		expect(reviewerSelectors("")).toEqual([]);
		expect(reviewerSelectors(" a/b ,, c/d ,")).toEqual(["a/b", "c/d"]);
		expect(parseGuardPatch({ reviewer: "" })).toEqual({ reviewer: "" });
	});
});

// ------------------------------------------------------------------ the log

const decision = (over: Partial<GuardDecision> = {}): GuardDecision => ({
	id: `id-${Math.random().toString(36).slice(2)}`,
	at: Date.now(),
	session: "s1",
	file: "/work/s1.jsonl",
	agent: "main",
	subagent: false,
	toolCallId: "call_1",
	tool: "bash",
	kinds: ["delete_outside"],
	cwd: "/work",
	intent: "tidy",
	detail: "Command: rm -rf ~/x",
	mode: "reviewer",
	verdict: "allow",
	by: "reviewer",
	reason: "ok",
	ms: 12,
	...over,
});
const line = (d: unknown): string => `${JSON.stringify(d)}\n`;

describe("the log of decisions", () => {
	test("a decision is read back field by field, and one that is not one is not", () => {
		const d = decision({
			model: "openai/gpt-5-mini",
			tried: ["openai/gpt-5-mini"],
			usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5, requests: 1 },
		});
		expect(parseDecision(JSON.parse(JSON.stringify(d)))).toEqual(d);
		for (const bad of [
			null,
			1,
			"x",
			[],
			{},
			{ ...d, id: "" },
			{ ...d, verdict: "yes" },
			{ ...d, by: "robot" },
			{ ...d, mode: "maybe" },
		]) {
			expect(parseDecision(bad), JSON.stringify(bad)).toBeNull();
		}
		// Sizes are bounded and types are repaired: a page renders what comes out of here.
		const wild = parseDecision({
			...d,
			detail: "x".repeat(50_000),
			reason: "r".repeat(9_000),
			kinds: [1, "write_outside", null, "bogus"],
			ms: -4,
			at: "now",
			subagent: "yes",
		});
		expect(wild?.detail.length).toBeLessThan(5_000);
		expect(wild?.reason.length).toBe(2_000);
		expect(wild?.kinds).toEqual(["write_outside"]);
		expect(wild?.ms).toBe(0);
		expect(wild?.at).toBe(0);
		expect(wild?.subagent).toBe(false);
	});

	test("`poll` hands out what was written since it was last asked, whole lines only", () => {
		const dir = scratch();
		mkdirSync(join(dir, "guard"));
		const file = join(dir, "guard", "decisions.jsonl");
		// What was there before the server started is not news.
		writeFileSync(file, line(decision({ id: "old" })));
		const log = new GuardLog(dir);
		expect(log.poll()).toEqual([]);
		appendFileSync(file, line(decision({ id: "a" })) + line(decision({ id: "b" })));
		expect(log.poll().map((d) => d.id)).toEqual(["a", "b"]);
		expect(log.poll()).toEqual([]);
		// A line that is being written is read when it is whole.
		const half = line(decision({ id: "c" }));
		appendFileSync(file, half.slice(0, 40));
		expect(log.poll()).toEqual([]);
		appendFileSync(file, half.slice(40));
		expect(log.poll().map((d) => d.id)).toEqual(["c"]);
		// A line that is not a decision is passed over, and does not stop the next.
		appendFileSync(file, `not json\n${JSON.stringify({ id: "x" })}\n${line(decision({ id: "d" }))}`);
		expect(log.poll().map((d) => d.id)).toEqual(["d"]);
	});

	test("a log that is not there yet is fine, and one that was moved aside or shortened is read from its start", () => {
		const dir = scratch();
		const log = new GuardLog(dir);
		expect(log.poll()).toEqual([]);
		expect(log.tail(10)).toEqual({ decisions: [], total: 0 });
		mkdirSync(join(dir, "guard"));
		const file = join(dir, "guard", "decisions.jsonl");
		writeFileSync(file, line(decision({ id: "a" })) + line(decision({ id: "b" })));
		expect(log.poll().map((d) => d.id)).toEqual(["a", "b"]);
		writeFileSync(file, line(decision({ id: "n" })));
		expect(log.poll().map((d) => d.id)).toEqual(["n"]);
	});

	test("the newest come first, a conversation's can be asked for, and the part read says how many it held", () => {
		const dir = scratch();
		mkdirSync(join(dir, "guard"));
		const file = join(dir, "guard", "decisions.jsonl");
		const lines = Array.from({ length: 30 }, (_, i) =>
			line(decision({ id: `d${i}`, session: i % 3 === 0 ? "mine" : "other" })),
		);
		writeFileSync(file, lines.join(""));
		const log = new GuardLog(dir);
		const tail = log.tail(5);
		expect(tail.decisions.map((d) => d.id)).toEqual(["d29", "d28", "d27", "d26", "d25"]);
		expect(tail.total).toBe(30);
		expect(log.ofSession("mine", 100).map((d) => d.id)).toEqual([
			"d27",
			"d24",
			"d21",
			"d18",
			"d15",
			"d12",
			"d9",
			"d6",
			"d3",
			"d0",
		]);
		expect(log.ofSession("nobody", 100)).toEqual([]);
	});

	test("a long log is read from its end, and the line it was cut in is not taken for one", () => {
		const dir = scratch();
		mkdirSync(join(dir, "guard"));
		const file = join(dir, "guard", "decisions.jsonl");
		const big = line(decision({ detail: "z".repeat(3_000) }));
		const count = Math.ceil((2 * 1024 * 1024 * 1.5) / big.length);
		const text = Array.from({ length: count }, (_, i) => big.replace('"id":"id-', `"id":"n${i}-`)).join("");
		writeFileSync(file, text);
		const log = new GuardLog(dir);
		const tail = log.tail(3);
		expect(tail.decisions).toHaveLength(3);
		expect(tail.total).toBeLessThan(count);
		expect(tail.decisions[0].id.startsWith(`n${count - 1}-`)).toBe(true);
	});
});

// ------------------------------------------------------------------ what each process's gate is told

/** The command line the scripted omp logged first. */
function argvOf(log: string): string[] {
	const first: unknown = JSON.parse(readFileSync(log, "utf8").split("\n").filter(Boolean)[0]);
	if (isRecord(first) && Array.isArray(first.argv)) return first.argv.filter((a): a is string => typeof a === "string");
	throw new Error("omp logged no command line");
}

function setup(config: () => GuardConfig, reachable?: () => boolean) {
	const dir = scratch();
	const log = join(dir, "log");
	writeFileSync(log, "");
	const bin = writeFakeHostOmp(dir, log, { configured: "yolo" });
	const approval = new ApprovalStore(bin, dir, 0);
	approval.handlerMs = 120_000;
	const pool = new LivePool(fakeConfig(dir, bin), null, null, approval);
	pools.push(pool);
	pool.gate = {
		extension: join(dir, "gate", "extension.ts"),
		protect: [dir],
		confirm: () => false,
		ensure: () => true,
		guard: { config, log: join(dir, "guard", "decisions.jsonl"), own: [dir], ...(reachable ? { reachable } : {}) },
	};
	const overlayOf = (): string => argvOf(log).at(-1) ?? "";
	const word = (): GuardWord | null => parseGuardWord(JSON.parse(readFileSync(`${overlayOf()}.risk`, "utf8")).guard);
	const open = () => pool.open({ kind: "new", cwd: tmpdir() }, async () => tmpdir());
	return { dir, pool, open, word, overlayOf };
}

describe("what a process's gate is told", () => {
	test("the setting, the reviewers, whether a page is open, where decisions go and which files are the app's own", async () => {
		const config: GuardConfig = {
			mode: "reviewer",
			reviewer: " openai/gpt-5-mini , anthropic/claude-haiku-5",
			askWhenUnavailable: true,
			askWhenDenied: false,
		};
		const { open, word, overlayOf, dir } = setup(() => config);
		const live = await open();
		const told = word();
		expect(told).toMatchObject({
			mode: "reviewer",
			reviewers: ["openai/gpt-5-mini", "anthropic/claude-haiku-5"],
			askWhenUnavailable: true,
			askWhenDenied: false,
			page: false,
			log: join(dir, "guard", "decisions.jsonl"),
		});
		// The data folder and the folder of this process's own settings overlay: nothing in them is the agent's to change.
		expect(told?.own).toContain(dir);
		expect(told?.own.some((p) => overlayOf().startsWith(p))).toBe(true);
		expect(live.info.exited).toBe(false);
	});

	test("a page that opens the conversation is said to the gate, and one that leaves is too", async () => {
		const { open, word, pool } = setup(() => DEFAULT_GUARD_CONFIG);
		const live = await open();
		expect(word()?.page).toBe(false);
		const page = { send: () => {} };
		live.subscribers.add(page);
		pool.announce(live);
		expect(word()?.page).toBe(true);
		live.subscribers.delete(page);
		pool.announce(live);
		expect(word()?.page).toBe(false);
	});

	test("while the conversation is unattended a reviewer's denial is not put to the person: its turn does not wait (#752)", async () => {
		const { open, word, pool, dir } = setup(() => ({ ...DEFAULT_GUARD_CONFIG, askWhenDenied: true }));
		pool.unattended = new UnattendedService(dir);
		const live = await open();
		// A page is open: the person would be asked.
		live.subscribers.add({ send: () => {} });
		pool.announce(live);
		expect(word()).toMatchObject({ page: true, askWhenDenied: true });
		// Unattended: the denial is final, whatever the setting; the page is still said to be there.
		live.setUnattended(true);
		expect(word()).toMatchObject({ page: true, askWhenDenied: false });
		// And back: the setting decides again.
		live.setUnattended(false);
		expect(word()).toMatchObject({ page: true, askWhenDenied: true });
	});

	test("the macOS app in the background is somebody to ask when no page is open: it is said to the gate, and so is its leaving", async () => {
		let app = false;
		const { open, word, pool } = setup(
			() => DEFAULT_GUARD_CONFIG,
			() => app,
		);
		const live = await open();
		expect(word()?.page).toBe(false);
		app = true;
		pool.syncRisk();
		expect(word()?.page).toBe(true);
		app = false;
		pool.syncRisk();
		expect(word()?.page).toBe(false);
		// An open page counts whatever the app does.
		const page = { send: () => {} };
		live.subscribers.add(page);
		pool.announce(live);
		expect(word()?.page).toBe(true);
	});

	test("a change of the setting reaches every process at the next look, with no message needed", async () => {
		let config: GuardConfig = { ...DEFAULT_GUARD_CONFIG };
		const { open, word, pool } = setup(() => config);
		await open();
		await open();
		expect(word()?.mode).toBe("reviewer");
		config = { ...config, mode: "ask" };
		pool.syncRisk();
		expect(word()?.mode).toBe("ask");
		config = { ...config, mode: "off" };
		pool.syncRisk();
		expect(word()?.mode).toBe("off");
	});

	test("a state file that an agent changed, or took away, is the server's word again at the next look", async () => {
		const { open, word, overlayOf, pool } = setup(() => DEFAULT_GUARD_CONFIG);
		await open();
		const file = `${overlayOf()}.risk`;
		writeFileSync(file, JSON.stringify({ armed: false, protect: [], guard: { mode: "off" } }));
		pool.syncRisk();
		expect(word()?.mode).toBe("reviewer");
		rmSync(file);
		pool.syncRisk();
		expect(word()?.mode).toBe("reviewer");
	});

	test("the file is written only when the word changes", async () => {
		const { open, overlayOf, pool } = setup(() => DEFAULT_GUARD_CONFIG);
		await open();
		const file = `${overlayOf()}.risk`;
		const before = statSync(file).mtimeMs;
		pool.syncRisk();
		pool.syncRisk();
		expect(statSync(file).mtimeMs).toBe(before);
	});

	test("the process's settings overlay gives omp's handler time for a reviewer", async () => {
		const { open, overlayOf } = setup(() => DEFAULT_GUARD_CONFIG);
		await open();
		expect(readFileSync(overlayOf(), "utf8")).toContain("extensionHandlers:\n  toolCallTimeoutMs: 120000");
	});

	test("a state with no guard (a server with none) is written as it was before", () => {
		const dir = scratch();
		const state = new RiskState(join(dir, "L1.yml"), ["/a"]);
		state.set(true);
		expect(JSON.parse(readFileSync(join(dir, "L1.yml.risk"), "utf8"))).toEqual({ armed: true, protect: ["/a"] });
	});

	test("a word the gate reads is the word the server wrote, and a damaged one is nothing", () => {
		const word: GuardWord = {
			mode: "ask",
			reviewers: ["a/b"],
			askWhenUnavailable: true,
			askWhenDenied: true,
			page: true,
			log: "/x/log",
			own: ["/x"],
		};
		expect(parseGuardWord(JSON.parse(JSON.stringify(word)))).toEqual(word);
		for (const bad of [null, 1, "ask", [], {}, { mode: "disabled" }]) expect(parseGuardWord(bad)).toBeNull();
	});
});
