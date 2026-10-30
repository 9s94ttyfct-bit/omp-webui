import { afterAll, beforeAll, expect, test, vi } from "bun:test";
import { Socket } from "../../web/src/lib/ws.ts";

/** Minimal stand-in for the browser WebSocket: the test drives open/close. */
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
	drop() {
		this.readyState = 3;
		this.onclose?.({ code: 1006 });
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

test("a request rejected as 'Connection lost' is not sent after reconnecting; later requests are", async () => {
	const s = new Socket();
	s.connect();
	const first = FakeWS.instances.at(-1) as FakeWS;

	const lost = s.request({ t: "list_lives" } as never);
	first.drop();
	await expect(lost).rejects.toThrow("Connection lost");

	vi.advanceTimersByTime(10_000);
	const second = FakeWS.instances.at(-1) as FakeWS;
	expect(second).not.toBe(first);
	const queued = s.request({ t: "list_lives" } as never);
	second.open();
	expect(second.sent.map((m) => JSON.parse(m).req)).toEqual(["r2"]);

	second.onmessage?.({ data: JSON.stringify({ t: "reply", req: "r2", ok: true, data: [] }) });
	await expect(queued).resolves.toEqual([]);
});
