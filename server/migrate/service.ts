import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { CodedError, type ErrorInfo, errorInfoOf } from "../../shared/error-info.ts";
import { isRecord } from "../../shared/guards.ts";
import {
	type ExportRequest,
	type ExportStatus,
	type ImportMode,
	type ImportRequest,
	type ImportStatus,
	isMigrateDataCategory,
	MIGRATE_API,
	MIGRATE_CATEGORIES,
	MIGRATE_MIN_PASSWORD,
	type MigrateCategory,
	type MigrateDataCategoryId,
	type MigrateErrorInfo,
	type MigratePlan,
	type MigrateProgress,
	type MigrateState,
	migrateArchiveName,
	migrateHeldCategories,
} from "../../shared/migrate.ts";
import { osUser } from "../feedback.ts";
import { Cancelled, runExport } from "./export.ts";
import { ImportArchive, ImportCancelled, type ImportHooks, type RunningImport } from "./import.ts";
import { inventory, type Locations, leftOutOf, tilde } from "./layout.ts";
import { restoreBackup } from "./restore.ts";
import { isSealed } from "./sealed.ts";

/**
 * What the page asks of this server for moving to another computer (`shared/migrate.ts`): the plan, an export that runs
 * in the background and is then downloaded, an import that is uploaded in pieces, checked, shown, and applied. One of
 * them runs at a time; the state of each outlives the page that started it (it is read again when the page returns).
 */

export interface MigrateDeps {
	locations(): Locations;
	ompVersion(): string;
	serverVersion: string;
	hooks: ImportHooks;
	/** Called when an import has put files under the running server: the in-memory state that was read from them is read again. */
	after(): Promise<void>;
	/** Told when an import (or a restore) starts writing and when it has stopped: no conversation is opened in between. */
	writing?(on: boolean): void;
	json(data: unknown, status?: number): Response;
	fail(error: string, status?: number, info?: ErrorInfo): Response;
}

const idle = (): MigrateProgress => ({
	phase: "scan",
	doneBytes: 0,
	totalBytes: 0,
	doneFiles: 0,
	totalFiles: 0,
	current: "",
});

function errorOf(e: unknown): MigrateErrorInfo {
	const coded = errorInfoOf(e);
	return { message: e instanceof Error ? e.message : String(e), ...(coded ?? {}) };
}

function statusOf(e: unknown): number {
	const code = errorInfoOf(e)?.code;
	if (code === "migrateBusy" || code === "migrateWorking") return 409;
	return code ? 400 : 500;
}

/**
 * The categories a request names, or none for a request that names none (every data category then). Anything that is not a
 * data category is refused, `credentials` among them: the logins are asked for by `credentials`, with the password.
 */
function readCategories(value: unknown): ExportRequest["categories"] {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new CodedError("The categories to export are not a list", "migrateCategories", { category: "" });
	}
	const out: MigrateDataCategoryId[] = [];
	for (const id of value) {
		if (!isMigrateDataCategory(id)) {
			throw new CodedError(`${String(id).slice(0, 64)} is not a category that can be chosen`, "migrateCategories", {
				category: String(id).slice(0, 64),
			});
		}
		if (!out.includes(id)) out.push(id);
	}
	return out;
}

/** The longest an archive may be: a terabyte. A larger declared size is a mistake, not a migration. */
const MAX_ARCHIVE = 1024 ** 4;

/** The import that is under way: the file uploaded, what it is in (checking, locked, ready…) and what has opened it. */
interface Incoming {
	status: ImportStatus;
	abort: AbortController;
	file: string;
	archive: ImportArchive | null;
	upload: Promise<unknown>;
	/** An apply (or a restore) has begun: set before anything is awaited, so that no second one begins. */
	applying: boolean;
	/** A password is being tried (scrypt takes a moment): a second try waits for the first. */
	unlocking: boolean;
}

export class MigrateService {
	private exp: { status: ExportStatus; abort: AbortController; file: string | null } | null = null;
	private imp: Incoming | null = null;

	constructor(private readonly deps: MigrateDeps) {}

	private get dir(): string {
		const dir = join(this.deps.locations().dataDir, "migrate");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		return dir;
	}

	private get running(): boolean {
		return (
			this.exp?.status.state === "running" ||
			this.imp?.status.state === "verifying" ||
			this.imp?.status.state === "applying"
		);
	}

