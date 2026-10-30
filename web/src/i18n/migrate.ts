/**
 * Strings for Settings › Move to another computer. Unlike the other namespaces this one is not in `MODULES` of
 * `index.ts`: the card is a lazy chunk, and its strings travel with it (`addStrings`). The zh-CN ones are a chunk of
 * their own, fetched only by a person who reads the page in Chinese.
 */
export const en = {
	title: "Move to another computer",
	/** The card's name in Settings' index. */
	indexTitle: "Migration",
	intro:
		"Put your conversations, history, memories, settings, plugins and this app's own data in one file, and bring them into omp on another Mac.",
	notEncrypted:
		"A file is encrypted only if you ask for it below. Otherwise anyone who gets it can read the conversations in it (logins, if you include them, are always encrypted). Keep it private and delete it when you are done.",
	refused:
		"This page is not on the Mac the server runs on, so moving data can only be done from the page on the Mac itself.",
	networkError: "The connection to the app was lost. Try again.",
	cancel: "Cancel",
	refresh: "Refresh",
	done: "Done",
	close: "Close",
	copy: "Copy",
	copied: "Copied",

	// The categories of an archive
	catConversations: "Conversations",
	catHistory: "Prompt history",
	catMemories: "Memories",
	catSettings: "Settings and instruction files",
	catCustomization: "Skills, agents, commands and themes",
	catPlugins: "Plugins",
	catWebui: "This app's data",
	catCredentials: "Logins",
	tableCategory: "What",
	tableFiles: "Files",
	tableSize: "Size",
	tableNew: "New here",
	tableSame: "Same",
	tableDiffers: "Different",
	tableLabel: "What the archive holds",

	// Why something is left out
	reasonCache: "made again when needed",
	reasonRebuilt: "rebuilt from your conversations",
	reasonMachine: "belongs to this computer",
	reasonRuntime: "in use right now",
	reasonRedownload: "downloaded again from the internet",
	reasonSecret: "a login or secret",
	reasonUnknown: "not known to this version",
	leftOutTitle: "Not included ({count})",
	leftOutList: "Items left out",

	// Export
	exportTitle: "Export",
	exportIntro: "On the old Mac: what you tick below goes into one .ompw file.",
	planLoading: "Looking through your files…",
	planFailed: "Could not look through your files: {error}",
	planTotals: "Files: {files}, {size} in all",
	planProfiles: "Profiles included: {names}",
	planSessionDirs: "Conversation folders included: {paths}",
	pickHint: "Tick what goes into the file. What you leave out stays only on this Mac.",
	pickLoginsOn: "included (encrypted, see below)",
	pickLoginsOff: "not included: turn on the switch below",
	pickNothing: "Nothing is ticked. Tick at least one kind of data, or include the logins.",
	credSwitch: "Include logins (encrypted)",
	credHint:
		"Logins are the sign-in tokens and API keys omp keeps. With this on a password is required, and the same password is asked when you import. If you forget it, the logins cannot be recovered.",
	wholeSwitch: "Encrypt the whole file",
	wholeHint:
		"Everything in the file is encrypted with the password: conversations, memories, settings, even the names of the files. Without the password nothing in it can be read or changed, and a file that was changed on the way is refused. Off, only the logins are encrypted.",
	password: "Password",
	passwordConfirm: "Repeat the password",
	passwordShort: "Use at least {min} characters.",
	passwordMismatch: "The two passwords are not the same.",
	strengthLabel: "Password strength: {level}",
	strength0: "very weak",
	strength1: "weak",
	strength2: "fair",
	strength3: "strong",
	strength4: "very strong",
	reasonShort: "It is short: twelve or more characters are much harder to guess.",
	reasonCommon: "It is, or is close to, a very common password.",
	reasonWord: "It is built on ordinary words, even with swaps like @ for a.",
	reasonSequence: "It has a run like abc or 1234.",
	reasonKeyboard: "It follows the keyboard, like qwerty.",
	reasonRepeat: "It repeats itself.",
	reasonDate: "It has a year or a date, which are easy to guess.",
	reasonSingleKind: "It is only letters or only digits.",
	suggestIntro: "Easier to remember and strong: a passphrase of unrelated words, for example",
	suggestUse: "Use this passphrase",
	generate: "Generate a strong password",
	madeNote:
		"Save this password now, for example in your password manager. The file cannot be opened without it, and it is not stored anywhere: not in the app and not in the file.",
	copyPassword: "Copy the password",
	copyFailed: "Could not copy. Select the password in the field and copy it yourself.",
	secretFilesOn: "These files hold secret values. They go into the encrypted part:",
	secretValues: "values: {count}",
	secretFilesOff:
		"Secret values left blank in the archive, in {files} (values: {count}). Enter them again on the new Mac.",
	exportButton: "Export",
	exportProgress: "Export progress",
	exportDone: "The archive is ready: {name} ({size}).",
	exportDoneHint: "Save the file first. Done deletes the temporary copy the app made.",
	exportDoneEncrypted:
		"The file is encrypted as a whole: you need the password to import it, and it is not stored anywhere.",
	exportDoneHolds: "The file holds: {names}.",
	download: "Save the file",
	skippedTitle: "Files that could not be read and are not in the archive ({count})",
	exportFailed: "The export failed: {error}",
	exportCancelled: "The export was cancelled. Nothing was kept.",
	tryAgain: "Try again",

	// Progress
	phaseScan: "Looking through the files",
	phaseCopy: "Writing the archive",
	phaseVerify: "Checking the archive",
	phaseBackup: "Backing up what will change",
	phaseWrite: "Writing files",
	phaseFinish: "Finishing",
	phaseUpload: "Uploading the file",
	progressPercent: "{phase}: {percent}%",
	progressBytes: "{done} of {total}",
	progressFiles: "Files: {done} of {total}",

	// Import
	importTitle: "Import",
	importIntro: "On the new Mac: install omp and omp-webui, open the app, and choose the .ompw file the export made.",
	chooseFile: "Choose a file…",
	importProgress: "Import progress",
	uploadCancel: "Cancel the upload",
	interrupted: "The upload stopped before the whole file arrived. Start again.",
	startAgain: "Start again",
	chooseOther: "Choose another file",
	unlockTitle: "This file is encrypted",
	unlockHint:
		"Enter the password it was exported with. Nothing in the file is shown or read until it is right, and a file that was changed since it was made is refused.",
	unlockPassword: "Password of the file",
	unlockButton: "Open the file",
	unlocking: "Opening…",
	importFailed: "The import failed: {error}",
	importFailedRetry: "Choose the file again",
	importFailedBackup:
		"What it had already written is kept, with lists of what it changed and what it made, in this folder:",
	restore: "Restore",
	restoring: "Restoring…",
	restored: "Everything the import changed is back as it was, and what it made is removed.",

	// The preview
	previewTitle: "What the file holds",
	heldOnly: "This file holds only: {names}. Everything else on this Mac is left exactly as it is.",
	sourceTitle: "Made on",
	sourceHost: "Computer",
	sourceUser: "User",
	sourceHome: "Home folder",
	sourceOmp: "omp",
	sourceWebui: "omp-webui",
	sourceCreated: "Made",
	warnOmpNewer:
		"The file was made with omp {version}, which is newer than the omp on this Mac. Its data may be in a layout this omp does not read.",
	warnWebuiNewer:
		"The file was made with omp-webui {version}, which is newer than this app. Some of its data may not be understood here.",
	warnHomeDiffers:
		"The file comes from the home folder {from}; this Mac's is {to}. Conversation folders under it are rewritten to this Mac's.",
	warnDiskLow:
		"There is not enough free room on this Mac: the file needs about {need} and {free} is free. Free some space before importing.",
	warnSkipped: "Files that could not be read when the file was made, and so are missing from it: {count}.",
	conversationsLine: "Conversations: {total} in all, {added} new here, {same} already here, {differs} different.",
	skippedFiles: "Files that were not readable",
	restoreLogins: "Restore logins",
	restorePassword: "Password the logins were encrypted with",
	noLogins: "This file holds no logins.",
	encWhole: "This file is encrypted as a whole and was opened with its password, so its logins need no second one.",

	// Merge or replace
	modeTitle: "When something is on both Macs",
	modeMerge: "Merge",
	modeMergeHint:
		"What is on this Mac stays; what is missing is added. If both have the same conversation, this Mac's is kept, unless the file's is the same conversation continued.",
	modeReplace: "Replace",
	modeReplaceHint:
		"Where both have the same item, the file's wins. Things that are only on this Mac are never deleted.",
	backupNote:
		"Before anything that exists is changed, it is copied to a backup folder in the app's data folder. The summary names it.",
	importButton: "Import",
	applying: "Importing…",

	// The summary
	summaryTitle: "The import is finished",
	summaryBackup: "Backup folder",
	summaryBackupNone: "Nothing that existed was changed, so there is no backup.",
	summaryConversations: "Conversations: {added} added, {kept} kept, {updated} updated, {replaced} replaced.",
	summaryFiles: "Files: {added} added, {kept} kept, {replaced} replaced, {merged} merged, {skipped} skipped.",
	summaryRewritten: "Conversations whose folder was rewritten to this Mac's home: {count}.",
	summaryMissing: "These folders are not on this Mac yet: conversations that ran there open into the folder chooser.",
	summaryMore: "…and {count} more",
	summaryOldMachine: "These values in your settings still point at the old Mac. Check them:",
	whyHome: "still names the old home folder",
	whyMissing: "path not found on this Mac",
	credsRestored: "Logins restored (providers: {providers}, files: {files}).",
	credsNotAsked: "Logins were not restored: you chose not to.",
	credsOmpOlder: "Logins were not restored: omp on this Mac keeps them in an older layout.",
	credsAbsent: "Logins were not restored: the file held none.",
	credsNotRestored: "Logins were not restored.",
	notesTitle: "Also",

	// What an import tells the person
	noteCredentialsOmpOlder:
		"The logins were not restored: omp {installed} on this Mac keeps them in an older layout than the omp {archive} that made the file. Update omp, then sign in again.",
	noteCredentialsFailed: "The logins could not be put in place: {error}",
	noteSecretsBlanked:
		"Secret values in configuration files left blank because the logins were not restored: {count}. Enter them again.",
	noteRemoteOff:
		"Remote access settings came with the file and are switched off. Turn them on in Settings › Remote access.",
	noteRemoteKept: "This Mac has remote access settings of its own, which stay as they are.",
	noteSessionDirMoved: "The conversation folder {from} is kept in this app's own folder now: {to}.",
	noteBanksRenamed: "Memory banks renamed for the folders' new paths: {count}.",
	noteBanksKept: "Memory banks of folders that could not be identified, which keep their old names: {count}.",
	noteLiveEnded: "Idle conversation processes closed so that their files could be written: {count}.",
	noteOpenElsewhere: "Conversations open in a terminal, which were left as they are: {count}.",
	noteLinksRecreated: "Installed plugins whose links were made again for this Mac's home folder: {count}.",
	noteFileFailed: "{path} could not be written: {error}. The rest went on.",
};
