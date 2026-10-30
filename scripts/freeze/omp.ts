#!/usr/bin/env bun
/**
 * A stand-in for `omp --mode rpc-ui` for the long-run harness (scripts/freeze/run.ts): no model, but it behaves the way
 * a busy omp does as far as the web UI's server can tell. While a turn runs it streams text deltas at a high rate,
 * runs tools, runs subagents (their frames and their transcript files), and appends entries to its session file the
 * way omp does (one line per finished message, taken from a pool of real lines so their sizes are real). It answers
 * every command at once, and writes the time each command was read from stdin to a log, so the harness can tell how
 * long a prompt or an abort took to reach omp.
 *
 * Settings come from the JSON file named by FREEZE_OMP (see `Settings`).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";

interface Settings {
	/** Where the time each command was read is appended (one JSON line per command). */
	recvLog: string;
	/** Lines of real entries (one JSON object per line) that finished messages are taken from. */
	pool: string;
	/** Milliseconds between two text deltas of the main agent. */
	deltaMs: number;
	/** Milliseconds between two entries the session file gets while a turn runs. */
	entryMs: number;
	/** How long one turn lasts; a goal-mode conversation starts the next one at once. */
	turnMs: number;
	/** The subagents each session runs while a turn does (by the session file's name), each streaming `subagentDeltaMs` apart and writing its transcript every `subagentEntryMs`. */
	subagents: Record<string, string[]>;
	subagentDeltaMs: number;
	subagentEntryMs: number;
	/** What a subagent's message has already in it when it starts streaming: a snapshot (`partial`) is the whole message so far, which in omp is tens of KB. */
	subagentSnapshotBytes?: number;
	/** Whether to begin a turn at startup (a conversation that was streaming when the page attached). */
	autostart: boolean;
	/** Answer `get_entries` from a cached text, a chunk per event-loop turn (see `answerPaced`). */
	entriesPaced?: boolean;
}

const settings: Settings = JSON.parse(readFileSync(process.env.FREEZE_OMP ?? "", "utf8"));
/** Written at once, or after the chunks of an answer that is being written one by one (see `answerPaced`). */
const emit = (line: string) => {
	if (sending) heldFrames.push(line);
	else process.stdout.write(line);
};
const out = (o: unknown) => emit(`${JSON.stringify(o)}\n`);
const nowMs = () => performance.timeOrigin + performance.now();
/** Set once the server asks for protocol 2: an answer larger than a frame may then go out in `rpc_chunk`s, as omp's do. */
let v2 = false;
let chunks = 0;
/** The number of the text delta being sent: a tab that was not reading sees what it lost as a gap. */
let frameSeq = 0;
// omp's chunks are 256 KiB of the document.
const CHUNK_BYTES = 256 * 1024;

/** Answer command `id`; a large answer, when the server speaks protocol 2, is cut into base64 chunks of one JSON document. */
function respond(id: unknown, command: string, data: unknown): void {
	const text = JSON.stringify({ id, type: "response", command, success: true, data });
	if (!v2 || text.length < 900_000) {
		emit(`${text}\n`);
		return;
	}
	const bytes = Buffer.from(text);
	const count = Math.ceil(bytes.length / CHUNK_BYTES);
	const chunkId = `c${chunks++}`;
	for (let index = 0; index < count; index++) {
		const part = bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
		out({ type: "rpc_chunk", chunkId, index, count, byteLength: bytes.length, data: part.toString("base64") });
	}
}

let sending = false;
const heldFrames: string[] = [];
let answering: Promise<void> = Promise.resolve();

/** What `get_entries` without `since` has as `data`, written from the session file's lines without reading them into objects, once. */
let entriesText: string | null = null;
function wholeEntries(): string {
	if (entriesText !== null) return entriesText;
	const lines = readFileSync(sessionFile, "utf8")
		.split("\n")
		.filter(
			(l) =>
				l.startsWith("{") && l.endsWith("}") && !l.startsWith('{"type":"session"') && !l.startsWith('{"type":"title"'),
		);
	const leafId = lines.length ? (JSON.parse(lines[lines.length - 1] as string) as { id?: string }).id : null;
	entriesText = `{"entries":[${lines.join(",")}],"leafId":${JSON.stringify(leafId ?? null)}}`;
	return entriesText;
}

