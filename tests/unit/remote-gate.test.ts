import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Live, LivePool } from "../../server/live.ts";
import { ApprovalStore } from "../../server/omp/approval.ts";
import { gatePaths, installGate } from "../../server/omp/gate/install.ts";
import { RiskState } from "../../server/omp/gate/state.ts";
import { LazyRemote } from "../../server/remote-lazy.ts";
import { isRecord } from "../../shared/guards.ts";
import { parseRiskTitle, RISK_ALLOW, RISK_DENY } from "../../shared/risk-confirm.ts";
import { writeFakeHostOmp } from "../support/fake-host-omp.ts";
import { fakeConfig } from "../support/fake-omp.ts";
import { pollUntil } from "../support/poll.ts";

/**
 * The gate of "Confirm risky commands from remote pages" without omp: the extension as it is installed into the data
 * folder (its imports resolve there, and it behaves the way the server arms it), and what a conversation tells its gate
 * of whose turn it is. The real omp, with a scripted model, is `tests/contract/remote-confirm.test.ts`.
 */

const dirs: string[] = [];
const pools: LivePool[] = [];
afterEach(async () => {
	for (const pool of pools.splice(0)) await pool.shutdown();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
// A server sweeps the temp dir for the overlay directories of servers that are gone: these tests use a temp dir of their own.
const sharedTmp = process.env.TMPDIR;
let ownTmp = "";
beforeAll(() => {
	ownTmp = mkdtempSync(join(tmpdir(), "ompw-gate-tmp-"));
	process.env.TMPDIR = ownTmp;
});
afterAll(() => {
	if (sharedTmp === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = sharedTmp;
	rmSync(ownTmp, { recursive: true, force: true });
});

const scratch = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "ompw-gate-"));
	dirs.push(dir);
	return dir;
};

// ------------------------------------------------------------------ the extension, as installed

type Handler = (
	event: { toolName: string; input?: unknown },
	ctx: Record<string, unknown>,
) => Promise<{ block: true; reason: string } | undefined>;

/** Install the gate under a data folder with a space in its name (the macOS app's has one), and load the copy omp would. */
async function load(argv: string[]): Promise<{ handler: Handler; dir: string }> {
	const dir = join(scratch(), "Application Support");
	mkdirSync(dir, { recursive: true });
	const path = installGate(dir);
	const saved = process.argv;
	process.argv = argv;
	let handler: Handler | undefined;
	try {
		// The installed copy's path is only known when the test runs; loading that very file is what is under test.
		const mod: { default: (pi: unknown) => void } = await import(`${path}?${Math.random()}`);
		mod.default({ on: (_event: string, h: Handler) => (handler = h) });
	} finally {
		process.argv = saved;
	}
	if (!handler) throw new Error("the gate registered nothing");
	return { handler, dir };
}

const ui = (answer: string | undefined) => {
	const asked: { title: string; options: string[] }[] = [];
	return {
		asked,
		ctx: (cwd: string, hasUI = true) => ({
			cwd,
			hasUI,
			ui: {
				select: async (title: string, options: string[]) => {
					asked.push({ title, options });
					return answer;
				},
			},
		}),
	};
};

/** The guard (#609) off: what these tests of "Confirm risky commands" (#608) run beside. A state that says nothing of it is the guard on. */
const GUARD_OFF = { mode: "off", reviewers: [], askWhenUnavailable: false, page: false, log: "", own: [] };

function overlayWith(state: unknown): string {
	const overlay = join(scratch(), "L1.yml");
	const word = isRecord(state) && !("guard" in state) ? { ...state, guard: GUARD_OFF } : state;
	if (word !== undefined) writeFileSync(`${overlay}.risk`, typeof word === "string" ? word : JSON.stringify(word));
	return overlay;
}

test("the gate is written under the data folder, in the layout of the source tree, and again only when it differs", () => {
	const data = scratch();
	const path = installGate(data);
	expect(path).toBe(gatePaths(data).extension);
	for (const f of ["server/omp/gate/extension.ts", "shared/remote-risk.ts", "shared/risk-confirm.ts"]) {
		expect(existsSync(join(data, "gate", f)), f).toBe(true);
	}
	expect(readFileSync(join(data, "gate", "shared/remote-risk.ts"), "utf8")).toBe(
		readFileSync("shared/remote-risk.ts", "utf8"),
	);
	const mtime = Bun.file(path).lastModified;
	installGate(data);
	expect(Bun.file(path).lastModified).toBe(mtime);
	// Changed (an update): written again.
	writeFileSync(join(data, "gate", "shared/risk-confirm.ts"), "// old");
	installGate(data);
	expect(readFileSync(join(data, "gate", "shared/risk-confirm.ts"), "utf8")).toBe(
		readFileSync("shared/risk-confirm.ts", "utf8"),
	);
});

