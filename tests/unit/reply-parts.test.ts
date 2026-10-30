import { expect, test } from "bun:test";
import { PART_CHARS, partOf, ReplyAssembler, replyMessages } from "../../shared/reply-parts.ts";

/**
 * A reply too large for one WebSocket message is sent as parts, so that a page on a slow link hears it arrive (see the
 * module). The parts are cut from the text omp wrote and put back together, byte for byte.
 */

/** A UTF-16 unit of a pair with its other half missing: what cannot be sent as text. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** What a page makes of the messages of one reply: `null` while parts are missing. */
function received(messages: string[]): unknown {
	const assembler = new ReplyAssembler();
	let whole: unknown = null;
	for (const m of messages) {
		const part = assembler.push(m);
		if (part === null) whole = JSON.parse(m);
		else if (part.data !== null) whole = { t: "reply", req: part.req, ok: true, data: JSON.parse(part.data) };
	}
	return whole;
}

test("a small reply is one JSON message, as it always was", () => {
	const messages = replyMessages('r"1', '{"a":[1,2]}');
	expect(messages).toEqual(['{"t":"reply","req":"r\\"1","ok":true,"data":{"a":[1,2]}}']);
	expect(partOf(messages[0] as string)).toBeNull();
	expect(received(messages)).toEqual({ t: "reply", req: 'r"1', ok: true, data: { a: [1, 2] } });
});

test("a large reply is parts of at most `PART_CHARS`, each marked by its request, the last marked as the last", () => {
	const data = JSON.stringify({
		entries: Array.from({ length: 3000 }, (_, i) => ({ id: `e${i}`, text: "x".repeat(200) })),
	});
	expect(data.length).toBeGreaterThan(PART_CHARS * 4);
	const messages = replyMessages("r7", data);
	expect(messages.length).toBe(Math.ceil(data.length / PART_CHARS));
	for (const m of messages) {
		expect(partOf(m)).toBe("r7");
		expect(m.length).toBeLessThanOrEqual(PART_CHARS + "~r7~0~".length);
	}
	expect(messages.slice(0, -1).every((m) => m.startsWith("~r7~0~"))).toBe(true);
	expect(messages.at(-1)?.startsWith("~r7~1~")).toBe(true);
	expect(received(messages)).toEqual({ t: "reply", req: "r7", ok: true, data: JSON.parse(data) });
});

test("a piece never ends inside a surrogate pair, whatever the size", () => {
	// Each 😀 is two UTF-16 units; an odd size would cut one in half.
	const data = JSON.stringify({ text: "😀é数据😀".repeat(40), tilde: "~~~" });
	for (const size of [3, 5, 7, 11, 64]) {
		const messages = replyMessages("q", data, size);
		const pieces = messages.map((m) => m.slice("~q~0~".length));
		expect(pieces.some((p) => LONE_SURROGATE.test(p))).toBe(false);
		expect(received(messages)).toEqual({ t: "reply", req: "q", ok: true, data: JSON.parse(data) });
	}
});

test("a request id that holds the mark is answered whole: its parts could not be told apart", () => {
	const messages = replyMessages("a~b", "[".concat("1,".repeat(100), "2]"), 10);
	expect(messages).toHaveLength(1);
	expect(received(messages)).toMatchObject({ req: "a~b", ok: true });
});

test("parts of replies to different requests are put together each its own way", () => {
	const one = replyMessages("r1", JSON.stringify({ one: "a".repeat(50) }), 16);
	const two = replyMessages("r2", JSON.stringify({ two: "b".repeat(50) }), 16);
	const assembler = new ReplyAssembler();
	const done: Record<string, unknown> = {};
	for (let i = 0; i < Math.max(one.length, two.length); i++) {
		for (const m of [one[i], two[i]]) {
			const part = m === undefined ? null : assembler.push(m);
			if (part?.data) done[part.req] = JSON.parse(part.data);
		}
	}
	expect(done).toEqual({ r1: { one: "a".repeat(50) }, r2: { two: "b".repeat(50) } });
});

test("what is not a part is not taken for one, and a connection that ended leaves nothing behind", () => {
	const assembler = new ReplyAssembler();
	for (const text of ['{"t":"hello"}', "", "~", "~~", "~r1", "~r1~", "~r1~2~x", "~r1~0x"])
		expect(assembler.push(text)).toBeNull();
	const text = JSON.stringify({ k: "v".repeat(40) });
	const parts = replyMessages("r1", text, 16);
	for (const m of parts.slice(0, -1)) assembler.push(m);
	assembler.clear();
	// The rest of a reply whose beginning went with the connection is not that reply.
	expect(assembler.push(parts.at(-1) as string)?.data).not.toBe(text);
});
