import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShellMessage } from "../../server/shell-events.ts";
import { GUARD_UNAVAILABLE, type GuardConfig, type GuardDecision } from "../../shared/guard.ts";
import { isRecord } from "../../shared/guards.ts";
import type { LiveInfo, SessionSummary } from "../../shared/protocol.ts";
import { parseRiskTitle, RISK_ALLOW, RISK_DENY } from "../../shared/risk-confirm.ts";
import { type AccessKey, type Jwks, makeKey, startJwks } from "../support/access-jwt.ts";
import { type Frame, messageWhere, watchFrames } from "../support/frames.ts";
import { pollUntil } from "../support/poll.ts";
import { remoteClient, remoteSettings } from "../support/remote-client.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import {
	type ScriptedRequest,
	type ScriptedTurn,
	type StubScripted,
	startScriptedStub,
} from "../support/stub-scripted.ts";
import { connect, request } from "../support/ws.ts";

/**
 * "Guard dangerous commands" (#609) against the real omp (18.12) and the real server. The agent (the main agent and its
 * subagent) and the reviewer are scripted providers: no model is called. A risky call is one that the classifier knows
 * and that is harmless here: a file written outside the project folder, inside the folder this test made. A call that
 * must be refused is one whose refusal is the thing under test: it targets only a folder this test made, and when the
 * guard fails it is that folder that is changed, nothing else.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-guard-contract-"));
const outside = join(root, "outside");
const settingsFile = join(root, "remote.json");
const dist = join(root, "dist");
let s: TestServer;
let key: AccessKey;
let jwks: Jwks;
let agent: StubScripted;
let reviewer: StubScripted;

const NESTED = "You are operating on a piece of work assigned to you by the main agent";
interface Call {
	name: string;
	args: unknown;
}

/** What the scripted agents do next: one tool call each, taken once. */
const plan: { main: Call | null; sub: Call | null } = { main: null, sub: null };
/** What the tools answered, as the agents were told (the main agent's and the subagent's). */
const toldMain: string[] = [];
const toldSub: string[] = [];

const agentScript = async (req: ScriptedRequest): Promise<ScriptedTurn> => {
	const messages = JSON.parse(req.text) as { role?: string; content?: unknown }[];
	const last = messages.at(-1);
	if (req.text.includes(NESTED)) {
		if (last?.role === "tool") {
			toldSub.push(String(last.content));
			return { text: "SUB-DONE" };
		}
		const next = plan.sub;
		plan.sub = null;
		return next ? { call: next } : { text: "SUB-NOTHING" };
	}
	if (!req.tools.includes("write")) return { text: "A title" };
	if (last?.role === "tool") {
		toldMain.push(String(last.content));
		return { text: "Main done." };
	}
	const next = plan.main;
	plan.main = null;
	return next ? { call: next } : { text: "Nothing to do." };
};

/** What the scripted reviewers answer: by the model the request names, else for any. */
let reviewing: (req: ScriptedRequest) => ScriptedTurn = () => ({ text: '{"decision":"allow"}' });
const reviewerScript = (req: ScriptedRequest): ScriptedTurn => reviewing(req);
const allow = (): ScriptedTurn => ({ text: '{"decision":"allow"}' });
const deny = (reason = "that deletes files the person did not name"): ScriptedTurn => ({
	text: JSON.stringify({ decision: "deny", reason }),
});
/**
 * A reviewer at its usage limit. The limit ends in ten minutes: omp's transport waits out a 429 that ends within a minute by
 * itself, five times over, so a limit of a second made each review of an unreachable reviewer six requests and five seconds
 * of waiting, which a loaded machine stretched past the gate's 30 s for one model ("Request was aborted").
 */
const down = (): ScriptedTurn => ({
	refuse: { retryAfterMs: 600_000, status: 429, message: "You have reached your usage limit." },
});

const authed = (extra: Record<string, string> = {}) => ({
	"x-omp-webui-token": s.accessToken,
	"x-omp-webui": "1",
	...extra,
});
const setGuard = async (patch: Partial<GuardConfig>): Promise<GuardConfig> => {
	const res = await fetch(`${s.url}/api/guard`, {
		method: "POST",
		headers: authed({ "content-type": "application/json" }),
		body: JSON.stringify(patch),
	});
	expect(res.status).toBe(200);
	return ((await res.json()) as { config: GuardConfig }).config;
};
const log = async (limit = 100): Promise<GuardDecision[]> => {
	const res = await fetch(`${s.url}/api/guard/log?limit=${limit}`, { headers: authed() });
	expect(res.status).toBe(200);
	return ((await res.json()) as { decisions: GuardDecision[] }).decisions.reverse();
};
/** The decisions from the `n`th on (oldest first), once there are that many. */
async function decisionsFrom(n: number, count = 1): Promise<GuardDecision[]> {
	let found: GuardDecision[] = [];
	await pollUntil(async () => {
		found = (await log()).slice(n);
		return found.length >= count;
	}, `${count} decision(s) from the ${n}th`);
	return found;
}

