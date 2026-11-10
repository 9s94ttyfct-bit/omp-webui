import { constants } from "node:fs";
import { type FileHandle, mkdir, open, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import {
	COPY_HEADERS,
	type CopyDone,
	type CopyKind,
	isRemoteCopyCode,
	REMOTE_COPY_MAX_BYTES,
	REMOTE_COPY_MAX_ENTRIES,
	REMOTE_COPY_PIECE,
	REMOTE_COPY_ROUTE,
	REMOTE_COPY_TIMEOUT_MS,
	RemoteCopyError,
	type RemoteCopyResult,
} from "../../shared/remote-copy.ts";
import { DEFAULT_LIMITS } from "../transfer-core.ts";
import { RemoteNotSignedIn, RemoteTooOld, signIn } from "./client.ts";
import {
	applyTop,
	checkTarget,
	discard,
	ensureRoom,
	makeParent,
	type Places,
	publish,
	type Reserve,
	type SpaceOf,
	stagedBeside,
	unmake,
} from "./copy-place.ts";
import { fsFailure, packTar, TarUnpacker, tarSize, walkFolder } from "./tar.ts";

/**
 * This computer's side of `remote_copy` (`shared/remote-copy.ts`): a file or a folder copied to or from another computer
 * through its own routes, signed in as `remote_run` is (`signIn`: the Access token the macOS app handed over, and the remote
 * app's cookie). Loaded by the first copy: a server that never copies holds none of it.
 *
 *  - `from`: the local target is checked first (`copy-place.ts`: never the home folder or the app's data, nothing replaced
 *    unasked), then the remote file or folder is read in one `GET` and written beside the target as it comes (a folder
 *    unpacked as it comes, under the rules of `TarUnpacker`), and moved into place once whole.
 *  - `to`: the local file is sent as it is, a folder as the tar of its walk (`walkFolder`, `packTar`), in pieces of
 *    `REMOTE_COPY_PIECE.bytes`; the remote computer checks its target before the first piece and puts it in place after the
 *    last one. A copy that fails or is cancelled is given up there (`DELETE`), and leaves nothing at either target.
 *
 * The whole call is held to `REMOTE_COPY_TIMEOUT_MS`, and ends with its `signal`: the request under way is aborted with it.
 */

export interface RemoteCopyOptions {
	/** The computer's host (`omp.example.com`). */
	host: string;
	/** Its Access token. */
	jwt: string;
	direction: "to" | "from";
	/** The path on this computer, absolute. */
	local: string;
	/** The path on that computer, as the call gave it (that computer resolves it). */
	remote: string;
	overwrite: boolean;
	/** This computer's home folder and the folders omp-webui keeps its data in. */
	places: Places;
	signal: AbortSignal;
	/** What a write here leaves free on the disk (`DEFAULT_LIMITS` unless told). */
	reserve?: Partial<Reserve>;
	spaceOf?: SpaceOf;
	/** Where the computer's page is, when it is not `https://<host>` (tests: a local stand-in). */
	origin?: string;
	/** Smaller pieces (tests). */
	pieceBytes?: number;
}

const LIMITS = { maxBytes: REMOTE_COPY_MAX_BYTES, maxEntries: REMOTE_COPY_MAX_ENTRIES };

/** Why the computer refused a request, as the error a call is told; a route it does not have is `RemoteTooOld`. */
async function refusal(res: Response, origin: string): Promise<Error> {
	const body: unknown = await res.json().catch(() => null);
	const code = isRecord(body) ? body.code : undefined;
	if (isRemoteCopyCode(code))
		return new RemoteCopyError(isRecord(body) && typeof body.error === "string" ? body.error : code, code, true);
	if (res.status === 404) return new RemoteTooOld(`${origin} has no ${REMOTE_COPY_ROUTE}`);
	if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400))
		return new RemoteNotSignedIn(`${origin} answered ${res.status}`);
	const said = isRecord(body) && typeof body.error === "string" ? `: ${body.error}` : "";
	return new Error(`${origin} answered ${res.status}${said}`);
}

