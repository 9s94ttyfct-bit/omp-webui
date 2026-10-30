import { mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { type FileHandle, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	MIGRATE_FORMAT,
	type MigrateCategoryId,
	type MigrateDataCategoryId,
	type MigrateLeftOut,
	type MigrateProgress,
	migrateHeldCategories,
} from "../../shared/migrate.ts";
import { encrypt } from "./crypto.ts";
import {
	bankIsOf,
	type Inventory,
	type Item,
	inventory,
	type Locations,
	leftOutOf,
	MEMORY_BANK,
	TRANSCRIPT_PATH,
	tilde,
} from "./layout.ts";
import {
	CREDENTIALS_NAME,
	CREDENTIALS_PLAIN_NAME,
	MANIFEST_NAME,
	type Manifest,
	type ManifestEntry,
} from "./manifest.ts";
import { HEAD_BYTES, sniffHead } from "./rewrite.ts";
import { SealedWriter } from "./sealed.ts";
import { redactSecrets } from "./secrets.ts";
import { authSnapshot, foldersOf, snapshotDb } from "./sqlite.ts";
import { ZipWriter } from "./zip.ts";

/**
 * Writing the archive. Everything is copied while omp may be writing: a transcript is append-only, so it is copied up to
 * a size that ends on a complete line (what is written after is simply not in it); a database is copied by SQLite as a
 * snapshot; nothing else changes while it is read. A file that cannot be read (it vanished, or is not the user's) is
 * left out and told, and the export goes on.
 */

export class Cancelled extends Error {
	constructor() {
		super("Cancelled");
	}
}

export interface ExportInput {
	loc: Locations;
	host: string;
	user: string;
	ompVersion: string;
	serverVersion: string;
	credentials: boolean;
	/** Encrypt the whole archive (every entry and the manifest) with `password`, not only the logins. */
	wholeFile?: boolean;
	/** Needed when the logins or the whole archive are encrypted. */
	password?: string;
	/** The data categories to put in the archive; every one when it is left out (see `ExportRequest.categories`). */
	categories?: readonly MigrateDataCategoryId[];
	/** The archive to write (made as `<out>.part` and moved there when it is whole). */
	out: string;
	/** A folder for the snapshots made on the way; removed afterwards. */
	tmp: string;
	signal: AbortSignal;
	onProgress: (p: Partial<MigrateProgress>) => void;
}

const CHUNK = 1024 * 1024;

/** What a bundle of secrets holds: each file with its original content, base64. */
export interface CredentialFile {
	/** The path it has in the archive. */
	path: string;
	kind: "auth" | "secret" | "config";
	mode: number;
	mtimeMs: number;
	data: string;
}

export interface CredentialBundle {
	v: 1;
	files: CredentialFile[];
}

/** How far a transcript is stable: the length of its last complete line. */
async function stableLength(fh: FileHandle, size: number): Promise<number> {
	let end = size;
	const block = Buffer.allocUnsafe(64 * 1024);
	while (end > 0) {
		const start = Math.max(0, end - block.length);
		const { bytesRead } = await fh.read(block, 0, end - start, start);
		const at = block.subarray(0, bytesRead).lastIndexOf(0x0a);
		if (at >= 0) return start + at + 1;
		end = start;
	}
	return 0;
}

/** The bytes of a file, to `limit` when it is given (and an error when it is shorter than that: it shrank under the read). */
async function* readFrom(fh: FileHandle, limit: number | null, signal: AbortSignal): AsyncGenerator<Uint8Array> {
	let position = 0;
	for (;;) {
		if (signal.aborted) throw new Cancelled();
		const want = limit === null ? CHUNK : Math.min(CHUNK, limit - position);
		if (want <= 0) return;
		const buf = Buffer.allocUnsafe(want);
		const { bytesRead } = await fh.read(buf, 0, want, position);
		if (bytesRead === 0) {
			if (limit !== null && position < limit) throw new Error("The file shrank while it was copied");
			return;
		}
		position += bytesRead;
		yield bytesRead === want ? buf : buf.subarray(0, bytesRead);
	}
}

/** The transcript's first window (to read the folder and id its header names) beside the bytes that go on. */
async function* tee(source: AsyncIterable<Uint8Array>, head: Buffer[]): AsyncGenerator<Uint8Array> {
	let held = 0;
	for await (const chunk of source) {
		if (held < HEAD_BYTES) {
			head.push(Buffer.from(chunk.buffer, chunk.byteOffset, Math.min(chunk.byteLength, HEAD_BYTES - held)));
			held += chunk.byteLength;
		}
		yield chunk;
	}
}

/** An archive written; the manifest that describes it. */
export async function runExport(input: ExportInput): Promise<{ manifest: Manifest; bytes: number }> {
	const { loc, signal } = input;
	if ((input.wholeFile || input.credentials) && !input.password) {
		throw new Error("A password is needed to encrypt the archive");
	}
	const categories = migrateHeldCategories(input);
	if (categories.length === 0) throw new Error("Nothing is chosen to export");
	const held = new Set<MigrateCategoryId>(categories);
	input.onProgress({ phase: "scan", current: "", doneBytes: 0, totalBytes: 0, doneFiles: 0, totalFiles: 0 });
	const skipped: { path: string; error: string }[] = [];
	const inv: Inventory = await inventory(loc, (path, error) =>
		skipped.push({ path: tilde(path, loc.home), error: error.message }),
	);
	if (signal.aborted) throw new Cancelled();

	// What is said to be left out is what lies where the chosen categories draw from (never a cache of a category not chosen).
	const leftOut: MigrateLeftOut[] = leftOutOf(inv.leftOut, held);
	const secretWithheld = (item: Item): void => {
		leftOut.push({ path: tilde(item.source, loc.home), reason: "secret", bytes: item.size });
	};
	// Only what the person chose: a category that was not asked for is not read, not listed as left out, and its secret
	// values stay out with it (a `.env` in a folder that was not chosen too). The logins are one of the categories, and only
	// when they were asked for.
	const carried = inv.items.filter(
		(i) => held.has(i.origin ?? i.category) && (input.credentials || (i.kind !== "auth" && i.kind !== "secret")),
	);
	if (!input.credentials) {
		for (const i of inv.items) {
			if ((i.kind === "auth" || i.kind === "secret") && (i.origin === undefined || held.has(i.origin)))
				secretWithheld(i);
		}
	}

	const totalBytes = carried.reduce((n, i) => n + i.size, 0);
	const progress: MigrateProgress = {
		phase: "copy",
		doneBytes: 0,
		totalBytes,
		doneFiles: 0,
		totalFiles: carried.length,
		current: "",
	};
	input.onProgress({ ...progress });

	mkdirSync(input.tmp, { recursive: true, mode: 0o700 });
	const part = `${input.out}.part`;
	rmSync(part, { force: true });
	// Sealed as a whole, the zip is encrypted as it is written: no plaintext copy of the archive is ever on disk.
	const zip = input.wholeFile
		? ZipWriter.createOn(await SealedWriter.create(part, input.password ?? ""), part)
		: await ZipWriter.create(part);
	const entries: ManifestEntry[] = [];
	const bundle: CredentialBundle = { v: 1, files: [] };
	let n = 0;

	const add = async (
		item: Item,
		kind: ManifestEntry["kind"],
		source: AsyncIterable<Uint8Array> | Uint8Array,
		extra: Partial<ManifestEntry> = {},
	): Promise<void> => {
		const base = progress.doneBytes;
		const written = await zip.add(item.path, source, {
			mtimeMs: item.mtimeMs,
			mode: item.mode,
			signal,
			// What is already compressed gains nothing from deflate, and a snapshot of a database is mostly pages.
			compress: !/\.(png|jpe?g|gif|webp|gz|zip|bz2|xz|zst|mp3|mp4|mov)$/i.test(item.path),
			onBytes: (bytes) => {
				progress.doneBytes = base + bytes;
				input.onProgress({ doneBytes: progress.doneBytes, current: item.path });
			},
		});
		progress.doneBytes = base + Math.max(written.size, item.size > written.size ? item.size : 0);
		entries.push({
			path: item.path,
			category: item.category,
			kind,
			size: written.size,
			sha256: written.sha256,
			mode: item.mode,
			mtimeMs: item.mtimeMs,
			...extra,
		});
	};

	try {
		for (const item of carried) {
			if (signal.aborted) throw new Cancelled();
			progress.current = item.path;
			input.onProgress({ current: item.path, doneFiles: n });
			try {
				await carry(item);
			} catch (e) {
				if (e instanceof Cancelled || signal.aborted) throw new Cancelled();
				// A file that cannot be read is not the archive's failure; the archive's own write failing is.
				if (isWriteFailure(e)) throw e;
				skipped.push({ path: tilde(item.source, loc.home), error: (e as Error).message });
			}
			n++;
		}

		async function carry(item: Item): Promise<void> {
			switch (item.kind) {
				case "symlink":
					entries.push({
						path: item.path,
						category: item.category,
						kind: "symlink",
						size: 0,
						sha256: "",
						mode: item.mode,
						mtimeMs: item.mtimeMs,
						target: item.target,
					});
					return;
				case "sqlite": {
					const copy = join(input.tmp, `${n}.db`);
					try {
						snapshotDb(item.source, copy);
						const fh = await open(copy, "r");
						try {
							await add(item, "sqlite", readFrom(fh, null, signal));
						} finally {
							await fh.close();
						}
					} finally {
						rmSync(copy, { force: true });
					}
					return;
				}
				case "auth": {
					const copy = join(input.tmp, `${n}.auth.db`);
					try {
						authSnapshot(item.source, copy);
						bundle.files.push({
							path: item.path,
							kind: "auth",
							mode: 0o600,
							mtimeMs: item.mtimeMs,
							data: (await readFile(copy)).toString("base64"),
						});
					} finally {
						rmSync(copy, { force: true });
					}
					return;
				}
				case "secret":
					bundle.files.push({
						path: item.path,
						kind: "secret",
						mode: 0o600,
						mtimeMs: item.mtimeMs,
						data: (await readFile(item.source)).toString("base64"),
					});
					return;
				case "config": {
					const original = await readFile(item.source);
					// Every configuration file is looked through, not only the ones the plan listed: what is found here is
					// what is blanked, so the two cannot disagree.
					const redacted = item.format
						? redactSecrets(original.toString("utf8"), item.format)
						: { text: "", count: 0, clean: true };
					if (redacted.count === 0 && redacted.clean) {
						await add(item, "config", original);
						return;
					}
					if (input.credentials) {
						bundle.files.push({
							path: item.path,
							kind: "config",
							mode: item.mode,
							mtimeMs: item.mtimeMs,
							data: original.toString("base64"),
						});
					}
					if (!redacted.clean) {
						// Secrets that cannot be told from the rest with certainty: the file as a whole stays out.
						if (!input.credentials) secretWithheld(item);
						return;
					}
					await add(item, "config", Buffer.from(redacted.text, "utf8"), { redacted: redacted.count });
					return;
				}
				default: {
					const fh = await open(item.source, "r");
					try {
						const jsonl = TRANSCRIPT_PATH.test(item.path);
						const size = (await fh.stat()).size;
						const limit = jsonl ? await stableLength(fh, size) : null;
						const head: Buffer[] = [];
						const data = readFrom(fh, limit, signal);
						if (!jsonl) {
							await add(item, "file", data);
							return;
						}
						await add(item, "file", tee(data, head));
						const sniffed = sniffHead(Buffer.concat(head));
						const entry = entries[entries.length - 1];
						entry.cwd = sniffed?.cwd ?? null;
						entry.sessionId = sniffed?.id ?? null;
					} finally {
						await fh.close();
					}
				}
			}
		}

		progress.phase = "finish";
		input.onProgress({ phase: "finish", doneFiles: carried.length, current: "" });

		let credentials: Manifest["credentials"] = { included: false };
		if (input.credentials) {
			// Sealed as a whole, the logins are already under the password: a second layer would only cost scrypt again.
			const bundleJson = Buffer.from(JSON.stringify(bundle), "utf8");
			const written = input.wholeFile
				? await zip.add(CREDENTIALS_PLAIN_NAME, bundleJson, { compress: false, mode: 0o600, signal })
				: await zip.add(CREDENTIALS_NAME, await encrypt(bundleJson, input.password ?? ""), {
						compress: false,
						mode: 0o600,
						signal,
					});
			credentials = { included: true, sha256: written.sha256, bytes: written.size, files: bundle.files.length };
		}

		const manifest: Manifest = {
			format: MIGRATE_FORMAT,
			app: "omp-webui",
			createdAt: new Date().toISOString(),
			categories,
			source: {
				host: input.host,
				user: input.user,
				home: loc.home,
				homeReal: loc.homeReal !== loc.home ? loc.homeReal : undefined,
				agentDir: loc.agentDir,
				dataDir: loc.dataDir,
				platform: process.platform,
				ompVersion: input.ompVersion,
				serverVersion: input.serverVersion,
			},
			// The folders of the conversations that are in it (an import moves them into this app's own folder).
			sessionDirs: held.has("conversations") ? inv.sessionDirs : [],
			// A profile is listed when something of it is in the archive.
			profiles: inv.profiles.filter((name) => carried.some((i) => i.path.startsWith(`profiles/${name}/`))),
			bankFolders: await bankFolders(inv, carried, held, input.tmp, signal),
			entries,
			leftOut: leftOut.sort((a, b) => (a.path < b.path ? -1 : 1)),
			secretFiles: inv.secretFiles
				.filter((f) => held.has(f.category))
				.map((f) => ({ path: tilde(f.source, loc.home), values: f.values })),
			skipped,
			credentials,
		};
		await zip.add(MANIFEST_NAME, Buffer.from(JSON.stringify(manifest), "utf8"), { signal });
		await zip.finish();
		renameSync(part, input.out);
		// What is on disk: the zip's own length when it is sealed is smaller by the tags and the header.
		return { manifest, bytes: statSync(input.out).size };
	} catch (e) {
		await zip.abort();
		throw e;
	} finally {
		rmSync(input.tmp, { recursive: true, force: true });
	}
}

/** A conversation's own transcript (not one beside it): the file whose header names the folder it ran in. */
const SESSION_FILE = /(?:^|\/)sessions\/[^/]+\/[^/]+\.jsonl$|^sessiondirs\/\d+\/[^/]+\.jsonl$/;

/**
 * The folders the memory banks of the archive are named after, for an archive that does not carry the places that record
 * them (the conversations' headers, the prompt history): a bank is named after a hash of its folder's path, so the importer
 * can only rename it for a new home when it is told the path. Found here, on the machine that has them, and only those
 * that match a bank that goes in.
 */
async function bankFolders(
	inv: Inventory,
	carried: Item[],
	held: ReadonlySet<MigrateCategoryId>,
	tmp: string,
	signal: AbortSignal,
): Promise<string[]> {
	const banks = new Set<string>();
	for (const i of carried) {
		const m = MEMORY_BANK.exec(i.path);
		if (m) banks.add(m[2]);
	}
	if (banks.size === 0 || (held.has("conversations") && held.has("history"))) return [];
	const folders = new Set<string>();
	if (!held.has("conversations")) {
		for (const i of inv.items) {
			if (i.category !== "conversations" || i.kind !== "file" || !SESSION_FILE.test(i.path)) continue;
			if (signal.aborted) throw new Cancelled();
			let fh: FileHandle;
			try {
				fh = await open(i.source, "r");
			} catch {
				// Gone since the scan: it names no folder.
				continue;
			}
			try {
				const head = Buffer.alloc(HEAD_BYTES);
				const { bytesRead } = await fh.read(head, 0, HEAD_BYTES, 0);
				const cwd = sniffHead(head.subarray(0, bytesRead))?.cwd;
				if (cwd) folders.add(cwd);
			} finally {
				await fh.close();
			}
		}
	}
	const history = held.has("history") ? undefined : inv.items.find((i) => i.path === "agent/history.db");
	if (history) {
		const copy = join(tmp, "folders.db");
		try {
			snapshotDb(history.source, copy);
			for (const dir of foldersOf(copy)) folders.add(dir);
		} catch {
			// Not a database SQLite can read: it names no folder.
		} finally {
			rmSync(copy, { force: true });
		}
	}
	return [...folders].filter((dir) => [...banks].some((bank) => bankIsOf(bank, dir))).sort();
}

/** Whether `e` is the archive's own file failing (the disk is full), not a file being copied. */
function isWriteFailure(e: unknown): boolean {
	const code = (e as NodeJS.ErrnoException).code;
	return code === "ENOSPC" || code === "EDQUOT" || code === "EROFS";
}
