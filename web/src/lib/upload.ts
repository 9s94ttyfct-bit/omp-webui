import type { UploadCode, UploadFailure, UploadResult } from "@shared/upload.ts";

/**
 * Send a file the page holds to the folder a conversation works in (`POST /api/upload`, see `server/upload.ts`), with the
 * progress of the upload. `fetch` reports none, so it is a request of its own kind (`XMLHttpRequest`).
 */

/** The conversation the file goes to: its process, and its saved file when it has one. The server knows the folder. */
export interface UploadScope {
	live: string | null;
	file: string | null;
}

/** A refused or failed upload: the server's code (`failed` when no answer came), its English sentence, the limit passed. */
export class UploadError extends Error {
	constructor(
		message: string,
		readonly code: UploadCode | "failed",
		readonly limit?: number,
	) {
		super(message);
	}
}

const CODES: readonly string[] = [
	"unknownConversation",
	"folderGone",
	"tooLarge",
	"quota",
	"tooMany",
	"ownData",
	"off",
	"refused",
	"stalled",
	"badRequest",
	"write",
] satisfies UploadCode[];

/** The address an upload of `name` is sent to. */
export function uploadUrl(scope: UploadScope, name: string): string {
	const q = new URLSearchParams();
	if (scope.live) q.set("live", scope.live);
	if (scope.file) q.set("file", scope.file);
	q.set("name", name);
	return `/api/upload?${q}`;
}

/** What the server said, read as a failure: its code and sentence, or `failed` for an answer that is none of its own. */
export function failureOf(status: number, body: string): UploadError {
	try {
		const parsed = JSON.parse(body) as Partial<UploadFailure> | null;
		if (parsed && typeof parsed.error === "string") {
			const code = CODES.includes(parsed.code as string) ? (parsed.code as UploadCode) : "failed";
			return new UploadError(parsed.error, code, typeof parsed.limit === "number" ? parsed.limit : undefined);
		}
	} catch {
		// not JSON: a proxy's page, or nothing
	}
	return new UploadError(status ? `HTTP ${status}` : "No answer from the server", "failed");
}

/**
 * Upload `file`, calling `onProgress` with the bytes sent so far. Resolves to where the server put it. `signal` stops it: the
 * server removes what it had received of the file.
 */
export function uploadFile(
	scope: UploadScope,
	file: File,
	onProgress: (sent: number, total: number) => void,
	signal: AbortSignal,
): Promise<UploadResult> {
	const { promise, resolve, reject } = Promise.withResolvers<UploadResult>();
	if (signal.aborted) {
		reject(new DOMException("Upload cancelled", "AbortError"));
		return promise;
	}
	const request = new XMLHttpRequest();
	const stop = () => request.abort();
	const finish = () => signal.removeEventListener("abort", stop);
	request.open("POST", uploadUrl(scope, file.name || "file"));
	request.setRequestHeader("x-omp-webui", "1");
	request.setRequestHeader("content-type", "application/octet-stream");
	request.upload.onprogress = (e) => onProgress(e.loaded, e.lengthComputable ? e.total : file.size);
	request.onload = () => {
		finish();
		if (request.status === 200) {
			try {
				resolve(JSON.parse(request.responseText) as UploadResult);
				return;
			} catch {
				// an answer that is not the server's
			}
		}
		reject(failureOf(request.status, request.responseText));
	};
	request.onerror = () => {
		finish();
		reject(new UploadError("The connection failed", "failed"));
	};
	request.onabort = () => {
		finish();
		reject(new DOMException("Upload cancelled", "AbortError"));
	};
	signal.addEventListener("abort", stop, { once: true });
	request.send(file);
	return promise;
}
