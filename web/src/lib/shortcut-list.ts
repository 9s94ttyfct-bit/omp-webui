/**
 * The bindings as Settings › Keyboard shortcuts lists them: the surface each acts on and its name. The ids and default
 * chords are `shortcuts.ts`'s (`DEFAULT_CHORDS`), which the key handlers match through; this table must name every one of
 * them (`satisfies`), so the list cannot leave a key out. Only that card reads it, so it is in its chunk.
 */

import "../i18n/later.ts";
import type { MessageKey } from "../i18n/index.ts";
import type { ShortcutId } from "./shortcuts.ts";

export type ShortcutScope = "Global" | "Composer" | "Subagent full screen" | "Command menu" | "Model picker";

/** Display heading for each scope; the scope values themselves are stable ids. */
export const SCOPE_KEYS: Record<ShortcutScope, MessageKey> = {
	Global: "pages.scopeGlobal",
	Composer: "pages.scopeComposer",
	"Subagent full screen": "pages.scopeAgentFull",
	"Command menu": "pages.scopeCommandMenu",
	"Model picker": "pages.scopeModelPicker",
};

export interface Shortcut {
	scope: ShortcutScope;
	labelKey: MessageKey;
	/** A convention of the surface (Esc closes, arrows move in a list, Shift+Enter is the text field's own line break): listed, and in the way of a binding that collides with it, but not rebound. */
	fixed?: true;
}

export const SHORTCUTS = {
	search: { scope: "Global", labelKey: "pages.shortcutSearch" },
	newChat: { scope: "Global", labelKey: "pages.shortcutNewChat" },
	sidebar: { scope: "Global", labelKey: "pages.shortcutSidebar" },
	goal: { scope: "Global", labelKey: "pages.shortcutGoal" },
	approval: { scope: "Global", labelKey: "pages.shortcutApproval" },
	toasts: { scope: "Global", labelKey: "pages.shortcutToasts" },
	help: { scope: "Global", labelKey: "pages.shortcutHelp" },
	send: { scope: "Composer", labelKey: "pages.shortcutSend" },
	steer: { scope: "Composer", labelKey: "pages.shortcutSteer" },
	ghostAccept: { scope: "Composer", labelKey: "pages.shortcutGhostAccept" },
	ghostAcceptBare: { scope: "Composer", labelKey: "pages.shortcutGhostAcceptBare" },
	newline: { scope: "Composer", labelKey: "pages.shortcutNewline", fixed: true },
	stop: { scope: "Composer", labelKey: "pages.shortcutStop", fixed: true },
	presetCycle: { scope: "Composer", labelKey: "shell.shortcutPresetCycle" },
	agentExit: { scope: "Subagent full screen", labelKey: "pages.shortcutAgentExit", fixed: true },
	agentPrev: { scope: "Subagent full screen", labelKey: "pages.shortcutAgentPrev" },
	agentNext: { scope: "Subagent full screen", labelKey: "pages.shortcutAgentNext" },
	agentList: { scope: "Subagent full screen", labelKey: "pages.shortcutAgentList" },
	menuNext: { scope: "Command menu", labelKey: "pages.shortcutMenuNext", fixed: true },
	menuPrev: { scope: "Command menu", labelKey: "pages.shortcutMenuPrev", fixed: true },
	menuAccept: { scope: "Command menu", labelKey: "pages.shortcutMenuAccept", fixed: true },
	menuDismiss: { scope: "Command menu", labelKey: "pages.shortcutMenuDismiss", fixed: true },
	modelLove: { scope: "Model picker", labelKey: "pages.shortcutModelLove" },
} satisfies Record<ShortcutId, Shortcut>;
