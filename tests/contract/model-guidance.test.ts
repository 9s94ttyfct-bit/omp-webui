import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import type { LiveInfo, LiveListing } from "../../shared/protocol.ts";
import { watchFrames } from "../support/frames.ts";
import { lanAddress, rawSocket } from "../support/lan-peer.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type ScriptedTurn, type StubScripted, startScriptedStub } from "../support/stub-scripted.ts";
import { connect, request } from "../support/ws.ts";

/**
 * Model guidance (#641) against the real omp: what the person picks for a conversation reaches the **provider request of the
 * main agent**, from the first turn, and is absent from a subagent's request and from a conversation started without it. No
 * model is called: a scripted provider answers, and the requests it was sent are read.
 *
 * The mechanism (measured here, and the reason `shared/model-guidance.ts` says why the flags were not used): the server starts
 * the conversation's omp with `--extension <data dir>/guidance/…/extension.ts`, and the extension appends the text of
 * `$OMPW_GUIDANCE_FILE` to the main agent's system prompt at each turn.
 */

const MARK = "GUIDANCE-MARKER-641: at most 1 Sonnet subagent at a time.";
const SUBAGENT = "You are operating on a piece of work assigned to you by the main agent";

let server: TestServer;
let backend: StubScripted;
/** The prompts each test sends: a request is found by the one it carries, not by its place (other conversations run too). */
let seq = 0;

/** What the scripted subagent reports. The task it is given never says it, so a request that carries it is one made after the report came. */
const REPORT = "SCOUT-REPORT-648";

/** What a test holds back from the scripted model, by the conversation's tag, until it lets go. */
const holds = new Map<string, { subagent?: Promise<void>; main?: Promise<void> }>();

const script = async (req: { text: string; tools: string[]; toolResults: number }): Promise<ScriptedTurn> => {
	// Which of a test's conversations this is: the word in the prompt the test sent (`PROMPT-641-<tag>-<n>`) for the main
	// agent, and the word its task call repeats (`tag:<tag>`) for the subagent.
	const tag = /PROMPT-641-([a-z]+)-\d+/.exec(req.text)?.[1] ?? /tag:([a-z]+)/.exec(req.text)?.[1] ?? "";
	// The subagent's prompt says the nested word; the main agent's does not.
	if (req.text.includes(SUBAGENT)) {
		await holds.get(tag)?.subagent;
		return { text: REPORT };
	}
	// A title's request offers no task tool.
	if (!req.tools.includes("task")) return { text: "A title" };
	if (req.toolResults === 0)
		return {
			call: {
				name: "task",
				args: { context: "# Goal\nShared.", tasks: [{ name: "Scout", task: `Report back. tag:${tag}` }] },
			},
		};
	// The main agent's answer to the notice that the subagent started, before the report comes.
	if (!req.text.includes(REPORT)) await holds.get(tag)?.main;
	return { text: "The scout reported." };
};

