import type { ErrorCode } from "@shared/error-info.ts";

/**
 * Errors the server explains with a code and parameters (`shared/error-info.ts`), worded here so that they read in the
 * page's language and never name a setting by its key path. `{name}` is a local server's name (oMLX, Ollama, LM Studio),
 * made from the `backend` parameter; text of omp's or the system's own (`output`, `reason`, `error`) stays as it was.
 */
export const en = {
	// A change of the Light settings that was refused
	settingsListInvalid: "{field} must be a list of names.",
	settingsNameInvalid: "A name in {field} is not valid.",
	settingsAddressInvalid: "The {name} address must be an address like http://127.0.0.1:11434/v1.",
	settingsAddressLinkLocal: "The {name} address is a link-local address ({host}), where no model server listens.",
	settingsOfflineShape: "The Light settings must be an object.",
	settingsBackendUnknown: "The local model server must be one of: {backends}.",
	settingsBaseUrlsShape: "The server addresses must be an object.",
	settingsBaseUrlsBackendUnknown: "{name} is not a local model server this app knows.",
	settingsModelShape: "The model must be empty (automatic) or a model id of the local server, like ollama/llama3.",
	settingsModelOfBackend: "The model must be empty (automatic) or one of {name}'s.",
	settingsThinkingUnknown: "That is not a thinking level.",
	settingsToolUnknown: "{tool} is not a tool Light can use.",
	settingsToolsNone: "Light needs at least one tool.",
	settingsAgentsMdShape: "Loading AGENTS.md must be on or off.",
	settingsModeUnknown: "The mode must be Full or Light.",
	settingsLightModelsUnknown: "Light's models must be your own models or a local server's.",
	settingsFieldUnknown: "{setting} is not a Light setting.",

	// Light on a local server that cannot start
	offlineUnreachableRefused:
		"{name} is not reachable at {url} (connection refused). Start the {name} server, or switch to Full mode.",
	offlineUnreachableTimeout:
		"{name} is not reachable at {url} (no answer within {seconds} s). Start the {name} server, or switch to Full mode.",
	offlineUnreachableOther:
		"{name} is not reachable at {url} ({reason}). Start the {name} server, or switch to Full mode.",
	offlineKeyWithheld:
		"{name} at {url} wants an API key (HTTP {status}), and the one in models.yml is not sent there: this address is neither on this computer or its network nor the one models.yml gives the {backend} provider. Put the address in that provider, or use a local one.",
	offlineKeyRefused:
		"{name} at {url} refused its API key (HTTP {status}). Check apiKey of the {backend} provider in models.yml.",
	offlineModelNotServed:
		"{name} does not serve {id} (it serves: {served}). Choose another model in Settings › Full / Light.",
	offlineModelNotServedNone:
		"{name} does not serve {id} (it serves no models). Choose another model in Settings › Full / Light.",
	offlineChooseModel: "Choose a model in Settings › Full / Light: {name} did not list its models.",
	offlineNoModels: "{name} serves no models yet. Load or pull one in {name}, or switch to Full mode.",
	offlineProviderMissing:
		'Light on a local server needs a provider named "{backend}" (with a baseUrl) in {path}; none was found.',
	offlineModelsUnreadable: "{path} could not be read: {reason}",
	offlineFlagForeignModel:
		"Light on a local server runs on {name} models only, but {flag} {value} selects another one. Remove the flag, or switch to Full mode.",

	// A conversation that cannot be switched to the other mode now
	modeSwitchPaused: "This conversation is paused; resume it before switching its mode.",
	modeSwitchUnsaved: "This conversation has no saved session yet; send a message first, then switch its mode.",

	// A folder the folder picker cannot list
	dirRelative: "{path} is not a full path: start it with / or ~.",
	dirNotFound: "{path} does not exist.",
	dirNotFolder: "{path} is not a folder.",
	dirNoAccess: "No permission to open {path}.",
	dirNotWritable: "No permission to make folders in {path}.",
	projectsNotHere: "The projects folder is changed on the computer omp-webui runs on.",
	projectsFolderShape: "Name the folder, or choose the default.",
	// The page words the reason from `problem` (project-groups namespace); this is what a page that does not know it shows.
	groupNameInvalid: "That name cannot be used for a group.",
	groupProjectInvalid: "A project is named by the folder its conversations run in.",
	groupUnknown: "That group is no longer there.",
	groupFull: "The groups hold as many projects as they can. Take one out first.",

	// An omp install or update that did not finish
	jobCancelled: "Cancelled",
	jobCouldNotRun: "Could not run {command}: {reason}",
	jobExited: "{command} exited with code {code}.",
	jobExitedOutput: "{command} exited with code {code}:\n{output}",
	jobStopped: "{command} was stopped before it finished.",
	jobStoppedOutput: "{command} was stopped before it finished:\n{output}",
	installNotFound: "The installer finished, but omp was not found afterwards. Looked in: {dirs}",
	installDoesNotRun: "omp was installed at {bin} but does not run: {error}",
	updateDoesNotRun: "omp was updated but does not run: {error}",
	updateStillOld: "omp update finished, but omp still reports {version}",
	jobNotSettled: "{command} ended while omp-webui was closed, but how it ended could not be read: {reason}",

	// A paused conversation that omp may not be run for
	paused: "This conversation is paused; resume it to continue.",
	pausedRetryDue:
		"This conversation is paused while omp waits to retry a failed turn, and that wait is over: running omp for this would start the retried turn. Resume it to let it retry.",

	// A conversation that cannot be resumed where it ran
	sessionFolderGone: "This conversation ran in {folder}, which no longer exists.",
	sessionFolderUnknown: "This conversation's file does not say which folder it ran in.",

	// A closed conversation's omp that has not ended yet
	stillFinishing:
		"omp is still finishing its work on this conversation after it was closed; try again once it has ended.",

	// Side questions: a conversation already has the most the server keeps waiting
	btwTooMany:
		"Two side questions of this conversation are already waiting: wait for one to be answered, or cancel one.",

	// Moving to another computer
	migrateBusy: "Another export or import is already running; wait for it to end.",
	migrateWorking: "{count} conversations are still working. Wait for them to finish or stop them, then try again.",
	migrateNothingChosen: "Nothing is chosen to export.",
	migrateCategories: "{category} cannot be chosen.",
	migratePasswordMissing: "Enter a password to encrypt the file with.",
	migratePasswordShort: "The password must have at least {min} characters.",
	migratePasswordWrong: "That password does not open the logins in this file. Nothing was changed.",
	migratePasswordNeeded: "This file is encrypted. Enter its password to open it.",
	migrateFilePasswordWrong: "That password does not open this file. Nothing was changed.",
	migrateTampered:
		"The file was changed after it was made, or it is damaged, so it was not imported. Nothing was changed.",
	migrateNotArchive: "This is not a migration file from omp-webui, or it cannot be read.",
	migrateCorrupt: "The file is damaged or incomplete. Nothing was changed.",
	migrateNewerFormat:
		"This file was made by a newer omp-webui (format {format}; this one reads up to {supported}). Update this app and try again.",
	migrateNotReady: "The file has not been checked yet.",
	migrateUpload: "The upload does not continue where it stopped. Start again.",
	migrateNoCredentials: "This file holds no logins.",
	migrateRunning: "An import is writing files. Open the conversation again when it has finished.",
	migrateTooLarge:
		"A file in it ({file}) says it is far larger than what is stored of it, so it cannot be a file this app made. Nothing was changed.",
	migrateDiskSpace:
		"There is not enough free space on this Mac for what the file holds. Free some space and try again.",
	migrateNoBackup: "There is no backup to put back.",
} satisfies Record<ErrorCode, string>;
