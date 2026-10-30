import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LiveInfo, LiveListing } from "../../shared/protocol.ts";
import { parseRiskTitle, RISK_ALLOW, RISK_DENY, type RiskTitle } from "../../shared/risk-confirm.ts";
import { type AccessKey, type Jwks, makeKey, startJwks } from "../support/access-jwt.ts";
import { type Frame, watchFrames } from "../support/frames.ts";
import { type RemoteClient, remoteClient, remoteSettings } from "../support/remote-client.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type ScriptedTurn, type StubScripted, startScriptedStub } from "../support/stub-scripted.ts";
import { connect, request } from "../support/ws.ts";

/**
 * "Confirm risky commands from remote pages" against the real omp (18.12) and the real server, the model a scripted
 * provider (no model call). A tool call that is high-risk waits for an explicit answer on the page while the setting is
 * on and the turn was sent or steered from a page that came in through the tunnel; with the setting off, or for a turn
 * a page on this computer drives, it just runs. A remote page that only looks at a conversation never causes a question,
 * and nothing here changes the conversation's permission mode.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-remote-confirm-"));
const settingsFile = join(root, "remote.json");
const dist = join(root, "dist");
const outside = join(root, "outside");
const dataDir = join(root, "Application Support", "omp-webui");
let key: AccessKey;
let jwks: Jwks;
let s: TestServer;
let backend: StubScripted;
let phone: RemoteClient;

/** What the scripted model does next: one tool call (the first request of a turn that has none to answer). */
let plan: { name: string; args: unknown } | null = null;
/** Held: the model's answer to the next request waits for this (a turn that is under way when a page steers it). */
let hold: Promise<void> | null = null;
/** What the tools answered, as the model was told. */
const told: string[] = [];

const script = async (req: { text: string; tools: string[] }): Promise<ScriptedTurn> => {
	if (!req.tools.includes("write")) return { text: "A title" };
	const messages = JSON.parse(req.text) as { role?: string; content?: unknown }[];
	const last = messages.at(-1);
	if (last?.role === "tool") {
		told.push(String(last.content));
		return { text: "Done." };
	}
	const waiting = hold;
	hold = null;
	if (waiting) await waiting;
	const next = plan;
	plan = null;
	return next ? { call: next } : { text: "Nothing to do." };
};

const setSettings = (over: Record<string, unknown> = {}) =>
	writeFileSync(settingsFile, JSON.stringify(remoteSettings(over)));

