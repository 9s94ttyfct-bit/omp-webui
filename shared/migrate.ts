/**
 * Moving everything to another computer: one archive written on the old Mac, read on the new one (#572).
 *
 * The server owns the work (`server/migrate/`); the page (Settings › Migration) shows what is included, starts an export
 * or an import and follows its progress. Both sides speak of it in these shapes. Only the page of this machine may ask:
 * an archive holds every conversation, and an import rewrites the user's own files, so none of it is reachable through
 * the tunnel.
 */

/** The archive's format. An archive of a higher number is refused: it may hold things this version cannot place. */
export const MIGRATE_FORMAT = 1;

/** The extension of an archive: `omp-webui-migration-<host>-<date>.ompw`, a zip file with a manifest. */
export const MIGRATE_EXTENSION = ".ompw";

/** The shortest password an archive may be encrypted with. */
export const MIGRATE_MIN_PASSWORD = 8;

/** What of an archive is encrypted: all of it, only the logins, nothing. */
export type MigrateEncryption = "whole" | "logins" | "none";

/** The name of the archive written on `host` on `date`. */
export function migrateArchiveName(host: string, date: Date): string {
	const safe = host.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "mac";
	return `omp-webui-migration-${safe}-${date.toISOString().slice(0, 10)}${MIGRATE_EXTENSION}`;
}

/**
 * What the archive is made of, as the page names it. `credentials` is only there when the person asked for it.
 *
 * - `conversations`: sessions with their subagent and advisor transcripts and forks, the images they keep, pins, and the
 *   folders conversations were started in with `--session-dir` or `--profile`.
 * - `history`: prompt history (with the titles and recaps of conversations) and the word predictor.
 * - `memories`: omp's memory banks.
 * - `settings`: config.yml, models, MCP servers, LSP, keybindings, and the instruction files (AGENTS.md, RULES.md…).
 * - `customization`: skills (the user's and the ones omp manages), agents, commands, rules, prompts, hooks, tools,
 *   extensions and themes.
 * - `plugins`: the plugin registry, the marketplaces and the installed plugins.
 * - `webui`: this app's own data: preferences, favourites, archived conversations, permission choices, the guard's
 *   settings, Full / Light mode, the folders it started omp with, remote access settings (switched off on import).
 * - `credentials`: logins (OAuth tokens, API keys), omp's secrets file, remote access secrets, and the secret values
 *   found inside the other files. Encrypted with a password.
 */
export const MIGRATE_CATEGORIES = [
	"conversations",
	"history",
	"memories",
	"settings",
	"customization",
	"plugins",
	"webui",
	"credentials",
] as const;
export type MigrateCategoryId = (typeof MIGRATE_CATEGORIES)[number];

export function isMigrateCategory(value: unknown): value is MigrateCategoryId {
	return typeof value === "string" && (MIGRATE_CATEGORIES as readonly string[]).includes(value);
}

/**
 * The categories the person picks among when exporting: all but `credentials`, whose switch asks for a password and
 * stays off unless it is turned on (`ExportRequest.credentials`).
 */
export type MigrateDataCategoryId = Exclude<MigrateCategoryId, "credentials">;
export const MIGRATE_DATA_CATEGORIES: readonly MigrateDataCategoryId[] = MIGRATE_CATEGORIES.filter(
	(id): id is MigrateDataCategoryId => id !== "credentials",
);

export function isMigrateDataCategory(value: unknown): value is MigrateDataCategoryId {
	return isMigrateCategory(value) && value !== "credentials";
}

/**
 * The categories an archive holds, in the order of `MIGRATE_CATEGORIES`: the ones picked (every data category when none
 * were named) and `credentials` when the logins are asked for. What the export carries, what the manifest records and
 * what the page shows afterwards all come from this one list.
 */
export function migrateHeldCategories(request: {
	credentials: boolean;
	categories?: readonly MigrateDataCategoryId[];
}): MigrateCategoryId[] {
	const picked = new Set<MigrateCategoryId>(request.categories ?? MIGRATE_DATA_CATEGORIES);
	if (request.credentials) picked.add("credentials");
	return MIGRATE_CATEGORIES.filter((id) => picked.has(id));
}

