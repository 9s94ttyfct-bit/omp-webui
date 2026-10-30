import { expect, test } from "bun:test";
import { wholeLines } from "../../server/omp/relay.ts";

/**
 * How the relay cuts what omp writes into whole lines (server/omp/relay.ts `wholeLines`): the copies it makes of a line
 * longer than a pipe's chunk are counted here, not seen as the memory of a relay process, which also holds what its
 * collector has not freed yet.
 */

const CHUNK = 64 * 1024;
const text = (s: string): Uint8Array => new TextEncoder().encode(s);
const join = (pieces: readonly Uint8Array[]): string => new TextDecoder().decode(Buffer.concat(pieces));

async function* arriving(...chunks: Uint8Array[]): AsyncGenerator<Uint8Array> {
	yield* chunks;
}

async function cut(...chunks: Uint8Array[]): Promise<Buffer[][]> {
	const out: Buffer[][] = [];
	for await (const lines of wholeLines(arriving(...chunks))) out.push(lines);
	return out;
}

test("a line that comes in many chunks waits as those chunks and is handed over once, whole", async () => {
	const line = "x".repeat(700_000);
	const bytes = text(`${line}\nnext`);
	const chunks: Uint8Array[] = [];
	for (let at = 0; at < bytes.length; at += CHUNK) chunks.push(bytes.subarray(at, at + CHUNK));
	expect(chunks.length).toBeGreaterThan(10);

	const handed = await cut(...chunks);
	// One hand-over, for the chunk that ended the line.
	expect(handed).toHaveLength(1);
	expect(join(handed[0])).toBe(`${line}\n`);
	// The pieces are the chunks it came in: nothing joined the line up to there and again at every chunk after (which
	// would leave one piece that grows, and copy it as many times as there are chunks).
	expect(handed[0].length).toBeGreaterThanOrEqual(chunks.length - 1);
	for (const piece of handed[0]) expect(piece.length).toBeLessThanOrEqual(CHUNK);
});

test("lines come out whole: what a chunk has after its last newline waits for the next chunk, and a chunk without one is not handed on", async () => {
	const handed = await cut(text("one\ntwo\nthr"), text("ee"), text("\nfour\n"), text("five"));
	// "five" has no newline yet: it is not omp's whole line, and stays unsent.
	expect(handed.map(join)).toEqual(["one\ntwo\n", "three\nfour\n"]);
	for (const lines of handed) expect(join(lines).endsWith("\n")).toBe(true);
});

test("the next chunk is not read before the lines of the one before have been taken: a consumer that waits holds omp back", async () => {
	let read = 0;
	async function* source(): AsyncGenerator<Uint8Array> {
		for (const chunk of ["a\n", "b\n", "c\n"]) {
			read++;
			yield text(chunk);
		}
	}
	const lines = wholeLines(source());
	expect(join((await lines.next()).value as Buffer[])).toBe("a\n");
	expect(read).toBe(1);
	expect(join((await lines.next()).value as Buffer[])).toBe("b\n");
	expect(read).toBe(2);
	await lines.return(undefined);
});