	state(): MigrateState {
		return { export: this.exp?.status ?? null, import: this.imp?.status ?? null };
	}

	// ------------------------------------------------------------------ plan

	async plan(): Promise<MigratePlan> {
		const loc = this.deps.locations();
		const inv = await inventory(loc);
		const categories: MigrateCategory[] = MIGRATE_CATEGORIES.map((id) => {
			const items = inv.items.filter((i) => i.category === id);
			return { id, files: items.length, bytes: items.reduce((n, i) => n + i.size, 0) };
		});
		const leftOut = leftOutOf(inv.leftOut);
		for (const i of inv.items) {
			if (i.kind === "auth" || i.kind === "secret") {
				leftOut.push({ path: tilde(i.source, loc.home), reason: "secret", bytes: i.size });
			}
		}
		return {
			host: hostName(),
			home: loc.home,
			ompVersion: this.deps.ompVersion(),
			serverVersion: this.deps.serverVersion,
			categories,
			totalFiles: categories.filter((c) => c.id !== "credentials").reduce((n, c) => n + c.files, 0),
			totalBytes: categories.filter((c) => c.id !== "credentials").reduce((n, c) => n + c.bytes, 0),
			leftOut: leftOut.sort((a, b) => (a.path < b.path ? -1 : 1)),
			secretFiles: inv.secretFiles.map((f) => ({
				path: tilde(f.source, loc.home),
				values: f.values,
				category: f.category,
			})),
			sessionDirs: inv.sessionDirs.map((d) => tilde(d.dir, loc.home)),
			profiles: inv.profiles,
			busy: this.running,
		};
	}

	// ------------------------------------------------------------------ export

	startExport(request: ExportRequest): ExportStatus {
		if (this.running) throw new CodedError("Another export or import is running", "migrateBusy");
		if (migrateHeldCategories(request).length === 0) {
			throw new CodedError("Nothing is chosen to export", "migrateNothingChosen");
		}
		if (request.credentials || request.wholeFile) {
			if (!request.password) {
				throw new CodedError("A password is needed to encrypt the archive", "migratePasswordMissing");
			}
			if (request.password.length < MIGRATE_MIN_PASSWORD) {
				throw new CodedError(
					`The password must be at least ${MIGRATE_MIN_PASSWORD} characters`,
					"migratePasswordShort",
					{
						min: MIGRATE_MIN_PASSWORD,
					},
				);
			}
		}
		this.discardExport();
		const name = migrateArchiveName(hostName(), new Date());
		const out = join(this.dir, name);
		rmSync(out, { force: true });
		const abort = new AbortController();
		const status: ExportStatus = {
			state: "running",
			credentials: request.credentials,
			wholeFile: request.wholeFile === true,
			categories: migrateHeldCategories(request),
			progress: idle(),
			skipped: [],
			startedAt: Date.now(),
		};
		this.exp = { status, abort, file: out };
		const loc = this.deps.locations();
		void runExport({
			loc,
			host: hostName(),
			user: osUser(),
			ompVersion: this.deps.ompVersion(),
			serverVersion: this.deps.serverVersion,
			credentials: request.credentials,
			wholeFile: request.wholeFile === true,
			categories: request.categories,
			password: request.password,
			out,
			tmp: join(this.dir, `tmp-${randomBytes(4).toString("hex")}`),
			signal: abort.signal,
			onProgress: (p) => {
				status.progress = { ...status.progress, ...p };
			},
		}).then(
			({ manifest, bytes }) => {
				status.state = "done";
				status.skipped = manifest.skipped;
				status.file = { name, bytes };
			},
			(e: unknown) => {
				rmSync(out, { force: true });
				rmSync(`${out}.part`, { force: true });
				if (e instanceof Cancelled || abort.signal.aborted) {
					status.state = "cancelled";
				} else {
					status.state = "failed";
					status.error = errorOf(e);
				}
			},
		);
		return status;
	}

	cancelExport(): void {
		if (this.exp?.status.state === "running") this.exp.abort.abort();
	}

	/** The finished archive: where it is and what to call it. */
	exportFile(): { path: string; name: string; bytes: number } | null {
		const file = this.exp?.file;
		const done = this.exp?.status.file;
		if (!file || !done || this.exp?.status.state !== "done") return null;
		try {
			return { path: file, name: done.name, bytes: statSync(file).size };
		} catch {
			return null;
		}
	}