beforeAll(async () => {
	key = await makeKey("kid-1");
	jwks = await startJwks([key]);
	mkdirSync(join(dist, "assets"), { recursive: true });
	writeFileSync(
		join(dist, "index.html"),
		'<!doctype html>\n<html><head></head><body><div id="root"></div></body></html>\n',
	);
	mkdirSync(outside, { recursive: true });
	writeFileSync(settingsFile, JSON.stringify(remoteSettings()));
	agent = await startScriptedStub(agentScript);
	reviewer = await startScriptedStub(reviewerScript);
	s = await startTestServer(
		0,
		{ OMP_WEBUI_REMOTE_CONFIG: settingsFile, OMP_WEBUI_ACCESS_CERTS_URL: jwks.url, OMP_WEBUI_DIST: dist },
		{ login: false },
	);
	// The reviewer's models are priced, so that what a review costs is a number the totals can be checked against.
	const priced = "        cost: { input: 1000, output: 2000, cacheRead: 0, cacheWrite: 0 }";
	writeFileSync(
		join(s.agentDir, "models.yml"),
		[
			"providers:",
			"  omlx:",
			`    baseUrl: ${agent.url}`,
			"    api: openai-completions",
			`    apiKey: ${agent.apiKey}`,
			"    models:",
			"      - id: stub-model",
			"  revco:",
			`    baseUrl: ${reviewer.url}`,
			"    api: openai-completions",
			`    apiKey: ${reviewer.apiKey}`,
			"    models:",
			"      - id: stub-reviewer",
			priced,
			"      - id: stub-reviewer-2",
			priced,
			"",
		].join("\n"),
	);
	writeFileSync(
		join(s.agentDir, "config.yml"),
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
	await s?.stop();
	await agent?.stop();
	await reviewer?.stop();
	jwks?.stop();
	rmSync(root, { recursive: true, force: true });
});

// ------------------------------------------------------------------ one conversation

/** What one tab is told of a process's frames (see `watchFrames`). */
interface Watched {
	seen: Frame[];
	next(match: (f: Frame) => boolean): Promise<Frame>;
	after(type: string): Promise<Frame>;
}

interface Conversation {
	live: LiveInfo;
	ws: WebSocket;
	frames: Watched;
	close(): Promise<void>;
}

async function conversation(args: string[] = []): Promise<Conversation> {
	const ws = await connect(s);
	const live = await request<LiveInfo>(ws, {
		t: "open",
		target: { kind: "new", cwd: s.work, approvalMode: "yolo", args },
	});
	const frames = watchFrames(ws, live.liveId);
	return {
		live,
		ws,
		frames,
		close: async () => {
			await request(ws, { t: "close", liveId: live.liveId }).catch(() => {});
			ws.close();
		},
	};
}

const prompt = (c: Conversation, message = "go") =>
	request(c.ws, { t: "rpc", liveId: c.live.liveId, command: { type: "prompt", message } });

/** The first frame from now on that satisfies `match` (frames the conversation had before this call do not count). */
const fresh = (c: Conversation, match: (f: Frame) => boolean): Promise<Frame> => {
	const from = c.frames.seen.length;
	return c.frames.next((f) => c.frames.seen.indexOf(f) >= from && match(f));
};

let workers = 0;
/** The main agent starts a subagent (a new one each time) whose first act is `call`, and the turn runs on until it is over. */
async function subagentDoes(c: Conversation, call: Call): Promise<string> {
	const name = `Worker${++workers}`;
	plan.main = {
		name: "task",
		args: { context: "One worker.", tasks: [{ name, task: "WORKER-TASK: do the one thing." }] },
	};
	plan.sub = call;
	const done = fresh(
		c,
		(f) =>
			f.type === "subagent_lifecycle" &&
			isRecord(f.payload) &&
			f.payload.id === name &&
			f.payload.status === "completed",
	);
	await prompt(c);
	await done;
	// The subagent's report starts one more turn of the main agent: it is over before the conversation takes another message.
	await fresh(c, (f) => f.type === "agent_end");
	return name;
}

/** The main agent makes `call` itself, and the turn runs to its end, answering the question the gate asks with `answer`. */
async function mainDoes(c: Conversation, call: Call, answer?: string | null): Promise<Frame | null> {
	plan.main = call;
	const ended = fresh(c, (f) => f.type === "agent_end");
	let asked: Frame | null = null;
	const question = (f: Frame) =>
		f.type === "extension_ui_request" &&
		f.method === "select" &&
		String(f.title ?? "").startsWith("Confirm risky call:");
	if (answer !== undefined) {
		const waiting = fresh(c, question);
		void waiting.then((f) => {
			asked = f;
			if (answer !== null)
				c.ws.send(JSON.stringify({ t: "ui_response", liveId: c.live.liveId, response: { id: f.id, value: answer } }));
			else
				c.ws.send(JSON.stringify({ t: "ui_response", liveId: c.live.liveId, response: { id: f.id, cancelled: true } }));
		});
	}
	await prompt(c);
	await ended;
	return asked;
}

const write = (name: string) => ({ name: "write", args: { path: join(outside, name), content: "from the agent" } });
const lastSub = () => toldSub.at(-1) ?? "";

// ------------------------------------------------------------------ a subagent's risky call

describe("a subagent's risky call is decided by the reviewer", () => {
	test("allowed: it runs, is written down with who said so and what it cost, and the cost is in the conversation's totals", async () => {
		await setGuard({ mode: "reviewer", reviewer: "revco/stub-reviewer" });
		reviewing = allow;
		const before = (await log()).length;
		const c = await conversation();
		const decisionPushed = messageWhere(c.ws, (m) => m.t === "guard_decision");
		await subagentDoes(c, write("allowed.txt"));
		expect(readFileSync(join(outside, "allowed.txt"), "utf8")).toBe("from the agent");
		const [d] = await decisionsFrom(before);
		expect(d).toMatchObject({
			verdict: "allow",
			by: "reviewer",
			model: "revco/stub-reviewer",
			tried: ["revco/stub-reviewer"],
			tool: "write",
			subagent: true,
			agent: expect.stringMatching(/^Worker\d+$/),
			mode: "reviewer",
		});
		expect(d.kinds).toContain("write_outside");
		expect(d.detail).toContain(join(outside, "allowed.txt"));
		expect(d.usage).toMatchObject({ input: 10, output: 2, requests: 1 });
		expect(d.usage?.cost).toBeCloseTo((10 * 1000 + 2 * 2000) / 1e6, 9);
		expect(d.toolCallId).not.toBe("");
		// What the reviewer was told: the exact path, as data, and the rules it judges by.
		const asked = reviewer.requests.at(-1);
		expect(asked?.model).toBe("stub-reviewer");
		expect(asked?.text).toContain(join(outside, "allowed.txt"));
		expect(asked?.text).toContain("UNTRUSTED DATA");
		// A page on this computer is told as it happens.
		expect(((await decisionPushed).decision as GuardDecision).id).toBe(d.id);

		// Its own session's id: the agent whose call it was is the subagent, not the conversation.
		// The header is the line of type `session` (a title slot comes first).
		const header = (file: string): string | null => {
			for (const line of readFileSync(file, "utf8").split("\n").slice(0, 4)) {
				try {
					const entry: unknown = JSON.parse(line);
					if (isRecord(entry) && entry.type === "session" && typeof entry.id === "string") return entry.id;
				} catch {
					// Not a whole line yet.
				}
			}
			return null;
		};
		let mine: string[] = [];
		await pollUntil(() => {
			mine = jsonl(s.agentDir).filter((f) => header(f) === d.session);
			return mine.length === 1;
		}, "the subagent's transcript, whose header holds the session id of the decision");
		// The spend is in that transcript as a `model_usage` record: the totals of the conversation read it from there.
		await pollUntil(
			() => readFileSync(mine[0], "utf8").includes('"purpose":"guard"'),
			"the reviewer's spend in the subagent's transcript",
		);
		const records = readFileSync(mine[0], "utf8")
			.split("\n")
			.filter((l) => l.includes('"model_usage"'))
			.map(
				(l) =>
					JSON.parse(l) as {
						purpose?: string;
						role?: string;
						provider?: string;
						model?: string;
						usage?: { input?: number; cost?: { total?: number } };
					},
			);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ purpose: "guard", role: "reviewer", provider: "revco", model: "stub-reviewer" });
		expect(records[0].usage?.input).toBe(10);
		await c.close();
		const res = await fetch(`${s.url}/api/sessions`, { headers: authed() });
		const sessions = (await res.json()) as SessionSummary[];
		const own = sessions.find((x) => x.file === c.live.sessionFile || x.id === c.live.sessionId);
		if (own) expect(own.subagentUsage.cost).toBeGreaterThanOrEqual(d.usage?.cost ?? 0);
	}, 120_000);

	test("denied: it does not run, the agent is told why in the reviewer's words, and asking again is not another chance", async () => {
		await setGuard({ mode: "reviewer", reviewer: "revco/stub-reviewer" });
		reviewing = () => deny("that deletes files the person did not name");
		const before = (await log()).length;
		const c = await conversation();
		toldSub.length = 0;
		await subagentDoes(c, write("denied.txt"));
		expect(existsSync(join(outside, "denied.txt"))).toBe(false);
		expect(lastSub()).toContain("denied this call");
		expect(lastSub()).toContain("that deletes files the person did not name");
		expect(lastSub()).toContain("It was not run");
		expect(lastSub().startsWith(GUARD_UNAVAILABLE)).toBe(false);
		const [d] = await decisionsFrom(before);
		expect(d).toMatchObject({
			verdict: "deny",
			by: "reviewer",
			model: "revco/stub-reviewer",
			reason: "that deletes files the person did not name",
		});
		await c.close();
	}, 120_000);

	test("the reviewer down: refused as `reviewer unavailable`, not judged, and the reviewer's chain is tried first", async () => {
		await setGuard({ mode: "reviewer", reviewer: "revco/stub-reviewer,revco/stub-reviewer-2" });
		// The first cannot be reached (a usage limit); the second says yes.
		reviewing = (req) => (req.model === "stub-reviewer" ? down() : allow());
		let before = (await log()).length;
		const c = await conversation();
		await subagentDoes(c, write("fallback.txt"));
		expect(existsSync(join(outside, "fallback.txt"))).toBe(true);
		let [d] = await decisionsFrom(before);
		expect(d).toMatchObject({
			verdict: "allow",
			model: "revco/stub-reviewer-2",
			tried: ["revco/stub-reviewer", "revco/stub-reviewer-2"],
		});

		// Both cannot be reached.
		reviewing = down;
		before = (await log()).length;
		toldSub.length = 0;
		await subagentDoes(c, write("unavailable.txt"));
		expect(existsSync(join(outside, "unavailable.txt"))).toBe(false);
		expect(lastSub().startsWith(GUARD_UNAVAILABLE)).toBe(true);
		expect(lastSub()).toContain("not judged");
		expect(lastSub()).toContain("usage limit");
		[d] = await decisionsFrom(before);
		expect(d).toMatchObject({
			verdict: "unavailable",
			by: "guard",
			subagent: true,
			tried: ["revco/stub-reviewer", "revco/stub-reviewer-2"],
		});

		// An answer that is not a verdict is the same: never a yes.
		reviewing = () => ({ text: "Looks fine to me, go ahead!" });
		before = (await log()).length;
		toldSub.length = 0;
		await subagentDoes(c, write("garbage.txt"));
		expect(existsSync(join(outside, "garbage.txt"))).toBe(false);
		expect(lastSub().startsWith(GUARD_UNAVAILABLE)).toBe(true);
		[d] = await decisionsFrom(before);
		expect(d.verdict).toBe("unavailable");
		await c.close();
	}, 180_000);

	test("a reviewer that names a model that is not signed in is no reviewer: refused, and the reason says so", async () => {
		await setGuard({ mode: "reviewer", reviewer: "nobody/none" });
		const before = (await log()).length;
		const c = await conversation();
		toldSub.length = 0;
		await subagentDoes(c, write("nobody.txt"));
		expect(existsSync(join(outside, "nobody.txt"))).toBe(false);
		expect(lastSub()).toContain("nobody/none: no such model signed in");
		expect((await decisionsFrom(before))[0].verdict).toBe("unavailable");
		await c.close();
	}, 120_000);

	test("a call that is not risky is never put to the reviewer", async () => {
		await setGuard({ mode: "reviewer", reviewer: "revco/stub-reviewer" });
		reviewing = () => deny();
		const asked = reviewer.requests.length;
		const c = await conversation();
		await subagentDoes(c, { name: "write", args: { path: join(s.work, "inside.txt"), content: "x" } });
		expect(existsSync(join(s.work, "inside.txt"))).toBe(true);
		expect(reviewer.requests.length).toBe(asked);
		await c.close();
	}, 120_000);

	test("Ask me: a subagent has no one to ask, and is refused", async () => {
		await setGuard({ mode: "ask" });
		const asked = reviewer.requests.length;
		const before = (await log()).length;
		const c = await conversation();
		toldSub.length = 0;
		await subagentDoes(c, write("sub-ask.txt"));
		expect(existsSync(join(outside, "sub-ask.txt"))).toBe(false);
		expect(lastSub()).toContain("name the exact command in your final answer");
		expect(reviewer.requests.length).toBe(asked);
		expect((await decisionsFrom(before))[0]).toMatchObject({
			verdict: "deny",
			by: "guard",
			subagent: true,
			mode: "ask",
		});
		await c.close();
	}, 120_000);
});

