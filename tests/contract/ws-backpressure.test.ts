import { afterAll, beforeAll, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { PART_CHARS, ReplyAssembler } from "../../shared/reply-parts.ts";
import { writeBigSession } from "../support/big-session.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { connect, request } from "../support/ws.ts";

/**
 * A page that attaches asks for the whole conversation and, right after it, for a few small things. The big answer leaves
 * the socket holding more than Bun keeps (16 MiB), and Bun throws away whatever is sent to a socket in that state: the small
 * answers were never delivered, and the page waited for them for ever. Against the real server and the real omp (resuming
 * a 24 MB conversation, no model called).
 */

const BIG_BYTES = 24 * 1024 * 1024;
const MODEL = "anthropic/claude-haiku-5-5";
let s: TestServer;
let big: string;

beforeAll(async () => {
	s = await startTestServer();
	big = realpathSync(writeBigSession(s.agentDir, BIG_BYTES));
}, 60_000);
afterAll(async () => {
	await s?.stop();
});

test("small replies sent right after the answer to a huge request still arrive", async () => {
	const ws = await connect(s);
	const live = await request<{ liveId: string }>(ws, {
		t: "open",
		target: { kind: "resume", sessionFile: big, model: MODEL },
	});

	// Replies are read as far as their head: the big one is 24 MB, and decoding it here would delay the rest by itself.
	const answered = new Map<string, { bytes: number; ok: boolean }>();
	/** The size of every message that was part of a big reply, in the order they came. */
	const partSizes: number[] = [];
	/** The JSON text of the `data` of the answer to `get_entries`, to be read once everything else has been measured. */
	let entriesData = "";
	const parts = new ReplyAssembler();
	ws.addEventListener("message", (ev) => {
		const text = String(ev.data);
		// A reply too large for one message comes in parts (see `shared/reply-parts.ts`).
		const part = parts.push(text);
		if (part) {
			partSizes.push(text.length);
			if (part.data !== null) {
				answered.set(part.req, { bytes: part.data.length, ok: true });
				if (part.req === "burst-0-get_entries") entriesData = part.data;
			}
			return;
		}
		const head = /^\{"t":"reply","req":"([^"]+)","ok":(true|false)/.exec(text.slice(0, 200));
		if (head) answered.set(head[1] as string, { bytes: text.length, ok: head[2] === "true" });
	});
	const asked = ["get_entries", "get_state", "get_state", "get_available_commands"].map((type, i) => {
		const req = `burst-${i}-${type}`;
		ws.send(JSON.stringify({ t: "rpc", req, liveId: live.liveId, command: { type } }));
		return req;
	});

	// A reply that was dropped never comes: the wait ends at its deadline and the assertion below names what is missing.
	await pollUntil(() => asked.every((r) => answered.has(r)), "every reply to the burst", 30_000).catch(() => {});
	ws.close();
	expect(asked.filter((r) => !answered.has(r))).toEqual([]);
	expect(answered.get(asked[0] as string)?.bytes).toBeGreaterThan(BIG_BYTES * 0.9);
	for (const r of asked) expect(answered.get(r)?.ok).toBe(true);
	// The big answer is cut into messages of a bounded size, so that a page on a slow link hears it arrive (#291): not one
	// of 24 MB, and the small ones after it still one message each.
	expect(partSizes.length).toBeGreaterThan(Math.floor(BIG_BYTES / PART_CHARS));
	expect(Math.max(...partSizes)).toBeLessThanOrEqual(PART_CHARS + 100);
	// The answer is passed on as the text omp wrote, not read into objects first (see `splitResponse`): put back together
	// it is the document of omp's own frame layout, as a page reads it.
	const data = JSON.parse(entriesData) as { entries: { id: string }[]; leafId: string };
	expect(data.entries.length).toBeGreaterThan(1000);
	expect(data.leafId).toBe(data.entries[data.entries.length - 1]?.id as string);
}, 90_000);
