import { createGzip, type ZlibOptions } from "node:zlib";
import type { Job, Reply } from "./family.ts";
import { memberPieces, PIECE_CHARS, rememberIds } from "./family-document.ts";
import { answerView } from "./history.ts";
import { ViewError } from "./history-request.ts";

/**
 * Worker thread of `family.ts`: reads and parses the session files of a lineage, serializes them and
 * gzips the result, so none of that holds the server's request thread. A large conversation (tens of MB)
 * takes hundreds of milliseconds; the server answers other requests meanwhile.
 *
 * A request for a window of the history (`view`) is answered by `history.ts` instead, from indexes of the files that this
 * worker keeps while it lives: a conversation that is tens of MB is not read whole for the last two hundred entries of it.
 *
 * omp's `fork` and `branch` write a new file with the whole path from the root copied, entry ids kept: a family of a
 * conversation and its forks holds that path once per file. A client that can put the shared entries back together
 * (the web UI does, see `x-family-dedup`) is sent the shared path once: a file says which entries it has, in order
 * (`order`), and the entries themselves are in that file's `entries` or in an earlier file's. A line whose entry was
 * sent already is not even parsed, each entry is serialized as it is read (so the objects of a file are not held
 * while it is written out), and the document is written to the gzip stream in bounded pieces (`family-document.ts`):
 * what is held while a file is read is its text, the ids of the entries of the files before it (copies, not pieces of
 * their text) and one piece of its JSON: not the objects of every file, and not the file's whole JSON as well. The text
 * of a file read before is garbage that JavaScriptCore collects on its own schedule, so a family of several long files can
 * have more than one text in memory at its end; the worker collects once the job is done.
 *
 * The compiled app embeds this file as a second entry point (scripts/app.ts) and reaches it through the
 * same relative URL as from source: keep it next to `main.ts`.
 */

/**
 * The size of the pieces zlib hands its output over in.
 *
 * zlib's own default is 16 KB: a family of a long conversation is tens of MB, so its body came out in thousands of
 * pieces, each one a `data` event, a buffer and a push, paid in the worker on the request the page waits for. In
 * 1 MB pieces the same body is built in about a third less time. The compressed bytes are the same either way: this
 * sizes zlib's output buffers, not its deflate blocks.
 */
const GZIP_CHUNK = 1024 * 1024;

/**
 * How much the gzip stream takes before it says to wait: a few pieces. The worker makes the next piece while zlib, on
 * another thread, compresses the ones it has, and never holds more than this ahead of it.
 */
const GZIP_BACKLOG = 4 * PIECE_CHARS;

/** A zlib stream is a `Transform` and takes its stream options; `ZlibOptions` does not list them. */
const GZIP_OPTIONS: ZlibOptions & { highWaterMark: number } = {
	// Level 1: the body is built once per change and cached, so speed matters more than the last few percent.
	level: 1,
	chunkSize: GZIP_CHUNK,
	highWaterMark: GZIP_BACKLOG,
};

/** The document of a lineage (or of one transcript with `single`), written piece by piece. */
async function writeLineage(job: Job, write: (piece: string) => Promise<void>): Promise<void> {
	const { file, members, single, dedup } = job;
	// The ids of the entries sent so far: a file's entries that are among them are not sent again. One transcript
	// (`/api/session`), and a client that did not ask for the shared path to be sent once, are sent as they are.
	const seen = single || !dedup ? null : new Set<string>();
	if (!single) await write(`{"file":${JSON.stringify(file)},"members":[`);
	// One file at a time: the text of a big conversation is the largest thing in memory here.
	// A file the client holds as it is is named, not sent; the files after it still have its entries to go by, unless
	// no file is sent after it.
	const lastSent = members.findLastIndex((m) => !m.kept);
	for (const [i, member] of members.entries()) {
		if (i > 0) await write(",");
		if (member.kept) {
			await write(`{"file":${JSON.stringify(member.file)},"tag":${JSON.stringify(member.tag)},"kept":true}`);
			if (seen && i < lastSent) rememberIds(await Bun.file(member.file).text(), seen);
			continue;
		}
		const text = await Bun.file(member.file).text();
		for (const piece of memberPieces(member.file, text, seen, member, seen ? member.tag : null)) await write(piece);
	}
	if (!single) await write("]}");
}

self.onmessage = async (event: MessageEvent<Job>) => {
	const job = event.data;
	const { id, file, members, view } = job;
	try {
		const gz = createGzip(GZIP_OPTIONS);
		const chunks: Buffer[] = [];
		gz.on("data", (chunk: Buffer) => chunks.push(chunk));
		const compressed = new Promise<void>((resolve, reject) => {
			gz.on("end", resolve);
			gz.on("error", reject);
		});
		/** Write a piece of the document, waiting for the gzip stream to take it when it cannot take it right away. */
		const write = async (piece: string): Promise<void> => {
			if (!gz.write(piece)) await new Promise<void>((resolve) => gz.once("drain", resolve));
		};
		// A window of the history is made from the indexes this worker keeps, not from the files read whole (see `history.ts`).
		if (view) for (const piece of answerView(file, members, view)) await write(piece);
		else await writeLineage(job, write);
		gz.end();
		await compressed;
		let size = 0;
		for (const chunk of chunks) size += chunk.length;
		const body = new Uint8Array(size);
		let at = 0;
		for (const chunk of chunks) {
			body.set(chunk, at);
			at += chunk.length;
		}
		// Hand over a buffer of its own, not a view into a larger one, so it moves without a copy.
		const bytes = body.buffer as ArrayBuffer;
		self.postMessage({ id, gz: bytes } satisfies Reply, { transfer: [bytes] });
	} catch (e) {
		const error = e instanceof Error ? e.message : String(e);
		self.postMessage({ id, error, ...(e instanceof ViewError ? { code: e.code } : {}) } satisfies Reply);
	} finally {
		// The reply is on its way and this thread has nothing to do until the next job. The file's text (tens of MB for a
		// long conversation) is garbage now, in the old generation, which JavaScriptCore collects when its own heuristics say
		// so: some seconds on, through whatever the server opens next (the benchmark's stream conversation, opened right after
		// its long one, peaked about 14 MB higher for it). Collected from a timer, not here: this frame is still on the stack,
		// and a collection from it does not free the text (it is held one turn of the event loop longer).
		setTimeout(() => Bun.gc(true), 0);
	}
};
