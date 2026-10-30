/**
 * Strings for installing, setting up and updating omp: FirstRun, Onboarding, OmpUpdateNotice and OmpSettings.
 *
 * Only the strings a module of the first page load asks for: `tests/unit/i18n-first-load.test.ts` holds this
 * file to that. The rest are in `omp-later.ts`.
 */
export const en = {
	// Update notice (components/OmpUpdateNotice.tsx)
	noticeUpdateAvailable: "omp {latest} is available — you have {current}.",
	noticeUpdateOutsideCompat:
		"omp {latest} is available, but this omp-webui is made for omp {range}. Updating may break parts of the web UI.",
	noticeReleaseNotes: "Release notes",
	noticeUpdate: "Update",
	noticeUpdateAnyway: "Update anyway",
	noticeLater: "Later",
	noticeDismiss: "Dismiss",
	noticeWaitingOne: "Waiting for 1 conversation to finish before updating omp…",
	noticeWaitingMany: "Waiting for {n} conversations to finish before updating omp…",
	holdWorking: "{n} working",
	holdAsking: "{n} waiting for an answer",
	holdPaused: "{n} paused",
	holdSeparator: ", ",
	noticeWaitingHeld:
		"Waiting to update omp: {what}. Resume or end the paused conversations and answer the ones that are waiting, or update anyway — a conversation that stays open keeps running the old omp until it is restarted.",
	noticeWaitingAnywayOne:
		"Updating omp as soon as the 1 conversation that is working has finished. Paused and waiting ones are not waited for; they keep running the old omp until they are restarted.",
	noticeWaitingAnywayMany:
		"Updating omp as soon as the {n} conversations that are working have finished. Paused and waiting ones are not waited for; they keep running the old omp until they are restarted.",
	noticeAutoWaiting: "Automatic update is waiting for: {what}.",
	noticeCancel: "Cancel",
	noticeUpdating: "Updating omp…",
	noticeUpdatingAuto: "Updating omp automatically…",
	noticeShowLog: "Show output",
	noticeHideLog: "Hide output",
	noticeLogLabel: "Update output",
	noticeUpdated: "omp is now {version}. Conversations that are already open keep the old version until you close them.",
	noticeUpdateFailed: "The omp update didn't finish: {error}",
	noticeRetry: "Try again",
	noticeCompatNewer:
		"omp {version} is newer than this omp-webui is made for ({range}). Some features may not work until omp-webui is updated.",
	noticeCompatOlder: "omp {version} is older than this omp-webui supports ({range}). Some features may not work.",
	noticeStartFailed: "Could not start the update: {error}",
	confirmTitle: "Update to an untested omp?",
	confirmBody:
		"omp {latest} is outside the versions this omp-webui supports ({range}). Parts of the web UI may stop working until omp-webui is updated too.",
	confirmUpdate: "Update anyway",
};
