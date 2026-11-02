import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import type { LiveInfo } from "../../shared/protocol.ts";
import { watchFrames } from "../support/frames.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type ScriptedRequest, type StubScripted, startScriptedStub } from "../support/stub-scripted.ts";
import { connect, request } from "../support/ws.ts";

/**
 * The advisor per conversation against the real omp: a conversation's own choice is an `advisor.enabled` line in its
 * process's `--config` overlay, which omp reloads by itself and which starts or stops that process's advisor at once. The
 * advisor is omp's own: a second model it asks after a turn, with its `advise` tool. Here every model is a scripted stub,
 * so which turns the advisor reviewed is which requests offered that tool, and what they carried.
 *
 * omp's configuration runs the advisor (`advisor.enabled: true`), so a conversation that chose nothing is reviewed.
 */

let server: TestServer;
let backend: StubScripted;

beforeAll(async () => {
	backend = await startScriptedStub(() => ({ text: "Noted." }));
	server = await startTestServer();
	writeFileSync(
		join(server.agentDir, "models.yml"),
		`providers:\n  omlx:\n    baseUrl: ${backend.url}\n    api: openai-completions\n    apiKey: ${backend.apiKey}\n    discovery:\n      type: openai-models-list\n`,
	);
	writeFileSync(
		join(server.agentDir, "config.yml"),
		[
			"modelRoles:",
			...["default", "smol", "slow", "tiny", "commit", "advisor"].map((r) => `  ${r}: omlx/stub-model`),
			"advisor:",
			"  enabled: true",
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

const api = (path: string, body?: unknown) =>
	fetch(`${server.url}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: { "x-omp-webui-token": server.accessToken, "x-omp-webui": "1", "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});

const listing = async (liveId: string): Promise<LiveInfo | undefined> =>
	((await (await api("/api/lives")).json()) as LiveInfo[]).find((l) => l.liveId === liveId);

/** What the overlay of the conversation's process says of the advisor (the server's own `--config`, last on its command line). */
function overlayAdvisor(liveId: string): unknown {
	const dir = readdirSync(server.tmpDir).find(
		(name) => name.startsWith("ompw-live-") && existsSync(join(server.tmpDir, name, `${liveId}.yml`)),
	);
	expect(dir).toBeDefined();
	const parsed: unknown = Bun.YAML.parse(readFileSync(join(server.tmpDir, dir as string, `${liveId}.yml`), "utf8"));
	return isRecord(parsed) && isRecord(parsed.advisor) ? parsed.advisor.enabled : undefined;
}

/** The requests omp's advisor made: the ones that offer its `advise` tool. */
const reviews = (): ScriptedRequest[] => backend.requests.filter((r) => r.tools.includes("advise"));

/** One new conversation of the test, on its own socket. */
interface Conversation {
	ws: WebSocket;
	liveId: string;
	/** One turn that says `marker`, to its end. */
	turn(marker: string): Promise<void>;
	/** The advisor reviewed the turn that said `marker`. */
	reviewed(marker: string): Promise<void>;
	/** Turn the advisor on or off for the conversation, as its pages do. */
	set(on: boolean): Promise<Response>;
}

async function conversation(target: Record<string, unknown> = {}): Promise<Conversation> {
	const ws = await connect(server);
	const info = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: server.work, ...target } });
	const frames = watchFrames(ws, info.liveId);
	return {
		ws,
		liveId: info.liveId,
		async turn(marker) {
			const end = frames.next((f) => f.type === "agent_end");
			await request(ws, { t: "rpc", liveId: info.liveId, command: { type: "prompt", message: marker } });
			await end;
		},
		reviewed: (marker) => pollUntil(() => reviews().some((r) => r.text.includes(marker)), `a review of ${marker}`),
		set: (on) => api("/api/advisor/live", { liveId: info.liveId, on }),
	};
}

/**
 * The advisor did not review the turn that said `quiet`. Nothing says a review was not made, so the conversation is then
 * reviewed again (`next`, with the advisor on) and that review awaited: a review of `quiet` would have been asked for at
 * that turn's end, before the next one, and every review there is must carry `next`.
 */
async function notReviewed(c: Conversation, quiet: string, next: string) {
	expect((await c.set(true)).status).toBe(200);
	await c.turn(next);
	await c.reviewed(next);
	expect(reviews().filter((r) => r.text.includes(quiet) && !r.text.includes(next))).toEqual([]);
}

test("omp's own value is what a new chat starts at", async () => {
	expect(await (await api("/api/advisor")).json()).toEqual({ omp: true });
});

test("a conversation started with the advisor off is not reviewed; turned on and off, its next turns follow at once", async () => {
	const c = await conversation({ advisor: false });
	try {
		expect(overlayAdvisor(c.liveId)).toBe(false);
		expect((await listing(c.liveId))?.advisor).toBe(false);
		await c.turn("TURN-OFF-1");
		await notReviewed(c, "TURN-OFF-1", "TURN-ON-2");
		expect(overlayAdvisor(c.liveId)).toBe(true);
		expect((await listing(c.liveId))?.advisor).toBe(true);

		// Off again, live: the advisor stops, and what it wrote stays.
		expect((await c.set(false)).status).toBe(200);
		expect(overlayAdvisor(c.liveId)).toBe(false);
		await pollUntil(async () => (await listing(c.liveId))?.advisor === false, "the pages to be told");
		await c.turn("TURN-OFF-3");
		await notReviewed(c, "TURN-OFF-3", "TURN-ON-4");

		for (const bad of [{ liveId: c.liveId, on: "no" }, { liveId: c.liveId }]) {
			expect((await api("/api/advisor/live", bad)).status).toBe(422);
		}
		expect((await api("/api/advisor/live", { liveId: "nope", on: true })).status).toBe(404);
	} finally {
		c.ws.close();
	}
}, 120_000);

test("a conversation that chose nothing follows omp's configuration", async () => {
	const c = await conversation();
	try {
		expect(overlayAdvisor(c.liveId)).toBeUndefined();
		expect((await listing(c.liveId))?.advisor).toBeUndefined();
		await c.turn("TURN-DEFAULT");
		await c.reviewed("TURN-DEFAULT");
	} finally {
		c.ws.close();
	}
}, 120_000);

test("the choice is the conversation's: it is opened again with it, after the server restarted too", async () => {
	const c = await conversation({ advisor: false });
	let file: string;
	try {
		await c.turn("TURN-KEPT");
		await pollUntil(async () => Boolean((await listing(c.liveId))?.sessionFile), "the session file");
		file = (await listing(c.liveId))?.sessionFile as string;
		await request(c.ws, { t: "close", liveId: c.liveId });
	} finally {
		c.ws.close();
	}
	const reopen = async () => {
		const ws = await connect(server);
		try {
			const info = await request<LiveInfo>(ws, { t: "open", target: { kind: "resume", sessionFile: file } });
			expect(info.advisor).toBe(false);
			expect(overlayAdvisor(info.liveId)).toBe(false);
			await request(ws, { t: "close", liveId: info.liveId });
		} finally {
			ws.close();
		}
	};
	await reopen();
	await server.restart();
	await reopen();
}, 120_000);

test("the panel's star makes the shown value omp's own", async () => {
	const c = await conversation({ advisor: false });
	try {
		const star = await api("/api/controls/default", { live: c.liveId, setting: "advisor", value: "off" });
		expect(star.status).toBe(200);
		expect(readFileSync(join(server.agentDir, "config.yml"), "utf8")).toMatch(
			/advisor:\n(?:\s+\w+: .*\n)*\s+enabled: false/,
		);
		expect(await (await api("/api/advisor")).json()).toEqual({ omp: false });
		// The conversation keeps its own choice, and the page reads what it runs with.
		const settings = await (await api("/api/controls/settings", { live: c.liveId })).json();
		expect(settings).toMatchObject({ advisor: "off" });
	} finally {
		c.ws.close();
	}
}, 120_000);
