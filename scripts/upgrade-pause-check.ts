/**
 * Does a paused conversation survive an app update? (`bun scripts/upgrade-pause-check.ts [upgrade|version|frames]
 * [--old <ref>] [--fixtures <dir>] [--keep]`, opt-in, macOS only.)
 *
 * A paused conversation outlives the server: quitting the app leaves its omp frozen behind the relay that holds its pipes,
 * and the next server on the same data dir adopts both (`LivePool.adopt`). An update quits the app, replaces the bundle
 * and starts the new one, so the new server must adopt what the OLD binary left. This runs exactly that, headless, across
 * two real builds: the release before (`--old <ref>`, or `OLD_REF`; by default the latest tag that is not this checkout's
 * own) and this checkout (uncommitted changes included). Run it before a release that touches `server/omp/parked.ts`, the
 * relay (`server/omp/relay*.ts`), `server/update/helper.sh`, or how `server/live.ts` adopts, pauses or resumes.
 *
 *   1. Both apps are built (`bun scripts/app.ts`, in copies of their own) and signed with one throwaway certificate, so the
 *      helper's signature and requirement checks pass as they do for a release. The OLD one is installed in a folder of its
 *      own and its server is started with the environment `macos/main.swift` gives it.
 *   2. Over the WebSocket, four conversations on a real omp (a scripted stub stands in for the model), all paused: c1
 *      mid-tool, c2 with a goal and a running subagent, c3 mid-tool (its relay is killed during the swap), c4 idle.
 *   3. The server is stopped as the app's quit does (SIGTERM), then the real `server/update/helper.sh` of the OLD ref swaps
 *      the bundle for the new one by rename and starts the NEW server (same data dir, but a NEW access token, as the app
 *      makes one per launch: adoption must not depend on it), which says it is up and is acknowledged.
 *   4. The new server must list c1, c2 and c4 as paused, attach with goal and subagents, resume them into the very same
 *      processes, finish the interrupted turn, take a new message, and leave no process behind; c3 must open as an ordinary
 *      conversation. Every PASS/FAIL line carries what was observed; the exit status is 1 when any check fails.
 *
 * The two other scenarios show what a user gets when a release breaks the contracts the new server adopts by (they pass when
 * the failure is the predicted one; see `tests/unit/update-compat.test.ts`):
 *   - `version`: the records on disk are of another `ParkedRecord.version`: nothing is adopted, the frozen omps run on
 *     unseen, and every launch waits for them.
 *   - `frames`: the new server speaks other relay frame ids (built from source with them renumbered): adoption fails and
 *     every paused conversation is ended.
 *
 * `--fixtures <dir>` writes the records the OLD server left (c1 and c2) as `parked-<ref>-{mid-tool,goal-subagents}.json`,
 * with the world's paths and this machine's home made generic, for `tests/fixtures` (then `bun run format`).
 * `--keep` leaves the work folder. Nothing here touches `/Applications/omp-webui.app`, its data, `~/.omp` or port 7878: the
 * servers get a HOME, agent directory, temp dir, data dir and port of their own, and a plain process stands in for the app.
 * Needs Xcode's command-line tools, Bun, rsync and the installed omp; about 75 s with warm caches, builds included.
 */
import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ParkedStore } from "../server/omp/parked.ts";
import * as protocol from "../server/omp/relay-protocol.ts";
import { isolatedEnv } from "../tests/support/omp-env.ts";
import { type StubScripted, startScriptedStub } from "../tests/support/stub-scripted.ts";
import { serverTmp } from "../tests/support/tmp.ts";
import { connect, request } from "../tests/support/ws.ts";
import { onShutdown } from "./lib/shutdown.ts";
import { BUNDLE_ID as APP_BUNDLE_ID, ensureIdentity, signBundle } from "./signing-identity.ts";

const repo = join(import.meta.dir, "..");
/** What a Finder launch gives the app, and the app its server. */
const LAUNCH_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
/** Not the app's own identifier: nothing here may be taken for the installed app. */
const BUNDLE_ID = `${APP_BUNDLE_ID}.upgradepause`;
const TICKS_TO_RUN = 25;
const NESTED = "You are operating on a piece of work assigned to you by the main agent";

const TAGS = ["c1", "c2", "c3", "c4"] as const;
type Tag = (typeof TAGS)[number];
/** The ones whose relay survives the swap (c3's is killed in it). */
const ADOPTED = ["c1", "c2", "c4"] as const;

// ------------------------------------------------------------------------------------------ what is read off the wire

interface Subagent {
	id: string;
	status?: string;
}
interface Goal {
	objective?: string;
	status?: string;
}
interface LiveRow {
	liveId: string;
	pid: number | null;
	pausedAt: number | null;
	exited: boolean;
	busy?: boolean;
	holding?: string | null;
	streaming: boolean;
	approvalMode?: string;
	sessionFile: string | null;
	sessionId: string | null;
	sessionSettings?: Record<string, string>;
}
interface Attached extends LiveRow {
	goal?: Goal;
	subagents?: Subagent[];
}
interface ParkedRec {
	version: number;
	liveId: string;
	owner: unknown;
	streaming: boolean;
	sessionSettings?: Record<string, string>;
	overlay?: { file?: string; mode?: string | null } | null;
	goal?: Goal;
	subagents?: Subagent[];
	descendants?: { pid: number }[];
}
interface Frame {
	liveId: string;
	frame: { type: string; payload?: { id?: string; status?: string } };
}

// ------------------------------------------------------------------------------------------------ the process table

interface Proc {
	pid: number;
	ppid: number;
	stat: string;
	command: string;
}
function procs(): Proc[] {
	const out = execFileSync("ps", ["-axo", "pid=,ppid=,stat=,command="], { encoding: "utf8" });
	const all: Proc[] = [];
	for (const line of out.split("\n")) {
		const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
		if (m) all.push({ pid: Number(m[1]), ppid: Number(m[2]), stat: m[3], command: m[4] });
	}
	return all;
}
const stateOf = (pid: number) => procs().find((p) => p.pid === pid)?.stat ?? "gone";
const alive = (pid: number) => !/^(gone|Z)/.test(stateOf(pid));
const frozen = (pid: number) => stateOf(pid).startsWith("T");
/** Cannot run: stopped, or a child that ended before the freeze reached it (a zombie: its frozen parent cannot reap it). */
const held = (pid: number) => /^[TZ]/.test(stateOf(pid));
function descendants(pid: number, all = procs()): number[] {
	const out: number[] = [];
	const walk = (p: number) => {
		for (const c of all.filter((q) => q.ppid === p)) {
			out.push(c.pid);
			walk(c.pid);
		}
	};
	walk(pid);
	return out;
}
function kill(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch {
		// gone
	}
}

// -------------------------------------------------------------------------------------------------------- the report

