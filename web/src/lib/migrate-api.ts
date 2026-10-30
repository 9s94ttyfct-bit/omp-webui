import {
	type ExportRequest,
	type ExportStatus,
	type ImportRequest,
	type ImportStatus,
	MIGRATE_API,
	MIGRATE_CHUNK_BYTES,
	type MigratePlan,
	type MigrateState,
} from "@shared/migrate.ts";
import { ApiError } from "./api.ts";

const POST = { "x-omp-webui": "1" };
const JSON_POST = { "content-type": "application/json", ...POST };

/** What the card says when the app does not answer at all: no status, no code, so the card words it itself. */
export function isNetworkError(e: unknown): boolean {
	return e instanceof ApiError && e.status === 0 && e.code === undefined;
}

interface ErrorBody {
	error?: string;
	code?: string;
	params?: Record<string, string | number>;
}

function refused(status: number, body: ErrorBody): ApiError {
	return new ApiError(body.error ?? `HTTP ${status}`, status, body.code, body.params);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	let res: Response;
	try {
		res = await fetch(path, init);
	} catch {
		throw new ApiError("Could not reach the app", 0);
	}
	const body = await res.json().catch(() => ({}));
	if (!res.ok) throw refused(res.status, body);
	return body as T;
}

const post = <T>(path: string, body?: unknown) =>
	request<T>(path, {
		method: "POST",
		headers: body === undefined ? POST : JSON_POST,
		body: body === undefined ? undefined : JSON.stringify(body),
	});

/** One piece of the archive, sent with XMLHttpRequest because `fetch` cannot say how much of a request body has gone. */
function sendPiece(
	offset: number,
	piece: Blob,
	onSent: (bytes: number) => void,
	signal: AbortSignal,
): Promise<ImportStatus> {
	const { promise, resolve, reject } = Promise.withResolvers<ImportStatus>();
	const xhr = new XMLHttpRequest();
	xhr.open("POST", `${MIGRATE_API.importChunk}?offset=${offset}`);
	xhr.setRequestHeader("x-omp-webui", "1");
	xhr.setRequestHeader("content-type", "application/octet-stream");
	xhr.upload.onprogress = (e) => onSent(e.loaded);
	xhr.onerror = () => reject(new ApiError("Could not reach the app", 0));
	xhr.onabort = () => reject(new DOMException("Aborted", "AbortError"));
	xhr.onload = () => {
		let body: ImportStatus & ErrorBody;
		try {
			body = JSON.parse(xhr.responseText);
		} catch {
			body = {} as typeof body;
		}
		if (xhr.status >= 200 && xhr.status < 300) resolve(body);
		else reject(refused(xhr.status, body));
	};
	if (signal.aborted) reject(new DOMException("Aborted", "AbortError"));
	else {
		signal.addEventListener("abort", () => xhr.abort(), { once: true });
		xhr.send(piece);
	}
	return promise;
}

/** The routes of `shared/migrate.ts`'s `MIGRATE_API`, as the card calls them. */
export const migrateApi = {
	plan: () => request<MigratePlan>(MIGRATE_API.plan),
	state: () => request<MigrateState>(MIGRATE_API.state),
	startExport: (req: ExportRequest) => post<ExportStatus>(MIGRATE_API.export, req),
	cancelExport: () => post<unknown>(MIGRATE_API.exportCancel),
	discardExport: () => post<unknown>(MIGRATE_API.exportDiscard),
	beginImport: (file: { name: string; size: number }) => post<ImportStatus>(MIGRATE_API.importBegin, file),
	verifyImport: () => post<ImportStatus>(MIGRATE_API.importVerify),
	unlockImport: (password: string) => post<ImportStatus>(MIGRATE_API.importUnlock, { password }),
	applyImport: (req: ImportRequest) => post<ImportStatus>(MIGRATE_API.importApply, req),
	restoreImport: () => post<ImportStatus>(MIGRATE_API.importRestore),
	discardImport: () => post<unknown>(MIGRATE_API.importDiscard),

	/**
	 * Send `file` in pieces of `MIGRATE_CHUNK_BYTES`, each at the offset it goes to. `onSent` is told how many bytes of the
	 * file have gone (inside a piece as well, so the bar moves while a piece is on its way); `onStatus` gets each answer.
	 * Rejects with an `AbortError` when `signal` is aborted.
	 */
	async upload(
		file: File,
		onSent: (bytes: number) => void,
		onStatus: (status: ImportStatus) => void,
		signal: AbortSignal,
	): Promise<ImportStatus | null> {
		let last: ImportStatus | null = null;
		for (let offset = 0; offset < file.size; offset += MIGRATE_CHUNK_BYTES) {
			const end = Math.min(offset + MIGRATE_CHUNK_BYTES, file.size);
			last = await sendPiece(offset, file.slice(offset, end), (n) => onSent(offset + n), signal);
			onStatus(last);
			onSent(end);
		}
		return last;
	},
};

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** 1536 → "1.5 KB": a size the way a file manager says it (powers of 1024, one decimal above bytes). */
export function formatBytes(bytes: number): string {
	let n = Math.max(0, bytes);
	let unit = 0;
	while (n >= 1024 && unit < UNITS.length - 1) {
		n /= 1024;
		unit++;
	}
	return `${unit === 0 ? n : Number(n.toFixed(n >= 100 ? 0 : 1))} ${UNITS[unit]}`;
}