export interface MigrateCategory {
	id: MigrateCategoryId;
	files: number;
	bytes: number;
}

/**
 * Why something is not in the archive:
 * - `cache`: made again by omp or this app when it is needed
 * - `rebuilt`: a database omp or this app fills from the conversations again (usage statistics, the search index)
 * - `machine`: belongs to this computer (its identity, its terminals, its remote hosts)
 * - `runtime`: what is running right now (sockets, locks, logs, downloaded programs)
 * - `redownload`: downloaded from the internet (marketplace catalogues, skill repositories)
 * - `secret`: a login or secret, and credentials were not asked for
 * - `unknown`: a file this version does not know how to place
 */
export type MigrateLeftOutReason = "cache" | "rebuilt" | "machine" | "runtime" | "redownload" | "secret" | "unknown";

export interface MigrateLeftOut {
	/** Where it is, with `~` for the home folder. */
	path: string;
	reason: MigrateLeftOutReason;
	bytes: number;
}

/** A configuration file with secret values in it: they are blanked in the archive unless credentials are exported. */
export interface MigrateSecretFile {
	/** Where it is, with `~` for the home folder. */
	path: string;
	/** How many values were found (never the values). */
	values: number;
}

/** A configuration file of the plan with secret values in it, and the category it is in (an export that leaves the category out leaves its secrets out too). */
export interface MigratePlanSecretFile extends MigrateSecretFile {
	category: MigrateCategoryId;
}

/** What `GET /api/migrate/plan` answers: what an export would hold, and what it would leave out. */
export interface MigratePlan {
	host: string;
	home: string;
	ompVersion: string;
	serverVersion: string;
	categories: MigrateCategory[];
	totalFiles: number;
	totalBytes: number;
	leftOut: MigrateLeftOut[];
	secretFiles: MigratePlanSecretFile[];
	/** `--session-dir` folders conversations are kept in (they are part of the archive). */
	sessionDirs: string[];
	/** `--profile` names whose agent directories are part of the archive. */
	profiles: string[];
	/** An export or an import is running: only one runs at a time. */
	busy: boolean;
}

export type MigratePhase = "scan" | "copy" | "verify" | "backup" | "write" | "finish";

export interface MigrateProgress {
	phase: MigratePhase;
	doneBytes: number;
	totalBytes: number;
	doneFiles: number;
	totalFiles: number;
	/** What is being worked on, as a short path. */
	current: string;
}

/** What went wrong, worded like every other error of the server (`shared/error-info.ts`). */
export interface MigrateErrorInfo {
	message: string;
	code?: string;
	params?: Record<string, string | number>;
}

export type ExportState = "running" | "done" | "failed" | "cancelled";

export interface ExportRequest {
	/** Put the logins in the archive. Off unless the person turns it on. */
	credentials: boolean;
	/** Encrypt the whole archive (every file in it and its manifest) with the password, not only the logins. */
	wholeFile?: boolean;
	/** Required (and at least `MIGRATE_MIN_PASSWORD` long) when `credentials` or `wholeFile` is on; never stored. */
	password?: string;
	/**
	 * What to put in the archive: the data categories ticked (see `MIGRATE_DATA_CATEGORIES`). Left out, every one of them goes
	 * in. Refused when it names `credentials` (that is `credentials`, above), anything else that is no category, or when it is
	 * empty and `credentials` is off: nothing would be exported. The logins the person did not tick, and the secret values
	 * inside files of categories left out, are not in the archive either.
	 */
	categories?: MigrateDataCategoryId[];
}