const lines: string[] = [];
function log(text: string): void {
	const line = `${new Date().toISOString().slice(11, 23)} ${text}`;
	lines.push(line);
	console.log(line);
}
const results: { id: string; ok: boolean }[] = [];
function check(id: string, ok: boolean, detail = ""): void {
	results.push({ id, ok });
	log(`${ok ? "PASS" : "FAIL"} ${id}${detail ? ` — ${detail}` : ""}`);
}
/** Something worth knowing that is not a verdict: whether the contracts differ from the old ref is what the checks find out. */
function note(text: string): void {
	log(`NOTE ${text}`);
}
async function until<T>(what: string, fn: () => T | Promise<T>, ms = 60_000, step = 200): Promise<NonNullable<T>> {
	const end = Date.now() + ms;
	for (;;) {
		const v = await Promise.resolve(fn()).catch(() => null);
		if (v) return v as NonNullable<T>;
		if (Date.now() > end) throw new Error(`timed out after ${ms / 1000} s waiting for ${what}`);
		await Bun.sleep(step);
	}
}

// ------------------------------------------------------------------------------------------- running and building

interface Spawned {
	out: string;
	err: string;
	code: number;
}
async function exec(
	cmd: string[],
	opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<Spawned> {
	const proc = Bun.spawn(cmd, {
		cwd: opts.cwd,
		env: (opts.env ?? process.env) as Record<string, string>,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { out, err, code };
}
async function sh(
	cmd: string[],
	opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<string> {
	const r = await exec(cmd, opts);
	if (r.code !== 0) throw new Error(`${cmd.join(" ")} (exit ${r.code}): ${r.err}${r.out}`.slice(-3000));
	return r.out;
}
const git = (...args: string[]) => sh(["git", "-C", repo, ...args]);

/** The latest release tag reachable from here that is not on this very commit: the release an update starts from. */
async function previousTag(): Promise<string> {
	const here = (await git("tag", "--points-at", "HEAD")).split("\n").filter(Boolean);
	const tags = (await git("tag", "-l", "--merged", "HEAD", "--sort=-v:refname", "v*")).split("\n").filter(Boolean);
	const tag = tags.find((t) => !here.includes(t));
	if (!tag) throw new Error("no earlier release tag to start from: name one with --old <ref>");
	return tag;
}

/** `bun scripts/app.ts` in `dir`, with a HOME of its own so that it signs ad hoc (the caller signs again) and finds no keys. */
async function buildApp(dir: string, home: string): Promise<string> {
	mkdirSync(home, { recursive: true });
	const env = { ...process.env, HOME: home, BUN_INSTALL: process.env.BUN_INSTALL ?? join(homedir(), ".bun") };
	await sh(["bun", "scripts/app.ts"], { cwd: dir, env });
	return join(dir, "dist", "omp-webui.app");
}
/** `ref` as it was committed, in `dir`, with its own dependencies, built. */
async function buildOld(ref: string, root: string): Promise<string> {
	const dir = join(root, "src-old");
	mkdirSync(dir);
	await git("archive", "--format=tar", "-o", join(root, "old.tar"), ref);
	await sh(["tar", "-xf", join(root, "old.tar"), "-C", dir]);
	const home = join(root, "home-build-old");
	mkdirSync(home);
	const env = { ...process.env, HOME: home, BUN_INSTALL: process.env.BUN_INSTALL ?? join(homedir(), ".bun") };
	await sh(["bun", "install", "--frozen-lockfile"], { cwd: dir, env });
	return buildApp(dir, home);
}
/** A copy of this checkout, its working tree as it is, built. */
async function buildNew(root: string): Promise<string> {
	const dir = join(root, "src-new");
	const skip = ["node_modules", "dist", ".git", "test-results", "playwright-report", ".tmp"].flatMap((p) => [
		"--exclude",
		p,
	]);
	await sh(["rsync", "-a", ...skip, `${repo}/`, `${dir}/`]);
	await sh(["ln", "-s", join(repo, "node_modules"), join(dir, "node_modules")]);
	return buildApp(dir, join(root, "home-build-new"));
}

// ---------------------------------------------------------------------------------------------------------- servers

/** What `relaunch` needs to start the new server the way the app does: written before the helper starts. */
interface Context {
	root: string;
	logs: string;
	/** The environment the app gives its server, except its token and its parent. */
	serverEnv: Record<string, string>;
	/** The server's command, where it is not the bundle's own binary (the `frames` scenario runs patched source). */
	command?: string[];
	app: string;
}
interface Launched {
	pid: number;
	appPid: number;
	token: string;
}
const serverOf = (app: string) => join(app, "Contents", "Resources", "omp-webui-server");

/** A server of `ctx.app`, started as `macos/main.swift` starts it: its environment, a plain process as its parent, a token of its own. */
function launchServer(ctx: Context, label: string): Launched & { proc: Bun.Subprocess } {
	const dummy = Bun.spawn(["/bin/sleep", "86400"], { detached: true, stdio: ["ignore", "ignore", "ignore"] });
	dummy.unref();
	const token = `tok-${crypto.randomUUID()}`;
	const out = openSync(join(ctx.logs, `${label}-server.log`), "a");
	const proc = Bun.spawn(ctx.command ?? [serverOf(ctx.app)], {
		cwd: join(ctx.root, "home"),
		env: {
			...ctx.serverEnv,
			OMP_WEBUI_TOKEN: token,
			OMP_WEBUI_PARENT_PID: String(dummy.pid),
			OMP_WEBUI_APP_BUNDLE: ctx.app,
			OMP_WEBUI_DIST: join(ctx.app, "Contents", "Resources", "web"),
		},
		stdin: "ignore",
		stdout: out,
		stderr: out,
		detached: true,
	});
	proc.unref();
	return { pid: proc.pid, appPid: dummy.pid, token, proc };
}
async function readyPort(ctx: Context, label: string): Promise<number> {
	const file = join(ctx.logs, `${label}-server.log`);
	const m = await until(`the ${label} server to be ready`, () =>
		/OMPW_READY (\{.*\})/.exec(readFileSync(file, "utf8")),
	);
	return JSON.parse(m[1]).port;
}

/** What the update helper runs to start the app again (`<command> --relaunch <context file>`): the new server, with a new token. */
function relaunch(contextFile: string): void {
	const ctx = JSON.parse(readFileSync(contextFile, "utf8")) as Context;
	const { pid, appPid, token } = launchServer(ctx, "new");
	writeFileSync(join(ctx.root, "new-server.json"), JSON.stringify({ pid, appPid, token } satisfies Launched));
}

// ------------------------------------------------------------------------------------------------------------- main

interface Conv {
	tag: Tag;
	liveId: string;
	omp: number;
	relay: number;
	tools: number[];
	sessionFile: string | null;
	sessionId: string | null;
	pausedAt: number;
	atPause: number;
	/** The conversation's own settings overlay (what holds its approval mode): omp reads it again when it runs. */
	overlay: string | null;
}

const args = process.argv.slice(2);
if (args[0] === "--relaunch") {
	relaunch(args[1]);
	process.exit(0);
}
const flag = (name: string) => {
	const at = args.indexOf(name);
	return at >= 0 ? args[at + 1] : undefined;
};
const keep = args.includes("--keep");
const fixturesDir = flag("--fixtures");
const scenario = args.find((a) => ["upgrade", "version", "frames"].includes(a)) ?? "upgrade";

if (process.platform !== "darwin") {
	console.error("upgrade-pause-check: macOS only (it builds, signs and swaps the app)");
	process.exit(2);
}

const root = realpathSync(mkdtempSync("/tmp/ompw-upc-"));
const strays = new Set<number>();
const launched: Launched[] = [];
let backend: StubScripted | null = null;
let keychain: string | null = null;
const cleanup = onShutdown(async () => {
	for (const s of launched) for (const pid of [s.pid, s.appPid]) kill(pid, "SIGKILL");
	for (const pid of strays) kill(pid, "SIGKILL");
	// Everything of this world has its folder in its command line (the folder is unique to this run).
	for (const p of procs()) if (p.command.includes(root) && p.pid !== process.pid) kill(p.pid, "SIGKILL");
	await backend?.stop().catch(() => {});
	if (keychain) Bun.spawnSync(["security", "delete-keychain", keychain], { stderr: "ignore" });
	if (keep) log(`the work folder is ${root}`);
	else rmSync(root, { recursive: true, force: true });
});

try {
	await main();
} catch (e) {
	check("harness", false, e instanceof Error ? (e.stack ?? e.message) : String(e));
} finally {
	await cleanup();
}
const failed = results.filter((r) => !r.ok);
console.log(
	`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; FAILED: ${failed.map((f) => f.id).join(", ")}` : ""}`,
);
process.exit(failed.length ? 1 : 0);

async function main(): Promise<void> {
	const data = join(root, "data");
	const logs = join(root, "logs");
	const ticksDir = join(root, "ticks");
	const work = join(root, "work");
	const apps = join(root, "Apps");
	const app = join(apps, "omp-webui.app");
	for (const d of [data, logs, ticksDir, work, apps]) mkdirSync(d);
	const oldRef = flag("--old") ?? process.env.OLD_REF ?? (await previousTag());
	const oldSha = (await git("rev-parse", "--short", `${oldRef}^{commit}`)).trim();
	const omp = Bun.which("omp");
	if (!omp) throw new Error("omp is not installed (the checks run a real one)");
	log(
		`old = ${oldRef} (${oldSha}), new = this checkout (HEAD ${(await git("rev-parse", "--short", "HEAD")).trim()}); ${(await sh([omp, "--version"])).trim()}`,
	);

	// ---- the two apps, signed alike, the OLD one installed
	log("building both apps (about a minute)");
	const [oldBuilt, newBuilt] = await Promise.all([buildOld(oldRef, root), buildNew(root)]);
	const signing = join(root, "signing.keychain-db");
	keychain = signing;
	ensureIdentity(signing);
	const signedCopy = async (from: string, to: string) => {
		await sh(["ditto", from, to]);
		await sh(["plutil", "-replace", "CFBundleIdentifier", "-string", BUNDLE_ID, join(to, "Contents", "Info.plist")]);
		signBundle(to, { keychain: signing, identifier: BUNDLE_ID });
	};
	await signedCopy(oldBuilt, app);
	const stagedNew = join(root, "new-signed.app");
	await signedCopy(newBuilt, stagedNew);
	const version = async (path: string) =>
		(
			await sh([
				"plutil",
				"-extract",
				"CFBundleShortVersionString",
				"raw",
				"-o",
				"-",
				join(path, "Contents", "Info.plist"),
			])
		).trim();
	const sha = async (file: string) => (await sh(["shasum", "-a", "256", file])).split(" ")[0].slice(0, 12);
	const inodeOf = async (file: string) => (await sh(["stat", "-f", "%i", file])).trim();
	const oldBinSha = await sha(serverOf(app));
	const oldInode = await inodeOf(serverOf(app));
	const newBinSha = await sha(serverOf(stagedNew));
	log(
		`installed ${await version(app)} (server ${oldBinSha}); update is ${await version(stagedNew)} (server ${newBinSha})`,
	);
	check("setup.builds-differ", oldBinSha !== newBinSha, "the old and the new server binary are different builds");

	// ---- the contracts the new server adopts by: said, not judged (adoption below is the verdict)
	const parkedFiles = [
		"server/omp/parked.ts",
		"server/omp/relay-protocol.ts",
		"server/omp/relay.ts",
		"server/omp/relay-client.ts",
		"server/omp/relay-main.ts",
		"server/omp/relay-backlog.ts",
		"server/omp/process-tree.ts",
		"server/update/helper.sh",
	];
	const differing = (await git("diff", "--name-only", oldRef, "--", ...parkedFiles)).split("\n").filter(Boolean);
	note(
		differing.length
			? `differ from ${oldRef}: ${differing.join(", ")}`
			: `parked.ts, the relay files, process-tree.ts and helper.sh are identical to ${oldRef}`,
	);
	const oldProtocol = (await import(join(root, "src-old", "server/omp/relay-protocol.ts"))) as typeof protocol; // the old ref's own, not this checkout's
	const table = (p: typeof protocol) =>
		JSON.stringify({
			to: p.TO_RELAY,
			from: p.FROM_RELAY,
			header: p.FRAME_HEADER,
			flag: p.RELAY_FLAG,
			stdin: p.encodeFrame(p.TO_RELAY.stdin, "x").toString("hex"),
		});
	note(
		table(oldProtocol) === table(protocol)
			? `relay frame ids and bytes are the same as ${oldRef}'s: ${table(protocol)}`
			: `relay frames differ from ${oldRef}'s: ${table(oldProtocol)} → ${table(protocol)}`,
	);

	// ---- the stub model, the omp world, the OLD server
	const loop = (tag: Tag) =>
		`i=0; while [ $i -lt ${TICKS_TO_RUN} ]; do i=$((i+1)); echo tick-$i; echo tick-$i >> '${ticksDir}/${tag}.txt'; /bin/sleep 1; done; echo UPGRADE-DONE-${tag}`;
	const bash = (tag: Tag) => ({ call: { name: "bash", args: { command: loop(tag), timeout: 600 } } });
	const task = {
		call: {
			name: "task",
			args: { context: "Upgrade check.", tasks: [{ name: "Sub", task: "SUB-TASK: run the tick loop." }] },
		},
	};
	backend = await startScriptedStub((req) => {
		if (!req.tools.includes("read")) return { text: "A title" };
		const t = req.text;
		if (t.includes(NESTED)) return req.toolResults === 0 ? bash("c2") : { text: "SUB-DONE-c2" };
		for (const c of TAGS) if (t.includes(`[${c}:next]`)) return { text: `NEXT-OK-${c}` };
		if (t.includes("[c1:start]")) return req.toolResults === 0 ? bash("c1") : { text: "c1 tool finished" };
		if (t.includes("[c3:start]")) return req.toolResults === 0 ? bash("c3") : { text: "c3 tool finished" };
		if (t.includes("[c2:start]")) return req.toolResults === 0 ? task : { text: "c2 main continues" };
		if (t.includes("[c4:start]")) return { text: "c4 first reply" };
		return { text: "ok" };
	});
	const env = await isolatedEnv(root, { login: false });
	writeFileSync(
		join(env.PI_CODING_AGENT_DIR, "models.yml"),
		`providers:\n  omlx:\n    baseUrl: ${backend.url}\n    api: openai-completions\n    apiKey: ${backend.apiKey}\n    discovery:\n      type: openai-models-list\n`,
	);
	writeFileSync(
		join(env.PI_CODING_AGENT_DIR, "config.yml"),
		[
			"modelRoles:",
			...["default", "smol", "slow", "tiny", "commit"].map((r) => `  ${r}: omlx/stub-model`),
			"spelling:",
			"  autocomplete: ngram",
			"",
		].join("\n"),
	);
	const ctx: Context = {
		root,
		logs,
		app,
		serverEnv: {
			...env,
			PATH: LAUNCH_PATH,
			SHELL: "/bin/zsh",
			USER: process.env.USER ?? "user",
			LANG: "en_US.UTF-8",
			OMP_BIN: omp,
			TMPDIR: serverTmp(env.TMPDIR, data),
			OMP_WEBUI_LOGIN_SHELL: "/bin/zsh",
			OMP_WEBUI_DATA_DIR: data,
			OMP_WEBUI_PORT: "0",
			OMP_WEBUI_AUTO_PORT: "1",
			OMP_WEBUI_UPDATE_CHECK: "off",
		},
	};
	const contextFile = join(root, "context.json");
	writeFileSync(contextFile, JSON.stringify(ctx));

	const oldServer = launchServer(ctx, "old");
	launched.push(oldServer);
	const oldPort = await readyPort(ctx, "old");
	log(`OLD server pid ${oldServer.pid} (parent "app" ${oldServer.appPid}) on port ${oldPort}`);
	const lives = async (port: number, token: string) =>
		fetch(`http://127.0.0.1:${port}/api/lives`, { headers: { "x-omp-webui-token": token } });
	const listing = async (port: number, token: string): Promise<LiveRow[]> => (await lives(port, token)).json();
	const tap = (ws: WebSocket) => {
		const frames: Frame[] = [];
		ws.addEventListener("message", (ev) => {
			try {
				const m = JSON.parse(String(ev.data));
				if (m.t === "frame") frames.push(m);
			} catch {
				// a part of a long reply
			}
		});
		return frames;
	};
	const rpc = <T = Record<string, unknown>>(ws: WebSocket, liveId: string, command: Record<string, unknown>) =>
		request<T>(ws, { t: "rpc", liveId, command });
	const ticks = (tag: Tag): number => {
		try {
			return readFileSync(join(ticksDir, `${tag}.txt`), "utf8")
				.split("\n")
				.filter(Boolean).length;
		} catch {
			return 0;
		}
	};
	const record = (liveId: string): ParkedRec =>
		JSON.parse(readFileSync(join(data, "parked", `${liveId}.json`), "utf8"));
	const recordFile = (liveId: string) => join(data, "parked", `${liveId}.json`);

	// ---- four conversations, paused
	const ws1 = await connect({ url: `http://127.0.0.1:${oldPort}`, accessToken: oldServer.token });
	const frames1 = tap(ws1);
	const convs = new Map<Tag, Conv>();
	const conv = (tag: Tag): Conv => {
		const c = convs.get(tag);
		if (!c) throw new Error(`${tag} was not paused`);
		return c;
	};
	const openConv = async (): Promise<{ liveId: string; omp: number }> => {
		const info = await request<LiveRow>(ws1, { t: "open", target: { kind: "new", cwd: work } });
		await request(ws1, { t: "approval_mode", liveId: info.liveId, mode: "yolo" });
		strays.add(info.pid as number);
		return { liveId: info.liveId, omp: info.pid as number };
	};
	const relayOf = (liveId: string) =>
		procs().find((p) => p.command.includes("--ompw-relay") && p.command.includes(liveId))?.pid ?? 0;
	/** What the conversation's tool runs as: whatever has its tick file in its command line (a loop's shell), and what those and omp started. */
	const toolsOf = (tag: Tag, ompPid: number): number[] => {
		const all = procs();
		const loops = all.filter((p) => p.command.includes(`${ticksDir}/${tag}.txt`)).map((p) => p.pid);
		return [...new Set([...loops, ...loops.flatMap((p) => descendants(p, all)), ...descendants(ompPid, all)])];
	};
	const pause = async (tag: Tag, c: { liveId: string; omp: number }) => {
		const paused = await request<LiveRow>(ws1, { t: "pause", liveId: c.liveId });
		await Bun.sleep(1200);
		const tools = toolsOf(tag, c.omp);
		const relay = relayOf(c.liveId);
		for (const p of [c.omp, relay, ...tools]) strays.add(p);
		convs.set(tag, {
			tag,
			liveId: c.liveId,
			omp: c.omp,
			relay,
			tools,
			sessionFile: paused.sessionFile,
			sessionId: paused.sessionId,
			pausedAt: paused.pausedAt as number,
			atPause: ticks(tag),
			overlay: record(c.liveId).overlay?.file ?? null,
		});
		log(`${tag}: paused (omp ${c.omp}, relay ${relay}, tools ${tools.join(",") || "-"}), ticks at pause ${ticks(tag)}`);
	};

	const c1 = await openConv();
	await rpc(ws1, c1.liveId, { type: "set_auto_retry", enabled: false });
	await rpc(ws1, c1.liveId, { type: "set_cache_warming", mode: "streaming" });
	await rpc(ws1, c1.liveId, { type: "prompt", message: "[c1:start] run the loop" });
	const c3 = await openConv();
	await rpc(ws1, c3.liveId, { type: "prompt", message: "[c3:start] run the loop" });
	const c2 = await openConv();
	await rpc(ws1, c2.liveId, { type: "goal", op: "create", objective: "[c2:start] drive one subagent" });
	const c4 = await openConv();
	await rpc(ws1, c4.liveId, { type: "prompt", message: "[c4:start] say something" });
	await until("c4 to finish its turn", () =>
		frames1.some((f) => f.liveId === c4.liveId && f.frame.type === "agent_end"),
	);
	await until(
		"the loops of c1, c2 and c3 to tick",
		() => ticks("c1") >= 3 && ticks("c2") >= 3 && ticks("c3") >= 3,
		90_000,
	);
	await until("c2's subagent to be listed as running", async () =>
		(await rpc<{ subagents?: Subagent[] }>(ws1, c2.liveId, { type: "get_subagents" })).subagents?.some(
			(s) => s.id === "Sub",
		),
	);
	const goalBefore = (await rpc<{ goal?: Goal | null }>(ws1, c2.liveId, { type: "goal", op: "get" })).goal;
	for (const [tag, c] of [
		["c1", c1],
		["c2", c2],
		["c3", c3],
		["c4", c4],
	] as const)
		await pause(tag, c);

	// ---- the OLD server's state when the app quits
	for (const c of convs.values()) {
		const wantsTool = c.tag !== "c4";
		check(
			`old.${c.tag}.paused`,
			frozen(c.omp) &&
				(wantsTool ? c.tools.length > 0 : true) &&
				c.tools.every(held) &&
				!frozen(c.relay) &&
				existsSync(recordFile(c.liveId)),
			`omp ${c.omp} frozen, ${c.tools.length} tool process(es) [${c.tools.map((p) => `${p}:${stateOf(p)}`).join(",")}] held (T = stopped, Z = ended before the freeze reached it)${wantsTool ? "; a tool is required" : "; idle: none expected"}, relay ${c.relay} running, record on disk`,
		);
	}
	const rec1 = record(c1.liveId);
	const rec2 = record(c2.liveId);
	check(
		"old.records.version-1",
		[...convs.values()].every((c) => record(c.liveId).version === 1),
		`ParkedRecord.version = ${rec1.version}; keys: ${Object.keys(rec1).join(",")}`,
	);
	check(
		"old.c1.record-streaming-settings",
		rec1.streaming === true &&
			JSON.stringify(rec1.sessionSettings) === JSON.stringify({ autoRetry: "off", cacheWarming: "streaming" }) &&
			rec1.overlay?.mode === "yolo",
		`streaming=${rec1.streaming} sessionSettings=${JSON.stringify(rec1.sessionSettings)} overlay.mode=${rec1.overlay?.mode}`,
	);
	check(
		"old.c2.record-goal-subagents",
		Boolean(rec2.goal) && Boolean(rec2.subagents?.some((s) => s.id === "Sub")),
		`goal=${JSON.stringify(rec2.goal)?.slice(0, 100)} subagents=${JSON.stringify(rec2.subagents?.map((s) => [s.id, s.status]))}`,
	);
	// The old records, read by this checkout's own parser (on a copy: `list` removes what it cannot read).
	const copy = join(root, "parked-copy");
	mkdirSync(copy);
	cpSync(join(data, "parked"), join(copy, "parked"), { recursive: true });
	const parsed = new ParkedStore(copy).list();
	const parsedC2 = parsed.find((r) => r.liveId === c2.liveId);
	check(
		"contract.new-parser-reads-old-records",
		parsed.length === TAGS.length &&
			parsed.every((r) => r.version === 1) &&
			Boolean(parsedC2?.goal) &&
			parsedC2?.subagents?.length === 1,
		`this checkout's ParkedStore.list() on the records the old server wrote: ${parsed.length} records, goal kept: ${Boolean(parsedC2?.goal)}, subagents kept: ${parsedC2?.subagents?.length}`,
	);

	// ---- the update: the real helper of the old ref swaps the bundle and starts the new server
	if (scenario === "frames") {
		// A build whose relay frame ids are renumbered (+10): the new server speaks to the old relays with ids they do not know.
		const patched = join(root, "src-new-patched");
		await sh(["cp", "-Rc", join(root, "src-new"), patched]);
		const file = join(patched, "server/omp/relay-protocol.ts");
		let renumbered = 0;
		const source = readFileSync(file, "utf8").replace(
			/^(\t(?:stdin|stdinEnd|hold|hello|stdout|stderr|exit|replaced): )(\d+),$/gm,
			(_m, key: string, n: string) => {
				renumbered++;
				return `${key}${Number(n) + 10},`;
			},
		);
		if (renumbered !== 8)
			throw new Error(`could not renumber the relay frame ids (${renumbered} of 8 found): update this scenario`);
		writeFileSync(file, source);
		ctx.command = [process.execPath, join(patched, "server/main.ts")];
		writeFileSync(contextFile, JSON.stringify(ctx));
		log("frames scenario: the new server runs from source with the relay frame ids renumbered +10");
	}
	const staged = `${app}.updating`;
	const backup = `${app}.previous`;
	await sh(["ditto", stagedNew, staged]);
	const updateDir = join(data, "update");
	mkdirSync(updateDir);
	const helper = join(updateDir, "helper.sh");
	cpSync(join(root, "src-old", "server/update/helper.sh"), helper); // the old server writes its own helper
	const helperLog = openSync(join(updateDir, "helper.log"), "a");
	const id = crypto.randomUUID();
	const from = await version(app);
	const to = await version(staged);
	const helperProc = Bun.spawn(
		[
			"/bin/sh",
			helper,
			id,
			String(oldServer.appPid),
			app,
			staged,
			backup,
			updateDir,
			"90",
			"60",
			from,
			to,
			"--",
			process.execPath,
			import.meta.path,
			"--relaunch",
			contextFile,
		],
		{ cwd: "/", env: { PATH: LAUNCH_PATH }, stdin: "ignore", stdout: helperLog, stderr: helperLog, detached: true },
	);
	helperProc.unref();
	writeFileSync(
		join(updateDir, "handover.json"),
		JSON.stringify({ id, from, to, installed: app, staged, backup, helperPid: helperProc.pid }),
	);
	log(`helper pid ${helperProc.pid} waits for the app (pid ${oldServer.appPid}) to quit`);

	// The app quits: the server is stopped with SIGTERM (macos/server.swift kills it only after 5 s).
	const quitAt = Date.now();
	process.kill(oldServer.pid, "SIGTERM");
	const exitCode = await Promise.race([oldServer.proc.exited, Bun.sleep(5000).then(() => "timeout")]);
	const oldLog = readFileSync(join(logs, "old-server.log"), "utf8");
	check(
		"quit.server-exits-cleanly",
		exitCode === 0,
		`the old server exited with ${exitCode} ${Date.now() - quitAt} ms after SIGTERM`,
	);
	check(
		"quit.server-reports-kept",
		/4 conversation\(s\).*stay in the background/.test(oldLog),
		oldLog
			.split("\n")
			.filter((l) => /stay in the background|shutdown failed/.test(l))
			.join(" | "),
	);
	check(
		"quit.records-released",
		[...convs.values()].every((c) => record(c.liveId).owner === null),
		"every record's owner is null once the server has let go",
	);
	if (fixturesDir) {
		mkdirSync(fixturesDir, { recursive: true });
		const generic = (rec: ParkedRec) =>
			`${JSON.stringify(rec, null, "\t")}\n`
				.replaceAll(`--${root.slice(1).replaceAll("/", "-")}-work--`, "--tmp-world-work--")
				.replaceAll(root, "/tmp/world")
				.replaceAll(homedir(), "/home/jdoe");
		for (const [name, c] of [
			["mid-tool", conv("c1")],
			["goal-subagents", conv("c2")],
		] as const) {
			const file = join(fixturesDir, `parked-${oldRef}-${name}.json`);
			writeFileSync(file, generic(record(c.liveId)));
			log(`wrote ${file}`);
		}
	}
	if (scenario === "upgrade") {
		// The reverse-safety case: c3's relay dies in the swap window (the old server is gone, the new one is not there yet).
		const c = conv("c3");
		kill(c.relay, "SIGKILL");
		await until("c3's relay to be gone", () => !alive(c.relay), 5000);
		log(`c3: relay ${c.relay} killed during the swap; omp ${c.omp} still ${alive(c.omp) ? "there" : "gone"}`);
	}
	if (scenario === "version") {
		// As if the new build wrote (or only knew) another ParkedRecord.version: the records on disk are "other" to it.
		for (const c of convs.values()) {
			const file = recordFile(c.liveId);
			writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), version: 2 }));
		}
		log("version scenario: every record rewritten with version 2");
	}
	await Bun.sleep(8000); // time passes while nothing serves them: nothing may advance
	check(
		"swap.still-frozen-without-a-server",
		ADOPTED.every((t) => frozen(conv(t).omp)) &&
			ticks("c1") === conv("c1").atPause &&
			ticks("c2") === conv("c2").atPause,
		`ticks c1 ${conv("c1").atPause}→${ticks("c1")}, c2 ${conv("c2").atPause}→${ticks("c2")} over 8+ s with no server`,
	);
	const relayText = async (tag: Tag) => {
		const r = await exec(["lsof", "-p", String(conv(tag).relay), "-a", "-d", "txt", "-Fi"]);
		return r.out.split("\n").find((l) => l.startsWith("i"));
	};
	const relayInodesBefore = await Promise.all(ADOPTED.map(relayText));

	const swapAt = Date.now();
	kill(oldServer.appPid, "SIGTERM"); // the app has quit: the helper swaps
	await until("the helper to finish", () => !alive(helperProc.pid), 120_000);
	const helperText = readFileSync(join(updateDir, "helper.log"), "utf8");
	log(
		`helper.log:\n${helperText
			.trim()
			.split("\n")
			.map((l) => `    ${l}`)
			.join("\n")}`,
	);
	check(
		"swap.helper-succeeded",
		/the new app is up; the backup is removed/.test(helperText) && !existsSync(backup) && !existsSync(staged),
		"the helper swapped by rename, the NEW server acknowledged, the backup (the old app) was removed",
	);
	const newServer = JSON.parse(readFileSync(join(root, "new-server.json"), "utf8")) as Launched;
	launched.push(newServer);
	const installedSha = await sha(serverOf(app));
	check(
		"swap.installed-is-new",
		installedSha === newBinSha && installedSha !== oldBinSha,
		`server binary at the installed path: ${oldBinSha} → ${installedSha}`,
	);
	const newPort = await readyPort(ctx, "new");
	const newLog = () => readFileSync(join(logs, "new-server.log"), "utf8");
	log(
		`NEW server pid ${newServer.pid} on port ${newPort}; old relays alive: ${ADOPTED.map((t) => `${t}:${alive(conv(t).relay)}`).join(" ")}`,
	);
	check(
		"token.new-launch-has-a-new-token",
		newServer.token !== oldServer.token,
		"as the app makes one per launch; adoption below ran under it",
	);
	const rejected = await lives(newPort, oldServer.token);
	const accepted = await lives(newPort, newServer.token);
	check(
		"token.adoption-ran-under-a-new-token",
		rejected.status === 401 && accepted.status === 200,
		`the new server answers /api/lives with ${accepted.status} to its own token and ${rejected.status} to the old one`,
	);

	if (scenario !== "upgrade") {
		await mismatch(scenario, { newPort, newToken: newServer.token, swapAt, newLog: newLog(), ctx });
		return;
	}
	const inodeNow = await inodeOf(serverOf(app));
	const relayInodesAfter = await Promise.all(ADOPTED.map(relayText));
	check(
		"swap.relays-run-the-old-binary",
		ADOPTED.every(
			(t, i) =>
				alive(conv(t).relay) && relayInodesBefore[i] === `i${oldInode}` && relayInodesAfter[i] === `i${oldInode}`,
		) && inodeNow !== oldInode,
		`the relays survived the swap and still map the OLD server file (inode ${oldInode}); the installed file is now inode ${inodeNow}`,
	);
	check(
		"adopt.server-says-so",
		/took over 3 paused conversation\(s\)/.test(newLog()),
		newLog()
			.split("\n")
			.filter((l) => /took over|could not take over|relay\(s\)/.test(l))
			.join(" | "),
	);

	// ---- the NEW server
	const newUrl = `http://127.0.0.1:${newPort}`;
	const ws2 = await connect({ url: newUrl, accessToken: newServer.token });
	const frames2 = tap(ws2);
	const listed = await listing(newPort, newServer.token);
	for (const t of ADOPTED) {
		const c = conv(t);
		const l = listed.find((x) => x.liveId === c.liveId);
		check(
			`new.${t}.listed-paused`,
			Boolean(l) &&
				l?.pid === c.omp &&
				l?.pausedAt === c.pausedAt &&
				l?.exited === false &&
				l?.holding === "paused" &&
				l?.busy === true,
			JSON.stringify(
				l && {
					pid: l.pid,
					pausedAt: l.pausedAt,
					holding: l.holding,
					busy: l.busy,
					streaming: l.streaming,
					approvalMode: l.approvalMode,
				},
			),
		);
		check(
			`new.${t}.adoption-did-not-run-it`,
			frozen(c.omp) && c.tools.every(held) && ticks(t) === c.atPause,
			`still frozen after adoption (tools ${c.tools.map((p) => `${p}:${stateOf(p)}`).join(",") || "none"}), ticks ${ticks(t)} (at pause ${c.atPause})`,
		);
		check(
			`new.${t}.overlay-kept`,
			c.overlay !== null && existsSync(c.overlay),
			"the overlay file in the dead old server's temp dir is still there for omp",
		);
	}
	const lost = conv("c3");
	check(
		"new.c3.not-listed",
		!listed.some((x) => x.liveId === lost.liveId),
		`c3's record was discarded: lives = [${listed.map((x) => x.liveId.slice(0, 8)).join(",")}]`,
	);
	const orphansEnded = await until(
		"c3's orphaned omp and its tool to be ended",
		() => !alive(lost.omp) && lost.tools.every((p) => !alive(p)),
		15_000,
	).then(
		() => true,
		() => false,
	);
	check("new.c3.orphans-ended", orphansEnded, `omp ${lost.omp} and ${lost.tools.length} tool process(es)`);
	check("new.c3.record-removed", !existsSync(recordFile(lost.liveId)), "");
	check(
		"new.c3.overlay-removed",
		lost.overlay !== null && !existsSync(lost.overlay),
		"the discarded conversation's overlay file is cleaned up",
	);
	const c3Ticks = ticks("c3");
	await Bun.sleep(2500);
	check("new.c3.tool-stopped", ticks("c3") === c3Ticks, `c3 ticks ${c3Ticks} → ${ticks("c3")}`);

	// What a page that opens a paused conversation is shown.
	const told = JSON.stringify({ autoRetry: "off", cacheWarming: "streaming" });
	const att1 = await request<Attached>(ws2, { t: "attach", liveId: c1.liveId });
	check(
		"new.c1.attach",
		att1.pausedAt === conv("c1").pausedAt &&
			att1.streaming === true &&
			att1.approvalMode === "yolo" &&
			JSON.stringify(att1.sessionSettings) === told,
		`pausedAt ${att1.pausedAt}, streaming ${att1.streaming}, approvalMode ${att1.approvalMode}, sessionSettings ${JSON.stringify(att1.sessionSettings)}`,
	);
	const att2 = await request<Attached>(ws2, { t: "attach", liveId: c2.liveId });
	check(
		"new.c2.attach-goal-subagents",
		att2.pausedAt === conv("c2").pausedAt &&
			att2.goal?.status === "active" &&
			String(att2.goal?.objective).includes("[c2:start]") &&
			Boolean(att2.subagents?.some((s) => s.id === "Sub")),
		`goal ${JSON.stringify(att2.goal)?.slice(0, 120)}; subagents ${JSON.stringify(att2.subagents?.map((s) => [s.id, s.status]))}`,
	);
	const att4 = await request<Attached>(ws2, { t: "attach", liveId: c4.liveId });
	check(
		"new.c4.attach",
		att4.pausedAt === conv("c4").pausedAt && att4.streaming === false,
		`pausedAt ${att4.pausedAt}, streaming ${att4.streaming}`,
	);
	const refusal = await rpc(ws2, c1.liveId, { type: "get_state" }).then(
		() => "answered",
		(e: Error) => e.message,
	);
	check(
		"new.c1.background-reads-refused-while-paused",
		/paused/.test(refusal),
		`get_state on the frozen omp: ${refusal}`,
	);

	// Resume: the very same processes run, the interrupted turn finishes.
	const agentEnds = (liveId: string) =>
		frames2.filter((f) => f.liveId === liveId && f.frame.type === "agent_end").length;
	for (const t of ADOPTED) {
		const r = await request<LiveRow>(ws2, { t: "resume", liveId: conv(t).liveId });
		check(`new.${t}.resume`, r.pausedAt === null, `pausedAt → ${r.pausedAt}`);
	}
	await until(
		"omp and its tools to run again",
		() => ADOPTED.every((t) => !frozen(conv(t).omp) && conv(t).tools.every((p) => !frozen(p))),
		10_000,
	);
	for (const t of ADOPTED) {
		const c = conv(t);
		const live = (await listing(newPort, newServer.token)).find((x) => x.liveId === c.liveId);
		check(
			`new.${t}.same-processes-running`,
			live?.pid === c.omp && alive(c.relay) && alive(c.omp) && !existsSync(recordFile(c.liveId)),
			`omp ${live?.pid}, relay ${c.relay}, record removed`,
		);
	}
	await until(
		"the loops of c1 and c2 to move again",
		() => ticks("c1") > conv("c1").atPause && ticks("c2") > conv("c2").atPause,
		15_000,
	);
	check(
		"new.c1.tick-continues",
		ticks("c1") > conv("c1").atPause,
		`the tool process went on from where it was frozen: c1 ${conv("c1").atPause}→${ticks("c1")}, c2 ${conv("c2").atPause}→${ticks("c2")}`,
	);
	const requests = () => (backend as StubScripted).requests;
	await until(
		"c1's interrupted turn to end",
		() => agentEnds(c1.liveId) >= 1 && requests().some((r) => r.text.includes("UPGRADE-DONE-c1") && r.toolResults >= 1),
		60_000,
	);
	check(
		"new.c1.interrupted-turn-finishes",
		true,
		`the tool printed UPGRADE-DONE-c1 (ticks ${ticks("c1")}), the provider got its result, agent_end came through the new server`,
	);
	await until(
		"c2's subagent to complete",
		() => requests().some((r) => r.text.includes("UPGRADE-DONE-c2") && r.toolResults >= 1),
		60_000,
	);
	const statuses = [
		...new Set(
			frames2
				.filter((f) => f.liveId === c2.liveId && f.frame.type === "subagent_lifecycle")
				.map((f) => f.frame.payload?.status),
		),
	];
	check(
		"new.c2.subagent-finishes",
		requests().some((r) => r.text.includes(NESTED) && r.text.includes("UPGRADE-DONE-c2")),
		`the subagent's tool printed UPGRADE-DONE-c2 (ticks ${ticks("c2")}); lifecycle statuses seen: ${statuses.join(",")}`,
	);
	const idle = async (liveId: string) => {
		let quiet = 0;
		await until(
			`${liveId.slice(0, 8)} to be idle`,
			async () => {
				quiet = (await rpc<{ isStreaming?: boolean }>(ws2, liveId, { type: "get_state" })).isStreaming ? 0 : quiet + 1;
				return quiet >= 3;
			},
			60_000,
			700,
		);
	};
	for (const c of [c1, c2, c4]) await idle(c.liveId);
	const goalAfter = (await rpc<{ goal?: Goal | null }>(ws2, c2.liveId, { type: "goal", op: "get" })).goal;
	check(
		"new.c2.goal-survives",
		goalAfter?.objective === goalBefore?.objective,
		`goal after resume: ${JSON.stringify(goalAfter)?.slice(0, 140)}`,
	);

	// A new message after the resume works on all three.
	for (const t of ADOPTED) {
		const c = conv(t);
		const before = agentEnds(c.liveId);
		await rpc(ws2, c.liveId, { type: "prompt", message: `[${t}:next] one more` });
		await until(
			`${t}'s new turn to end`,
			() => agentEnds(c.liveId) > before && requests().some((r) => r.text.includes(`[${t}:next]`)),
			60_000,
		);
		const entries = JSON.stringify(await rpc(ws2, c.liveId, { type: "get_entries" }).catch(() => null));
		check(
			`new.${t}.new-message-works`,
			entries.includes(`NEXT-OK-${t}`),
			`the turn ended, the reply NEXT-OK-${t} is in omp's entries`,
		);
	}

	// c3: no process is left, so it opens as an ordinary conversation from its session file.
	const reopened = await request<LiveRow>(ws2, {
		t: "open",
		target: { kind: "resume", sessionFile: lost.sessionFile, cwd: work },
	});
	strays.add(reopened.pid as number);
	check(
		"new.c3.opens-as-ordinary",
		reopened.pid !== lost.omp &&
			reopened.pausedAt === null &&
			reopened.exited === false &&
			reopened.sessionFile !== null,
		`new omp ${reopened.pid} (was ${lost.omp}), pausedAt ${reopened.pausedAt}, session ${reopened.sessionId}`,
	);
	await request(ws2, { t: "approval_mode", liveId: reopened.liveId, mode: "yolo" });
	const beforeC3 = agentEnds(reopened.liveId);
	await rpc(ws2, reopened.liveId, { type: "prompt", message: "[c3:next] one more" });
	await until("c3's new turn to end", () => agentEnds(reopened.liveId) > beforeC3, 60_000);
	const entries3 = JSON.stringify(await rpc(ws2, reopened.liveId, { type: "get_entries" }).catch(() => ""));
	check(
		"new.c3.new-message-works",
		entries3.includes("NEXT-OK-c3") && entries3.includes("[c3:start]"),
		"the reopened conversation holds its earlier message and answers the new one",
	);

	// ---- the end: close everything, quit the new server, nothing may be left
	for (const liveId of [c1.liveId, c2.liveId, c4.liveId, reopened.liveId])
		await request(ws2, { t: "close", liveId }).catch(() => {});
	await Bun.sleep(3000);
	ws2.close();
	kill(newServer.pid, "SIGTERM");
	await until("the new server to exit", () => !alive(newServer.pid), 15_000).catch(() => {});
	kill(newServer.appPid, "SIGTERM");
	await Bun.sleep(1500);
	const left = procs().filter((p) => strays.has(p.pid) || (p.command.includes(root) && p.pid !== process.pid));
	check(
		"end.no-orphans",
		left.length === 0,
		left.length
			? left.map((p) => `${p.pid} ${p.stat} ${p.command.slice(0, 100)}`).join(" | ")
			: "no omp, relay, tool or server of this world is running",
	);
	check("end.new-server-exited", !alive(newServer.pid), `new server pid ${newServer.pid}`);
	const records = existsSync(join(data, "parked")) ? readdirSync(join(data, "parked")) : [];
	check("end.no-records-left", records.length === 0, records.join(",") || "no record left");
	check(
		"end.overlays-removed",
		[...convs.values()].every((c) => c.overlay !== null && !existsSync(c.overlay)),
		"no overlay file of the four conversations is left once they are closed",
	);

	/** What a user gets when a release breaks one of the contracts adoption depends on. Passes when the failure is the predicted one. */
	async function mismatch(
		which: string,
		o: { newPort: number; newToken: string; swapAt: number; newLog: string; ctx: Context },
	): Promise<void> {
		const took = Date.now() - o.swapAt;
		const listedNow = await listing(o.newPort, o.newToken);
		const all = [...convs.values()];
		const where = (c: Conv) =>
			`${c.tag}: omp ${alive(c.omp) ? (frozen(c.omp) ? "frozen" : "running") : "gone"}, relay ${alive(c.relay) ? "up" : "gone"}, tool processes alive ${c.tools.filter(alive).length}/${c.tools.length}`;
		log(
			`${which} mismatch: the new server was ready ${took} ms after the app quit; lives = [${listedNow.map((l) => l.liveId).join(",")}]\n    ${all.map(where).join("\n    ")}`,
		);
		log(
			`new server log (omp-webui lines):\n${o.newLog
				.split("\n")
				.filter((l) => l.startsWith("omp-webui"))
				.map((l) => `    ${l}`)
				.join("\n")}`,
		);
		const left = existsSync(join(data, "parked")) ? readdirSync(join(data, "parked")) : [];
		check(
			`demo.${which}.none-adopted`,
			listedNow.length === 0,
			`lives = ${listedNow.length}: none of the ${all.length} paused conversations is listed, paused or otherwise`,
		);
		if (which === "version") {
			check(
				"demo.version.frozen-orphans-left",
				all.every((c) => alive(c.omp) && frozen(c.omp) && alive(c.relay)) && left.length === all.length,
				`every omp stays frozen behind its relay with nobody to adopt it; ${left.length} records stay on disk`,
			);
			check(
				"demo.version.startup-waits-then-logs",
				took >= 5500 && /still run/.test(o.newLog),
				`ready ${took} ms after the quit (the 6 s ORPHAN_WAIT_MS), and logged: ${o.newLog
					.split("\n")
					.find((l) => /still run/.test(l))
					?.slice(0, 120)}`,
			);
		} else {
			check(
				"demo.frames.paused-work-destroyed",
				all.every((c) => !alive(c.omp) && !alive(c.relay) && c.tools.every((p) => !alive(p))) && left.length === 0,
				"adoption failed, so every frozen omp, its tool and its relay were ended and the records removed",
			);
			check(
				"demo.frames.logged",
				/could not take over the kept conversation/.test(o.newLog),
				o.newLog
					.split("\n")
					.find((l) => /could not take over/.test(l))
					?.slice(0, 160) ?? "",
			);
		}
		check(
			`demo.${which}.tool-never-finishes`,
			ticks("c1") < TICKS_TO_RUN && ticks("c1") === conv("c1").atPause,
			`c1's loop stopped at tick ${ticks("c1")} of ${TICKS_TO_RUN} and will not finish`,
		);
		const ws = await connect({ url: `http://127.0.0.1:${o.newPort}`, accessToken: o.newToken });
		const opened = await request<LiveRow>(ws, {
			t: "open",
			target: { kind: "resume", sessionFile: conv("c1").sessionFile, cwd: work },
		});
		strays.add(opened.pid as number);
		check(
			`demo.${which}.session-opens-as-ordinary`,
			opened.pausedAt === null && opened.pid !== conv("c1").omp,
			`opening c1's session starts a new omp ${opened.pid} (paused: ${opened.pausedAt}); the old omp ${conv("c1").omp} is ${alive(conv("c1").omp) ? "still there, frozen" : "gone"}`,
		);
		const history = await (
			await fetch(`http://127.0.0.1:${o.newPort}/api/sessions`, { headers: { "x-omp-webui-token": o.newToken } })
		).json();
		check(
			`demo.${which}.session-in-history`,
			JSON.stringify(history).includes(String(conv("c1").sessionId)),
			`the conversation is in the sidebar's history as an ordinary saved one (session ${conv("c1").sessionId})`,
		);
		if (which === "version") {
			// The next launch: the records and the frozen orphans are still there, so the wait and the log come again.
			ws.close();
			kill(newServer.pid, "SIGTERM");
			await until("the first new server to exit", () => !alive(newServer.pid), 15_000);
			const again = launchServer(o.ctx, "new2");
			launched.push(again);
			const t2 = Date.now();
			await readyPort(o.ctx, "new2");
			const second = Date.now() - t2;
			check(
				"demo.version.every-launch-waits-again",
				second >= 5500 && /still run/.test(readFileSync(join(logs, "new2-server.log"), "utf8")),
				`a second launch took ${second} ms to be ready and logged the same orphans: the wait comes back on every start until the orphans are killed by hand`,
			);
		}
	}
}
