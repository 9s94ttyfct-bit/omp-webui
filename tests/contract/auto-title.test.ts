import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveInfo, SessionSummary } from "../../shared/protocol.ts";
import { type Frame, watchFrames } from "../support/frames.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type ScriptedTurn, type StubScripted, startScriptedStub } from "../support/stub-scripted.ts";
import { connect, request } from "../support/ws.ts";

/**
 * Automatic titles (#627), against the real omp and the real server, the model a scripted provider. omp makes no title in RPC
 * mode, so the server asks for one (`/rename`) after a conversation's first exchange, whether a page is open on it or not:
 * a conversation that finishes while the macOS app has no window is named all the same. The title model is the provider's
 * request that offers no tools. omp's own title switch (`PI_NO_TITLE`, set by the harness) is lifted, so that `/rename` reaches it.
 */

let server: TestServer;
let backend: StubScripted;
/** What the title model answers next (`null`: a refusal, as a model that gave nothing). */
let title: string | null = "A fine title";
const asked = () => backend.requests.filter((r) => r.tools.length === 0).length;

const script = (req: { tools: string[] }): ScriptedTurn => {
	if (req.tools.length === 0)
		return title === null ? { refuse: { retryAfterMs: 1, status: 400, message: "no title today" } } : { text: title };
	return { text: "Ok." };
};

beforeAll(async () => {
	backend = await startScriptedStub(script);
	server = await startTestServer(0, { OMP_WEBUI_AUTO_TITLE: "on", PI_NO_TITLE: "" }, { login: false });
	writeFileSync(
		join(server.agentDir, "models.yml"),
		`providers:\n  omlx:\n    baseUrl: ${backend.url}\n    api: openai-completions\n    apiKey: ${backend.apiKey}\n    models:\n      - id: stub-model\n`,
	);
	writeFileSync(
		join(server.agentDir, "config.yml"),
		[
			"modelRoles:",
			...["default", "smol", "slow", "tiny", "commit"].map((r) => `  ${r}: omlx/stub-model`),
			"spelling:",
			"  autocomplete: ngram",
			"",
		].join("\n"),
	);
}, 120_000);

afterAll(async () => {
	await server?.stop();
	await backend?.stop();
});

const headers = () => ({
	"x-omp-webui-token": server.accessToken,
	"x-omp-webui": "1",
	"content-type": "application/json",
});
const sessions = async (): Promise<SessionSummary[]> =>
	(await fetch(`${server.url}/api/sessions`, { headers: headers() })).json();
const titleOf = async (id: string | null) => (await sessions()).find((x) => x.id === id)?.title ?? null;
const choose = async (changes: Record<string, string | null>) => {
	const res = await fetch(`${server.url}/api/prefs`, {
		method: "POST",
		headers: headers(),
		body: JSON.stringify({ changes }),
	});
	expect(res.status).toBe(200);
};

/** A new conversation, one prompt sent, its turn over; the page then lets go of it (`detach`), as a window that is closed does. */
async function firstExchange(options: { detach: boolean }) {
	const ws = await connect(server);
	const live = await request<LiveInfo>(ws, {
		t: "open",
		target: { kind: "new", cwd: server.work, approvalMode: "yolo" },
	});
	const frames = watchFrames(ws, live.liveId);
	const ended = frames.after("agent_end");
	// omp gives no title to a greeting: a first prompt that says what the work is.
	const first = "Please refactor the payment module so that refunds are idempotent";
	await request(ws, { t: "rpc", liveId: live.liveId, command: { type: "prompt", message: first } });
	await ended;
	const sessionId = async () => {
		const state = await request<{ data?: { sessionId?: string }; sessionId?: string }>(ws, {
			t: "rpc",
			liveId: live.liveId,
			command: { type: "get_state" },
		});
		return state.data?.sessionId ?? state.sessionId ?? null;
	};
	const id = await sessionId();
	if (options.detach) ws.send(JSON.stringify({ t: "detach", liveId: live.liveId }));
	return { ws, live, frames, id };
}

const printedTitle = (f: Frame) => f.type === "command_output";

test("a conversation's first exchange is given a title by the server, with no page open on it, and no page is shown what omp printed", async () => {
	title = "A fine title";
	const before = asked();
	const c = await firstExchange({ detach: true });
	await pollUntil(async () => (await titleOf(c.id)) === "A fine title", "the conversation to be listed with its title");
	expect(asked()).toBeGreaterThan(before);
	// What `/rename` printed was the server's to read: the page that was attached to the conversation is shown none of it.
	expect(c.frames.seen.some(printedTitle)).toBe(false);
	await request(c.ws, { t: "close", liveId: c.live.liveId }).catch(() => {});
	c.ws.close();
}, 120_000);

test("a title is asked for once: the next turn of a conversation that has one asks for none", async () => {
	title = "Once only";
	const c = await firstExchange({ detach: false });
	await pollUntil(async () => (await titleOf(c.id)) === "Once only", "the title");
	const asks = asked();
	const ended = c.frames.after("agent_end");
	await request(c.ws, { t: "rpc", liveId: c.live.liveId, command: { type: "prompt", message: "and again" } });
	await ended;
	await Bun.sleep(1500);
	expect(asked()).toBe(asks);
	await request(c.ws, { t: "close", liveId: c.live.liveId }).catch(() => {});
	c.ws.close();
}, 120_000);

test("with automatic titles off in Settings none is asked for", async () => {
	await choose({ "ompw.autoTitle": "off" });
	title = "Never shown";
	const asks = asked();
	const c = await firstExchange({ detach: true });
	await Bun.sleep(2500);
	expect(asked()).toBe(asks);
	expect(await titleOf(c.id)).not.toBe("Never shown");
	await choose({ "ompw.autoTitle": null });
	await request(c.ws, { t: "close", liveId: c.live.liveId }).catch(() => {});
	c.ws.close();
}, 120_000);

test("a title model that gives nothing leaves the conversation unnamed, and it is named once the model answers", async () => {
	title = null;
	const asks = asked();
	const c = await firstExchange({ detach: false });
	await pollUntil(() => asked() > asks, "the first attempt");
	// How often a refusal is retried is `AutoTitle`'s (tests/unit/auto-title.test.ts); here the conversation recovers.
	expect(await titleOf(c.id)).toBeNull();
	title = "At last";
	const ended = c.frames.after("agent_end");
	await request(c.ws, { t: "rpc", liveId: c.live.liveId, command: { type: "prompt", message: "once more" } });
	await ended;
	await pollUntil(
		async () => (await titleOf(c.id)) === "At last",
		"the title a retry or the next turn's end asked for",
	);
	await request(c.ws, { t: "close", liveId: c.live.liveId }).catch(() => {});
	c.ws.close();
}, 180_000);
