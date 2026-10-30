import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { interviewPrompt } from "../../shared/guided-goal.ts";
import { FIXTURE_BUCKET, FIXTURE_CWD } from "./fixtures.ts";

/**
 * A saved conversation that began as a guided goal: the web UI's interview prompt as the first user message, one
 * question from omp, and the user's answer. It has no title, so the sidebar names it by its preview. `n` (0-255)
 * makes the file name and session id unique. Its mtime is now, not `writeSimpleSession`'s `now + n`: a conversation
 * stamped minutes ahead would keep the top of the sidebar and of the palette, and push the fixtures other specs look
 * for out of the few rows those show. Returns the file path.
 */
export function writeGuidedSession(
	agentDir: string,
	n: number,
	options: { rough: string; language: string; answer: string },
): string {
	const hex = n.toString(16).padStart(2, "0");
	const id = `01a00000-0000-7000-8000-0000000098${hex}`;
	const file = join(agentDir, "sessions", FIXTURE_BUCKET, `2026-01-07T01-${hex}-00-000Z_${id}.jsonl`);
	const at = (min: number) => new Date(Date.UTC(2026, 0, 7, 1, min)).toISOString();
	const message = (entryId: string, parentId: string | null, min: number, role: string, text: string) => ({
		type: "message",
		id: entryId,
		parentId,
		timestamp: at(min),
		message: {
			role,
			content: [{ type: "text", text }],
			...(role === "user"
				? { attribution: "user" }
				: {
						api: "anthropic-messages",
						provider: "anthropic",
						model: "claude-haiku-5-5",
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
						stopReason: "stop",
					}),
			timestamp: Date.parse(at(min)),
		},
	});
	const entries = [
		{ type: "session", version: 3, id, timestamp: at(0), cwd: FIXTURE_CWD },
		message(`g${hex}000001`, null, 1, "user", interviewPrompt(options.rough, options.language)),
		message(`g${hex}000002`, `g${hex}000001`, 2, "assistant", "What does done look like?"),
		message(`g${hex}000003`, `g${hex}000002`, 3, "user", options.answer),
		message(`g${hex}000004`, `g${hex}000003`, 4, "assistant", "Thanks."),
	];
	writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
	return file;
}