	discardExport(): void {
		if (!this.exp || this.exp.status.state === "running") return;
		if (this.exp.file) rmSync(this.exp.file, { force: true });
		this.exp = null;
	}

	// ------------------------------------------------------------------ import

	async begin(name: string, size: number): Promise<ImportStatus> {
		if (this.running) throw new CodedError("Another export or import is running", "migrateBusy");
		if (!Number.isInteger(size) || size < 22 || size > MAX_ARCHIVE) {
			throw new CodedError("This is not an omp-webui migration archive", "migrateNotArchive");
		}
		await this.discardImport();
		const file = join(this.dir, `incoming-${randomBytes(6).toString("hex")}.ompw`);
		const fh = await open(file, "wx", 0o600);
		await fh.close();
		const status: ImportStatus = {
			state: "uploading",
			name: name.slice(0, 255),
			received: 0,
			size,
			progress: idle(),
			startedAt: Date.now(),
		};
		this.imp = {
			status,
			abort: new AbortController(),
			file,
			archive: null,
			upload: Promise.resolve(),
			applying: false,
			unlocking: false,
		};
		return status;
	}

	/** One piece of the archive, which goes at `offset` (a piece sent again replaces what it had written). */
	async chunk(offset: number, body: ReadableStream<Uint8Array> | null): Promise<ImportStatus> {
		const imp = this.imp;
		if (imp?.status.state !== "uploading") throw new CodedError("There is no upload under way", "migrateUpload");
		// One piece at a time: pieces that overlap would write over each other.
		const run = imp.upload.then(async () => {
			const { status } = imp;
			if (!Number.isInteger(offset) || offset < 0 || offset > status.received) {
				throw new CodedError("The upload does not continue where it stopped", "migrateUpload");
			}
			const fh = await open(imp.file, "r+");
			try {
				let position = offset;
				if (body) {
					for await (const part of body) {
						if (position + part.byteLength > status.size) {
							throw new CodedError("The upload is larger than it said it would be", "migrateUpload");
						}
						await fh.write(part, 0, part.byteLength, position);
						position += part.byteLength;
					}
				}
				// What was written beyond this piece (an earlier try that went further) is no longer trusted.
				await fh.truncate(position);
				status.received = position;
			} finally {
				await fh.close();
			}
		});
		imp.upload = run.catch(() => {});
		await run;
		return imp.status;
	}

	/** Check the archive and compare it with this Mac, in the background; the state says when it is ready (or `locked`: it needs its password first). */
	verify(): ImportStatus {
		const imp = this.imp;
		if (imp?.status.state !== "uploading") throw new CodedError("There is no upload to check", "migrateUpload");
		if (imp.status.received !== imp.status.size) {
			throw new CodedError("The upload is not complete", "migrateUpload");
		}
		const { status } = imp;
		status.state = "verifying";
		status.progress = { ...idle(), phase: "verify" };
		void (async () => {
			try {
				// Encrypted as a whole, not even the manifest can be read yet: the page is asked for the password first.
				if (await isSealed(imp.file)) {
					if (!imp.abort.signal.aborted) status.state = "locked";
					return;
				}
			} catch (e) {
				if (!imp.abort.signal.aborted) await this.fail(imp, e);
				return;
			}
			await this.check(imp);
		})();
		return status;
	}

	/**
	 * Open the archive that is encrypted as a whole with `password` and check it (the same check as for any other archive).
	 * A wrong password is refused here and the archive stays locked, to be tried again; a file that opens and is found
	 * changed or damaged is a failed import, as any other.
	 */
	async unlock(password: string): Promise<ImportStatus> {
		const imp = this.imp;
		if (imp?.status.state !== "locked") {
			throw new CodedError("There is no file waiting for its password", "migrateNotReady");
		}
		if (imp.unlocking) throw new CodedError("The file is being opened already", "migrateBusy");
		if (!password) throw new CodedError("A password is needed to open this file", "migratePasswordNeeded");
		const { status } = imp;
		imp.unlocking = true;
		let archive: ImportArchive;
		try {
			archive = await ImportArchive.open(imp.file, { password });
		} catch (e) {
			const code = errorInfoOf(e)?.code;
			if (code === "migrateFilePasswordWrong" || code === "migratePasswordNeeded") throw e;
			if (!imp.abort.signal.aborted) await this.fail(imp, e);
			return status;
		} finally {
			imp.unlocking = false;
		}
		if (imp.abort.signal.aborted) {
			await archive.close();
			return status;
		}
		status.state = "verifying";
		status.progress = { ...idle(), phase: "verify" };
		void this.check(imp, archive);
		return status;
	}

