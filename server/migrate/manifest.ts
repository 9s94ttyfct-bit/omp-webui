import { CodedError } from "../../shared/error-info.ts";
import { isRecord } from "../../shared/guards.ts";
import {
	isMigrateCategory,
	MIGRATE_CATEGORIES,
	MIGRATE_FORMAT,
	type MigrateCategoryId,
	type MigrateLeftOut,
	type MigrateLeftOutReason,
	type MigrateSecretFile,
} from "../../shared/migrate.ts";

/**
 * The manifest: the archive's table of contents, written last (`manifest.json`) because the checksums of what was
 * copied are only known once it was. An archive comes from a file the person carried over, so everything in it is read
 * as untrusted: shapes, sizes and paths are checked before anything is placed on disk.
 */

export const MANIFEST_NAME = "manifest.json";
/** The logins, encrypted on their own: in a zip that is not sealed as a whole. */
export const CREDENTIALS_NAME = "credentials.enc";
/** The logins, as they are: inside a sealed archive, whose encryption already covers them (a second layer under the same password would add nothing). */
export const CREDENTIALS_PLAIN_NAME = "credentials.json";

export type EntryKind = "file" | "sqlite" | "config" | "symlink";

export interface ManifestEntry {
	/** The path in the archive (see `layout.ts`). */
	path: string;
	category: MigrateCategoryId;
	kind: EntryKind;
	/** Bytes of what is stored (not of the file as it was: a snapshot or a redacted copy differs). */
	size: number;
	sha256: string;
	mode: number;
	mtimeMs: number;
	/** A link's target. */
	target?: string;
	/** For a conversation's transcript: the folder and id its header names (before any rewriting). */
	cwd?: string | null;
	sessionId?: string | null;
	/** Secret values blanked in this copy of a configuration file. */
	redacted?: number;
}

export interface Manifest {
	format: number;
	app: "omp-webui";
	createdAt: string;
	/** What the archive holds (`migrateHeldCategories`): the categories its export was asked for, and `credentials` when it holds the encrypted part. */
	categories: MigrateCategoryId[];
	source: {
		host: string;
		user: string;
		home: string;
		/** The home folder with links resolved, when that is another spelling. */
		homeReal?: string;
		agentDir: string;
		dataDir: string;
		platform: string;
		ompVersion: string;
		serverVersion: string;
	};
	sessionDirs: { index: number; dir: string }[];
	profiles: string[];
	/**
	 * Folders the archive's memory banks are named after, for an archive that holds the memories but not every place a folder is
	 * recorded (the conversations, the prompt history): only those that match a bank of the archive. Empty otherwise.
	 */
	bankFolders: string[];
	entries: ManifestEntry[];
	leftOut: MigrateLeftOut[];
	secretFiles: MigrateSecretFile[];
	skipped: { path: string; error: string }[];
	/** The encrypted part: its checksum and size, and how many files it holds (the count says nothing of what they are). */
	credentials: { included: boolean; sha256?: string; bytes?: number; files?: number };
}

/**
 * The categories the manifest says the archive holds. An archive made before they were recorded was a whole export: every
 * data category, and the logins when it holds them. One that records them lists each at most once, names only categories
 * there are, and lists `credentials` exactly when it holds the encrypted part.
 */
function heldCategories(value: unknown, credentialsIncluded: boolean): MigrateCategoryId[] {
	if (value === undefined) {
		return MIGRATE_CATEGORIES.filter((id) => id !== "credentials" || credentialsIncluded);
	}
	if (!Array.isArray(value) || value.length > MIGRATE_CATEGORIES.length) bad("categories");
	const named = new Set<MigrateCategoryId>();
	for (const id of value) {
		if (!isMigrateCategory(id) || named.has(id)) bad("categories");
		named.add(id);
	}
	if (named.has("credentials") !== credentialsIncluded) bad("categories");
	return MIGRATE_CATEGORIES.filter((id) => named.has(id));
}

const MAX_ENTRIES = 2_000_000;
const SHA256 = /^[0-9a-f]{64}$/;
const REASONS: MigrateLeftOutReason[] = ["cache", "rebuilt", "machine", "runtime", "redownload", "secret", "unknown"];

function bad(why: string): never {
	throw new CodedError(`The archive's manifest is damaged: ${why}`, "migrateCorrupt", { file: "manifest.json" });
}

const str = (v: unknown, what: string, max = 4096): string => {
	if (typeof v !== "string" || v.length > max) bad(what);
	return v;
};
const num = (v: unknown, what: string): number => {
	if (typeof v !== "number" || !Number.isFinite(v) || v < 0) bad(what);
	return v;
};

