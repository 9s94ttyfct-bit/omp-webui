#!/usr/bin/env bun
/**
 * A stand-in for `omp --mode rpc-ui` that a test conducts, for the two-page spec (`tests/e2e/live-sync.spec.ts`): what
 * the pages show of a conversation that two of them watch. No model is called and nothing happens by itself: a turn
 * begins when a `prompt` arrives and goes on until the test says what omp does next.
 *
 * It answers the commands the pages send the way omp 18.12 does — what each changes in `get_state`, and which frames
 * omp sends for it (read off a real omp: `set_model` sends `model_changed` and `thinking_level_changed`; the other
 * settings change the state and send nothing) — and takes three commands of its own, sent through the server like any
 * other (see `conduct` in `two-pages.ts`):
 *
 * - `sync_emit { frames }`: print these frames. Frames that change what omp is (`agent_start`, `agent_end`, a
 *   `message_end`) change it here too: `get_state` says streaming, the entries and the session file follow the messages.
 * - `sync_state { patch }`: change what `get_state` reports (`todoPhases`, `contextUsage`, `usageLimit`…). `subagents` is
 *   what `get_subagents` lists.
 * - `sync_finish`: the turn ends as omp ends it (`agent_end`, `session_settled`), and the next queued message, steering
 *   first, becomes the next turn.
 *
 * Every line it receives is appended to `FAKE_OMP_LOG` (one JSON object per line, `{ in: <command> }`), so a test can
 * see exactly what reached omp (and that no `abort` did). Runs under Bun.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const argv = process.argv.slice(2);
// `omp config get <key>`: an omp with nothing configured prints what it uses when nothing says otherwise. For the approval
// mode that is `yolo` (what the server then starts a conversation in); for a key the specs do not care about it fails,
// which the server reads as "omp's own default". `omp config list --json` says what the session panel reads of the
// configuration (omp's defaults, and a Claude model among the roles), which is what its stars are filled against.
// `modelPresets` is the one key a spec writes (`omp config set`) and the server reads back: a file beside the agent
// directory's other files, so every process of the conversation sees what a page saved.
const presetsFile = join(process.env.PI_CODING_AGENT_DIR ?? dirname(process.argv[1] ?? "."), "sync-omp-presets.json");
const savedPresets = (): Record<string, unknown> => {
	try {
		return JSON.parse(readFileSync(presetsFile, "utf8"));
	} catch {
		return {};
	}
};
if (argv[0] === "config") {
	if (argv[1] === "get" && argv[2] === "modelPresets") {
		console.log(JSON.stringify({ value: savedPresets() }));
		process.exit(0);
	}
	if (argv[1] === "set" && argv[2] === "modelPresets") {
		writeFileSync(presetsFile, argv[3] ?? "{}");
		process.exit(0);
	}
	if (argv[1] === "get" && argv[2] === "tools.approvalMode") {
		console.log("yolo");
		process.exit(0);
	}
	if (argv[1] === "list" && argv.includes("--json")) {
		const value = (v: unknown) => ({ value: v });
		console.log(
			JSON.stringify({
				"compaction.enabled": value(true),
				"retry.enabled": value(true),
				steeringMode: value("one-at-a-time"),
				followUpMode: value("one-at-a-time"),
				interruptMode: value("immediate"),
				"providers.cacheWarming": value("idle"),
				"tier.anthropic": value("none"),
				"providers.anthropic.slowMode": value("off"),
				modelRoles: value({ default: "anthropic/claude-opus-5-5" }),
				modelPresets: value(savedPresets()),
			}),
		);
		process.exit(0);
	}
	process.exit(argv[1] === "get" ? 1 : 0);
}
if (!argv.includes("--mode")) {
	console.log("omp/18.12.6");
	process.exit(0);
}
const log = process.env.FAKE_OMP_LOG;
const note = (o: unknown) => {
	if (log) appendFileSync(log, `${JSON.stringify(o)}\n`);
};

const resumeAt = argv.indexOf("--resume");
const resumed = resumeAt >= 0 ? argv[resumeAt + 1] : null;
const sessionId = resumed?.match(/_([0-9a-f-]{36})\.jsonl$/)?.[1] ?? crypto.randomUUID();
// omp keeps a new conversation under its agent dir, in a folder named after the real path of the working folder (a
// test's temp dir is behind a symlink on macOS: the server compares real paths, so the file is named by its real one).
const agentDir = realpathSync(process.env.PI_CODING_AGENT_DIR ?? "/tmp");
const sessionFile =
	resumed ??
	join(
		agentDir,
		"sessions",
		`--${realpathSync(process.cwd()).slice(1).replaceAll("/", "-")}--`,
		`${new Date().toISOString().replaceAll(":", "-").replace(".", "-")}_${sessionId}.jsonl`,
	);

type Entry = { id: string; parentId: string | null; type: string; timestamp: string; [k: string]: unknown };
const entries: Entry[] = [];
let headerWritten = false;
if (resumed && existsSync(resumed)) {
	headerWritten = true;
	for (const line of readFileSync(resumed, "utf8").split("\n")) {
		if (!line) continue;
		const e = JSON.parse(line) as Entry;
		if (typeof e.id === "string" && e.type !== "session" && e.type !== "title") entries.push(e);
	}
}
let leaf: string | null = entries.at(-1)?.id ?? null;
let entrySeq = 0;
const unwritten: Entry[] = [];

const out = (o: unknown) => void process.stdout.write(`${JSON.stringify(o)}\n`);
const now = () => new Date().toISOString();

/** omp writes a new conversation's file with its first assistant message, not before. */
function persist(message: Record<string, unknown>): void {
	const entry: Entry = {
		type: "message",
		id: `e${(++entrySeq).toString(16).padStart(6, "0")}${sessionId.slice(0, 2)}`,
		parentId: leaf,
		timestamp: now(),
		message,
	};
	entries.push(entry);
	leaf = entry.id;
	if (!headerWritten) {
		if (message.role !== "assistant") {
			unwritten.push(entry);
			return;
		}
		mkdirSync(dirname(sessionFile), { recursive: true });
		writeFileSync(
			sessionFile,
			`${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: now(), cwd: process.cwd() })}\n`,
		);
		headerWritten = true;
		for (const held of unwritten.splice(0)) appendFileSync(sessionFile, `${JSON.stringify(held)}\n`);
	}
	appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
}