test("not armed: nothing is asked, and nothing is read of the call", async () => {
	const overlay = overlayWith({ armed: false, protect: [] });
	const { handler } = await load(["omp", "--config", overlay]);
	const { ctx, asked } = ui(RISK_DENY);
	expect(await handler({ toolName: "bash", input: { command: "sudo rm -rf /" } }, ctx("/work"))).toBeUndefined();
	expect(asked).toEqual([]);
});

test("armed: a call that is not risky runs, a risky one waits for the person's answer", async () => {
	const overlay = overlayWith({ armed: true, protect: [] });
	const { handler } = await load(["omp", "--config", "/elsewhere.yml", "--config", overlay]);
	const allow = ui(RISK_ALLOW);
	expect(await handler({ toolName: "bash", input: { command: "ls" } }, allow.ctx("/work"))).toBeUndefined();
	expect(await handler({ toolName: "read", input: { path: "/etc/passwd" } }, allow.ctx("/work"))).toBeUndefined();
	expect(allow.asked).toEqual([]);

	expect(await handler({ toolName: "bash", input: { command: "sudo ls /root" } }, allow.ctx("/work"))).toBeUndefined();
	expect(allow.asked).toHaveLength(1);
	expect(allow.asked[0].options).toEqual([RISK_ALLOW, RISK_DENY]);
	expect(parseRiskTitle(allow.asked[0].title)).toEqual({
		tool: "bash",
		by: "remote",
		kinds: ["privilege"],
		detail: "Command: sudo ls /root",
	});
});

test("armed: a no, or no answer, refuses the call with words the agent can read", async () => {
	const overlay = overlayWith({ armed: true, protect: [] });
	const { handler } = await load(["omp", "--config", overlay]);
	const denied = await handler(
		{ toolName: "bash", input: { command: "git push --force" } },
		ui(RISK_DENY).ctx("/work"),
	);
	expect(denied?.block).toBe(true);
	expect(denied?.reason).toMatch(
		/did not allow this high-risk call \(force_push\).*not run.*Retry it only after the person explicitly approves/s,
	);
	const unanswered = await handler(
		{ toolName: "bash", input: { command: "git push --force" } },
		ui(undefined).ctx("/work"),
	);
	expect(unanswered?.reason).toMatch(/did not answer.*not run/s);
});

test("armed: a subagent has no one to ask, so its risky call is refused and the agent told to report it", async () => {
	const overlay = overlayWith({ armed: true, protect: [] });
	const { handler } = await load(["omp", "--config", overlay]);
	const none = ui(undefined);
	const refused = await handler({ toolName: "bash", input: { command: "sudo ls" } }, none.ctx("/work", false));
	expect(refused?.block).toBe(true);
	expect(refused?.reason).toMatch(/subagent cannot ask.*not run.*main agent/s);
	expect(none.asked).toEqual([]);
	expect(await handler({ toolName: "bash", input: { command: "ls" } }, none.ctx("/work", false))).toBeUndefined();
});

test("armed, and its own folder is the folder of the conversation: what is outside it asks, what is inside does not", async () => {
	const overlay = overlayWith({ armed: true, protect: [] });
	const { handler } = await load(["omp", "--config", overlay]);
	const allow = ui(RISK_ALLOW);
	await handler({ toolName: "write", input: { path: "src/a.ts", content: "x" } }, allow.ctx("/work/proj"));
	await handler({ toolName: "write", input: { path: `${tmpdir()}/a.ts`, content: "x" } }, allow.ctx("/work/proj"));
	expect(allow.asked).toEqual([]);
	await handler({ toolName: "write", input: { path: "/Users/someone/a.ts", content: "x" } }, allow.ctx("/work/proj"));
	expect(parseRiskTitle(allow.asked[0].title)).toMatchObject({ tool: "write", kinds: ["write_outside"] });
});

