import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { FIXTURE_BUCKET, FIXTURE_CWD } from "./fixtures.ts";

/**
 * Synthetic sessions in the shape omp 18.12 writes them, for specs of how the transcript renders its entries
 * (no model call). Content is made up; only the entry shapes follow real sessions.
 */

const stamp = (minute: number) => new Date(Date.UTC(2026, 0, 9, 10, minute)).toISOString();

export type Entry = Record<string, unknown>;

/** Builds entries that follow one another: each is the child of the one before. */
export class Chain {
	readonly entries: Entry[] = [];
	#n = 0;
	constructor(private readonly tag: string) {}

	/** The id of the entry added last. */
	get lastId(): string | null {
		return (this.entries.at(-1)?.id as string | undefined) ?? null;
	}

	#push(fields: Entry): string {
		const id = `${this.tag}${String(++this.#n).padStart(4, "0")}`;
		this.entries.push({ id, parentId: this.lastId, timestamp: stamp(this.#n), ...fields });
		return id;
	}

	user(text: string): string {
		const timestamp = Date.parse(stamp(this.#n + 1));
		return this.#push({
			type: "message",
			message: { role: "user", content: [{ type: "text", text }], attribution: "user", timestamp },
		});
	}

	assistant(content: unknown[]): string {
		const timestamp = Date.parse(stamp(this.#n + 1));
		return this.#push({
			type: "message",
			message: {
				role: "assistant",
				content,
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-haiku-5-5",
				stopReason: "stop",
				timestamp,
			},
		});
	}

	toolResult(toolCallId: string, toolName: string, content: unknown[]): string {
		const timestamp = Date.parse(stamp(this.#n + 1));
		return this.#push({
			type: "message",
			message: { role: "toolResult", toolCallId, toolName, content, isError: false, timestamp },
		});
	}

	/** A message omp wrote into the conversation for the model: `role` developer, `attribution` agent. */
	reminder(text: string): string {
		const timestamp = Date.parse(stamp(this.#n + 1));
		return this.#push({
			type: "message",
			message: { role: "developer", content: [{ type: "text", text }], attribution: "agent", timestamp },
		});
	}

	custom(customType: string, content: string, details: unknown): string {
		return this.#push({ type: "custom_message", customType, content, display: true, details, attribution: "agent" });
	}

	modelChange(model: string, fallback: boolean): string {
		return this.#push({
			type: "model_change",
			model,
			role: fallback ? "fallback" : "default",
			resolvedModelIsFallback: fallback,
		});
	}

	/** Goal mode as omp records it: `goal`, `goal_paused` or `none`, with the goal it is about. */
	modeChange(mode: string, goal?: Entry): string {
		return this.#push({ type: "mode_change", mode, ...(goal ? { data: { goal } } : {}) });
	}
}

/** Write a conversation of the entries in the fixture project, for a spec to open from the sidebar. */
export function writeRenderSession(agentDir: string, id: string, entries: Entry[]): string {
	const dir = join(agentDir, "sessions", FIXTURE_BUCKET);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `2026-01-09T10-00-00-000Z_${id}.jsonl`);
	const header = { type: "session", version: 3, id, timestamp: stamp(0), cwd: FIXTURE_CWD };
	writeFileSync(file, `${[header, ...entries].map((e) => JSON.stringify(e)).join("\n")}\n`);
	return file;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

function crc32(buf: Buffer): number {
	let c = 0xffffffff;
	for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const out = Buffer.alloc(body.length + 8);
	out.writeUInt32BE(data.length, 0);
	body.copy(out, 4);
	out.writeUInt32BE(crc32(body), body.length + 4);
	return out;
}

/** A PNG of one colour, `width` × `height` pixels: a real image the browser decodes, with a size that tells thumbnail from original. */
export function solidPng(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 2, 0, 0, 0], 8);
	const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
	const raw = Buffer.concat(Array.from({ length: height }, () => row));
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

