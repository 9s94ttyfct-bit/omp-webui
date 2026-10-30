import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	closeSync,
	existsSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type GuardConfig, type GuardWord, type LiveGuard, parseGuardWord } from "../../shared/guard.ts";
import { type ImportStatus, MIGRATE_API, type MigrateState } from "../../shared/migrate.ts";
import type { LiveInfo, LiveListing } from "../../shared/protocol.ts";
import { messageWhere } from "../support/frames.ts";
import { lanAddress, type NetSocket, rawRequest, rawSocket } from "../support/lan-peer.ts";
import { call, exportTo, state, uploadAndVerify } from "../support/migrate-http.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { connect, request } from "../support/ws.ts";

/**
 * "Guard dangerous commands" for one conversation (#626), against the real omp and the real server (no model call): the
 * conversation's own choices reach its process's gate (`<overlay>.risk`, which the main agent and each subagent of that
 * process read: that a subagent's call follows it is `guard.test.ts`), the conversations that chose nothing follow the
 * global settings as they change, a choice outlives the server (a paused conversation adopted again, a file opened
 * again), a page that is not this computer's can neither make nor see it changed, and a record that is damaged is the
 * global setting, never Off.
 */

const LAN = lanAddress();
if (LAN === undefined) {
	console.warn(
		"guard-conversation: this computer has no IPv4 address on a network, so a connection from a network peer cannot be made: the cases that need one are skipped",
	);
}
const networkOnly = LAN === undefined ? describe.skip : describe;

let s: TestServer;
const root = mkdtempSync(join(tmpdir(), "ompw-guard-conversation-"));
const GLOBAL: GuardConfig = { mode: "reviewer", reviewer: "g/one", askWhenUnavailable: true, askWhenDenied: true };

beforeAll(async () => {
	s = await startTestServer(0, {}, { login: false });
}, 120_000);

afterAll(async () => {
	await s?.stop();
	rmSync(root, { recursive: true, force: true });
});

const authed = (extra: Record<string, string> = {}) => ({
	"x-omp-webui-token": s.accessToken,
	"x-omp-webui": "1",
	...extra,
});

async function setGlobal(patch: Partial<GuardConfig>): Promise<void> {
	const res = await fetch(`${s.url}/api/guard`, {
		method: "POST",
		headers: authed({ "content-type": "application/json" }),
		body: JSON.stringify(patch),
	});
	expect(res.status).toBe(200);
}

/** Change one conversation's own guard as the page of this computer does. */
const choose = (liveId: string, guard: unknown, method = "POST") =>
	fetch(`${s.url}/api/guard/live`, {
		method,
		headers: authed({ "content-type": "application/json" }),
		body: method === "POST" ? JSON.stringify({ liveId, guard }) : undefined,
	});

const lives = async (): Promise<LiveListing[]> =>
	(await (await fetch(`${s.url}/api/lives`, { headers: authed() })).json()) as LiveListing[];
const listed = async (liveId: string): Promise<LiveListing | undefined> =>
	(await lives()).find((l) => l.liveId === liveId);
/** What the page is told a conversation's guard is. */
const guardOf = async (liveId: string): Promise<LiveGuard | undefined> => (await listed(liveId))?.guard;

/** Where the gate of a process reads its word: beside the process's own settings overlay, in the temp dir of the server. */
function riskFile(liveId: string): string {
	for (const dir of readdirSync(s.tmpDir)) {
		if (!dir.startsWith("ompw-live-")) continue;
		const file = join(s.tmpDir, dir, `${liveId}.yml.risk`);
		if (existsSync(file)) return file;
	}
	throw new Error(`no word to the gate of ${liveId}`);
}
const wordOf = (liveId: string): GuardWord | null => {
	const state: { guard?: unknown } = JSON.parse(readFileSync(riskFile(liveId), "utf8"));
	return parseGuardWord(state.guard);
};

/** The info of the process a `live` frame is about; the frames of the test's message type do not say what they carry. */
const liveInfo = (m: { t: string; info?: unknown }): Partial<LiveInfo> => (m.t === "live" ? (m.info as LiveInfo) : {});

async function openNew(): Promise<{ ws: WebSocket; live: LiveInfo }> {
	const ws = await connect(s);
	const live = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: s.work, approvalMode: "yolo" } });
	return { ws, live };
}

