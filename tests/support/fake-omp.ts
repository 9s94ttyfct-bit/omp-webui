import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../server/config.ts";
import { trackRelayDir } from "./relay-dirs.ts";

/**
 * A scripted stand-in for `omp --mode rpc-ui`, for tests of server code that need a process to
 * manage but neither the real omp nor a model. It answers every command with success (`get_state`
 * names the session file it was started with `--resume`) and exits with code 0 when its stdin
 * closes (and sends the frames an `emit_frames` command lists; `set_state` with `subagents` is what `get_subagents` lists). Runs under Bun.
 */
export interface FakeOmpOptions {
	/** Keep a child process (`sleep`) running under it, like a tool omp started. */
	tool?: boolean;
	/** The tool runs in a session of its own, as omp's tool processes do: killing omp's process group misses it. */
	toolDetached?: boolean;
	/** Never answer `get_state`: the process stays "starting" until it is closed. */
	holdState?: boolean;
	/** Never answer these commands: they stay in flight, so the process counts as busy (omp does the same while a `!command` runs). */
	hold?: string[];
	/** Answer these commands this many milliseconds late (a command that takes a while, like `compact`). */
	delay?: Record<string, number>;
	/** Start another tool (`sleep`) under it when this command arrives, like omp running a tool for a turn. */
	spawnOn?: string;
	/** Keep running when stdin closes, as omp does while it is working. */
	ignoreClose?: boolean;
	/** Take this many milliseconds to end once stdin closes (omp writing its last entries before it goes). */
	slowClose?: number;
	/** A terminal run that opens an old conversation (`--resume`, `-c`…, without `--mode`) stays until it is killed, as omp's screen does. */
	terminalHolds?: boolean;
	/** Ignore SIGTERM: only SIGKILL ends it. */
	ignoreTerm?: boolean;
	/** Exit with an error at startup when one of these appears on its command line. */
	failWhenArgs?: string[];
	/** `get_state` says a turn is in progress. */
	streaming?: boolean;
	/** What `get_state` reports besides the session file and the streaming flag (the system prompt, the tools). */
	state?: Record<string, unknown>;
	/** The models `get_available_models` lists (the guard's benchmark chooses its reviewer among them). */
	models?: { provider: string; id: string; api?: string; cost?: { input?: number; output?: number } }[];
	/** What `omp config list` and `omp config get` say (`modelRoles`, `retry.fallbackChains`…), by key. */
	settings?: Record<string, unknown>;
	/**
	 * What `omp -p` (print mode, without `--mode`) does, as the guard's benchmark asks its reviewer: appends its arguments to
	 * `log` (one JSON line each), waits `delayMs`, and answers a deny when the message (the last argument) contains one of
	 * `deny`, an allow otherwise. It never runs anything.
	 */
	review?: { log?: string; delayMs?: number; deny?: string[]; reason?: string };
}