// ------------------------------------------------------------------ the main agent

describe("the main agent's risky call", () => {
	test("allowed by the reviewer it runs; denied it does not, and the agent reads why", async () => {
		await setGuard({ mode: "reviewer", reviewer: "revco/stub-reviewer", askWhenDenied: false });
		const c = await conversation();
		reviewing = allow;
		await mainDoes(c, write("main-allowed.txt"));
		expect(existsSync(join(outside, "main-allowed.txt"))).toBe(true);
		reviewing = () => deny("not the folder you were asked about");
		toldMain.length = 0;
		const asked = await mainDoes(c, write("main-denied.txt"), RISK_ALLOW);
		// "When the reviewer denies a call, ask me" is off: the denial is final, and nobody is asked.
		expect(asked).toBeNull();
		expect(existsSync(join(outside, "main-denied.txt"))).toBe(false);
		expect(toldMain.at(-1)).toContain("not the folder you were asked about");
		expect(toldMain.at(-1)).toContain("Retry it only after the person explicitly approves this exact call");
		await c.close();
	}, 120_000);

	test("denied by the reviewer with a page open: the person sees the reviewer's reason, and their Allow runs it (#747)", async () => {
		await setGuard({ mode: "reviewer", reviewer: "revco/stub-reviewer", askWhenDenied: true });
		reviewing = () => deny("the approval was not specific");
		const c = await conversation();
		const before = (await log()).length;
		const asked = await mainDoes(c, write("denied-allowed.txt"), RISK_ALLOW);
		expect(asked).not.toBeNull();
		const shown = parseRiskTitle(String(asked?.title));
		// The reviewer and its reason come apart from the call, for the page to show in its own words (#753).
		expect(shown?.denied).toEqual({ model: "revco/stub-reviewer", reason: "the approval was not specific" });
		expect(shown?.detail).not.toContain("the approval was not specific");
		expect(shown?.detail).toContain(join(outside, "denied-allowed.txt"));
		expect(existsSync(join(outside, "denied-allowed.txt"))).toBe(true);
		expect((await decisionsFrom(before))[0]).toMatchObject({ verdict: "allow", by: "person" });
		// Their Deny refuses it, as the reviewer did.
		toldMain.length = 0;
		await mainDoes(c, write("denied-denied.txt"), RISK_DENY);
		expect(existsSync(join(outside, "denied-denied.txt"))).toBe(false);
		expect(toldMain.at(-1)).toContain("did not allow");
		await c.close();
	}, 120_000);

	test("no reviewer can be reached and a page is open: the person is asked, with the reason; their answer decides", async () => {
		await setGuard({ mode: "reviewer", reviewer: "revco/stub-reviewer", askWhenUnavailable: true });
		reviewing = down;
		const c = await conversation();
		const before = (await log()).length;
		const asked = await mainDoes(c, write("asked-yes.txt"), RISK_ALLOW);
		expect(asked).not.toBeNull();
		const shown = parseRiskTitle(String(asked?.title));
		expect(shown?.tool).toBe("write");
		// That no reviewer could be reached, and what went wrong, come apart from the call (#764).
		expect(shown?.unavailable?.reason).toContain("usage limit");
		expect(shown?.detail).not.toContain(GUARD_UNAVAILABLE);
		expect(shown?.detail).toContain(join(outside, "asked-yes.txt"));
		expect(existsSync(join(outside, "asked-yes.txt"))).toBe(true);
		expect((await decisionsFrom(before))[0]).toMatchObject({ verdict: "allow", by: "person" });
		toldMain.length = 0;
		await mainDoes(c, write("asked-no.txt"), RISK_DENY);
		expect(existsSync(join(outside, "asked-no.txt"))).toBe(false);
		expect(toldMain.at(-1)).toContain("did not allow");
		await c.close();
	}, 120_000);

	test("with that setting off the main agent is refused as unavailable, and nobody is asked", async () => {
		await setGuard({ mode: "reviewer", reviewer: "revco/stub-reviewer", askWhenUnavailable: false });
		reviewing = down;
		const c = await conversation();
		toldMain.length = 0;
		const asked = await mainDoes(c, write("not-asked.txt"), RISK_ALLOW);
		expect(asked).toBeNull();
		expect(existsSync(join(outside, "not-asked.txt"))).toBe(false);
		expect(toldMain.at(-1)?.startsWith(GUARD_UNAVAILABLE)).toBe(true);
		await c.close();
	}, 120_000);

	test("Ask me: the person decides, and no reviewer is asked", async () => {
		await setGuard({ mode: "ask" });
		const asked = reviewer.requests.length;
		const c = await conversation();
		await mainDoes(c, write("ask-yes.txt"), RISK_ALLOW);
		expect(existsSync(join(outside, "ask-yes.txt"))).toBe(true);
		await mainDoes(c, write("ask-no.txt"), RISK_DENY);
		expect(existsSync(join(outside, "ask-no.txt"))).toBe(false);
		expect(reviewer.requests.length).toBe(asked);
		await c.close();
	}, 120_000);

	test("what names the guard's own files is refused by the gate itself: no reviewer is asked, and the file is as it was", async () => {
		await setGuard({ mode: "reviewer", reviewer: "revco/stub-reviewer" });
		reviewing = allow;
		const own = join(s.root, "data", "guard-probe.txt");
		mkdirSync(join(s.root, "data"), { recursive: true });
		writeFileSync(own, "as it was");
		const asked = reviewer.requests.length;
		const before = (await log()).length;
		const c = await conversation();
		toldMain.length = 0;
		await mainDoes(c, { name: "write", args: { path: own, content: "changed by the agent" } });
		expect(readFileSync(own, "utf8")).toBe("as it was");
		expect(toldMain.at(-1)).toContain("safety guard itself");
		expect(reviewer.requests.length).toBe(asked);
		expect((await decisionsFrom(before))[0]).toMatchObject({ verdict: "deny", by: "guard" });
		await c.close();
	}, 120_000);
});

