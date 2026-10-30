/**
 * Strings for the Loaded dialog: what a conversation has loaded (tools, MCP servers, commands, skills, plugins, rules).
 *
 * Only the strings a module of the first page load asks for: `tests/unit/i18n-first-load.test.ts` holds this
 * file to that. The rest are in `loaded-later.ts`.
 */
export const en = {
	// Typing /status, /extensions or /skills where there is no conversation to ask about
	slashHint:
		"Open a conversation first: its header has a “Loaded in this chat” button listing its tools, MCP servers, commands, skills, plugins and rules.",
	slashDescription: "Show what is loaded in this chat",
};