/**
 * Answer command `id` with `dataText` (already JSON), cut into `rpc_chunk`s of omp's size and written one per turn of the event loop, so
 * that the commands that arrive meanwhile are read at once. Nothing may come between the chunks of one answer (the server drops a
 * sequence that is interrupted): other frames wait until the last chunk is out.
 */
function answerPaced(id: unknown, command: string, dataText: string): void {
	const text = `{"id":${JSON.stringify(id)},"type":"response","command":${JSON.stringify(command)},"success":true,"data":${dataText}}`;
	answering = answering.then(async () => {
		const bytes = Buffer.from(text);
		const count = Math.ceil(bytes.length / CHUNK_BYTES);
		const chunkId = `c${chunks++}`;
		sending = true;
		for (let index = 0; index < count; index++) {
			const part = bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
			process.stdout.write(
				`${JSON.stringify({ type: "rpc_chunk", chunkId, index, count, byteLength: bytes.length, data: part.toString("base64") })}\n`,
			);
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		sending = false;
		for (const line of heldFrames.splice(0)) process.stdout.write(line);
	});
}

/** What `get_entries` answers: the entries of the session file as they are now, after `since` when it names one. */
function entriesOf(since: unknown): { entries: unknown[]; leafId: string | null } {
	if (!existsSync(sessionFile)) return { entries: [], leafId: null };
	const entries: { id: string }[] = [];
	for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
		if (!line) continue;
		try {
			const o = JSON.parse(line);
			if (typeof o.id === "string" && o.type !== "session") entries.push(o);
		} catch {
			// a line being written
		}
	}
	const from = typeof since === "string" ? entries.findIndex((e) => e.id === since) + 1 : 0;
	return { entries: entries.slice(from), leafId: entries.at(-1)?.id ?? null };
}

if (!process.argv.includes("--mode")) {
	console.log("fake-omp 0.0.0");
	process.exit(0);
}

const resumeAt = process.argv.indexOf("--resume");
const sessionFile = resumeAt >= 0 ? (process.argv[resumeAt + 1] as string) : "/nonexistent/fake.jsonl";
const sessionId = basename(sessionFile).replace(/\.jsonl$/, "");

