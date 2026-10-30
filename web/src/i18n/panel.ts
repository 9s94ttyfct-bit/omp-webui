/**
 * Strings for the panel surfaces.
 *
 * Only the strings a module of the first page load asks for: `tests/unit/i18n-first-load.test.ts` holds this
 * file to that. The rest are in `panel-later.ts`.
 */
export const en = {
	// Subagents
	agentStopped: "Subagent stopped",
	agentNotRunning: "Subagent was not running",

	// Goal
	goalResumedToStart: "Resumed the conversation to start the goal.",

	// Guided goal: the bar while omp interviews, and the proposal to confirm
	guidedActive: "A guided goal setup is already open in this conversation. Finish or cancel it first.",
	reqAnnounce: "omp is waiting for you: {title}",
	proposalTitle: "Confirm the goal",

	// Model picker
	modelFallbackLabel: "Model",
	modelChoose: "Choose model",
	modelSearch: "Search models…",
	modelListFailed: "Could not list models: {error}",
	thinkingLevel: "Thinking level",
	/** In front of the level in the composer's "⋯" panel, where the control says which setting it is: "Thinking: Low". */
	thinkingPrefix: "Thinking:",
	thinkingOff: "Off",
	thinkingMinimal: "Minimal",
	thinkingLow: "Low",
	thinkingMedium: "Medium",
	thinkingHigh: "High",
	thinkingXhigh: "Extra high",
	thinkingMax: "Max",
	thinkingAuto: "Auto",
	/** `auto` while it is set, with the level omp resolved it to this turn. */
	thinkingAutoResolved: "Auto ({level})",

	// UI requests
	reqInputRequested: "Input requested",
	reqHasQuestion: "omp has a question",
	reqMore: "+{n} more",
	reqDetails: "What is being approved",
	reqMoreBelow: "There is more below: scroll to read all of it.",
	reqInvisible: "A character that does not show: {code}",
	reqDeny: "Deny",
	reqAllow: "Allow",
	reqResponse: "Response",
	reqSubmit: "Submit",
	reqSkip: "Skip",
	/** In a request of several questions, where Skip would read as skipping this question: it declines them all. */
	reqSkipAll: "Skip all",
	reqOther: "Other…",
	reqOtherAria: "Other answer for: {question}",
	/** Beside the option the agent recommends in a question it asks. */
	reqRecommended: "recommended",
	reqSubmitAnswers: "Submit answers",
	/** The counter of a request with several questions: the one asked now, of how many. */
	reqStep: "{n} / {total}",
	reqStepAria: "Question {n} of {total}",
	reqBack: "Back",
	reqNext: "Next",
	reqReview: "Your answers",
	reqNoAnswer: "No answer",
	reqCountdown: "omp goes on without an answer in {time}",
	reqCountdownAsk: "omp picks its recommended answer in {time}",
	reqCountdownApproval: "omp stops waiting for this approval in {time}",
	reqDenyOnSend: "Sending a message denies this and sends the message.",

	// The gate's confirmation of a risky call: "Confirm risky commands from remote pages" (Settings › Remote access) or
	// "Guard dangerous commands" (Settings › Safety)
	reqRiskTitle: "Confirm a risky call: {tool}",
	reqRiskNote:
		"A remote page is driving this turn, and Settings › Remote access asks before a risky call runs. Allow only what you expect; Deny tells the agent it was refused.",
	reqRiskNoteGuard:
		"Guard dangerous commands asks before a risky call runs (Settings › Safety, or this conversation's own choice). Allow only what you expect; Deny tells the agent it was refused.",
	reqRiskCommand: "Command: {command}",
	reqRiskIn: "In: {cwd}",
	reqRiskWhy: "Why it asks: {why}",
	reqRiskDenied: "The reviewer ({model}) denied this call. Allow once runs it anyway.",
	reqRiskDeniedReason: "Its reason: {reason}",
	reqRiskDeniedNoReason: "It gave no reason.",
	reqRiskUnavailable: "No reviewer could be reached, so nobody has judged this call. Allow once runs it anyway.",
	reqRiskUnavailableReason: "What went wrong: {reason}",
	reqRiskUnavailableNoReason: "Nothing was said about what went wrong.",
	reqRiskAllow: "Allow once",
	reqRiskDeny: "Deny",
	reqRisk_privilege: "it runs with administrator rights (sudo)",
	reqRisk_mass_delete: "it deletes or empties a whole folder, many files at once, or something it cannot name",
	reqRisk_delete_outside: "it deletes files outside the project folder, or too many",
	reqRisk_write_outside: "it writes outside the project folder",
	reqRisk_protected: "it touches credentials, the settings of omp or of this app, or files that start programs",
	reqRisk_secret_read: "it reads a key, a token or a password (ssh keys, cloud or registry credentials, the keychain)",
	reqRisk_force_push: "it overwrites or deletes history on a git remote",
	reqRisk_discard: "it throws away uncommitted work or git history",
	reqRisk_remote_exec: "it runs a script it downloads",
	reqRisk_permissions: "it changes the permissions of many files",
	reqRisk_shell_out: "it starts a program from a command that is only known when it runs",
	reqRisk_launchctl: "it changes what macOS starts (launchctl)",
	reqRisk_osascript: "it runs AppleScript (osascript)",
	reqRisk_tunnel: "it opens a tunnel to this computer",
	reqRisk_global_install: "it installs software for the whole system",
	reqRisk_system: "it can erase a disk or stop this computer",
	reqRisk_remote_tool: "it changes remote access to this app",
	reqRisk_unreadable: "it could not be checked, so it asks",

	// Permission mode (tool approval)
	approvalTrigger: "Permission mode",
	approvalMenu: "When omp wants to run a tool",
	approvalAlways: "Ask every time",
	approvalAlwaysHint: "Reads run freely. Every edit and command waits for your approval.",
	approvalCached: "Ask and remember",
	approvalCachedHint:
		"Like Ask every time, and file reads wait too. Approve a file or folder and omp remembers it, for this conversation or for good.",
	approvalWrite: "Ask for commands",
	approvalWriteHint: "Reads and edits run freely. Commands, the browser and subagents wait for your approval.",
	approvalYolo: "Auto-approve",
	approvalYoloHint: "Everything runs without asking. Use with care.",
	approvalApplies: "{mode}: applies from the next tool call.",
	approvalOmp: "omp's setting: {mode}",
	approvalFailed: "Could not change the permission mode: {error}",
	// The info button of a session-panel row (`InfoButton`), which the guard's module on the first page imports.
	controlsInfo: "About “{label}”",
};