beforeAll(async () => {
	backend = await startScriptedStub(script);
	server = await startTestServer();
	writeFileSync(
		join(server.agentDir, "models.yml"),
		`providers:\n  omlx:\n    baseUrl: ${backend.url}\n    api: openai-completions\n    apiKey: ${backend.apiKey}\n    discovery:\n      type: openai-models-list\n`,
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

/**
 * The latest request the main agent of a conversation made that carries every one of `marks`: the prompt the test sent and,
 * for a request made after the subagent's report, the report. A subagent's own request is never the one: it offers the task
 * tool too and repeats what it was asked, so selecting by those finds it, and finds it first in the moment between its
 * request and the main agent's next (#648).
 */
async function mainRequestFor(...marks: string[]): Promise<{ text: string }> {
	const matching = () =>
		backend.requests.findLast(
			(r) => !r.text.includes(SUBAGENT) && r.tools.includes("task") && marks.every((m) => r.text.includes(m)),
		);
	await pollUntil(
		() => matching() !== undefined,
		`a request of the main agent that carries ${marks.join(" and ")}`,
		40_000,
	);
	const found = matching();
	if (!found) throw new Error("unreachable");
	return found;
}

/** Wait until a conversation's omp has nothing going on: no turn running, and no subagent's work or report still to come. */
async function idle(ws: WebSocket, liveId: string): Promise<void> {
	await pollUntil(
		async () => {
			const reply = await request<unknown>(ws, { t: "rpc", liveId, command: { type: "get_state" } });
			const state = isRecord(reply) && isRecord(reply.data) ? reply.data : reply;
			return isRecord(state) && state.isStreaming === false && state.hasPendingAsyncWork === false;
		},
		"the conversation to be idle",
		40_000,
	);
}

const prompt = (what: string) => `PROMPT-641-${what}-${++seq}`;

test("a conversation started with guidance carries it in the main agent's request, and its subagent's request does not", async () => {
	const ws = await connect(server);
	const info = await request<LiveInfo>(ws, {
		t: "open",
		target: { kind: "new", cwd: server.work, guidance: { text: MARK } },
	});
	// What the page is told: the text, live (its omp runs the extension), and no template (it was typed).
	expect(info.guidance).toEqual({ template: null, templateName: null, text: MARK, live: true });
	// And the process says so in its command line.
	expect(info.args.filter((_, i) => info.args[i - 1] === "--extension").some((a) => a.includes("/guidance/"))).toBe(
		true,
	);
	const mark = prompt("with");
	await request(ws, { t: "rpc", liveId: info.liveId, command: { type: "prompt", message: mark } });
	expect((await mainRequestFor(mark)).text).toContain(MARK);
	// The subagent's own prompt does not: the guidance is about how the main agent hands work out, not an instruction to
	// the subagent about itself.
	await pollUntil(() => backend.requests.some((r) => r.text.includes(SUBAGENT)), "the subagent's request", 40_000);
	const sub = backend.requests.filter((r) => r.text.includes(SUBAGENT));
	expect(sub.length).toBeGreaterThan(0);
	for (const r of sub) expect(r.text).not.toContain(MARK);
	// The main agent's next request, the one that carries the subagent's report, has it too: the report's turn is one omp
	// starts by itself, and the prompt it is built on is the one this conversation already holds (see the two tests below).
	expect((await mainRequestFor(mark, REPORT)).text).toContain(MARK);
	ws.close();
}, 240_000);

/**
 * What turn the report of a subagent comes back in (#648), measured against omp 18.12.6: omp starts it itself, with nobody's
 * prompt, and does not run the extensions' `before_agent_start` for it, so it carries the system prompt the conversation's
 * last turn had. These two tests hold the subagent (or the main agent's answer) until the test lets go, so that each of the
 * ways the report reaches the main agent is exercised on purpose and not by the timing of a run, and in both the request
 * that carries the report must carry the guidance. The first is also the moment the old selection of this file's first test
 * tripped on: the subagent's own request is on record and the main agent's request that carries its report is not yet.
 */
test("a subagent's report that comes after the main agent's turn is over starts a turn that carries the guidance", async () => {
	const answer = Promise.withResolvers<void>();
	holds.set("after", { subagent: answer.promise });
	const ws = await connect(server);
	const info = await request<LiveInfo>(ws, {
		t: "open",
		target: { kind: "new", cwd: server.work, guidance: { text: MARK } },
	});
	const frames = watchFrames(ws, info.liveId);
	const ended = frames.after("agent_end");
	const mark = prompt("after");
	await request(ws, { t: "rpc", liveId: info.liveId, command: { type: "prompt", message: mark } });
	// The main agent's turn is over, and the subagent is asked and has not answered: there is no report anywhere yet.
	await ended;
	await pollUntil(
		() => backend.requests.some((r) => r.text.includes(SUBAGENT) && r.text.includes("tag:after")),
		"the subagent's request",
		40_000,
	);
	expect(backend.requests.some((r) => r.text.includes(mark) && r.text.includes(REPORT))).toBe(false);
	answer.resolve();
	expect((await mainRequestFor(mark, REPORT)).text).toContain(MARK);
	ws.close();
}, 120_000);

test("a subagent's report that is ready while the main agent's turn is still going reaches the turn that follows, with the guidance", async () => {
	const answer = Promise.withResolvers<void>();
	holds.set("during", { main: answer.promise });
	const ws = await connect(server);
	const info = await request<LiveInfo>(ws, {
		t: "open",
		target: { kind: "new", cwd: server.work, guidance: { text: MARK } },
	});
	const frames = watchFrames(ws, info.liveId);
	const mark = prompt("during");
	await request(ws, { t: "rpc", liveId: info.liveId, command: { type: "prompt", message: mark } });
	// The subagent is done while the main agent's own answer is held back: its report is ready before that turn ends.
	await frames.next((f) => isRecord(f.payload) && f.type === "subagent_lifecycle" && f.payload.status === "completed");
	answer.resolve();
	expect((await mainRequestFor(mark, REPORT)).text).toContain(MARK);
	ws.close();
}, 120_000);

test("a conversation started without guidance carries none, though its omp was started with the extension", async () => {
	const ws = await connect(server);
	const info = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: server.work } });
	expect(info.guidance).toBeUndefined();
	// The extension is still started (it adds nothing without a file): one command line for every conversation.
	expect(info.args.filter((_, i) => info.args[i - 1] === "--extension").some((a) => a.includes("/guidance/"))).toBe(
		true,
	);
	const mark = prompt("without");
	await request(ws, { t: "rpc", liveId: info.liveId, command: { type: "prompt", message: mark } });
	expect((await mainRequestFor(mark)).text).not.toContain(MARK);
	ws.close();
}, 120_000);

