import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { FIXTURE_CWD } from "./fixtures.ts";

/** One prompt and its answer; `image` is a `blob:sha256:` hash omp would have stored the prompt's picture under. */
export interface ChatTurn {
	prompt: string;
	reply: string;
	image?: string;
}

export interface ChatSessionOptions {
	/** 0–255: makes the file and session id unique (see `writeSimpleSession`; the ids here use another prefix). */
	n: number;
	title: string;
	/** The folder of the conversation: its sidebar project. */
	cwd?: string;
	turns: ChatTurn[];
	/**
	 * What the conversation cost, in dollars. The Usage page lists only the costliest conversations, so a spec that
	 * wants its own conversation in the list gives it a cost above the fixtures' (see `writeChatSession`).
	 */
	cost?: number;
}

/** The usage of a conversation, at the cost the spec asked for. */
const usageOf = (cost: number) => ({
	input: 5,
	output: 7,
	cacheRead: 100,
	cacheWrite: 10,
	totalTokens: 122,
	cost: { total: cost },
});

const usage = usageOf(0.0001);

/**
 * A conversation of the spec's own with any number of turns, in any folder, for specs that need a different shape
 * from `writeSimpleSession`'s two messages (an image conversation, one of hundreds of turns, another project).
 * Returns the file's path. Entry ids are `t<turn>p` (the prompt) and `t<turn>r` (the reply).
 */
export function writeChatSession(agentDir: string, o: ChatSessionOptions): string {
	const cwd = o.cwd ?? FIXTURE_CWD;
	const hex = o.n.toString(16).padStart(2, "0");
	const id = `01a00000-0000-7000-8000-0000000077${hex}`;
	const turnUsage = usageOf(o.cost ?? usage.cost.total);
	const stamp = (i: number) => new Date(Date.UTC(2026, 0, 9, 0, 0, i)).toISOString();
	const lines: Record<string, unknown>[] = [
		{ type: "session", version: 3, id, timestamp: stamp(0), cwd },
		{ type: "title_change", id: "title000", parentId: null, timestamp: stamp(0), title: o.title },
	];
	let parent: string | null = null;
	o.turns.forEach((t, i) => {
		const content: Record<string, unknown>[] = [{ type: "text", text: t.prompt }];
		if (t.image) content.push({ type: "image", data: `blob:sha256:${t.image}`, mimeType: "image/png" });
		lines.push({
			type: "message",
			id: `t${i}p`,
			parentId: parent,
			timestamp: stamp(2 * i + 1),
			message: { role: "user", content, attribution: "user", timestamp: Date.parse(stamp(2 * i + 1)) },
		});
		lines.push({
			type: "message",
			id: `t${i}r`,
			parentId: `t${i}p`,
			timestamp: stamp(2 * i + 2),
			message: {
				role: "assistant",
				content: [{ type: "text", text: t.reply }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-haiku-5-5",
				usage: turnUsage,
				stopReason: "stop",
				timestamp: Date.parse(stamp(2 * i + 2)),
			},
		});
		parent = `t${i}r`;
	});
	const bucket = join(agentDir, "sessions", cwd.replaceAll("/", "-"));
	mkdirSync(bucket, { recursive: true });
	const file = join(bucket, `2026-01-09T00-${hex}-00-000Z_${id}.jsonl`);
	writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	const at = Date.now() / 1000 + o.n;
	utimesSync(file, at, at);
	return file;
}

/** A solid-colour PNG, `w` × `h` pixels: a picture of a known size for specs about layout. */
export function solidPng(w: number, h: number, [r, g, b]: [number, number, number] = [90, 140, 220]): Buffer {
	const crcTable = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (buf: Buffer) => {
		let c = 0xffffffff;
		for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type), data]);
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const sum = Buffer.alloc(4);
		sum.writeUInt32BE(crc(body));
		return Buffer.concat([length, body, sum]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(w, 0);
	header.writeUInt32BE(h, 4);
	header.set([8, 2, 0, 0, 0], 8);
	const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
	const raw = Buffer.concat(Array.from({ length: h }, () => row));
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}
