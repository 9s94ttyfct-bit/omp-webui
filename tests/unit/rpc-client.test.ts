import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcClient, RpcError } from "../../server/omp/rpc-client.ts";
import type { OmpFrame } from "../../shared/protocol.ts";

/**
 * Drives RpcClient against a scripted fake `omp` so framing edge cases
 * (v2 negotiation, rpc_chunk reassembly, interleaving, exit) are exercised.
 */

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakeOmp(script: string): string {
	const dir = mkdtempSync(join(tmpdir(), "ompw-fake-"));
	dirs.push(dir);
	const bin = join(dir, "omp");
	writeFileSync(bin, `#!/usr/bin/env bun\n${script}`);
	chmodSync(bin, 0o755);
	return bin;
}

const SERVER_PRELUDE = `
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
const chunked = (obj, id, parts) => {
  const bytes = Buffer.from(JSON.stringify(obj));
  const size = Math.ceil(bytes.length / parts);
  for (let i = 0; i < parts; i++) out({ type: "rpc_chunk", chunkId: id, index: i, count: parts, byteLength: bytes.length, data: bytes.subarray(i * size, (i + 1) * size).toString("base64") });
};
let buf = "";
for await (const c of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(c);
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    const cmd = JSON.parse(line);
    handle(cmd);
  }
}
`;

function start(handler: string, frames: OmpFrame[] = [], onFrame: (f: OmpFrame) => void = () => {}) {
	const bin = fakeOmp(`${SERVER_PRELUDE}\nfunction handle(cmd) {${handler}}`);
	const exit = Promise.withResolvers<number | null>();
	const c = new RpcClient({
		bin,
		args: [],
		cwd: tmpdir(),
		onFrame: (f) => {
			frames.push(f);
			onFrame(f);
		},
		onExit: (code) => exit.resolve(code),
	});
	return { c, exit: exit.promise };
}

