import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ParkedStore } from "../../server/omp/parked.ts";
import {
	type ExitInfo,
	encodeFrame,
	FRAME_HEADER,
	FROM_RELAY,
	FrameDecoder,
	type Hello,
	RELAY_FLAG,
	TO_RELAY,
} from "../../server/omp/relay-protocol.ts";

/**
 * What the next release must still understand of the one before it, because an app update restarts the server and
 * nothing else: the omp and relay of every paused conversation keep running, frozen, from the OLD binary, and the new
 * server adopts them from what the old one left (`LivePool.adopt`): a record on disk and a relay on a socket.
 *
 *  - Any `ParkedRecord.version` the reader does not take is "other": the record is not adopted, left on disk, and the
 *    frozen omp and its relay run on with no owner (every later start waits `ORPHAN_WAIT_MS` for them and logs it).
 *  - A relay frame id the client does not know makes the relay "not greet": adoption fails, and the conversation is
 *    ended (omp, its tool, the relay: `LivePool.discard`) - a paused turn is lost silently, on every user's next update.
 *
 * So these numbers and this record shape are frozen until a release has carried a migration. A migration needs: the
 * reader keeps accepting version 1 and maps it forward (never "other"); frames only ever get NEW ids, and the first
 * frame a relay sends (`hello`) says which protocol it speaks, absent meaning this one, so a new client can speak the
 * old one to an old relay (the new server never restarts a relay: it holds omp's pipes). Change the test in the same
 * commit as that code, not before.
 *
 * `fixtures/parked-v0.11.10-*.json` are records the v0.11.10 server really wrote (a real omp paused mid-tool, and one
 * with a goal and a running subagent), left by the quit that precedes an update: `bun scripts/upgrade-pause-check.ts
 * --fixtures <dir>` writes them, with the world's paths made generic. After a release that changes what a record holds,
 * add its fixtures next to these; do not replace them: the user's next update may start from any release.
 *
 * Not repeated here: the process identity (`ps -o lstart=,command=`, and the Linux `/proc` form) is pinned by
 * `parked.test.ts`, and the whole procedure across two real builds is `scripts/upgrade-pause-check.ts`.
 */

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("the relay speaks the frame ids a relay started by the previous release speaks", () => {
	expect(TO_RELAY).toEqual({ stdin: 1, stdinEnd: 2, hold: 3 });
	expect(FROM_RELAY).toEqual({ hello: 1, stdout: 2, stderr: 3, exit: 4, replaced: 5 });
	expect(FRAME_HEADER).toBe(5);
	expect(RELAY_FLAG).toBe("--ompw-relay");
	// [type: u8][length: u32 big endian][payload]
	expect(encodeFrame(TO_RELAY.stdin, "x").toString("hex")).toBe("010000000178");
	expect(encodeFrame(FROM_RELAY.exit).toString("hex")).toBe("0400000000");
});

test("a hello and an exit as the previous release's relay writes them (bytes, not encodeFrame) are what the client reads", () => {
	// The payloads' fields are the only ones the client may require: a new required field is a type error here.
	const hello = { pid: 4242, relayPid: 4241, stderr: "" } satisfies Hello;
	const exit = { code: 0, signal: null } satisfies ExitInfo;
	const bytes = (type: number, json: unknown): Buffer => {
		const payload = Buffer.from(JSON.stringify(json));
		const head = Buffer.alloc(FRAME_HEADER);
		head[0] = type;
		head.writeUInt32BE(payload.length, 1);
		return Buffer.concat([head, payload]);
	};
	const stream = Buffer.concat([bytes(1, hello), Buffer.from([2, 0, 0, 0, 3, 0x61, 0x0a, 0x62]), bytes(4, exit)]);
	// Whole, and a byte at a time: a socket delivers whatever it has.
	for (const step of [stream.length, 1]) {
		const decoder = new FrameDecoder();
		const frames = [];
		for (let at = 0; at < stream.length; at += step) frames.push(...decoder.push(stream.subarray(at, at + step)));
		expect(frames.map((f) => f.type)).toEqual([FROM_RELAY.hello, FROM_RELAY.stdout, FROM_RELAY.exit]);
		expect(JSON.parse(frames[0].payload.toString())).toEqual(hello);
		expect(frames[1].payload.toString()).toBe("a\nb");
		expect(JSON.parse(frames[2].payload.toString())).toEqual(exit);
	}
});

for (const name of ["mid-tool", "goal-subagents"]) {
	test(`a record the previous release wrote while a conversation was paused (${name}) is adopted, not skipped or removed`, () => {
		const dataDir = mkdtempSync(join(tmpdir(), "ompw-compat-"));
		dirs.push(dataDir);
		const text = readFileSync(join(import.meta.dir, "..", "fixtures", `parked-v0.11.10-${name}.json`), "utf8");
		const golden = JSON.parse(text);
		mkdirSync(join(dataDir, "parked"));
		const file = join(dataDir, "parked", `${golden.liveId}.json`);
		writeFileSync(file, text);

		const list = new ParkedStore(dataDir).list();
		expect(list).toHaveLength(1);
		const [record] = list;
		expect(record.version).toBe(1);
		// Everything the next server resumes from, as written. The mode the previous release called `online` is Full.
		expect(record).toMatchObject({
			liveId: golden.liveId,
			omp: golden.omp,
			relay: golden.relay,
			socket: golden.socket,
			owner: null,
			cwd: golden.cwd,
			args: golden.args,
			mode: golden.mode === "offline" ? "light" : "full",
			pausedAt: golden.pausedAt,
			streaming: golden.streaming,
			sessionFile: golden.sessionFile,
			sessionId: golden.sessionId,
			overlay: { file: golden.overlay.file, mode: golden.overlay.mode },
			descendants: golden.descendants,
			...(golden.goal ? { goal: { objective: golden.goal.objective, status: golden.goal.status } } : {}),
			...(golden.subagents ? { subagents: golden.subagents } : {}),
			...(golden.sessionSettings ? { sessionSettings: golden.sessionSettings } : {}),
		});
		expect(existsSync(file)).toBe(true);
	});
}
