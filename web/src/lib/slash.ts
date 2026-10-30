import type { MessageKey } from "../i18n/index.ts";
import type { SlashCommand } from "../store/live.ts";

/**
 * omp sends a `/name` it does not know to the model as an ordinary message, which costs a turn. Many of the
 * terminal's commands (`/new`, `/tree`, `/resume`…) are not available over RPC at all, so the composer holds such a
 * message back and says what to use in the web UI instead. What counts as unknown is decided by the live process's
 * own command catalog; until that has loaded, only the names known to be terminal-only are held back.
 */

/** Where a terminal-only command lives in the web UI. */
export interface WebEquivalent {
	/** Says where to find it. */
	hint: MessageKey;
	/** A button that goes there, for the ones that have somewhere to go. */
	action?: { label: MessageKey; to: "new" | "settings" | "panel" | "search" | "shortcuts" };
}

const NEW: WebEquivalent = { hint: "chat.slashWebNew", action: { label: "shell.sidebarNewChat", to: "new" } };
const CLEAR: WebEquivalent = { hint: "chat.slashWebClear", action: { label: "shell.sidebarNewChat", to: "new" } };
const SETTINGS: WebEquivalent = {
	hint: "chat.slashWebSettings",
	action: { label: "shell.sidebarNavSettings", to: "settings" },
};
const BRANCH: WebEquivalent = { hint: "chat.slashWebBranch", action: { label: "chat.slashOpenPanel", to: "panel" } };

/** The terminal-only commands that have a counterpart in the web UI, by name. */
export const WEB_EQUIVALENTS: Record<string, WebEquivalent> = {
	new: NEW,
	clear: CLEAR,
	resume: { hint: "chat.slashWebResume", action: { label: "chat.slashSearch", to: "search" } },
	tree: { hint: "chat.slashWebTree", action: { label: "chat.slashOpenPanel", to: "panel" } },
	branch: BRANCH,
	rewind: BRANCH,
	fork: BRANCH,
	btw: { hint: "chat.slashWebBtw", action: { label: "chat.slashOpenPanel", to: "panel" } },
	settings: SETTINGS,
	setup: SETTINGS,
	login: SETTINGS,
	logout: SETTINGS,
	hotkeys: { hint: "chat.slashWebHotkeys", action: { label: "shell.shortcutsTitle", to: "shortcuts" } },
	pause: { hint: "chat.slashWebPause" },
	goal: { hint: "chat.slashWebGoal" },
	"guided-goal": { hint: "chat.slashWebGoal" },
	plan: { hint: "chat.slashWebPlan", action: { label: "shell.sidebarNewChat", to: "new" } },
	// Where a conversation is open these show the Loaded dialog instead (`loadedSlash`); the page for a new chat has no
	// conversation to show it for, so it holds them back and says where to find it.
	status: { hint: "loaded.slashHint" },
	extensions: { hint: "loaded.slashHint" },
	skills: { hint: "loaded.slashHint" },
};

/** What `name` is in the web UI, when it is a terminal-only command that has a counterpart. */
export function webEquivalent(name: string): WebEquivalent | undefined {
	const key = name.toLowerCase();
	return Object.hasOwn(WEB_EQUIVALENTS, key) ? WEB_EQUIVALENTS[key] : undefined;
}

/** `clear` of `/clear now`; null when the text is not a command: a path, a sentence, a lone slash. */
export function slashName(text: string): string | null {
	return /^\/([A-Za-z][\w.:-]*)(?:\s|$)/.exec(text)?.[1] ?? null;
}

/** Whether omp would run `name` itself: a catalog entry, an alias, or a catalog entry's `prefix:` form (`/force:read`). */
function isKnown(name: string, commands: SlashCommand[]): boolean {
	const lower = name.toLowerCase();
	const head = lower.includes(":") ? lower.slice(0, lower.indexOf(":")) : null;
	return commands.some((c) => {
		const names = [c.name, ...(c.aliases ?? [])].map((n) => n.toLowerCase());
		return names.includes(lower) || (head !== null && (names.includes(head) || names.includes(`${head}:`)));
	});
}

/**
 * The terminal commands whose answer is the Loaded dialog: `/status` opens the Extension Control Center, which lists
 * extensions, skills, rules, tools and MCP servers. omp does not run them over RPC: it would hand the line to the model.
 */
const LOADED_COMMANDS = ["status", "extensions", "skills"];

/** Whether `text` asks for the Loaded dialog: one of its commands, unless omp's own catalog has a command of that name. */
export function loadedSlash(text: string, commands: SlashCommand[]): boolean {
	const name = slashName(text)?.toLowerCase();
	return name !== undefined && LOADED_COMMANDS.includes(name) && !isKnown(name, commands);
}

/** The Loaded commands as catalog entries, for the composer's suggestions (omp's own catalog has none of them). */
export function loadedCommands(commands: SlashCommand[], description: string): SlashCommand[] {
	return LOADED_COMMANDS.filter((name) => !isKnown(name, commands)).map((name) => ({
		name,
		source: "web",
		description,
	}));
}

/** The name of the command in `text` that omp would not run, or null when the text should be sent. */
export function unknownSlash(text: string, commands: SlashCommand[]): string | null {
	const name = slashName(text);
	if (!name) return null;
	if (commands.length) return isKnown(name, commands) ? null : name;
	return webEquivalent(name) ? name : null;
}

/**
 * Whether omp runs `text` itself, at once, as a command — or whether it is a message for the model. A path, a sentence
 * that starts with a slash, and a `/name` omp does not know are all messages: they reach the model as text (the composer
 * holds the last one back, and it can be sent anyway). Text with images is a message too: the composer does not read a
 * command out of it.
 */
export function isCommand(text: string, hasImages: boolean, commands: SlashCommand[]): boolean {
	if (hasImages) return false;
	return slashName(text) !== null && unknownSlash(text, commands) === null;
}
