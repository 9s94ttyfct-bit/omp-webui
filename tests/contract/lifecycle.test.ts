import { afterAll, beforeAll, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { LiveInfo, LiveListing } from "../../shared/protocol.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { connect, request } from "../support/ws.ts";

/** omp process lifecycle through the server's WebSocket API. */

let s: TestServer;
beforeAll(async () => {
	s = await startTestServer();
}, 60_000);
afterAll(async () => {
	await s?.stop();
});

test("closing the socket during `open` leaves the new omp process without subscribers", async () => {
	const observer = await connect(s);
	// The pool announces a live to every socket once omp is ready; the `open` handler's
	// attach runs right after, before the server handles the observer's next message.
	const ready = new Promise<void>((resolve) =>
		observer.addEventListener("message", (ev) => {
			const m = JSON.parse(String(ev.data));
			if (m.t === "live" && m.info.sessionId) resolve();
		}),
	);
	const tab = await connect(s);
	tab.send(JSON.stringify({ t: "open", target: { kind: "new", cwd: s.work }, req: "r1" }));
	tab.close();
	await ready;

	const lives = await request<LiveInfo[]>(observer, { t: "list_lives" });
	expect(lives.length).toBe(1);
	expect(lives[0].subscribers).toBe(0);
	for (const l of lives) await request(observer, { t: "close", liveId: l.liveId });
	observer.close();
}, 60_000);

test("resuming a session file omp never wrote starts a fresh session in the given cwd", async () => {
	const ws = await connect(s);
	// omp reports a session path before the first assistant message writes it.
	const fresh = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: s.work } });
	const unwritten = fresh.sessionFile as string;
	const exited = new Promise<void>((resolve) =>
		ws.addEventListener("message", (ev) => {
			const m = JSON.parse(String(ev.data));
			if (m.t === "live_exit" && m.liveId === fresh.liveId) resolve();
		}),
	);
	await request(ws, { t: "close", liveId: fresh.liveId });
	await exited;
	const resumed = await request<LiveInfo>(ws, {
		t: "open",
		target: { kind: "resume", sessionFile: unwritten, cwd: s.work },
	});
	expect(resumed.exited).toBe(false);
	expect(resumed.cwd).toBe(s.work);
	expect(resumed.sessionFile).not.toBe(unwritten);

	await expect(
		request(ws, { t: "open", target: { kind: "resume", sessionFile: join(s.work, "missing.jsonl") } }),
	).rejects.toThrow(/not found/);
	await request(ws, { t: "close", liveId: resumed.liveId });
	ws.close();
}, 60_000);

test("concurrent resumes of one session file (a double click, two tabs) share one omp process", async () => {
	const [a, b] = await Promise.all([connect(s), connect(s)]);
	const target = { kind: "resume", sessionFile: s.fixtures.alpha, model: "anthropic/claude-haiku-5-5" };
	const [first, second] = await Promise.all([
		request<LiveInfo>(a, { t: "open", target }),
		request<LiveInfo>(b, { t: "open", target }),
	]);
	expect(second.liveId).toBe(first.liveId);
	expect(first.sessionFile).toBe(realpathSync(s.fixtures.alpha));

	const lives = await request<LiveInfo[]>(a, { t: "list_lives" });
	expect(lives.filter((l) => l.sessionFile === first.sessionFile).map((l) => l.liveId)).toEqual([first.liveId]);
	await request(a, { t: "close", liveId: first.liveId });
	a.close();
	b.close();
}, 60_000);

/** What `/api/lives` reports (the macOS app asks it before quitting). */
const listing = async (): Promise<LiveListing[]> =>
	(await fetch(`${s.url}/api/lives`, { headers: { "x-omp-webui-token": s.accessToken } })).json();

test("a page reloaded five times in a row finds the same new-chat process each time", async () => {
	await pollUntil(async () => (await listing()).length === 0, "earlier processes to finish closing");
	const opened: LiveInfo[] = [];
	for (let load = 0; load < 5; load++) {
		const page = await connect(s);
		opened.push(await request<LiveInfo>(page, { t: "open", target: { kind: "new", cwd: s.work } }));
		// The reload: the socket goes, the process is not closed.
		page.close();
		await pollUntil(
			async () => (await listing()).every((l) => l.subscribers === 0),
			"the server to see the socket close",
		);
	}
	expect(new Set(opened.map((o) => o.liveId)).size).toBe(1);
	const running = (await listing()).filter((l) => !l.exited);
	expect(running.map((l) => l.liveId)).toEqual([opened[0].liveId]);

	const ws = await connect(s);
	await request(ws, { t: "close", liveId: opened[0].liveId });
	ws.close();
	await pollUntil(async () => (await listing()).length === 0, "the process to close");
}, 120_000);

test("a page that is already using a new-chat process does not share it with another page", async () => {
	const [one, other] = await Promise.all([connect(s), connect(s)]);
	const first = await request<LiveInfo>(one, { t: "open", target: { kind: "new", cwd: s.work } });
	const second = await request<LiveInfo>(other, { t: "open", target: { kind: "new", cwd: s.work } });
	expect(second.liveId).not.toBe(first.liveId);
	for (const [ws, live] of [
		[one, first],
		[other, second],
	] as const)
		await request(ws, { t: "close", liveId: live.liveId });
	one.close();
	other.close();
}, 60_000);

test("/api/lives says a process is busy while it runs a command, and idle again afterwards", async () => {
	const ws = await connect(s);
	const live = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: s.work } });
	const busy = async () => (await listing()).find((l) => l.liveId === live.liveId)?.busy;
	expect(await busy()).toBe(false);

	// omp answers `!command` only when it ends: busy for as long as the command runs.
	const finished = request(ws, { t: "rpc", liveId: live.liveId, command: { type: "bash", command: "sleep 2" } });
	await pollUntil(async () => (await busy()) === true, "the process to be busy");
	await finished;
	expect(await busy()).toBe(false);

	await request(ws, { t: "close", liveId: live.liveId });
	ws.close();
}, 60_000);