test("the places the server names are protected, and so is omp's own agent folder", async () => {
	const overlay = overlayWith({ armed: true, protect: ["/data/omp-webui", "/var/ompw-live-9"] });
	const saved = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = "/custom/agent";
	try {
		const { handler } = await load(["omp", "--config", overlay]);
		const allow = ui(RISK_ALLOW);
		for (const path of ["/data/omp-webui/remote.json", "/var/ompw-live-9/L1.yml.risk", "/custom/agent/config.yml"]) {
			await handler(
				{ toolName: "write", input: { path: `/work/proj/../../..${path}`, content: "x" } },
				allow.ctx("/work/proj"),
			);
			await handler({ toolName: "write", input: { path, content: "x" } }, allow.ctx("/work/proj"));
		}
		expect(allow.asked.map((a) => parseRiskTitle(a.title)?.kinds)).toEqual(Array(6).fill(["protected"]));
	} finally {
		if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = saved;
	}
});

test("the address the server was bound to is read by its gate as the loopback is (#634)", async () => {
	const overlay = overlayWith({
		armed: true,
		protect: [],
		ports: [7878],
		hosts: ["192.168.1.5"],
	});
	const { handler } = await load(["omp", "--config", overlay]);
	const allow = ui(RISK_ALLOW);
	// On the server's own port at the address it was bound to: the same API as the loopback's.
	await handler(
		{ toolName: "bash", input: { command: "curl http://192.168.1.5:7878/api/remote" } },
		allow.ctx("/work"),
	);
	// Another program's API on that same address, and another computer's: nobody's business.
	await handler(
		{ toolName: "bash", input: { command: "curl http://192.168.1.5:3000/api/health" } },
		allow.ctx("/work"),
	);
	await handler(
		{ toolName: "bash", input: { command: "curl http://192.168.1.6:7878/api/remote" } },
		allow.ctx("/work"),
	);
	expect(allow.asked.map((a) => parseRiskTitle(a.title)?.detail)).toEqual([
		"Command: curl http://192.168.1.5:7878/api/remote",
	]);
});

test("a state file that is gone, unreadable or without an explicit `armed: false` arms the gate: a risky call is not let through for want of a word", async () => {
	for (const state of [
		undefined,
		"{",
		"[]",
		"{}",
		"null",
		'"armed"',
		'{"armed":"false"}',
		'{"armed":0}',
		'{"protect":[]}',
	]) {
		const overlay = overlayWith(state);
		const { handler } = await load(["omp", "--config", overlay]);
		const deny = ui(RISK_DENY);
		const result = await handler({ toolName: "bash", input: { command: "sudo ls" } }, deny.ctx("/work"));
		expect(result?.block, String(state)).toBe(true);
	}
});

test("without an overlay of the server's on omp's command line there is nothing to read: it does nothing", async () => {
	const { handler } = await load(["omp", "--mode", "rpc-ui"]);
	const deny = ui(RISK_DENY);
	expect(await handler({ toolName: "bash", input: { command: "sudo ls" } }, deny.ctx("/work"))).toBeUndefined();
	expect(deny.asked).toEqual([]);
});

test("a call it cannot read through asks, and a classifier that fails does not stop omp", async () => {
	const overlay = overlayWith({ armed: true, protect: [] });
	const { handler } = await load(["omp", "--config", overlay]);
	const circular: Record<string, unknown> = {};
	circular.self = circular;
	const allow = ui(RISK_ALLOW);
	expect(await handler({ toolName: "bash", input: circular }, allow.ctx("/work"))).toBeUndefined();
	expect(await handler({ toolName: "bash", input: undefined }, allow.ctx("/work"))).toBeUndefined();
});

// ------------------------------------------------------------------ what the server tells it

/** The command line the scripted omp logged first. */
function argvOf(log: string): string[] {
	const first: unknown = JSON.parse(readFileSync(log, "utf8").split("\n").filter(Boolean)[0]);
	if (isRecord(first) && Array.isArray(first.argv)) return first.argv.filter((a): a is string => typeof a === "string");
	throw new Error("omp logged no command line");
}

