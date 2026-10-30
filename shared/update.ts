/**
 * The app's own updates (#571): what the server knows about a newer release of omp-webui itself, and how an install of
 * it is going. The server computes all of it (`server/update/`) and the page shows it; versions are compared with
 * `compareVersions` (`shared/omp-install.ts`) so both agree.
 *
 * Releases are public: the check needs no GitHub login. A release that cannot be reached (the repository is private,
 * or has none) is a state to show quietly, never an error to retry in a loop.
 */

/** The repository whose releases the app updates from. */
export const UPDATE_REPO = "9s94ttyfct-bit/omp-webui";

/** The release notes of a release, one per language (the body has a `## English` and a `## 中文` section). */
export interface UpdateNotes {
	/** Markdown. Empty when the release has no English section and no notes at all. */
	en: string;
	/** Markdown. Empty when the release has no 中文 section: show `en`. */
	zh: string;
}

/** The newest published release the last check saw. */
export interface AppRelease {
	/** `v0.12.0` */
	tag: string;
	/** `0.12.0` */
	version: string;
	/** ISO time the release was published, when GitHub said. */
	publishedAt: string | null;
	/** The release's page (for a manual download, and for notes the page cannot show). */
	url: string;
	notes: UpdateNotes;
	/**
	 * The installer (`omp-webui-vX.Y.Z.dmg`): null while the release has none yet. A tag's release is created by Actions
	 * first, and the dmg is attached minutes later from the Mac that signs it.
	 */
	asset: { name: string; size: number } | null;
}

/** Why the last check did not give an answer. Neutral for `noRelease`, a warning for the others; none is retried at once. */
export type CheckFailure =
	/** 404: no release is reachable without a login (a private repository, or none published). */
	| { code: "noRelease" }
	/** GitHub could not be reached. */
	| { code: "offline" }
	/** The unauthenticated limit is used up (403/429); no request is made before `retryAt` (epoch ms), when GitHub said. */
	| { code: "rateLimited"; retryAt: number | null }
	/** Any other answer. */
	| { code: "http"; status: number }
	/** An answer that is no release this app understands. */
	| { code: "badAnswer" };

/** Why this copy of the app cannot replace itself. */
export type InstallBlock =
	/** Not run as the macOS app bundle (`bun server/main.ts`, the npm package): there is no app to replace. */
	| "notApp"
	/** macOS runs the app from a read-only, randomized copy (it was opened from the downloaded disk image or folder). */
	| "translocated"
	/** The folder the app is in cannot be written by this user. */
	| "notWritable"
	/** The running app is signed ad hoc: there is no signature to hold a download against. */
	| "adHoc";

/** Where an install is. `handover`: everything is staged and the app has been asked to quit; the helper takes over. */
export type UpdatePhase = "downloading" | "verifying" | "staging" | "handover";

export interface UpdateJob {
	id: string;
	tag: string;
	phase: UpdatePhase;
	/** Bytes downloaded so far, and in all (the installer's size). */
	received: number;
	total: number;
	/** Epoch ms. */
	startedAt: number;
}

/**
 * Why an install did not go on, with what the sentence says. Nothing was installed. `params` values are text or
 * numbers the page puts into its own sentence for the code (never a path of this machine except `dir`).
 */
export type UpdateFailureCode =
	/** The installer could not be downloaded: `reason` (a word), `status` (HTTP, when there was one). */
	| "download"
	/** The download is not the size the release lists: `expected`, `actual` (bytes). */
	| "size"
	/** The download's SHA-256 is not the one GitHub lists: `expected`, `actual`. */
	| "digest"
	/** The disk image would not mount: `detail`. */
	| "mount"
	/** The image holds no `omp-webui.app`. */
	| "noApp"
	/** `codesign --verify --deep --strict` refused the app: `detail`. */
	| "signature"
	/** The app is not this app: `expected`, `found` bundle identifiers. */
	| "bundleId"
	/** The app's version is not the release's: `tag`, `found`. */
	| "version"
	/** The app is not newer than the running one (never a downgrade): `found`, `installed`. */
	| "notNewer"
	/** The app is signed by another certificate than the running one: `expected`, `found` (certificate hashes, or `ad hoc`). */
	| "requirement"
	/** The running app is signed ad hoc, so its permissions cannot be kept and nothing can be compared. */
	| "adHoc"
	/** Not enough free space, before the download (3 × the installer, on the data folder's volume and the app's) or for the copy next to the app: `needed`, `free` (bytes). */
	| "space"
	/** The app's folder cannot be written: `dir`. */
	| "notWritable"
	/** The new app could not be copied next to the old one: `detail`. */
	| "stage";

export interface UpdateFailure {
	code: UpdateFailureCode;
	/** The release the install was for. */
	tag: string;
	params: Record<string, string | number>;
}

/** How the last update ended, found after the app started again (the helper wrote it before it left). */
export interface UpdateOutcome {
	ok: boolean;
	from: string;
	to: string;
	/** Epoch ms. */
	at: number;
	/**
	 * What went wrong when `ok` is false, after which the old app was put back and started again:
	 * the app did not quit in time, the new one was not what it should be at the last look, it could not be swapped in,
	 * or it did not start (the old one was put back).
	 */
	problem?: "quitTimeout" | "verify" | "swap" | "didNotStart" | "rollbackFailed";
}

/** What the server tells the page about the app's own updates. */
export interface AppUpdateState {
	/** Names this run of the server; with `rev` it orders states (a page keeps the newest, see `store/omp.ts`). */
	boot: string;
	rev: number;
	/** The version running now. */
	installed: string;
	/** Whether this copy can replace itself, and why not otherwise. */
	install: { allowed: true } | { allowed: false; reason: InstallBlock };
	/** A look at GitHub is under way. */
	checking: boolean;
	/** Epoch ms of the last look that was answered (304 included); null before the first. */
	checkedAt: number | null;
	/** The newest published release the last answered check saw; null before the first answer, or when none is reachable. */
	latest: AppRelease | null;
	/** `latest` is newer than `installed`. */
	newer: boolean;
	/** Why the last look gave no answer; null when it did. */
	failure: CheckFailure | null;
	/** The install under way. */
	job: UpdateJob | null;
	/** The install that was refused or failed last; cleared by a new install or `dismiss`. */
	failed: UpdateFailure | null;
	/** How the last update ended; cleared by `dismiss`. */
	outcome: UpdateOutcome | null;
}

/** The answer of every `/api/update*` route. */
export interface UpdateSnapshot {
	state: AppUpdateState;
}

/**
 * The refusals of `POST /api/update/install` that are no failure of the install itself, as the `code` of a 409 (with an
 * English `error`): `replying` (`params`: `working`, `asking`, `paused`, `waiting` conversations: the page asks the user,
 * and sends the request again with `anyway`), `busy` (an install is under way), `nothingToInstall` (no newer release with an
 * installer is known, or `tag` is not the one known), `blocked` (`params.reason`: an `InstallBlock`).
 */
export type UpdateRefusal = "replying" | "busy" | "nothingToInstall" | "blocked";

/** `POST /api/update/install`. `tag`: the release the user was shown. */
export interface UpdateInstallRequest {
	tag: string;
	/** The user has been told which conversations are replying and went on. */
	anyway?: boolean;
}
