import { expect, spyOn, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { compressResponse } from "../../server/compress.ts";

/**
 * Every API answer over 1 KB is compressed. The server's one thread also forwards every WebSocket frame of every running
 * conversation, so compressing a big answer (the HTML export of a long conversation is tens of MB) must not hold it.
 */

const gzipRequest = () => new Request("http://x/api/export", { headers: { "accept-encoding": "gzip, br" } });

/** Text that compresses to about half, so that the compressor really has work to do. */
function bulkyText(bytes: number): string {
	let state = 12345;
	const next = () => {
		state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
		return state;
	};
	const words = Array.from({ length: 5000 }, (_, i) => (i * 2654435761 + 7).toString(36));
	const parts: string[] = [];
	for (let size = 0; size < bytes; ) {
		const line = `<p>${Array.from({ length: 20 }, () => words[next() % words.length]).join(" ")} ${next()}</p>\n`;
		parts.push(line);
		size += line.length;
	}
	return parts.join("");
}

test("a big answer is compressed while the server keeps serving everything else", async () => {
	const text = bulkyText(40_000_000);
	// Something else the server does at the same moment (a WebSocket frame to forward): it must keep running. A real
	// timer on purpose: what is measured is whether the event loop stayed free while the answer was compressed.
	let ticks = 0;
	const timer = setInterval(() => ticks++, 2);
	let out: Response;
	try {
		out = await compressResponse(
			gzipRequest(),
			new Response(text, { headers: { "content-type": "text/html; charset=utf-8" } }),
		);
	} finally {
		clearInterval(timer);
	}
	// The compressor takes a few hundred ms: a thread that is held by it ticks once or twice, a free one dozens of times.
	expect(ticks).toBeGreaterThan(10);

	expect(out.headers.get("content-encoding")).toBe("gzip");
	expect(out.headers.get("vary")).toBe("accept-encoding");
	expect(out.headers.has("content-length")).toBe(false);
	expect(out.headers.get("content-type")).toBe("text/html; charset=utf-8");
	expect(gunzipSync(await out.arrayBuffer()).toString("utf8") === text).toBe(true);
});

test("a small answer, an answer to a client that takes no gzip and one that is not text go out as they are", async () => {
	const small = await compressResponse(gzipRequest(), Response.json({ a: 1 }));
	expect(small.headers.has("content-encoding")).toBe(false);
	expect(await small.json()).toEqual({ a: 1 });

	const big = JSON.stringify({ text: "x".repeat(5000) });
	const plain = await compressResponse(
		new Request("http://x/api/y"),
		new Response(big, { headers: { "content-type": "application/json" } }),
	);
	expect(plain.headers.has("content-encoding")).toBe(false);
	expect(await plain.text()).toBe(big);

	const bytes = new Uint8Array(5000);
	const binary = await compressResponse(
		gzipRequest(),
		new Response(bytes, { headers: { "content-type": "application/octet-stream" } }),
	);
	expect(binary.headers.has("content-encoding")).toBe(false);
	expect((await binary.arrayBuffer()).byteLength).toBe(5000);
});

test("an answer that is big enough is compressed whole and keeps its status", async () => {
	const body = JSON.stringify({ text: "y".repeat(5000) });
	const out = await compressResponse(
		gzipRequest(),
		new Response(body, { status: 409, headers: { "content-type": "application/json" } }),
	);
	expect(out.status).toBe(409);
	expect(out.headers.get("content-encoding")).toBe("gzip");
	expect(gunzipSync(await out.arrayBuffer()).toString("utf8")).toBe(body);
});

test("an answer of the size of the conversation list is compressed in place, a bigger one on the thread pool", async () => {
	// The list of conversations is 519 070 bytes of JSON on the benchmark library, and the page asks for it again on
	// every change. Compressing it on zlib's thread pool costs about a quarter more CPU on every request than
	// compressing it in place does (#569), and what it saves in stall is a few milliseconds of the server's thread.
	// Above the threshold the answer goes to the pool again, so that a big answer (the export of a conversation of
	// tens of MB) does not hold the server's one thread (#422).
	//
	// Which of the two ran is told by `Bun.gzipSync` being called: the in-place compression is that one, and the pool's
	// is node:zlib's `gzip`. Both produce the same bytes, so the answer is read back to be sure of it either way.
	const spy = spyOn(Bun, "gzipSync");
	try {
		const below = Buffer.alloc(1024 * 1024 - 1, 0x61);
		const out = await compressResponse(
			gzipRequest(),
			new Response(below, { headers: { "content-type": "application/json" } }),
		);
		expect(spy).toHaveBeenCalledTimes(1);
		expect(out.headers.get("content-encoding")).toBe("gzip");
		expect(gunzipSync(await out.arrayBuffer()).byteLength).toBe(below.byteLength);

		spy.mockClear();
		const above = Buffer.alloc(1024 * 1024 + 1, 0x61);
		const out2 = await compressResponse(
			gzipRequest(),
			new Response(above, { headers: { "content-type": "application/json" } }),
		);
		expect(spy).not.toHaveBeenCalled();
		expect(out2.headers.get("content-encoding")).toBe("gzip");
		expect(gunzipSync(await out2.arrayBuffer()).byteLength).toBe(above.byteLength);
	} finally {
		spy.mockRestore();
	}
});