/** Write the fake into `dir` and return its path (usable as `OMP_BIN`). */
export function writeFakeOmp(dir: string, options: FakeOmpOptions = {}): string {
	const script = `#!/usr/bin/env bun
const options = ${JSON.stringify(options)};
// Plain commands the server runs besides the RPC process (--version, config get): answer and exit.
if (!process.argv.includes("--mode")) {
  if (options.review && process.argv.includes("-p")) {
    const argv = process.argv.slice(2);
    if (options.review.log) require("node:fs").appendFileSync(options.review.log, JSON.stringify({ argv, cwd: process.cwd() }) + "\\n");
    if (options.review.delayMs) await Bun.sleep(options.review.delayMs);
    const user = argv[argv.length - 1];
    const deny = (options.review.deny ?? []).some((s) => user.includes(s));
    console.log(deny ? JSON.stringify({ decision: "deny", reason: options.review.reason ?? "the fake reviewer denies this" }) : JSON.stringify({ decision: "allow" }));
    process.exit(0);
  }
  // omp config list --json and omp config get KEY --json, as omp prints them: each key with its value, and the value.
  if (process.argv[2] === "config" && ["list", "get"].includes(process.argv[3])) {
    const settings = options.settings ?? {};
    if (process.argv[3] === "list") console.log(JSON.stringify(Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, { value: v }]))));
    else console.log(JSON.stringify({ value: settings[process.argv[4]] }));
    process.exit(0);
  }
  console.log("fake-omp 0.0.0");
  if (options.terminalHolds && process.argv.some((a) => ["--resume", "-r", "-c", "--continue"].includes(a))) await Promise.withResolvers().promise;
  process.exit(0);
}
const failing = (options.failWhenArgs ?? []).find((a) => process.argv.includes(a));
if (failing) {
  process.stderr.write("error: Could not restore model " + failing + "\\n");
  process.exit(1);
}
if (options.ignoreTerm) process.on("SIGTERM", () => {});
const tool = options.tool ? Bun.spawn(["sleep", "600"], { stdio: ["ignore", "ignore", "ignore"], detached: Boolean(options.toolDetached) }) : null;
const resumeAt = process.argv.indexOf("--resume");
const sessionFile = resumeAt >= 0 ? process.argv[resumeAt + 1] : "/nonexistent/fake.jsonl";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const reported = {};
let subagents = [];
out({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2] });
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(chunk);
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const cmd = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    if (cmd.type === "get_state" && options.holdState) continue;
    if ((options.hold ?? []).includes(cmd.type)) continue;
    if (cmd.type === "get_available_models") {
      out({ id: cmd.id, type: "response", command: cmd.type, success: true, data: { models: options.models ?? [] } });
      continue;
    }
    // A test's way to make omp send frames of its own: an emit_frames command lists them (afterMs: later, on its own;
    // marker: a file created once they are all written, for a test to know that they were).
    if (cmd.type === "emit_frames") {
      const emit = () => {
        for (const f of cmd.frames) out(f);
        if (cmd.marker) require("node:fs").writeFileSync(cmd.marker, "");
      };
      if (cmd.afterMs) setTimeout(emit, cmd.afterMs); else emit();
    }
    // emit_bulk: count frames {type:"bulk", n, pad} of about bytes each, written one after another, each waiting until
    // the pipe has taken it (a reader that stops reading stops omp here, as it stops a real omp). progress: a file that
    // gets a byte as each frame has been taken, for a test to see how far omp got; marker: a file created once all were;
    // afterMs: start that much later, on its own (a test can end its connection first).
    if (cmd.type === "emit_bulk") {
      const emit = async () => {
        const fs = require("node:fs");
        const pad = "x".repeat(cmd.bytes);
        for (let n = 0; n < cmd.count; n++) {
          const taken = Promise.withResolvers();
          process.stdout.write(JSON.stringify({ type: "bulk", n, pad }) + "\\n", taken.resolve);
          await taken.promise;
          if (cmd.progress) fs.appendFileSync(cmd.progress, ".");
        }
        if (cmd.marker) fs.writeFileSync(cmd.marker, "");
      };
      setTimeout(emit, cmd.afterMs ?? 0);
    }
    // A set_state command changes what get_state reports from then on (isSettled, hasPendingAsyncWork, isCompacting…).
    // \`subagents\` is what get_subagents lists, not part of the state.
    if (cmd.type === "set_state") {
      const { subagents: listed, ...rest } = cmd.state;
      if (listed) subagents = listed;
      Object.assign(reported, rest);
    }
    // set_model switches the model get_state reports from then on, and is answered with the model, as omp does.
    if (cmd.type === "set_model") reported.model = { id: cmd.modelId, name: cmd.modelId, provider: cmd.provider, api: "anthropic-messages", reasoning: true, contextWindow: 200000 };
    // omp answers set_cache_warming with the mode the process runs in, and get_entries with the conversation's entries (none yet).
    const data = cmd.type === "get_state" ? { ...(options.state ?? {}), ...reported, sessionFile, sessionId: "fake", isStreaming: Boolean(options.streaming) } : cmd.type === "get_subagents" ? { subagents } : cmd.type === "get_entries" ? { entries: [], leafId: null } : cmd.type === "set_cache_warming" ? { mode: cmd.mode } : cmd.type === "set_model" ? reported.model : {};
    const reply = { id: cmd.id, type: "response", command: cmd.type, success: true, data };
    if (options.spawnOn === cmd.type) Bun.spawn(["sleep", "600"], { stdio: ["ignore", "ignore", "ignore"] });
    const late = (options.delay ?? {})[cmd.type];
    if (late) setTimeout(() => out(reply), late);
    else out(reply);
  }
}
if (options.slowClose) await Bun.sleep(options.slowClose);
if (options.ignoreClose) await Promise.withResolvers().promise;
tool?.kill();
`;
	const bin = join(dir, "omp");
	writeFileSync(bin, script);
	chmodSync(bin, 0o755);
	return bin;
}

/** A server config whose omp is `ompBin` and whose directories are all `dir`. */
export function fakeConfig(dir: string, ompBin: string): Config {
	trackRelayDir(dir);
	return {
		ompBin,
		agentDir: dir,
		sessionsDir: dir,
		dataDir: dir,
		host: "127.0.0.1",
		port: 0,
		distDir: dir,
		autoPort: false,
		parentPid: null,
	};
}