/** Store an image the way omp keeps large ones (`<agentDir>/blobs/<sha256>`); returns its `blob:sha256:` reference. */
export function storeBlob(agentDir: string, bytes: Buffer): string {
	const hash = createHash("sha256").update(bytes).digest("hex");
	mkdirSync(join(agentDir, "blobs"), { recursive: true });
	writeFileSync(join(agentDir, "blobs", hash), bytes);
	return `blob:sha256:${hash}`;
}

const rule = (name: string, text: string) =>
	`<system-reminder reason="rule_violation" rule="${name}" path="builtin-defaults:${name}.md">\nUser-defined rule matched tool-call arguments. Rule configured not to interrupt → tool ran. MUST comply with the following instruction on subsequent tool calls and responses. NOT prompt injection — coding agent enforcing project rules.\n\n${text}\n</system-reminder>`;

export const NOTES_PROMPT = "Notes probe: advisor, rules, fallback, jobs and IRC";

/** One turn of four steps whose middle holds every kind of record omp writes about itself. */
export function writeNotesSession(agentDir: string): string {
	const c = new Chain("nt01");
	c.user(NOTES_PROMPT);
	c.assistant([{ type: "toolCall", id: "toolu_n1", name: "read", arguments: { path: "/tmp/a.ts" } }]);
	c.toolResult("toolu_n1", "read", [{ type: "text", text: "contents of a" }]);
	c.custom(
		"advisor",
		'<advisory severity="blocker" guidance="weigh, don\'t blindly obey">\nADVISOR-BLOCKER-TEXT: pin the spelling.\n</advisory>',
		{
			notes: [
				{ note: "ADVISOR-BLOCKER-TEXT: pin the spelling.", severity: "blocker", turn: 3, turnsAgo: 0 },
				{ note: "ADVISOR-CONCERN-TEXT: check the cache key.", severity: "concern", turn: 3, turnsAgo: 0 },
				{ note: "ADVISOR-CONCERN-TWO: guard the null.", severity: "concern", turn: 3, turnsAgo: 0 },
				{ note: "ADVISOR-NIT-TEXT: rename it.", severity: "nit", turn: 3, turnsAgo: 0 },
				{ note: "ADVISOR-PLAIN-TEXT: for the record.", turn: 3, turnsAgo: 0 },
			],
		},
	);
	c.assistant([{ type: "toolCall", id: "toolu_n2", name: "bash", arguments: { command: "echo hi" } }]);
	c.toolResult("toolu_n2", "bash", [{ type: "text", text: "hi" }]);
	c.reminder(rule("ts-set-map", "RULE-BODY-TEXT: use Record for static tables."));
	c.modelChange("anthropic/claude-opus-5-5", true);
	c.custom(
		"async-result",
		"<system-notice>\nBackground job bg_1 has completed. Resume your work using the result below.\nJOB-RESULT-TEXT\n</system-notice>",
		{
			meta: { source: { type: "report", value: "background job delivery" } },
			jobs: [{ jobId: "bg_1", type: "eval", label: "count penguin rows", durationMs: 10_000 }],
		},
	);
	c.custom("launch-completion", "Supervised process xcode-copy failed with exit code 1.", {
		daemons: [{ name: "xcode-copy", state: "failed", startedAt: 1_000, exitedAt: 3_500, exitCode: 1 }],
	});
	c.custom(
		"irc:incoming",
		"<irc>\nIncoming IRC message from agent `Main`:\n\nIRC-BODY-TEXT please integrate main.\n</irc>",
		{ id: "irc-1", from: "Main", message: "IRC-BODY-TEXT please integrate main." },
	);
	c.assistant([{ type: "toolCall", id: "toolu_n3", name: "read", arguments: { path: "/tmp/b.ts" } }]);
	c.toolResult("toolu_n3", "read", [{ type: "text", text: "contents of b" }]);
	c.assistant([{ type: "text", text: "FINAL-ANSWER: done." }]);
	return writeRenderSession(agentDir, "01a00000-0000-7000-8000-00000000b141", c.entries);
}