/** The manifest in `value`, checked. A format newer than this version's is refused with its own error, before anything else is read. */
export function parseManifest(value: unknown): Manifest {
	if (!isRecord(value)) bad("it is not an object");
	const format = num(value.format, "format");
	if (format > MIGRATE_FORMAT) {
		throw new CodedError(
			`This archive was made by a newer omp-webui (format ${format}; this version reads up to ${MIGRATE_FORMAT}). Update omp-webui and open it again.`,
			"migrateNewerFormat",
			{ format, supported: MIGRATE_FORMAT },
		);
	}
	if (value.app !== "omp-webui") bad("it was not made by omp-webui");
	const source = value.source;
	if (!isRecord(source)) bad("source");
	if (!Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) bad("entries");
	const entries: ManifestEntry[] = value.entries.map((e: unknown): ManifestEntry => {
		if (!isRecord(e)) bad("an entry is not an object");
		const path = str(e.path, "path", 2048);
		if (!isMigrateCategory(e.category)) bad(`category of ${path}`);
		if (e.kind !== "file" && e.kind !== "sqlite" && e.kind !== "config" && e.kind !== "symlink") bad(`kind of ${path}`);
		const sha = str(e.sha256, `checksum of ${path}`, 64);
		if (e.kind !== "symlink" && !SHA256.test(sha)) bad(`checksum of ${path}`);
		return {
			path,
			category: e.category,
			kind: e.kind,
			size: num(e.size, `size of ${path}`),
			sha256: sha,
			mode: num(e.mode, `mode of ${path}`),
			mtimeMs: num(e.mtimeMs, `time of ${path}`),
			target: e.target === undefined ? undefined : str(e.target, `target of ${path}`),
			cwd: typeof e.cwd === "string" ? e.cwd.slice(0, 4096) : null,
			sessionId: typeof e.sessionId === "string" ? e.sessionId.slice(0, 256) : null,
			redacted: typeof e.redacted === "number" ? e.redacted : undefined,
		};
	});
	const list = <T>(v: unknown, what: string, map: (x: unknown) => T): T[] => {
		if (v === undefined) return [];
		if (!Array.isArray(v) || v.length > MAX_ENTRIES) bad(what);
		return v.map(map);
	};
	const credentials = isRecord(value.credentials) ? value.credentials : {};
	const included = credentials.included === true;
	const categories = heldCategories(value.categories, included);
	// An entry of a category the manifest does not say it holds is a file the person never chose to put in: not read as one.
	for (const e of entries)
		if (!categories.includes(e.category)) bad(`${e.path} is in a category the archive does not hold`);
	return {
		categories,
		format,
		app: "omp-webui",
		createdAt: str(value.createdAt, "createdAt", 64),
		source: {
			host: str(source.host, "host", 256),
			user: str(source.user ?? "", "user", 256),
			home: str(source.home, "home"),
			homeReal:
				typeof source.homeReal === "string" && source.homeReal !== source.home
					? source.homeReal.slice(0, 4096)
					: undefined,
			agentDir: str(source.agentDir, "agentDir"),
			dataDir: str(source.dataDir, "dataDir"),
			platform: str(source.platform ?? "", "platform", 64),
			ompVersion: str(source.ompVersion ?? "unknown", "ompVersion", 64),
			serverVersion: str(source.serverVersion ?? "unknown", "serverVersion", 64),
		},
		sessionDirs: list(value.sessionDirs, "sessionDirs", (x) => {
			if (!isRecord(x)) bad("a session folder");
			return { index: num(x.index, "index"), dir: str(x.dir, "dir") };
		}),
		profiles: list(value.profiles, "profiles", (x) => str(x, "profile", 256)),
		bankFolders: list(value.bankFolders, "bankFolders", (x) => str(x, "a bank folder")),
		entries,
		leftOut: list(value.leftOut, "leftOut", (x) => {
			if (!isRecord(x)) bad("a left-out entry");
			const reason = REASONS.find((r) => r === x.reason);
			if (!reason) bad("a reason");
			return { path: str(x.path, "path"), reason, bytes: num(x.bytes, "bytes") };
		}),
		secretFiles: list(value.secretFiles, "secretFiles", (x) => {
			if (!isRecord(x)) bad("a secret file");
			return { path: str(x.path, "path"), values: num(x.values, "values") };
		}),
		skipped: list(value.skipped, "skipped", (x) => {
			if (!isRecord(x)) bad("a skipped file");
			return { path: str(x.path, "path"), error: str(x.error, "error", 1024) };
		}),
		credentials: {
			included,
			sha256:
				typeof credentials.sha256 === "string" && SHA256.test(credentials.sha256) ? credentials.sha256 : undefined,
			bytes: typeof credentials.bytes === "number" ? credentials.bytes : undefined,
			files: typeof credentials.files === "number" ? credentials.files : undefined,
		},
	};
}
