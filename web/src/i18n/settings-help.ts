/**
 * Strings of Ask agent for help (Settings, v0.13.0): Settings' card with its change log, and the strip of the dedicated
 * conversation with its countdown and the Allow / Deny cards. All of it is in lazy chunks, so this namespace is not in
 * `MODULES` of `index.ts`: its strings travel with those chunks (`lib/settings-help-strings.ts`, `addStrings`), and the
 * zh-CN ones are a chunk of their own.
 */
export const en = {
	title: "Ask agent for help",
	intro:
		"A conversation of its own whose agent explains these settings and changes them for you. Ordinary settings change at once; the ones that weaken a protection (the guard, remote access, unattended mode, the permission mode, updates…) each wait for your Allow. Its access ends after 30 minutes, when you revoke it, or when the conversation is closed.",
	start: "Ask agent for help",
	starting: "Starting…",
	startFailed: "Could not start the conversation: {error}",
	conversationTitle: "Settings help",
	prompt:
		"I opened this from Settings › {where}. Help me with omp-webui's settings: explain what I ask about (look it up with webui_docs) and change what I ask for with webui_settings. Ask me what I would like to do.",
	badge: "Settings help",
	activeLeft: "Can change settings · {time} left",
	activeLabel: "This conversation can change settings for {time} more",
	open: "Open",
	revoke: "Revoke now",
	revokeFailed: "Could not revoke: {error}",
	endedExpired: "Settings access ended: its 30 minutes are over.",
	endedRevoked: "Settings access ended: you revoked it.",
	endedEnded: "Settings access ended with the conversation.",
	endedNone: "This conversation cannot change settings. Start a new one from Settings › Ask agent for help.",
	requestTitle: "The agent asks to change a security setting",
	requestNow: "Now",
	requestNew: "New",
	requestExpires: "Denied by itself in {time}",
	allow: "Allow",
	deny: "Deny",
	answerFailed: "Could not answer: {error}",
	unset: "not set",
	changesTitle: "Changes made by the agent",
	changesEmpty: "Nothing was changed by the agent yet.",
	byAgent: "changed by the agent",
	byPerson: "allowed by you",
	undo: "Undo",
	undoLabel: "Undo the change of {key}",
	undone: "Undone",
	undoFailed: "Could not undo: {error}",
	undoAll: "Undo all",
	undoAllLabel: "Undo every change of the conversation started {time}",
	undoAllDone: "{n} undone.",
	undoAllPartial: "{n} undone; {failed} could not be: {error}",
	session: "Conversation of {time}",
	sessionActive: "Conversation of {time} · can change settings for {left}",
};
