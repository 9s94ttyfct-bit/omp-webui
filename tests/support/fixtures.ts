import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Deterministic session files in omp's documented JSONL format (omp docs:
 * session.md). Used by E2E tests that must not depend on a model.
 */

export const FIXTURE_CWD = "/tmp/ompw-fixture-project";

export interface FixtureUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export const USAGE_A1: FixtureUsage = { input: 120, output: 45, cacheRead: 1000, cacheWrite: 300, cost: 0.012345 };
export const USAGE_A2: FixtureUsage = { input: 10, output: 80, cacheRead: 1400, cacheWrite: 60, cost: 0.004321 };
export const USAGE_A3: FixtureUsage = { input: 5, output: 20, cacheRead: 1500, cacheWrite: 10, cost: 0.001 };
export const USAGE_B2: FixtureUsage = { input: 11, output: 33, cacheRead: 1400, cacheWrite: 20, cost: 0.0025 };

export const FIXTURE = {
	alphaTitle: "Fixture alpha: zebra protocol",
	betaTitle: "Fixture beta: wombat branch",
	gammaTitle: "Fixture gamma: scout agent",
	gammaSideReply: "README located under docs/README.md.",
	deltaTitle: "Fixture delta: unavailable model",
	epsilonTitle: "Fixture epsilon: long agent turn",
	epsilonFinal: "All four checks passed.",
	compactionSummary: "The user asked a scout to find config files; three were found.",
	alphaReply: "The zebra protocol uses striped packets.",
	alphaFinal: "Quokka mode enabled.",
	alphaThinking: "The quokka flag lives in the protocol header.",
	betaFinal: "Wombat route chosen.",
	subagentId: "ScoutAgent",
	subagentReply: "Found 3 matching files.",
};

function usage(u: FixtureUsage) {
	return {
		input: u.input,
		output: u.output,
		cacheRead: u.cacheRead,
		cacheWrite: u.cacheWrite,
		totalTokens: u.input + u.output + u.cacheRead + u.cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: u.cost },
	};
}

const ts = (min: number) => new Date(Date.UTC(2026, 0, 5, 10, min)).toISOString();

/** omp's fixed-width title slot: one JSON line padded to exactly 256 bytes including the newline. */
function titleSlot(title: string): string {
	const slot = { type: "title", v: 1, title, source: "user", updatedAt: ts(0), pad: "" };
	slot.pad = " ".repeat(255 - Buffer.byteLength(JSON.stringify(slot)));
	return `${JSON.stringify(slot)}\n`;
}

function write(file: string, header: Record<string, unknown>, entries: Record<string, unknown>[], title: string): void {
	const body = `${[header, ...entries].map((e) => JSON.stringify(e)).join("\n")}\n`;
	writeFileSync(file, title ? titleSlot(title) + body : body);
}

const user = (id: string, parentId: string | null, min: number, text: string) => ({
	type: "message",
	id,
	parentId,
	timestamp: ts(min),
	message: { role: "user", content: [{ type: "text", text }], attribution: "user", timestamp: Date.parse(ts(min)) },
});

const assistant = (id: string, parentId: string, min: number, content: unknown[], u: FixtureUsage) => ({
	type: "message",
	id,
	parentId,
	timestamp: ts(min),
	message: {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-haiku-5-5",
		usage: usage(u),
		stopReason: "stop",
		timestamp: Date.parse(ts(min)) + 500,
	},
});

export interface SeededFixtures {
	alpha: string;
	beta: string;
	gamma: string;
	/** Saved model is an OpenAI model the isolated environment has no credentials for. */
	delta: string;
	/** One agent turn with four tool steps before the final answer. */
	epsilon: string;
}

/** Bucket and file names of the fixture sessions inside `<agentDir>/sessions`. */
export const FIXTURE_BUCKET = "-tmp-ompw-fixture-project";
export const FIXTURE_FILES = {
	alpha: "2026-01-05T10-00-00-000Z_01a00000-0000-7000-8000-00000000a1a1.jsonl",
	beta: "2026-01-05T10-30-00-000Z_01a00000-0000-7000-8000-00000000b2b2.jsonl",
	gamma: "2026-01-05T11-00-00-000Z_01a00000-0000-7000-8000-00000000c3c3.jsonl",
	delta: "2026-01-05T12-00-00-000Z_01a00000-0000-7000-8000-00000000e5e5.jsonl",
	epsilon: "2026-01-05T13-00-00-000Z_01a00000-0000-7000-8000-00000000f6f6.jsonl",
};

