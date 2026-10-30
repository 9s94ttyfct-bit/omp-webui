/**
 * Strings for model presets and the model-role editor: the composer's preset menu, its dialogs, Settings.
 *
 * Only the strings a module of the first page load asks for: `tests/unit/i18n-first-load.test.ts` holds this
 * file to that. The rest are in `presets-later.ts`.
 */
export const en = {
	// Composer menu
	trigger: "Presets",
	custom: "Custom",
	menuTitle: "Model presets",
	empty: "No presets yet. Save the models you use now to get back to them in one click.",
	loadFailed: "Could not load presets: {error}",
	saveCurrent: "Save current as…",
	manage: "Manage presets…",
	active: "Active",
	project: "Project",
	projectHint: "Defined by the project's config; change it there.",
	unusable: "omp cannot use this preset: {problem}",
	summaryMore: "+{n} more",
	summaryNoDefault: "No default model",
	// The mark on a preset that carries subagent models (the composer's menu): the tooltip names them, and this is what
	// assistive technology reads inside the item (the title alone is not announced).
	carriesAgents: "Also sets subagent models: {models}",
	carriesAgentsShort: "subagent models",
	switched: "Switched to preset “{name}”.",
	switchFailed: "Could not switch to preset “{name}”: {error}",
	cycleNone: "No presets to switch between. Save the current models as a preset first.",
	setDefault: "Set as default",
	setDefaultHint: "New conversations start with these models. Conversations switched to a preset keep theirs.",
	defaultSet: "Default models set to {name}.",
	defaultSetPlain: "Default models saved.",
	defaultFailed: "Could not set the default models: {error}",

	// Name dialogs
	nameLabel: "Preset name",
	namePlaceholder: "e.g. deep-work",
	nameHint: "A letter, then letters, digits, - or _.",
	nameInvalid: "Start with a letter, then use only letters, digits, - or _.",
	nameTooLong: "Use at most {max} characters.",
	nameExists: "A preset with this name already exists.",
	nameProject: "The project defines a preset with this name; choose another.",
	replaceNote: "A preset named “{name}” exists. Saving replaces it.",
	saveTitle: "Save current models as a preset",
	saveDescription:
		"Saves each role's model and the thinking level under a name. Presets live in omp's config, so the terminal UI has them too.",
	replace: "Replace",
	saved: "Saved preset “{name}”.",

	// Model chooser
	chooseModel: "Choose a model",
	searchModels: "Search models…",
	noModels: "No models",
	useCustom: "Use “{value}”",

	// A process on a local server
	localNote: "Presets apply to conversations on your own models. This one runs on a local server's model.",
};
