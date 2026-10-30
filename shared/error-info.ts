/**
 * What the server tells the page about an error the user is meant to read, besides its English sentence: a stable
 * `code` and the `params` the sentence is made of. The page words it in its own language from them
 * (`web/src/i18n/errors.ts`, `web/src/lib/error-text.ts`); the English `error` stays for logs, for API users and for a
 * page that does not know the code. omp's own output is not translated and travels inside a parameter (`output`).
 *
 * An `ErrorParams` value is a name, a number or a piece of omp's or the system's own text, never an internal setting
 * path: the page's sentence says what the setting is for ("the oMLX address"), not what it is called in the code.
 */

export const ERROR_CODES = [
	// A change of the Light settings that was refused (server/offline/settings.ts).
	"settingsListInvalid",
	"settingsNameInvalid",
	"settingsAddressInvalid",
	"settingsAddressLinkLocal",
	"settingsOfflineShape",
	"settingsBackendUnknown",
	"settingsBaseUrlsShape",
	"settingsBaseUrlsBackendUnknown",
	"settingsModelShape",
	"settingsModelOfBackend",
	"settingsThinkingUnknown",
	"settingsToolUnknown",
	"settingsToolsNone",
	"settingsAgentsMdShape",
	"settingsModeUnknown",
	"settingsLightModelsUnknown",
	"settingsFieldUnknown",
	// Light with a local server that cannot start (server/offline).
	"offlineUnreachableRefused",
	"offlineUnreachableTimeout",
	"offlineUnreachableOther",
	"offlineKeyWithheld",
	"offlineKeyRefused",
	"offlineModelNotServed",
	"offlineModelNotServedNone",
	"offlineChooseModel",
	"offlineNoModels",
	"offlineProviderMissing",
	"offlineModelsUnreadable",
	"offlineFlagForeignModel",
	// A conversation that cannot be switched to the other mode now (server/live.ts).
	"modeSwitchPaused",
	"modeSwitchUnsaved",
	// A folder the folder picker cannot list (server/dirs.ts).
	"dirRelative",
	"dirNotFound",
	"dirNotFolder",
	"dirNoAccess",
	"dirNotWritable",
	// The projects folder (server/main.ts, /api/projects): moved from a page that is not at this computer, or named wrongly.
	"projectsNotHere",
	"projectsFolderShape",
	// The sidebar's project groups (#636): a name or a project a change cannot use.
	"groupNameInvalid",
	"groupProjectInvalid",
	"groupUnknown",
	"groupFull",
	// An omp install or update that did not finish (server/omp/lifecycle.ts).
	"jobCancelled",
	"jobCouldNotRun",
	"jobExited",
	"jobExitedOutput",
	"jobStopped",
	"jobStoppedOutput",
	"installNotFound",
	"installDoesNotRun",
	"updateDoesNotRun",
	"updateStillOld",
	"jobNotSettled",
	// A paused conversation that omp may not be run for (server/live.ts).
	"paused",
	"pausedRetryDue",
	// A conversation that cannot be resumed where it ran (server/live.ts): `folder` is the one it recorded, `nearest` the closest that exists.
	"sessionFolderGone",
	"sessionFolderUnknown",
	// A closed conversation's omp that has not ended yet (server/live.ts).
	"stillFinishing",
	// Side questions (server/omp/btw-fork.ts): a conversation already has the most the server keeps waiting.
	"btwTooMany",
	// Moving to another computer (server/migrate): an export or an import that cannot go on.
	"migrateBusy",
	"migrateWorking",
	"migrateNothingChosen",
	"migrateCategories",
	"migratePasswordMissing",
	"migratePasswordShort",
	"migratePasswordWrong",
	"migratePasswordNeeded",
	"migrateFilePasswordWrong",
	"migrateTampered",
	"migrateNotArchive",
	"migrateCorrupt",
	"migrateNewerFormat",
	"migrateNotReady",
	"migrateUpload",
	"migrateNoCredentials",
	"migrateRunning",
	"migrateTooLarge",
	"migrateDiskSpace",
	"migrateNoBackup",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** The values of a sentence: names, numbers and text of omp's or the system's own. */
export type ErrorParams = Record<string, string | number>;

export interface ErrorInfo {
	code: ErrorCode;
	params?: ErrorParams;
}

/** An error whose sentence the page words itself: `message` is the English one. */
export class CodedError extends Error {
	readonly params: ErrorParams;
	constructor(
		message: string,
		readonly code: ErrorCode,
		params: ErrorParams = {},
	) {
		super(message);
		this.params = params;
	}
}

/** The code and parameters of `e` when it is a `CodedError`, else nothing. */
export function errorInfoOf(e: unknown): ErrorInfo | null {
	return e instanceof CodedError ? { code: e.code, params: e.params } : null;
}

export function isErrorCode(code: unknown): code is ErrorCode {
	return typeof code === "string" && (ERROR_CODES as readonly string[]).includes(code);
}