/**
 * Write one short conversation (a prompt and a reply) in the fixture project, for specs
 * that delete or otherwise consume sessions without touching the shared fixtures.
 * `n` (0–255) makes the file name and session id unique, and orders the sidebar: it lists by
 * mtime, so each file is stamped `now + n` seconds (writes in one tick would otherwise tie).
 * Returns the file path. `cwd`: the folder the conversation worked in (the fixture project by default).
 */
export function writeSimpleSession(
	agentDir: string,
	n: number,
	title: string,
	cost?: number,
	cwd: string = FIXTURE_CWD,
): string {
	const hex = n.toString(16).padStart(2, "0");
	const id = `01a00000-0000-7000-8000-0000000099${hex}`;
	const file = join(agentDir, "sessions", FIXTURE_BUCKET, `2026-01-07T00-${hex}-00-000Z_${id}.jsonl`);
	write(
		file,
		{ type: "session", version: 3, id, timestamp: ts(300 + n), cwd },
		[
			user(`s${hex}000001`, null, 300 + n, `${title}?`),
			assistant(`s${hex}000002`, `s${hex}000001`, 300 + n, [{ type: "text", text: `${title}.` }], {
				...USAGE_A1,
				cost: cost ?? USAGE_A1.cost,
			}),
		],
		title,
	);
	const at = Date.now() / 1000 + n;
	utimesSync(file, at, at);
	return file;
}