async function openFile(file: string): Promise<{ ws: WebSocket; live: LiveInfo }> {
	const ws = await connect(s);
	const live = await request<LiveInfo>(ws, { t: "open", target: { kind: "resume", sessionFile: file } });
	return { ws, live };
}

async function closeAndWait(ws: WebSocket, liveId: string): Promise<void> {
	const exited = messageWhere(ws, (m) => m.t === "live_exit" && m.liveId === liveId);
	await request(ws, { t: "close", liveId });
	await exited;
	ws.close();
}

/** The keys of the conversations the store keeps choices for: the real path of a session file. */
const approvalFile = () => join(s.root, "data", "approval.json");

// ------------------------------------------------------------------ the gate

describe("a conversation's own guard", () => {
	test("reaches its process's gate over the global settings, the others follow the settings as they move, and the pages are told", async () => {
		await setGlobal(GLOBAL);
		const a = await openNew();
		const b = await openNew();
		const idA = a.live.liveId;
		const idB = b.live.liveId;
		expect(idA).not.toBe(idB);
		// A conversation that chose nothing is under the global settings, and says it has nothing of its own.
		expect(a.live.guard).toEqual({ config: GLOBAL });
		expect(wordOf(idA)).toMatchObject({ mode: "reviewer", reviewers: ["g/one"], askWhenUnavailable: true });

		const res = await choose(idA, { mode: "off" });
		expect(res.status).toBe(200);
		const now: LiveGuard = { config: { ...GLOBAL, mode: "off" }, own: { mode: "off" } };
		const answer: { guard: LiveGuard } = await res.json();
		expect(answer.guard).toEqual(now);
		// The word the process's gate reads, which its subagents read too (they are the same process).
		expect(wordOf(idA)).toMatchObject({ mode: "off", reviewers: ["g/one"], askWhenUnavailable: true });
		expect(wordOf(idB)).toMatchObject({ mode: "reviewer", reviewers: ["g/one"] });
		expect(await guardOf(idA)).toEqual(now);
		expect(await guardOf(idB)).toEqual({ config: GLOBAL });

		// The settings move: the conversation that follows them follows, at once; the one that chose Off stays off and takes the rest.
		const told = messageWhere(b.ws, (m) => {
			const info = liveInfo(m);
			return info.liveId === idB && info.guard?.config.mode === "ask";
		});
		await setGlobal({ mode: "ask", reviewer: "g/two", askWhenUnavailable: false });
		await told;
		await pollUntil(() => wordOf(idB)?.mode === "ask", "the follower's gate to be told the settings' mode");
		expect(wordOf(idB)).toMatchObject({ mode: "ask", reviewers: ["g/two"], askWhenUnavailable: false });
		expect(wordOf(idA)).toMatchObject({ mode: "off", reviewers: ["g/two"], askWhenUnavailable: false });
		expect(await guardOf(idA)).toEqual({
			config: { mode: "off", reviewer: "g/two", askWhenUnavailable: false, askWhenDenied: true },
			own: { mode: "off" },
		});

		// One field at a time: the reviewer is the conversation's own, the mode is the settings' again.
		await choose(idA, { reviewer: "x/y", mode: null });
		expect(wordOf(idA)).toMatchObject({ mode: "ask", reviewers: ["x/y"], askWhenUnavailable: false });
		expect((await guardOf(idA))?.own).toEqual({ reviewer: "x/y" });
		// Nothing of its own left: it follows the settings, and says so.
		const cleared = await choose(idA, null);
		expect(cleared.status).toBe(200);
		expect(await guardOf(idA)).toEqual({
			config: { mode: "ask", reviewer: "g/two", askWhenUnavailable: false, askWhenDenied: true },
		});
		expect(wordOf(idA)).toMatchObject({ mode: "ask", reviewers: ["g/two"] });

		await closeAndWait(a.ws, idA);
		await closeAndWait(b.ws, idB);
	}, 120_000);

	test("is checked: a change that is not acceptable, a conversation that is not there, and a method that is not POST change nothing", async () => {
		await setGlobal(GLOBAL);
		const a = await openNew();
		const id = a.live.liveId;
		for (const bad of [{ mode: "disabled" }, { mode: "OFF" }, { reviewer: 3 }, { nope: true }, "off", [], undefined]) {
			const res = await choose(id, bad);
			expect(res.status, JSON.stringify(bad)).toBe(400);
		}
		expect((await choose("L0-nope", { mode: "off" })).status).toBe(404);
		expect((await choose(id, undefined, "GET")).status).toBe(405);
		expect(await guardOf(id)).toEqual({ config: GLOBAL });
		expect(wordOf(id)?.mode).toBe("reviewer");
		await closeAndWait(a.ws, id);
	}, 60_000);
});

