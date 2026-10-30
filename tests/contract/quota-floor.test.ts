import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LiveInfo, LiveListing } from "../../shared/protocol.ts";
import { QUOTA_DIALOG_TITLE } from "../../shared/quota-hold.ts";
import { type Frame, watchFrames } from "../support/frames.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import {
	type ScriptedRequest,
	type ScriptedTurn,
	type StubScripted,
	startScriptedStub,
} from "../support/stub-scripted.ts";
import { connect, request } from "../support/ws.ts";

/**
 * The quota floor (#652) against the real omp and the real server. The provider is a scripted stub (no model is called) and
 * `omp usage` is a launcher that answers from a file the test writes, so the test says how much of the window is left and when it
 * resets; every other omp command goes to the real omp.
 *
 * What is measured: a conversation whose provider is at the floor finishes the model request that is in flight and then waits
 * *before the next request* (the stub is asked once, not twice); its omp is not frozen (it answers `get_state`, its process is not
 * stopped); no page is shown the dialog it waits in; it is let go after the window resets and the quota is above the floor, and
 * the next request goes out then, not before; "Continue anyway" lets it go at once and stands; a conversation that is held survives
 * the server ending (the next one finds it held and releases it at the reset); and N conversations looking at one provider are one
 * `omp usage` per interval, not N.
 *
 * Each scenario has a provider of its own (all of them are the one stub): the server keeps what `omp usage` said for 25 s, by
 * provider, which is what keeps N conversations to one look, and what would carry one scenario's figures into the next.
 */

const MARK = "PROMPT-652";
const GRACE_MS = 250;
const LOOK_MS = 250;
const FLOOR = 20;
const HOUR = 3_600_000;
const PROVIDERS = [
	"qf-hold",
	"qf-lag",
	"qf-go",
	"qf-free",
	"qf-none",
	"qf-stop",
	"qf-storm",
	"qf-restart",
	"qf-api",
] as const;
type Provider = (typeof PROVIDERS)[number];

let s: TestServer;
let agent: StubScripted;
const root = mkdtempSync(join(tmpdir(), "ompw-quota-floor-"));
const usageFile = join(root, "usage.json");
const callsFile = join(root, "calls");
/** When each main-agent request reached the stub. */
const stamps: number[] = [];
/** How many tool steps the scripted main agent takes before it answers. */
let steps = 1;

const isMain = (r: ScriptedRequest) => r.tools.includes("task");
const mainRequests = (m: string) => agent.requests.filter((r) => isMain(r) && r.text.includes(m));

/** How many tool results the conversation holds since the person's last message: the steps this turn has taken. */
function taken(req: ScriptedRequest): number {
	const messages = JSON.parse(req.text) as { role?: string }[];
	const last = messages.map((m) => m.role).lastIndexOf("user");
	return messages.slice(last + 1).filter((m) => m.role === "tool").length;
}

const script = (req: ScriptedRequest): ScriptedTurn => {
	// A title's request offers no task tool.
	if (!isMain(req)) return { text: "A title" };
	stamps.push(Date.now());
	const done = taken(req);
	if (done < steps) return { call: { name: "bash", args: { command: `echo step-${done}`, timeout: 5 } } };
	return { text: "Main done." };
};

/** What `omp usage --json` says: `provider`'s one window, `left` of it still there, resetting at `resetsAt`. */
function say(provider: Provider, left: number, resetsAt: number): void {
	writeFileSync(
		usageFile,
		JSON.stringify({
			reports: [
				{
					provider,
					fetchedAt: Date.now(),
					limits: [
						{
							id: `${provider}:5h`,
							label: "5 hour",
							window: { id: "5h", label: "5 hour", durationMs: 5 * HOUR, resetsAt },
							amount: { remainingFraction: left, unit: "percent" },
						},
					],
					metadata: { email: "quota@example.com" },
				},
			],
		}),
	);
}

const authed = (extra: Record<string, string> = {}) => ({
	"x-omp-webui-token": s.accessToken,
	"x-omp-webui": "1",
	...extra,
});
const post = (path: string, body: unknown) =>
	fetch(`${s.url}${path}`, {
		method: "POST",
		headers: authed({ "content-type": "application/json" }),
		body: JSON.stringify(body),
	});
const setFloor = async (provider: Provider, floor: number | null) => {
	const res = await post("/api/quota-floor", { provider, floor });
	expect(res.status).toBe(200);
};
/** How many times the server asked omp for the quota (`omp usage …`). */
const usageCalls = (): number =>
	existsSync(callsFile)
		? readFileSync(callsFile, "utf8")
				.split("\n")
				.filter((line) => line.startsWith("usage")).length
		: 0;

