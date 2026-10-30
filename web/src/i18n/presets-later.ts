/**
 * Strings for model presets and the model-role editor: the composer's preset menu, its dialogs, Settings.
 *
 * The strings only code outside the first page load asks for, which `later.ts` registers: a module that uses one
 * imports `later.ts` (`tests/unit/i18n-first-load.test.ts`). The ones the first page asks for are in `presets.ts`.
 */
export const en = {
	// Name dialogs
	saveFailed: "Could not save the preset: {error}",
	renameTitle: "Rename preset",
	renamed: "Renamed to “{name}”.",
	duplicateTitle: "Duplicate preset",
	duplicateSuggestion: "{name}-copy",
	duplicated: "Created preset “{name}”.",

	// Settings: presets
	listTitle: "Model presets",
	listHint:
		"A preset is a named set of models for every role plus a thinking level, so you can switch them all at once. They are stored in omp's config and shared with the terminal UI.",
	listEmpty: "No presets yet.",
	listFailed: "Could not load presets: {error}",
	movedAside:
		"omp could not read your config.yml and moved it aside to {path}. The roles and presets below are omp's defaults, not the ones you had; restore the file to get them back.",
	apply: "Apply",
	applyAria: "Apply preset {name}",
	applied: "Applied preset “{name}”. Open conversations keep their model until you switch them from their composer.",
	applyFailed: "Could not apply preset “{name}”: {error}",
	renameAria: "Rename preset {name}",
	duplicateAria: "Duplicate preset {name}",
	deleteAria: "Delete preset {name}",
	deleteTitle: "Delete preset “{name}”?",
	deleteBody: "It is removed from omp's config. Your current model roles stay as they are.",
	deleted: "Deleted preset “{name}”.",
	actionFailed: "Could not change the preset: {error}",
	projectNote: "From the project config of {folder}; read-only here.",
	roleCount: "{n} roles",
	layerTitle: "Project overrides · {folder}",
	layerHint:
		"omp merges this project's config over the global one, so conversations in it use these instead of the roles above. Editing the roles above changes the global config only.",
	layerThinking: "Default thinking level",
	roleOverridden: "Project overrides",
	roleOverriddenHint: "In {folder} this role uses {model}.",
	storageProject:
		"Model role storage is “project”: role changes made in omp's terminal UI are saved to the project's config (.omp/config.yml), not to the global config this page edits.",

	// Settings: roles
	rolesTitle: "Model roles",
	rolesHint:
		"Which model each role uses, and the default thinking level. Changes go to omp's config, shared with the terminal UI, and apply to new conversations.",
	defaultThinking: "Default thinking level",
	thinkingNone: "Model default",
	roleModelAria: "Model for {role}",
	roleThinkingAria: "Thinking level for {role}",
	roleRemove: "Remove {role}",
	roleAdd: "Add role",
	roleAddName: "Role name",
	roleAddAria: "New role name",
	roleAddInvalid: "A role name starts with a letter, then letters, digits, - or _.",
	roleAddExists: "That role already exists.",
	rolesUnsaved: "Unsaved changes",
	rolesDiscard: "Discard",
	rolesSaved: "Model roles saved.",
	rolesFailed: "Could not save the model roles: {error}",
	rolesNone: "No roles are set; omp picks a model it can use.",
	rolesSaveAsPreset: "Save as preset…",
	rolesSaveFirst: "Save your changes first.",

	// Role names
	roleDefault: "Default",
	roleSmol: "Fast",
	roleSlow: "Thinking",
	rolePlan: "Architect",
	roleTask: "Subtask",
	roleCommit: "Commit",
	roleVision: "Vision",
	roleAdvisor: "Advisor",
	roleTiny: "Tiny tasks",
	roleMemory: "Memory",
	roleWeb: "Web search",
	roleImage: "Image generation",
	roleSpeech: "Speech",
	roleDictation: "Dictation",
	roleJudge: "Judge",

	// Settings: the Edit dialog of a preset
	editAria: "Edit preset {name}",
	editTitle: "Edit preset · {name}",
	editDescription:
		"The model of each role, the default thinking level and the subagent models of this preset, saved together. Nothing else in the preset changes, and the models you use now stay as they are until you apply it.",
	editThinkingUnset: "Not set (keep the current level)",
	editSubagents: "Subagent models",
	editSaved: "Saved preset “{name}”.",

	// A process on a local server
	localSettingsNote:
		"Light with a local server's models is selected. Model roles and presets apply to your own models; conversations on a local server run on the model chosen under Full / Light.",
};
