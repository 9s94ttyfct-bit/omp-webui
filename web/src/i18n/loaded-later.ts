/**
 * Strings for the Loaded dialog: what a conversation has loaded (tools, MCP servers, commands, skills, plugins, rules).
 *
 * The strings only code outside the first page load asks for, which `later.ts` registers: a module that uses one
 * imports `later.ts` (`tests/unit/i18n-first-load.test.ts`). The ones the first page asks for are in `loaded.ts`.
 */
export const en = {
	title: "Loaded in this chat",
	description:
		"What this conversation has loaded: its tools, MCP servers, slash commands, skills, plugins and rules, as omp reports them.",
	searchPlaceholder: "Filter by name…",
	searchAria: "Filter what is loaded",
	refresh: "Refresh",
	loadFailed: "Could not read what is loaded: {error}",
	sectionFailed: "omp could not say: {error}",
	noMatch: "Nothing loaded matches “{query}”.",
	notRunning:
		"This conversation has no running omp process. Open it to see its tools, MCP servers, commands and skills.",
	lightNote:
		"Started in Light mode: only the MCP servers, tools and skills chosen in Settings are loaded, and no plugins.",

	// Sections
	sectionTools: "Tools",
	sectionMcp: "MCP servers",
	sectionCommands: "Slash commands",
	sectionSkills: "Skills",
	sectionPlugins: "Plugins",
	sectionRules: "Rules",

	// Tools
	toolsNote:
		"What the model can call. A tool marked xd:// is mounted as a device the model writes to; one marked off is registered but not enabled.",
	toolMounted: "xd://",
	toolMountedTip: "Mounted as an xd:// device",
	toolOff: "off",
	toolOffTip: "Registered but not enabled",

	// MCP servers
	mcpNote:
		"The servers omp has configured (/mcp list). A switch turns a server on or off in the config it is defined in (this folder’s .omp/mcp.json or your mcp.json). omp connects its servers only when it starts, so a change applies once this conversation’s omp restarts. The list does not say whether a server connected: one with no tools may still be starting, have failed, or offer none.",
	mcpEnabled: "enabled",
	mcpDisabled: "disabled",
	mcpToolOne: "1 tool",
	mcpTools: "{n} tools",
	mcpNoTools: "no tools loaded",
	mcpOther: "Other MCP tools",
	mcpOtherTip: "MCP tools that belong to none of the servers listed",
	mcpExpand: "Show the tools of {name}",
	mcpCollapse: "Hide the tools of {name}",
	mcpOffStillRunning: "off · still running",
	mcpSwitch: "Use the MCP server {name}",
	mcpSwitchLight: "A Light conversation loads the MCP servers chosen in Settings › Full / Light",
	mcpSwitchName:
		"omp’s /mcp enable and /mcp disable take one word: this name has spaces or unusual characters, so it can only be switched in mcp.json",
	mcpSwitchBoth:
		"This name is defined in your config and in this folder’s: omp lists one entry but switches the other, so edit it in the terminal",
	mcpFailed: "Couldn’t change the MCP server {name}: {error}",
	mcpRestartIdle:
		"Changed in omp’s config: {names}. omp connects its MCP servers only when it starts, so this applies after this conversation’s omp restarts. The restart resumes the same conversation from its saved file.",
	mcpRestartLater:
		"Changed in omp’s config: {names}. This conversation is busy, so the change applies the next time its omp starts, not before.",
	mcpRestartNow: "Restart omp to apply",
	mcpRestarting: "Restarting…",

	// Commands and skills
	srcBuiltin: "Built-in",
	srcExtension: "Extensions",
	srcCustom: "Custom",
	srcFile: "Prompt templates",
	aliases: "also {names}",
	subcommands: "{n} subcommands",
	skillsEmpty:
		"No skills listed. omp reports skills through their slash commands, which the skills.enableSkillCommands setting turns on.",

	// Plugins and rules
	pluginsEmpty: "No plugins installed.",
	pluginDisabled: "disabled",
	pluginShadowed: "overridden by this folder’s copy",
	pluginLight: "not loaded in Light mode",
	rulesNote: "Rules that watch what the model writes and step in when it matches (omp ttsr list).",
	rulesEmpty: "No rules.",

	// Paused, a refresh that failed, long descriptions
	paused:
		"This conversation is paused, so omp cannot be asked. Resume it to see its tools, MCP servers, commands and skills.",
	refreshFailed: "Couldn’t refresh: {error}",
	retry: "Retry",
	srcMcpPrompt: "MCP prompts",
	descriptionExpand: "Show the whole description",
	descriptionCollapse: "Show less of the description",

	// Switches for skills and plugins
	skillsNote:
		"Skills are switched off in omp’s settings (disabledExtensions), so a skill that is off stays off in every conversation. omp stops offering it at once.",
	skillOff: "off",
	skillOffTip: "Turned off: omp does not offer this skill, so it has no description here.",
	skillSwitch: "Use the skill {name}",
	skillOverridden:
		"Saved, but the {by} settings of this folder decide which extensions are off, so {name} is unchanged here.",
	skillFailed: "Couldn’t change the skill {name}: {error}",
	pluginsNote:
		"Switching a plugin reloads this conversation’s skills and commands at once. Other open conversations pick it up when their plugins reload.",
	pluginSwitch: "Use the plugin {name}",
	pluginSwitchLight: "omp loads no plugins in Light mode",
	pluginNotReloaded:
		"{name} was switched, but this conversation’s omp could not reload plugins. It will take effect when omp next starts.",
	pluginFailed: "Couldn’t change the plugin {name}: {error}",
};
