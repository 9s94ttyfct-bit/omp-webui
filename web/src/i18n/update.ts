/**
 * Strings for the app's own updates: the Settings › Updates card. Not part of the first page's strings: the card's chunk
 * registers them (`registerStrings`), and the sidebar's indicator, which is on the first page, keeps its two in `shell`.
 */
export const en = {
	// The card
	title: "Updates",
	hint: "omp-webui updates itself from its public releases on GitHub.",
	remoteRefused: "Updates are not available on a remote page: the app can only be updated from the Mac it runs on.",
	loadFailed: "Could not read the update state from the app.",
	versionInstalled: "Installed version: v{version}",
	versionLatest: "Latest version: v{version}",
	versionLatestUnknown: "Latest version: not known yet",
	upToDate: "You are up to date.",
	available: "v{version} is available",
	checkedAt: "Last checked {when}",
	neverChecked: "Not checked yet",
	check: "Check now",
	checking: "Checking…",

	// A look at GitHub that gave no answer
	noRelease: "No release is reachable right now.",
	offline: "GitHub could not be reached. Check the internet connection and look again.",
	rateLimitedAt: "GitHub's request limit is used up. The app looks again at {when}.",
	rateLimited: "GitHub's request limit is used up. Try again in a while.",
	http: "GitHub answered with status {status}, which is not a release. Try again in a while.",
	badAnswer: "GitHub's answer was not a release this app understands. Try again in a while.",

	// The newer release
	notesLabel: "What is new in v{version}",
	releasePage: "Release page",
	install: "Download and install",
	noAsset: "v{version} is published but its installer is not attached yet. Check again in a few minutes.",

	// Why this copy cannot install
	blockedNotApp:
		"Updates install only in the macOS app. Download v{version} from the release page, or update the way this copy was installed.",
	blockedTranslocated:
		"macOS is running omp-webui from a temporary copy. Move it to the Applications folder and open it from there; then it can update itself.",
	blockedNotWritable:
		"This user cannot write to the folder omp-webui is in, so it cannot replace itself. Install the new version by hand from the release page.",
	blockedAdHoc:
		"This copy of omp-webui is signed ad hoc, so there is no signature to check a download against. Install the new version by hand from the release page.",

	// An install under way
	phaseDownloading: "Downloading v{version}…",
	phaseVerifying: "Checking the download…",
	phaseStaging: "Preparing the new version…",
	phaseHandover: "Restarting to finish the update…",
	progressLabel: "Download progress",
	cancel: "Cancel",

	// An install that was refused
	refusedBusy: "An update is already under way.",
	refusedNothing: "There is nothing to install: that release is no longer the newest one. Check again.",
	refusedBlocked: "This copy of omp-webui cannot update itself.",
	requestFailed: "The update could not be started: {error}",

	// Conversations are replying
	confirmTitle: "Update while conversations are replying?",
	confirmBodyOne: "1 conversation is replying; updating stops it. Update anyway?",
	confirmBodyMany: "{n} conversations are replying; updating stops them. Update anyway?",
	confirmStayingOne: "1 paused or waiting conversation stays in the background.",
	confirmStayingMany: "{n} paused or waiting conversations stay in the background.",
	confirmAnyway: "Update anyway",

	// An install that did not go on
	failedTitle: "The update was not installed",
	failedDownload: "The installer could not be downloaded ({detail}). Nothing was changed.",
	failedDownloadPlain: "The installer could not be downloaded. Nothing was changed.",
	failedSize:
		"The download is {actual} bytes, but the release lists {expected} bytes, so it is incomplete or not the file that was published. Nothing was installed.",
	failedDigest:
		"The download's checksum (SHA-256 {actual}) is not the one GitHub lists for the installer ({expected}), so it was not installed.",
	failedMount: "The installer could not be opened: {detail}",
	failedNoApp: "The installer does not contain omp-webui.app, so it was not installed.",
	failedSignature: "macOS refused the new app's signature, so it was not installed: {detail}",
	failedBundleId: "The app in the installer is `{found}`, not `{expected}`, so it was not installed.",
	failedVersion: "The app in the installer is v{found}, but the release is {tag}, so it was not installed.",
	failedNotNewer:
		"The app in the installer is v{found}, which is not newer than the installed v{installed}. The app never goes back to an older version.",
	failedRequirement:
		"The new app is signed by another certificate ({found}) than the one running now ({expected}), so it was not installed.",
	failedAdHoc:
		"This copy of omp-webui is signed ad hoc, so there is no signature to compare the new app with. Install the new version by hand from the release page.",
	failedSpace:
		"There is not enough free space for the update: it needs {needed} and {free} is free. Free some space and try again.",
	failedNotWritable: "The folder `{dir}` cannot be written by this user, so the app cannot replace itself there.",
	failedStage: "The new app could not be copied next to the old one: {detail}",
	failedUnknown: "The update could not be installed (reason: {code}). Nothing was changed.",
	retry: "Try again",
	dismiss: "Dismiss",

	// How the last update ended
	outcomeOk: "Updated to v{to}.",
	outcomeFailed: "The update to v{to} did not work out; v{from} is back.",
	outcomeQuitTimeout: "The update to v{to} did not work out: the app did not quit in time. v{from} is back.",
	outcomeVerify:
		"The update to v{to} did not work out: the new app was not what it should be at the last check. v{from} is back.",
	outcomeSwap: "The update to v{to} did not work out: the new app could not be swapped in. v{from} is back.",
	outcomeDidNotStart: "The update to v{to} did not work out: the new app did not start. v{from} was put back.",
	outcomeRollbackFailed:
		"The update to v{to} did not work out, and v{from} could not be put back. Install omp-webui again from the release page.",

	// The setting
	auto: "Check for updates automatically",
	autoHint: "Looks at start and every 6 hours. “Check now” always works, whatever this is set to.",
};