/** Write fixture sessions under `<agentDir>/sessions` and return their paths. */
export function seedFixtures(agentDir: string): SeededFixtures {
	const bucket = join(agentDir, "sessions", FIXTURE_BUCKET);
	mkdirSync(bucket, { recursive: true });
	const alpha = join(bucket, FIXTURE_FILES.alpha);
	const beta = join(bucket, FIXTURE_FILES.beta);
	const gamma = join(bucket, FIXTURE_FILES.gamma);

	const prefix = [
		{ type: "model_change", id: "f0000001", parentId: null, timestamp: ts(0), model: "anthropic/claude-haiku-5-5" },
		user("f0000002", "f0000001", 1, "Explain the zebra protocol"),
		assistant("f0000003", "f0000002", 2, [{ type: "text", text: FIXTURE.alphaReply }], USAGE_A1),
	];
	write(
		alpha,
		{ type: "session", version: 3, id: "01a00000-0000-7000-8000-00000000a1a1", timestamp: ts(0), cwd: FIXTURE_CWD },
		[
			...prefix,
			user("f0000004", "f0000003", 3, "And what about quokka mode?"),
			assistant(
				"f0000005",
				"f0000004",
				4,
				[{ type: "toolCall", id: "toolu_fixture_1", name: "bash", arguments: { command: "echo quokka" } }],
				USAGE_A2,
			),
			{
				type: "message",
				id: "f0000006",
				parentId: "f0000005",
				timestamp: ts(5),
				message: {
					role: "toolResult",
					toolCallId: "toolu_fixture_1",
					toolName: "bash",
					content: [{ type: "text", text: "quokka\n" }],
					isError: false,
					timestamp: Date.parse(ts(5)),
				},
			},
			assistant(
				"f0000007",
				"f0000006",
				6,
				[
					{ type: "thinking", thinking: FIXTURE.alphaThinking },
					{ type: "text", text: FIXTURE.alphaFinal },
				],
				USAGE_A3,
			),
		],
		FIXTURE.alphaTitle,
	);
	write(
		beta,
		{
			type: "session",
			version: 3,
			id: "01a00000-0000-7000-8000-00000000b2b2",
			timestamp: ts(30),
			cwd: FIXTURE_CWD,
			parentSession: alpha,
		},
		[
			...prefix,
			user("f0000014", "f0000003", 31, "And what about wombat routing?"),
			assistant("f0000015", "f0000014", 32, [{ type: "text", text: FIXTURE.betaFinal }], USAGE_B2),
		],
		FIXTURE.betaTitle,
	);
	write(
		gamma,
		{ type: "session", version: 3, id: "01a00000-0000-7000-8000-00000000c3c3", timestamp: ts(60), cwd: FIXTURE_CWD },
		[
			// An earlier, abandoned in-file branch (physically first, so the file's head stays the main path).
			user("f0000027", null, 59, "Find the README with a scout"),
			assistant("f0000028", "f0000027", 60, [{ type: "text", text: FIXTURE.gammaSideReply }], USAGE_A3),
			user("f0000021", null, 61, "Find the config files with a scout"),
			assistant(
				"f0000022",
				"f0000021",
				62,
				[
					{
						type: "toolCall",
						id: "toolu_fixture_task",
						name: "task",
						arguments: { tasks: [{ id: FIXTURE.subagentId, assignment: "Find config files" }] },
					},
				],
				USAGE_A3,
			),
			{
				type: "message",
				id: "f0000023",
				parentId: "f0000022",
				timestamp: ts(63),
				message: {
					role: "toolResult",
					toolCallId: "toolu_fixture_task",
					toolName: "task",
					content: [{ type: "text", text: FIXTURE.subagentReply }],
					isError: false,
					timestamp: Date.parse(ts(63)),
				},
			},
			assistant("f0000024", "f0000023", 64, [{ type: "text", text: "The scout found 3 files." }], USAGE_A3),
			{
				type: "compaction",
				id: "f0000025",
				parentId: "f0000024",
				timestamp: ts(65),
				summary: FIXTURE.compactionSummary,
				firstKeptEntryId: "f0000024",
				tokensBefore: 12345,
			},
		],
		FIXTURE.gammaTitle,
	);
	const artifacts = gamma.replace(/\.jsonl$/, "");
	mkdirSync(artifacts, { recursive: true });
	write(
		join(artifacts, `${FIXTURE.subagentId}.jsonl`),
		{ type: "session", version: 3, id: "01a00000-0000-7000-8000-00000000d4d4", timestamp: ts(62), cwd: FIXTURE_CWD },
		[
			user("f0000031", null, 62, "Find config files"),
			assistant("f0000032", "f0000031", 63, [{ type: "text", text: FIXTURE.subagentReply }], USAGE_A3),
		],
		"",
	);
	const delta = join(bucket, FIXTURE_FILES.delta);
	const openaiReply = assistant(
		"f0000043",
		"f0000042",
		122,
		[{ type: "text", text: "I am an OpenAI model." }],
		USAGE_A3,
	);
	openaiReply.message = { ...openaiReply.message, api: "openai-responses", provider: "openai", model: "gpt-5.2" };
	write(
		delta,
		{ type: "session", version: 3, id: "01a00000-0000-7000-8000-00000000e5e5", timestamp: ts(120), cwd: FIXTURE_CWD },
		[
			{ type: "model_change", id: "f0000041", parentId: null, timestamp: ts(120), model: "openai/gpt-5.2" },
			user("f0000042", "f0000041", 121, "Which model are you?"),
			openaiReply,
		],
		FIXTURE.deltaTitle,
	);
	const epsilon = join(bucket, FIXTURE_FILES.epsilon);
	const steps: Record<string, unknown>[] = [];
	let parent = "f0000051";
	["bash", "read", "bash", "grep"].forEach((tool, i) => {
		const call = `f00000${60 + i * 2}`;
		const result = `f00000${61 + i * 2}`;
		const toolCallId = `toolu_eps_${i}`;
		steps.push(
			assistant(
				call,
				parent,
				182 + i * 2,
				[{ type: "toolCall", id: toolCallId, name: tool, arguments: { command: `check ${i}` } }],
				USAGE_A3,
			),
			{
				type: "message",
				id: result,
				parentId: call,
				timestamp: ts(183 + i * 2),
				message: {
					role: "toolResult",
					toolCallId,
					toolName: tool,
					content: [{ type: "text", text: `ok ${i}` }],
					isError: false,
					timestamp: Date.parse(ts(183 + i * 2)),
				},
			},
		);
		parent = result;
	});
	write(
		epsilon,
		{ type: "session", version: 3, id: "01a00000-0000-7000-8000-00000000f6f6", timestamp: ts(180), cwd: FIXTURE_CWD },
		[
			user("f0000051", null, 181, "Run the four checks"),
			...steps,
			assistant("f0000070", parent, 191, [{ type: "text", text: FIXTURE.epsilonFinal }], USAGE_A3),
		],
		FIXTURE.epsilonTitle,
	);
	return { alpha, beta, gamma, delta, epsilon };
}
