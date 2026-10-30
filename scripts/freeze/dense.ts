#!/usr/bin/env bun
/**
 * What a person who presses Send or Stop meanwhile would wait for, measured densely, in a process of its own: a request every 10 ms
 * for the whole run, in two kinds. `meta` is a trivial HTTP request (the server's event-loop lag, as a page sees it), `abort` is the
 * `abort` command over the socket to the last live conversation, timed until the reply is back and, through omp's log, until omp read it.
 * They run in a process of their own because the page that attaches to a huge conversation receives tens of MB, and a process that is
 * busy with that cannot time anything.
 *
 * `run.ts` correlates these samples with the attaches the probe makes (`hydrate` records), before and during each.
 */
import { appendFileSync, readFileSync } from "node:fs";

const s: { port: number; token: string; lives: string[]; out: string; seconds: number } = JSON.parse(
	readFileSync(process.env.FREEZE_PROBE ?? "", "utf8"),
);
const origin = `http://127.0.0.1:${s.port}`;
const headers = { "x-omp-webui-token": s.token, "x-omp-webui": "1" };
const out = s.out.replace(/probe\.jsonl$/, "dense.jsonl");
const now = () => performance.timeOrigin + performance.now();
const record = (kind: string, fields: Record<string, unknown>) =>
	appendFileSync(out, `${JSON.stringify({ kind, at: now(), ...fields })}\n`);

const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`, { headers: { ...headers, origin } } as unknown as string[]);
const waiting = new Map<string, () => void>();
let liveId = "";
ws.addEventListener("message", (ev) => {
	const text = String(ev.data);
	const head = /^\{"t":"reply","req":"([^"]+)","ok":(true|false)/.exec(text.slice(0, 200));
	if (!head) return;
	if (head[1] === "dense-open") liveId = (JSON.parse(text) as { data: { liveId: string } }).data.liveId;
	waiting.get(head[1] as string)?.();
	waiting.delete(head[1] as string);
});
const opened = Promise.withResolvers<void>();
ws.addEventListener("open", () => opened.resolve());
await opened.promise;
ws.send(
	JSON.stringify({
		t: "open",
		req: "dense-open",
		target: { kind: "resume", sessionFile: s.lives[s.lives.length - 1] },
	}),
);
while (!liveId) await Bun.sleep(20);

let probe = 10_000_000;
const stop = Date.now() + s.seconds * 1000;
const timer = setInterval(() => {
	const n = ++probe;
	const began = now();
	void fetch(`${origin}/api/meta`, { headers })
		.then((r) => r.arrayBuffer())
		.then(() => record("meta", { began, ms: now() - began }));
	const req = `dense-${n}`;
	const done = Promise.withResolvers<void>();
	waiting.set(req, done.resolve);
	ws.send(JSON.stringify({ t: "rpc", req, liveId, command: { type: "abort", probe: n } }));
	void done.promise.then(() => record("abort", { probe: n, began, ms: now() - began }));
}, 10);
while (Date.now() < stop) await Bun.sleep(500);
clearInterval(timer);
ws.close();
process.exit(0);