beforeAll(async () => {
	const real = process.env.OMP_BIN ?? Bun.which("omp");
	if (!real) throw new Error("omp is not installed");
	const launcher = join(root, "omp");
	writeFileSync(
		launcher,
		`#!/bin/sh\necho "$*" >> "${callsFile}"\nif [ "$1" = "usage" ]; then cat "${usageFile}"; exit 0; fi\nexec "${real}" "$@"\n`,
	);
	chmodSync(launcher, 0o755);
	say("qf-hold", 0.9, Date.now() + HOUR);
	agent = await startScriptedStub(script);
	s = await startTestServer(
		0,
		{
			OMP_BIN: launcher,
			OMP_WEBUI_QUOTA_GRACE_MS: String(GRACE_MS),
			OMP_WEBUI_QUOTA_LOOK_MS: String(LOOK_MS),
			OMP_WEBUI_QUOTA_HELD_LOOK_MS: String(LOOK_MS),
		},
		{ login: false },
	);
	writeFileSync(
		join(s.agentDir, "models.yml"),
		`providers:\n${PROVIDERS.map(
			(p) =>
				`  ${p}:\n    baseUrl: ${agent.url}\n    api: openai-completions\n    apiKey: ${agent.apiKey}\n    models:\n      - id: stub-model\n`,
		).join("")}`,
	);
	writeFileSync(
		join(s.agentDir, "config.yml"),
		[
			"modelRoles:",
			...["default", "smol", "slow", "tiny", "commit"].map((r) => `  ${r}: qf-hold/stub-model`),
			"spelling:",
			"  autocomplete: ngram",
			"",
		].join("\n"),
	);
}, 120_000);

afterAll(async () => {
	await s?.stop();
	await agent?.stop();
	rmSync(root, { recursive: true, force: true });
});

interface Conversation {
	live: LiveInfo;
	ws: WebSocket;
	frames: ReturnType<typeof watchFrames>;
}

async function conversation(provider: Provider): Promise<Conversation> {
	const ws = await connect(s);
	const live = await request<LiveInfo>(ws, {
		t: "open",
		target: { kind: "new", cwd: s.work, approvalMode: "yolo", args: ["--model", `${provider}/stub-model`] },
	});
	return { live, ws, frames: watchFrames(ws, live.liveId) };
}

const prompt = (c: Conversation, message: string) =>
	request(c.ws, { t: "rpc", liveId: c.live.liveId, command: { type: "prompt", message } });
const fresh = (c: Conversation, match: (f: Frame) => boolean): Promise<Frame> => {
	const from = c.frames.seen.length;
	return c.frames.next((f) => c.frames.seen.indexOf(f) >= from && match(f));
};
const listing = async (ws: WebSocket, liveId: string): Promise<LiveListing | undefined> =>
	(await request<LiveListing[]>(ws, { t: "list_lives" })).find((l) => l.liveId === liveId);
const holdOf = async (c: Conversation) => (await listing(c.ws, c.live.liveId))?.quotaHold;
const heldNow = async (c: Conversation) => (await holdOf(c))?.state === "held";
/** The state letters `ps` gives a process: `T` is stopped (SIGSTOP), which a held conversation must not be. */
const stat = (pid: number): string =>
	Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)])
		.stdout.toString()
		.trim();

let seq = 0;
const mark = (what: string) => `${MARK}-${what}-${++seq}`;

