import { afterEach, beforeEach, expect, test } from "bun:test";
import { replyMessages } from "../../shared/reply-parts.ts";
import { connect, request } from "../support/ws.ts";

/** tests/support/ws.ts `request()` against a small WebSocket server that answers by command. */

let server: Bun.Server<undefined>;
let ws: WebSocket;

beforeEach(async () => {
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req, srv) {
			return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
		},
		websocket: {
			message(sock, raw) {
				const m = JSON.parse(String(raw));
				const reply = (data: unknown) => sock.send(JSON.stringify({ t: "reply", req: m.req, ok: true, data }));
				if (m.cmd === "echo") reply(m.value);
				else if (m.cmd === "fail") sock.send(JSON.stringify({ t: "reply", req: m.req, ok: false, error: "nope" }));
				else if (m.cmd === "noisy") {
					// Other requests' replies, events and a part of someone else's reply come first.
					sock.send(JSON.stringify({ t: "reply", req: "another", ok: true, data: "not mine" }));
					sock.send(JSON.stringify({ t: "event", n: 1 }));
					sock.send(replyMessages("another", JSON.stringify("also not mine"), 4)[0] as string);
					reply("mine");
				} else if (m.cmd === "big") {
					// Two requests' parts arrive interleaved.
					const parts = replyMessages(m.req, JSON.stringify(m.value), 7);
					for (const part of parts) sock.send(part);
				} else if (m.cmd === "close") sock.close();
				// "never": no reply at all.
			},
		},
	});
	ws = await connect({ url: `http://127.0.0.1:${server.port}`, accessToken: "t" });
});
afterEach(() => {
	ws.close();
	server.stop(true);
});

test("a reply resolves its request, an error reply rejects it with the error", async () => {
	expect(await request(ws, { cmd: "echo", value: { a: [1, 2] } })).toEqual({ a: [1, 2] });
	await expect(request(ws, { cmd: "fail" })).rejects.toThrow("nope");
});

test("frames that are not this request's reply are ignored", async () => {
	expect(await request(ws, { cmd: "noisy" })).toBe("mine");
});

test("replies in parts are put back together, for requests that are waiting at the same time", async () => {
	const long = "ünï ".repeat(40);
	const [a, b] = await Promise.all([
		request(ws, { cmd: "big", value: { text: long } }),
		request(ws, { cmd: "big", value: { text: long.toUpperCase() } }),
	]);
	expect(a).toEqual({ text: long });
	expect(b).toEqual({ text: long.toUpperCase() });
});

test("the connection closing fails the requests waiting on it at once, not at the test's timeout", async () => {
	const waiting = [request(ws, { cmd: "never" }), request(ws, { cmd: "close" })];
	const started = Date.now();
	const results = await Promise.allSettled(waiting);
	expect(Date.now() - started).toBeLessThan(1000);
	for (const r of results) {
		expect(r.status).toBe("rejected");
		expect((r as PromiseRejectedResult).reason.message).toContain("connection closed");
	}
});

test("a server that goes away fails what is waiting, and a request on the dead socket fails without waiting", async () => {
	const waiting = request(ws, { cmd: "never" });
	server.stop(true);
	await expect(waiting).rejects.toThrow(/connection (closed|error)/);
	const started = Date.now();
	await expect(request(ws, { cmd: "echo", value: 1 })).rejects.toThrow("connection closed");
	expect(Date.now() - started).toBeLessThan(500);
});

test("a socket carries one set of listeners however many requests it makes", async () => {
	const added: string[] = [];
	const add = ws.addEventListener.bind(ws) as (type: string, ...rest: unknown[]) => void;
	ws.addEventListener = ((type: string, ...rest: unknown[]) => {
		added.push(type);
		add(type, ...rest);
	}) as typeof ws.addEventListener;
	for (let i = 0; i < 1000; i++) expect(await request(ws, { cmd: "echo", value: i })).toBe(i);
	expect(added.length).toBeLessThanOrEqual(3);
});