interface PoolEntry {
	message?: { role?: string; toolName?: string; content?: unknown };
	[key: string]: unknown;
}
const pool: PoolEntry[] = readFileSync(settings.pool, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((l) => JSON.parse(l));
let poolAt = 0;
let lastId: string | null = null;
let counter = 0;
const nextId = () => `f${process.pid.toString(36)}${(counter++).toString(36)}`;

/** The next real entry of the pool, with an id and a time of its own. */
function entryLine(parent: string | null): { id: string; line: string; entry: PoolEntry } {
	const entry = pool[poolAt++ % pool.length] as PoolEntry;
	const id = nextId();
	return {
		id,
		entry,
		line: `${JSON.stringify({ ...entry, id, parentId: parent, timestamp: new Date().toISOString() })}\n`,
	};
}

/** A message finished: its entry is appended to the session file, and the frame that says so goes out, as omp does it. */
function finishMessage(): void {
	const { id, line, entry } = entryLine(lastId);
	lastId = id;
	if (existsSync(sessionFile)) appendFileSync(sessionFile, line);
	const message = entry.message;
	if (message?.role === "toolResult")
		out({
			type: "tool_execution_end",
			toolCallId: id,
			toolName: message.toolName ?? "bash",
			result: { content: message.content },
		});
	else out({ type: "message_end", message });
}

const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa"];
let streaming = false;
let turnTimers: NodeJS.Timeout[] = [];
let turnEnd: NodeJS.Timeout | undefined;

const artifacts = sessionFile.replace(/\.jsonl$/, "");

function startTurn(): void {
	if (streaming) return;
	streaming = true;
	out({ type: "agent_start" });
	let n = 0;
	turnTimers.push(
		setInterval(() => {
			const delta = `${words[n++ % words.length]} `;
			out({
				type: "message_update",
				n: ++frameSeq,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
			});
		}, settings.deltaMs),
	);
	turnTimers.push(
		setInterval(() => {
			out({ type: "tool_execution_start", toolCallId: `c${n}`, toolName: "bash", args: { command: "ls" } });
			finishMessage();
		}, settings.entryMs),
	);
	const ids = settings.subagents[basename(sessionFile)] ?? [];
	if (ids.length > 0) {
		mkdirSync(artifacts, { recursive: true });
		for (const [i, id] of ids.entries()) {
			const file = `${artifacts}/${id}.jsonl`;
			let last: string | null = null;
			const base = "snapshot ".repeat(Math.ceil((settings.subagentSnapshotBytes ?? 0) / 9));
			let partial = base;
			out({ type: "subagent_lifecycle", payload: { id, status: "running" } });
			turnTimers.push(
				setInterval(() => {
					partial += `${words[(n + i) % words.length]} `;
					out({
						type: "subagent_event",
						payload: {
							id,
							event: {
								type: "message_update",
								assistantMessageEvent: {
									type: "text_delta",
									partial: { role: "assistant", content: [{ type: "text", text: partial }] },
								},
							},
						},
					});
				}, settings.subagentDeltaMs),
			);
			turnTimers.push(
				setInterval(() => {
					const e = entryLine(last);
					last = e.id;
					appendFileSync(file, e.line);
					partial = base;
					out({ type: "subagent_event", payload: { id, event: { type: "message_end" } } });
				}, settings.subagentEntryMs),
			);
		}
	}
	turnEnd = setTimeout(() => endTurn(true), settings.turnMs);
}

function endTurn(continues: boolean): void {
	for (const t of turnTimers) clearInterval(t);
	turnTimers = [];
	clearTimeout(turnEnd);
	turnEnd = undefined;
	if (!streaming) return;
	streaming = false;
	out({ type: "agent_end", isTerminal: !continues });
	if (continues) setTimeout(startTurn, 50);
	else out({ type: "session_settled" });
}

out({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2] });
if (settings.autostart) setTimeout(startTurn, 200);

let buf = "";
for await (const chunk of Bun.stdin.stream()) {
	buf += new TextDecoder().decode(chunk);
	for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
		const read = nowMs();
		const cmd = JSON.parse(buf.slice(0, nl));
		buf = buf.slice(nl + 1);
		appendFileSync(
			settings.recvLog,
			`${JSON.stringify({ id: cmd.id, type: cmd.type, probe: cmd.probe ?? null, at: read, pid: process.pid })}\n`,
		);
		let data: unknown = {};
		if (cmd.type === "negotiate_protocol") v2 = cmd.protocolVersion === 2;
		if (cmd.type === "get_state") data = { sessionFile, sessionId, isStreaming: streaming };
		else if (cmd.type === "get_entries" && settings.entriesPaced && typeof cmd.since !== "string") {
			// omp's own cost of building such an answer (200-280 ms on the real one, which answers nothing else meanwhile) is not
			// this stand-in's: what a run measures is then what the server adds.
			answerPaced(cmd.id, cmd.type, wholeEntries());
			continue;
		} else if (cmd.type === "get_entries") data = entriesOf(cmd.since);
		else if (cmd.type === "get_subagents") data = { subagents: [] };
		respond(cmd.id, cmd.type, data);
		if (cmd.type === "abort" || cmd.type === "abort_and_restore_queue") endTurn(false);
		else if (cmd.type === "prompt") startTurn();
	}
}