describe("RpcClient", () => {
	test("negotiates v2 and reassembles chunked responses with multibyte text", async () => {
		const big = "数据".repeat(5000);
		const { c } = start(`
      if (cmd.type === "negotiate_protocol") out({ id: cmd.id, type: "response", command: cmd.type, success: true, data: { protocolVersion: 2 } });
      if (cmd.type === "get_messages") chunked({ id: cmd.id, type: "response", command: cmd.type, success: true, data: { text: ${JSON.stringify(big)} } }, "c1", 7);
    `);
		await c.ready;
		const data = await c.call<{ text: string }>({ type: "get_messages" });
		expect(data.text).toBe(big);
		c.close();
	});

	test("an interleaved frame aborts a chunk sequence instead of corrupting it", async () => {
		const frames: OmpFrame[] = [];
		const { c } = start(
			`
      if (cmd.type === "negotiate_protocol") out({ id: cmd.id, type: "response", command: cmd.type, success: true });
      if (cmd.type === "go") {
        const bytes = Buffer.from(JSON.stringify({ type: "huge", n: 1 }));
        out({ type: "rpc_chunk", chunkId: "x", index: 0, count: 2, byteLength: bytes.length, data: bytes.subarray(0, 5).toString("base64") });
        out({ type: "notice", message: "interleaved" });
        out({ type: "rpc_chunk", chunkId: "x", index: 1, count: 2, byteLength: bytes.length, data: bytes.subarray(5).toString("base64") });
        out({ id: cmd.id, type: "response", command: "go", success: true });
      }
    `,
			frames,
		);
		await c.ready;
		await c.call({ type: "go" });
		expect(frames.map((f) => f.type)).toEqual(["ready", "notice"]);
		c.close();
	});

	test("failure responses reject call() with omp's error code", async () => {
		const { c } = start(`
      if (cmd.type === "negotiate_protocol") out({ id: cmd.id, type: "response", command: cmd.type, success: true });
      if (cmd.type === "fork") out({ id: cmd.id, type: "response", command: "fork", success: false, error: "busy", code: "session_busy" });
    `);
		await c.ready;
		await expect(c.call({ type: "fork" })).rejects.toMatchObject({ message: "busy", code: "session_busy" });
		c.close();
	});

	test("an answer is taken in at its place among the frames: before the frame omp wrote right after it, not after", async () => {
		const seen: string[] = [];
		const { c } = start(
			`
      if (cmd.type === "negotiate_protocol") out({ id: cmd.id, type: "response", command: cmd.type, success: true });
      if (cmd.type === "ask") process.stdout.write(JSON.stringify({ id: cmd.id, type: "response", command: "ask", success: true }) + "\\n" + JSON.stringify({ type: "notice", message: "after" }) + "\\n");
    `,
			[],
			(f) => seen.push(`frame ${f.type}`),
		);
		await c.ready;
		const answer = await c.request({ type: "ask" }, 0, undefined, () => seen.push("answered"));
		seen.push("continued");
		expect(answer.success).toBe(true);
		// The two lines are read together; whatever waits for the Promise runs after both.
		expect(seen).toEqual(["frame ready", "answered", "frame notice", "continued"]);
		c.close();
	});

	test("a handler of an answer that throws leaves the request answered, and the lines after it handled", async () => {
		const frames: OmpFrame[] = [];
		const noticed = Promise.withResolvers<void>();
		const { c } = start(
			`
      if (cmd.type === "negotiate_protocol") out({ id: cmd.id, type: "response", command: cmd.type, success: true });
      if (cmd.type === "ask") process.stdout.write(JSON.stringify({ id: cmd.id, type: "response", command: "ask", success: true }) + "\\n" + JSON.stringify({ type: "notice", message: "after" }) + "\\n");
    `,
			frames,
			(f) => {
				if (f.type === "notice") noticed.resolve();
			},
		);
		await c.ready;
		const logged = spyOn(console, "error").mockImplementation(() => {});
		try {
			const answer = await c.request({ type: "ask" }, 0, undefined, () => {
				throw new Error("a handler's failure");
			});
			expect(answer.success).toBe(true);
			await noticed.promise;
			expect(frames.map((f) => f.type)).toEqual(["ready", "notice"]);
			expect(String(logged.mock.calls[0]?.[0])).toContain("a handler's failure");
		} finally {
			logged.mockRestore();
			c.close();
		}
	});

	test("pending requests reject with omp's stderr reason when the process exits", async () => {
		const { c, exit } = start(`
      if (cmd.type === "negotiate_protocol") out({ id: cmd.id, type: "response", command: cmd.type, success: true });
      if (cmd.type === "die") { process.stderr.write("    at stack frame\\nerror: Could not restore model x/y\\n"); process.exit(3); }
    `);
		await c.ready;
		await expect(c.call({ type: "die" })).rejects.toThrow("omp exited (code 3): error: Could not restore model x/y");
		expect(await exit).toBe(3);
	});

	test("an omp killed by a signal rejects what is pending naming the signal, and reports the signal, not a made-up code", async () => {
		const bin = fakeOmp(`${SERVER_PRELUDE}
function handle(cmd) {
  if (cmd.type === "negotiate_protocol") out({ id: cmd.id, type: "response", command: cmd.type, success: true });
  if (cmd.type === "die") process.kill(process.pid, "SIGKILL");
}`);
		const exit = Promise.withResolvers<{ code: number | null; signal: string | null }>();
		const c = new RpcClient({
			bin,
			args: [],
			cwd: tmpdir(),
			onFrame: () => {},
			onExit: (code, _stderr, signal) => exit.resolve({ code, signal }),
		});
		await c.ready;
		await expect(c.call({ type: "die" })).rejects.toThrow("omp exited (killed by SIGKILL)");
		expect(await exit.promise).toEqual({ code: null, signal: "SIGKILL" });
	});

	test("a child that dies while a large request is being written rejects it; nothing goes unhandled", async () => {
		// Bun reports EPIPE on the stdin write as a rejected Promise; unhandled, it takes the whole server down.
		const unhandled: unknown[] = [];
		const record = (e: unknown) => {
			unhandled.push(e);
		};
		process.on("unhandledRejection", record);
		try {
			const stalling = Promise.withResolvers<void>();
			const { c, exit } = start(
				`
      if (cmd.type === "negotiate_protocol") out({ id: cmd.id, type: "response", command: cmd.type, success: true });
      if (cmd.type === "stall") {
        require("node:fs").writeSync(1, JSON.stringify({ type: "stalling" }) + "\\n");
        Bun.sleepSync(60000);
      }
    `,
				[],
				(f) => {
					if (f.type === "stalling") stalling.resolve();
				},
			);
			await c.ready;
			// omp stops reading: whatever is sent next stays queued in the pipe.
			const stalled = c.request({ type: "stall" });
			await stalling.promise;
			const large = c.request({ type: "prompt", message: "x".repeat(16 * 1024 * 1024) });
			const outcomes = Promise.allSettled([stalled, large]);

			c.proc.kill("SIGKILL");
			for (const outcome of await outcomes) {
				expect(outcome.status).toBe("rejected");
				expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(RpcError);
			}
			await exit;
			// One more event-loop turn: an EPIPE rejection nobody handled would have been reported by now.
			const turn = Promise.withResolvers<void>();
			setImmediate(turn.resolve);
			await turn.promise;
			expect(unhandled).toEqual([]);

			// A client whose process is gone refuses new work at once instead of waiting for a reply.
			await expect(c.request({ type: "get_state" })).rejects.toBeInstanceOf(RpcError);
			expect(() => c.close()).not.toThrow();
		} finally {
			process.off("unhandledRejection", record);
		}
	});

	test("a line that is JSON but no frame is dropped, and the frames and the reply after it still arrive (#315)", async () => {
		const unhandled: unknown[] = [];
		const record = (e: unknown) => {
			unhandled.push(e);
		};
		process.on("unhandledRejection", record);
		try {
			const frames: OmpFrame[] = [];
			const { c } = start(
				`
      if (cmd.type === "negotiate_protocol") out({ id: cmd.id, type: "response", command: cmd.type, success: true });
      if (cmd.type === "go") {
        // What is valid JSON and no frame: null, a number, a string, a list, an object without a type.
        for (const v of [null, 5, "text", [1, 2], { no: "type" }, { type: 7 }]) out(v);
        out({ type: "notice", message: "after" });
        out({ id: cmd.id, type: "response", command: "go", success: true });
      }
    `,
				frames,
			);
			await c.ready;
			await c.call({ type: "go" });
			expect(frames.map((f) => f.type)).toEqual(["ready", "notice"]);
			c.close();
			const turn = Promise.withResolvers<void>();
			setImmediate(turn.resolve);
			await turn.promise;
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", record);
		}
	});

	test("a frame whose handler throws is logged, and the lines after it are still read (#315)", async () => {
		const unhandled: unknown[] = [];
		const record = (e: unknown) => {
			unhandled.push(e);
		};
		process.on("unhandledRejection", record);
		const logged = spyOn(console, "error").mockImplementation(() => {});
		try {
			const frames: OmpFrame[] = [];
			const { c } = start(
				`
      if (cmd.type === "negotiate_protocol") out({ id: cmd.id, type: "response", command: cmd.type, success: true });
      if (cmd.type === "go") {
        out({ type: "boom" });
        out({ type: "notice", message: "after" });
        out({ id: cmd.id, type: "response", command: "go", success: true });
      }
    `,
				frames,
				(f) => {
					if (f.type === "boom") throw new Error("the handler broke");
				},
			);
			await c.ready;
			await c.call({ type: "go" });
			expect(frames.map((f) => f.type)).toEqual(["ready", "boom", "notice"]);
			expect(logged.mock.calls.map((call) => String(call[0])).join("\n")).toContain("the handler broke");
			c.close();
			const turn = Promise.withResolvers<void>();
			setImmediate(turn.resolve);
			await turn.promise;
			expect(unhandled).toEqual([]);
		} finally {
			logged.mockRestore();
			process.off("unhandledRejection", record);
		}
	});
});
