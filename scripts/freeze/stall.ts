#!/usr/bin/env bun
/**
 * A tab that stops reading: attached to the first live conversation of the harness (probe.ts' settings), it counts the
 * frames it gets, and the gaps in their numbers (the fake omp numbers its text deltas). The orchestrator stops this
 * process with SIGSTOP for a while and lets it go again, as a page whose window is hidden or whose thread is busy would
 * not read for that long; what the server did meanwhile shows as a gap, as the connection closing, or as nothing.
 *
 * Writes its counts to `stall.json` next to the probe's samples every second.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const s: { port: number; token: string; lives: string[]; out: string } = JSON.parse(
	readFileSync(process.env.FREEZE_PROBE ?? "", "utf8"),
);
const origin = `http://127.0.0.1:${s.port}`;
const summary = join(dirname(s.out), "stall.json");

const state = { frames: 0, gaps: 0, lostFrames: 0, lastN: 0, closed: false, bytes: 0, attachedAt: 0 };
const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`, {
	headers: { "x-omp-webui-token": s.token, origin },
} as unknown as string[]);
let liveId = "";
ws.addEventListener("close", () => {
	state.closed = true;
});
ws.addEventListener("message", (ev) => {
	const text = String(ev.data);
	state.bytes += text.length;
	if (text.startsWith('{"t":"reply"')) {
		const reply = JSON.parse(text) as { ok: boolean; data?: { liveId?: string } };
		if (reply.ok && reply.data?.liveId) liveId = reply.data.liveId;
		return;
	}
	if (!text.startsWith('{"t":"frame"')) return;
	state.frames++;
	// Only the numbered text deltas: `"n":123` follows the frame type.
	const n = /"type":"message_update","n":(\d+)/.exec(text)?.[1];
	if (n === undefined) return;
	const seen = Number(n);
	if (state.lastN && seen > state.lastN + 1) {
		state.gaps++;
		state.lostFrames += seen - state.lastN - 1;
	}
	state.lastN = seen;
});
const opened = Promise.withResolvers<void>();
ws.addEventListener("open", () => opened.resolve());
await opened.promise;
ws.send(JSON.stringify({ t: "open", req: "stall-open", target: { kind: "resume", sessionFile: s.lives[0] } }));
while (!liveId) await Bun.sleep(50);
state.attachedAt = Date.now();
setInterval(() => writeFileSync(summary, JSON.stringify({ ...state, at: Date.now() })), 1000);
