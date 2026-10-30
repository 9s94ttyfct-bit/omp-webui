import { createHash, randomBytes } from "node:crypto";
import { type Socket, connect as tcp } from "node:net";
import { networkInterfaces } from "node:os";

/**
 * A client that is not on the loopback: the requests and the socket of a page on another machine of the network,
 * made from this one. The server sees what it would see from there, the address the connection is from (`requestIP`):
 * this computer's own network address instead of 127.0.0.1. Nothing listens on that address; the connection is made
 * to the server's own, from the network address (`localAddress`), which a socket can choose and a request cannot say.
 *
 * What a request says (its Host, its Origin, a `X-Forwarded-For`) is the test's to choose, and is sent as given: a
 * client on the network says whatever it likes.
 */

/** An IPv4 address of this computer on a network (not 127.x), or undefined when it has none (no network at all). */
export function lanAddress(): string | undefined {
	const found: string[] = [];
	for (const addresses of Object.values(networkInterfaces()))
		for (const a of addresses ?? []) if (a.family === "IPv4" && !a.internal) found.push(a.address);
	// A link-local address (169.254.x.x) is a network's too, but another is the better stand-in for a LAN.
	return found.find((a) => !a.startsWith("169.254.")) ?? found[0];
}

/** Where a connection goes, and the address it is made from (none: the system's choice for that destination). */
export interface Path {
	host: string;
	port: number;
	from?: string;
}

const NO_BODY = new Set([101, 204, 205, 304]);

/** The body of a chunked answer, put together. */
function unchunk(raw: Buffer): Buffer {
	const parts: Buffer[] = [];
	let at = 0;
	for (;;) {
		const eol = raw.indexOf("\r\n", at);
		if (eol < 0) break;
		const size = Number.parseInt(raw.subarray(at, eol).toString("latin1").split(";")[0] ?? "", 16);
		if (!Number.isFinite(size) || size === 0) break;
		parts.push(raw.subarray(eol + 2, eol + 2 + size));
		at = eol + 2 + size + 2;
	}
	return Buffer.concat(parts);
}

/** Parse the head of an HTTP answer: its status, and its headers (a repeated one stays repeated). */
function parseHead(head: string): { status: number; headers: Headers } {
	const [line = "", ...fields] = head.split("\r\n");
	const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(line)?.[1]);
	if (!Number.isInteger(status)) throw new Error(`not an HTTP answer: ${line}`);
	const headers = new Headers();
	for (const field of fields) {
		const colon = field.indexOf(":");
		if (colon > 0) headers.append(field.slice(0, colon).trim(), field.slice(colon + 1).trim());
	}
	return { status, headers };
}

const connectionOf = (r: Path): Socket =>
	tcp({ host: r.host, port: r.port, ...(r.from ? { localAddress: r.from } : {}) });

export interface RawRequest extends Path {
	method?: string;
	path: string;
	/** Sent as given, Host included (the default Host is the one the connection goes to). */
	headers?: Record<string, string>;
	body?: string;
}

