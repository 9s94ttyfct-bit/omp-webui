import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_BUCKET, FIXTURE_CWD } from "./fixtures.ts";

/**
 * A conversation of about `bytes` bytes in the fixture project of `agentDir`, for tests of what a long one costs
 * the server: a title and alternating user and assistant messages of ~6 KB of varied prose (a few thousand
 * distinct words, so it compresses about as real text does). Returns the file's path.
 */
export function writeBigSession(
	agentDir: string,
	bytes: number,
	title = "Fixture big: a very long conversation",
): string {
	// A fixed seed: the same file every run.
	let seed = 0x2545f491;
	const next = () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed;
	};
	const syllables = [
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
	const vocabulary = Array.from({ length: 4000 }, () =>
		Array.from({ length: 1 + (next() % 3) }, () => syllables[next() % syllables.length]).join(""),
	);
	const text = () => Array.from({ length: 900 }, () => vocabulary[next() % vocabulary.length]).join(" ");

	const stamp = "2026-01-08T00:00:00.000Z";
	const lines = [
		JSON.stringify({
			type: "session",
			version: 3,
			id: "01a00000-0000-7000-8000-0000000000b1",
			timestamp: stamp,
			cwd: FIXTURE_CWD,
		}),
		JSON.stringify({ type: "title_change", id: "t0000000", parentId: null, timestamp: stamp, title }),
	];
	let size = lines[0].length + lines[1].length + 2;
	for (let i = 0; size < bytes; i++) {
		const message =
			i % 2 === 0
				? { role: "user", content: [{ type: "text", text: text() }], attribution: "user" }
				: {
						role: "assistant",
						content: [{ type: "text", text: text() }],
						provider: "anthropic",
						model: "claude-haiku-5-5",
						usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 100, cost: { total: 0.001 } },
						stopReason: "stop",
					};
		const line = JSON.stringify({
			type: "message",
			id: `b${i.toString(16).padStart(7, "0")}`,
			parentId: i ? `b${(i - 1).toString(16).padStart(7, "0")}` : null,
			timestamp: stamp,
			message,
		});
		lines.push(line);
		size += line.length + 1;
	}
	const bucket = join(agentDir, "sessions", FIXTURE_BUCKET);
	mkdirSync(bucket, { recursive: true });
	const file = join(bucket, "2026-01-08T00-00-00-000Z_01a00000-0000-7000-8000-0000000000b1.jsonl");
	writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}
