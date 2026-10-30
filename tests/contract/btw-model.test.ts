import { afterAll, beforeAll, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import { PREF, type PrefsSnapshot } from "../../shared/prefs.ts";
import type { LiveInfo, LiveListing } from "../../shared/protocol.ts";
import { type Frame, watchFrames } from "../support/frames.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type StubChat, type StubOmlx, startStubOmlx } from "../support/stub-omlx.ts";
import { connect, request } from "../support/ws.ts";

/**
 * Side questions on the model the person chose (`ompw.btwModel`). omp answers a side question with the model of the session
 * and takes none in `btw`, so the server answers these in a process of its own on a copy of the conversation. A real server,
 * real omp processes and a stub provider, no model: what each request names as its model says who answered, and what the
 * conversation's own model, file and next turn were is read back from the same places.
 *
 * `OMP_BIN` is a wrapper that notes the command line of every omp it starts and then runs the real one.
 */

const MAIN = "m-main";
const SIDE = "m-side";
const OTHER = "m-other";

let server: TestServer;
let backend: StubOmlx;
let argvLog: string;
let scratch = "";

const dataDir = () => join(server.root, "data");
const forkDir = () => join(dataDir(), "btw-fork");
/** The folders of the questions that run now. */
const runs = () => (existsSync(forkDir()) ? readdirSync(forkDir()) : []);

/** The command lines of every omp the server has started, each as its arguments. */
function invocations(): string[][] {
	const text = existsSync(argvLog) ? readFileSync(argvLog, "utf8") : "";
	return text
		.split("--\n")
		.filter((block) => block !== "")
		.map((block) => block.replace(/\n$/, "").split("\n"));
}
/** The command lines of the processes that answer side questions (omp's `--mode rpc`; the conversations run `rpc-ui`). */
const forks = () =>
	invocations().filter((args) => {
		const at = args.indexOf("--mode");
		return at >= 0 && args[at + 1] === "rpc";
	});
const flagValue = (args: string[], flag: string) => args[args.lastIndexOf(flag) + 1];

/** The mode and path of everything the wrappers found in the folders of the copies, as lines (a `scan <folder>` line before each folder's). */
const scanned = () =>
	existsSync(`${argvLog}.modes`) ? readFileSync(`${argvLog}.modes`, "utf8").split("\n").filter(Boolean) : [];

beforeAll(async () => {
	backend = await startStubOmlx({
		models: [MAIN, SIDE, OTHER],
		// The answer names the model that was asked: a text a test can tell apart without reading the request.
		respond: (chat) => ({ text: `ANSWER-FROM-${chat.body.model}` }),
	});
	const real = Bun.which("omp");
	if (!real) throw new Error("omp is not installed");
	scratch = mkdtempSync(join(tmpdir(), "ompw-btw-model-"));
	argvLog = join(scratch, "argv.log");
	const wrapper = join(scratch, "omp");
	// Every omp is noted. A process that answers a side question (`--mode rpc`) is not replaced by omp (`exec`): once omp has
	// ended, the modes of everything in the folder of its copy are written down, before the server removes it.
	writeFileSync(
		wrapper,
		String.raw`#!/bin/sh
{ for a in "$@"; do printf '%s\n' "$a"; done; echo '--'; } >> "${argvLog}"
case " $* " in *" --mode rpc "*) ;; *) exec "${real}" "$@" ;; esac
"${real}" "$@"
code=$?
prev=
dir=
for a in "$@"; do
  if [ "$prev" = "--resume" ]; then dir=$(dirname "$a"); fi
  prev=$a
done
if [ -n "$dir" ]; then
  { echo "scan $dir"; find "$dir" ! -type l -exec stat -f '%Lp %N' {} \; ; } >> "${argvLog}.modes"
fi
exit $code
`,
		{ mode: 0o755 },
	);
	chmodSync(wrapper, 0o755);
	server = await startTestServer(0, { OMP_BIN: wrapper }, { login: false });
	writeFileSync(
		join(server.agentDir, "models.yml"),
		`providers:\n  omlx:\n    baseUrl: ${backend.url}\n    api: openai-completions\n    apiKey: ${backend.apiKey}\n    discovery:\n      type: openai-models-list\n`,
	);
	writeFileSync(
		join(server.agentDir, "config.yml"),
		[
			"modelRoles:",
			...["default", "smol", "slow", "tiny", "commit"].map((role) => `  ${role}: omlx/${MAIN}`),
			"spelling:",
			"  autocomplete: ngram",
			"",
		].join("\n"),
	);
}, 120_000);

afterAll(async () => {
	await server?.stop();
	await backend?.stop();
	if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const setChoice = async (model: string | null) => {
	const res = await fetch(`${server.url}/api/prefs`, {
		method: "POST",
		headers: { "x-omp-webui-token": server.accessToken, "x-omp-webui": "1", "content-type": "application/json" },
		body: JSON.stringify({ changes: { [PREF.btwModel]: model } }),
	});
	expect(res.status).toBe(200);
};

/** The text of a chat request's last user message. */
function lastUser(chat: StubChat): string {
	const users = (chat.body.messages ?? []).filter((m) => m.role === "user");
	const content = users[users.length - 1]?.content;
	if (typeof content === "string") return content;
	return Array.isArray(content)
		? content.map((p) => (isRecord(p) && typeof p.text === "string" ? p.text : "")).join("")
		: "";
}

const requestsTo = (model: string) => backend.chats.filter((c) => c.body.model === model);

/** Every path under `dir` (links aside) that group or others can reach, with its mode. */
function reachableBy(dir: string): string[] {
	const found: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		const info = lstatSync(path);
		if (info.isSymbolicLink()) continue;
		if (info.mode & 0o077) found.push(`${path} ${(info.mode & 0o777).toString(8)}`);
		if (info.isDirectory()) found.push(...reachableBy(path));
	}
	return found;
}

interface Wire {
	id: string;
	question: string;
	answer: string;
	status: string;
	model?: string;
	error?: string;
	followUps?: { question: string; answer: string; status: string }[];
}

/** One conversation, with a main turn behind it (so that there is a session file to ask about) unless `turn` is false. */
async function conversation(turn = true) {
	const ws = await connect(server);
	const info = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: server.work } });
	const frames = watchFrames(ws, info.liveId);
	const rpc = <T = unknown>(command: Record<string, unknown>) =>
		request<T>(ws, { t: "rpc", liveId: info.liveId, command });
	const mainTurn = async (text: string) => {
		const seen = frames.seen.length;
		await rpc({ type: "prompt", message: text });
		await frames.next((f) => f.type === "agent_end" && frames.seen.indexOf(f) >= seen);
	};
	let file = "";
	if (turn) {
		await mainTurn("remember the word PINEAPPLE");
		await pollUntil(async () => {
			const live = (await request<LiveListing[]>(ws, { t: "list_lives" })).find((l) => l.liveId === info.liveId);
			file = live?.sessionFile ?? "";
			return file !== "" && existsSync(file);
		}, "the session file");
	}
	/** Where in the frames each side question was asked: its end is the first frame about it after that. */
	const askedAt = new Map<string, number>();
	/** The question's record once its latest turn has ended, as the page is told. */
	const ended = (id: string) =>
		frames.next((f: Frame) => {
			const r = f.record as Wire | undefined;
			if (f.type !== "btw_record" || r?.id !== id || frames.seen.indexOf(f) < (askedAt.get(id) ?? 0)) return false;
			return (r.followUps?.at(-1) ?? r).status !== "running";
		});
	const ask = async (question: string, recordId?: string) => {
		const from = frames.seen.length;
		const r = await rpc<{ record: Wire }>({ type: "btw", question, ...(recordId ? { recordId } : {}) });
		askedAt.set(r.record.id, from);
		return r.record;
	};
	return {
		ws,
		info,
		frames,
		rpc,
		file,
		mainTurn,
		ask,
		ended,
		history: async () => (await rpc<{ records: Wire[] }>({ type: "get_btw_history" })).records,
		model: async () => (await rpc<{ model: { id: string } }>({ type: "get_state" })).model.id,
		close: () => {
			void request(ws, { t: "close", liveId: info.liveId }).catch(() => {});
			ws.close();
		},
	};
}

