import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import type { LiveInfo, LiveListing, OpenTarget } from "../../shared/protocol.ts";
import { type Frame, watchFrames } from "../support/frames.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type StubChat, type StubOmlx, startStubOmlx } from "../support/stub-omlx.ts";
import { connect, request } from "../support/ws.ts";

/**
 * The subagent models of a preset (omp's `task.agentModelOverrides`) belong to the conversation that switched to it, like the
 * roles do. A real server, real omp processes, a stub provider and no model: what the subagents a conversation dispatches
 * are given is read from the model id each of their requests names, and omp's global config.yml is compared byte for byte.
 *
 * The stub model answers a prompt `DISPATCH <agent> <tag>` with a call of omp's `task` tool, whose subagent is told
 * `SUBAGENT-JOB <tag>`; that subagent's first request names the model it was given.
 */

const GLOBAL = "stub-global";
const ALPHA = "stub-alpha";
const BRAVO = "stub-bravo";

/** Every role on the global model, so what a subagent runs on is its override or nothing but that. */
const GLOBAL_ROLES: Record<string, string> = Object.fromEntries(
	["default", "smol", "task", "tiny", "commit", "slow"].map((role) => [role, `omlx/${GLOBAL}`]),
);

let server: TestServer;
let backend: StubOmlx;

const configYml = () => readFileSync(join(server.agentDir, "config.yml"), "utf8");

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
	server = await startTestServer(0, {}, { login: false });
	writeFileSync(
		join(server.agentDir, "models.yml"),
		`providers:\n  omlx:\n    baseUrl: ${backend.url}\n    api: openai-completions\n    apiKey: ${backend.apiKey}\n    discovery:\n      type: openai-models-list\n`,
	);
	writeFileSync(
		join(server.agentDir, "config.yml"),
		[
			"modelRoles:",
			...Object.entries(GLOBAL_ROLES).map(([role, selector]) => `  ${role}: ${selector}`),
			// `sonic` (a smol-role agent) runs on Alpha until something takes that away.
			"task:",
			"  agentModelOverrides:",
			`    sonic: omlx/${ALPHA}`,
			"modelPresets:",
			// The same roles as the config, and the task subagent on Bravo.
			"  agents:",
			"    modelRoles:",
			...Object.entries(GLOBAL_ROLES).map(([role, selector]) => `      ${role}: ${selector}`),
			"    agentModelOverrides:",
			`      task: omlx/${BRAVO}`,
			// Sets no subagent models: whatever the conversation has stays; the main agent moves to Alpha.
			"  plain:",
			"    modelRoles:",
			...Object.entries({ ...GLOBAL_ROLES, default: `omlx/${ALPHA}` }).map(
				([role, selector]) => `      ${role}: ${selector}`,
			),
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
		info,
		liveId: info.liveId,
		listing,
		switchTo: (name: string) => request<LiveInfo>(ws, { t: "model_preset", liveId: info.liveId, name }),
		async dispatch(agent: string): Promise<Dispatched> {
			const tag = `${info.liveId.replace(/\W/g, "")}n${dispatched++}`;
			const prompt = `DISPATCH ${agent} ${tag}`;
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
			const asking = (needle: string) => backend.chats.find((c) => lastUser(c).includes(needle) && toolCount(c) > 0);
			await pollUntil(() => asking(`SUBAGENT-JOB ${tag}`) !== undefined, `the subagent of ${tag} to ask its model`);
			return {
				main: asking(`DISPATCH ${agent} ${tag}`)?.body.model,
				subagent: asking(`SUBAGENT-JOB ${tag}`)?.body.model,
			};
		},
		close: () => {
			void request(ws, { t: "close", liveId: info.liveId }).catch(() => {});
			ws.close();
		},
	};
}

/** What a conversation was given to run its main agent and the subagent it dispatched, by model id. */
interface Dispatched {
	main: string | undefined;
	subagent: string | undefined;
}

/**
 * Dispatch until the subagent runs on `model`, and return the last result. omp reloads a changed overlay by itself, after
 * a debounce, and macOS delivers file events late on a busy machine: there is no signal to wait for, so the observation is
 * repeated (the first try is the one that counts when the machine is not busy).
 */