// ------------------------------------------------------------------ the macOS app in the background

/** The macOS app reading the stream its notifications come from (`ShellEvents`): the messages in the order they come. */
async function readApp() {
	const control = new AbortController();
	const res = await fetch(`${s.url}/api/shell/events`, {
		headers: { "x-omp-webui-token": s.accessToken },
		signal: control.signal,
	});
	expect(res.status).toBe(200);
	const body = res.body?.getReader();
	if (!body) throw new Error("no body");
	const decoder = new TextDecoder();
	let buffer = "";
	/** The next message that satisfies `match`; the ones before it are read and dropped. */
	const message = async (match: (m: ShellMessage) => boolean): Promise<ShellMessage> => {
		for (;;) {
			const at = buffer.indexOf("\n");
			if (at < 0) {
				const { value, done } = await body.read();
				if (done) throw new Error("the stream ended");
				buffer += decoder.decode(value);
				continue;
			}
			const text = buffer.slice(0, at);
			buffer = buffer.slice(at + 1);
			if (text === "") continue;
			const parsed = JSON.parse(text) as ShellMessage;
			if (match(parsed)) return parsed;
		}
	};
	// The response has begun: the server has seen the app.
	await message((m) => m.t === "state");
	return { message, leave: () => control.abort() };
}

const choosePref = async (changes: Record<string, string | null>) => {
	const res = await fetch(`${s.url}/api/prefs`, {
		method: "POST",
		headers: authed({ "content-type": "application/json" }),
		body: JSON.stringify({ changes }),
	});
	expect(res.status).toBe(200);
};