function setup(options: {
	on: () => boolean;
	gate?: boolean;
	ports?: () => number[] | undefined;
	hosts?: () => string[] | undefined;
}) {
	const dir = scratch();
	const log = join(dir, "log");
	writeFileSync(log, "");
	const bin = writeFakeHostOmp(dir, log, { configured: "yolo" });
	const pool = new LivePool(fakeConfig(dir, bin), null, null, new ApprovalStore(bin, dir, 0));
	pools.push(pool);
	if (options.gate !== false)
		pool.gate = {
			extension: join(dir, "gate", "extension.ts"),
			protect: [dir],
			confirm: options.on,
			...(options.ports ? { ports: options.ports } : {}),
			...(options.hosts ? { hosts: options.hosts } : {}),
			ensure: () => true,
		};
	const overlayOf = (): string => argvOf(log).at(-1) ?? "";
	const state = (): { armed: boolean; protect: string[] } => JSON.parse(readFileSync(`${overlayOf()}.risk`, "utf8"));
	const open = () => pool.open({ kind: "new", cwd: tmpdir() }, async () => tmpdir());
	return { dir, pool, open, state, overlayOf, log };
}

test("a process is started with the gate, and says in its first moments whether it asks", async () => {
	const on = false;
	const { open, state, log, overlayOf } = setup({ on: () => on });
	const live = await open();
	const argv = argvOf(log);
	const at = argv.indexOf("--extension");
	expect(at).toBeGreaterThan(-1);
	expect(argv[at + 1]).toMatch(/gate\/extension\.ts$/);
	// The command line names the gate, but only a gate that ran says so: omp carries on without an extension it cannot load.
	expect(live.gated).toBe(false);
	writeFileSync(`${overlayOf()}.risk.loaded`, "1");
	expect(live.gated).toBe(true);
	// The setting is off: it never asks, whoever drives.
	expect(state().armed).toBe(false);
	expect(state().protect).toHaveLength(2);
	live.noteOrigin(true);
	expect(state().armed).toBe(false);
});

test("armed while the setting is on and the turn is a remote page's, or nobody's has been yet", async () => {
	let on = true;
	const { open, state, pool } = setup({ on: () => on });
	const live = await open();
	// Nobody has sent anything: not known to be a person at this computer's turn, so it asks.
	expect(state().armed).toBe(true);
	live.noteOrigin(false);
	expect(state().armed).toBe(false);
	live.noteOrigin(true);
	expect(state().armed).toBe(true);
	// A page on this computer sends the next message, and takes the turn back.
	live.noteOrigin(false);
	expect(state().armed).toBe(false);
	// The setting turned off while a remote page drives: the next look says so, with no message needed.
	live.noteOrigin(true);
	on = false;
	pool.syncRisk();
	expect(state().armed).toBe(false);
	on = true;
	pool.syncRisk();
	expect(state().armed).toBe(true);
});

test("the conversation's permission mode is never changed by any of it", async () => {
	let on = true;
	const { open, overlayOf } = setup({ on: () => on });
	const live = await open();
	const before = readFileSync(overlayOf(), "utf8");
	live.noteOrigin(true);
	live.noteOrigin(false);
	live.noteOrigin(true);
	on = false;
	live.syncRisk();
	expect(readFileSync(overlayOf(), "utf8")).toBe(before);
	expect(live.info.approvalMode).toBe("yolo");
});

test("a process without the gate says so, and what ends with the process takes its state file along", async () => {
	const { open: openWithout } = setup({ on: () => true, gate: false });
	expect((await openWithout()).gated).toBe(false);

	const { open, overlayOf } = setup({ on: () => true });
	const live = await open();
	const file = `${overlayOf()}.risk`;
	expect(existsSync(file)).toBe(true);
	await live.end();
	await pollUntil(() => !existsSync(file), "the state file to go with the process");
});

test("a conversation whose own flags rule out an extension list runs without the gate, and says so", async () => {
	const dir = scratch();
	const log = join(dir, "log");
	writeFileSync(log, "");
	const bin = writeFakeHostOmp(dir, log, { configured: "yolo" });
	const own = new LivePool(fakeConfig(dir, bin), null, null, new ApprovalStore(bin, dir, 0));
	pools.push(own);
	own.gate = { extension: join(dir, "gate", "extension.ts"), protect: [], confirm: () => true, ensure: () => true };
	const live: Live = await own.open({ kind: "new", cwd: tmpdir(), args: ["--trusted-extension", "/x.ts"] }, async () =>
		tmpdir(),
	);
	expect(live.gated).toBe(false);
	expect(argvOf(log)).not.toContain("--extension");
});

