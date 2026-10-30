import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A scripted stand-in for `omp --mode rpc-ui` that serves what the web UI hands omp besides commands: a
 * per-process settings overlay (`--config`, last) and host tools. It needs neither the real omp nor a model.
 *
 * - `omp config get tools.approvalMode` prints `options.configured` (and fails without it).
 * - The rpc loop appends every line it receives, and its own argv, to `log` as JSON lines
 *   (`{ argv }`, `{ in: <frame> }`), so a test can see exactly what reached omp.
 * - A `prompt` whose message is `call` makes it send a `propose_goal` host tool call (id `h1`); `cancel` sends
 *   the matching `host_tool_cancel`. Every command is answered with success.
 * - A `prompt` whose message is `tool <name> [<json>]` makes it call that host tool with those arguments (ids `ht1`,
 *   `ht2`…, as omp numbers its calls); once it was given tools (`set_host_tools`), `get_state` lists them as `dumpTools`.
 *   An `emit_frames` command makes it send the frames it lists. `answer_next_with` (`command`, `frames`, `state`) makes it
 *   answer the next `command` (with `state` added to what it says) and write the frames right after the answer in the same
 *   write, so that both reach the server in one read.
 * - A `prompt` whose message is `stream` starts a turn and leaves its reply half written (message `m1`: a text block
 *   "The quick " and "brown fox", as increments); `finish` writes the rest and ends the turn (`session_settled` too).
 * - `fork`, `branch` and `new_session` move it to a session file of its own (`<file>-<n>.jsonl`), as omp does, unless the
 *   command says `cancel: true` (a cancelled fork answers success and moves nothing); `switch_session` and `open_session` move it
 *   to `sessionPath`; a `prompt` of `/move <file>` moves it to that file (omp's own slash command). `get_state` says where
 *   it is. `goal get` answers with `options.goal` (a goal's status), else none.
 * - A `bash` command whose `command` starts with `hold` is not answered until a `release_bash` command arrives (then each
 *   such `bash` is answered with exit code 0), as omp answers a `!command` only when it exits.
 */
export interface FakeHostOmpOptions {
	configured?: string;
	goal?: string;
}

/** Write the fake into `dir`; the returned path is usable as `OMP_BIN`. */
export function writeFakeHostOmp(dir: string, log: string, options: FakeHostOmpOptions = {}): string {
	const script = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const options = ${JSON.stringify(options)};
const log = ${JSON.stringify(log)};
if (process.argv[2] === "config") {
  if (options.configured) { process.stdout.write(options.configured + "\\n"); process.exit(0); }
  process.exit(1);
}
// Any other run without --mode (the server asks for --version): answer and go, as omp does.
if (!process.argv.includes("--mode")) {
  console.log("fake-host-omp 0.0.0");
  process.exit(0);
}
const note = (o) => appendFileSync(log, JSON.stringify(o) + "\\n");
note({ argv: process.argv.slice(2) });
const resumeAt = process.argv.indexOf("--resume");
let sessionFile = resumeAt >= 0 ? process.argv[resumeAt + 1] : "/nonexistent/fake.jsonl";
let moves = 0;
let hostTools = null;
let together = null;
let calls = 0;
let heldBash = [];
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2] });
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(chunk);
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const cmd = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    note({ in: cmd });
    if (cmd.type === "bash" && String(cmd.command).startsWith("hold")) { heldBash.push(cmd.id); continue; }
    if (cmd.type === "release_bash") for (const id of heldBash.splice(0)) out({ id, type: "response", command: "bash", success: true, data: { exitCode: 0 } });
    if (cmd.type === "host_tool_result" || cmd.type === "extension_ui_response") continue;
    if (cmd.type === "set_host_tools") hostTools = Array.isArray(cmd.tools) ? cmd.tools.map((t) => t.name) : [];
    if (cmd.type === "emit_frames") for (const f of cmd.frames) out(f);
    if (cmd.type === "answer_next_with") together = { command: cmd.command, frames: cmd.frames, state: cmd.state ?? {} };
    if (["fork", "branch", "new_session"].includes(cmd.type) && cmd.cancel !== true) sessionFile = sessionFile.replace(/(-\\d+)?\\.jsonl$/, "") + "-" + ++moves + ".jsonl";
    if (["switch_session", "open_session"].includes(cmd.type) && typeof cmd.sessionPath === "string") sessionFile = cmd.sessionPath;
    if (cmd.type === "prompt" && typeof cmd.message === "string" && cmd.message.startsWith("/move ")) sessionFile = cmd.message.slice(6);
    const data =
      cmd.type === "get_state"
        ? { sessionFile, sessionId: "fake", isStreaming: false, ...(hostTools ? { dumpTools: hostTools.map((name) => ({ name })) } : {}) }
        : cmd.type === "goal" && cmd.op === "get"
          ? { goal: options.goal ? { id: "g", objective: "x", status: options.goal } : null }
          : cmd.type === "get_entries"
            ? { entries: [], leafId: null }
            : cmd.type === "get_available_commands"
              ? { commands: [] }
              : cmd.type === "get_subagents"
                ? { subagents: [] }
                : {};
    const answer = (extra) => JSON.stringify({ id: cmd.id, type: "response", command: cmd.type, success: true, data: { ...data, ...extra } }) + "\\n";
    if (together && together.command === cmd.type) {
      process.stdout.write(answer(together.state) + together.frames.map((f) => JSON.stringify(f) + "\\n").join(""));
      together = null;
    } else process.stdout.write(answer({}));
    if (cmd.type === "prompt" && cmd.message === "call") {
      out({
        type: "host_tool_call",
        id: "h1",
        toolCallId: "t1",
        toolName: "propose_goal",
        arguments: { objective: "Ship it", acceptance_criteria: ["It ships"], token_budget: 50000 },
      });
    }
    if (cmd.type === "prompt" && cmd.message === "cancel") out({ type: "host_tool_cancel", id: "c1", targetId: "h1" });
    const toolCall = cmd.type === "prompt" && typeof cmd.message === "string" ? /^tool (\\S+)(?: (.*))?$/.exec(cmd.message) : null;
    if (toolCall) {
      calls++;
      out({ type: "host_tool_call", id: "ht" + calls, toolCallId: "tc" + calls, toolName: toolCall[1], arguments: toolCall[2] ? JSON.parse(toolCall[2]) : {} });
    }
    const delta = (type, extra) => out({ type: "message_update", messageId: "m1", message: { role: "assistant" }, assistantMessageEvent: { type, contentIndex: 0, ...extra } });
    if (cmd.type === "prompt" && cmd.message === "stream") {
      out({ type: "agent_start" });
      out({ type: "message_start", messageId: "m1", message: { role: "assistant", content: [], timestamp: 5 } });
      delta("text_start", {});
      delta("text_delta", { delta: "The quick " });
      delta("text_delta", { delta: "brown fox" });
    }
    if (cmd.type === "prompt" && cmd.message === "finish") {
      delta("text_end", { content: "The quick brown fox jumps" });
      out({ type: "message_end", messageId: "m1", message: { role: "assistant", content: [{ type: "text", text: "The quick brown fox jumps" }], timestamp: 5 } });
      out({ type: "agent_end", isTerminal: true });
      out({ type: "session_settled" });
    }
  }
}
`;
	const bin = join(dir, "omp");
	writeFileSync(bin, script);
	chmodSync(bin, 0o755);
	return bin;
}
