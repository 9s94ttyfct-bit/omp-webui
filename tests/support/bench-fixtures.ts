import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The conversations `scripts/bench.ts` measures, generated from a fixed seed: the same bytes on every machine and
 * every run, so a number that moves between two runs moved because of the code, not the data.
 *
 * - one long conversation of thousands of entries, with tool results from a few lines to a hundred KB;
 * - a few moderately sized ones to switch between;
 * - the conversation a fake omp streams into (rewritten before every run: a run adds to it);
 * - hundreds of small ones in many projects, spread over a year, so the sidebar has a library to list.
 */

/** Shape of the generated library: the benchmark reports it next to its numbers. */
export const BENCH_SHAPE = {
	/** Turns of the long conversation (a prompt, one or two tool steps and an answer each). */
	longTurns: 1400,
	/** Every this many turns the tool result is a big one (a log dump). */
	bigEvery: 25,
	/** Conversations to switch between, and the turns of each. */
	switchCount: 8,
	switchTurns: 40,
	/** Turns of the conversation that streams. */
	streamTurns: 500,
	/** Small conversations in the library. */
	bulk: 500,
	bulkProjects: 12,
} as const;

export interface BenchConversation {
	file: string;
	title: string;
	/** The id of the last entry on the branch: the message that is on screen once the conversation is. */
	lastId: string;
	entries: number;
	bytes: number;
}

export interface BenchWorld {
	/** The folder of the long, switching and streaming conversations (it exists: omp can start in it). */
	work: string;
	long: BenchConversation;
	switches: BenchConversation[];
	stream: BenchConversation;
	bulk: number;
}

// ------------------------------------------------------------------ deterministic content
/** mulberry32: a small seeded generator, the same sequence everywhere. */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const SYLLABLES = [
	"ka",
	"to",
	"ri",
	"mel",
	"dun",
	"sa",
	"ve",
	"lo",
	"pan",
	"gri",
	"ox",
	"ne",
	"ba",
	"tur",
	"qui",
	"zen",
];
const IDENT = [
	"parse",
	"render",
	"load",
	"merge",
	"flush",
	"split",
	"index",
	"queue",
	"route",
	"state",
	"frame",
	"entry",
];
const DIRS = ["server", "web/src/components", "web/src/lib", "shared", "scripts", "tests/unit"];

class Gen {
	private next: () => number;
	private vocabulary: string[];
	constructor(seed: number) {
		this.next = rng(seed);
		this.vocabulary = Array.from({ length: 3000 }, () => this.syllables(1 + Math.floor(this.next() * 3)));
	}
	private syllables(n: number): string {
		return Array.from({ length: n }, () => SYLLABLES[Math.floor(this.next() * SYLLABLES.length)]).join("");
	}
	int(lo: number, hi: number): number {
		return lo + Math.floor(this.next() * (hi - lo + 1));
	}
	pick<T>(xs: readonly T[]): T {
		return xs[Math.floor(this.next() * xs.length)];
	}
	chance(p: number): boolean {
		return this.next() < p;
	}
	words(n: number): string {
		return Array.from({ length: n }, () => this.vocabulary[Math.floor(this.next() * this.vocabulary.length)]).join(" ");
	}
	sentence(): string {
		const s = this.words(this.int(6, 18));
		return `${s[0].toUpperCase()}${s.slice(1)}.`;
	}
	paragraph(sentences: number): string {
		return Array.from({ length: sentences }, () => this.sentence()).join(" ");
	}
	path(): string {
		return `${this.pick(DIRS)}/${this.pick(IDENT)}-${this.pick(IDENT)}.ts`;
	}
	codeLine(): string {
		const [a, b, c] = [this.pick(IDENT), this.pick(IDENT), this.pick(IDENT)];
		switch (this.int(0, 5)) {
			case 0:
				return `export function ${a}${b[0].toUpperCase()}${b.slice(1)}(${c}: string): number {`;
			case 1:
				return `\tconst ${a} = ${b}(${c}, ${this.int(0, 99)});`;
			case 2:
				return `\tif (${a}.${b} === undefined) return ${this.int(0, 9)};`;
			case 3:
				return `\tfor (const ${a} of ${b}.${c}) ${this.pick(IDENT)}.push(${a});`;
			case 4:
				return `// ${this.words(this.int(3, 9))}`;
			default:
				return `}`;
		}
	}
	/** A file as `read` returns it: numbered lines. */
	fileListing(lines: number): string {
		return Array.from({ length: lines }, (_, i) => `${i + 1}\t${this.codeLine()}`).join("\n");
	}
	/** Output of `rg`/`bash`: path:line: text. */
	searchOutput(lines: number): string {
		return Array.from({ length: lines }, () => `${this.path()}:${this.int(1, 900)}: ${this.codeLine().trim()}`).join(
			"\n",
		);
	}
	/** A big log dump: timestamps, levels, messages. */
	logDump(bytes: number): string {
		const out: string[] = [];
		let size = 0;
		for (let i = 0; size < bytes; i++) {
			const line = `2026-01-0${1 + (i % 9)}T${String(i % 24).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")}Z ${this.pick(["INFO", "WARN", "DEBUG", "ERROR"])} [${this.pick(IDENT)}] ${this.words(this.int(6, 20))}`;
			out.push(line);
			size += line.length + 1;
		}
		return out.join("\n");
	}
	/** An answer: prose, a list, a code block, now and then a table. */
	answer(t: number): string {
		const parts = [this.paragraph(this.int(1, 3))];
		parts.push(Array.from({ length: this.int(2, 5) }, () => `- ${this.sentence()}`).join("\n"));
		parts.push(`\`\`\`ts\n${Array.from({ length: this.int(4, 12) }, () => this.codeLine()).join("\n")}\n\`\`\``);
		if (t % 7 === 3)
			parts.push(
				`| name | value |\n| --- | --- |\n${Array.from({ length: 4 }, () => `| ${this.words(1)} | ${this.int(0, 999)} |`).join("\n")}`,
			);
		parts.push(this.paragraph(this.int(1, 2)));
		return parts.join("\n\n");
	}
}