test("a side question goes to the chosen model; the conversation's model, file and next turn stay as they were", async () => {
	const chat = await conversation();
	try {
		// What the conversation's omp writes after its turn (it settles within a moment): the file as it stays.
		let before = readFileSync(chat.file);
		await pollUntil(() => {
			const now = readFileSync(chat.file);
			const same = now.equals(before);
			before = now;
			return same;
		}, "the session file to settle");
		await setChoice(`omlx/${SIDE}`);

		const record = await chat.ask("which word did I ask you to remember?");
		expect(record).toMatchObject({ status: "running", model: `omlx/${SIDE}`, answer: "" });
		expect(record.id).toStartWith("side-");
		const done = (await chat.ended(record.id)).record as Wire;
		expect(done).toMatchObject({ status: "complete", answer: `ANSWER-FROM-${SIDE}`, model: `omlx/${SIDE}` });

		// The side model was asked, with the conversation as context and the question, and the main model was not.
		const asked = requestsTo(SIDE);
		expect(asked).toHaveLength(1);
		const text = JSON.stringify(asked[0]?.body.messages);
		expect(text).toContain("PINEAPPLE");
		expect(text).toContain("which word did I ask you to remember?");
		expect(requestsTo(MAIN).some((c) => JSON.stringify(c.body.messages).includes("which word did I ask"))).toBe(false);

		// The answer was streamed to the page as omp streams its own.
		expect(chat.frames.seen.some((f) => f.type === "btw_delta" && f.recordId === record.id)).toBe(true);

		// The conversation: its file is the one it had, byte for byte, and omp still runs it on its own model.
		expect(readFileSync(chat.file).equals(before)).toBe(true);
		expect(await chat.model()).toBe(MAIN);
		// What the process made is gone, folder and all, once it has ended.
		await pollUntil(() => runs().length === 0, "the copy of the conversation to be removed");

		// The next turn of the main agent is on the conversation's model and has not heard of the side question.
		const mainBefore = requestsTo(MAIN).length;
		await chat.mainTurn("and now, a main turn");
		const next = requestsTo(MAIN).slice(mainBefore);
		expect(next.length).toBeGreaterThan(0);
		expect(requestsTo(SIDE)).toHaveLength(1);
		expect(JSON.stringify(next.at(-1)?.body.messages)).not.toContain("which word did I ask you to remember?");
		expect(await chat.model()).toBe(MAIN);

		// The panel's history lists it with the model that answered.
		expect((await chat.history()).find((r) => r.id === record.id)).toMatchObject({
			status: "complete",
			model: `omlx/${SIDE}`,
			answer: `ANSWER-FROM-${SIDE}`,
		});
	} finally {
		await setChoice(null);
		chat.close();
	}
}, 120_000);

