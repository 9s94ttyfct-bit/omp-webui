import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import type { LiveInfo } from "../../shared/protocol.ts";
import { watchFrames } from "../support/frames.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type ScriptedTurn, type StubScripted, startScriptedStub } from "../support/stub-scripted.ts";
import { connect, request } from "../support/ws.ts";

/**
 * "Parallel subagents" against the real omp: a conversation's own limit (`POST /api/subagent-concurrency/session`) is a
 * `task.maxConcurrency` line in its process's `--config` overlay, which the running omp reloads by itself (it started with
 * omp's default, 32), and with a limit of 1 omp runs the three subagents of one `task` call one after another. The ones
 * waiting are what every page is told as `LiveInfo.queuedSubagents`, from omp's own progress records of the call.
 *
 * A scripted provider holds each subagent's reply until the test lets it go, so which of them have asked the model is what
 * omp is running.
 */

const NESTED = "You are operating on a piece of work assigned to you by the main agent";
const NAMES = ["A", "B", "C"] as const;
let server: TestServer;
let backend: StubScripted;
const gate = () => Promise.withResolvers<void>();
const gates: Record<(typeof NAMES)[number], ReturnType<typeof gate>> = { A: gate(), B: gate(), C: gate() };

const script = async (req: { text: string; tools: string[]; toolResults: number }): Promise<ScriptedTurn> => {
	if (req.text.includes(NESTED)) {
		const name = NAMES.find((n) => req.text.includes(`${n}-TASK`));
		if (name) {
			await gates[name].promise;
			return { text: `${name}-DONE` };
		}
	}
	if (!req.tools.includes("task")) return { text: "A title" };
	if (req.text.includes("Send scouts") && req.toolResults === 0) {
		return {
			call: {
				name: "task",
				args: { context: "Three scouts.", tasks: NAMES.map((n) => ({ name: n, task: `${n}-TASK: say ${n}-DONE.` })) },
			},
		};
	}
	return { text: "Noted." };
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
	for (const g of Object.values(gates)) g.resolve();
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

/** The overlay of the conversation's process: the server's own `--config`, last on its command line. */
function overlayTask(liveId: string): Record<string, unknown> | undefined {
	const dir = readdirSync(server.tmpDir).find(
		(name) => name.startsWith("ompw-live-") && existsSync(join(server.tmpDir, name, `${liveId}.yml`)),
	);
	expect(dir).toBeDefined();
	const parsed: unknown = Bun.YAML.parse(readFileSync(join(server.tmpDir, dir as string, `${liveId}.yml`), "utf8"));
	return isRecord(parsed) && isRecord(parsed.task) ? parsed.task : undefined;
}

const nested = () =>
	backend.requests.filter((r) => r.text.includes(NESTED)).map((r) => NAMES.find((n) => r.text.includes(`${n}-TASK`)));

test("a conversation's limit reaches its running omp, which then queues the subagents beyond it, and the pages are told who waits", async () => {
	const ws = await connect(server);
	const info = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: server.work } });
	const frames = watchFrames(ws, info.liveId);
	try {
		// One turn writes the conversation's file, which the limit is kept by.
		const first = frames.next((f) => f.type === "agent_end");
		await request(ws, { t: "rpc", liveId: info.liveId, command: { type: "prompt", message: "Hello" } });
		await first;
		await pollUntil(async () => Boolean((await listing(info.liveId))?.sessionFile), "the session file");
		const file = (await listing(info.liveId))?.sessionFile as string;

		// omp's own value: its default, as nothing configures it.
		expect(await (await api("/api/subagent-concurrency")).json()).toEqual({ omp: 32, session: null });
		for (const bad of [17, -1, 2.5, "1"]) {
			expect((await api("/api/subagent-concurrency/session", { file, limit: bad })).status).toBe(400);
		}
		expect((await api("/api/subagent-concurrency/session", { file: "/etc/hosts", limit: 1 })).status).toBe(404);
		const set = await api("/api/subagent-concurrency/session", { file, limit: 1 });
		expect(await set.json()).toEqual({ omp: 32, session: 1 });
		expect(overlayTask(info.liveId)).toEqual({ maxConcurrency: 1 });
		await pollUntil(
			async () => (await listing(info.liveId))?.subagentConcurrency === 1,
			"the process to say its limit",
		);
		expect(await (await api(`/api/subagent-concurrency?file=${encodeURIComponent(file)}`)).json()).toEqual({
			omp: 32,
			session: 1,
		});

		await request(ws, { t: "rpc", liveId: info.liveId, command: { type: "prompt", message: "Send scouts" } });
		// One runs, two wait: omp asked for one subagent's reply, and every page is told the other two are queued.
		await pollUntil(() => nested().length === 1, "the first subagent to ask the model");
		await pollUntil(
			async () => (await listing(info.liveId))?.queuedSubagents?.map((q) => q.id).join() === "B,C",
			"the pages to be told B and C wait",
		);
		const waiting = (await listing(info.liveId))?.queuedSubagents ?? [];
		expect(waiting[0]).toMatchObject({ id: "B", agent: "task", assignment: "B-TASK: say B-DONE." });
		expect(nested()).toEqual(["A"]);

		// Each starts only when the one before it ended.
		gates.A.resolve();
		await pollUntil(() => nested().length === 2, "the second subagent to ask the model");
		expect(nested()).toEqual(["A", "B"]);
		await pollUntil(
			async () => (await listing(info.liveId))?.queuedSubagents?.map((q) => q.id).join() === "C",
			"only C to wait",
		);
		gates.B.resolve();
		await pollUntil(() => nested().length === 3, "the third subagent to ask the model");
		await pollUntil(async () => (await listing(info.liveId))?.queuedSubagents === undefined, "nothing to wait");
		gates.C.resolve();
		await frames.next(
			(f) =>
				f.type === "subagent_lifecycle" &&
				isRecord(f.payload) &&
				f.payload.id === "C" &&
				f.payload.status === "completed",
		);

		// Default again: the overlay says nothing of it, and the process follows omp's configuration.
		expect(await (await api("/api/subagent-concurrency/session", { file, limit: null })).json()).toEqual({
			omp: 32,
			session: null,
		});
		expect(overlayTask(info.liveId)?.maxConcurrency).toBeUndefined();
		await pollUntil(
			async () => (await listing(info.liveId))?.subagentConcurrency === undefined,
			"the limit to be cleared",
		);

		// omp's own value, as `omp config set` writes it, and back to its default.
		expect(await (await api("/api/subagent-concurrency", { limit: 4 })).json()).toEqual({ omp: 4, session: null });
		expect(readFileSync(join(server.agentDir, "config.yml"), "utf8")).toContain("maxConcurrency: 4");
		expect((await api("/api/subagent-concurrency", { limit: 99 })).status).toBe(400);
		expect(await (await api("/api/subagent-concurrency", { limit: null })).json()).toEqual({ omp: 32, session: null });
	} finally {
		ws.close();
	}
}, 120_000);