/** The window is closed: no page is open on the conversation any more (the app runs in the background). */
const closeWindow = (c: Conversation) => c.ws.send(JSON.stringify({ t: "detach", liveId: c.live.liveId }));

const isRiskQuestion = (f: Frame) =>
	f.type === "extension_ui_request" && f.method === "select" && String(f.title ?? "").startsWith("Confirm risky call:");

describe("the macOS app in the background is somebody to ask when no page is open", () => {
	test("the person is asked through the app, the call waits for them, and the window the notification opens shows the question", async () => {
		await setGuard({ mode: "reviewer", reviewer: "revco/stub-reviewer", askWhenUnavailable: true });
		await choosePref({ "ompw.notify": "on", "ompw.lang": "en" });
		reviewing = down;
		const c = await conversation();
		const app = await readApp();
		closeWindow(c);
		const before = (await log()).length;
		plan.main = write("app-asked.txt");
		await prompt(c);
		// The menu bar counts it as waiting, and the notification says which conversation needs the person.
		await app.message((m) => m.t === "state" && m.asking === 1);
		const notice = await app.message((m) => m.t === "attention" && m.kind === "asking" && m.liveId === c.live.liveId);
		expect(notice).toMatchObject({ t: "attention", kind: "asking", liveId: c.live.liveId });
		// Nothing ran, and nothing was refused: it waits.
		expect(existsSync(join(outside, "app-asked.txt"))).toBe(false);
		expect((await request<LiveInfo[]>(c.ws, { t: "list_lives" })).find((l) => l.liveId === c.live.liveId)?.asking).toBe(
			true,
		);

		// A click on the notification opens the window on the conversation: its page attaches and is shown the question.
		const asked = fresh(c, isRiskQuestion);
		const ended = fresh(c, (f) => f.type === "agent_end");
		await request(c.ws, { t: "attach", liveId: c.live.liveId });
		const question = await asked;
		expect(parseRiskTitle(String(question.title))?.unavailable?.reason).toContain("usage limit");
		c.ws.send(
			JSON.stringify({ t: "ui_response", liveId: c.live.liveId, response: { id: question.id, value: RISK_ALLOW } }),
		);
		await ended;
		expect(readFileSync(join(outside, "app-asked.txt"), "utf8")).toBe("from the agent");
		expect((await decisionsFrom(before))[0]).toMatchObject({ verdict: "allow", by: "person" });
		app.leave();
		await c.close();
	}, 120_000);

	/** The conversation has no page, and `arrange` leaves nobody who would see a question: the call is refused, nobody is asked. */
	async function refusedWithNobodyToAsk(name: string, arrange: () => Promise<() => void>) {
		await setGuard({ mode: "reviewer", reviewer: "revco/stub-reviewer", askWhenUnavailable: true });
		reviewing = down;
		const c = await conversation();
		const done = await arrange();
		closeWindow(c);
		const before = (await log()).length;
		toldMain.length = 0;
		plan.main = write(name);
		await prompt(c);
		await pollUntil(() => toldMain.length > 0, "the agent is told what became of the call");
		expect(existsSync(join(outside, name))).toBe(false);
		expect(toldMain.at(-1)?.startsWith(GUARD_UNAVAILABLE)).toBe(true);
		expect((await decisionsFrom(before))[0]).toMatchObject({ verdict: "unavailable", by: "guard" });
		expect(
			(await request<LiveInfo[]>(c.ws, { t: "list_lives" })).find((l) => l.liveId === c.live.liveId)?.asking,
		).not.toBe(true);
		done();
		await c.close();
	}

	test("with neither a page nor the app (it was reading and left) the call is refused for want of a reviewer, as it always was", async () => {
		await choosePref({ "ompw.notify": "on" });
		await refusedWithNobodyToAsk("nobody-asked.txt", async () => {
			const app = await readApp();
			app.leave();
			// The server notices the app has gone within a second (the gates are told again then at the latest).
			await Bun.sleep(1_500);
			return () => {};
		});
	}, 120_000);

	test("an app that is reading but has notifications off can tell nobody: the call is refused, not left waiting", async () => {
		await refusedWithNobodyToAsk("silent-app.txt", async () => {
			const app = await readApp();
			await choosePref({ "ompw.notify": "off" });
			return () => {
				app.leave();
			};
		});
		await choosePref({ "ompw.notify": "on" });
	}, 120_000);
});

