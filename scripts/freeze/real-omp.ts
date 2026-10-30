#!/usr/bin/env bun
/**
 * What the real omp costs on a very long conversation, as the web UI's server meets it: how long it takes to resume, and how long
 * it takes to answer the commands the page sends, one at a time and one behind another. No model is called: omp runs in an isolated
 * HOME on a copy of the session, and only commands that read state are sent.
 *
 *   bun scripts/freeze/real-omp.ts <a session file> [--repeat 5]
 *
 * The question it answers: does a command wait behind a slow one? (`abort` is the one that matters.) Every command is sent right
 * after the previous one, without waiting for its answer, and each answer is timed from its own send.
 */
import { constants, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const source = process.argv[2];
if (!source) throw new Error("usage: real-omp.ts <session file> [--repeat N]");
const repeat = Number(process.argv[process.argv.indexOf("--repeat") + 1] || 5);

const root = mkdtempSync(join(tmpdir(), "ompw-realomp-"));
const home = join(root, "home");
const agentDir = join(home, ".omp", "agent");
const bucket = join(agentDir, "sessions", "-omp");
mkdirSync(bucket, { recursive: true });
const file = join(bucket, "big.jsonl");
copyFileSync(source, file, constants.COPYFILE_FICLONE);

const began = performance.now();
const omp = Bun.spawn(["omp", "--mode", "rpc-ui", "--resume", file], {
	cwd: root,
	env: {
		...process.env,
		HOME: home,
		PI_CODING_AGENT_DIR: agentDir,
		PI_NO_TITLE: "1",
		PI_NATIVES_DIR: join(homedir(), ".omp", "natives"),
		ANTHROPIC_API_KEY: "ompw-offline-placeholder",
	},
	stdin: "pipe",
	stdout: "pipe",
	stderr: "pipe",
});

interface Waiting {
	type: string;
	sentAt: number;
	bytes: number;
	done: (ms: number) => void;
}
const waiting = new Map<string, Waiting>();
const frames: Record<string, number> = {};
const ready = Promise.withResolvers<void>();
let parts: Buffer[] = [];
let seq = 0;

void (async () => {
	const decoder = new TextDecoder();
	let buf = "";
	for await (const chunk of omp.stdout) {
		buf += decoder.decode(chunk, { stream: true });
		let nl = buf.indexOf("\n");
		while (nl >= 0) {
			const line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			nl = buf.indexOf("\n");
			// A frame is only looked into as far as its kind and id, near its start: a large answer is megabytes of JSON.
			const head = line.slice(0, 300);
			const type = /"type":"([a-z_]+)"/.exec(head)?.[1] ?? "?";
			if (type === "ready") {
				ready.resolve();
				continue;
			}
			if (type === "rpc_chunk") {
				// A large answer arrives as base64 chunks of one JSON document, one document at a time; its id is in its first bytes.
				const chunk = JSON.parse(line) as { index: number; count: number; data: string };
				parts.push(Buffer.from(chunk.data, "base64"));
				if (chunk.index === chunk.count - 1) {
					const whole = Buffer.concat(parts);
					parts = [];
					const id = /"id":"([^"]+)"/.exec(whole.toString("utf8", 0, 400))?.[1];
					const w = id ? waiting.get(id) : undefined;
					if (w) {
						w.bytes += whole.length;
						waiting.delete(id as string);
						w.done(performance.now() - w.sentAt);
					}
				}
				continue;
			}
			if (type !== "response") {
				frames[type] = (frames[type] ?? 0) + 1;
				continue;
			}
			const id = /"id":"([^"]+)"/.exec(head)?.[1];
			const w = id ? waiting.get(id) : undefined;
			if (!w) continue;
			w.bytes += line.length;
			waiting.delete(id as string);
			w.done(performance.now() - w.sentAt);
		}
	}
})();

const write = (command: Record<string, unknown>): void => {
	omp.stdin.write(`${JSON.stringify(command)}\n`);
	omp.stdin.flush();
};

function send(
	command: Record<string, unknown>,
	timeoutMs = 90_000,
): Promise<{ type: string; ms: number; bytes: number }> {
	const id = `m${++seq}`;
	const { promise, resolve } = Promise.withResolvers<{ type: string; ms: number; bytes: number }>();
	const w: Waiting = {
		type: String(command.type),
		sentAt: performance.now(),
		bytes: 0,
		done: (ms) => resolve({ type: w.type, ms, bytes: w.bytes }),
	};
	waiting.set(id, w);
	setTimeout(() => {
		if (waiting.delete(id)) resolve({ type: `${w.type}(NO ANSWER)`, ms: timeoutMs, bytes: 0 });
	}, timeoutMs);
	write({ ...command, id });
	return promise;
}

await ready.promise;
console.log(
	`omp ready ${(performance.now() - began).toFixed(0)} ms after start (session ${(Bun.file(file).size / 1e6).toFixed(1)} MB)`,
);
await send({ type: "negotiate_protocol", protocolVersion: 2 });
await send({ type: "set_subagent_subscription", level: "events" });
await send({ type: "set_event_filter", events: null, messageUpdates: "delta" });
console.log(
	`rss after resume: ${(
		Number(
			Bun.spawnSync(["ps", "-o", "rss=", "-p", String(omp.pid)])
				.stdout.toString()
				.trim(),
		) / 1024
	).toFixed(0)} MB`,
);

const table = (label: string, rows: { type: string; ms: number; bytes: number }[]) =>
	console.log(
		`${label.padEnd(34)} ${rows.map((r) => `${r.type} ${r.ms.toFixed(0)}ms (${(r.bytes / 1e3).toFixed(0)}KB)`).join("  |  ")}`,
	);

for (const type of [
	"get_state",
	"get_session_stats",
	"get_entries",
	"get_subagents",
	"get_available_commands",
	"abort",
]) {
	const rows = [];
	for (let i = 0; i < repeat; i++) rows.push(await send({ type }));
	table(`alone, ${repeat}x`, rows);
}

// One behind another, sent without waiting: does the cheap one wait for the expensive one?
for (const heavy of ["get_entries", "get_session_stats", "get_messages"]) {
	for (const cheap of ["abort", "get_state"]) {
		const rows = await Promise.all([send({ type: heavy }), send({ type: cheap }), send({ type: cheap })]);
		table(`${heavy} then ${cheap} x2`, rows);
	}
}
console.log(`other frames omp sent meanwhile: ${JSON.stringify(frames)}`);

omp.stdin.end();
await Promise.race([omp.exited, Bun.sleep(5000)]);
if (omp.exitCode === null) omp.kill("SIGKILL");
rmSync(root, { recursive: true, force: true });