	/** Check an opened archive (opened here when it is not given: one that is not encrypted as a whole) and compare it with this Mac. */
	private async check(imp: Incoming, opened?: ImportArchive): Promise<void> {
		const { status } = imp;
		try {
			const archive = opened ?? (await ImportArchive.open(imp.file));
			if (imp.abort.signal.aborted) {
				await archive.close();
				return;
			}
			imp.archive = archive;
			await archive.verify({
				signal: imp.abort.signal,
				onProgress: (p) => {
					status.progress = { ...status.progress, ...p };
				},
			});
			status.preview = await archive.preview(this.env(imp.abort.signal, status));
			status.state = "ready";
		} catch (e) {
			if (e instanceof ImportCancelled || imp.abort.signal.aborted) return;
			await this.fail(imp, e);
		}
	}

	private async fail(imp: Incoming, e: unknown): Promise<void> {
		imp.status.state = "failed";
		imp.status.error = errorOf(e);
		await imp.archive?.close();
		imp.archive = null;
	}

	/** Begin the import. A refusal that needs nothing written (a wrong password, a working conversation) is thrown here. */
	async apply(request: ImportRequest): Promise<ImportStatus> {
		const imp = this.imp;
		// An import under way (also while it is still deciding, before its state says so) is never begun a second time.
		if (imp?.applying) throw new CodedError("The import has begun already", "migrateBusy");
		if (imp?.status.state !== "ready" || !imp.archive) {
			throw new CodedError("The archive has not been checked yet", "migrateNotReady");
		}
		if (request.mode !== "merge" && request.mode !== "replace")
			throw new CodedError("Choose merge or replace", "migrateNotReady");
		imp.applying = true;
		this.deps.writing?.(true);
		const { status, archive } = imp;
		const env = this.env(imp.abort.signal, status);
		let running: RunningImport;
		try {
			running = await archive.prepare(request, env);
		} catch (e) {
			imp.applying = false;
			this.deps.writing?.(false);
			throw e;
		}
		status.state = "applying";
		status.mode = request.mode;
		status.progress = { ...idle(), phase: "backup" };
		void (async () => {
			// `done` is said last: once a page reads it, what the import replaced has been read again and conversations open.
			let written = false;
			try {
				status.summary = await running.run();
				try {
					await this.deps.after();
				} catch (e) {
					console.warn(`omp-webui: after an import, state could not be read again: ${(e as Error).message}`);
				}
				written = true;
			} catch (e) {
				status.state = "failed";
				status.error = errorOf(e);
				// What was written before it stopped is in the backup, with the lists that undo it.
				status.backup = running.backup;
			} finally {
				imp.applying = false;
				this.deps.writing?.(false);
				if (written) status.state = "done";
				rmSync(env.tmp, { recursive: true, force: true });
			}
		})();
		return status;
	}

	/** Put back what a failed import changed, and remove what it made: from the backup it wrote before each file. */
	async restore(): Promise<ImportStatus> {
		const imp = this.imp;
		const backup = imp?.status.backup;
		if (imp?.status.state !== "failed" || !backup || imp.status.restored) {
			throw new CodedError("There is no backup to put back", "migrateNoBackup");
		}
		if (imp.applying) throw new CodedError("The import is being written", "migrateBusy");
		imp.applying = true;
		this.deps.writing?.(true);
		try {
			const busy = this.deps.hooks.busy();
			if (busy > 0)
				throw new CodedError(`${busy} conversation(s) are still working`, "migrateWorking", { count: busy });
			await this.deps.hooks.endIdle();
			await restoreBackup(backup);
			imp.status.restored = true;
			await this.deps.after().catch((e: unknown) => {
				console.warn(`omp-webui: after a restore, state could not be read again: ${(e as Error).message}`);
			});
		} finally {
			imp.applying = false;
			this.deps.writing?.(false);
		}
		return imp.status;
	}

