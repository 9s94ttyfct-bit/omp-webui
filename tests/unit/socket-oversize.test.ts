import { afterAll, beforeAll, expect, test, vi } from "bun:test";
import { MAX_WS_MESSAGE_BYTES } from "../../shared/protocol.ts";
import { oversize, Socket } from "../../web/src/lib/ws.ts";

/**
 * A message over the server's limit closes the whole socket (code 1009) and fails every request on it: the page refuses it
 * itself, saying what is too large, and the socket and the other requests stay as they were (#381).
 */

class FakeWS {
	static OPEN = 1;
	static instances: FakeWS[] = [];
	readyState = 0;
	sent: string[] = [];
	onopen?: () => void;
	onclose?: (ev: { code: number }) => void;
	onmessage?: (ev: { data: string }) => void;
	constructor(public url: string) {
		FakeWS.instances.push(this);
	}
	send(text: string) {
		this.sent.push(text);
	}
	open() {
		this.readyState = FakeWS.OPEN;
		this.onopen?.();
	}
}

const saved = { WebSocket: globalThis.WebSocket, location: (globalThis as { location?: unknown }).location };
beforeAll(() => {
	vi.useFakeTimers();
	Object.assign(globalThis, { WebSocket: FakeWS, location: { protocol: "http:", host: "127.0.0.1:1" } });
});
afterAll(() => {
	vi.useRealTimers();
	Object.assign(globalThis, saved);
});

test("a message is over the limit by its bytes in UTF-8, not by its characters", () => {
	expect(oversize("x".repeat(1000))).toBeNull();
	// 12M characters of ASCII are under 32 MiB; 12M CJK characters are 36 MB of UTF-8.
	expect(oversize("x".repeat(12_000_000))).toBeNull();
	expect(oversize("中".repeat(12_000_000))).toBe(36_000_000);
	expect(oversize("x".repeat(MAX_WS_MESSAGE_BYTES + 1))).toBe(MAX_WS_MESSAGE_BYTES + 1);
});

test("a message over the limit is refused with what is too large, is never sent, and the other requests go on", async () => {
	const s = new Socket();
	s.connect();
	const ws = FakeWS.instances.at(-1) as FakeWS;
	ws.open();

	const big = s.request({
		t: "rpc",
		liveId: "a",
		command: { type: "prompt", message: "中".repeat(12_000_000) },
	} as never);
	await expect(big).rejects.toThrow(/too large.*34\.\d MiB.*32\.0 MiB/);
	expect(ws.sent).toEqual([]);

	// The socket is as it was: another request goes out and is answered.
	const other = s.request({ t: "list_lives" } as never);
	expect(ws.sent.map((m) => JSON.parse(m).req)).toEqual(["r2"]);
	ws.onmessage?.({ data: JSON.stringify({ t: "reply", req: "r2", ok: true, data: [] }) });
	await expect(other).resolves.toEqual([]);
});