test("at the floor, the request in flight completes and the next one waits; the reset lets it go, the stub is asked then", async () => {
	await setFloor("qf-hold", FLOOR);
	steps = 1;
	stamps.length = 0;
	const resetsAt = Date.now() + 5_000;
	say("qf-hold", 0.05, resetsAt);
	const c = await conversation("qf-hold");
	const m = mark("held");
	const ended = fresh(c, (f) => f.type === "agent_end");
	await prompt(c, m);

	await pollUntil(() => heldNow(c), "the conversation to be held");
	const hold = await holdOf(c);
	expect(hold).toMatchObject({ state: "held", provider: "qf-hold", floor: FLOOR, window: "5 hour", resetsAt });
	expect(hold?.remaining).toBeCloseTo(0.05);
	// The cache's warming has not been decided (omp decides before its first refresh): the page is told so.
	expect(hold?.warming.state).toBe("unknown");

	// Between two requests: the first was answered (a tool step followed it), the second is not made.
	expect(mainRequests(m).length).toBe(1);
	// An omission: nothing observable happens when the stub is not asked, so this is a real wait (the reset is 5 s away).
	await Bun.sleep(1200);
	expect(mainRequests(m).length).toBe(1);
	expect(await heldNow(c)).toBe(true);

	// Not frozen: omp answers, and its process is not stopped. (A pause would SIGSTOP both.)
	const pid = (await listing(c.ws, c.live.liveId))?.pid as number;
	expect(stat(pid)).not.toContain("T");
	const state = await request<{ isStreaming?: boolean }>(c.ws, {
		t: "rpc",
		liveId: c.live.liveId,
		command: { type: "get_state" },
	});
	expect(state).toMatchObject({ isStreaming: true });
	// No page was shown the dialog the extension waits in, and the conversation is held, not asking: nothing waits for the person.
	expect(c.frames.seen.some((f) => f.type === "extension_ui_request" && f.title === QUOTA_DIALOG_TITLE)).toBe(false);
	expect((await listing(c.ws, c.live.liveId))?.holding).toBe("working");

	// The window refills; the reset comes and the quota is above the floor: the next request goes out then.
	say("qf-hold", 0.9, Date.now() + HOUR);
	await ended;
	expect(mainRequests(m).length).toBe(2);
	expect(stamps.at(-1) ?? 0).toBeGreaterThanOrEqual(resetsAt);
	await pollUntil(async () => (await holdOf(c)) === undefined, "the hold to be gone");
	c.ws.close();
}, 120_000);

test("the reset passes but the provider still says low: the conversation stays held, and goes on when it does not", async () => {
	await setFloor("qf-lag", FLOOR);
	steps = 1;
	const resetsAt = Date.now() + 2_000;
	say("qf-lag", 0.05, resetsAt);
	const c = await conversation("qf-lag");
	const m = mark("lag");
	const ended = fresh(c, (f) => f.type === "agent_end");
	await prompt(c, m);
	await pollUntil(() => heldNow(c), "the conversation to be held");
	// Past the reset (and its grace) and the figures have not caught up: it is looked at again, and stays held. (An omission.)
	await Bun.sleep(2_000 + GRACE_MS + 1_000);
	expect(await heldNow(c)).toBe(true);
	expect(mainRequests(m).length).toBe(1);
	say("qf-lag", 0.9, Date.now() + HOUR);
	await ended;
	expect(mainRequests(m).length).toBe(2);
	c.ws.close();
}, 120_000);

test("Continue anyway lets it go at once and stands for the conversation until the provider is above the floor", async () => {
	await setFloor("qf-go", FLOOR);
	steps = 1;
	say("qf-go", 0.05, Date.now() + HOUR);
	const c = await conversation("qf-go");
	const m = mark("override");
	const ended = fresh(c, (f) => f.type === "agent_end");
	await prompt(c, m);
	await pollUntil(() => heldNow(c), "the conversation to be held");
	const before = mainRequests(m).length;
	const reply = await request<LiveInfo>(c.ws, { t: "quota_override", liveId: c.live.liveId, on: true });
	expect(reply.quotaHold?.state).toBe("overridden");
	await ended;
	expect(mainRequests(m).length).toBe(before + 1);
	// The turn is over, and so is what it was held for; the person's word stands for the next one.
	expect(await holdOf(c)).toBeUndefined();

	// The next turn is not held: it runs through while the provider is still at the floor.
	const again = fresh(c, (f) => f.type === "agent_end");
	const m2 = mark("override-again");
	await prompt(c, m2);
	await again;
	// Two requests, a tool step between them: held, it would have stopped after one.
	expect(mainRequests(m2).length).toBe(2);
	c.ws.close();
}, 120_000);

test("above the floor, or with no floor: nothing is held, and every request goes out", async () => {
	steps = 2;
	try {
		for (const [provider, left, floor] of [
			["qf-free", 0.5, FLOOR],
			["qf-none", 0.05, null],
		] as const) {
			await setFloor(provider, floor);
			say(provider, left, Date.now() + HOUR);
			const c = await conversation(provider);
			const m = mark("free");
			const ended = fresh(c, (f) => f.type === "agent_end");
			await prompt(c, m);
			await ended;
			// Two tool steps and the answer: three requests, none of them waited.
			expect(mainRequests(m).length).toBe(3);
			expect(await holdOf(c)).toBeUndefined();
			c.ws.close();
		}
	} finally {
		steps = 1;
	}
}, 120_000);