	async discardImport(): Promise<void> {
		const imp = this.imp;
		if (!imp) return;
		if (imp.status.state === "applying") throw new CodedError("The import is being written", "migrateBusy");
		imp.abort.abort();
		await imp.upload;
		await imp.archive?.close();
		rmSync(imp.file, { force: true });
		this.imp = null;
	}

	private env(signal: AbortSignal, status: ImportStatus) {
		const loc = this.deps.locations();
		return {
			loc,
			ompVersion: this.deps.ompVersion(),
			serverVersion: this.deps.serverVersion,
			backups: join(loc.dataDir, "migration-backups"),
			tmp: join(this.dir, `tmp-${randomBytes(4).toString("hex")}`),
			signal,
			hooks: this.deps.hooks,
			onProgress: (p: Partial<MigrateProgress>) => {
				status.progress = { ...status.progress, ...p };
			},
		};
	}

	// ------------------------------------------------------------------ routes

	/** The answer to a request under `/api/migrate/`; null for a path that is not one of them. */
	async handle(req: Request, url: URL): Promise<Response | null> {
		const { json, fail } = this.deps;
		const p = url.pathname;
		if (!p.startsWith("/api/migrate/")) return null;
		const post = req.method === "POST";
		const read = async (): Promise<Record<string, unknown>> => {
			const body: unknown = await req.json().catch(() => null);
			return isRecord(body) ? body : {};
		};
		try {
			switch (p) {
				case MIGRATE_API.plan:
					return json(await this.plan());
				case MIGRATE_API.state:
					return json(this.state());
				case MIGRATE_API.export: {
					if (!post) return fail("POST required", 405);
					const body = await read();
					return json(
						this.startExport({
							credentials: body.credentials === true,
							wholeFile: body.wholeFile === true,
							password: typeof body.password === "string" ? body.password : undefined,
							categories: readCategories(body.categories),
						}),
					);
				}
				case MIGRATE_API.exportCancel:
					if (!post) return fail("POST required", 405);
					this.cancelExport();
					return json(this.state());
				case MIGRATE_API.exportDiscard:
					if (!post) return fail("POST required", 405);
					this.discardExport();
					return json(this.state());
				case MIGRATE_API.exportFile: {
					const file = this.exportFile();
					if (!file) return fail("There is no finished export", 404);
					return new Response(Bun.file(file.path), {
						headers: {
							"content-type": "application/octet-stream",
							"content-length": String(file.bytes),
							"content-disposition": `attachment; filename="${file.name}"`,
							"cache-control": "no-store",
						},
					});
				}
				case MIGRATE_API.importBegin: {
					if (!post) return fail("POST required", 405);
					const body = await read();
					return json(await this.begin(typeof body.name === "string" ? body.name : "", Number(body.size)));
				}
				case MIGRATE_API.importChunk:
					if (!post) return fail("POST required", 405);
					return json(await this.chunk(Number(url.searchParams.get("offset")), req.body));
				case MIGRATE_API.importVerify:
					if (!post) return fail("POST required", 405);
					return json(this.verify());
				case MIGRATE_API.importUnlock: {
					if (!post) return fail("POST required", 405);
					const body = await read();
					return json(await this.unlock(typeof body.password === "string" ? body.password : ""));
				}
				case MIGRATE_API.importApply: {
					if (!post) return fail("POST required", 405);
					const body = await read();
					const mode: ImportMode = body.mode === "replace" ? "replace" : "merge";
					return json(
						await this.apply({
							mode,
							credentials: body.credentials === true,
							password: typeof body.password === "string" ? body.password : undefined,
						}),
					);
				}
				case MIGRATE_API.importRestore:
					if (!post) return fail("POST required", 405);
					return json(await this.restore());
				case MIGRATE_API.importDiscard:
					if (!post) return fail("POST required", 405);
					await this.discardImport();
					return json(this.state());
				default:
					return fail("Not found", 404);
			}
		} catch (e) {
			return fail((e as Error).message, statusOf(e), errorInfoOf(e) ?? undefined);
		}
	}

	/** Remove what a finished or abandoned migration left in the data dir (an archive the page never downloaded). */
	close(): void {
		this.exp?.abort.abort();
		this.imp?.abort.abort();
	}
}

function hostName(): string {
	return hostname().replace(/\.local$/, "");
}
