/**
 * Strings for unattended mode (#646): the Questions page, the switch next to the message box (and its count of open
 * questions), and the card in Settings that sets what the agent is told. All of it is in lazy chunks (`QuestionsPage`,
 * `UnattendedToggle`, `UnattendedSettings`), so like the model guidance this namespace is not in `MODULES` of `index.ts`:
 * its strings travel with those chunks (`lib/questions-strings.ts`, `addStrings`). The zh-CN ones are a chunk of their
 * own, fetched only by a person who reads the page in Chinese. The sidebar's own entry is in `shell`.
 */
export const en = {
	// The page
	pageTitle: "Questions",
	pageIntro:
		"What your agents filed while you were away. Open one to see what they found and answer it: the answer goes to that conversation as a message.",
	tabOpen: "Open",
	tabDone: "Done",
	filterLabel: "Show questions from",
	filterAll: "All conversations",
	filterThis: "This conversation",
	empty: "No questions waiting",
	emptyHint: "When a conversation is unattended, what needs you is filed here instead of stopping it.",
	emptyDone: "Nothing answered or dismissed yet",
	loadFailed: "Could not load the questions: {error}",
	retry: "Try again",
	countOne: "1 question",
	countMany: "{n} questions",
	openConversation: "Open conversation",
	openPage: "All conversations' questions",
	tabNoConversation: "Open a conversation to see its questions.",
	conversationGone: "A conversation that is not listed any more",
	asked: "Asked {when}",
	fromAsk: "omp's own question",
	fromTool: "Filed by the agent",
	contextLabel: "What the agent found",
	meanwhileLabel: "Meanwhile it",
	optionsLabel: "Options",
	multiHint: "You can choose more than one.",
	recommended: "recommended",
	textLabel: "Your answer, or a note",
	textPlaceholder: "Write an answer…",
	noOptionsHint: "There are no options: write the answer.",
	answer: "Answer",
	sending: "Sending…",
	dismiss: "Dismiss",
	deliveryLabel: "While the conversation is working",
	deliveryFollowUp: "Queue after the turn",
	deliverySteer: "Steer in now",
	answerHint:
		"Sent to the conversation as a message: queued behind the turn under way, or steered into it. One that is idle takes it at once; one that is closed is opened for it.",
	answerNeeded: "Choose an option or write an answer",
	sent: "Answer sent",
	dismissedToast: "Question dismissed",
	errAnswer: "The answer could not be sent: {error}",
	errDismiss: "Could not dismiss it: {error}",
	stateAnswered: "Answered",
	stateDismissed: "Dismissed",
	yourAnswer: "Your answer",
	chosen: "Chosen",
	note: "Note",
	openCount: "{n} open",
	// Questions that could not be kept (#650), under the conversation they came from
	droppedFull: "A question was not kept: this conversation has 60 open already.",
	droppedEmpty: "A question was not kept: it had no text.",
	droppedUnwritable: "A question was not kept: the list could not be written to the app's data folder.",
	droppedCount: "{n} questions were lost in all.",
	// The switch beside the message box
	toggleLabel: "Unattended",
	toggleTitle: "Unattended: the agent keeps going and files what needs you as a question",
	toggleFailed: "Could not change unattended mode: {error}",
	skippedTrusted:
		"On, but this conversation's omp is not told you are away: it runs with your own --trusted-extension, which omp cannot combine with the server's. Its own questions are still filed.",
	skippedInherited:
		"On, but this conversation's omp was started by a server that did not have the mode: it is told when the conversation is opened again. Its own questions are still filed.",
	skippedUnavailable:
		"On, but the extension that tells the agent did not start in this conversation's omp. Its own questions are still filed.",
	chipOpen: "{n} open",
	chipTitle: "Open this conversation's questions",
	// Settings
	settingsTitle: "Unattended mode",
	settingsIntro:
		"With it on, the agent is told you are away: it goes on with what needs no decision and files what does as a question under Questions in the sidebar.",
	defaultLabel: "Turn it on for new conversations",
	defaultHint:
		"A conversation you start from New chat begins unattended. Each conversation has its own switch beside the message box.",
	instructionLabel: "What the agent is told",
	instructionHint:
		"Added to the main agent's instructions while the mode is on, from its next turn. Subagents do not see it.",
	instructionCount: "{n} of {max}",
	instructionEdited: "Edited",
	instructionShipped: "As shipped",
	save: "Save",
	saved: "Saved",
	restore: "Restore default",
	restored: "Default restored",
	remoteNote: "The text is changed on the computer omp-webui runs on.",
	settingsFailed: "Could not save: {error}",
};
