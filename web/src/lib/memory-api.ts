import {
	MEMORY_CONTENT_MAX,
	MEMORY_ERROR_CODES,
	type MemoryChanged,
	type MemoryDeleted,
	type MemoryDetail,
	type MemoryErrorCode,
	type MemoryList,
	type MemoryOverview,
	type MemoryQuery,
	type MemoryScope,
	queryString,
} from "@shared/memory.ts";
import { type MessageKey, t } from "../i18n/index.ts";

/** `/api/memory*`: omp's long-term memory. Every route answers 403 to a page that came through the tunnel. */

/** A refusal of the server, with the code it names (`MemoryErrorCode`) when it is one this page knows. */
export class MemoryApiError extends Error {
	constructor(
		message: string,
		readonly code: MemoryErrorCode | null,
		readonly status: number,
	) {
		super(message);
		this.name = "MemoryApiError";
	}
}

const CODE_TEXT: Record<MemoryErrorCode, MessageKey> = {
	notFound: "memory.errNotFound",
	badRequest: "memory.errBadRequest",
	stale: "memory.errStale",
	busy: "memory.errBusy",
	layout: "memory.errLayout",
	notEditable: "memory.errNotEditable",
	tooLong: "memory.errTooLong",
	noGlobal: "memory.errNoGlobal",
	backup: "memory.errBackup",
	unreadable: "memory.errUnreadable",
	settings: "memory.errSettings",
	secret: "memory.errSecret",
};

/** What went wrong, in the page's language: the text of the code when the server named one, else its own words. */
export function memoryErrorText(e: unknown): string {
	if (e instanceof MemoryApiError && e.code) return t(CODE_TEXT[e.code], { max: MEMORY_CONTENT_MAX });
	return e instanceof Error ? e.message : String(e);
}

/** Whether `e` is the server's answer that the memory changed since it was read. */
export const isStale = (e: unknown): boolean => e instanceof MemoryApiError && e.code === "stale";
export const isGone = (e: unknown): boolean => e instanceof MemoryApiError && e.code === "notFound";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, init);
	const body = (await res.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
	if (!res.ok) {
		const code = (MEMORY_ERROR_CODES as readonly unknown[]).includes(body.code) ? (body.code as MemoryErrorCode) : null;
		throw new MemoryApiError(typeof body.error === "string" ? body.error : res.statusText, code, res.status);
	}
	return body as T;
}

function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
	return request<T>(path, {
		method: "POST",
		headers: { "content-type": "application/json", "x-omp-webui": "1" },
		body: JSON.stringify(body),
	});
}

export const memoryApi = {
	overview: () => request<MemoryOverview>("/api/memory"),
	items: (query: Partial<MemoryQuery>) => request<MemoryList>(`/api/memory/items?${queryString(query)}`),
	item: (bank: string, id: string) =>
		request<{ item: MemoryDetail }>(`/api/memory/item?${new URLSearchParams({ bank, id })}`).then((r) => r.item),
	add: (input: {
		scope: MemoryScope;
		bank?: string;
		content: string;
		importance?: number;
		context?: string;
		acknowledgeSecret?: boolean;
	}) => post<MemoryChanged>("/api/memory/add", input),
	/** `etag` is the one the edit began from; only the fields that changed are sent. */
	update: (input: {
		bank: string;
		id: string;
		etag: string;
		content?: string;
		importance?: number;
		acknowledgeSecret?: boolean;
	}) => post<MemoryChanged>("/api/memory/update", input),
	/** `etag` is left out to retire a memory whatever state it is in (the consolidated copy of one that is deleted). */
	retire: (input: { bank: string; id: string; etag?: string }) => post<MemoryChanged>("/api/memory/retire", input),
	restore: (input: { bank: string; id: string; etag?: string }) => post<MemoryChanged>("/api/memory/restore", input),
	/** `retireConsolidated`: what omp made of it is retired in the same transaction. */
	remove: (input: { bank: string; id: string; etag: string; retireConsolidated?: boolean }) =>
		post<MemoryDeleted>("/api/memory/delete", input),
};