/** Copy as `o` says; throws `RemoteNotSignedIn`, `RemoteUnsupported`, `RemoteTooOld`, `RemoteCopyError`, or what the connection met. */
export async function copyRemote(o: RemoteCopyOptions): Promise<RemoteCopyResult> {
	const started = Date.now();
	const origin = o.origin ?? `https://${o.host}`;
	const signal = AbortSignal.any([o.signal, AbortSignal.timeout(REMOTE_COPY_TIMEOUT_MS)]);
	const cookie = await signIn(origin, o.jwt, signal);
	const ask = async (path: string, init: RequestInit = {}): Promise<Response> => {
		const res = await fetch(`${origin}${path}`, {
			...init,
			headers: { cookie, origin, "x-omp-webui": "1" },
			redirect: "manual",
			signal,
		});
		if (!res.ok) throw await refusal(res, origin);
		return res;
	};
	const r = o.direction === "from" ? await download(o, ask) : await upload(o, ask, origin, cookie);
	return { ...r, ms: Date.now() - started };
}

type Ask = (path: string, init?: RequestInit) => Promise<Response>;

async function download(o: RemoteCopyOptions, ask: Ask): Promise<Omit<RemoteCopyResult, "ms">> {
	const target = o.local;
	await checkTarget(target, o.overwrite, o.places);
	const res = await ask(`${REMOTE_COPY_ROUTE}?path=${encodeURIComponent(o.remote)}`);
	const kind = res.headers.get(COPY_HEADERS.kind);
	const bytes = Number(res.headers.get(COPY_HEADERS.bytes));
	const files = Number(res.headers.get(COPY_HEADERS.files));
	const leftOut = Number(res.headers.get(COPY_HEADERS.leftOut) ?? 0);
	const from = decodeURIComponent(res.headers.get(COPY_HEADERS.path) ?? encodeURIComponent(o.remote));
	const modeText = res.headers.get(COPY_HEADERS.mode) ?? "";
	const mtimeText = res.headers.get(COPY_HEADERS.mtime) ?? "";
	if ((kind !== "file" && kind !== "folder") || !Number.isSafeInteger(bytes) || !Number.isSafeInteger(files)) {
		await res.body?.cancel();
		throw new Error("The other computer's answer is not a copy");
	}
	if (bytes > REMOTE_COPY_MAX_BYTES) {
		await res.body?.cancel();
		throw new RemoteCopyError(`${from} holds more than ${REMOTE_COPY_MAX_BYTES} bytes`, "tooLarge");
	}
	const staged = stagedBeside(target);
	let handle: FileHandle | null = null;
	let unpacker: TarUnpacker | null = null;
	let made: string | undefined;
	try {
		// Room for what the other computer says it sends, before a folder is made; what it sends is then held to what it said
		// (a file to its bytes, a folder's files to theirs), so a computer that says less cannot write past the room kept free.
		await ensureRoom(dirname(target), bytes, { ...DEFAULT_LIMITS, ...o.reserve }, o.spaceOf);
		made = await makeParent(target);
		let got = 0;
		if (kind === "file") {
			const h = await open(
				staged,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				0o600,
			);
			handle = h;
			for await (const chunk of res.body ?? []) {
				got += chunk.length;
				if (got > bytes) throw new RemoteCopyError(`${from} grew while it was copied: try again`, "changed");
				let done = 0;
				while (done < chunk.length) done += (await h.write(chunk, done, chunk.length - done)).bytesWritten;
			}
			handle = null;
			await h.close();
			if (got !== bytes) throw new RemoteCopyError(`${from} changed while it was copied: try again`, "changed");
		} else {
			await mkdir(staged);
			const u = new TarUnpacker(staged, { ...LIMITS, maxBytes: bytes });
			unpacker = u;
			for await (const chunk of res.body ?? []) await u.write(chunk);
			await u.end();
			unpacker = null;
		}
		await applyTop(
			staged,
			/^[0-7]{1,6}$/.test(modeText) ? Number.parseInt(modeText, 8) : null,
			/^\d{1,16}$/.test(mtimeText) ? Number(mtimeText) : null,
			kind === "folder",
		);
		const replaced = await publish(staged, target, o.overwrite);
		return { kind, files, bytes, leftOut, replaced, from, to: target };
	} catch (e) {
		await res.body?.cancel().catch(() => {});
		await handle?.close().catch(() => {});
		await unpacker?.close();
		await discard(staged);
		await unmake(target, made);
		if (
			e instanceof RemoteCopyError &&
			e.code === "tooLarge" &&
			unpacker &&
			e.message.endsWith("bytes of files to copy")
		)
			throw new RemoteCopyError(
				`${from} sent more than the ${bytes} bytes of files it said it holds`,
				"tooLarge",
				true,
			);
		throw fsFailure(e, target);
	}
}