// ------------------------------------------------------------------ what omp is
const MODELS = [
	{
		id: "claude-opus-5-5",
		name: "Opus 5.5",
		provider: "anthropic",
		api: "anthropic-messages",
		reasoning: true,
		contextWindow: 1_000_000,
	},
	{
		id: "claude-sonnet-5-5",
		name: "Sonnet 5.5",
		provider: "anthropic",
		api: "anthropic-messages",
		reasoning: true,
		contextWindow: 1_000_000,
	},
	{
		id: "claude-haiku-5-5",
		name: "Haiku 5.5",
		provider: "anthropic",
		api: "anthropic-messages",
		reasoning: true,
		contextWindow: 200_000,
	},
];
const settings: Record<string, unknown> = {
	model: MODELS[0],
	thinkingLevel: "high",
	isCompacting: false,
	steeringMode: "one-at-a-time",
	followUpMode: "one-at-a-time",
	interruptMode: "immediate",
	autoCompactionEnabled: true,
	fastModeEnabled: false,
	fastModeActive: false,
	slowModeSupported: false,
	slowModeEnabled: false,
	todoPhases: [],
	hasPendingAsyncWork: false,
	contextUsage: { tokens: 120_000, contextWindow: 1_000_000, percent: 12 },
	sessionName: undefined,
};
let subagents: unknown[] = [];
let goal: Record<string, unknown> | null = null;
let streaming = false;
let settled = true;
const queue = { steering: [] as string[], followUp: [] as string[] };
let messageSeq = 0;
/** The `bash` commands that wait for their time, with how each is answered. */
const bashes = new Map<NodeJS.Timeout, (data?: unknown) => void>();

const queueUpdate = () =>
	out({ type: "queue_update", steering: [...queue.steering], followUp: [...queue.followUp], liveSteered: 0 });

const state = () => ({
	...settings,
	isStreaming: streaming,
	isSettled: settled && queue.steering.length + queue.followUp.length === 0,
	sessionFile,
	sessionId,
	messageCount: entries.filter((e) => e.type === "message").length,
	queuedMessageCount: queue.steering.length + queue.followUp.length,
	queuedMessages: { steering: [...queue.steering], followUp: [...queue.followUp], liveSteered: 0 },
	goal: { enabled: goal !== null, mode: goal ? "goal" : "none", goal },
	dumpTools: [],
});

/** What a frame omp prints does to omp itself. */
function emit(frame: Record<string, unknown>): void {
	if (frame.type === "agent_start") {
		streaming = true;
		settled = false;
	}
	if (frame.type === "agent_end" && frame.isTerminal !== false) streaming = false;
	if (frame.type === "session_settled") {
		streaming = false;
		settled = true;
	}
	if (frame.type === "goal_updated") goal = (frame.goal as Record<string, unknown> | null) ?? null;
	out(frame);
	if (frame.type === "message_end" && frame.message && typeof frame.message === "object")
		persist(frame.message as Record<string, unknown>);
}

