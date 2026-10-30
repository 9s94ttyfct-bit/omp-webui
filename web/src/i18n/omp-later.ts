/**
 * Strings for installing, setting up and updating omp: FirstRun, Onboarding, OmpUpdateNotice and OmpSettings.
 *
 * The strings only code outside the first page load asks for, which `later.ts` registers: a module that uses one
 * imports `later.ts` (`tests/unit/i18n-first-load.test.ts`). The ones the first page asks for are in `omp.ts`.
 */
export const en = {
	// First run (components/FirstRun.tsx)
	firstRunTitle: "Install omp to get started",
	firstRunBrokenTitle: "omp doesn't start",
	firstRunIntro:
		"omp-webui is a window onto the omp coding agent, and omp isn't installed on this computer yet. Pick how to install it; the command each choice runs is shown with it.",
	firstRunSearched: "Looked for `omp` in {n} places",
	firstRunBroken: "omp was found at `{bin}`, but it doesn't run: {error}",
	firstRunBrokenHint: "Install it again below, or fix it yourself and look again.",
	optionsLabel: "How to install omp",
	optionHomebrew: "Homebrew",
	optionHomebrewHint: "Installs omp with `brew`, and Homebrew keeps it up to date.",
	optionInstaller: "omp's installer",
	optionInstallerHint:
		"Downloads omp's standalone binary into `~/.local/bin` and checks its checksum. Needs nothing else.",
	optionBun: "Bun",
	optionBunHint: "Installs omp's package globally with `bun`.",
	optionRecommended: "Recommended",
	optionMissingTool: "Needs `{tool}`, which isn't installed on this computer.",
	optionCommand: "Runs",
	installButton: "Install omp",
	installRunning: "Installing omp with {method}…",
	installLogLabel: "Installer output",
	installNoOutput: "Waiting for output…",
	installCancel: "Cancel",
	installFailedTitle: "The install didn't finish",
	installTryAgain: "Try again",
	installRecheck: "I installed it myself — look again",
	installRecheckNone: "omp still wasn't found.",
	installRecheckFailed: "Could not look again: {error}",
	installStartFailed: "Could not start the install: {error}",

	// First-time setup (components/Onboarding.tsx)
	setupTitle: "Set up omp",
	setupStep: "Step {n} of {total}",
	setupSkip: "Skip setup",
	setupBack: "Back",
	setupContinue: "Continue",
	setupSkipStep: "Skip this step",
	setupStepAccount: "Sign in",
	setupStepModel: "Model",
	setupStepApproval: "Permissions",
	setupStepDone: "Done",
	setupAccountTitle: "Sign in to a provider",
	setupAccountIntro:
		"omp needs an account or an API key with at least one model provider to answer. Sign in below; you can add more later in Settings.",
	setupAccountSignedIn: "You're signed in. Continue to choose a model.",
	setupModelTitle: "Choose your default model",
	setupModelIntro:
		"New conversations start with this model. You can change it later in Settings, or for one conversation.",
	setupModelLabel: "Default model",
	setupModelNone: "omp lists no models yet. Go back and sign in to a provider first.",
	setupModelLoading: "Looking up the models you can use…",
	setupModelFailed: "Could not save the model: {error}",
	setupModelListFailed: "Could not list the models: {error}",
	setupApprovalTitle: "Choose how omp asks before it acts",
	setupApprovalIntro:
		"omp can edit files and run commands. Decide when it has to ask you first; each conversation can still change it.",
	setupApprovalFailed: "Could not save the permission mode: {error}",
	setupDoneTitle: "You're all set",
	setupDoneIntro: "omp is installed and set up. Start your first conversation.",
	setupSummaryModel: "Default model: {model}",
	setupSummaryApproval: "Permissions: {mode}",
	setupSummaryNone: "Nothing was changed; Settings has all of this.",
	setupStart: "Start a chat",
	setupFinishFailed: "Could not finish the setup: {error}",

	// Settings (components/OmpSettings.tsx)
	settingsTitle: "omp",
	/** On a page that is not on the computer the server runs on. */
	settingsRemoteNote:
		"This is the omp of the computer omp-webui runs on: checking and updating here change that computer's omp.",
	settingsVersion: "Installed: omp {version}",
	settingsLocation: "Location: `{path}`",
	settingsVia: "Installed with {method}.",
	methodHomebrew: "Homebrew",
	methodBun: "Bun",
	methodNpm: "npm",
	methodInstaller: "omp's installer",
	methodMise: "mise",
	methodNix: "Nix",
	methodManaged: "{name}",
	methodUnknown: "an unknown method",
	updateViaHomebrew:
		"Updating runs `omp update`, which upgrades the Homebrew formula (`brew upgrade can1357/tap/omp`).",
	updateViaBun: "Updating runs `omp update`, which reinstalls omp's package globally with `bun`.",
	updateViaNpm: "Updating runs `omp update`, which reinstalls omp's package globally with `npm`.",
	updateViaInstaller: "Updating runs `omp update`, which replaces omp's standalone binary after checking its checksum.",
	updateViaMise: "Updating runs `omp update`, which upgrades the omp tool with `mise`.",
	updateViaNix: "Nix manages this omp: update the flake input or profile that provides it, then rebuild.",
	updateViaManaged: "{name} keeps this omp up to date; update it from there.",
	updateViaUnknown:
		"This omp comes from a source checkout or somewhere omp-webui can't tell, so it is not updated from here.",
	settingsSupported: "This omp-webui is made for omp {range}.",
	settingsCompatOk: "The installed version is in that range.",
	settingsCompatNewer: "The installed version is newer than that range.",
	settingsCompatOlder: "The installed version is older than that range.",
	settingsUpToDate: "omp is up to date (latest release {latest}).",
	settingsAvailable: "omp {latest} is available.",
	settingsNotChecked: "No look-up for a newer omp yet.",
	settingsCheckedAt: "Checked at {when}.",
	settingsCheck: "Check now",
	settingsChecking: "Checking…",
	settingsCheckFailed: "Could not look for a newer omp: {error}",
	settingsUpdate: "Update omp",
	settingsAuto: "Update omp automatically",
	settingsAutoHint:
		"When no conversation is working, paused or waiting for your answer, omp-webui runs `omp update` by itself. Off by default. It never moves to a version outside the range this omp-webui is made for.",
	settingsAutoWaitingHint:
		"Resume or end the paused conversations and answer the ones that are waiting, or update now.",
	settingsAutoFailed: "Could not save the setting: {error}",
	settingsSetupAgain: "Run the first-time setup again",
	settingsSetupAgainHint: "Sign in, choose the default model and permission mode step by step.",
	settingsSetupFailed: "Could not start the setup: {error}",
};