// ------------------------------------------------------------------ session files
const usage = { input: 5, output: 7, cacheRead: 100, cacheWrite: 10, totalTokens: 122, cost: { total: 0.0001 } };
const stamp = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + n * 1000).toISOString();

type Line = Record<string, unknown>;

function sessionId(kind: number, n: number): string {
	return `01b0000${kind}-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
}

interface Built {
	lines: Line[];
	lastId: string;
}

/**
 * `turns` turns of a working conversation: a prompt; an assistant step with thinking, a note and a tool call; the
 * tool's result; for some turns a second step; and the answer. `big` makes every that-many-th result a log dump.
 */
function buildConversation(
	g: Gen,
	o: { id: string; cwd: string; title: string; turns: number; big: number; tag: string },
): Built {
	const lines: Line[] = [
		{ type: "session", version: 3, id: o.id, timestamp: stamp(0), cwd: o.cwd },
		{ type: "title_change", id: `${o.tag}title`, parentId: null, timestamp: stamp(0), title: o.title },
	];
	let parent: string | null = null;
	let clock = 1;
	const push = (id: string, message: Record<string, unknown>) => {
		clock++;
		lines.push({
			type: "message",
			id,
			parentId: parent,
			timestamp: stamp(clock),
			message: { ...message, timestamp: Date.parse(stamp(clock)) },
		});
		parent = id;
	};
	const assistant = (id: string, content: unknown[], stopReason: string) =>
		push(id, {
			role: "assistant",
			content,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-haiku-5-5",
			usage,
			stopReason,
		});
	const step = (t: number, id: string, n: number) => {
		const kind = g.pick(["read", "bash", "bash", "edit", "grep"] as const);
		const callId = `toolu_${o.tag}${t}_${n}`;
		const args =
			kind === "read"
				? { path: g.path(), i: "Reading" }
				: kind === "bash"
					? { command: `rg -n ${g.words(1)} ${g.pick(DIRS)} | head -40`, i: "Searching" }
					: kind === "grep"
						? { pattern: g.words(1), path: g.pick(DIRS) }
						: { path: g.path(), input: `[${g.path()}#ABCD]\nPUT 1:\n+${g.codeLine()}` };
		assistant(
			id,
			[
				{ type: "thinking", thinking: g.paragraph(g.int(2, 6)), thinkingSignature: g.words(120).replaceAll(" ", "") },
				{ type: "text", text: g.paragraph(1) },
				{ type: "toolCall", id: callId, name: kind, arguments: args },
			],
			"toolUse",
		);
		const isBig = o.big > 0 && t % o.big === o.big - 1 && n === 0;
		const text = isBig
			? g.logDump(g.int(80_000, 140_000))
			: kind === "read"
				? g.fileListing(g.int(40, 300))
				: kind === "edit"
					? "Updated file."
					: g.searchOutput(g.int(5, 60));
		const details =
			kind === "edit"
				? {
						path: args.path,
						diff: [" 10|// context", `-11|${g.codeLine()}`, `+11|${g.codeLine()}`, " 12|}"].join("\n"),
					}
				: { wallTimeMs: g.int(5, 900) };
		push(`${o.tag}r${t}_${n}`, {
			role: "toolResult",
			toolCallId: callId,
			toolName: kind,
			content: [{ type: "text", text }],
			details,
			isError: false,
		});
	};
	for (let t = 0; t < o.turns; t++) {
		push(`${o.tag}u${t}`, {
			role: "user",
			content: [{ type: "text", text: `${g.paragraph(g.int(1, 2))} (turn ${t})` }],
			attribution: "user",
		});
		step(t, `${o.tag}a${t}x`, 0);
		if (g.chance(0.4)) step(t, `${o.tag}a${t}w`, 1);
		assistant(`${o.tag}a${t}y`, [{ type: "text", text: g.answer(t) }], "stop");
	}
	return { lines, lastId: parent ?? "" };
}