test("the process that answers is the conversation's own command line on a copy, bound to the chosen model, in a private folder", async () => {
	const chat = await conversation();
	const release = backend.hold();
	try {
		await setChoice(`omlx/${SIDE}`);
		const seen = forks().length;
		const record = await chat.ask("what is the word?");
		// The process starts once its copy is made: held at its model, the folder is there and private to this user.
		await pollUntil(() => forks().length > seen, "the process to start");
		expect(runs()).toHaveLength(1);
		const run = join(forkDir(), runs()[0] as string);
		expect(statSync(forkDir()).mode & 0o777).toBe(0o700);
		expect(statSync(run).mode & 0o777).toBe(0o700);
		// Everything under it, what omp wrote there as well as the copies: no group or other bits anywhere.
		await pollUntil(() => existsSync(join(run, "session")), "omp to checkpoint the question");
		expect(reachableBy(forkDir())).toEqual([]);
		expect(readdirSync(run)).toContain("session.jsonl");

		const args = forks()[seen] as string[];
		expect(args).toBeDefined();
		expect(flagValue(args, "--model")).toBe(`omlx/${SIDE}`);
		// The copy, not the conversation's file; one `--resume` and no other way to bind it to a session.
		expect(flagValue(args, "--resume")).toBe(join(run, "session.jsonl"));
		expect(args.filter((a) => a === "--resume")).toHaveLength(1);
		expect(args).not.toContain(chat.file);
		// The settings overlay is the copy beside it, last, and the gate is loaded as in the conversation.
		expect(flagValue(args, "--config")).toBe(join(run, "overlay.yml"));
		expect(args.indexOf("--extension")).toBeGreaterThanOrEqual(0);
		expect(args.indexOf("--config")).toBeLessThan(args.lastIndexOf("--config"));

		release();
		await chat.ended(record.id);
		await pollUntil(() => runs().length === 0, "the copy to be removed");
		// What omp left there when it ended (it writes a session file of its own then, and its side-question record) was
		// private too: the wrapper looked before the server removed the folder.
		const lines = scanned();
		const at = lines.lastIndexOf(`scan ${run}`);
		expect(at).toBeGreaterThanOrEqual(0);
		const found = lines.slice(at + 1).filter((l) => !l.startsWith("scan "));
		expect(found.length).toBeGreaterThan(5);
		for (const line of found) {
			const [mode, ...path] = line.split(" ");
			expect(Number.parseInt(mode as string, 8) & 0o077, path.join(" ")).toBe(0);
		}
	} finally {
		release();
		await setChoice(null);
		chat.close();
	}
}, 120_000);

