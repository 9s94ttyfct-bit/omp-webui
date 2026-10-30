/**
 * Strings for model guidance (#641): New chat's *Guidance* picker, the card in Settings that edits the templates, and a
 * conversation's *Guidance* tab that edits what it carries (#715). All of it is in lazy chunks (`GuidancePicker`,
 * `GuidanceSettings`, `GuidanceEditor`), so unlike most namespaces this one is not in `MODULES` of `index.ts`: its strings
 * travel with those chunks (`lib/guidance-strings.ts`, `addStrings`). The zh-CN ones are a chunk of their own, fetched
 * only by a person who reads the page in Chinese.
 */
export const en = {
	title: "Model guidance",
	intro:
		"The main agent is told, in its standing instructions, how to hand work to subagents and which models to use for them. It is off unless you pick one, or make a template the default in Settings.",
	pick: "Guidance",
	pickNone: "None",
	pickCustom: "Custom…",
	pickTemplateHint: "Sent with this conversation only. You can change it later in its Guidance tab.",
	empty: "No guidance: the main agent decides by itself.",
	templateGone:
		"That template was deleted meanwhile. Save the text for this conversation only, or pick another template.",
	changeIntro: "This is part of the main agent's instructions from its next turn on. Subagents do not see it.",
	readOnly:
		"This conversation's omp was started without the extension that carries the guidance (its own flags rule it out, or it already ran), so a change is kept for its next opening.",
	skippedTrusted:
		"Not carried: this conversation was started with your own --trusted-extension, which omp cannot combine with the guidance extension.",
	skippedInherited:
		"Not carried: this server took the conversation over from one that had not started it with the guidance extension. It is carried again when the conversation is opened.",
	skippedUnavailable:
		"Not carried: the guidance extension did not start in this conversation's omp (its files could not be written to the data folder, or omp did not run it).",
	none: "No guidance",
	templateLabel: "Template",
	textLabel: "Guidance text",
	custom: "Written here",
	save: "Save",
	saving: "Saving…",
	saved: "Saved",
	saveFailed: "Could not save: {error}",
	remove: "Turn off",
	removing: "Turning off…",
	loadFailed: "Could not read the guidance: {error}",
	tooLong: "At most {max} characters.",
	chars: "{n} / {max}",
	settingsIntro:
		"Saved templates you can pick for a new conversation. They are kept with the app's settings, so they follow you to another computer.",
	settingsEmpty: "No templates yet.",
	newTemplate: "New template",
	nameLabel: "Name",
	bodyLabel: "Text",
	builtin: "Shipped",
	edit: "Edit",
	delete: "Delete",
	deleteConfirm: "Delete the template “{name}”?",
	deleteHint: "Conversations that use it keep the text it stood for.",
	restore: "Restore defaults",
	restoreHint: "The shipped templates come back as they ship; the ones you made are left alone.",
	restoreDone: "The shipped templates are back.",
	namePlaceholder: "A name you will recognise",
	textPlaceholder: "What the main agent should do, e.g. which model to give a subagent and how many to run at once.",
	cancel: "Cancel",
	nameEmpty: "The template needs a name.",
	textEmpty: "The template needs some text.",
	nameTooLong: "A name is at most {max} characters.",
	readOnlyRemote: "Model guidance is changed on the computer omp-webui runs on.",
	chip: "Guidance: {name}",
	chipOff: "Guidance: off",
	defaultBadge: "Default",
	makeDefault: "Default for new chats",
	makeDefaultHint: "New chats start with this template; you can still pick another, or none, in New chat.",
	newChatsGet: "New chats start with: {name}",
	newChatsNone: "New chats start without guidance. Open a template to make it the default.",
	duplicate: "Duplicate",
	copyName: "{name} (copy)",
	reset: "Reset",
	resetHint: "Put back the name and text this template ships with.",
	writeOwn: "Write your own…",
	listLabel: "Guidance templates",
	revert: "Revert",
	// The Guidance tab's three ways of saving (v0.12.2): this conversation only, into the template it uses, as a new template.
	saveHere: "Save for this conversation",
	saveHereHint:
		"Saves this text for this conversation only. No template is changed: text that came from a template becomes this conversation's own.",
	nothingToSave: "Nothing has changed.",
	toTemplate: "Save to template",
	toTemplateHint: "Writes this text into the template “{name}”.",
	toTemplateNone: "This conversation does not use a template. Use “Create new template” to make one from this text.",
	toTemplateSame: "“{name}” already has this text.",
	textNeeded: "Write some text first.",
	newFromText: "Create new template",
	newFromTextHint: "Makes a new template from this text; this conversation then uses it.",
	tooManyTemplates: "Keep at most {max} templates: delete one in Settings › Model guidance first.",
	createIntro:
		"A new template is made from this conversation's text, and this conversation uses it from then on. New chats can pick it too.",
	create: "Create",
	nameRepeated: "There is already a template with that name.",
	confirmTitle: "Update the template “{name}”?",
	confirmShared:
		"Other conversations that use this template: {n}. Those not running now carry the new text when they are next opened, and so does a new chat that picks it; a conversation running now keeps the text it has until it is closed and opened again. This conversation carries the new text from its next turn.",
	confirmUpdate: "Update template",
	rename: "Rename template",
	renameLabel: "New name of the template",
	renameSave: "Save name",
	renameHint: "Enter saves, Esc cancels.",
	appliesNext: "This conversation is not running: the change applies when it is opened again.",
	// The shipped templates' names and summary lines, shown in the page's language while the person has not changed them.
	// What the model reads is the template's text, which stays as shipped.
	builtinOneOfEachName: "One of each kind at a time",
	builtinOneOfEachSummary: "For subagents, respect these limits at all times, counting the ones already running:",
	builtinSimpleComplexName: "Simple to DeepSeek, complex to Sonnet",
	builtinSimpleComplexSummary: "Choose a subagent's model by how hard its work is, and say which you chose and why:",
};