// ------------------------------------------------------------------ kept with the conversation

describe("what a conversation chose", () => {
	test("outlives the server while it is paused: the next server adopts it with its own choices, and the settings do not move them", async () => {
		await setGlobal(GLOBAL);
		const a = await openNew();
		const id = a.live.liveId;
		await choose(id, { mode: "ask", reviewer: "x/y" });
		await request(a.ws, { t: "pause", liveId: id });
		await pollUntil(
			() => existsSync(join(s.root, "data", "parked", `${id}.json`)),
			"the record of the paused conversation",
		);
		const record: { guard?: unknown } = JSON.parse(readFileSync(join(s.root, "data", "parked", `${id}.json`), "utf8"));
		expect(record.guard).toEqual({ mode: "ask", reviewer: "x/y" });
		a.ws.close();

		await s.restart();
		const adopted = await listed(id);
		expect(adopted).toMatchObject({ liveId: id, exited: false });
		expect(adopted?.guard).toEqual({
			config: { ...GLOBAL, mode: "ask", reviewer: "x/y" },
			own: { mode: "ask", reviewer: "x/y" },
		});
		// The word is the new server's: its gate reads the conversation's own choices over the settings.
		await pollUntil(() => wordOf(id)?.mode === "ask", "the new server's word to the adopted gate");
		expect(wordOf(id)).toMatchObject({ mode: "ask", reviewers: ["x/y"], askWhenUnavailable: true });
		// The settings move; what it chose stays, and it takes the rest from them.
		await setGlobal({ mode: "off", askWhenUnavailable: false });
		await pollUntil(() => wordOf(id)?.askWhenUnavailable === false, "the adopted gate to follow the settings");
		expect(wordOf(id)).toMatchObject({ mode: "ask", reviewers: ["x/y"] });

		// Resumed, it is the same: the choice is the conversation's, not the pause's.
		const ws = await connect(s);
		await request(ws, { t: "attach", liveId: id });
		await request(ws, { t: "resume", liveId: id });
		expect((await guardOf(id))?.own).toEqual({ mode: "ask", reviewer: "x/y" });
		await closeAndWait(ws, id);
	}, 180_000);

	test("goes with the file: the conversation opened again, by this server or by the next, is under it, until it follows the settings again", async () => {
		await setGlobal(GLOBAL);
		const file = s.fixtures.beta;
		const first = await openFile(file);
		expect(first.live.guard).toEqual({ config: GLOBAL });
		await choose(first.live.liveId, { mode: "off", askWhenUnavailable: false });
		await closeAndWait(first.ws, first.live.liveId);

		const second = await openFile(file);
		expect(second.live.liveId).not.toBe(first.live.liveId);
		expect(second.live.guard).toEqual({
			config: { ...GLOBAL, mode: "off", askWhenUnavailable: false },
			own: { mode: "off", askWhenUnavailable: false },
		});
		expect(wordOf(second.live.liveId)).toMatchObject({ mode: "off", askWhenUnavailable: false, reviewers: ["g/one"] });
		second.ws.close();

		// The server stops (an idle conversation's process ends with it) and starts again over the same data folder.
		await s.restart();
		const third = await openFile(file);
		expect(third.live.guard?.own).toEqual({ mode: "off", askWhenUnavailable: false });
		expect(wordOf(third.live.liveId)?.mode).toBe("off");
		await choose(third.live.liveId, null);
		await closeAndWait(third.ws, third.live.liveId);

		const fourth = await openFile(file);
		expect(fourth.live.guard).toEqual({ config: GLOBAL });
		expect(wordOf(fourth.live.liveId)?.mode).toBe("reviewer");
		await closeAndWait(fourth.ws, fourth.live.liveId);
	}, 180_000);
});

// ------------------------------------------------------------------ damaged

