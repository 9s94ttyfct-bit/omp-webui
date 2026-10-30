/**
 * Strings for Full / Light mode: New chat's chip, the dot of a conversation in the list, and the names of what Light loads.
 *
 * Only the strings a module of the first page load asks for: `tests/unit/i18n-first-load.test.ts` holds this
 * file to that. The rest are in `mode-later.ts`.
 */
export const en = {
	// New chat's chip
	full: "Full",
	light: "Light",
	pickerTitle: "Full or Light for new conversations",
	pickerMenu: "Mode for new conversations",
	/** In front of Full / Light in the composer's "⋯" panel, where the control says which setting it is: "Mode: Full". */
	chipPrefix: "Mode:",
	/** The chip's name, which starts with what it shows in the "⋯" panel ("Mode: Full") and contains it elsewhere ("Full"). */
	pickerLabel: "Mode: {mode}",
	fullHint: "Your models, tools, MCP servers and skills, as omp is configured.",
	lightHintYours: "Only the tools, MCP servers and skills chosen in Settings, on your own models.",
	lightHintLocal: "Only the tools, MCP servers and skills chosen in Settings, on {backend} models.",
	lightHintUnknown: "a local server's",
	liveState: "{state} · Light mode",

	// Settings: what Light loads
	mcpLabel: "MCP servers",
	toolsLabel: "Tools",
	skillsLabel: "Skills",

	// Settings: MCP servers that are gone
	mcpMissingToast:
		"Light mode starts without these selected MCP servers, which are not in your mcp.json: {names}. Restore them in mcp.json, or remove them under Settings › Full / Light.",
};