function write(
	agentDir: string,
	cwd: string,
	id: string,
	fileStamp: string,
	lines: Line[],
	mtimeSec: number,
): { file: string; bytes: number } {
	const bucket = join(agentDir, "sessions", cwd.replaceAll("/", "-"));
	mkdirSync(bucket, { recursive: true });
	const file = join(bucket, `${fileStamp}_${id}.jsonl`);
	const body = `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
	writeFileSync(file, body);
	utimesSync(file, mtimeSec, mtimeSec);
	return { file, bytes: Buffer.byteLength(body) };
}

const fileStamp = (kind: number, n: number) => `2026-01-0${kind}T00-${String(n % 60).padStart(2, "0")}-00-000Z`;

function conversation(
	agentDir: string,
	work: string,
	o: {
		kind: number;
		n: number;
		title: string;
		turns: number;
		big: number;
		tag: string;
		seed: number;
		mtimeSec: number;
	},
): BenchConversation {
	const id = sessionId(o.kind, o.n);
	const built = buildConversation(new Gen(o.seed), {
		id,
		cwd: work,
		title: o.title,
		turns: o.turns,
		big: o.big,
		tag: o.tag,
	});
	const { file, bytes } = write(agentDir, work, id, fileStamp(o.kind, o.n), built.lines, o.mtimeSec);
	return { file, title: o.title, lastId: built.lastId, entries: built.lines.length, bytes };
}

/** The streaming conversation: the same file every time it is written, so a run starts from what the last one did. */
export function writeStreamSession(agentDir: string, work: string, nowSec: number): BenchConversation {
	return conversation(agentDir, work, {
		kind: 3,
		n: 1,
		title: "Bench stream: a conversation that grows",
		turns: BENCH_SHAPE.streamTurns,
		big: 0,
		tag: "st",
		seed: 0x57ea11,
		mtimeSec: nowSec - 600,
	});
}

/**
 * Write the whole library under `agentDir` (an omp agent directory) and return what the benchmark needs to know.
 * The long conversation and the ones to switch between are the newest, so they are at the top of the sidebar; the
 * small ones are spread over the year before, in groups of one day, at noon UTC (a date group does not change with the
 * hour the benchmark runs at).
 */
export function seedBenchWorld(agentDir: string, work: string, nowMs = Date.now()): BenchWorld {
	const nowSec = Math.floor(nowMs / 1000);
	const long = conversation(agentDir, work, {
		kind: 1,
		n: 1,
		title: "Bench long: thousands of messages",
		turns: BENCH_SHAPE.longTurns,
		big: BENCH_SHAPE.bigEvery,
		tag: "lg",
		seed: 0x10a6,
		mtimeSec: nowSec - 60,
	});
	const switches = Array.from({ length: BENCH_SHAPE.switchCount }, (_, i) =>
		conversation(agentDir, work, {
			kind: 2,
			n: i + 1,
			title: `Bench switch ${i + 1}: ${["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"][i]} conversation`,
			turns: BENCH_SHAPE.switchTurns,
			big: 10,
			tag: `sw${i}`,
			seed: 0x5110 + i,
			mtimeSec: nowSec - 120 - i * 60,
		}),
	);
	const stream = writeStreamSession(agentDir, work, nowSec);

	const g = new Gen(0xb01c);
	const noon = Math.floor(nowSec / 86400) * 86400 + 12 * 3600;
	for (let i = 0; i < BENCH_SHAPE.bulk; i++) {
		const day = 1 + Math.floor((i * 380) / BENCH_SHAPE.bulk);
		const project = `/tmp/ompw-bench/project-${String(i % BENCH_SHAPE.bulkProjects).padStart(2, "0")}`;
		const turns = g.int(1, 5);
		const title = `Bulk ${i}: ${g.words(g.int(2, 5))}`;
		const id = sessionId(4, i);
		const built = buildConversation(g, { id, cwd: project, title, turns, big: 0, tag: `b${i}` });
		write(agentDir, project, id, fileStamp(4, i), built.lines, noon - day * 86400 + (i % 3) * 600);
	}
	return { work, long, switches, stream, bulk: BENCH_SHAPE.bulk };
}
/** An `OMP_BIN` that is the scripted fake omp (long-fake-omp.ts: no model) and reports the version of the omp the web UI is made for, so no "omp is older" banner changes the page. */
export function writeBenchOmp(dir: string): string {
	const bin = join(dir, "omp");
	const script = join(dirname(fileURLToPath(import.meta.url)), "long-fake-omp.ts");
	writeFileSync(
		bin,
		`#!/bin/sh\nif [ "$1" = "--version" ]; then echo "omp/18.12.3"; exit 0; fi\nexec bun ${script} "$@"\n`,
		{
			mode: 0o755,
		},
	);
	return bin;
}
