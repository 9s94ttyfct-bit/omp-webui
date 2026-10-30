import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import type { LiveInfo, LiveListing, OpenTarget } from "../../shared/protocol.ts";
import { type Frame, watchFrames } from "../support/frames.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type StubChat, type StubOmlx, startStubOmlx } from "../support/stub-omlx.ts";
import { connect, request } from "../support/ws.ts";

/**
 * A preset switch belongs to the conversation it is made in. A real server, real omp processes (two conversations
 * running at once), a stub provider and no model: what a conversation's main agent and the subagents it dispatches are
 * given is read from the model id each of their requests names, and omp's global config.yml is compared byte for byte.
 *
 * The stub model answers a prompt `DISPATCH <agent> <tag>` with a call of omp's `task` tool, whose subagent is told
 * `SUBAGENT-JOB <tag>`. omp starts that subagent in the background; its first request names the model it was given.
 */

const GLOBAL = "stub-global";
const ALPHA = "stub-alpha";
const BRAVO = "stub-bravo";

/** The roles of the global config the tests start from: every role but `slow`, all on the global model. */
const GLOBAL_ROLES: Record<string, string> = Object.fromEntries(
	["default", "smol", "task", "tiny", "commit"].map((role) => [role, `omlx/${GLOBAL}`]),
);

let server: TestServer;
let backend: StubOmlx;

const configYml = () => readFileSync(join(server.agentDir, "config.yml"), "utf8");

/** The text of a chat request's last user message. */
function lastUser(chat: StubChat): string {
	const users = (chat.body.messages ?? []).filter((m) => m.role === "user");
	const content = users[users.length - 1]?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("");
}

const toolCount = (chat: StubChat) => chat.body.tools?.length ?? 0;