test("a second question waits for the first: one process at a time for a conversation, answered in order", async () => {
	const chat = await conversation();
	const release = backend.hold();
	try {
		await setChoice(`omlx/${SIDE}`);
		const asked = requestsTo(SIDE).length;
		const first = await chat.ask("first question");
		await pollUntil(() => requestsTo(SIDE).length === asked + 1, "the first question to reach its model");
		const from = chat.frames.seen.length;
		const second = await chat.ask("second question");
		expect(second.status).toBe("running");
		// An absence (the second question does not start) has nothing to wait for but time.
		await Bun.sleep(500);
		expect(runs()).toHaveLength(1);
		expect(requestsTo(SIDE)).toHaveLength(asked + 1);

		release();
		await chat.ended(first.id);
		await chat.ended(second.id);
		expect(requestsTo(SIDE)).toHaveLength(asked + 2);
		// The second question began only after the first had ended.
		const frames = chat.frames.seen.slice(from);
		const firstEnd = frames.findIndex(
			(f) => f.type === "btw_record" && (f.record as Wire).id === first.id && (f.record as Wire).status === "complete",
		);
		const secondStart = frames.findIndex((f) => f.type === "btw_delta" && f.recordId === second.id);
		expect(firstEnd).toBeGreaterThanOrEqual(0);
		expect(secondStart).toBeGreaterThan(firstEnd);
		await pollUntil(() => runs().length === 0, "the copies to be removed");
	} finally {
		release();
		await setChoice(null);
		chat.close();
	}
}, 120_000);