export interface ExportStatus {
	state: ExportState;
	credentials: boolean;
	/** The archive is encrypted as a whole. */
	wholeFile: boolean;
	/** What the archive holds (`migrateHeldCategories`): the manifest records the same list. */
	categories: MigrateCategoryId[];
	progress: MigrateProgress;
	error?: MigrateErrorInfo;
	/** The finished archive: `GET /api/migrate/export/file` downloads it. */
	file?: { name: string; bytes: number };
	/** Files that could not be read while the archive was made (they vanished or are not the user's to read). */
	skipped: { path: string; error: string }[];
	startedAt: number;
}

export type ImportMode = "merge" | "replace";

/** How many of an archive's files a Mac has already: new ones are added, the same are left, different ones are in conflict. */
export interface ImportCounts {
	files: number;
	bytes: number;
	added: number;
	same: number;
	differs: number;
}

export type ImportWarningCode =
	/** The archive was written by a newer omp than the one here: its data may be in a layout this omp does not read. */
	| "ompNewer"
	/** …by a newer omp-webui. */
	| "webuiNewer"
	/** The home folder differs: paths under it are rewritten. */
	| "homeDiffers"
	/** Some files could not be read when the archive was made. */
	| "skipped"
	/** There is less room on this Mac than the file needs: the import is refused until there is more. */
	| "diskLow";

export interface ImportWarning {
	code: ImportWarningCode;
	params: Record<string, string | number>;
}

/** What the archive holds, checked and compared with this Mac: shown before anything is written. */
export interface ImportPreview {
	format: number;
	source: {
		host: string;
		user: string;
		home: string;
		ompVersion: string;
		serverVersion: string;
		createdAt: string;
	};
	/** This Mac's home folder. */
	home: string;
	categories: (MigrateCategory & ImportCounts)[];
	/** The conversations alone (session files, not the transcripts beside them). */
	conversations: { total: number; added: number; same: number; differs: number };
	/** The archive holds logins: restoring them asks for the password, unless the archive is encrypted as a whole. */
	credentials: boolean;
	/** How the archive is encrypted: `whole` (everything, opened with the password before this preview), `logins` (only the logins), `none`. */
	encryption: MigrateEncryption;
	leftOut: MigrateLeftOut[];
	skipped: { path: string; error: string }[];
	warnings: ImportWarning[];
	/**
	 * The categories the file holds, as its manifest records them: an import writes nothing outside them. A file made before
	 * the manifest recorded them is a whole export: every data category, and the logins when it holds them.
	 */
	held: MigrateCategoryId[];
}

export type ImportState = "uploading" | "locked" | "verifying" | "ready" | "applying" | "done" | "failed";

/** `POST /api/migrate/import/unlock`. */
export interface ImportUnlockRequest {
	password: string;
}

export interface ImportRequest {
	mode: ImportMode;
	/** Restore the logins and the secret values of the archive. Needs `password` unless the archive is encrypted as a whole (it was opened with it already). */
	credentials: boolean;
	password?: string;
}

/** A value that still points at the old machine after the import, so that the person can fix it. */
export interface OldMachineValue {
	/** The file, with `~` for the home folder. */
	file: string;
	/** Where in the file (a key path such as `servers.gopls.command`); empty for a file read as text. */
	key: string;
	value: string;
	/** `home`: it still names the old home folder; `missing`: a path that is not on this Mac. */
	why: "home" | "missing";
}

export interface ImportSummary {
	mode: ImportMode;
	/** The folder everything this import changed was first copied to (null when nothing existing was changed). */
	backup: string | null;
	conversations: { added: number; kept: number; updated: number; replaced: number };
	/** Files by what happened to them. */
	files: { added: number; kept: number; replaced: number; merged: number; skipped: number };
	/** Conversations whose recorded folder was rewritten from the old home to this one. */
	rewrittenFolders: number;
	/** Folders conversations ran in that this Mac does not have (yet): the first ones. */
	missingFolders: string[];
	missingFolderCount: number;
	/** Values in configuration files that point at the old machine (the first ones). */
	oldMachine: OldMachineValue[];
	oldMachineCount: number;
	credentials: { restored: boolean; providers: number; files: number; reason?: "notAsked" | "omp-older" | "absent" };
	/** What the import did not do or did differently, and why, in the order it came up. */
	notes: ImportNote[];
}

