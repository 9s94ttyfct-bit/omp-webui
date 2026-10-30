import type { FileHandle } from "node:fs/promises";
import { holdsPrivateKey, type OpenHooks, openRegular } from "./folder.ts";
import {
	busy,
	conversationRoot,
	etagOf,
	type Gate,
	holdsHome,
	type Limits,
	record,
	requireDownload,
	resolveDownload,
	type Trace,
	type TransferContext,
	type TransferEnv,
	TransferError,
	viaFolder,
} from "./transfer-core.ts";
import type { TransferLog } from "./transfer-log.ts";

/**
 * `GET|HEAD /api/folder/download?live&file&path`: a file of the conversation's folder, as an attachment. What it promises:
 * the path is resolved against the real folder and opened without following a link (`openRegular`), the bytes sent are
 * those of the file that was opened (the answer is built on that handle, not on a second open by path), a name that looks
 * like a secret, a private key in the text of a file and a protected place are not sent to a page that is not on this
 * computer, the answer is never a page (`attachment`, `application/octet-stream`, `nosniff`, `sandbox`), and it is
 * a stream: nothing is held in memory but one chunk, however big the file. A `Range` is answered, so that a download that broke
 * goes on where it stopped; and an answer ends when the Access session of the page does (a socket does too, #548).
 */

/** The part of a `Range` header this answers: one range of bytes. */
export type ByteRange = { start: number; end: number };

/**
 * What `Range` asks for of a file of `size` bytes: its bytes `a-b`, `a-` (to the end) or `-n` (the last `n`). `all` when
 * there is no range, more than one (answered whole, as the specification allows) or one that is no range at all; `unsatisfiable`
 * when it begins after the end.
 */
export function parseRange(header: string | null, size: number): ByteRange | "all" | "unsatisfiable" {
	if (header === null) return "all";
	const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!m || (m[1] === "" && m[2] === "")) return "all";
	const first = m[1] ?? "";
	const last = m[2] ?? "";
	if (first === "") {
		const n = Number(last);
		if (!Number.isSafeInteger(n) || n === 0 || size === 0) return "unsatisfiable";
		return { start: Math.max(0, size - n), end: size - 1 };
	}
	const start = Number(first);
	if (!Number.isSafeInteger(start) || start >= size) return "unsatisfiable";
	const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
	if (!Number.isSafeInteger(end) || end < start) return "all";
	return { start, end };
}

/** Whether an `If-Range` header (an etag, or the date the file was last modified) still names the file that is there. */
export function ifRangeHolds(header: string | null, etag: string, mtimeMs: number): boolean {
	if (header === null) return true;
	const value = header.trim();
	if (value.startsWith('"') || value.startsWith("W/")) return value === `"${etag}"`;
	const at = Date.parse(value);
	return Number.isFinite(at) && at === Math.floor(mtimeMs / 1000) * 1000;
}