test("a side question can be cancelled while it runs: the process ends, its folder goes, and the next question is answered", async () => {
	const chat = await conversation();
	const release = backend.hold();
	try {
		await setChoice(`omlx/${SIDE}`);
		const asked = requestsTo(SIDE).length;
		const record = await chat.ask("a question that is stopped");
		await pollUntil(() => requestsTo(SIDE).length === asked + 1, "the question to reach its model");
		const cancelled = await chat.rpc<{ cancelled: boolean }>({ type: "btw_cancel" });
		expect(cancelled.cancelled).toBe(true);
		expect(((await chat.ended(record.id)).record as Wire).status).toBe("cancelled");
		await pollUntil(() => runs().length === 0, "the copy to be removed");
		// Nothing left to cancel.
		expect((await chat.rpc<{ cancelled: boolean }>({ type: "btw_cancel" })).cancelled).toBe(false);

		release();
		const next = await chat.ask("a question after it");
		expect(((await chat.ended(next.id)).record as Wire).status).toBe("complete");
		await pollUntil(() => runs().length === 0, "the copy to be removed");
	} finally {
		release();
		await setChoice(null);
		chat.close();
	}
}, 120_000);

test("a follow-up goes on where its topic began, with the topic's earlier turns, on the topic's model", async () => {
	const chat = await conversation();
	try {
		await setChoice(`omlx/${SIDE}`);
		const topic = await chat.ask("what is the word?");
		await chat.ended(topic.id);
		// The choice changes: a topic goes on where it began.
		await setChoice(`omlx/${OTHER}`);
		const up = await chat.ask("and its length?", topic.id);
		expect(up.id).toBe(topic.id);
		const ended = (await chat.ended(topic.id)).record as Wire;
		expect(ended.followUps?.at(-1)).toMatchObject({ status: "complete", answer: `ANSWER-FROM-${SIDE}` });
		const sent = requestsTo(SIDE).at(-1);
		expect(sent && lastUser(sent)).toContain(`ANSWER-FROM-${SIDE}`);
		expect(sent && lastUser(sent)).toContain("what is the word?");
		expect(sent && lastUser(sent)).toContain("and its length?");
		expect(requestsTo(OTHER)).toHaveLength(0);

		// A new topic is on the model chosen now.
		const fresh = await chat.ask("a new topic");
		expect(fresh.model).toBe(`omlx/${OTHER}`);
		await chat.ended(fresh.id);
		expect(requestsTo(OTHER)).toHaveLength(1);
		// Both are in the panel's list, one record each.
		expect((await chat.history()).filter((r) => [topic.id, fresh.id].includes(r.id))).toHaveLength(2);
	} finally {
		await setChoice(null);
		chat.close();
	}
}, 120_000);

test("with nothing chosen, or the conversation's own model chosen, omp answers: no process, no copy, the model noted", async () => {
	const chat = await conversation();
	try {
		const seen = forks().length;
		for (const choice of [null, `omlx/${MAIN}`]) {
			await setChoice(choice);
			const asked = requestsTo(MAIN).length;
			const record = await chat.ask(`question for omp ${choice}`);
			expect(record.id).not.toStartWith("side-");
			expect(record.model).toBe(`omlx/${MAIN}`);
			await chat.ended(record.id);
			expect(requestsTo(MAIN).length).toBeGreaterThan(asked);
			const listed = (await chat.history()).find((r) => r.id === record.id);
			expect(listed).toMatchObject({ status: "complete", model: `omlx/${MAIN}` });
		}
		expect(forks()).toHaveLength(seen);
		expect(runs()).toEqual([]);
	} finally {
		await setChoice(null);
		chat.close();
	}
}, 120_000);

test("a conversation with nothing said yet has no file to copy: the question is asked on no session, and still answered by the chosen model", async () => {
	const chat = await conversation(false);
	try {
		await setChoice(`omlx/${SIDE}`);
		const seen = forks().length;
		const asked = requestsTo(SIDE).length;
		const record = await chat.ask("is anyone there?");
		const ended = (await chat.ended(record.id)).record as Wire;
		expect(ended).toMatchObject({ status: "complete", answer: `ANSWER-FROM-${SIDE}`, model: `omlx/${SIDE}` });
		expect(requestsTo(SIDE)).toHaveLength(asked + 1);
		const args = forks()[seen] as string[];
		expect(args).toContain("--no-session");
		expect(args).not.toContain("--resume");
		await pollUntil(() => runs().length === 0, "the copy to be removed");
	} finally {
		await setChoice(null);
		chat.close();
	}
}, 120_000);