/** One request over one connection, answered as a `Response` (the server is asked to close it after the answer). */
export function rawRequest(r: RawRequest): Promise<Response> {
	const what = `${r.method ?? "GET"} ${r.path}`;
	const headers: Record<string, string> = { host: `${r.host}:${r.port}`, connection: "close" };
	for (const [name, value] of Object.entries(r.headers ?? {})) headers[name.toLowerCase()] = value;
	const body = r.body === undefined ? Buffer.alloc(0) : Buffer.from(r.body);
	if (r.body !== undefined) headers["content-length"] = String(body.length);
	const head = [`${r.method ?? "GET"} ${r.path} HTTP/1.1`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
	const { promise, resolve, reject } = Promise.withResolvers<Response>();
	const chunks: Buffer[] = [];
	const socket = connectionOf(r);
	socket.setTimeout(15_000, () => socket.destroy(new Error(`${what}: no answer`)));
	socket.on("connect", () => socket.write(Buffer.concat([Buffer.from(`${head.join("\r\n")}\r\n\r\n`), body])));
	socket.on("data", (c: Buffer) => chunks.push(c));
	socket.on("error", reject);
	socket.on("close", () => {
		try {
			const raw = Buffer.concat(chunks);
			const end = raw.indexOf("\r\n\r\n");
			if (end < 0) throw new Error(`${what}: the connection ended before an answer`);
			const { status, headers: answered } = parseHead(raw.subarray(0, end).toString("latin1"));
			const rest = raw.subarray(end + 4);
			const bytes = answered.get("transfer-encoding")?.includes("chunked") ? unchunk(rest) : rest;
			resolve(new Response(NO_BODY.has(status) ? null : new Uint8Array(bytes), { status, headers: answered }));
		} catch (e) {
			reject(e);
		}
	});
	return promise;
}

/** The part of the `WebSocket` interface the specs' helpers (`request`, `watchFrames`, `messageWhere`) use. */
export interface NetSocket {
	readonly readyState: number;
	send(data: string): void;
	close(): void;
	addEventListener(type: "message" | "close" | "error", listener: (ev: never) => void): void;
	removeEventListener(type: "message" | "close" | "error", listener: (ev: never) => void): void;
	/** What the server sent, in order (text frames). */
	readonly received: string[];
}

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** A frame of the WebSocket protocol from a client: always masked. */
function frame(opcode: number, payload: Buffer): Buffer {
	const mask = randomBytes(4);
	const n = payload.length;
	let head: Buffer;
	if (n < 126) head = Buffer.from([0x80 | opcode, 0x80 | n]);
	else if (n < 65536) head = Buffer.from([0x80 | opcode, 0x80 | 126, n >> 8, n & 0xff]);
	else {
		head = Buffer.alloc(10);
		head[0] = 0x80 | opcode;
		head[1] = 0x80 | 127;
		head.writeBigUInt64BE(BigInt(n), 2);
	}
	const masked = Buffer.from(payload);
	for (let i = 0; i < n; i++) masked[i] = (masked[i] ?? 0) ^ (mask[i % 4] ?? 0);
	return Buffer.concat([head, mask, masked]);
}

/**
 * A WebSocket opened as a page on the network opens it (`/ws` with the headers given: the token cookie, an Origin, …);
 * null when the server does not upgrade the request. Whatever the server sends is kept in `received`, and handed to
 * the `message` listeners as `{ data }`, as a browser's socket does.
 */
export function rawSocket(r: Path & { path?: string; headers?: Record<string, string> }): Promise<NetSocket | null> {
	const key = randomBytes(16).toString("base64");
	const headers: Record<string, string> = {
		host: `${r.host}:${r.port}`,
		upgrade: "websocket",
		connection: "Upgrade",
		"sec-websocket-key": key,
		"sec-websocket-version": "13",
	};
	for (const [name, value] of Object.entries(r.headers ?? {})) headers[name.toLowerCase()] = value;
	const lines = [`GET ${r.path ?? "/ws"} HTTP/1.1`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
	const { promise, resolve, reject } = Promise.withResolvers<NetSocket | null>();
	const socket = connectionOf(r);
	const listeners = {
		message: new Set<(ev: never) => void>(),
		close: new Set<(ev: never) => void>(),
		error: new Set<(ev: never) => void>(),
	};
	const received: string[] = [];
	let readyState = 0;
	let buffer = Buffer.alloc(0);
	let fragments: Buffer[] = [];
	let upgraded = false;
	const emit = (type: keyof typeof listeners, ev: unknown) => {
		for (const l of [...listeners[type]]) l(ev as never);
	};
	const api: NetSocket = {
		get readyState() {
			return readyState;
		},
		received,
		send(data) {
			socket.write(frame(0x1, Buffer.from(data)));
		},
		close() {
			readyState = 2;
			socket.destroy();
		},
		addEventListener: (type, listener) => void listeners[type].add(listener),
		removeEventListener: (type, listener) => void listeners[type].delete(listener),
	};
	const frames = () => {
		for (;;) {
			if (buffer.length < 2) return;
			const opcode = (buffer[0] ?? 0) & 0x0f;
			const fin = ((buffer[0] ?? 0) & 0x80) !== 0;
			let len = (buffer[1] ?? 0) & 0x7f;
			let at = 2;
			if (len === 126) {
				if (buffer.length < 4) return;
				len = buffer.readUInt16BE(2);
				at = 4;
			} else if (len === 127) {
				if (buffer.length < 10) return;
				len = Number(buffer.readBigUInt64BE(2));
				at = 10;
			}
			if (buffer.length < at + len) return;
			const payload = buffer.subarray(at, at + len);
			buffer = buffer.subarray(at + len);
			if (opcode === 0x8) return void socket.end();
			if (opcode === 0x9) {
				socket.write(frame(0xa, payload));
				continue;
			}
			if (opcode === 0xa) continue;
			fragments.push(payload);
			if (!fin) continue;
			const text = Buffer.concat(fragments).toString("utf8");
			fragments = [];
			received.push(text);
			emit("message", { data: text });
		}
	};
	socket.setTimeout(15_000, () => socket.destroy(new Error("the socket got no answer")));
	socket.on("connect", () => socket.write(`${lines.join("\r\n")}\r\n\r\n`));
	socket.on("error", (e) => (upgraded ? emit("error", e) : reject(e)));
	socket.on("close", () => {
		readyState = 3;
		if (!upgraded) resolve(null);
		emit("close", {});
	});
	socket.on("data", (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk]);
		if (!upgraded) {
			const end = buffer.indexOf("\r\n\r\n");
			if (end < 0) return;
			const { status, headers: answered } = parseHead(buffer.subarray(0, end).toString("latin1"));
			buffer = buffer.subarray(end + 4);
			const accept = createHash("sha1")
				.update(key + GUID)
				.digest("base64");
			if (status !== 101 || answered.get("sec-websocket-accept") !== accept) {
				socket.destroy();
				return resolve(null);
			}
			upgraded = true;
			readyState = 1;
			// A quiet socket is a healthy one: nothing is waited for with a timer from here on.
			socket.setTimeout(0);
			resolve(api);
		}
		frames();
	});
	return promise;
}