/** A user's message starts a turn: omp announces it and the page shows it, then the test says what the model does. */
function startTurn(message: string): void {
	const user = {
		role: "user",
		content: [{ type: "text", text: message }],
		attribution: "user",
		timestamp: Date.now(),
	};
	const id = `msg-${++messageSeq}`;
	emit({ type: "agent_start" });
	emit({ type: "message_start", messageId: id, message: user });
	emit({ type: "message_end", messageId: id, message: user });
}

function finishTurn(): void {
	emit({ type: "agent_end", messages: [], isTerminal: true });
	const next = queue.steering.shift() ?? queue.followUp.shift();
	if (next === undefined) {
		emit({ type: "session_settled" });
		return;
	}
	queueUpdate();
	startTurn(next);
}

/** `sync_deaf` was sent: omp has stopped taking abort commands (answers none, ends nothing), as a process that hangs does. */
let deaf = false;

function handle(cmd: Record<string, unknown> & { id?: string; type: string }) {
	note({ in: cmd });
	const reply = (data: unknown = {}) => out({ id: cmd.id, type: "response", command: cmd.type, success: true, data });
	const fail = (error: string, code?: string) =>
		out({ id: cmd.id, type: "response", command: cmd.type, success: false, error, code });
	switch (cmd.type) {
		case "negotiate_protocol":
			return reply({ protocolVersion: 1 });
		case "get_state":
			return reply(state());
		case "get_entries": {
			if (typeof cmd.since === "string") {
				const at = entries.findIndex((e) => e.id === cmd.since);
				if (at < 0) return fail("unknown since entry", "unknown_since");
				return reply({ entries: entries.slice(at + 1), leafId: leaf });
			}
			return reply({ entries, leafId: leaf });
		}
		case "get_available_models":
			return reply({ models: MODELS });
		case "get_available_commands":
			return reply({ commands: [{ name: "todo", subcommands: [{ name: "import" }] }] });
		case "get_subagents":
			return reply({ subagents });
		case "get_available_thinking_levels":
			return reply({ levels: ["off", "minimal", "low", "medium", "high", "xhigh"] });
		case "set_model": {
			const model = MODELS.find((m) => m.provider === cmd.provider && m.id === cmd.modelId);
			if (!model) return fail("Model not found");
			settings.model = model;
			reply(model);
			// omp 18.12: both frames, whatever the level was before.
			out({ type: "model_changed" });
			return out({ type: "thinking_level_changed" });
		}
		case "set_thinking_level":
			settings.thinkingLevel = cmd.level;
			return reply(undefined);
		case "set_steering_mode":
			settings.steeringMode = cmd.mode;
			return reply(undefined);
		case "set_follow_up_mode":
			settings.followUpMode = cmd.mode;
			return reply(undefined);
		case "set_interrupt_mode":
			settings.interruptMode = cmd.mode;
			return reply(undefined);
		case "set_auto_compaction":
			settings.autoCompactionEnabled = cmd.enabled;
			return reply(undefined);
		case "set_fast_mode":
			settings.fastModeEnabled = cmd.enabled;
			settings.fastModeActive = cmd.enabled;
			return reply({ enabled: cmd.enabled, active: cmd.enabled });
		// omp never reports auto-retry or cache warming in its state; it answers `set_cache_warming` with the mode it runs in.
		case "set_cache_warming":
			return reply({ mode: cmd.mode });
		case "set_session_name": {
			settings.sessionName = cmd.name;
			// omp keeps the name in the title slot at the head of the conversation's file, which the sidebar lists it by.
			if (existsSync(sessionFile)) {
				const kept = readFileSync(sessionFile, "utf8")
					.split("\n")
					.filter((line) => !line.startsWith('{"type":"title"'));
				const slot = JSON.stringify({ type: "title", title: String(cmd.name), source: "user" });
				writeFileSync(sessionFile, [slot, ...kept].join("\n"));
			}
			reply(undefined);
			return emit({ type: "session_info_update" });
		}
		case "goal": {
			const op = cmd.op;
			if (op === "get") return reply({ goal, state: null });
			if (op === "create") {
				goal = {
					id: `goal-${++messageSeq}`,
					objective: String(cmd.objective ?? ""),
					status: "active",
					...(typeof cmd.tokenBudget === "number" ? { tokenBudget: cmd.tokenBudget } : {}),
					tokensUsed: 0,
					timeUsedSeconds: 0,
				};
			} else if (goal && (op === "pause" || op === "resume")) {
				goal = { ...goal, status: op === "pause" ? "paused" : "active" };
			} else if (goal && (op === "drop" || op === "clear")) {
				emit({ type: "goal_updated", goal: { ...goal, status: "dropped" } });
				goal = null;
				return reply({ goal: null, state: null });
			}
			reply({ goal, state: null });
			return emit({ type: "goal_updated", goal });
		}
		case "prompt": {
			const message = String(cmd.message ?? "");
			// omp's builtin `/todo import "<file>"`: the file's Markdown checklist is the list, and it says so, at once, mid-turn too.
			const imported = /^\/todo import "(.+)"$/.exec(message);
			if (imported) {
				const phases: { name: string; tasks: { content: string; status: string }[] }[] = [];
				const states: Record<string, string> = {
					" ": "pending",
					"/": "in_progress",
					x: "completed",
					"!": "blocked",
					"-": "abandoned",
				};
				for (const line of readFileSync(imported[1], "utf8").split("\n")) {
					const phase = /^# (.*)$/.exec(line);
					if (phase) phases.push({ name: phase[1], tasks: [] });
					const task = /^- \[(.)\] (.*?)(?: <!--.*-->)?$/.exec(line);
					if (task && phases.length)
						phases[phases.length - 1].tasks.push({ content: task[2], status: states[task[1]] ?? "pending" });
				}
				settings.todoPhases = phases;
				reply({ agentInvoked: false });
				return out({
					type: "command_output",
					text: `Imported ${phases.reduce((n, p) => n + p.tasks.length, 0)} tasks`,
				});
			}
			if (streaming) {
				const how = cmd.streamingBehavior;
				if (how !== "followUp" && how !== "steer") return fail("Agent is already processing a prompt.");
				(how === "steer" ? queue.steering : queue.followUp).push(message);
				reply();
				return queueUpdate();
			}
			reply({ agentInvoked: true });
			return startTurn(message);
		}
		case "steer":
			queue.steering.push(String(cmd.message ?? ""));
			reply();
			return queueUpdate();
		case "remove_queued_message": {
			const list = cmd.queue === "steering" ? queue.steering : queue.followUp;
			const at = list.indexOf(String(cmd.message));
			if (at >= 0) list.splice(at, 1);
			reply({ removed: at >= 0, images: [] });
			return queueUpdate();
		}
		case "abort":
		case "abort_and_restore_queue": {
			if (deaf) return;
			const withdrawn =
				cmd.type === "abort_and_restore_queue"
					? { steering: queue.steering.map((text) => ({ text })), followUp: queue.followUp.map((text) => ({ text })) }
					: {};
			if (cmd.type === "abort_and_restore_queue") {
				queue.steering = [];
				queue.followUp = [];
			}
			reply(withdrawn);
			if (cmd.type === "abort_and_restore_queue") queueUpdate();
			if (streaming) {
				emit({ type: "agent_end", messages: [], isTerminal: true });
				emit({ type: "session_settled" });
			}
			return;
		}
		case "bash": {
			// `sleep 3` takes three seconds; `abort_bash` ends every one that waits, as omp's does.
			const seconds = Number(/^sleep (\d+)/.exec(String(cmd.command ?? ""))?.[1] ?? 0);
			const timer = setTimeout(
				() => {
					bashes.delete(timer);
					reply({ exitCode: 0, output: "" });
				},
				seconds > 0 ? seconds * 1000 : 150,
			);
			bashes.set(timer, reply);
			return;
		}
		case "abort_bash":
			if (deaf) return;
			for (const [timer, answer] of bashes) {
				clearTimeout(timer);
				answer({ exitCode: 130, cancelled: true, output: "" });
			}
			bashes.clear();
			return reply();
		case "sync_emit":
			for (const f of cmd.frames as Record<string, unknown>[]) emit(f);
			return reply();
		case "sync_state": {
			const patch = { ...(cmd.patch as Record<string, unknown>) };
			if ("subagents" in patch) {
				subagents = patch.subagents as unknown[];
				delete patch.subagents;
			}
			Object.assign(settings, patch);
			return reply();
		}
		case "sync_deaf":
			deaf = true;
			return reply();
		case "sync_finish":
			reply();
			return finishTurn();
		default:
			return reply({});
	}
}

out({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2] });
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
	buf += new TextDecoder().decode(chunk);
	for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
		const line = buf.slice(0, nl);
		buf = buf.slice(nl + 1);
		if (line.trim()) handle(JSON.parse(line));
	}
}