// ------------------------------------------------------------------ Off, and what is not covered

describe("Off", () => {
	test("nothing is held back and nothing is asked: the permission mode decides, as before", async () => {
		await setGuard({ mode: "off" });
		reviewing = () => deny();
		const asked = reviewer.requests.length;
		const before = (await log()).length;
		const c = await conversation();
		await subagentDoes(c, write("off-sub.txt"));
		await mainDoes(c, write("off-main.txt"));
		expect(existsSync(join(outside, "off-sub.txt"))).toBe(true);
		expect(existsSync(join(outside, "off-main.txt"))).toBe(true);
		expect(reviewer.requests.length).toBe(asked);
		expect((await log()).length).toBe(before);
		await c.close();
	}, 120_000);
});

describe("a conversation that cannot be covered", () => {
	test("while the guard is on, a process that started without the gate is not given a turn; with it off, it is", async () => {
		await setGuard({ mode: "reviewer" });
		const own = join(root, "trusted.ts");
		writeFileSync(own, "export default function () {}\n");
		const c = await conversation(["--trusted-extension", own]);
		expect(c.live.args).not.toContain("--extension");
		await expect(prompt(c)).rejects.toThrow(/Guard dangerous commands is on/);
		await setGuard({ mode: "off" });
		plan.main = write("ungated.txt");
		const ended = fresh(c, (f) => f.type === "agent_end");
		await prompt(c);
		await ended;
		expect(existsSync(join(outside, "ungated.txt"))).toBe(true);
		await c.close();
	}, 120_000);
});