beforeAll(async () => {
	backend = await startStubOmlx({
		models: [GLOBAL, ALPHA, BRAVO],
		respond: (chat) => {
			// A tool result is the last thing the model sees once it has called its tool: say something, call nothing.
			if (chat.body.messages?.at(-1)?.role === "tool") return undefined;
			const dispatch = /DISPATCH (\w+) (\w+)/.exec(lastUser(chat));
			if (!dispatch || !chat.body.tools?.some((t) => t.function?.name === "task")) return undefined;
			return {
				toolCalls: [
					{
						name: "task",
						arguments: {
							agent: dispatch[1],
							task: `SUBAGENT-JOB ${dispatch[2]}`,
							solutionSpace: "one fix: nothing to change",
						},
					},
				],
			};
		},
	});
	// No login: the stub provider is the only model there is.
	server = await startTestServer(0, {}, { login: false });
	writeFileSync(
		join(server.agentDir, "models.yml"),
		`providers:\n  omlx:\n    baseUrl: ${backend.url}\n    api: openai-completions\n    apiKey: ${backend.apiKey}\n    discovery:\n      type: openai-models-list\n`,
	);
	writeFileSync(
		join(server.agentDir, "config.yml"),
		[
			"modelRoles:",
			// No `slow` role: the reviewer agent, which runs on it, inherits the default role until a test adds one.
			...Object.entries(GLOBAL_ROLES).map(([role, selector]) => `  ${role}: ${selector}`),
			"modelPresets:",
			// Sets the default and task roles only: smol, tiny and commit are the config's, which the preset leaves out.
			"  alpha:",
			"    modelRoles:",
			`      default: omlx/${ALPHA}`,
			`      task: omlx/${ALPHA}`,
			"    defaultThinkingLevel: low",
			// The main agent and its task subagents on different models.
			"  mixed:",
			"    modelRoles:",
			`      default: omlx/${ALPHA}`,
			`      task: omlx/${BRAVO}`,
			"  broken:",
			"    modelRoles:",
			"      default: nope/missing-model",
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

/** One conversation: a tab on a process of its own, which can be told to dispatch a subagent and asked what it ran on. */
async function conversation(target?: OpenTarget) {
	const ws = await connect(server);
	const info = await request<LiveInfo>(ws, { t: "open", target: target ?? { kind: "new", cwd: server.work } });
	const frames = watchFrames(ws, info.liveId);
	const rpc = (command: Record<string, unknown>) => request(ws, { t: "rpc", liveId: info.liveId, command });
	const listing = async () =>
		(await request<LiveListing[]>(ws, { t: "list_lives" })).find((l) => l.liveId === info.liveId);
	let dispatched = 0;
	return {
		ws,
		info,
		liveId: info.liveId,
		frames,
		rpc,
		listing,
		switchTo: (name: string) => request<LiveInfo>(ws, { t: "model_preset", liveId: info.liveId, name }),
		/**
		 * Have the main agent dispatch `agent` and wait until the subagent has asked its model, then say which models the
		 * main agent and the subagent were given.
		 */
		async dispatch(agent = "task"): Promise<{ main: string | undefined; subagent: string | undefined }> {
			const tag = `${info.liveId.replace(/\W/g, "")}n${dispatched++}`;
			const prompt = `DISPATCH ${agent} ${tag}`;
			// A subagent that finishes hands its result to the conversation, which starts a turn of its own to read it: a
			// prompt sent meanwhile is refused until that turn is over.
			await pollUntil(
				async () => {
					try {
						await rpc({ type: "prompt", message: prompt });
						return true;
					} catch (e) {
						if (/already processing/i.test((e as Error).message)) return false;
						throw e;
					}
				},
				"the conversation to take the prompt",
				60_000,
			);
			const asked = await frames.next(
				(f: Frame) => f.type === "message_end" && JSON.stringify(f.message).includes(prompt),
			);
			const askedAt = frames.seen.indexOf(asked);
			await frames.next((f: Frame) => f.type === "agent_end" && frames.seen.indexOf(f) > askedAt);
			// omp also asks a small model to name the task, with the same text and no tools: that is not the subagent.
			const request = (needle: string) => backend.chats.find((c) => lastUser(c).includes(needle) && toolCount(c) > 0);
			await pollUntil(() => request(`SUBAGENT-JOB ${tag}`) !== undefined, `the subagent of ${tag} to ask its model`);
			return {
				main: request(`DISPATCH ${agent} ${tag}`)?.body.model,
				subagent: request(`SUBAGENT-JOB ${tag}`)?.body.model,
			};
		},
		close: () => {
			void request(ws, { t: "close", liveId: info.liveId }).catch(() => {});
			ws.close();
		},
	};
}

type Conversation = Awaited<ReturnType<typeof conversation>>;

/**
 * Dispatch until the subagent runs on `model`, and return the last result. omp reloads a changed overlay by itself, after
 * a debounce, and macOS delivers file events late on a busy machine: there is no signal to wait for, so the observation
 * is repeated (the first try is the one that counts when the machine is not busy).
 */
async function dispatchedOn(chat: Conversation, model: string, agent = "task", seconds = 15) {
	const deadline = Date.now() + seconds * 1000;
	let seen = await chat.dispatch(agent);
	while (seen.subagent !== model && Date.now() < deadline) seen = await chat.dispatch(agent);
	return seen;
}

test("a preset switch in one conversation changes that conversation and its subagents, not the others or the config", async () => {
	const a = await conversation();
	const b = await conversation();
	const before = configYml();
	try {
		expect(await a.dispatch()).toEqual({ main: GLOBAL, subagent: GLOBAL });
		expect(await b.dispatch()).toEqual({ main: GLOBAL, subagent: GLOBAL });

		const switched = await a.switchTo("mixed");
		expect(switched.models).toEqual({ preset: "mixed", roles: { default: `omlx/${ALPHA}`, task: `omlx/${BRAVO}` } });

		// A: the main agent runs on the preset's default role, the subagent it dispatches from now on on its task role.
		expect(await dispatchedOn(a, BRAVO)).toEqual({ main: ALPHA, subagent: BRAVO });
		// B, and what B dispatches, is untouched: the global config is what it runs on.
		expect(await b.dispatch()).toEqual({ main: GLOBAL, subagent: GLOBAL });
		expect((await b.listing())?.models).toBeUndefined();
		expect((await a.listing())?.models?.preset).toBe("mixed");

		// A switch writes nothing to omp's own config: not the roles, not the thinking level, not a byte.
		expect(configYml()).toBe(before);

		// A conversation opened now starts from the global default.
		const c = await conversation();
		try {
			expect(c.info.models).toBeUndefined();
			expect(await c.dispatch()).toEqual({ main: GLOBAL, subagent: GLOBAL });
		} finally {
			c.close();
		}
	} finally {
		a.close();
		b.close();
	}
}, 180_000);

test("the roles a preset leaves out are not the conversation's either, as `/modelpreset switch` leaves the config", async () => {
	const a = await conversation();
	const b = await conversation();
	try {
		// `sonic` is a smol-role agent. The config's smol is the global model; `alpha` sets no smol.
		expect((await a.dispatch("sonic")).subagent).toBe(GLOBAL);
		await a.switchTo("alpha");
		// Without a smol role of its own the conversation falls back to its default role, which `alpha` sets.
		expect((await dispatchedOn(a, ALPHA, "sonic")).subagent).toBe(ALPHA);
		expect((await b.dispatch("sonic")).subagent).toBe(GLOBAL);
	} finally {
		a.close();
		b.close();
	}
}, 180_000);

/** What the Settings page does to the global default: one write of the whole role map. */
async function setGlobalRoles(roles: Record<string, string>) {
	const res = await fetch(`${server.url}/api/model-config/roles`, {
		method: "POST",
		headers: { "x-omp-webui-token": server.accessToken, "x-omp-webui": "1", "content-type": "application/json" },
		body: JSON.stringify({ roles }),
	});
	expect(res.status).toBe(200);
}

/**
 * Switch A to `alpha`, then give the configuration the `slow` role the reviewer agent runs on (`change` does it): B, which
 * follows the configuration, runs the reviewer on it, and A, whose roles are its preset's only, still on its default role.
 * omp reloads a changed config by itself and the server then rewrites A's overlay, so A may see the new role for a moment
 * before that: it is the state it settles in that counts.
 */
async function addedRoleStaysOutOfA(change: () => void | Promise<void>) {
	const a = await conversation();
	const b = await conversation();
	try {
		await a.switchTo("alpha");
		expect((await dispatchedOn(a, ALPHA, "reviewer")).subagent).toBe(ALPHA);
		expect((await b.dispatch("reviewer")).subagent).toBe(GLOBAL);

		await change();
		expect((await dispatchedOn(b, BRAVO, "reviewer", 40)).subagent).toBe(BRAVO);
		expect((await dispatchedOn(a, ALPHA, "reviewer", 40)).subagent).toBe(ALPHA);
		expect((await a.dispatch("reviewer")).subagent).toBe(ALPHA);
	} finally {
		a.close();
		b.close();
	}
}

test("a role added to the global config later does not reach a switched conversation: only its preset's roles apply", async () => {
	try {
		await addedRoleStaysOutOfA(() => setGlobalRoles({ ...GLOBAL_ROLES, slow: `omlx/${BRAVO}` }));
	} finally {
		await setGlobalRoles(GLOBAL_ROLES);
	}
}, 300_000);

test("nor does a role added to the project's config", async () => {
	const project = join(server.work, ".omp");
	try {
		await addedRoleStaysOutOfA(() => {
			mkdirSync(project, { recursive: true });
			writeFileSync(join(project, "config.yml"), `modelRoles:\n  slow: omlx/${BRAVO}\n`);
		});
	} finally {
		rmSync(project, { recursive: true, force: true });
	}
}, 300_000);

test("a preset typed into the composer is the conversation's switch too", async () => {
	const a = await conversation();
	const b = await conversation();
	const before = configYml();
	try {
		const said = a.frames.next((f) => f.type === "command_output");
		await a.rpc({ type: "prompt", message: "/modelpreset switch mixed" });
		expect(String((await said).text)).toContain("mixed");
		expect((await a.listing())?.models?.preset).toBe("mixed");
		expect(await dispatchedOn(a, BRAVO)).toEqual({ main: ALPHA, subagent: BRAVO });
		expect(await b.dispatch()).toEqual({ main: GLOBAL, subagent: GLOBAL });
		expect(configYml()).toBe(before);
	} finally {
		a.close();
		b.close();
	}
}, 180_000);

test("a preset omp could not apply is refused and the conversation stays as it was", async () => {
	const a = await conversation();
	try {
		await expect(a.switchTo("nope")).rejects.toThrow(/no preset/i);
		await expect(a.switchTo("broken")).rejects.toThrow(/not available/i);
		await expect(a.switchTo("1bad name")).rejects.toThrow();
		expect((await a.listing())?.models).toBeUndefined();
		expect(await a.dispatch()).toEqual({ main: GLOBAL, subagent: GLOBAL });
	} finally {
		a.close();
	}
}, 120_000);

test("the preset belongs to the conversation: it holds when the conversation is resumed, and after the server restarts", async () => {
	const first = await conversation();
	let file: string;
	try {
		await first.switchTo("mixed");
		// The conversation has to have a reply for omp to have written its session file.
		expect(await dispatchedOn(first, BRAVO)).toEqual({ main: ALPHA, subagent: BRAVO });
		await pollUntil(async () => Boolean((await first.listing())?.sessionFile), "the session file");
		file = (await first.listing())?.sessionFile ?? "";
	} finally {
		first.close();
	}
	await pollUntil(async () => {
		const ws = await connect(server);
		try {
			return !(await request<LiveListing[]>(ws, { t: "list_lives" })).some((l) => l.liveId === first.liveId);
		} finally {
			ws.close();
		}
	}, "the first process to end");

	const resume: OpenTarget = { kind: "resume", sessionFile: file };
	const resumed = await conversation(resume);
	try {
		expect(resumed.info.models?.preset).toBe("mixed");
		expect(await resumed.dispatch()).toEqual({ main: ALPHA, subagent: BRAVO });
	} finally {
		resumed.close();
	}

	// The server's own memory of it is on disk, not in the process.
	await server.restart();
	const restarted = await conversation(resume);
	try {
		expect(restarted.info.models?.preset).toBe("mixed");
		expect(await restarted.dispatch()).toEqual({ main: ALPHA, subagent: BRAVO });
		// And the page can ask for it without a process, as a conversation that is not running is shown.
		const asked = await fetch(`${server.url}/api/model-preset/session?file=${encodeURIComponent(file)}`, {
			headers: { "x-omp-webui-token": server.accessToken, "x-omp-webui": "1" },
		});
		expect(((await asked.json()) as { models: { preset: string } | null }).models?.preset).toBe("mixed");
	} finally {
		restarted.close();
	}
}, 240_000);