test("stopping a held conversation ends the hold with the turn; the next turn looks again", async () => {
	await setFloor("qf-stop", FLOOR);
	steps = 1;
	say("qf-stop", 0.05, Date.now() + HOUR);
	const c = await conversation("qf-stop");
	await prompt(c, mark("stop"));
	await pollUntil(() => heldNow(c), "the conversation to be held");
	const ended = fresh(c, (f) => f.type === "agent_end");
	await request(c.ws, { t: "rpc", liveId: c.live.liveId, command: { type: "abort" }, stop: true });
	await ended;
	await pollUntil(async () => (await holdOf(c)) === undefined, "the hold to be gone with the turn");
	// The next turn is held again, from its first tool step: its first request goes out (nothing is held before a tool step), the
	// second is the one that waits.
	const again = mark("stop-again");
	await prompt(c, again);
	await pollUntil(() => heldNow(c), "the conversation to be held again");
	expect(mainRequests(again).length).toBe(1);
	c.ws.close();
}, 120_000);

test("three conversations held on one provider cost one `omp usage` per interval, not three", async () => {
	await setFloor("qf-storm", FLOOR);
	steps = 1;
	say("qf-storm", 0.05, Date.now() + HOUR);
	const before = usageCalls();
	const chats = await Promise.all([conversation("qf-storm"), conversation("qf-storm"), conversation("qf-storm")]);
	await Promise.all(chats.map((c) => prompt(c, mark("storm"))));
	for (const c of chats) await pollUntil(() => heldNow(c), "a conversation to be held");
	// They look every LOOK_MS and the cache is 25 s: held for six looks, the provider was asked once (an omission, so a real wait).
	await Bun.sleep(LOOK_MS * 6);
	expect(usageCalls() - before).toBeLessThanOrEqual(2);
	for (const c of chats) {
		void request(c.ws, { t: "close", liveId: c.live.liveId }).catch(() => {});
		c.ws.close();
	}
}, 120_000);

test("a conversation held when the server ends is found held by the next one, and goes on at the reset", async () => {
	await setFloor("qf-restart", FLOOR);
	steps = 1;
	stamps.length = 0;
	const resetsAt = Date.now() + 9_000;
	say("qf-restart", 0.05, resetsAt);
	const c = await conversation("qf-restart");
	const m = mark("restart");
	await prompt(c, m);
	await pollUntil(() => heldNow(c), "the conversation to be held");
	const pid = (await listing(c.ws, c.live.liveId))?.pid as number;
	const before = mainRequests(m).length;
	c.ws.close();

	await s.restart(undefined, { signal: "SIGTERM" });
	const ws = await connect(s);
	try {
		// Not a new process: the one that waits, found again, and still held.
		const found = await listing(ws, c.live.liveId);
		expect(found?.pid).toBe(pid);
		expect(found?.quotaHold?.state).toBe("held");
		// An omission: the stub is not asked while the new server looks at the quota.
		await Bun.sleep(1_000);
		expect(mainRequests(m).length).toBe(before);
		expect((await listing(ws, c.live.liveId))?.quotaHold?.state).toBe("held");

		// The reset: the quota is above the floor, and the conversation goes on with nobody having asked.
		say("qf-restart", 0.9, Date.now() + HOUR);
		await pollUntil(() => mainRequests(m).length === before + 1, "the turn to go on after the reset", 30_000);
		expect(stamps.at(-1) ?? 0).toBeGreaterThanOrEqual(resetsAt);
		await pollUntil(async () => (await listing(ws, c.live.liveId))?.quotaHold === undefined, "the hold to be gone");
	} finally {
		void request(ws, { t: "close", liveId: c.live.liveId }).catch(() => {});
		ws.close();
	}
}, 120_000);

test("the floors are the person's own: kept in the data dir, read back, refused when they are not a share, and removed", async () => {
	const read = async (): Promise<{ floors: Record<string, number> }> =>
		(await fetch(`${s.url}/api/quota-floor`, { headers: authed() })).json();
	const before = (await read()).floors;
	await setFloor("qf-api", 35);
	expect((await read()).floors).toEqual({ ...before, "qf-api": 35 });
	for (const bad of [0, 100, 12.5, "20", true, {}]) {
		expect((await post("/api/quota-floor", { provider: "qf-api", floor: bad })).status).toBe(422);
	}
	expect((await post("/api/quota-floor", { provider: "--evil", floor: 20 })).status).toBe(422);
	expect((await post("/api/quota-floor", { provider: "qf-api" })).status).toBe(422);
	expect((await read()).floors).toEqual({ ...before, "qf-api": 35 });
	await setFloor("qf-api", null);
	expect((await read()).floors).toEqual(before);
});