describe("what an agent plants in the files that keep a conversation's choices", () => {
	/** The guard map `approval.json` holds now. */
	const keptInFile = (): Record<string, unknown> => {
		const stored: { guard?: Record<string, unknown> } = JSON.parse(readFileSync(approvalFile(), "utf8"));
		return stored.guard ?? {};
	};

	test.each<[string, unknown]>([
		["an Off", { mode: "off" }],
		["text", "off"],
		["a mode spelled another way", { mode: "OFF" }],
		["a mode beside a field that is none", { mode: "off", nope: 1 }],
		["a list", [{ mode: "off" }]],
		["a number", 0],
	])(
		"is not read once the server has the file, and is written over: %s planted for a conversation",
		async (_name, planted) => {
			await setGlobal(GLOBAL);
			const file = s.fixtures.gamma;
			const key = realpathSync(file);
			writeFileSync(
				approvalFile(),
				JSON.stringify({ default: null, sessions: {}, usageWait: {}, models: {}, guard: { [key]: planted } }),
			);
			// Opened before the server looks again, and after: the conversation follows the settings either way.
			const opened = await openFile(file);
			expect(opened.live.guard).toEqual({ config: GLOBAL });
			expect(wordOf(opened.live.liveId)).toMatchObject({ mode: "reviewer", reviewers: ["g/one"] });
			await pollUntil(() => !(key in keptInFile()), "the server to write the planted choice over");
			await closeAndWait(opened.ws, opened.live.liveId);
			const again = await openFile(file);
			expect(again.live.guard).toEqual({ config: GLOBAL });
			await closeAndWait(again.ws, again.live.liveId);
		},
		90_000,
	);

	test("an Off planted in the record of a paused conversation and in the file is written over, and the next server adopts the conversation under what it chose", async () => {
		await setGlobal(GLOBAL);
		const a = await openNew();
		const id = a.live.liveId;
		await choose(id, { mode: "ask" });
		const key = (await listed(id))?.sessionFile ?? "";
		expect(key).not.toBe("");
		await request(a.ws, { t: "pause", liveId: id });
		const recordFile = join(s.root, "data", "parked", `${id}.json`);
		await pollUntil(() => existsSync(recordFile), "the record of the paused conversation");
		const recordedGuard = (): unknown => (JSON.parse(readFileSync(recordFile, "utf8")) as { guard?: unknown }).guard;
		expect(recordedGuard()).toEqual({ mode: "ask" });

		// An Off in both places the conversation's choice is kept in.
		const record: Record<string, unknown> = JSON.parse(readFileSync(recordFile, "utf8"));
		writeFileSync(recordFile, JSON.stringify({ ...record, guard: { mode: "off" } }));
		writeFileSync(
			approvalFile(),
			JSON.stringify({
				default: null,
				sessions: {},
				usageWait: {},
				models: {},
				guard: { ...keptInFile(), [key]: { mode: "off" } },
			}),
		);
		await pollUntil(
			() => JSON.stringify(recordedGuard()) === JSON.stringify({ mode: "ask" }),
			"the record to be written again",
		);
		await pollUntil(
			() => JSON.stringify(keptInFile()[key]) === JSON.stringify({ mode: "ask" }),
			"the file to be written again",
		);
		a.ws.close();

		// A crash: the server does not get to write its conversations down as it leaves.
		await s.restart(undefined, { signal: "SIGKILL" });
		expect(await listed(id)).toMatchObject({ liveId: id, exited: false });
		expect((await guardOf(id))?.own).toEqual({ mode: "ask" });
		await pollUntil(() => wordOf(id)?.mode === "ask", "the adopted gate to be told what the conversation chose");
		const ws = await connect(s);
		await request(ws, { t: "attach", liveId: id });
		await request(ws, { t: "resume", liveId: id });
		await closeAndWait(ws, id);
	}, 180_000);
});

// ------------------------------------------------------------------ a page that is not this computer's

