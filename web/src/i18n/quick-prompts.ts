/**
 * Strings for quick prompts (#659) and the built-in Soft stop (#658): the menu beside the message box and the card in
 * Settings. Both are lazy chunks that register these (`registerStrings`); the soft stop's status line and exit notice
 * are in `chat`.
 */
export const en = {
	menuLabel: "Quick prompts",
	menuEmpty: "No quick prompts. Add some in Settings.",
	menuManage: "Edit quick prompts…",
	modeSteer: "Steers now",
	modeFollowUp: "After this turn",
	stopsAfter: "Stops the session after",
	sent: "Sent “{name}”",
	sendFailed: "Couldn't send “{name}”: {error}",
	softStopFailed: "“{name}” was sent, but the session will not stop by itself: {error}",
	softStopName: "Soft stop",
	presetReviewName: "Review my changes",
	presetTestsName: "Write tests for this",
	presetSummaryName: "Summarize & next steps",
	presetCommitName: "Commit the work",
	presetSimplifyName: "Simplify what you wrote",
	paletteGroup: "Quick prompts",
	paletteItem: "Send “{name}”",

	cardTitle: "Quick prompts",
	cardIntro:
		"Messages you send often, one click from the message box (the ⚡ menu beside it) and from the command menu. Each says how it is sent while the agent works.",
	cardAdd: "Add a quick prompt",
	cardRestore: "Restore the defaults",
	cardRestoreDone: "Quick prompts restored",
	cardEmpty: "No quick prompts.",
	fieldName: "Name",
	fieldText: "Message",
	fieldMode: "While the agent works",
	fieldModeSteer: "Steer: reaches the agent now",
	fieldModeFollowUp: "Follow-up: waits for the turn to end",
	fieldStopAfter: "Stop the session when that turn ends",
	fieldStopAfterHint:
		"The conversation's omp process is ended when the turn ends; the conversation is kept and your next message carries on.",
	fieldTextNote: "A message that starts with / runs as a command, and one that starts with ! as a shell command.",
	moveUp: "Move up",
	moveDown: "Move down",
	remove: "Remove",
	save: "Save",
	saved: "Quick prompts saved",
	needsName: "Give it a name",
	needsText: "Write its message",
	tooLong: "Too long: at most {n} characters",
	tooLarge: "These quick prompts are too large to keep together (16 KiB). Shorten or remove some.",
	newName: "New prompt",
	softStopNote:
		"Soft stop asks the agent to save its progress as a handoff in its last message, then stops the session. It can be edited; Restore brings back the original.",
};