test("a template picked by id carries the text it stands for now, and turning it off reaches the next turn", async () => {
	const ws = await connect(server);
	const res = await fetch(`${server.url}/api/model-guidance`, {
		method: "POST",
		headers: { "x-omp-webui-token": server.accessToken, "x-omp-webui": "1", "content-type": "application/json" },
		body: JSON.stringify({ template: { id: "contract-template", name: "Contract", text: MARK } }),
	});
	expect(res.status).toBe(200);
	expect(((await res.json()) as { templates: { id: string; text: string }[] }).templates).toContainEqual(
		expect.objectContaining({ id: "contract-template", text: MARK }),
	);

	const info = await request<LiveInfo>(ws, {
		t: "open",
		target: { kind: "new", cwd: server.work, guidance: { template: "contract-template" } },
	});
	expect(info.guidance?.template).toBe("contract-template");
	expect(info.guidance?.templateName).toBe("Contract");
	expect(info.guidance?.text).toBe(MARK);
	const first = prompt("template");
	await request(ws, { t: "rpc", liveId: info.liveId, command: { type: "prompt", message: first } });
	expect((await mainRequestFor(first)).text).toContain(MARK);
	// The subagent's report starts a turn of its own: the next prompt goes in once that is over (omp refuses one sent into a turn).
	await mainRequestFor(first, REPORT);
	await idle(ws, info.liveId);

	// Turned off, the text is gone from the next turn: the extension reads the file at each turn.
	const off = await fetch(`${server.url}/api/model-guidance/live`, {
		method: "POST",
		headers: { "x-omp-webui-token": server.accessToken, "x-omp-webui": "1", "content-type": "application/json" },
		body: JSON.stringify({ liveId: info.liveId, guidance: null }),
	});
	expect(off.status).toBe(200);
	expect(((await off.json()) as { guidance?: unknown }).guidance).toBeUndefined();
	const second = prompt("off");
	await request(ws, { t: "rpc", liveId: info.liveId, command: { type: "prompt", message: second } });
	expect((await mainRequestFor(second)).text).not.toContain(MARK);
	ws.close();
}, 240_000);

test("the guidance file is in the conversation's own folder under the data dir, holds the text, and goes when turned off", async () => {
	const ws = await connect(server);
	const info = await request<LiveInfo>(ws, {
		t: "open",
		target: { kind: "new", cwd: server.work, guidance: { text: MARK } },
	});
	// The conversation's overlay is one `ompw-live-*` file in the test's temp dir, named after the process; its guidance
	// file is beside it.
	const found = readdirSync(server.tmpDir, { recursive: true, encoding: "utf8" }).filter((f) =>
		f.endsWith(`${info.liveId}.yml.guidance.md`),
	);
	expect(found).toHaveLength(1);
	const file = join(server.tmpDir, found[0] as string);
	expect(readFileSync(file, "utf8")).toBe(`${MARK}\n`);
	expect(statSync(file).mode & 0o777).toBe(0o600);
	// Turned off, the file is taken away: the extension adds nothing at all from the next turn (no empty block).
	const off = await fetch(`${server.url}/api/model-guidance/live`, {
		method: "POST",
		headers: { "x-omp-webui-token": server.accessToken, "x-omp-webui": "1", "content-type": "application/json" },
		body: JSON.stringify({ liveId: info.liveId, guidance: null }),
	});
	expect(off.status).toBe(200);
	expect(existsSync(file)).toBe(false);
	ws.close();
}, 120_000);

const LAN = lanAddress();
if (LAN === undefined)
	console.warn("model-guidance: no IPv4 address on a network, so the case of a page on the network is skipped");

/** Open `target` the way `ws` does, and the process it started is closed again (nothing in these tests needs it). */
const openAndClose = async (ws: WebSocket, target: Record<string, unknown>): Promise<LiveInfo> => {
	const info = await request<LiveInfo>(ws, { t: "open", target });
	await request(ws, { t: "close", liveId: info.liveId }).catch(() => {});
	return info;
};

