import { afterAll, beforeAll, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import type { LiveInfo, LiveListing } from "../../shared/protocol.ts";
import { type Frame, watchFrames } from "./frames.ts";
import { pollUntil } from "./poll.ts";
import { startTestServer, type TestServer } from "./server.ts";
import { type StubOmlx, startStubOmlx } from "./stub-omlx.ts";
import { connect, request } from "./ws.ts";

/** The messages of one role that omp said it had finished (`message_end` frames). */
export function messageEnds(frames: Frame[], role: string): Record<string, unknown>[] {
	return frames.flatMap((f) =>
		f.type === "message_end" && isRecord(f.message) && f.message.role === role ? [f.message] : [],
	);
}

/** What `usageResetWaitFixture().conversation()` hands a test: one page's socket on a conversation, and what it heard of it. */
export interface UsageConversation {
	ws: WebSocket;
	liveId: string;
	/** Every omp frame the page was sent, and a way to wait for one. */
	frames: {
		seen: Frame[];
		next: (match: (f: Frame) => boolean) => Promise<Frame>;
		after: (type: string) => Promise<Frame>;
	};
	/** The `live` announcements of the process the page heard, in order. */
	infos: LiveInfo[];
	prompt: (message: string) => Promise<unknown>;
	listing: () => Promise<LiveListing | undefined>;
	/** The first frame of this type from now on. */
	next: (type: string, match?: (f: Frame) => boolean) => Promise<Frame>;
	/** Run one turn that the provider answers, and return the conversation's session file. */
	start: () => Promise<string>;
	close: () => void;
}

/**
 * A real server, omp and stub provider owned by one contract file. Retry deadline assertions need real clocks;
 * independent files get their own config and provider limit so those waits can overlap without weakening them.
 * The stub answers 402: omp classifies it as a usage limit and its transport never retries below the retry under test.
 */
export function usageResetWaitFixture() {
	let server: TestServer;
	let backend: StubOmlx;
	const headers = () => ({
		"x-omp-webui-token": server.accessToken,
		"x-omp-webui": "1",
		"content-type": "application/json",
	});
	const api = (path: string, body?: unknown) =>
		fetch(`${server.url}${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: headers(),
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	const waitState = async (file?: string): Promise<{ omp: boolean | null; session: boolean | null }> =>
		(await api(`/api/usage-reset-wait${file ? `?file=${encodeURIComponent(file)}` : ""}`)).json();
	const configYml = () => readFileSync(join(server.agentDir, "config.yml"), "utf8");
	const ompConfigGet = async (key: string): Promise<string> => {
		const proc = Bun.spawn([process.env.OMP_BIN ?? "omp", "config", "get", key], {
			env: { ...process.env, HOME: server.home, PI_CODING_AGENT_DIR: server.agentDir },
			stdout: "pipe",
			stderr: "ignore",
		});
		const out = (await new Response(proc.stdout).text()).trim();
		await proc.exited;
		return out;
	};
	const ompConfigSet = async (key: string, value: string): Promise<void> => {
		const proc = Bun.spawn([process.env.OMP_BIN ?? "omp", "config", "set", key, value], {
			env: { ...process.env, HOME: server.home, PI_CODING_AGENT_DIR: server.agentDir },
			stdout: "ignore",
			stderr: "ignore",
		});
		expect(await proc.exited).toBe(0);
	};

	/** A conversation on its own page (socket), in `cwd`: the server's working folder unless another is given. */
	async function conversation(cwd = server.work): Promise<UsageConversation> {
		const ws = await connect(server);
		const info = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd } });
		const frames = watchFrames(ws, info.liveId);
		const infos: LiveInfo[] = [];
		ws.addEventListener("message", (ev) => {
			const m = JSON.parse(String(ev.data));
			if (m.t === "live" && m.info.liveId === info.liveId) infos.push(m.info);
		});
		const prompt = (message: string) =>
			request(ws, { t: "rpc", liveId: info.liveId, command: { type: "prompt", message } });
		const listing = async () =>
			(await request<LiveListing[]>(ws, { t: "list_lives" })).find((l) => l.liveId === info.liveId);
		const next = (type: string, match: (f: Frame) => boolean = () => true) => {
			const from = frames.seen.length;
			return frames.next((f) => f.type === type && match(f) && frames.seen.indexOf(f) >= from);
		};
		return {
			ws,
			liveId: info.liveId,
			frames,
			infos,
			prompt,
			listing,
			next,
			async start() {
				backend.limitUntil = 0;
				const done = next("agent_end");
				await prompt("hello");
				await done;
				await pollUntil(async () => Boolean((await listing())?.sessionFile), "the session file");
				return (await listing())?.sessionFile as string;
			},
			close: () => {
				void request(ws, { t: "close", liveId: info.liveId }).catch(() => {});
				ws.close();
			},
		};
	}

	beforeAll(async () => {
		backend = await startStubOmlx({ limit: { status: 402 } });
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
				"retry:",
				"  maxDelayMs: 2000",
				"  waitForUsageReset: false",
				"",
			].join("\n"),
		);
	}, 120_000);
	afterAll(async () => {
		await server?.stop();
		await backend?.stop();
	});

	return {
		get server() {
			return server;
		},
		get backend() {
			return backend;
		},
		api,
		waitState,
		configYml,
		ompConfigGet,
		ompConfigSet,
		conversation,
	};
}
