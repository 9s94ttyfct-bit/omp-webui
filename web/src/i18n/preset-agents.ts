/**
 * Strings for the subagent models of a preset (omp's `task.agentModelOverrides`): the editor in Settings › Presets and
 * the note in the save dialogs. Not part of the first page's strings: the chunks that show them register them
 * (`registerStrings`), so the composer's menu does not carry them until a preset is being saved.
 */
export const en = {
	// Settings › Presets
	rule: "Subagent models: a preset that sets some replaces the subagent models of whatever it is applied to (this conversation, or the default for new ones). A preset that sets none leaves them as they are.",
	summary: "Subagents: {models}",
	editAria: "Subagent models of preset {name}",
	// The editor
	title: "Subagent models · {name}",
	description:
		"Subagents (the task tool's agents, such as reviewer or scout) run on the model of their role unless one is set here. Applying this preset replaces the subagent models of the conversation or the default it is applied to with the ones below; with none below, it leaves them as they are.",
	none: "No subagent models: applying this preset leaves the current ones as they are.",
	modelAria: "Model for subagent {agent}",
	thinkingAria: "Thinking level for subagent {agent}",
	remove: "Remove subagent {agent}",
	addAria: "Name of the subagent to add",
	addName: "Subagent, e.g. reviewer",
	add: "Add subagent",
	addInvalid: "Use a letter, then letters, digits, - or _.",
	addExists: "That subagent is already in the list.",
	unsaved: "Not saved yet",
	saved: "Saved the subagent models of “{name}”.",
	savedNone: "“{name}” no longer sets subagent models.",
	// The note in the save dialogs
	noteSet: "Saved with it: subagent models {models}. Applying the preset replaces the subagent models with these.",
	noteNone: "No subagent models are set, so applying this preset leaves them as they are.",
};
