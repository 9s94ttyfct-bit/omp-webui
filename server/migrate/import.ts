import { createHash, randomBytes } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	constants,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmdirSync,
	rmSync,
	statfsSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { lstat, open, readFile, readlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { CodedError } from "../../shared/error-info.ts";
import { isRecord } from "../../shared/guards.ts";
import {
	type ImportCounts,
	type ImportMode,
	type ImportNote,
	type ImportPreview,
	type ImportRequest,
	type ImportSummary,
	MIGRATE_CATEGORIES,
	type MigrateCategoryId,
	type MigrateEncryption,
	type MigrateProgress,
	type OldMachineValue,
} from "../../shared/migrate.ts";
import { compareVersions } from "../../shared/omp-install.ts";
import { isPrefKey, isValidPref } from "../../shared/prefs.ts";
import { UiPrefs } from "../prefs.ts";
import { decrypt, WrongPasswordError } from "./crypto.ts";
import type { CredentialFile } from "./export.ts";
import {
	bankIsOf,
	bundleDestination,
	configRootOf,
	destinationOf,
	type Locations,
	MEMORY_BANK,
	type PathPlacement,
	PLUGIN_LINK,
	placementOf,
	TRANSCRIPT_PATH,
	tilde,
} from "./layout.ts";
import {
	CREDENTIALS_NAME,
	CREDENTIALS_PLAIN_NAME,
	MANIFEST_NAME,
	type Manifest,
	type ManifestEntry,
	parseManifest,
} from "./manifest.ts";
import { compareFiles, mergeDoc, parseDoc, serializeDoc, unionList } from "./merge.ts";
import { BACKUP_APP, RESTORE_NOTE } from "./restore.ts";
import { bucketFor, PathMap, rewriteSession } from "./rewrite.ts";
import { isSealed, SealedFile, unlockSealed } from "./sealed.ts";
import type { ConfigFormat } from "./secrets.ts";
import { foldersOf, mergeHistory, replaceDbFile, restoreAuth, rewriteColumnsAt, snapshotDb } from "./sqlite.ts";
import { ZipError, ZipReader } from "./zip.ts";

/**
 * Reading an archive and putting it on this Mac.
 *
 * `ImportArchive.open` reads the manifest only (an archive encrypted as a whole needs its password even for that: its
 * manifest is encrypted too); `verify` reads every file once and compares its checksum (and, for such an archive,
 * authenticates every chunk); `preview` compares the archive with what is here; `apply` writes. Nothing is written
 * before `apply`, and `apply` decrypts the logins (if they are asked for, and encrypted on their own) before it writes
 * anything: a wrong password changes nothing. Each file is written beside its place and moved into it, and whatever is
 * already there and about to change is copied to a backup folder first.
 */

export interface ImportHooks {
	/** Conversations of this server that are working, asking or paused: the import does not start while there are any. */
	busy(): number;
	/** Close the conversation processes that are idle (they start again from their files when they are opened). */
	endIdle(): Promise<number>;
	/** Whether a terminal's omp holds the session (a file it writes must not be replaced under it). */
	openElsewhere(sessionId: string): Promise<boolean>;
}

export interface ImportEnv {
	loc: Locations;
	ompVersion: string;
	serverVersion: string;
	/** Where backups are made: a folder of timestamped folders. */
	backups: string;
	tmp: string;
	signal: AbortSignal;
	onProgress: (p: Partial<MigrateProgress>) => void;
	hooks: ImportHooks;
	now?: () => Date;
	/** How many bytes are free where the import writes (tests set it; the file system says otherwise). */
	freeBytes?: () => number;
}

export class ImportCancelled extends Error {
	constructor() {
		super("Cancelled");
	}
}

const SESSION_FILE = /(?:^|\/)sessions\/([^/]+)\/[^/]+\.jsonl$/;
const SESSION_DIR_FILE = /^sessiondirs\/\d+\/[^/]+\.jsonl$/;
const LIST_FILES = new Set(["archived.json", "interviews.json", "favorite-models.json", "session-pins.json"]);
/** The lists of objects that carry an identity. */
const LIST_KEYS: Record<string, Record<string, string>> = {
	"marketplaces.json": { marketplaces: "name" },
	"session-roots.json": { roots: "dir" },
	// The sidebar's project groups (#636): a group is merged by its id, so a person's groups here are kept as they are and the
	// archive's are added beside them. Two machines' groups have ids of their own, so the two lists are added together; should
	// both name one project folder, the page shows it once (the first group in the list has it, `parseGroups`).
	"project-groups.json": { groups: "id" },
	// Unattended mode's questions (#646): merged by id, so the archive's questions are added beside the ones here.
	"questions.json": { questions: "id" },
};

/** The largest manifest read into memory: a listing of every file is megabytes, never more than this. */
const MAX_MANIFEST = 64 * 1024 * 1024;
/** What an archive may declare in all, and how much more a file may be than what is stored of it (deflate cannot pass about 1000). */
const MAX_TOTAL = 2 * 1024 ** 4;
const MAX_RATIO = 400;
const RATIO_FROM = 64 * 1024 * 1024;

const sessionIdOf = (path: string): string | null => /_([^_/]+)\.jsonl$/.exec(path)?.[1] ?? null;

function mapZipError(e: unknown, file = ""): never {
	if (e instanceof CodedError) throw e;
	if (e instanceof ZipError) {
		const [message, code] =
			e.code === "corrupt"
				? (["The archive is damaged or cut off", "migrateCorrupt"] as const)
				: e.code === "tampered"
					? (["The file was changed after it was made, or it is damaged", "migrateTampered"] as const)
					: ([`The archive cannot be read (${e.message})`, "migrateNotArchive"] as const);
		throw new CodedError(message, code, file ? { file } : {});
	}
	throw e;
}

export class ImportArchive {
	/** How the file is encrypted: as a whole (it was opened with its password), only its logins, or not at all. */
	readonly encryption: MigrateEncryption;

	private constructor(
		readonly file: string,
		private readonly zip: ZipReader,
		readonly manifest: Manifest,
		private readonly sealed: SealedFile | null,
	) {
		this.encryption = sealed ? "whole" : manifest.credentials.included ? "logins" : "none";
	}

	/**
	 * The archive at `file`, opened and its manifest read (nothing else is read yet). An archive encrypted as a whole
	 * needs `password` here (`migratePasswordNeeded` without, `migrateFilePasswordWrong` for a wrong one), because its
	 * manifest is encrypted too; any other archive takes the same way as before and ignores it.
	 */
	static async open(file: string, options: { password?: string } = {}): Promise<ImportArchive> {
		let zip: ZipReader;
		let sealed: SealedFile | null = null;
		if (await isSealed(file)) {
			// Encrypted as a whole: not even the manifest can be read without the password.
			if (!options.password) throw new CodedError("A password is needed to open this file", "migratePasswordNeeded");
			try {
				sealed = await SealedFile.open(file, await unlockSealed(file, options.password));
				zip = await ZipReader.from(sealed, sealed.size);
			} catch (e) {
				if (e instanceof WrongPasswordError) {
					throw new CodedError("That password does not open this file", "migrateFilePasswordWrong");
				}
				return mapZipError(e);
			}
		} else {
			// A file that does not even start like a zip is somebody's other file, not a damaged archive.
			const head = Buffer.alloc(4);
			const fh = await open(file, "r");
			try {
				await fh.read(head, 0, 4, 0);
			} finally {
				await fh.close();
			}
			if (head[0] !== 0x50 || head[1] !== 0x4b) {
				throw new CodedError("This is not an omp-webui migration archive", "migrateNotArchive");
			}
			try {
				zip = await ZipReader.open(file);
			} catch (e) {
				return mapZipError(e);
			}
		}
		try {
			if (!zip.entry(MANIFEST_NAME)) {
				throw new CodedError("This is not an omp-webui migration archive", "migrateNotArchive");
			}
			let text: Uint8Array;
			try {
				text = await zip.bytes(MANIFEST_NAME, MAX_MANIFEST);
			} catch (e) {
				return mapZipError(e, MANIFEST_NAME);
			}
			let json: unknown;
			try {
				json = JSON.parse(Buffer.from(text).toString("utf8"));
			} catch {
				throw new CodedError("The archive's manifest cannot be read", "migrateCorrupt", { file: MANIFEST_NAME });
			}
			const manifest = parseManifest(json);
			const indexes = new Set<number>();
			for (const d of manifest.sessionDirs) {
				if (!Number.isInteger(d.index) || d.index < 0 || indexes.has(d.index) || !isAbsolute(d.dir)) {
					throw new CodedError("The archive names a folder it should not", "migrateCorrupt", { file: MANIFEST_NAME });
				}
				indexes.add(d.index);
			}
			let total = 0;
			for (const e of manifest.entries) {
				const placed = placedEntry(e, indexes, manifest.categories);
				if (!placed) {
					throw new CodedError(`The archive names a place it should not: ${e.path}`, "migrateCorrupt", {
						file: e.path,
					});
				}
				// What the entry counts as, and what writing it means, is what its path is: not the label it came with.
				e.category = placed.category;
				if (e.kind === "symlink") continue;
				const stored = zip.entry(e.path);
				if (!stored || stored.size !== e.size) {
					throw new CodedError(`${e.path} is missing from the archive or is not the size it was`, "migrateCorrupt", {
						file: e.path,
					});
				}
				total += stored.size;
				if (total > MAX_TOTAL || (stored.size > RATIO_FROM && stored.compressedSize * MAX_RATIO < stored.size)) {
					throw new CodedError(`${e.path} is far larger than what is stored of it`, "migrateTooLarge", {
						file: e.path,
					});
				}
			}
			const credentialsName = sealed ? CREDENTIALS_PLAIN_NAME : CREDENTIALS_NAME;
			if (manifest.credentials.included && !zip.entry(credentialsName)) {
				throw new CodedError("The encrypted part is missing from the archive", "migrateCorrupt", {
					file: credentialsName,
				});
			}
			return new ImportArchive(file, zip, manifest, sealed);
		} catch (e) {
			await zip.close();
			throw e;
		}
	}

	async close(): Promise<void> {
		await this.zip.close();
	}

	/** Read every file of the archive once and compare its checksum with the manifest's. */
	async verify(env: Pick<ImportEnv, "signal" | "onProgress">): Promise<void> {
		const files = this.manifest.entries.filter((e) => e.kind !== "symlink");
		const total = files.reduce((n, e) => n + e.size, 0);
		let done = 0;
		env.onProgress({
			phase: "verify",
			doneBytes: 0,
			totalBytes: total,
			doneFiles: 0,
			totalFiles: files.length,
			current: "",
		});
		const check = async (path: string, expected: string | undefined): Promise<void> => {
			const hash = createHash("sha256");
			try {
				for await (const chunk of this.zip.stream(path, { signal: env.signal })) {
					hash.update(chunk);
					done += chunk.byteLength;
					env.onProgress({ doneBytes: done, current: path });
				}
			} catch (e) {
				if (env.signal.aborted) throw new ImportCancelled();
				return mapZipError(e, path);
			}
			if (expected !== undefined && hash.digest("hex") !== expected) {
				throw new CodedError(`${path} does not match its checksum`, "migrateCorrupt", { file: path });
			}
		};
		let n = 0;
		for (const e of files) {
			await check(e.path, e.sha256);
			env.onProgress({ doneFiles: ++n });
		}
		if (this.manifest.credentials.included) {
			await check(this.sealed ? CREDENTIALS_PLAIN_NAME : CREDENTIALS_NAME, this.manifest.credentials.sha256);
		}
		// Sealed as a whole: what no read above touched (headers, the directory) is checked too, so that after this
		// nothing in the file can have been changed.
		if (this.sealed) {
			try {
				await this.sealed.authenticateAll(env.signal);
			} catch (e) {
				if (env.signal.aborted) throw new ImportCancelled();
				return mapZipError(e);
			}
		}
	}

	/** Where `from` is and what the archive changes in it, for a person to read before anything is written. */
	async preview(env: ImportEnv): Promise<ImportPreview> {
		const { manifest } = this;
		const map = pathMapOf(manifest, env.loc);
		const roots = relocate(manifest, env.loc);
		const ids = await existingSessionIds(env.loc, roots);
		const buckets = bucketsOf(manifest, map, env.loc);
		const counts = new Map<MigrateCategoryId, ImportCounts & { files: number }>();
		for (const id of MIGRATE_CATEGORIES) counts.set(id, { files: 0, bytes: 0, added: 0, same: 0, differs: 0 });
		const conversations = { total: 0, added: 0, same: 0, differs: 0 };
		let needed = 0;
		for (const e of manifest.entries) {
			const c = counts.get(e.category);
			if (!c) continue;
			c.files++;
			c.bytes += e.size;
			const dest = destinationOf(renamed(e.path, buckets), env.loc, roots);
			const here = dest ? await lstat(dest).catch(() => null) : null;
			const id =
				e.cwd !== undefined && (SESSION_FILE.test(e.path) || SESSION_DIR_FILE.test(e.path))
					? (e.sessionId ?? sessionIdOf(e.path))
					: null;
			const known = id ? ids.get(id) : undefined;
			const status: "added" | "same" | "differs" =
				!here && !known ? "added" : here && here.size === e.size ? "same" : known && !here ? "same" : "differs";
			c[status]++;
			if (status !== "same") needed += e.size;
			if (id) {
				conversations.total++;
				conversations[status]++;
			}
		}
		// The logins are one encrypted part: what it holds is not known without the password, only how much of it there is.
		if (manifest.credentials.included) {
			const logins = counts.get("credentials") as ImportCounts;
			logins.files = manifest.credentials.files ?? 1;
			logins.bytes = manifest.credentials.bytes ?? 0;
		}
		const categories = MIGRATE_CATEGORIES.filter((id) => (counts.get(id)?.files ?? 0) > 0).map((id) => ({
			id,
			...(counts.get(id) as ImportCounts),
		}));
		const warnings: ImportPreview["warnings"] = [];
		if (compareVersions(manifest.source.ompVersion, env.ompVersion) > 0)
			warnings.push({ code: "ompNewer", params: { archive: manifest.source.ompVersion, installed: env.ompVersion } });
		if (compareVersions(manifest.source.serverVersion, env.serverVersion) > 0)
			warnings.push({
				code: "webuiNewer",
				params: { archive: manifest.source.serverVersion, installed: env.serverVersion },
			});
		if (manifest.source.home !== env.loc.home)
			warnings.push({ code: "homeDiffers", params: { from: manifest.source.home, to: env.loc.home } });
		if (manifest.skipped.length) warnings.push({ code: "skipped", params: { count: manifest.skipped.length } });
		// What is written, with room for the copy of a database made on the way and the backup of what it replaces.
		const need = Math.ceil(needed * 1.25) + 64 * 1024 * 1024;
		const free = (env.freeBytes ?? (() => freeBytesAt(env.loc.dataDir)))();
		if (free < need) warnings.push({ code: "diskLow", params: { need, free } });
		return {
			format: manifest.format,
			source: {
				host: manifest.source.host,
				user: manifest.source.user,
				home: manifest.source.home,
				ompVersion: manifest.source.ompVersion,
				serverVersion: manifest.source.serverVersion,
				createdAt: manifest.createdAt,
			},
			home: env.loc.home,
			categories,
			conversations,
			credentials: manifest.credentials.included,
			held: manifest.categories,
			encryption: this.encryption,
			leftOut: manifest.leftOut,
			skipped: manifest.skipped,
			warnings,
		};
	}

	/**
	 * Check what can be checked before anything is touched: the password (the logins are decrypted here, a wrong one is
	 * refused) and that no conversation of this server is working. `run` of the result writes.
	 */
	async prepare(request: ImportRequest, env: ImportEnv): Promise<RunningImport> {
		const apply = new Apply(this, this.zip, request, env);
		await apply.prepare();
		return apply;
	}
}

/**
 * An entry is one the importer may place only if the exporter's own rules would have made it (`placementOf`): a place in
 * omp's or this app's folders, never a login or a secret (those come in the encrypted part), a link only to an installed
 * plugin, a `--session-dir` folder only of the manifest's own list, and in a category the manifest says the file holds
 * (the category is that of the path: the label an entry carries is the manifest's own word and decides nothing). The
 * manifest is a file somebody carried over: what it says is not trusted. The place of the entry, or null when it may not be placed.
 */
function placedEntry(
	e: ManifestEntry,
	sessionDirs: ReadonlySet<number>,
	held: readonly MigrateCategoryId[],
): PathPlacement | null {
	const placed = placementOf(e.path);
	if (!placed || placed.kind === "auth" || placed.kind === "secret" || !held.includes(placed.category)) return null;
	if (e.path.startsWith("sessiondirs/") && !sessionDirs.has(Number(e.path.split("/")[1]))) return null;
	if (e.path.startsWith("omp/plugins/node_modules/")) {
		const link =
			e.kind === "symlink" &&
			PLUGIN_LINK.test(e.path) &&
			typeof e.target === "string" &&
			isAbsolute(e.target) &&
			!e.target.includes("\0") &&
			e.size === 0;
		return link ? placed : null;
	}
	if (e.kind === "symlink") return null;
	return e.kind !== "sqlite" || /\.db$/.test(e.path) ? placed : null;
}

/**
 * Where each `--session-dir` of the archive goes on this Mac: always `<data dir>/session-dirs/<n>`, this app's own folder,
 * whatever the manifest says and wherever the folder was. A folder the manifest chose anywhere else would be a place an
 * archive can write to (`~/.ssh`, `~/Library/LaunchAgents`, `~/.npmrc`: any folder of the user's own); there is no list of
 * safe places short of this one. `session-roots.json` is rewritten to name the new place, and the summary says so.
 */
export function relocate(manifest: Manifest, loc: Locations): Map<number, string> {
	const out = new Map<number, string>();
	for (const { index } of manifest.sessionDirs) out.set(index, join(loc.dataDir, "session-dirs", String(index)));
	return out;
}

/** The old home folder, in each spelling it has, as the new one in the matching spelling. */
function homePairs(manifest: Manifest, loc: Locations): { from: string; to: string }[] {
	const pairs = [{ from: manifest.source.home, to: loc.home }];
	if (manifest.source.homeReal) pairs.push({ from: manifest.source.homeReal, to: loc.homeReal ?? loc.home });
	return pairs;
}

/**
 * The old folders as the new ones: the home, omp's agent directory and this app's data folder. A `--session-dir` is not
 * among them: it moved to this app's folder, but the folders conversations ran in may lie under its old path (a project
 * folder kept beside the transcripts), and those stay where they are.
 */
function pathMapOf(manifest: Manifest, loc: Locations): PathMap {
	return new PathMap([
		...homePairs(manifest, loc),
		{ from: manifest.source.agentDir, to: loc.agentDir },
		{ from: manifest.source.dataDir, to: loc.dataDir },
	]);
}

/** `pathMapOf` with the `--session-dir` folders too: for the one file that lists them (`session-roots.json`). */
function rootsMapOf(manifest: Manifest, loc: Locations, roots: Map<number, string>): PathMap {
	const pairs = [
		{ from: manifest.source.agentDir, to: loc.agentDir },
		{ from: manifest.source.dataDir, to: loc.dataDir },
		...homePairs(manifest, loc),
	];
	for (const { index, dir } of manifest.sessionDirs) pairs.push({ from: dir, to: roots.get(index) ?? dir });
	return new PathMap(pairs);
}

/** The session folder each bucket of the archive has on this Mac (only those that change). */
function bucketsOf(manifest: Manifest, map: PathMap, loc: Locations): Map<string, string> {
	const out = new Map<string, string>();
	for (const e of manifest.entries) {
		const m = SESSION_FILE.exec(e.path);
		if (!m || !e.cwd) continue;
		const prefix = e.path.slice(0, e.path.length - m[0].length + (m[0].startsWith("/") ? 1 : 0));
		const key = `${prefix}sessions/${m[1]}`;
		if (out.has(key)) continue;
		out.set(
			key,
			bucketFor(
				m[1],
				e.cwd,
				map,
				[manifest.source.home, ...(manifest.source.homeReal ? [manifest.source.homeReal] : [])],
				[loc.homeReal ?? loc.home, loc.home],
			),
		);
	}
	return out;
}

/** `path` with its session folder renamed as `buckets` says. */
function renamed(path: string, buckets: Map<string, string>): string {
	const at = path.indexOf("sessions/");
	if (at < 0 || (at > 0 && path[at - 1] !== "/")) return path;
	const rest = path.slice(at + "sessions/".length);
	const slash = rest.indexOf("/");
	if (slash < 0) return path;
	const key = `${path.slice(0, at)}sessions/${rest.slice(0, slash)}`;
	const bucket = buckets.get(key);
	return bucket === undefined ? path : `${path.slice(0, at)}sessions/${bucket}${rest.slice(slash)}`;
}

/** The session ids this Mac has, and where. */
async function existingSessionIds(loc: Locations, roots: Map<number, string>): Promise<Map<string, string>> {
	const ids = new Map<string, string>();
	const scan = (dir: string, flat: boolean): void => {
		let names: import("node:fs").Dirent[];
		try {
			names = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const d of names) {
			if (flat ? d.isFile() : d.isDirectory()) {
				if (flat) {
					const id = sessionIdOf(d.name);
					if (id && d.name.endsWith(".jsonl")) ids.set(id, join(dir, d.name));
				} else scan(join(dir, d.name), true);
			}
		}
	};
	scan(join(loc.agentDir, "sessions"), false);
	const profiles = join(configRootOf(loc.home), "profiles");
	try {
		for (const p of readdirSync(profiles)) scan(join(profiles, p, "agent", "sessions"), false);
	} catch {
		// no profiles
	}
	for (const dir of roots.values()) scan(dir, true);
	return ids;
}

/** The bytes free on the file system `path` is on; unbounded when it cannot be told. */
function freeBytesAt(path: string): number {
	try {
		const fs = statfsSync(path);
		return fs.bavail * fs.bsize;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

/** What `prepare` hands back: the import that is ready to write, and where its backup is (also when it failed). */
export interface RunningImport {
	run(): Promise<ImportSummary>;
	/** The folder the files it changes are copied to, and the lists of what it changed and made; null before it wrote. */
	readonly backup: string | null;
}

/** One `apply`: the state of an import that is under way. */
class Apply implements RunningImport {
	private readonly summary: ImportSummary;
	private readonly notes: ImportNote[] = [];
	private readonly map: PathMap;
	/** `map` with the `--session-dir` folders moved to this app's own: what `session-roots.json` is rewritten with. */
	private readonly rootsMap: PathMap;
	private readonly roots: Map<number, string>;
	private readonly buckets: Map<string, string>;
	private readonly originals = new Map<string, Buffer>();
	private readonly bundle = new Map<string, CredentialFile>();
	private backupDir: string | null = null;
	private readonly changed: string[] = [];
	private readonly created: string[] = [];
	/** What the backup already holds the first state of: a file is copied once, before it is first written. */
	private readonly touched = new Set<string>();
	/** Links this import made: nothing is written through them. */
	private readonly planted = new Set<string>();
	/** Files of the encrypted part that name no place of ours. */
	private readonly refused: string[] = [];
	/** Where a conversation folder was renamed to: the old and the new path of each, for the paths that name one. */
	private readonly bucketDirs: [string, string][] = [];
	private readonly oldMachine: OldMachineValue[] = [];
	private oldMachineCount = 0;
	private readonly missing = new Map<string, number>();
	private ids = new Map<string, string>();
	private done = 0;
	private doneBytes = 0;
	private restored = false;
	private readonly mode: ImportMode;

	constructor(
		private readonly archive: ImportArchive,
		private readonly zip: ZipReader,
		private readonly request: ImportRequest,
		private readonly env: ImportEnv,
	) {
		this.mode = request.mode;
		const manifest = archive.manifest;
		this.roots = relocate(manifest, env.loc);
		this.map = pathMapOf(manifest, env.loc);
		this.rootsMap = rootsMapOf(manifest, env.loc, this.roots);
		this.buckets = bucketsOf(manifest, this.map, env.loc);
		const root = configRootOf(env.loc.home);
		for (const [key, to] of this.buckets) {
			const [, from] = /sessions\/([^/]+)$/.exec(key) ?? [];
			if (!from || from === to) continue;
			const dir = key.startsWith("profiles/")
				? join(root, "profiles", key.split("/")[1], "agent", "sessions")
				: join(env.loc.agentDir, "sessions");
			this.bucketDirs.push([join(dir, from), join(dir, to)]);
		}
		this.summary = {
			mode: request.mode,
			backup: null,
			conversations: { added: 0, kept: 0, updated: 0, replaced: 0 },
			files: { added: 0, kept: 0, replaced: 0, merged: 0, skipped: 0 },
			rewrittenFolders: 0,
			missingFolders: [],
			missingFolderCount: 0,
			oldMachine: [],
			oldMachineCount: 0,
			credentials: { restored: false, providers: 0, files: 0 },
			notes: this.notes,
		};
	}

	private note(code: ImportNote["code"], params: ImportNote["params"] = {}): void {
		this.notes.push({ code, params });
	}

	private check(): void {
		if (this.env.signal.aborted) throw new ImportCancelled();
	}

	/** The password, and the conversations that are working: refused before anything is written. */
	async prepare(): Promise<void> {
		const { manifest } = this.archive;
		const { env, request } = this;

		// 1. The password.
		if (request.credentials) {
			if (!manifest.credentials.included) {
				throw new CodedError("This archive holds no logins", "migrateNoCredentials");
			}
			// Sealed as a whole, the logins were opened with the archive: they are in it as they are, with no password of their own.
			const whole = this.archive.encryption === "whole";
			if (!whole && !request.password) {
				throw new CodedError("A password is needed to restore the logins", "migratePasswordMissing");
			}
			const name = whole ? CREDENTIALS_PLAIN_NAME : CREDENTIALS_NAME;
			let plain: Buffer;
			try {
				const stored = await this.zip.bytes(name, 256 * 1024 * 1024);
				plain = whole ? Buffer.from(stored) : await decrypt(stored, request.password ?? "");
			} catch (e) {
				if (e instanceof WrongPasswordError) throw new CodedError(e.message, "migratePasswordWrong");
				if (e instanceof ZipError) return mapZipError(e, name);
				throw new CodedError(`The encrypted part cannot be read: ${(e as Error).message}`, "migrateCorrupt", {
					file: name,
				});
			}
			const parsed: unknown = JSON.parse(plain.toString("utf8"));
			if (!isRecord(parsed) || !Array.isArray(parsed.files)) {
				throw new CodedError("The encrypted part is damaged", "migrateCorrupt", { file: name });
			}
			for (const f of parsed.files) {
				if (!isRecord(f) || typeof f.path !== "string" || typeof f.data !== "string") continue;
				if (f.kind !== "auth" && f.kind !== "secret" && f.kind !== "config") continue;
				// The encrypted part is as little to be trusted as the manifest: its files go where the exporter takes them from, and
				// only in categories the archive holds: the file's own, and for a secret by its name (a `.env`, a key) the one of the
				// folder it lies in, as the exporter carries it. (The tunnel's two files lie under `home/`, which has no placement:
				// they are logins.)
				const placed = placementOf(f.path);
				const needed: MigrateCategoryId[] = placed
					? [placed.category, ...(placed.origin ? [placed.origin] : [])]
					: ["credentials"];
				if (
					!bundleDestination(f.path, f.kind, env.loc, this.roots) ||
					!needed.every((c) => manifest.categories.includes(c))
				) {
					this.refused.push(f.path);
					continue;
				}
				const file: CredentialFile = {
					path: f.path,
					kind: f.kind,
					data: f.data,
					mode: typeof f.mode === "number" ? f.mode : 0o600,
					mtimeMs: typeof f.mtimeMs === "number" ? f.mtimeMs : Date.now(),
				};
				this.bundle.set(file.path, file);
				if (file.kind === "config") this.originals.set(file.path, Buffer.from(file.data, "base64"));
			}
		}

		// 2. Where the archive's links lead, and whether what it holds fits: a refusal before anything is written.
		for (const e of manifest.entries) {
			if (e.kind === "symlink" && !this.linkTarget(e)) {
				throw new CodedError(`The archive links ${e.path} to a place it should not`, "migrateCorrupt", {
					file: e.path,
				});
			}
		}
		const preview = await this.archive.preview(env);
		const low = preview.warnings.find((w) => w.code === "diskLow");
		if (low) {
			throw new CodedError("There is not enough room on this Mac for what the file holds", "migrateDiskSpace", {
				need: low.params.need,
				free: low.params.free,
			});
		}

		// 3. Conversations of this server must not be writing to the files that are about to change.
		const busy = env.hooks.busy();
		if (busy > 0) {
			throw new CodedError(`${busy} conversation(s) are still working`, "migrateWorking", { count: busy });
		}
	}

	async run(): Promise<ImportSummary> {
		const { manifest } = this.archive;
		const { env, request } = this;
		this.check();
		// The conversation processes are closed so that what omp may hold open can be written: a file of this app's own data
		// (webui) is nothing of theirs, and an import of only that leaves them running.
		const writesOmp = request.credentials || manifest.entries.some((e) => e.category !== "webui");
		const ended = writesOmp ? await env.hooks.endIdle() : 0;
		if (ended > 0) this.note("liveEnded", { count: ended });
		for (const { index, dir } of manifest.sessionDirs) {
			if (!manifest.entries.some((e) => e.path.startsWith(`sessiondirs/${index}/`))) continue;
			this.note("sessionDirMoved", {
				from: tilde(dir, manifest.source.home),
				to: tilde(this.roots.get(index) ?? dir, env.loc.home),
			});
		}
		this.ids = await existingSessionIds(env.loc, this.roots);

		const entries = manifest.entries;
		const files = entries.filter((e) => e.kind !== "symlink");
		const total = files.reduce((n, e) => n + e.size, 0);
		env.onProgress({
			phase: "write",
			doneBytes: 0,
			totalBytes: total,
			doneFiles: 0,
			totalFiles: entries.length,
			current: "",
		});

		// Memory banks are named after the folder their conversations ran in: a folder that moved needs its bank renamed.
		const bankNames = this.bankNames(await this.candidateFolders());

		// 3. Everything but the databases and the links first (a transcript is placed before what hangs on it).
		for (const e of entries) {
			this.check();
			env.onProgress({ current: e.path });
			try {
				if (e.kind === "symlink") await this.link(e);
				else if (e.kind === "sqlite") await this.database(e, bankNames);
				else if (e.kind === "config" || (e.kind === "file" && e.category === "settings")) await this.config(e);
				else await this.plain(e);
			} catch (error) {
				if (error instanceof ImportCancelled || error instanceof CodedError) throw error;
				// The archive was checked before anything was written: a file of it that no longer reads (it changed on disk since)
				// stops the import, with what was written in the backup, rather than being skipped as one file among many.
				if (error instanceof ZipError) {
					if (error.code === "aborted" || env.signal.aborted) throw new ImportCancelled();
					return mapZipError(error, e.path);
				}
				// A full disk fails every file after this one alike: stop, and say so (what was done is in the backup list).
				if (["ENOSPC", "EDQUOT", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
				this.summary.files.skipped++;
				this.note("fileFailed", { path: e.path, error: (error as Error).message.slice(0, 300) });
			}
			this.done++;
			this.doneBytes += e.size;
			env.onProgress({ doneFiles: this.done, doneBytes: this.doneBytes });
		}
		// Files that only the encrypted part has (a configuration that could not be cleaned of its secrets).
		const bundleOnly = [...this.bundle.values()].filter(
			(f) => f.kind === "config" && !entries.some((e) => e.path === f.path),
		);
		for (const f of bundleOnly) await this.fromBundle(f);

		// 4. Logins.
		if (request.credentials) await this.credentials();
		else if (manifest.credentials.included)
			this.summary.credentials = { restored: false, providers: 0, files: 0, reason: "notAsked" };
		else this.summary.credentials = { restored: false, providers: 0, files: 0, reason: "absent" };
		const blanked = entries.reduce((n, e) => n + (e.redacted ?? 0), 0);
		if (!this.restored && blanked > 0) this.note("secretsBlanked", { count: blanked });

		// 5. What the import leaves to the person.
		this.folders(entries);
		this.summary.oldMachine = this.oldMachine.slice(0, 50);
		this.summary.oldMachineCount = this.oldMachineCount;
		// A backup folder that holds nothing that was changed (only what was made) is not a backup: the list of what was
		// made is of use to an import that failed, not to one that did not.
		if (this.backupDir && this.changed.length === 0) {
			rmSync(this.backupDir, { recursive: true, force: true });
			this.backupDir = null;
			try {
				rmdirSync(env.backups);
			} catch {
				// other backups are in it
			}
		}
		this.summary.backup = this.backupDir;
		if (this.backupDir) this.writeNote("complete");
		env.onProgress({ phase: "finish", current: "" });
		return this.summary;
	}

	// ------------------------------------------------------------------ places

	private dest(path: string): string | null {
		return destinationOf(renamed(path, this.buckets), this.env.loc, this.roots);
	}

	get backup(): string | null {
		return this.backupDir;
	}

	/** The backup folder, made when the first file is about to be written: its note and its lists are there from then on. */
	private openBackup(): string {
		if (this.backupDir) return this.backupDir;
		const stamp = (this.env.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
		let dir = join(this.env.backups, stamp);
		for (let n = 2; existsSync(dir); n++) dir = join(this.env.backups, `${stamp}-${n}`);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		this.backupDir = dir;
		writeFileSync(join(dir, "changed.txt"), "");
		writeFileSync(join(dir, "created.txt"), "");
		this.writeNote("incomplete");
		return dir;
	}

	private writeNote(status: "incomplete" | "complete"): void {
		if (!this.backupDir) return;
		const { manifest } = this.archive;
		writeFileSync(
			join(this.backupDir, "backup.json"),
			JSON.stringify(
				{
					app: BACKUP_APP,
					status,
					made: (this.env.now?.() ?? new Date()).toISOString(),
					mode: this.mode,
					archive: { host: manifest.source.host, createdAt: manifest.createdAt },
					restore: RESTORE_NOTE,
				},
				null,
				2,
			),
		);
	}

	/**
	 * Nothing is written through a link: the plugins' folder holds links an archive makes, and a file of the archive that
	 * lies under one would be written wherever it leads. A folder of the user's own that is a link is theirs to have.
	 */
	private async guard(dest: string): Promise<void> {
		const root = configRootOf(this.env.loc.home);
		const plugins = [join(root, "plugins"), join(configRootOf(this.env.loc.homeReal ?? this.env.loc.home), "plugins")];
		for (let at = dirname(dest); at.length > 1 && at !== dirname(at); at = dirname(at)) {
			if (this.planted.has(at)) throw new Error(`${at} is a link that was just made: nothing is written through it`);
			if (!plugins.some((p) => at.startsWith(`${p}/`))) continue;
			const st = await lstat(at).catch(() => null);
			if (st?.isSymbolicLink()) throw new Error(`${at} is a link: nothing is written through it`);
		}
	}

	/**
	 * `dest` is about to be written: what is there is copied to the backup, or, when there is nothing, `dest` is listed as
	 * made. Both are on disk before the write, so that an import that stops anywhere can be undone from what was written.
	 */
	private async touch(dest: string): Promise<void> {
		await this.guard(dest);
		if (this.touched.has(dest)) return;
		this.touched.add(dest);
		const dir = this.openBackup();
		const stat = await lstat(dest).catch(() => null);
		if (!stat) {
			appendFileSync(join(dir, "created.txt"), `${dest}\n`);
			this.created.push(dest);
			return;
		}
		appendFileSync(join(dir, "changed.txt"), `${dest}\n`);
		const target = join(dir, "files", dest);
		mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
		// A pipe, a device or a socket has no contents to keep, and copying is synchronous: opening a pipe nobody writes to
		// would stop the whole server. It is listed as changed with no copy, which a restore passes over.
		if (stat.isSymbolicLink()) symlinkSync(await readlink(dest), target);
		else if (stat.isFile() && /\.db$/.test(dest)) {
			try {
				snapshotDb(dest, target);
			} catch {
				// Not a database SQLite can read: it is copied as it is.
				rmSync(target, { force: true });
				copyFileSync(dest, target, constants.COPYFILE_FICLONE);
			}
		} else if (stat.isFile()) copyFileSync(dest, target, constants.COPYFILE_FICLONE);
		this.changed.push(dest);
	}

	/** A conversation folder that was renamed: the paths that name a file in the old one name it in the new one. */
	private fixSessionPath = (path: string): string => {
		for (const [from, to] of this.bucketDirs) if (path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`;
		return path;
	};

	/** The place a link of the archive leads to, when it is in the plugins' folder (`..` and links resolved by name); else null. */
	private linkTarget(e: ManifestEntry): string | null {
		const target = resolve(this.map.map(e.target ?? ""));
		const roots = [
			join(configRootOf(this.env.loc.home), "plugins"),
			join(configRootOf(this.env.loc.homeReal ?? this.env.loc.home), "plugins"),
		];
		return isAbsolute(e.target ?? "") && roots.some((r) => target.startsWith(`${r}/`)) ? target : null;
	}

	/** Write `data` to `dest` beside it and move it into place. */
	private async place(
		dest: string,
		data: AsyncIterable<Uint8Array> | Uint8Array,
		mode: number,
		mtimeMs: number,
	): Promise<void> {
		await this.guard(dest);
		mkdirSync(dirname(dest), { recursive: true });
		const tmp = `${dest}.ompw-${randomBytes(4).toString("hex")}.tmp`;
		const fh = await open(tmp, "wx", mode & 0o755 || 0o644);
		try {
			if (data instanceof Uint8Array) await fh.write(data);
			else for await (const chunk of data) await fh.write(chunk);
		} catch (e) {
			await fh.close();
			rmSync(tmp, { force: true });
			throw e;
		}
		await fh.close();
		const when = new Date(mtimeMs);
		utimesSync(tmp, when, when);
		renameSync(tmp, dest);
	}

	private stream(path: string): AsyncIterable<Uint8Array> {
		return this.zip.stream(path, { signal: this.env.signal });
	}

	// ------------------------------------------------------------------ entries

	private async link(e: ManifestEntry): Promise<void> {
		const dest = this.dest(e.path);
		const target = this.linkTarget(e);
		if (!dest || !target) {
			this.summary.files.skipped++;
			return;
		}
		const here = await lstat(dest).catch(() => null);
		if (here) {
			const same = here.isSymbolicLink() && (await readlink(dest)) === target;
			if (same || this.mode === "merge") {
				this.summary.files.kept++;
				return;
			}
			await this.touch(dest);
			rmSync(dest, { force: true });
		} else await this.touch(dest);
		mkdirSync(dirname(dest), { recursive: true });
		symlinkSync(target, dest);
		this.planted.add(dest);
		this.summary.files.added++;
		this.note("linksRecreated", { count: 1 });
	}

	/** A file as it is: added when missing, else kept or replaced. */
	private async plain(e: ManifestEntry): Promise<void> {
		if (TRANSCRIPT_PATH.test(e.path)) return this.transcript(e);
		const dest = this.dest(e.path);
		if (!dest) return void this.summary.files.skipped++;
		const here = await lstat(dest).catch(() => null);
		if (!here) {
			await this.touch(dest);
			await this.place(dest, this.stream(e.path), e.mode, e.mtimeMs);
			this.summary.files.added++;
			return;
		}
		// A blob is named by its hash: the same name is the same bytes.
		const same = here.isFile() && here.size === e.size;
		if (same || this.mode === "merge" || e.path.includes("/blobs/")) {
			this.summary.files.kept++;
			return;
		}
		await this.touch(dest);
		await this.place(dest, this.stream(e.path), e.mode, e.mtimeMs);
		this.summary.files.replaced++;
	}

	/** A conversation's transcript: its header's folders rewritten, and what is already here compared with it. */
	private async transcript(e: ManifestEntry): Promise<void> {
		let dest = this.dest(e.path);
		if (!dest) return void this.summary.files.skipped++;
		const isSession = !!(SESSION_FILE.exec(e.path) || SESSION_DIR_FILE.test(e.path));
		const id = isSession ? (e.sessionId ?? sessionIdOf(e.path)) : null;
		const there = id ? this.ids.get(id) : undefined;
		const tally = (k: "added" | "kept" | "updated" | "replaced"): void => {
			if (isSession) this.summary.conversations[k]++;
			if (k === "added") this.summary.files.added++;
			else if (k === "kept") this.summary.files.kept++;
			else this.summary.files.replaced++;
		};
		// The same conversation under another folder name is the same conversation: it is kept once.
		if (there && there !== dest) {
			if (this.mode === "merge") return tally("kept");
			dest = there;
		}
		let rewritten = false;
		const head = rewriteSession(
			this.stream(e.path),
			this.map,
			(h) => {
				if (h.changed) rewritten = true;
			},
			this.fixSessionPath,
		);
		const here = await lstat(dest).catch(() => null);
		if (!here) {
			await this.touch(dest);
			await this.place(dest, head, e.mode, e.mtimeMs);
			if (rewritten && isSession) this.summary.rewrittenFolders++;
			if (id) this.ids.set(id, dest);
			return tally("added");
		}
		const tmp = `${dest}.ompw-${randomBytes(4).toString("hex")}.incoming`;
		try {
			await this.place(tmp, head, e.mode, e.mtimeMs);
			const cmp = await compareFiles(dest, tmp);
			if (cmp.same) return tally("kept");
			// A terminal's omp that holds the conversation writes it: its file is not replaced under it.
			if ((cmp.extends || this.mode === "replace") && id && (await this.env.hooks.openElsewhere(id))) {
				this.note("openElsewhere", { count: 1 });
				return tally("kept");
			}
			if (cmp.extends) {
				await this.touch(dest);
				renameSync(tmp, dest);
				if (rewritten && isSession) this.summary.rewrittenFolders++;
				return tally("updated");
			}
			if (this.mode === "merge") return tally("kept");
			await this.touch(dest);
			renameSync(tmp, dest);
			if (rewritten && isSession) this.summary.rewrittenFolders++;
			return tally("replaced");
		} finally {
			rmSync(tmp, { force: true });
		}
	}

	/**
	 * Files that name a conversation by its path (pins by archived, a permission choice) name its folder as it was: a
	 * conversation whose folder is now named after the new home's spelling is at its new path.
	 */
	private sessionPaths(text: string): string {
		let out = text;
		for (const [from, to] of this.bucketDirs) out = out.replaceAll(`${from}/`, `${to}/`);
		return out;
	}

	private format(path: string): ConfigFormat | "text" {
		if (/\.ya?ml$/.test(path)) return "yaml";
		return /\.json$/.test(path) ? "json" : "text";
	}

	/** A configuration file: its old paths rewritten, then added, merged or replaced. */
	private async config(e: ManifestEntry): Promise<void> {
		const bytes = this.originals.get(e.path) ?? Buffer.from(await this.zip.bytes(e.path));
		await this.configText(e.path, bytes.toString("utf8"), e.mode, e.mtimeMs, e.category);
	}

	private async fromBundle(f: CredentialFile): Promise<void> {
		if (!this.request.credentials) return;
		try {
			await this.configText(f.path, Buffer.from(f.data, "base64").toString("utf8"), f.mode, f.mtimeMs, "settings");
		} catch (e) {
			this.note("fileFailed", { path: f.path, error: (e as Error).message.slice(0, 300) });
		}
	}

	private async configText(
		path: string,
		original: string,
		mode: number,
		mtimeMs: number,
		category: MigrateCategoryId,
	): Promise<void> {
		const dest = this.dest(path);
		if (!dest) return void this.summary.files.skipped++;
		const name = basename(path);
		const format = this.format(path);
		const text = this.sessionPaths(
			(path === "webui/session-roots.json" ? this.rootsMap : this.map).text(original).text,
		);
		const here = await lstat(dest).catch(() => null);
		const old = here ? await readFile(dest, "utf8").catch(() => null) : null;

		const write = async (content: string, how: "added" | "merged" | "replaced"): Promise<void> => {
			await this.touch(dest);
			await this.place(dest, Buffer.from(content, "utf8"), mode, mtimeMs);
			this.summary.files[how]++;
			if (format !== "text") this.scan(dest, content, format, category);
		};

		// This app's own files with their own rules.
		if (path === "webui/ui-prefs.json") return this.prefs(dest, text);
		if (path === "webui/remote.json") return this.remote(text, here !== null, write);

		if (here === null || old === null) {
			if (here !== null && old === null) {
				// Unreadable here: not ours to overwrite in merge.
				if (this.mode === "merge") return void this.summary.files.kept++;
			}
			return write(text, here ? "replaced" : "added");
		}
		if (old === text) return void this.summary.files.kept++;

		if (LIST_FILES.has(name)) {
			let mine: unknown;
			let theirs: unknown;
			try {
				mine = JSON.parse(old);
				theirs = JSON.parse(text);
			} catch {
				return this.mode === "merge" ? void this.summary.files.kept++ : write(text, "replaced");
			}
			const merged = this.mode === "replace" ? unionList(theirs, mine) : unionList(mine, theirs);
			if (JSON.stringify(merged) === JSON.stringify(mine)) return void this.summary.files.kept++;
			return write(`${JSON.stringify(merged)}\n`, "merged");
		}

		if (this.mode === "replace") return write(text, "replaced");
		// What is written for a person to read (instructions, key bindings) is not merged line by line.
		if (format === "text") return void this.summary.files.kept++;
		const mine = parseDoc(old, format);
		const theirs = parseDoc(text, format);
		if (!mine || !theirs) return void this.summary.files.kept++;
		if (!mergeDoc(mine, theirs, "merge", LIST_KEYS[name] ?? {})) return void this.summary.files.kept++;
		return write(serializeDoc(mine, format, old), "merged");
	}

	/** Preferences go through the store that owns them (its revision goes up, and the pages hear of it). */
	private async prefs(dest: string, text: string): Promise<void> {
		const doc = parseDoc(text, "json");
		const values = doc && isRecord(doc.values) ? doc.values : null;
		if (!values) return void this.summary.files.skipped++;
		// The store makes its file when there is none: that file is listed as made before it is.
		const existed = existsSync(dest);
		if (!existed) await this.touch(dest);
		const store = new UiPrefs(this.env.loc.dataDir);
		const have = store.snapshot().values;
		const changes: Record<string, string> = {};
		for (const [k, v] of Object.entries(values)) {
			if (!isPrefKey(k) || typeof v !== "string" || !isValidPref(k, v)) continue;
			if (this.mode === "merge" && have[k] !== null && have[k] !== undefined) continue;
			if (have[k] !== v) changes[k] = v;
		}
		if (Object.keys(changes).length === 0) return void this.summary.files.kept++;
		await this.touch(dest);
		store.apply(changes);
		this.summary.files.merged++;
	}

	/** Remote access comes back switched off: it is a door, and this Mac's tunnel is not the old one's. */
	private async remote(
		text: string,
		exists: boolean,
		write: (content: string, how: "added" | "merged" | "replaced") => Promise<void>,
	): Promise<void> {
		if (exists) {
			this.note("remoteKept");
			return void this.summary.files.kept++;
		}
		const doc = parseDoc(text, "json");
		if (!doc) return void this.summary.files.skipped++;
		doc.enabled = false;
		doc.autostart = false;
		// The tunnel's credentials are on the old Mac unless they came along: without them its id is of no use here.
		if (!this.request.credentials) {
			delete doc.tunnelId;
			delete doc.tunnelName;
		}
		await write(`${JSON.stringify(doc, null, "\t")}\n`, "added");

		this.note("remoteOff");
	}

	// ------------------------------------------------------------------ databases

	/**
	 * The folders a memory bank may be named after: the ones conversations recorded, the ones the prompt history and recaps
	 * were made in (every folder omp was ever used in), the ones an archive without them recorded for its banks, the folders
	 * this app keeps, and the home folder itself.
	 */
	private async candidateFolders(): Promise<Set<string>> {
		const { manifest } = this.archive;
		const cwds = new Set<string>();
		for (const e of manifest.entries) if (e.cwd) cwds.add(e.cwd);
		for (const { dir } of manifest.sessionDirs) cwds.add(dir);
		// What the exporter found for banks whose folders no conversation or history entry of this archive names.
		for (const dir of manifest.bankFolders) cwds.add(dir);
		const { source } = manifest;
		for (const dir of [
			source.home,
			source.homeReal,
			source.agentDir,
			join(source.agentDir, "sessions"),
			source.dataDir,
		]) {
			if (dir) cwds.add(dir);
		}
		const history = manifest.entries.find((e) => e.path === "agent/history.db");
		if (history) {
			const copy = join(this.env.tmp, `${randomBytes(6).toString("hex")}.folders.db`);
			mkdirSync(this.env.tmp, { recursive: true, mode: 0o700 });
			try {
				await this.writeStream(copy, this.stream(history.path));
				for (const dir of foldersOf(copy)) cwds.add(dir);
			} finally {
				rmSync(copy, { force: true });
			}
		}
		return cwds;
	}

	private bankNames(cwds: Set<string>): Map<string, string> {
		const { manifest } = this.archive;
		const out = new Map<string, string>();
		let renamedCount = 0;
		let kept = 0;
		for (const e of manifest.entries) {
			const m = MEMORY_BANK.exec(e.path);
			if (!m || out.has(m[2])) continue;
			const dash = m[2].lastIndexOf("-");
			const name = m[2].slice(0, dash);
			const found = [...cwds].find((c) => bankIsOf(m[2], c));
			if (!found) {
				kept++;
				out.set(m[2], m[2]);
				continue;
			}
			const next = this.map.map(found);
			const bank = next === found ? m[2] : `${name}-${Bun.hash(next).toString(36)}`;
			if (bank !== m[2]) renamedCount++;
			out.set(m[2], bank);
		}
		if (renamedCount > 0) this.note("banksRenamed", { count: renamedCount });
		if (kept > 0) this.note("banksKept", { count: kept });
		return out;
	}

	private async database(e: ManifestEntry, banks: Map<string, string>): Promise<void> {
		let path = e.path;
		const m = MEMORY_BANK.exec(path);
		if (m) path = `${m[1]}${banks.get(m[2]) ?? m[2]}/${m[3]}`;
		const dest = this.dest(path);
		if (!dest) return void this.summary.files.skipped++;
		const tmp = join(this.env.tmp, `${randomBytes(6).toString("hex")}.db`);
		mkdirSync(this.env.tmp, { recursive: true, mode: 0o700 });
		try {
			await this.writeStream(tmp, this.stream(e.path));
			const here = await lstat(dest).catch(() => null);
			if (basename(e.path) === "history.db") {
				rewriteColumnsAt(
					tmp,
					[
						{ table: "history", column: "cwd" },
						{ table: "session_recaps", column: "cwd" },
					],
					this.map,
				);
				if (!here) {
					await this.touch(dest);
					mkdirSync(dirname(dest), { recursive: true });
					replaceDbFile(dest, tmp);
					this.summary.files.added++;
				} else {
					// What the merge would change is found on a copy first: an archive that adds nothing leaves the
					// database, and the backup folder, alone.
					const probe = join(this.env.tmp, `${randomBytes(6).toString("hex")}.probe.db`);
					snapshotDb(dest, probe);
					const would = mergeHistory(probe, tmp, this.mode).changes;
					rmSync(probe, { force: true });
					if (would === 0) return void this.summary.files.kept++;
					await this.touch(dest);
					mergeHistory(dest, tmp, this.mode);
					this.summary.files.merged++;
				}
				return;
			}
			// A memory bank: the database as a whole. A bank both Macs have is kept here, or replaced in `replace`.
			if (!here) {
				await this.touch(dest);
				mkdirSync(dirname(dest), { recursive: true });
				replaceDbFile(dest, tmp);
				this.summary.files.added++;
			} else if (this.mode === "replace") {
				await this.touch(dest);
				replaceDbFile(dest, tmp);
				this.summary.files.replaced++;
			} else this.summary.files.kept++;
		} finally {
			rmSync(tmp, { force: true });
		}
	}

	private async writeStream(path: string, data: AsyncIterable<Uint8Array>): Promise<void> {
		const fh = await open(path, "wx", 0o600);
		try {
			for await (const chunk of data) await fh.write(chunk);
		} finally {
			await fh.close();
		}
	}

	// ------------------------------------------------------------------ logins

	private async credentials(): Promise<void> {
		let providers = 0;
		let count = 0;
		mkdirSync(this.env.tmp, { recursive: true, mode: 0o700 });
		for (const path of this.refused) {
			this.note("credentialsFailed", { error: `${path.slice(0, 120)} is no place of the logins` });
		}
		for (const f of this.bundle.values()) {
			if (f.kind === "config") continue;
			const dest = bundleDestination(f.path, f.kind, this.env.loc, this.roots);
			if (!dest) continue;
			try {
				const data = Buffer.from(f.data, "base64");
				if (f.kind === "auth") {
					const tmp = join(this.env.tmp, `${randomBytes(6).toString("hex")}.auth.db`);
					writeFileSync(tmp, data, { mode: 0o600 });
					try {
						await this.touch(dest);
						mkdirSync(dirname(dest), { recursive: true });
						const result = restoreAuth(dest, tmp, this.mode);
						if ("skipped" in result) {
							if (result.skipped === "omp-older") {
								this.note("credentialsOmpOlder", {
									archive: this.archive.manifest.source.ompVersion,
									installed: this.env.ompVersion,
								});
							} else this.note("credentialsFailed", { error: "agent.db has no logins table" });
							continue;
						}
						providers += result.providers.length;
						count++;
					} finally {
						rmSync(tmp, { force: true });
					}
				} else {
					const here = await lstat(dest).catch(() => null);
					if (here && this.mode === "merge") continue;
					await this.touch(dest);
					mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
					const tmp = `${dest}.ompw-${randomBytes(4).toString("hex")}.tmp`;
					writeFileSync(tmp, data, { mode: 0o600 });
					renameSync(tmp, dest);
					chmodSync(dest, 0o600);
					count++;
				}
			} catch (e) {
				this.note("credentialsFailed", { error: (e as Error).message.slice(0, 300) });
			}
		}
		this.restored = count > 0;
		this.summary.credentials = { restored: this.restored, providers, files: count };
	}

	// ------------------------------------------------------------------ what is left to the person

	/** Values of a written file that name the old machine or a path this Mac does not have. */
	private scan(dest: string, text: string, format: ConfigFormat, category: MigrateCategoryId): void {
		if (category !== "settings" && category !== "plugins") return;
		const doc = parseDoc(text, format);
		if (!doc) return;
		const file = tilde(dest, this.env.loc.home);
		const visit = (value: unknown, key: string): void => {
			if (typeof value === "string") {
				if (this.map.remaining(value) > 0) {
					this.found({ file, key, value, why: "home" });
					return;
				}
				for (const token of absolutePaths(value)) {
					if (!existsSync(token)) this.found({ file, key, value: token, why: "missing" });
				}
			} else if (Array.isArray(value)) {
				for (const [i, x] of value.entries()) visit(x, `${key}[${i}]`);
			} else if (isRecord(value)) for (const [k, x] of Object.entries(value)) visit(x, key ? `${key}.${k}` : k);
		};
		visit(doc, "");
	}

	private found(v: OldMachineValue): void {
		this.oldMachineCount++;
		if (this.oldMachine.length < 200) this.oldMachine.push(v);
	}

	/** The folders conversations ran in, after the rewrite: how many are not on this Mac. */
	private folders(entries: ManifestEntry[]): void {
		const seen = new Set<string>();
		for (const e of entries) {
			if (!e.cwd?.startsWith("/") || (!SESSION_FILE.test(e.path) && !SESSION_DIR_FILE.test(e.path))) continue;
			const mapped = this.map.map(e.cwd);
			if (seen.has(mapped)) continue;
			seen.add(mapped);
			if (!existsSync(mapped)) this.missing.set(mapped, 0);
		}
		const list = [...this.missing.keys()].sort();
		this.summary.missingFolderCount = list.length;
		this.summary.missingFolders = list.slice(0, 20);
	}
}

/** The absolute paths a string names: the whole string when it is one, else its words that start with `/`. */
function absolutePaths(value: string): string[] {
	const v = value.trim();
	if (v.length < 2 || v.length > 4096 || v.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(v)) return [];
	if (v.startsWith("/") && !/\s/.test(v)) return [v];
	if (!/\s/.test(v)) return [];
	return v
		.split(/\s+/)
		.map((w) => w.replace(/^["'`(]+|["'`),;]+$/g, ""))
		.filter((w) => w.startsWith("/") && !w.startsWith("//") && w.length > 1 && !/^\/(dev|proc)\b/.test(w));
}