test("a state file is written whole, only when it changes, and under the overlay's own name", () => {
	const dir = scratch();
	const state = new RiskState(join(dir, "L1.yml"), ["/a", "/b"]);
	state.set(true);
	expect(JSON.parse(readFileSync(join(dir, "L1.yml.risk"), "utf8"))).toEqual({ armed: true, protect: ["/a", "/b"] });
	const mtime = Bun.file(join(dir, "L1.yml.risk")).lastModified;
	state.set(true);
	expect(Bun.file(join(dir, "L1.yml.risk")).lastModified).toBe(mtime);
	rmSync(dir, { recursive: true });
	// The folder is gone (a cleaner of the temp dir): it is made again, as the overlay's is.
	state.set(false);
	expect(JSON.parse(readFileSync(join(dir, "L1.yml.risk"), "utf8")).armed).toBe(false);
});

test("a state file that was overwritten is written again whatever its size and time say", () => {
	const dir = scratch();
	const state = new RiskState(join(dir, "L1.yml"), ["/a"]);
	state.set(true);
	const file = join(dir, "L1.yml.risk");
	const word = readFileSync(file, "utf8");
	const before = statSync(file);
	// The gate is switched off with a file of the same size, and the time it had put back: only its content differs.
	const forged = '{"armed":false,"protect":["/"]}';
	expect(word).toBe('{"armed":true,"protect":["/a"]}');
	expect(forged.length).toBe(word.length);
	writeFileSync(file, forged);
	utimesSync(file, before.atimeMs / 1000, before.mtimeMs / 1000);
	expect(statSync(file).size).toBe(before.size);
	expect(statSync(file).mtimeMs).toBe(before.mtimeMs);
	state.set(true);
	expect(readFileSync(file, "utf8")).toBe(word);
	// A file nobody touched is left alone.
	const mtime = statSync(file).mtimeMs;
	state.set(true);
	expect(statSync(file).mtimeMs).toBe(mtime);
	// The ports are part of the word, and new ones are written.
	state.set(true, undefined, [7878, 7879]);
	expect(JSON.parse(readFileSync(file, "utf8")).ports).toEqual([7878, 7879]);
	// None known: none written (the gate then asks about every loopback /api/).
	state.set(true, undefined, []);
	expect(JSON.parse(readFileSync(file, "utf8"))).not.toHaveProperty("ports");
	// The address a server of a network is bound to is part of the word too, and none where it has none.
	state.set(true, undefined, [7878], ["192.168.1.5"]);
	expect(JSON.parse(readFileSync(file, "utf8")).hosts).toEqual(["192.168.1.5"]);
	state.set(true, undefined, [7878], []);
	expect(JSON.parse(readFileSync(file, "utf8"))).not.toHaveProperty("hosts");
});

test("whatever is not a regular file at the state file's path is replaced without being read: a pipe does not block the server", () => {
	const dir = scratch();
	const state = new RiskState(join(dir, "L1.yml"), ["/a"]);
	state.set(true);
	const file = join(dir, "L1.yml.risk");
	const word = readFileSync(file, "utf8");
	const mkfifo = (path: string) => {
		const made = Bun.spawnSync(["mkfifo", path]);
		expect(made.exitCode).toBe(0);
		expect(statSync(path).isFIFO()).toBe(true);
	};
	// A pipe where the word was (an agent that could write there): nobody reads it, so a read of it would never return.
	rmSync(file);
	mkfifo(file);
	state.set(true);
	expect(statSync(file).isFile()).toBe(true);
	expect(readFileSync(file, "utf8")).toBe(word);
	// A pipe where the next word is written first: a write to it would block for ever.
	rmSync(file);
	mkfifo(`${file}.tmp`);
	state.set(true);
	expect(statSync(file).isFile()).toBe(true);
	expect(readFileSync(file, "utf8")).toBe(word);
	// A file of another size is not the word, and is not read to find out.
	writeFileSync(file, `${word} `);
	state.set(true);
	expect(readFileSync(file, "utf8")).toBe(word);
});

test("a process is told the ports an omp-webui may serve on, so that its gate protects that API and no other", async () => {
	let ports: number[] | undefined;
	const { open, pool, overlayOf } = setup({ on: () => true, ports: () => ports });
	await open();
	// The server has not bound yet: no ports, every loopback /api/ asks.
	expect(JSON.parse(readFileSync(`${overlayOf()}.risk`, "utf8")).ports).toBeUndefined();
	ports = [7878, 7879];
	pool.syncRisk();
	expect(JSON.parse(readFileSync(`${overlayOf()}.risk`, "utf8")).ports).toEqual([7878, 7879]);
});