async function dispatchedOn(
	chat: { dispatch(agent: string): Promise<Dispatched> },
	agent: string,
	model: string,
	seconds = 15,
) {
	const deadline = Date.now() + seconds * 1000;
	let seen = await chat.dispatch(agent);
	while (seen.subagent !== model && Date.now() < deadline) seen = await chat.dispatch(agent);
	return seen;
}

test("a preset's subagent models are the conversation's, replacing the configuration's, and no other conversation sees them or the config changes", async () => {
	const a = await conversation();
	const b = await conversation();
	const before = configYml();
	try {
		// The configuration: `task` runs on its role's model, `sonic` on the override.
		expect((await a.dispatch("task")).subagent).toBe(GLOBAL);
		expect((await a.dispatch("sonic")).subagent).toBe(ALPHA);

		const switched = await a.switchTo("agents");
		expect(switched.models?.agentModelOverrides).toEqual({ task: `omlx/${BRAVO}` });

		// The preset's override applies; the configuration's `sonic` override is not the conversation's any more.
		expect((await dispatchedOn(a, "task", BRAVO)).subagent).toBe(BRAVO);
		expect((await dispatchedOn(a, "sonic", GLOBAL)).subagent).toBe(GLOBAL);
		expect((await a.listing())?.models?.agentModelOverrides).toEqual({ task: `omlx/${BRAVO}` });

		// B follows the configuration, and so does a conversation opened now.
		expect((await b.dispatch("task")).subagent).toBe(GLOBAL);
		expect((await b.dispatch("sonic")).subagent).toBe(ALPHA);
		expect((await b.listing())?.models).toBeUndefined();
		const c = await conversation();
		try {
			expect(c.info.models).toBeUndefined();
			expect((await c.dispatch("sonic")).subagent).toBe(ALPHA);
		} finally {
			c.close();
		}

		// Not a byte of omp's config.yml: the preset's agents went to the conversation's own overlay.
		expect(configYml()).toBe(before);
	} finally {
		a.close();
		b.close();
	}
}, 300_000);

test("a preset that sets no subagent models leaves the conversation's, and its roles still apply", async () => {
	const a = await conversation();
	try {
		await a.switchTo("agents");
		expect((await dispatchedOn(a, "task", BRAVO)).subagent).toBe(BRAVO);

		const switched = await a.switchTo("plain");
		// Kept: the conversation still has the models it had; the roles and the thinking level are `plain`'s.
		expect(switched.models).toMatchObject({ preset: "plain", agentModelOverrides: { task: `omlx/${BRAVO}` } });
		expect(switched.models?.roles.default).toBe(`omlx/${ALPHA}`);
		const seen = await dispatchedOn(a, "task", BRAVO);
		expect(seen).toEqual({ main: ALPHA, subagent: BRAVO });
		// `sonic` still has none of the configuration's override (Alpha), which the models the conversation kept leave out:
		// it runs on the smol role of `plain`, the global model.
		expect((await dispatchedOn(a, "sonic", GLOBAL)).subagent).toBe(GLOBAL);
	} finally {
		a.close();
	}
}, 300_000);

test("the subagent models belong to the conversation: they hold when it is resumed, and after the server restarts", async () => {
	const first = await conversation();
	let file: string;
	try {
		await first.switchTo("agents");
		expect((await dispatchedOn(first, "task", BRAVO)).subagent).toBe(BRAVO);
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
		expect(resumed.info.models?.agentModelOverrides).toEqual({ task: `omlx/${BRAVO}` });
		expect((await dispatchedOn(resumed, "task", BRAVO)).subagent).toBe(BRAVO);
		expect((await dispatchedOn(resumed, "sonic", GLOBAL)).subagent).toBe(GLOBAL);
	} finally {
		resumed.close();
	}

	await server.restart();
	const restarted = await conversation(resume);
	try {
		expect(restarted.info.models?.agentModelOverrides).toEqual({ task: `omlx/${BRAVO}` });
		expect((await dispatchedOn(restarted, "task", BRAVO)).subagent).toBe(BRAVO);
		const asked = await fetch(`${server.url}/api/model-preset/session?file=${encodeURIComponent(file)}`, {
			headers: { "x-omp-webui-token": server.accessToken, "x-omp-webui": "1" },
		});
		const models: { models: { agentModelOverrides?: Record<string, string> } | null } = await asked.json();
		expect(models.models?.agentModelOverrides).toEqual({ task: `omlx/${BRAVO}` });
	} finally {
		restarted.close();
	}
}, 360_000);