// ------------------------------------------------------------------ the settings

describe("the settings", () => {
	test("are checked, kept in the file the server was given, and said to every page on this computer", async () => {
		const ws = await connect(s);
		const told = messageWhere(ws, (m) => m.t === "guard_config");
		const config = await setGuard({
			mode: "ask",
			reviewer: " revco/stub-reviewer ",
			askWhenUnavailable: false,
			askWhenDenied: false,
		});
		expect(config).toEqual({
			mode: "ask",
			reviewer: "revco/stub-reviewer",
			askWhenUnavailable: false,
			askWhenDenied: false,
		});
		expect((await told).config).toEqual(config);
		expect(JSON.parse(readFileSync(join(s.root, "guard.json"), "utf8"))).toEqual(config);
		const got = await fetch(`${s.url}/api/guard`, { headers: authed() });
		expect(((await got.json()) as { config: GuardConfig }).config).toEqual(config);
		for (const bad of [{ mode: "disabled" }, { reviewer: 3 }, { askWhenDenied: "yes" }, { nope: true }, "off"]) {
			const res = await fetch(`${s.url}/api/guard`, {
				method: "POST",
				headers: authed({ "content-type": "application/json" }),
				body: JSON.stringify(bad),
			});
			expect(res.status, JSON.stringify(bad)).toBe(400);
		}
		expect(
			((await (await fetch(`${s.url}/api/guard`, { headers: authed() })).json()) as { config: GuardConfig }).config,
		).toEqual(config);
		ws.close();
	}, 60_000);

	test("a file changed behind the server's back is written again, so an agent cannot turn the guard off by editing it", async () => {
		await setGuard({ mode: "reviewer", reviewer: "revco/stub-reviewer", askWhenUnavailable: true });
		writeFileSync(join(s.root, "guard.json"), JSON.stringify({ mode: "off" }));
		await pollUntil(
			() => JSON.parse(readFileSync(join(s.root, "guard.json"), "utf8")).mode === "reviewer",
			"the server to write its settings again",
		);
		const res = await fetch(`${s.url}/api/guard`, { headers: authed() });
		expect(((await res.json()) as { config: GuardConfig }).config.mode).toBe("reviewer");
	}, 60_000);

	test("a page that came in through the tunnel is refused the guard's settings, its log and its decisions", async () => {
		const phone = remoteClient(s, key);
		for (const [path, method, body] of [
			["/api/guard", "GET", undefined],
			["/api/guard", "POST", JSON.stringify({ mode: "off" })],
			["/api/guard/log", "GET", undefined],
			["/api/guard/decisions?session=x", "GET", undefined],
		] as const) {
			const res = await phone.fetch(
				path,
				{ method, headers: method === "POST" ? { "x-omp-webui": "1", "content-type": "application/json" } : undefined },
				body,
			);
			expect(res.status, `${method} ${path}`).toBe(403);
		}
		// Not changed, and a remote socket is not told of decisions.
		expect(
			((await (await fetch(`${s.url}/api/guard`, { headers: authed() })).json()) as { config: GuardConfig }).config
				.mode,
		).toBe("reviewer");
		const remote = await phone.socket();
		expect(remote).not.toBeNull();
		let heard = false;
		remote?.addEventListener("message", (ev) => {
			if (String(ev.data).includes('"guard_')) heard = true;
		});
		// A page on this computer hears of the change; the remote one, attached at the same moment, does not.
		const local = await connect(s);
		const told = messageWhere(local, (m) => m.t === "guard_config");
		await setGuard({ mode: "reviewer", askWhenUnavailable: false });
		await told;
		expect(heard).toBe(false);
		local.close();
		remote?.close();
	}, 60_000);

	test("the decisions of one agent session are asked for by its id", async () => {
		const all = await log();
		const some = all.find((d) => d.session !== "");
		expect(some).toBeDefined();
		const res = await fetch(`${s.url}/api/guard/decisions?session=${encodeURIComponent(some?.session ?? "")}`, {
			headers: authed(),
		});
		const { decisions } = (await res.json()) as { decisions: GuardDecision[] };
		expect(decisions.length).toBeGreaterThan(0);
		for (const d of decisions) expect(d.session).toBe(some?.session ?? "");
		expect((await fetch(`${s.url}/api/guard/decisions`, { headers: authed() })).status).toBe(400);
	}, 60_000);
});