networkOnly("a page on the network that holds the token", () => {
	const port = () => Number(new URL(s.url).port);
	const peer = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) =>
		rawRequest({
			host: "127.0.0.1",
			port: port(),
			from: LAN,
			method,
			path,
			headers: {
				"x-omp-webui-token": s.accessToken,
				...(method === "GET" ? {} : { "x-omp-webui": "1" }),
				...(body === undefined ? {} : { "content-type": "application/json" }),
				...headers,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	const socketOfPeer = async (): Promise<NetSocket> => {
		const socket = await rawSocket({
			host: "127.0.0.1",
			port: port(),
			from: LAN,
			headers: { origin: s.url, cookie: `ompw_token=${s.accessToken}` },
		});
		if (!socket) throw new Error("the server refused the socket of a page on the network");
		return socket;
	};

	test("sees a conversation's guard and cannot change it: not by the route, whatever it says it is, and not when it opens a chat", async () => {
		await setGlobal(GLOBAL);
		const a = await openNew();
		const id = a.live.liveId;
		await choose(id, { mode: "ask" });
		const before = await guardOf(id);
		expect(before?.own).toEqual({ mode: "ask" });

		const spoofs: Record<string, string>[] = [
			{},
			{ host: `127.0.0.1:${port()}` },
			{ host: `localhost:${port()}` },
			{ origin: s.url },
			{ "sec-fetch-site": "same-origin" },
			{ "x-forwarded-for": "127.0.0.1" },
			{ forwarded: "for=127.0.0.1" },
		];
		for (const headers of spoofs) {
			const res = await peer("/api/guard/live", "POST", { liveId: id, guard: { mode: "off" } }, headers);
			expect(res.status, JSON.stringify(headers)).toBe(403);
			const clear = await peer("/api/guard/live", "POST", { liveId: id, guard: null }, headers);
			expect(clear.status, JSON.stringify(headers)).toBe(403);
		}
		// Nothing changed, in the page's view or in the word the gate reads.
		expect(await guardOf(id)).toEqual(before);
		expect(wordOf(id)?.mode).toBe("ask");

		// What the page of the network is shown: it is told what the conversation is under, and that it is its own.
		const listing = (await (await peer("/api/lives")).json()) as LiveListing[];
		expect(listing.find((l) => l.liveId === id)?.guard).toEqual(before);

		// It may open a chat, as before, but not one with a guard of its own: it starts under the settings.
		const socket = await socketOfPeer();
		try {
			const count = (await lives()).length;
			const target = { kind: "new", cwd: s.work, guard: { mode: "off" } };
			await expect(request(socket as unknown as WebSocket, { t: "open", target })).rejects.toThrow(
				/computer omp-webui runs on/,
			);
			expect((await lives()).length).toBe(count);
			const plain = await request<LiveInfo>(socket as unknown as WebSocket, {
				t: "open",
				target: { kind: "new", cwd: s.work, approvalMode: "yolo" },
			});
			expect(plain.guard).toEqual({ config: GLOBAL });
			await request(socket as unknown as WebSocket, { t: "close", liveId: plain.liveId }).catch(() => {});
		} finally {
			socket.close();
		}
		await closeAndWait(a.ws, id);
	}, 120_000);
});

describe("a page on this computer", () => {
	test("opens a new chat under a guard of its own, and a spare process a reloaded page left is put under what this page asks", async () => {
		await setGlobal(GLOBAL);
		const first = await connect(s);
		const own = await request<LiveInfo>(first, {
			t: "open",
			target: { kind: "new", cwd: s.work, approvalMode: "yolo", guard: { mode: "ask", reviewer: "n/m" } },
		});
		expect(own.guard).toEqual({
			config: { ...GLOBAL, mode: "ask", reviewer: "n/m" },
			own: { mode: "ask", reviewer: "n/m" },
		});
		expect(wordOf(own.liveId)).toMatchObject({ mode: "ask", reviewers: ["n/m"] });
		// The page is reloaded: nobody watches the process, and the next new chat takes it over.
		first.send(JSON.stringify({ t: "detach", liveId: own.liveId }));
		await pollUntil(
			async () => (await listed(own.liveId))?.subscribers === 0,
			"the page to have let go of the process",
		);
		const second = await connect(s);
		const plain = await request<LiveInfo>(second, {
			t: "open",
			target: { kind: "new", cwd: s.work, approvalMode: "yolo" },
		});
		// The spare was taken over: it is under the settings again, not under what the page that left it picked.
		expect(plain.liveId).toBe(own.liveId);
		expect(plain.guard).toEqual({ config: GLOBAL });
		await pollUntil(() => wordOf(plain.liveId)?.mode === "reviewer", "the spare's gate to be told the settings");
		for (const bad of [{ mode: "disabled" }, { reviewer: 1 }, "off"]) {
			await expect(request(second, { t: "open", target: { kind: "new", cwd: s.work, guard: bad } })).rejects.toThrow();
		}
		await request(second, { t: "close", liveId: plain.liveId }).catch(() => {});
		first.close();
		second.close();
	}, 120_000);
});

// ------------------------------------------------------------------ moved to another computer

describe("a conversation's guard moved to another computer", () => {
	test("survives an import that takes longer than the server's look at the file: it is the person's act, and the conversation opens under it there", async () => {
		await setGlobal(GLOBAL);
		const file = s.fixtures.beta;
		const first = await openFile(file);
		await choose(first.live.liveId, { mode: "ask", reviewer: "moved/one" });
		await closeAndWait(first.ws, first.live.liveId);
		// A file that sorts after `approval.json` in the archive, for the import to stand still at once approval.json is written.
		writeFileSync(join(s.root, "data", "favorite-models.json"), JSON.stringify(["moved/model"]));

		const archive = join(root, "moved.ompw");
		await exportTo(s, archive, { credentials: false });
		const b = await startTestServer(0, {}, { login: false });
		const pipe = join(b.root, "data", "favorite-models.json");
		try {
			expect((await uploadAndVerify(b, archive)).state).toBe("ready");
			// What the import reads on this Mac before it decides what to do with it: a pipe, which does not answer until somebody
			// writes to it. Nothing reads this file but the import.
			expect(spawnSync("mkfifo", [pipe]).status).toBe(0);
			const started = await call<ImportStatus>(b, MIGRATE_API.importApply, {
				method: "POST",
				body: JSON.stringify({ mode: "merge", credentials: false }),
			});
			expect(started.status).toBe(200);

			const approvalFile = join(b.root, "data", "approval.json");
			const kept = (): Record<string, unknown> => {
				const stored: { guard?: Record<string, unknown> } = JSON.parse(readFileSync(approvalFile, "utf8"));
				return stored.guard ?? {};
			};
			const brought = () => Object.entries(kept()).find(([key]) => key.endsWith(basename(file)));
			await pollUntil(
				() => existsSync(approvalFile) && brought() !== undefined,
				"the import to have written approval.json",
			);
			expect(((await state(b)).body as MigrateState).import?.state).toBe("applying");
			// A real wait, for a real timer: the server looks at the file once a second and writes over what it did not write
			// itself. The import is still writing, and must be left alone for three looks.
			await Bun.sleep(3_500);
			expect(((await state(b)).body as MigrateState).import?.state).toBe("applying");
			expect(brought()?.[1]).toEqual({ mode: "ask", reviewer: "moved/one" });

			// The pipe answers, and the import goes on to its end.
			const fd = openSync(pipe, "w");
			writeSync(fd, "[]");
			closeSync(fd);
			await pollUntil(
				async () => ((await state(b)).body as MigrateState).import?.state === "done",
				"the import to end",
			);
			expect(brought()?.[1]).toEqual({ mode: "ask", reviewer: "moved/one" });

			// What the server took from the file is its own now: the next looks leave it, and the conversation opens under it.
			await Bun.sleep(2_500);
			expect(brought()?.[1]).toEqual({ mode: "ask", reviewer: "moved/one" });
			const ws = await connect(b);
			const there = await request<LiveInfo>(ws, {
				t: "open",
				target: { kind: "resume", sessionFile: brought()?.[0] ?? "" },
			});
			expect(there.guard?.own).toEqual({ mode: "ask", reviewer: "moved/one" });
			await closeAndWait(ws, there.liveId);
		} finally {
			await b.stop();
		}
	}, 240_000);
});

// ------------------------------------------------------------------ the guard's own settings

describe("the guard's settings moved to another computer", () => {
	test("an import that takes longer than the server's look keeps the file it wrote: the look leaves it alone while the import writes, and takes it when it ends", async () => {
		// The other Mac's settings, in its data dir (its own guard file is elsewhere: this is the file an archive carries).
		const imported: GuardConfig = {
			mode: "ask",
			reviewer: "moved/one",
			askWhenUnavailable: false,
			askWhenDenied: false,
		};
		const a = await startTestServer(0, {}, { login: false });
		const archive = join(root, "guard-settings.ompw");
		// The server here is told to keep its guard settings where this version does (`<data dir>/guard.json`), as the app does.
		const b = await startTestServer(0, { OMP_WEBUI_GUARD_CONFIG: "" }, { login: false });
		// A file of the archive that sorts after `guard.json`, for the import to stand still at once guard.json is written, and
		// that nothing else here reads while it stands still.
		const pipe = join(b.root, "data", "interviews.json");
		try {
			writeFileSync(join(a.root, "data", "guard.json"), `${JSON.stringify(imported, null, 2)}\n`);
			// The file the import stands still at is in the archive too (an archive carries only what is there).
			writeFileSync(join(a.root, "data", "interviews.json"), "[]");
			await exportTo(a, archive, { credentials: false });
			expect((await uploadAndVerify(b, archive)).state).toBe("ready");
			// What the import reads on this Mac before it decides what to do with it: a pipe, which does not answer until
			// somebody writes to it.
			expect(spawnSync("mkfifo", [pipe]).status).toBe(0);
			const started = await call<ImportStatus>(b, MIGRATE_API.importApply, {
				method: "POST",
				body: JSON.stringify({ mode: "merge", credentials: false }),
			});
			expect(started.status).toBe(200);

			const file = join(b.root, "data", "guard.json");
			const kept = (): GuardConfig => JSON.parse(readFileSync(file, "utf8")) as GuardConfig;
			await pollUntil(() => existsSync(file) && kept().mode === "ask", "the import to have written guard.json");
			expect(((await state(b)).body as MigrateState).import?.state).toBe("applying");
			// A real wait, for a real timer: the server looks at the file once a second and writes its own settings over one it
			// did not write itself. The import is still writing, and must be left alone for three looks.
			await Bun.sleep(3_500);
			expect(((await state(b)).body as MigrateState).import?.state).toBe("applying");
			expect(kept()).toEqual(imported);

			// The pipe answers, and the import goes on to its end.
			const fd = openSync(pipe, "w");
			writeSync(fd, "[]");
			closeSync(fd);
			await pollUntil(
				async () => ((await state(b)).body as MigrateState).import?.state === "done",
				"the import to end",
			);
			// What the import brought is the server's own now: every gate and page is told, and the looks leave the file.
			const answered = await fetch(`${b.url}/api/guard`, {
				headers: { "x-omp-webui-token": b.accessToken, "x-omp-webui": "1" },
			});
			const body: unknown = await answered.json();
			expect(typeof body === "object" && body !== null && "config" in body ? body.config : null).toEqual(imported);
			await Bun.sleep(2_500);
			expect(kept()).toEqual(imported);
		} finally {
			await Promise.all([a.stop(), b.stop()]);
		}
	}, 240_000);
});

// ------------------------------------------------------------------ the once-a-second look goes on

describe("the server's once-a-second look", () => {
	test("goes on when the guard choices cannot be written over: what else it does is not lost", async () => {
		await setGlobal(GLOBAL);
		const a = await openNew();
		const id = a.live.liveId;
		await choose(id, { mode: "ask" });
		const key = (await listed(id))?.sessionFile ?? "";
		const data = join(s.root, "data");
		const word = riskFile(id);
		try {
			// An Off planted in the file, and the data folder takes no new file: the server cannot write its own copy back.
			chmodSync(data, 0o500);
			writeFileSync(
				approvalFile(),
				JSON.stringify({ default: null, sessions: {}, usageWait: {}, models: {}, guard: { [key]: { mode: "off" } } }),
			);
			// What only the look does: a gate's word that was taken away is written again. It must still run, every second.
			for (const round of [1, 2, 3]) {
				rmSync(word, { force: true });
				await pollUntil(() => existsSync(word), `the gate's word to be written again by look ${round}`);
			}
			// The server's copy was not changed by the plant, and it is still its own.
			expect((await guardOf(id))?.own).toEqual({ mode: "ask" });
			expect(wordOf(id)?.mode).toBe("ask");
		} finally {
			chmodSync(data, 0o700);
		}
		// The folder can be written again: the plant is written over at the next look, with the server's own map (the choices of
		// every conversation it holds, not only this one's).
		await pollUntil(() => {
			const written: { guard?: Record<string, unknown> } = JSON.parse(readFileSync(approvalFile(), "utf8"));
			return JSON.stringify(written.guard?.[key]) === JSON.stringify({ mode: "ask" });
		}, "the plant to be written over");
		await closeAndWait(a.ws, id);
	}, 120_000);
});
