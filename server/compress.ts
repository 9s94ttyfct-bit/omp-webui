import { statSync } from "node:fs";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

/**
 * gzip for static assets (cached per file version) and large JSON responses.
 * Hashed Vite assets are also marked immutable so repeat visits skip the network.
 */

/** Runs on zlib's thread pool: the server's one thread keeps forwarding WebSocket frames while a big answer is compressed. */
const gzipAsync = promisify(gzip);

/**
 * How big an answer is before it is compressed on zlib's thread pool rather than in place.
 *
 * The pool is what keeps a big answer from holding the server's one thread: the export of a conversation of tens of MB
 * used to hold every WebSocket frame for half a second (#422). But the pool is not free. node:zlib's gzip is a slower
 * implementation than Bun's own, and the hand-off to the pool costs on top of that, so the list of conversations — asked
 * for again on every change, 519 070 bytes of JSON on the benchmark library — paid about a quarter more CPU on every
 * request than the compression itself is worth.
 *
 * Below this size the answer is compressed in place, which is where the CPU goes: a megabyte of JSON is a few
 * milliseconds of the server's thread (a megabyte of plain text, the worst case, is about ten), and the WebSocket
 * frames it holds up are frames the reader waits a few milliseconds longer for. Above it the answer goes to the pool,
 * as it did for #422, and the thread is free while it is compressed.
 */
const SYNC_MAX_BYTES = 1024 * 1024;

const MIN_BYTES = 1024;
const COMPRESSIBLE = /\.(js|css|html|svg|json|map|txt)$/;
const staticCache = new Map<string, { mtime: number; body: Uint8Array<ArrayBuffer> }>();

export function acceptsGzip(req: Request): boolean {
	return /\bgzip\b/.test(req.headers.get("accept-encoding") ?? "");
}

export async function serveStatic(req: Request, file: string, immutable: boolean): Promise<Response> {
	const blob = Bun.file(file);
	const headers: Record<string, string> = {
		"content-type": blob.type,
		"cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
	};
	if (!COMPRESSIBLE.test(file) || !acceptsGzip(req) || blob.size < MIN_BYTES) return new Response(blob, { headers });
	const mtime = statSync(file).mtimeMs;
	let cached = staticCache.get(file);
	if (!cached || cached.mtime !== mtime) {
		cached = { mtime, body: Bun.gzipSync(new Uint8Array(await blob.arrayBuffer())) };
		staticCache.set(file, cached);
	}
	return new Response(cached.body, { headers: { ...headers, "content-encoding": "gzip", vary: "accept-encoding" } });
}

/** Compress a finished API response when it is big enough to matter. */
export async function compressResponse(req: Request, res: Response): Promise<Response> {
	if (!acceptsGzip(req) || res.headers.has("content-encoding")) return res;
	const type = res.headers.get("content-type") ?? "";
	if (!type.includes("json") && !type.includes("text")) return res;
	const body = new Uint8Array(await res.arrayBuffer());
	const headers = new Headers(res.headers);
	if (body.byteLength < MIN_BYTES) return new Response(body, { status: res.status, headers });
	headers.set("content-encoding", "gzip");
	headers.set("vary", "accept-encoding");
	headers.delete("content-length");
	// A small answer is compressed here: it is a few milliseconds of the server's thread, and the pool's gzip costs
	// more CPU than it saves in stall. A big one goes to the pool (#422): the server's one thread must keep forwarding
	// the WebSocket frames of every running conversation.
	const gz = body.byteLength <= SYNC_MAX_BYTES ? Bun.gzipSync(body) : await gzipAsync(body);
	return new Response(gz, { status: res.status, headers });
}