beforeAll(async () => {
	key = await makeKey("kid-1");
	jwks = await startJwks([key]);
	mkdirSync(join(dist, "assets"), { recursive: true });
	writeFileSync(
		join(dist, "index.html"),
		'<!doctype html>\n<html><head></head><body><div id="root"></div></body></html>\n',
	);
	mkdirSync(outside, { recursive: true });
	setSettings();
	backend = await startScriptedStub(script);
	s = await startTestServer(
		0,
		{
			OMP_WEBUI_REMOTE_CONFIG: settingsFile,
			OMP_WEBUI_ACCESS_CERTS_URL: jwks.url,
			OMP_WEBUI_DIST: dist,
			// The macOS app's data folder is `~/Library/Application Support/omp-webui`: the gate must work from a path with a space.
			OMP_WEBUI_DATA_DIR: dataDir,
		},
		{ login: false },
	);
	writeFileSync(
		join(s.agentDir, "models.yml"),
		`providers:\n  omlx:\n    baseUrl: ${backend.url}\n    api: openai-completions\n    apiKey: ${backend.apiKey}\n    discovery:\n      type: openai-models-list\n`,
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
	phone = remoteClient(s, key);
}, 120_000);

afterAll(async () => {
	await s?.stop();
	await backend?.stop();
	jwks?.stop();
	rmSync(root, { recursive: true, force: true });
});

/** What a page is told of a process's frames (see `watchFrames`). */
interface Watched {
	seen: Frame[];
	next(match: (f: Frame) => boolean): Promise<Frame>;
	after(type: string): Promise<Frame>;
}

/** A conversation in yolo mode, opened on this computer, with a remote page attached to it. */
interface Conversation {
	live: LiveInfo;
	local: WebSocket;
	remote: WebSocket;
	here: Watched;
	there: Watched;
	/** The confirmations the gate asked, on either page. */
	asked(): Frame[];
	close(): Promise<void>;
}

async function conversation(args: string[] = []): Promise<Conversation> {
	const local = await connect(s);
	const remote = await phone.socket();
	if (!remote) throw new Error("the tunnel refused the page");
	const live = await request<LiveInfo>(local, {
		t: "open",
		target: { kind: "new", cwd: s.work, approvalMode: "yolo", args },
	});
	await request(remote, { t: "attach", liveId: live.liveId });
	const here = watchFrames(local, live.liveId);
	const there = watchFrames(remote, live.liveId);
	const asked = () => [...here.seen, ...there.seen].filter(isConfirmation);
	const close = async () => {
		await request(local, { t: "close", liveId: live.liveId }).catch(() => {});
		local.close();
		remote.close();
	};
	return { live, local, remote, here, there, asked, close };
}

const isConfirmation = (f: Frame): boolean =>
	f.type === "extension_ui_request" && f.method === "select" && String(f.title ?? "").startsWith("Confirm risky call:");
/** omp's own approval, which only the permission mode asks for. */
const isApproval = (f: Frame): boolean =>
	f.type === "extension_ui_request" && /^Allow tool:/.test(String(f.title ?? ""));

/** A write outside the project folder: risky, and visible in the file system. */
const outsideWrite = (name: string) => ({
	name: "write",
	args: { path: join(outside, name), content: "from the agent" },
});

/** `ws` sends a prompt and the turn runs to its end (answering what asks on the way with `answer`, if it is given). */
async function turn(c: Conversation, ws: WebSocket, call: typeof plan, answer?: (ask: Frame) => string | null) {
	plan = call;
	const ended = c.here.after("agent_end");
	if (answer) {
		const listener = (ev: MessageEvent) => {
			const m = JSON.parse(String(ev.data));
			if (m.t !== "frame" || m.liveId !== c.live.liveId || !isConfirmation(m.frame)) return;
			const value = answer(m.frame as Frame);
			if (value !== null)
				ws.send(JSON.stringify({ t: "ui_response", liveId: c.live.liveId, response: { id: m.frame.id, value } }));
		};
		ws.addEventListener("message", listener);
		await request(ws, { t: "rpc", liveId: c.live.liveId, command: { type: "prompt", message: "go" } });
		await ended;
		ws.removeEventListener("message", listener);
		return;
	}
	await request(ws, { t: "rpc", liveId: c.live.liveId, command: { type: "prompt", message: "go" } });
	await ended;
}

const modeOf = async (c: Conversation) =>
	(await request<LiveListing[]>(c.local, { t: "list_lives" })).find((l) => l.liveId === c.live.liveId)?.approvalMode;

describe("the setting is off (the default)", () => {
	test("a turn a remote page drives runs a risky call without a question, and the mode stays", async () => {
		setSettings({ confirmRisky: false });
		const c = await conversation();
		const target = join(outside, "off.txt");
		await turn(c, c.remote, outsideWrite("off.txt"));
		expect(existsSync(target)).toBe(true);
		expect(c.asked()).toEqual([]);
		expect([...c.here.seen, ...c.there.seen].filter(isApproval)).toEqual([]);
		expect(await modeOf(c)).toBe("yolo");
		await c.close();
	}, 90_000);
});

describe("the setting is on", () => {
	test("a risky call of a turn a remote page sent waits for the page; the exact path is shown; allowing runs it", async () => {
		setSettings({ confirmRisky: true });
		const c = await conversation();
		const target = join(outside, "allowed.txt");
		plan = outsideWrite("allowed.txt");
		const ended = c.here.after("agent_end");
		const ask = c.there.next(isConfirmation);
		await request(c.remote, { t: "rpc", liveId: c.live.liveId, command: { type: "prompt", message: "go" } });
		const frame = await ask;
		const risk = parseRiskTitle(String(frame.title));
		expect(risk?.tool).toBe("write");
		expect(risk?.kinds).toEqual(["write_outside"]);
		expect(risk?.detail).toBe(`Path: ${target}`);
		expect(frame.options).toEqual([RISK_ALLOW, RISK_DENY]);
		// It waits: nothing ran, and omp's own approval (the mode is yolo) never asked.
		expect(existsSync(target)).toBe(false);
		expect(c.here.seen.filter(isApproval)).toEqual([]);
		// The local page was told too, and either may answer; the remote page does.
		await c.here.next(isConfirmation);
		c.remote.send(
			JSON.stringify({ t: "ui_response", liveId: c.live.liveId, response: { id: frame.id, value: RISK_ALLOW } }),
		);
		await ended;
		expect(existsSync(target)).toBe(true);
		expect(await modeOf(c)).toBe("yolo");
		await c.close();
	}, 90_000);

	test("denying refuses the call with a reason the agent reads, and nothing runs", async () => {
		setSettings({ confirmRisky: true });
		const c = await conversation();
		const target = join(outside, "denied.txt");
		told.length = 0;
		await turn(c, c.remote, outsideWrite("denied.txt"), () => RISK_DENY);
		expect(existsSync(target)).toBe(false);
		expect(told.at(-1)).toMatch(/did not allow this high-risk call \(write_outside\)/);
		expect(told.at(-1)).toMatch(/not run/);
		expect(c.asked()).toHaveLength(2);
		expect(await modeOf(c)).toBe("yolo");
		await c.close();
	}, 90_000);

	test("cancelling the question counts as no answer, and the call does not run either", async () => {
		setSettings({ confirmRisky: true });
		const c = await conversation();
		const target = join(outside, "cancelled.txt");
		told.length = 0;
		plan = outsideWrite("cancelled.txt");
		const ended = c.here.after("agent_end");
		const ask = c.there.next(isConfirmation);
		await request(c.remote, { t: "rpc", liveId: c.live.liveId, command: { type: "prompt", message: "go" } });
		const frame = await ask;
		c.remote.send(
			JSON.stringify({ t: "ui_response", liveId: c.live.liveId, response: { id: frame.id, cancelled: true } }),
		);
		await ended;
		expect(existsSync(target)).toBe(false);
		expect(told.at(-1)).toMatch(/did not answer/);
		await c.close();
	}, 90_000);

	test("a call that is not risky runs, whoever drives, with no question", async () => {
		setSettings({ confirmRisky: true });
		const c = await conversation();
		const inside = join(s.work, "inside.txt");
		await turn(c, c.remote, { name: "write", args: { path: inside, content: "x" } });
		expect(existsSync(inside)).toBe(true);
		expect(c.asked()).toEqual([]);
		await c.close();
	}, 90_000);

	test("a turn a page on this computer drives runs a risky call without a question, a remote page attached and watching or not", async () => {
		setSettings({ confirmRisky: true });
		const c = await conversation();
		const target = join(outside, "local.txt");
		await turn(c, c.local, outsideWrite("local.txt"));
		expect(existsSync(target)).toBe(true);
		expect(c.asked()).toEqual([]);
		expect(await modeOf(c)).toBe("yolo");
		await c.close();
	}, 90_000);

	test("the person at this computer takes the turn back with their next message", async () => {
		setSettings({ confirmRisky: true });
		const c = await conversation();
		await turn(c, c.remote, outsideWrite("first.txt"), () => RISK_ALLOW);
		expect(c.asked()).toHaveLength(2);
		const target = join(outside, "second.txt");
		await turn(c, c.local, outsideWrite("second.txt"));
		expect(existsSync(target)).toBe(true);
		// No new question was asked (each of the two pages saw the first one).
		expect(c.asked()).toHaveLength(2);
		// And a remote page's next message makes the turn its own again.
		const again = join(outside, "third.txt");
		await turn(c, c.remote, outsideWrite("third.txt"), () => RISK_DENY);
		expect(existsSync(again)).toBe(false);
		expect(c.asked()).toHaveLength(4);
		await c.close();
	}, 120_000);

	test("a remote page that steers a turn a local page started takes it over", async () => {
		setSettings({ confirmRisky: true });
		const c = await conversation();
		const target = join(outside, "steered.txt");
		const release = Promise.withResolvers<void>();
		hold = release.promise;
		plan = outsideWrite("steered.txt");
		const ended = c.here.after("agent_end");
		await request(c.local, { t: "rpc", liveId: c.live.liveId, command: { type: "prompt", message: "go" } });
		// The turn is under way (the model has not answered); the remote page steers it, and only then does the model call the tool.
		await request(c.remote, {
			t: "rpc",
			liveId: c.live.liveId,
			command: { type: "steer", message: "do it differently" },
		});
		const ask = c.there.next(isConfirmation);
		release.resolve();
		const frame = await ask;
		expect(parseRiskTitle(String(frame.title))?.kinds).toEqual(["write_outside"]);
		expect(existsSync(target)).toBe(false);
		c.remote.send(
			JSON.stringify({ t: "ui_response", liveId: c.live.liveId, response: { id: frame.id, value: RISK_DENY } }),
		);
		await ended;
		expect(existsSync(target)).toBe(false);
		await c.close();
	}, 90_000);

	test("a command is shown whole, with why it asks; a safe one in the same conversation is not asked about", async () => {
		setSettings({ confirmRisky: true });
		const c = await conversation();
		const victim = join(outside, "victim");
		mkdirSync(victim, { recursive: true });
		writeFileSync(join(victim, "keep.txt"), "x");
		const command = `rm -rf '${victim}'`;
		// Assigned in the answer below, which the compiler does not follow.
		let shown = null as RiskTitle | null;
		await turn(c, c.remote, { name: "bash", args: { command } }, (ask) => {
			shown = parseRiskTitle(String(ask.title));
			return RISK_DENY;
		});
		expect(shown).toEqual({ tool: "bash", by: "remote", kinds: ["delete_outside"], detail: `Command: ${command}` });
		expect(existsSync(join(victim, "keep.txt"))).toBe(true);
		const asking = c.asked().length;
		await turn(c, c.remote, { name: "bash", args: { command: "echo fine" } });
		expect(c.asked()).toHaveLength(asking);
		await c.close();
	}, 90_000);
});

describe("a conversation that cannot be covered", () => {
	test("a remote page is not given the turn of a process that started without the gate; this computer is", async () => {
		setSettings({ confirmRisky: true });
		// omp refuses `--trusted-extension` together with `--extension`: such a conversation runs without the gate.
		const own = join(root, "trusted.ts");
		writeFileSync(own, "export default function () {}\n");
		const c = await conversation(["--trusted-extension", own]);
		expect(c.live.args).not.toContain("--extension");
		await expect(
			request(c.remote, { t: "rpc", liveId: c.live.liveId, command: { type: "prompt", message: "go" } }),
		).rejects.toThrow(/Confirm risky commands from remote pages is on/);
		// A page on this computer is not refused, and with the setting off nobody is.
		const target = join(outside, "ungated.txt");
		await turn(c, c.local, outsideWrite("ungated.txt"));
		expect(existsSync(target)).toBe(true);
		setSettings({ confirmRisky: false });
		const again = join(outside, "ungated-off.txt");
		await turn(c, c.remote, outsideWrite("ungated-off.txt"));
		expect(existsSync(again)).toBe(true);
		await c.close();
	}, 90_000);

	test("the gate is under the data folder, which has a space in its name here as the app's has, and omp is started with it", async () => {
		const extension = join(dataDir, "gate", "server", "omp", "gate", "extension.ts");
		expect(extension).toContain("Application Support");
		expect(existsSync(extension)).toBe(true);
		setSettings({ confirmRisky: false });
		const c = await conversation();
		// Among the extensions the server gives omp (the quota floor's is another), the gate's, as one argument.
		const given = c.live.args.flatMap((arg, i) => (c.live.args[i - 1] === "--extension" ? [arg] : []));
		expect(given).toContain(extension);
		expect(c.live.args.at(-1)).not.toBe("--extension");
		await c.close();
	}, 90_000);
});

/** The goal's own command: it starts the turn (omp's goal mode runs on by itself in a host the server configured for it). */
const goalCreate = (liveId: string) => ({
	t: "rpc",
	liveId,
	command: { type: "goal", op: "create", objective: "write the file" },
});

describe("a turn that a goal starts is its sender's, as a message's is", () => {
	test("a goal a remote page creates asks the page before a risky call, though a local page sent the last message", async () => {
		setSettings({ confirmRisky: true });
		const c = await conversation();
		// A local message first: the conversation's turn is a local page's, as the reviewer's reproduction had it.
		await turn(c, c.local, { name: "write", args: { path: join(s.work, "first.txt"), content: "x" } });
		const target = join(outside, "goal-remote.txt");
		told.length = 0;
		plan = outsideWrite("goal-remote.txt");
		const ended = c.here.after("agent_end");
		const ask = c.there.next(isConfirmation);
		await request(c.remote, goalCreate(c.live.liveId));
		const frame = await ask;
		expect(parseRiskTitle(String(frame.title))?.kinds).toEqual(["write_outside"]);
		expect(existsSync(target)).toBe(false);
		c.remote.send(
			JSON.stringify({ t: "ui_response", liveId: c.live.liveId, response: { id: frame.id, value: RISK_DENY } }),
		);
		await ended;
		expect(existsSync(target)).toBe(false);
		expect(told.at(-1)).toMatch(/did not allow this high-risk call/);
		await c.close();
	}, 120_000);

	test("a goal a page on this computer creates in a fresh conversation is not asked about: nobody's message came first, and the goal is the turn's sender", async () => {
		setSettings({ confirmRisky: true });
		const c = await conversation();
		const target = join(outside, "goal-local.txt");
		plan = outsideWrite("goal-local.txt");
		const ended = c.here.after("agent_end");
		await request(c.local, goalCreate(c.live.liveId));
		await ended;
		expect(existsSync(target)).toBe(true);
		expect(c.asked()).toEqual([]);
		await c.close();
	}, 120_000);

	test("a goal and a steer of a subagent from a remote page are refused on a process without the gate, as a message is", async () => {
		setSettings({ confirmRisky: true });
		const own = join(root, "trusted-goal.ts");
		writeFileSync(own, "export default function () {}\n");
		const c = await conversation(["--trusted-extension", own]);
		for (const command of [
			{ type: "goal", op: "create", objective: "write the file" },
			{ type: "goal", op: "resume" },
			{ type: "steer_subagent", subagentId: "x", message: "do it" },
			{ type: "abort_and_prompt", message: "go" },
		]) {
			await expect(request(c.remote, { t: "rpc", liveId: c.live.liveId, command }), command.type).rejects.toThrow(
				/Confirm risky commands from remote pages is on/,
			);
		}
		// Reading a goal is not driving: it is not refused.
		await request(c.remote, { t: "rpc", liveId: c.live.liveId, command: { type: "goal", op: "get" } });
		await c.close();
	}, 90_000);
});

describe("a gate that did not start", () => {
	const extension = join(dataDir, "gate", "server", "omp", "gate", "extension.ts");

	test("files damaged since the server started are written again before the next process, which is then covered", async () => {
		setSettings({ confirmRisky: true });
		writeFileSync(extension, "export default function ( { this is not valid\n");
		const c = await conversation();
		expect(c.live.args).toContain(extension);
		const target = join(outside, "repaired.txt");
		plan = outsideWrite("repaired.txt");
		const ended = c.here.after("agent_end");
		const ask = c.there.next(isConfirmation);
		await request(c.remote, { t: "rpc", liveId: c.live.liveId, command: { type: "prompt", message: "go" } });
		const frame = await ask;
		expect(existsSync(target)).toBe(false);
		c.remote.send(
			JSON.stringify({ t: "ui_response", liveId: c.live.liveId, response: { id: frame.id, value: RISK_DENY } }),
		);
		await ended;
		expect(existsSync(target)).toBe(false);
		await c.close();
	}, 90_000);

	test("a gate that cannot be written leaves the process uncovered: a remote page is refused, and the next process is covered once it can be", async () => {
		setSettings({ confirmRisky: true });
		// A folder where the file belongs: it cannot be replaced.
		rmSync(extension, { force: true });
		mkdirSync(extension, { recursive: true });
		const c = await conversation();
		// The model-guidance extension is started with every process, so it is the gate's own path that must be absent.
		expect(c.live.args).not.toContain(extension);
		await expect(
			request(c.remote, { t: "rpc", liveId: c.live.liveId, command: { type: "prompt", message: "go" } }),
		).rejects.toThrow(/Confirm risky commands from remote pages is on/);
		await c.close();
		rmSync(extension, { recursive: true, force: true });
		const next = await conversation();
		expect(next.live.args).toContain(extension);
		await request(next.remote, { t: "rpc", liveId: next.live.liveId, command: { type: "goal", op: "get" } });
		await next.close();
	}, 90_000);
});