test("a model omp does not have ends the question with omp's own words, and leaves nothing behind", async () => {
	const chat = await conversation();
	try {
		await setChoice("omlx/no-such-model");
		const record = await chat.ask("is anyone there?");
		const ended = (await chat.ended(record.id)).record as Wire;
		expect(ended.status).toBe("error");
		expect(ended.error).toMatch(/not found/i);
		await pollUntil(() => runs().length === 0, "the copy to be removed");
		// The conversation goes on.
		expect(await chat.model()).toBe(MAIN);
	} finally {
		await setChoice(null);
		chat.close();
	}
}, 120_000);

test("a follow-up of a topic omp answered stays with omp, whatever model is chosen", async () => {
	const chat = await conversation();
	try {
		await setChoice(null);
		const topic = await chat.ask("first, put to omp itself");
		await chat.ended(topic.id);
		await setChoice(`omlx/${SIDE}`);
		const seen = forks().length;
		const side = requestsTo(SIDE).length;
		const main = requestsTo(MAIN).length;

		const up = await chat.ask("and then, to omp as well", topic.id);
		expect(up.id).toBe(topic.id);
		const ended = (await chat.ended(topic.id)).record as Wire;
		expect(ended.followUps?.at(-1)).toMatchObject({ status: "complete" });
		// The conversation's model answered, with the topic's first turn in front of it (omp replays it); no process, no copy.
		const sent = requestsTo(MAIN).slice(main);
		expect(sent).toHaveLength(1);
		expect(JSON.stringify(sent[0]?.body.messages)).toContain("first, put to omp itself");
		expect(requestsTo(SIDE)).toHaveLength(side);
		expect(forks()).toHaveLength(seen);
		expect(runs()).toEqual([]);
		expect((await chat.history()).filter((r) => r.id === topic.id)).toHaveLength(1);
	} finally {
		await setChoice(null);
		chat.close();
	}
}, 120_000);

test("a question asked before the conversation has a file is still listed and can be followed up once it has one", async () => {
	const chat = await conversation(false);
	try {
		await setChoice(`omlx/${SIDE}`);
		const first = await chat.ask("before anything is said");
		await chat.ended(first.id);
		expect((await chat.history()).map((r) => r.id)).toContain(first.id);

		await chat.mainTurn("now something is said");
		expect((await chat.history()).map((r) => r.id)).toContain(first.id);
		const seen = forks().length;
		const up = await chat.ask("and now that there is a conversation", first.id);
		expect(up.id).toBe(first.id);
		const ended = (await chat.ended(first.id)).record as Wire;
		expect(ended.followUps?.at(-1)).toMatchObject({ status: "complete", answer: `ANSWER-FROM-${SIDE}` });
		// The follow-up has the conversation to look at now: its copy, not "no session".
		const args = forks()[seen] as string[];
		expect(args).toContain("--resume");
		expect(args).not.toContain("--no-session");
		await pollUntil(() => runs().length === 0, "the copy to be removed");
	} finally {
		await setChoice(null);
		chat.close();
	}
}, 120_000);