/** Characters that do not show or that turn text around: out of a file name that is sent. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is replaced.
const NOT_IN_A_NAME = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff/\\]/g;

/** `Content-Disposition` for a download named `name`: an ASCII name for old programs, and the real one (RFC 5987) for the rest. */
export function contentDisposition(name: string): string {
	const clean = name.replace(NOT_IN_A_NAME, "_").trim() || "file";
	const ascii = clean.replace(/[^\x20-\x7e]|["\\%]/g, "_");
	const encoded = encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** The headers every answer that carries a file's bytes has: it is saved, never shown. */
export function attachmentHeaders(name: string): Record<string, string> {
	return {
		"content-type": "application/octet-stream",
		"content-disposition": contentDisposition(name),
		"x-content-type-options": "nosniff",
		"content-security-policy": "sandbox",
		"cache-control": "no-store",
		"accept-ranges": "bytes",
	};
}

interface Stream {
	handle: FileHandle;
	start: number;
	length: number;
	chunk: number;
	validUntil: number | undefined;
	/** The time, in ms (tests move it). */
	now: () => number;
	/** Called once, when the stream ends: how, and how many bytes were sent. */
	ended: (status: string, sent: number) => void;
	release: () => void;
}

/** The bytes `start`… of an open file as a stream, read as the client takes them, and ended at `validUntil`. */
function streamOf(s: Stream): ReadableStream<Uint8Array> {
	let position = s.start;
	let left = s.length;
	let sent = 0;
	let over = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const finish = async (status: string): Promise<void> => {
		if (over) return;
		over = true;
		clearTimeout(timer);
		await s.handle.close().catch(() => {});
		s.release();
		s.ended(status, sent);
	};
	return new ReadableStream<Uint8Array>(
		{
			start(controller) {
				if (s.validUntil === undefined) return;
				timer = setTimeout(
					() => {
						controller.error(new Error("The Access session ended"));
						void finish("expired");
					},
					Math.max(0, s.validUntil - s.now()),
				);
				timer.unref();
			},
			async pull(controller) {
				if (over) return;
				if (s.validUntil !== undefined && s.now() >= s.validUntil) {
					controller.error(new Error("The Access session ended"));
					return finish("expired");
				}
				const want = Math.min(s.chunk, left);
				const buffer = Buffer.allocUnsafe(want);
				let n: number;
				try {
					n = (await s.handle.read(buffer, 0, want, position)).bytesRead;
				} catch (e) {
					if (!over) controller.error(e);
					return finish("failed");
				}
				if (over) return;
				if (n === 0) {
					// The file got shorter while it was sent: what was promised cannot be kept, and nothing is made up.
					controller.error(new Error("The file got shorter while it was sent"));
					return finish("failed");
				}
				position += n;
				left -= n;
				sent += n;
				controller.enqueue(n === want ? buffer : buffer.subarray(0, n));
				if (left === 0) {
					await finish("ok");
					controller.close();
				}
			},
			cancel() {
				return finish("aborted");
			},
		},
		new CountQueuingStrategy({ highWaterMark: 2 }),
	);
}

export interface DownloadDeps {
	log: TransferLog;
	gate: Gate;
	limits: Limits;
	now: () => number;
	hooks?: OpenHooks;
}

/** The download the request asks for (`HEAD` asks the same questions and gets the headers). */
export async function download(
	req: Request,
	url: URL,
	ctx: TransferContext,
	env: TransferEnv,
	trace: Trace,
	deps: DownloadDeps,
): Promise<Response> {
	const head = req.method === "HEAD";
	const q = url.searchParams;
	// What was asked for is written down even when the setting says no (a refusal is in the log with who asked and for what).
	trace.path = (q.get("path") ?? "").slice(0, 4096);
	requireDownload(env);
	const root = await conversationRoot(ctx, q.get("live"), q.get("file"));
	trace.root = root;
	const home = holdsHome(root, env);
	const file = await resolveDownload(root, q.get("path") ?? "", env, home);
	const { handle } = await viaFolder(() => openRegular(file.abs, deps.hooks));
	let answered = false;
	try {
		const info = await handle.stat({ bigint: true });
		const size = Number(info.size);
		const mtimeMs = Number(info.mtimeMs);
		// A page that is not this computer's is not sent a private key, whatever the file is called (as the Files tab shows none).
		if (!env.local && size > 0) {
			const sample = Buffer.alloc(Math.min(size, 1024 * 1024));
			const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
			if (holdsPrivateKey(sample.subarray(0, bytesRead).toString("utf8")))
				throw new TransferError(
					"This looks like a secret: it is not sent to a page that is not on this computer",
					403,
					"secret",
				);
		}
		const etag = etagOf(info);
		const range = parseRange(req.headers.get("range"), size);
		const current = ifRangeHolds(req.headers.get("if-range"), etag, mtimeMs);
		if (range === "unsatisfiable" && current) {
			throw new TransferError(
				"That part of the file is not there",
				416,
				"badRequest",
				{},
				{ "content-range": `bytes */${size}` },
			);
		}
		// A range is answered only for the file the page saw (`If-Range`); for another one the whole file is.
		const asked: ByteRange | null = typeof range === "object" && current ? range : null;
		const partial = asked !== null;
		const part: ByteRange = asked ?? { start: 0, end: size - 1 };
		const length = size === 0 ? 0 : part.end - part.start + 1;
		const headers: Record<string, string> = {
			...attachmentHeaders(file.rel.slice(file.rel.lastIndexOf("/") + 1)),
			etag: `"${etag}"`,
			"last-modified": new Date(Math.floor(mtimeMs / 1000) * 1000).toUTCString(),
			// Sent when the size is known. A body that is streamed in pieces goes out chunked, and Bun then leaves this out (a
			// length and chunks never go together): a client takes the size of a GET from the end of its body, and from the
			// answer to a HEAD, the listing or `content-range` before it.
			"content-length": String(length),
		};
		if (partial) headers["content-range"] = `bytes ${part.start}-${part.end}/${size}`;
		const status = partial ? 206 : 200;
		if (head || length === 0) {
			if (!head) record(deps.log, env, trace, "ok", { size: 0 });
			return new Response(null, { status, headers });
		}
		const release = deps.gate.take(env.who);
		if (!release) throw busy();
		answered = true;
		return new Response(
			streamOf({
				handle,
				start: part.start,
				length,
				chunk: deps.limits.chunkBytes,
				validUntil: env.validUntil,
				now: deps.now,
				release,
				ended: (how, sent) => record(deps.log, env, trace, how, { size: sent }),
			}),
			{ status, headers },
		);
	} finally {
		// The stream closes the file once it is sent; any other way out closes it here.
		if (!answered) await handle.close().catch(() => {});
	}
}
