import { readFileSync, statSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import {
	type ExportRequest,
	type ExportStatus,
	type ImportRequest,
	type ImportStatus,
	MIGRATE_API,
	type MigratePlan,
	type MigrateState,
} from "../../shared/migrate.ts";
import type { TestServer } from "./server.ts";

/** What a page does, over HTTP, against a test server: ask for the plan, export, download, upload, check, apply. */

export interface Answer<T> {
	status: number;
	body: T & { error?: string; code?: string; params?: Record<string, string | number> };
}

export async function call<T>(
	s: Pick<TestServer, "url" | "accessToken">,
	path: string,
	init: RequestInit = {},
): Promise<Answer<T>> {
	const res = await fetch(`${s.url}${path}`, {
		...init,
		headers: {
			"x-omp-webui-token": s.accessToken,
			...(init.method && init.method !== "GET" ? { "x-omp-webui": "1" } : {}),
			...(init.body && typeof init.body === "string" ? { "content-type": "application/json" } : {}),
			...init.headers,
		},
	});
	const body = (await res.json().catch(() => ({}))) as Answer<T>["body"];
	return { status: res.status, body };
}

const post = <T>(s: TestServer, path: string, body?: unknown) =>
	call<T>(s, path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export const plan = (s: TestServer) => call<MigratePlan>(s, MIGRATE_API.plan);
export const state = (s: TestServer) => call<MigrateState>(s, MIGRATE_API.state);

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, what: string, ms = 60_000): Promise<T> {
	const stop = Date.now() + ms;
	for (;;) {
		const v = await read();
		if (done(v)) return v;
		if (Date.now() > stop) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v).slice(0, 400)}`);
		await sleep(40);
	}
}

/** Export on `s` and, when it ends, the archive written to `to`. */
export async function exportTo(s: TestServer, to: string, request: ExportRequest): Promise<ExportStatus> {
	const started = await post<ExportStatus>(s, MIGRATE_API.export, request);
	if (started.status !== 200) throw new Error(`export refused: ${started.status} ${JSON.stringify(started.body)}`);
	const ended = await until(
		async () => (await state(s)).body.export as ExportStatus,
		(e) => e.state !== "running",
		"the export",
	);
	if (ended.state !== "done") throw new Error(`export ${ended.state}: ${JSON.stringify(ended.error)}`);
	const res = await fetch(`${s.url}${MIGRATE_API.exportFile}`, { headers: { "x-omp-webui-token": s.accessToken } });
	if (!res.ok) throw new Error(`download failed: ${res.status}`);
	writeFileSync(to, new Uint8Array(await res.arrayBuffer()));
	return ended;
}

/** Upload `file` to `s` in pieces of `piece` bytes and check it; resolves with the state when it is ready, has failed, or waits for a password (`locked`). */
export async function uploadAndVerify(s: TestServer, file: string, piece = 64 * 1024): Promise<ImportStatus> {
	const bytes = readFileSync(file);
	const begun = await post<ImportStatus>(s, MIGRATE_API.importBegin, { name: "moved.ompw", size: statSync(file).size });
	if (begun.status !== 200) throw new Error(`begin refused: ${begun.status} ${JSON.stringify(begun.body)}`);
	for (let offset = 0; offset < bytes.length; offset += piece) {
		const sent = await call<ImportStatus>(s, `${MIGRATE_API.importChunk}?offset=${offset}`, {
			method: "POST",
			headers: { "content-type": "application/octet-stream" },
			body: bytes.subarray(offset, offset + piece),
		});
		if (sent.status !== 200) throw new Error(`chunk refused: ${sent.status} ${JSON.stringify(sent.body)}`);
	}
	const verifying = await post<ImportStatus>(s, MIGRATE_API.importVerify);
	if (verifying.status !== 200)
		throw new Error(`verify refused: ${verifying.status} ${JSON.stringify(verifying.body)}`);
	return until(
		async () => (await state(s)).body.import as ImportStatus,
		(i) => i.state === "ready" || i.state === "failed" || i.state === "locked",
		"the check",
	);
}

/** Apply the checked archive; the answer to the request itself (a refusal is not a state), then the final state. */
export async function apply(
	s: TestServer,
	request: ImportRequest,
): Promise<{ started: Answer<ImportStatus>; ended?: ImportStatus }> {
	const started = await post<ImportStatus>(s, MIGRATE_API.importApply, request);
	if (started.status !== 200) return { started };
	const ended = await until(
		async () => (await state(s)).body.import as ImportStatus,
		(i) => i.state === "done" || i.state === "failed",
		"the import",
	);
	return { started, ended };
}

/**
 * Open an archive that is encrypted as a whole: the answer to the request itself (a wrong password is a refusal, and the
 * archive stays locked), then, when it was taken, the state once the check has ended.
 */
export async function unlock(
	s: TestServer,
	password: string,
): Promise<{ answered: Answer<ImportStatus>; ended?: ImportStatus }> {
	const answered = await post<ImportStatus>(s, MIGRATE_API.importUnlock, { password });
	if (answered.status !== 200) return { answered };
	const ended = await until(
		async () => (await state(s)).body.import as ImportStatus,
		(i) => i.state === "ready" || i.state === "failed",
		"the check after the password",
	);
	return { answered, ended };
}

export const discardImport = (s: TestServer) => post<MigrateState>(s, MIGRATE_API.importDiscard);
export const discardExport = (s: TestServer) => post<MigrateState>(s, MIGRATE_API.exportDiscard);
