/**
 * Strings for the chat surfaces.
 *
 * Only the strings a module of the first page load asks for: `tests/unit/i18n-first-load.test.ts` holds this
 * file to that. The rest are in `chat-later.ts`.
 */
export const en = {
	// Composer
	composerChipSteer: "Steer",
	composerChipQueued: "Queued",
	composerSendNowSteer: "Send now (steer)",
	composerSteerNow: "Steer now",
	composerRemoveQueued: "Remove queued message",
	composerEditQueued: "Edit queued message",
	queueEditSteer: "Editing a steering message",
	queueEditFollowUp: "Editing a queued follow-up",
	queueEditLabel: "Queued message text",
	queueEditHint: "Enter saves · Shift+Enter new line · Esc cancels",
	queueEditEndOne:
		"Saving moves it to the end of the queue, so the 1 message that was behind it will be sent before it.",
	queueEditEndMany:
		"Saving moves it to the end of the queue, so the {n} messages that were behind it will be sent before it.",
	queueEditLocked: "omp already sent this into the running response, so it can no longer be changed or removed.",
	queueEditGone: "omp had already taken that message, so nothing was changed.",
	composerCommands: "Commands",
	composerFiles: "Files",
	composerRemoveImage: "Remove {name}",
	composerMessage: "Message",
	composerPlaceholder: "Message omp… (/ for commands, ! for bash)",
	composerPlaceholderQueue: "Queue a follow-up… ({keys} to steer now)",
	composerPlaceholderQueueBare: "Queue a follow-up…",
	composerPlaceholderApproval: "Message omp… (sending it denies the approval)",
	composerAttach: "Attach files",
	/** Where the message box is narrow: the button that shows its less used controls. */
	composerMore: "More controls",
	composerOffline: "Can be sent once the page has reconnected",
	composerSteer: "Steer",
	composerStop: "Stop",
	stopping: "Stopping…",
	composerPause: "Pause conversation",
	composerQueueMessage: "Queue message",
	composerSend: "Send",
	composerPlaceholderPaused: "Paused. Press Enter to resume and send, or use Resume.",
	composerResumeSend: "Resume & send",

	// Slash commands omp cannot run
	slashUnknownTitle: "“/{name}” is not available here",
	slashUnknownBody:
		"This conversation's omp has no such command, so it would send the text to the model as an ordinary message.",
	slashSendAnyway: "Send to model anyway",
	slashOpenPanel: "Open side panel",
	slashSearch: "Search conversations",
	slashWebNew: "Start a new conversation with New chat.",
	slashWebClear: "The web UI has no in-place clear. Start a new chat to begin with an empty context.",
	slashWebResume: "Pick a conversation in the sidebar, or search for it.",
	slashWebTree: "Browse this conversation's branches in the Branches tab of the side panel.",
	slashWebBranch:
		"Use “Branch from here” under a reply, or edit an earlier message, to branch. The side panel lists the branches.",
	slashWebBtw: "Side questions are in the Ask tab of the side panel.",
	slashWebSettings: "Accounts and preferences are in Settings.",
	slashWebHotkeys:
		"Every keyboard shortcut is listed in Settings › Keyboard shortcuts: press ? to open it, or open Settings.",
	slashWebPause: "Use the Pause button next to Stop while omp is working.",
	slashWebGoal: "Use Set a goal in the header of the conversation.",
	slashWebPlan:
		"omp cannot switch plan mode on or off from here. To begin in read-only plan mode, start a new chat with the --plan-yolo option (Options on the new-chat page); the header shows Plan mode until the plan is approved.",

	// Chat view
	toastCommandExited: "Command exited with {code}",
	toastNeedsInput: "“{title}” needs your input",
	toastOpenChat: "Open",
	notifyAsking: "Needs your input",
	notifyFinished: "Finished",
	untitledSession: "Untitled session",
	newConversation: "New conversation",
	quotaLeft: "{pct}% left",
	quotaTitle: "{provider} usage limits",
	quotaWindow: "{label}: {pct}% left · resets in {time}",
	quotaWindowNoReset: "{label}: {pct}% left",
	quotaAria: "{provider} quota: {pct}% left in {label}",
	quotaAriaAccount: "{provider} quota: {pct}% left in {label} ({account})",
	quotaAccountN: "Account {n}",
	quotaBest: "Best",
	quotaNamed: "{provider} · {text}",
	quotaResetsIn: "resets in {time}",
	quotaResetting: "resetting…",
	quotaExhausted: "limit reached",
	quotaAriaUsedUp: "{provider} quota used up, {when}",
	quotaAriaUsedUpOpen: "{provider} quota used up",
	quotaStale: "Couldn't refresh · showing the last known value",
	quotaAriaStale: "{aria} (couldn't refresh, showing the last known value)",
	usageWaitChoiceTitle: "When the usage limit is reached",
	usageWaitChoiceDefault: "Default ({state})",
	usageWaitChoiceDefaultUnknown: "Default (omp's setting)",
	usageWaitChoiceOn: "Wait for the reset",
	usageWaitChoiceOff: "Don't wait",
	usageWaitStateOn: "wait",
	usageWaitStateOff: "don't wait",
	usageWaitFailed: "Couldn't change the wait: {error}",
	usageWaitChoiceHint:
		"\"Don't wait\" only fails a wait longer than omp's `retry.maxDelayMs` (5 minutes unless it was changed); shorter waits still happen. A wait that is already running is not changed: Cancel it.",
	composerPlaceholderWait: "Sent when omp retries… (or use Retry now)",
	composerSteerAfterWait: "Steer when omp retries",
	composerQueueAfterWait: "Queue until omp retries",
	messageFailed: "This message could not be displayed.",

	// Status line: fast mode, usage limit (omp's own wording), git
	statusUsageLowPriority: "low priority until {time}",
	statusUsageLowPriorityLeft: "low priority until {time} · {percent}% left",
	statusUsageLowPriorityOpen: "low priority",
	statusUsageWrapUp: "limit reached · wrapping up",
	statusUsageWrapUpResets: "limit reached · wrapping up · resets {time}",
	statusUsageWrapUpExtra: "limit reached · wrap-up, then extra usage",
};
