import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcClient, splitResponse } from "../../server/omp/rpc-client.ts";
import { ReplyAssembler, replyMessages } from "../../shared/reply-parts.ts";

/**
 * A large answer is passed on to the page as the text omp wrote, not read into objects and written out again: for a
 * conversation of tens of MB that is hundreds of ms in which the server's one thread answers nothing else, and half a GB
 * of memory. `splitResponse` cuts the text without reading it; these tests pin down what it may and may not cut.
 */

const HEAD = '{"id":"r1","type":"response","command":"get_entries","success":true';
const answer = (data: string) => `${HEAD},"data":${data}}`;

describe("splitResponse", () => {
	test("takes the answer's head as objects and `data` as the text omp wrote, wherever the later pieces end", () => {
		const data = '{"entries":[{"id":"a","text":"x \\"data\\": y"},{"id":"b","nested":{"data":[1,2,3]}}],"leafId":"b"}';
		const text = answer(data);
		for (const size of [1000, 100, 79]) {
			const pieces = Array.from({ length: Math.ceil(text.length / size) }, (_, i) =>
				text.slice(i * size, (i + 1) * size),
			);
			const split = splitResponse(pieces);
			expect(split?.head).toMatchObject({ id: "r1", type: "response", command: "get_entries", success: true });
			expect(split?.data).toBe(data);
		}
	});

	test("a head that does not fit the first piece is left to the full parse", () => {
		const text = answer('{"a":1}');
		expect(splitResponse([text.slice(0, 30), text.slice(30)])).toBeNull();
	});

	test('the first `"data":` is a key even when an earlier string holds that text, because a string cannot hold a bare quote', () => {
		const text = `{"id":"r1","type":"response","command":"x","success":false,"error":"no \\"data\\": here","data":{"k":1}}`;
		const split = splitResponse([text]);
		expect(split?.head).toMatchObject({ error: 'no "data": here', success: false });
		expect(split?.data).toBe('{"k":1}');
	});

	test("an answer whose `data` is a string, a number or an array is cut like any other", () => {
		for (const data of ['"text"', "42", "[1,2]", "null", "true"])
			expect(splitResponse([answer(data)])?.data).toBe(data);
	});

	test("what is not an answer of the usual shape is left to the full parse", () => {
		// Not a response; no id; no success flag; `data` first (the keys after it would be taken for its text).
		expect(splitResponse(['{"type":"message_update","data":{"a":1}}'])).toBeNull();
		expect(splitResponse(['{"type":"response","success":true,"data":{"a":1}}'])).toBeNull();
		expect(splitResponse(['{"id":"r","type":"response","data":{"a":1}}'])).toBeNull();
		// `"data":` inside something nested in an earlier value is not the answer's own key: what precedes it does not close.
		expect(splitResponse(['{"id":"r","type":"response","success":true,"extra":{"data":{"a":1}}}'])).toBeNull();
		// No `data` at all, or nothing after it, or no closing brace at the end.
		expect(splitResponse(['{"id":"r","type":"response","command":"abort","success":true}'])).toBeNull();
		expect(splitResponse(['{"id":"r","type":"response","success":true,"data":}'])).toBeNull();
		expect(splitResponse(['{"id":"r","type":"response","success":true,"data":[1,2]'])).toBeNull();
		expect(splitResponse([])).toBeNull();
	});

	test("a closing brace followed by whitespace in the last piece is still the end", () => {
		expect(splitResponse([`${answer('{"a":1}')}\n`])?.data).toBe('{"a":1}');
		const text = answer('{"a":1}');
		expect(splitResponse([text.slice(0, 76), `${text.slice(76)} \n`])?.data).toBe('{"a":1}');
	});

	test("the reply to the page is valid JSON with the text in it as it is", () => {
		const data = '{"entries":[{"id":"é数据"}],"leafId":"b"}';
		const messages = replyMessages('r"1', data);
		expect(messages).toHaveLength(1);
		const reply = JSON.parse(messages[0] as string);
		expect(reply).toEqual({ t: "reply", req: 'r"1', ok: true, data: { entries: [{ id: "é数据" }], leafId: "b" } });
	});
});

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ENTRIES = 60;
/** Characters of text in each entry: 60 of them are over a million. */
const TEXT = 20_000;

/** A client of a scripted omp that answers every command but the negotiation with a large `get_entries` answer, in chunks of 64 KiB. */
function client(): RpcClient {
	const dir = mkdtempSync(join(tmpdir(), "ompw-raw-"));
	dirs.push(dir);
	const bin = join(dir, "omp");
	writeFileSync(
		bin,
		`#!/usr/bin/env bun
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
let buf = "";
for await (const c of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(c);
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const cmd = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (cmd.type === "negotiate_protocol") { out({ id: cmd.id, type: "response", command: cmd.type, success: true, data: {} }); continue; }
    // 数据 is 6 bytes for 2 characters: chunk boundaries fall inside characters.
    const list = Array.from({ length: ${ENTRIES} }, (_, n) => ({ id: "e" + n, text: "数据".repeat(${TEXT / 2}) }));
    const bytes = Buffer.from(JSON.stringify({ id: cmd.id, type: "response", command: cmd.type, success: true, data: { entries: list, leafId: "e" } }));
    const count = Math.ceil(bytes.length / 65536);
    for (let n = 0; n < count; n++) out({ type: "rpc_chunk", chunkId: "c", index: n, count, byteLength: bytes.length, data: bytes.subarray(n * 65536, (n + 1) * 65536).toString("base64") });
  }
}
`,
	);
	chmodSync(bin, 0o755);
	return new RpcClient({ bin, args: [], cwd: tmpdir(), onFrame: () => {}, onExit: () => {} });
}

describe("RpcClient with a large answer", () => {
	test("hands out the text of `data` and reads it into objects only if asked", async () => {
		const c = client();
		await c.ready;
		const r = await c.request({ type: "get_entries" });
		expect(r.success).toBe(true);
		expect(r.rawData?.length).toBeGreaterThan(1_000_000);
		const data = r.data as { entries: { id: string; text: string }[]; leafId: string };
		expect(data.entries).toHaveLength(ENTRIES);
		expect(data.entries[ENTRIES - 1]).toEqual({ id: `e${ENTRIES - 1}`, text: "数据".repeat(TEXT / 2) });
		// What the page is sent is the same document.
		const parts = replyMessages("q", r.rawData as string);
		expect(parts.length).toBeGreaterThan(1);
		const whole = new ReplyAssembler();
		const received = parts.map((p) => whole.push(p));
		expect(received.slice(0, -1).every((p) => p?.data === null)).toBe(true);
		expect(JSON.parse(received.at(-1)?.data as string)).toEqual(data);
		c.close();
	});

	test("does not read the whole answer into objects while it is only passed on", async () => {
		const c = client();
		await c.ready;
		// A parse of anything this size is what held every other request up.
		const parse = JSON.parse;
		const large: number[] = [];
		JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
			if (typeof text === "string" && text.length > 100_000) large.push(text.length);
			return parse(text, reviver);
		}) as typeof JSON.parse;
		try {
			const r = await c.request({ type: "get_entries" });
			expect(r.rawData?.length).toBeGreaterThan(1_000_000);
			expect(large).toEqual([]);
		} finally {
			JSON.parse = parse;
		}
		c.close();
	});
});