test("a process is told the address of a network the server was bound to, so that its gate protects the API there too", async () => {
	let hosts: string[] | undefined;
	const { open, pool, overlayOf } = setup({ on: () => true, ports: () => [7878], hosts: () => hosts });
	await open();
	// Bound to the loopback (or to every address): no host written, and only the loopback spellings ask.
	expect(JSON.parse(readFileSync(`${overlayOf()}.risk`, "utf8"))).not.toHaveProperty("hosts");
	hosts = ["192.168.1.5"];
	pool.syncRisk();
	expect(JSON.parse(readFileSync(`${overlayOf()}.risk`, "utf8")).hosts).toEqual(["192.168.1.5"]);
});

// ------------------------------------------------------------------ the setting, as the server reads it

test("the server reads the setting from the settings file, whether or not remote access is on, and again when the file changes", () => {
	const dir = scratch();
	const file = join(dir, "remote.json");
	const remote = new LazyRemote(
		dir,
		() => {},
		"127.0.0.1",
		() => 0,
	);
	expect(remote.confirmRisky()).toBe(false);
	writeFileSync(file, JSON.stringify({ confirmRisky: true }));
	expect(remote.confirmRisky()).toBe(true);
	// Remote access itself is off in that file: the switch is still read.
	expect(remote.settings()).toBeNull();
	writeFileSync(file, JSON.stringify({ confirmRisky: false, team: "x" }));
	expect(remote.confirmRisky()).toBe(false);
	// A file from before the setting: off. One that cannot be trusted: off.
	writeFileSync(file, JSON.stringify({ team: "x", hostname: "omp.example.com" }));
	expect(remote.confirmRisky()).toBe(false);
	writeFileSync(file, JSON.stringify({ confirmRisky: true }));
	expect(remote.confirmRisky()).toBe(true);
	writeFileSync(file, "{");
	expect(remote.confirmRisky()).toBe(false);
	writeFileSync(file, JSON.stringify({ confirmRisky: "yes" }));
	expect(remote.confirmRisky()).toBe(false);
	rmSync(file);
	expect(remote.confirmRisky()).toBe(false);
});

test("the gate says it started, beside the overlay and only once its handler is in; with no overlay it says nothing", async () => {
	const overlay = overlayWith({ armed: false, protect: [] });
	expect(existsSync(`${overlay}.risk.loaded`)).toBe(false);
	await load(["omp", "--config", overlay]);
	expect(existsSync(`${overlay}.risk.loaded`)).toBe(true);
	const bare = join(scratch(), "bare.yml");
	await load(["omp", "--mode", "rpc-ui"]);
	expect(existsSync(`${bare}.risk.loaded`)).toBe(false);
});

test("a gate that left no note is not one that covers the process, whatever its command line says; once seen, the note is not needed again", async () => {
	const { open, overlayOf } = setup({ on: () => true });
	const live = await open();
	expect(live.gated).toBe(false);
	writeFileSync(`${overlayOf()}.risk.loaded`, "1");
	expect(live.gated).toBe(true);
	// A cleaner of the temp folder takes the note of a conversation that has been running for hours: the gate is still in omp.
	rmSync(`${overlayOf()}.risk.loaded`);
	expect(live.gated).toBe(true);
});

test("a note that was never seen when it went is no note: the latch is of what was seen", () => {
	const dir = scratch();
	const state = new RiskState(join(dir, "L1.yml"), []);
	expect(state.loaded).toBe(false);
	writeFileSync(state.loadedFile, "1");
	rmSync(state.loadedFile);
	expect(state.loaded).toBe(false);
	writeFileSync(state.loadedFile, "1");
	expect(state.loaded).toBe(true);
	rmSync(state.loadedFile);
	expect(state.loaded).toBe(true);
});

test("a note the previous server saw is kept by the one that takes the process over, which has no note to look for", () => {
	const dir = scratch();
	const state = new RiskState(join(dir, "L1.yml"), [], true);
	expect(existsSync(state.loadedFile)).toBe(false);
	expect(state.loaded).toBe(true);
	expect(new RiskState(join(dir, "L2.yml"), [], false).loaded).toBe(false);
});