// ------------------------------------------------------------------ a conversation's own guard (#626)

/** Change one conversation's own guard, as the page of this computer does. */
const choose = (liveId: string, guard: unknown) =>
	fetch(`${s.url}/api/guard/live`, {
		method: "POST",
		headers: authed({ "content-type": "application/json" }),
		body: JSON.stringify({ liveId, guard }),
	});

describe("a conversation's own guard", () => {
	test("holds for its subagents, and a conversation that chose nothing is under the settings, also as they change", async () => {
		await setGuard({ mode: "ask", reviewer: "revco/stub-reviewer", askWhenUnavailable: true });
		reviewing = () => deny();
		const own = await conversation();
		const following = await conversation();
		expect((await choose(own.live.liveId, { mode: "off" })).status).toBe(200);

		// The one that chose Off: its subagent's risky call is not looked at, though the settings say Ask me.
		const asked = reviewer.requests.length;
		const before = (await log()).length;
		await subagentDoes(own, write("own-off.txt"));
		expect(existsSync(join(outside, "own-off.txt"))).toBe(true);
		// The one that chose nothing is under Ask me: its subagent has no one to ask, and is refused.
		toldSub.length = 0;
		await subagentDoes(following, write("following-ask.txt"));
		expect(existsSync(join(outside, "following-ask.txt"))).toBe(false);
		expect(lastSub()).toContain("name the exact command in your final answer");
		expect((await decisionsFrom(before))[0]).toMatchObject({
			verdict: "deny",
			by: "guard",
			subagent: true,
			mode: "ask",
		});
		expect(reviewer.requests.length).toBe(asked);

		// The settings move to Off, and the conversation that follows them follows at once; the one that now chose the
		// reviewer has its subagent judged by it, though the settings say Off.
		await setGuard({ mode: "off" });
		await subagentDoes(following, write("following-off.txt"));
		expect(existsSync(join(outside, "following-off.txt"))).toBe(true);
		expect((await choose(own.live.liveId, { mode: "reviewer" })).status).toBe(200);
		await subagentDoes(own, write("own-reviewer.txt"));
		expect(existsSync(join(outside, "own-reviewer.txt"))).toBe(false);
		expect(reviewer.requests.length).toBe(asked + 1);
		await own.close();
		await following.close();
	}, 240_000);

	test("a page that came in through the tunnel is refused to change it, by the route and by opening a chat with one, and is shown what it is", async () => {
		await setGuard({ mode: "reviewer", reviewer: "revco/stub-reviewer", askWhenUnavailable: true });
		const c = await conversation();
		expect((await choose(c.live.liveId, { mode: "ask" })).status).toBe(200);
		const phone = remoteClient(s, key);
		const refused = await phone.fetch(
			"/api/guard/live",
			{ method: "POST", headers: { "x-omp-webui": "1", "content-type": "application/json" } },
			JSON.stringify({ liveId: c.live.liveId, guard: { mode: "off" } }),
		);
		expect(refused.status).toBe(403);
		const socket = await phone.socket();
		expect(socket).not.toBeNull();
		if (socket) {
			await expect(
				request(socket, { t: "open", target: { kind: "new", cwd: s.work, guard: { mode: "off" } } }),
			).rejects.toThrow(/computer omp-webui runs on/);
			const listing = await request<{ liveId: string; guard?: { own?: unknown } }[]>(socket, { t: "list_lives" });
			expect(listing.find((l) => l.liveId === c.live.liveId)?.guard?.own).toEqual({ mode: "ask" });
			socket.close();
		}
		const word = await fetch(`${s.url}/api/lives`, { headers: authed() });
		const listed: { liveId: string; guard?: { config: { mode: string }; own?: unknown } }[] = await word.json();
		expect(listed.find((l) => l.liveId === c.live.liveId)?.guard).toMatchObject({
			config: { mode: "ask" },
			own: { mode: "ask" },
		});
		await c.close();
	}, 120_000);
});

/** Every `.jsonl` file under `dir`. */
function jsonl(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...jsonl(path));
		else if (entry.name.endsWith(".jsonl")) out.push(path);
	}
	return out;
}