(LAN === undefined ? test.skip : test)(
	"a page on the network may pick a template but cannot write the text of a conversation's guidance",
	async () => {
		const TYPED = "GUIDANCE-TYPED-BY-A-NETWORK-PAGE-641";
		const post = await fetch(`${server.url}/api/model-guidance`, {
			method: "POST",
			headers: { "x-omp-webui-token": server.accessToken, "x-omp-webui": "1", "content-type": "application/json" },
			body: JSON.stringify({ template: { id: "remote-template", name: "Remote can pick", text: MARK } }),
		});
		expect(post.status).toBe(200);
		const socket = await rawSocket({
			host: "127.0.0.1",
			port: Number(new URL(server.url).port),
			from: LAN,
			headers: { origin: server.url, cookie: `ompw_token=${server.accessToken}` },
		});
		if (!socket) throw new Error("the server refused the socket of a page on the network");
		const page = socket as unknown as WebSocket;
		const count = async () => (await request<unknown[]>(page, { t: "list_lives" })).length;
		try {
			const before = await count();
			// Text a page on the network wrote is refused, and no process is started for it.
			await expect(
				request(page, { t: "open", target: { kind: "new", cwd: server.work, guidance: { text: TYPED } } }),
			).rejects.toThrow(/computer omp-webui runs on/);
			expect(await count()).toBe(before);

			// A template it picked is the text the store has for it, whatever else the page says along with the id.
			const picked = await openAndClose(page, {
				kind: "new",
				cwd: server.work,
				guidance: { template: "remote-template", text: TYPED },
			});
			expect(picked.guidance?.template).toBe("remote-template");
			expect(picked.guidance?.text).toBe(MARK);

			// A template the store does not have, with text beside it, is not a way to get the text in.
			const unknown = await openAndClose(page, {
				kind: "new",
				cwd: server.work,
				guidance: { template: "no-such-template", text: TYPED },
			});
			expect(unknown.guidance).toBeUndefined();

			// A page that is this computer's may write it.
			const here = await connect(server);
			const written = await openAndClose(here, { kind: "new", cwd: server.work, guidance: { text: TYPED } });
			expect(written.guidance?.text).toBe(TYPED);
			here.close();
		} finally {
			socket.close();
		}
	},
	120_000,
);

test("what a new conversation was given outlives its process, can be changed while it has none, and is carried when it is resumed", async () => {
	const RESUME = "GUIDANCE-RESUME-MARKER-641: one subagent only.";
	const ws = await connect(server);
	const info = await request<LiveInfo>(ws, {
		t: "open",
		target: { kind: "new", cwd: server.work, guidance: { text: RESUME } },
	});
	expect(info.guidance?.text).toBe(RESUME);
	const first = prompt("resume-first");
	await request(ws, { t: "rpc", liveId: info.liveId, command: { type: "prompt", message: first } });
	expect((await mainRequestFor(first)).text).toContain(RESUME);
	const listing = async () =>
		(await request<LiveListing[]>(ws, { t: "list_lives" })).find((l) => l.liveId === info.liveId);
	// The subagent's report starts a turn of its own: the process is closed once that is over too.
	await mainRequestFor(first, REPORT);
	await idle(ws, info.liveId);
	await pollUntil(async () => (await listing())?.busy === false, "the first turn to end", 60_000);
	const file = (await listing())?.sessionFile ?? "";
	expect(file).not.toBe("");

	await request(ws, { t: "close", liveId: info.liveId });
	await pollUntil(async () => {
		const l = await listing();
		return !l || l.exited;
	}, "the process to end");

	// With no process, the choice kept for the file is what a page asks for.
	const kept = await fetch(`${server.url}/api/model-guidance/session?file=${encodeURIComponent(file)}`, {
		headers: { "x-omp-webui-token": server.accessToken },
	});
	expect(kept.status).toBe(200);
	expect(((await kept.json()) as { guidance: { text: string } | null }).guidance?.text).toBe(RESUME);

	// Changed while it has no process (#715): the change is what it carries when it is opened next.
	const EDITED = "GUIDANCE-EDITED-MARKER-715: two subagents at most.";
	const changed = await fetch(`${server.url}/api/model-guidance/live`, {
		method: "POST",
		headers: { "x-omp-webui-token": server.accessToken, "content-type": "application/json", "x-omp-webui": "1" },
		body: JSON.stringify({ file, guidance: { text: EDITED } }),
	});
	expect(changed.status).toBe(200);
	expect(((await changed.json()) as { guidance: { text: string; live: boolean } | null }).guidance).toMatchObject({
		text: EDITED,
		live: false,
	});

	// Resumed, the page says nothing of the guidance, and the conversation carries the edited text.
	const again = await request<LiveInfo>(ws, { t: "open", target: { kind: "resume", sessionFile: file } });
	expect(again.liveId).not.toBe(info.liveId);
	expect(again.guidance?.text).toBe(EDITED);
	expect(again.guidance?.live).toBe(true);
	const second = prompt("resume-second");
	await request(ws, { t: "rpc", liveId: again.liveId, command: { type: "prompt", message: second } });
	const resumed = (await mainRequestFor(second)).text;
	expect(resumed).toContain(EDITED);
	expect(resumed).not.toContain(RESUME);
	ws.close();
}, 300_000);