test("a process without the gate says why: by choice when this server started it so, and not at all once the gate ran or where the server has none", async () => {
	const { open, pool, overlayOf } = setup({ on: () => true });
	const told: (string | undefined)[] = [];
	pool.onAnnounce((info) => told.push(info.ungated));
	const live = await open();
	// Started with the gate named on its command line, which has not said it ran: this server's own start, so not an inherited one.
	expect(live.ungated).toBe("chosen");
	expect(live.info.ungated).toBe("chosen");
	// The gate says it started: the next look tells the pages, who were told otherwise.
	writeFileSync(`${overlayOf()}.risk.loaded`, "1");
	told.length = 0;
	pool.syncRisk();
	expect(live.ungated).toBeUndefined();
	expect(live.info.ungated).toBeUndefined();
	expect(told).toEqual([undefined]);
	// A look that finds nothing changed announces nothing.
	told.length = 0;
	pool.syncRisk();
	expect(told).toEqual([]);

	// A server with no gate has nothing a process could lack.
	const { open: openWithout } = setup({ on: () => true, gate: false });
	const bare = await openWithout();
	expect(bare.ungated).toBeUndefined();
	expect(bare.info.ungated).toBeUndefined();
});

test("a conversation whose own flags rule out the gate is ungated by choice", async () => {
	const dir = scratch();
	const log = join(dir, "log");
	writeFileSync(log, "");
	const bin = writeFakeHostOmp(dir, log, { configured: "yolo" });
	const own = new LivePool(fakeConfig(dir, bin), null, null, new ApprovalStore(bin, dir, 0));
	pools.push(own);
	own.gate = { extension: join(dir, "gate", "extension.ts"), protect: [], confirm: () => true, ensure: () => true };
	const live: Live = await own.open({ kind: "new", cwd: tmpdir(), args: ["--trusted-extension", "/x.ts"] }, async () =>
		tmpdir(),
	);
	expect(live.info.ungated).toBe("chosen");
});

test("a gate whose files cannot be put in place before a start leaves that process without it, and says so", async () => {
	const dir = scratch();
	const log = join(dir, "log");
	writeFileSync(log, "");
	const bin = writeFakeHostOmp(dir, log, { configured: "yolo" });
	const own = new LivePool(fakeConfig(dir, bin), null, null, new ApprovalStore(bin, dir, 0));
	pools.push(own);
	let ok = false;
	let tried = 0;
	own.gate = {
		extension: join(dir, "gate", "extension.ts"),
		protect: [],
		confirm: () => true,
		ensure: () => {
			tried++;
			return ok;
		},
	};
	const bare: Live = await own.open({ kind: "new", cwd: tmpdir() }, async () => tmpdir());
	// Asked before the start (how often is the pool's business).
	expect(tried).toBeGreaterThan(0);
	expect(argvOf(log)).not.toContain("--extension");
	expect(bare.gated).toBe(false);
	// Once the files can be written, the next process takes the gate.
	ok = true;
	writeFileSync(log, "");
	const asked = tried;
	await own.open({ kind: "new", cwd: tmpdir() }, async () => tmpdir());
	expect(tried).toBeGreaterThan(asked);
	expect(argvOf(log)).toContain("--extension");
});

test("a word the gate may not have is reported: noteOrigin says whether the state file was written", async () => {
	const { open, overlayOf } = setup({ on: () => true });
	const live = await open();
	expect(live.noteOrigin(true)).toBe(true);
	// A folder where the temporary file belongs: the state cannot be written.
	mkdirSync(`${overlayOf()}.risk.tmp`);
	// The turn goes to a local page: the file has to change, and cannot.
	expect(live.noteOrigin(false)).toBe(false);
	rmSync(`${overlayOf()}.risk.tmp`, { recursive: true });
	expect(live.noteOrigin(false)).toBe(true);
});

test("the setting is read once for all conversations, not once for each", async () => {
	let reads = 0;
	const { open, pool } = setup({
		on: () => {
			reads++;
			return true;
		},
	});
	await open();
	await open();
	reads = 0;
	pool.syncRisk();
	expect(reads).toBe(1);
});

test("a state file a cleaner of the temp folder took is written again by the next look, though nothing changed", () => {
	const dir = scratch();
	const state = new RiskState(join(dir, "L1.yml"), ["/a"]);
	state.set(false);
	const file = join(dir, "L1.yml.risk");
	expect(existsSync(file)).toBe(true);
	rmSync(file);
	state.set(false);
	expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ armed: false, protect: ["/a"] });
});