/**
 * Things an import tells the person, by code (the page words them in its language):
 * - `credentialsOmpOlder` {archive, installed}: the logins were not restored: this Mac's omp keeps them in an older layout
 * - `credentialsFailed` {error}: the logins could not be put in place
 * - `secretsBlanked` {count}: values in configuration files were left blank (credentials were not restored)
 * - `remoteOff` {}: remote access settings came with the archive and are switched off: turn them on in Settings
 * - `remoteKept` {}: this Mac has remote access settings of its own, which stay
 * - `sessionDirMoved` {from, to}: a `--session-dir` folder of the file is kept in this app's own folder (`to`), whatever it was
 * - `banksRenamed` {count}: memory banks were renamed for the folders' new paths
 * - `banksKept` {count}: memory banks of folders that could not be identified keep their old names
 * - `liveEnded` {count}: idle conversation processes were closed so that their files could be written
 * - `openElsewhere` {count}: conversations open in a terminal were left as they are
 * - `linksRecreated` {count}: links of installed plugins were made again for this Mac's home
 * - `fileFailed` {path, error}: one file could not be written; the rest went on
 */
export type ImportNoteCode =
	| "credentialsOmpOlder"
	| "credentialsFailed"
	| "secretsBlanked"
	| "remoteOff"
	| "remoteKept"
	| "sessionDirMoved"
	| "banksRenamed"
	| "banksKept"
	| "liveEnded"
	| "openElsewhere"
	| "linksRecreated"
	| "fileFailed";

export interface ImportNote {
	code: ImportNoteCode;
	params: Record<string, string | number>;
}

export interface ImportStatus {
	state: ImportState;
	name: string;
	/** Bytes of the archive received so far, and its size. */
	received: number;
	size: number;
	progress: MigrateProgress;
	error?: MigrateErrorInfo;
	preview?: ImportPreview;
	summary?: ImportSummary;
	mode?: ImportMode;
	/** The folder the files an import changed were copied to, and the lists of what it changed and made: also when it failed. */
	backup?: string | null;
	/** The import that failed was undone from its backup. */
	restored?: boolean;
	startedAt: number;
}

/** What `GET /api/migrate/state` answers: the export and the import that are under way or have just ended, if any. */
export interface MigrateState {
	export: ExportStatus | null;
	import: ImportStatus | null;
}

export const MIGRATE_API = {
	plan: "/api/migrate/plan",
	state: "/api/migrate/state",
	/** POST `ExportRequest` → `ExportStatus`. */
	export: "/api/migrate/export",
	exportCancel: "/api/migrate/export/cancel",
	/** GET: the finished archive, as a download. */
	exportFile: "/api/migrate/export/file",
	/** POST: forget the finished export and delete its archive. */
	exportDiscard: "/api/migrate/export/discard",
	/** POST `{ name, size }` → `ImportStatus`. */
	importBegin: "/api/migrate/import/begin",
	/** POST raw bytes, `?offset=<where this piece goes>` → `ImportStatus`. */
	importChunk: "/api/migrate/import/chunk",
	/** POST: check the archive (manifest, every checksum), then compare it with this Mac → `ImportStatus` with a preview. */
	importVerify: "/api/migrate/import/verify",
	/** POST `{ password }` → `ImportStatus`: opens an archive that is encrypted as a whole (state `locked`); a wrong password is refused and the archive stays locked. */
	importUnlock: "/api/migrate/import/unlock",
	/** POST `ImportRequest` → `ImportStatus`. */
	importApply: "/api/migrate/import/apply",
	/** POST: put back what a failed import changed, and remove what it made. */
	importRestore: "/api/migrate/import/restore",
	/** POST: drop the uploaded archive (before or after the import). */
	importDiscard: "/api/migrate/import/discard",
} as const;

/** The largest piece of an archive one request carries: the server's request limit is 128 MiB. */
export const MIGRATE_CHUNK_BYTES = 32 * 1024 * 1024;