async function upload(
	o: RemoteCopyOptions,
	ask: Ask,
	origin: string,
	cookie: string,
): Promise<Omit<RemoteCopyResult, "ms">> {
	const source = o.local;
	const st = await stat(source).catch((e) => {
		const code = (e as NodeJS.ErrnoException).code;
		throw code === "ENOENT" || code === "ENOTDIR"
			? new RemoteCopyError(`Nothing is at ${source} on this computer`, "notFound")
			: fsFailure(e, source);
	});
	let kind: CopyKind;
	let size: number;
	let bytes: number;
	let leftOut = 0;
	let pieces: () => AsyncGenerator<Uint8Array<ArrayBuffer>>;
	const pieceBytes = o.pieceBytes ?? REMOTE_COPY_PIECE.bytes;
	if (st.isFile()) {
		if (st.size > REMOTE_COPY_MAX_BYTES)
			throw new RemoteCopyError(`${source} is larger than ${REMOTE_COPY_MAX_BYTES} bytes`, "tooLarge");
		kind = "file";
		size = bytes = st.size;
		pieces = () => filePieces(source, size, pieceBytes);
	} else if (st.isDirectory()) {
		const walked = await walkFolder(source, LIMITS);
		kind = "folder";
		size = tarSize(walked.entries);
		({ bytes, leftOut } = walked);
		pieces = () => streamPieces(packTar(source, walked.entries), pieceBytes);
	} else throw new RemoteCopyError(`${source} is not a file or a folder`, "notFound");
	const q = new URLSearchParams({
		path: o.remote,
		kind,
		size: String(size),
		bytes: String(bytes),
		overwrite: o.overwrite ? "1" : "0",
		mode: (st.mode & 0o777).toString(8),
		mtime: String(Math.floor(st.mtimeMs / 1000)),
	});
	const begun: unknown = await (await ask(`${REMOTE_COPY_ROUTE}?${q}`, { method: "POST" })).json();
	if (!isRecord(begun) || typeof begun.id !== "string" || !/^[0-9a-f]{32}$/.test(begun.id))
		throw new Error("The other computer's answer is not a copy");
	const at = `${REMOTE_COPY_ROUTE}/${begun.id}`;
	try {
		let offset = 0;
		for await (const piece of pieces()) {
			await (await ask(`${at}?offset=${offset}`, { method: "PUT", body: piece })).body?.cancel();
			offset += piece.length;
		}
		if (offset !== size) throw new RemoteCopyError(`${source} changed while it was copied: try again`, "changed");
		const done: unknown = await (await ask(at, { method: "POST" })).json();
		if (!isRecord(done) || typeof done.path !== "string") throw new Error("The other computer's answer is not a copy");
		const d = done as unknown as CopyDone;
		return { kind, files: d.files, bytes: d.bytes, leftOut, replaced: d.replaced === true, from: source, to: d.path };
	} catch (e) {
		// Given up there too, with a signal of its own: the call's may be what ended it.
		await fetch(`${origin}${at}`, {
			method: "DELETE",
			headers: { cookie, origin, "x-omp-webui": "1" },
			redirect: "manual",
			signal: AbortSignal.timeout(10_000),
		})
			.then((r) => r.body?.cancel())
			.catch(() => {});
		throw e;
	}
}

/** A file in pieces of `pieceBytes`, each read whole; one that is shorter than it was is `changed`. */
async function* filePieces(path: string, size: number, pieceBytes: number): AsyncGenerator<Uint8Array<ArrayBuffer>> {
	for (let offset = 0; offset < size; offset += pieceBytes) {
		const end = Math.min(size, offset + pieceBytes);
		const piece = new Uint8Array(await Bun.file(path).slice(offset, end).arrayBuffer());
		if (piece.length !== end - offset)
			throw new RemoteCopyError(`${path} changed while it was copied: try again`, "changed");
		yield piece;
	}
}

/** A stream in pieces of `pieceBytes` (the last one shorter). */
async function* streamPieces(
	stream: ReadableStream<Uint8Array>,
	pieceBytes: number,
): AsyncGenerator<Uint8Array<ArrayBuffer>> {
	const reader = stream.getReader();
	let buf = new Uint8Array(pieceBytes);
	let len = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			let at = 0;
			while (at < value.length) {
				const n = Math.min(pieceBytes - len, value.length - at);
				buf.set(value.subarray(at, at + n), len);
				len += n;
				at += n;
				if (len === pieceBytes) {
					yield buf;
					buf = new Uint8Array(pieceBytes);
					len = 0;
				}
			}
		}
		if (len > 0) yield buf.subarray(0, len);
	} finally {
		await reader.cancel().catch(() => {});
	}
}