test("a conversation keeps two side questions waiting at most: the next is refused with a code the page words", async () => {
	const chat = await conversation();
	const release = backend.hold();
	try {
		await setChoice(`omlx/${SIDE}`);
		const asked = requestsTo(SIDE).length;
		await chat.ask("the one that runs");
		await pollUntil(() => requestsTo(SIDE).length === asked + 1, "the first question to reach its model");
		await chat.ask("waiting, first");
		await chat.ask("waiting, second");
		await expect(chat.ask("one too many")).rejects.toMatchObject({ code: "btwTooMany" });
		expect(runs()).toHaveLength(1);

		// Cancelled, they leave room again.
		expect((await chat.rpc<{ cancelled: boolean }>({ type: "btw_cancel" })).cancelled).toBe(true);
		release();
		await pollUntil(() => runs().length === 0, "the copy to be removed");
		const again = await chat.ask("after the line has cleared");
		expect(((await chat.ended(again.id)).record as Wire).status).toBe("complete");
		await pollUntil(() => runs().length === 0, "the copy to be removed");
	} finally {
		release();
		await setChoice(null);
		chat.close();
	}
}, 120_000);

test("at most three processes answer at once, for all conversations: the fourth waits for a place", async () => {
	const chats = [await conversation(), await conversation(), await conversation(), await conversation()];
	const release = backend.hold();
	try {
		await setChoice(`omlx/${SIDE}`);
		const asked = requestsTo(SIDE).length;
		const records = [];
		for (const [i, chat] of chats.entries()) records.push(await chat.ask(`question ${i}`));
		await pollUntil(() => requestsTo(SIDE).length === asked + 3, "three questions to reach their model");
		expect(runs()).toHaveLength(3);
		// An absence (the fourth does not start) has nothing to wait for but time.
		await Bun.sleep(500);
		expect(requestsTo(SIDE)).toHaveLength(asked + 3);
		expect(runs()).toHaveLength(3);

		release();
		for (const [i, chat] of chats.entries()) {
			expect(((await chat.ended((records[i] as Wire).id)).record as Wire).status).toBe("complete");
		}
		expect(requestsTo(SIDE)).toHaveLength(asked + 4);
		await pollUntil(() => runs().length === 0, "the copies to be removed");
	} finally {
		release();
		await setChoice(null);
		for (const chat of chats) chat.close();
	}
}, 180_000);

test("a conversation whose settings file has been taken away is not asked about without its guard: the question fails and says why", async () => {
	const chat = await conversation();
	try {
		await setChoice(`omlx/${SIDE}`);
		const overlay = readdirSync(server.tmpDir)
			.filter((name) => name.startsWith("ompw-live-"))
			.map((name) => join(server.tmpDir, name, `${chat.info.liveId}.yml`))
			.find((file) => existsSync(file));
		expect(overlay).toBeDefined();
		rmSync(overlay as string);
		const asked = requestsTo(SIDE).length;
		const record = await chat.ask("is the guard still there?");
		const ended = (await chat.ended(record.id)).record as Wire;
		expect(ended.status).toBe("error");
		expect(ended.error).toMatch(/settings file is gone/);
		expect(requestsTo(SIDE)).toHaveLength(asked);
		await pollUntil(() => runs().length === 0, "the copy to be removed");
	} finally {
		await setChoice(null);
		chat.close();
	}
}, 120_000);

test("the choice is one preference of the app: only a single provider/id is kept, and it is in the snapshot every page gets", async () => {
	const post = (value: unknown) =>
		fetch(`${server.url}/api/prefs`, {
			method: "POST",
			headers: { "x-omp-webui-token": server.accessToken, "x-omp-webui": "1", "content-type": "application/json" },
			body: JSON.stringify({ changes: { [PREF.btwModel]: value } }),
		});
	for (const bad of ["opus", "pi/slow", "a/b,c/d", "omlx/*", "omlx/ x", 7]) {
		expect((await post(bad)).status, String(bad)).toBe(400);
	}
	expect((await post("omlx/m-side")).status).toBe(200);
	const read = await fetch(`${server.url}/api/prefs`, { headers: { "x-omp-webui-token": server.accessToken } });
	const snapshot: PrefsSnapshot = await read.json();
	expect(snapshot.values[PREF.btwModel]).toBe("omlx/m-side");
	await setChoice(null);
});
