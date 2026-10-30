/**
 * The check that no page shows a translation key (`pages.newPlaceholder`) where its text belongs. Every English string
 * of the app is a key here, whole (the first-page half and the `-later` half of a namespace, and the namespaces whose
 * strings arrive with a lazy chunk), so a text on a page that is one of them is a string `t()` did not know.
 */
import { en as chat } from "../../web/src/i18n/chat.ts";
import { en as chatLater } from "../../web/src/i18n/chat-later.ts";
import { en as common } from "../../web/src/i18n/common.ts";
import { en as controlsHelp } from "../../web/src/i18n/controls-help.ts";
import { en as drop } from "../../web/src/i18n/drop.ts";
import { en as errors } from "../../web/src/i18n/errors.ts";
import { en as feedback } from "../../web/src/i18n/feedback.ts";
import { en as feedbackLater } from "../../web/src/i18n/feedback-later.ts";
import { en as files } from "../../web/src/i18n/files.ts";
import { en as guard } from "../../web/src/i18n/guard.ts";
import { en as guidance } from "../../web/src/i18n/guidance.ts";
import { en as host } from "../../web/src/i18n/host.ts";
import { en as issues } from "../../web/src/i18n/issues.ts";
import { en as loaded } from "../../web/src/i18n/loaded.ts";
import { en as loadedLater } from "../../web/src/i18n/loaded-later.ts";
import { en as macs } from "../../web/src/i18n/macs.ts";
import { en as memory } from "../../web/src/i18n/memory.ts";
import { en as migrate } from "../../web/src/i18n/migrate.ts";
import { en as mode } from "../../web/src/i18n/mode.ts";
import { en as modeLater } from "../../web/src/i18n/mode-later.ts";
import { en as navLayout } from "../../web/src/i18n/nav-layout.ts";
import { en as omp } from "../../web/src/i18n/omp.ts";
import { en as ompLater } from "../../web/src/i18n/omp-later.ts";
import { en as pages } from "../../web/src/i18n/pages.ts";
import { en as pagesLater } from "../../web/src/i18n/pages-later.ts";
import { en as panel } from "../../web/src/i18n/panel.ts";
import { en as panelLater } from "../../web/src/i18n/panel-later.ts";
import { en as presetAgents } from "../../web/src/i18n/preset-agents.ts";
import { en as presets } from "../../web/src/i18n/presets.ts";
import { en as presetsLater } from "../../web/src/i18n/presets-later.ts";
import { en as projectGroups } from "../../web/src/i18n/project-groups.ts";
import { en as projects } from "../../web/src/i18n/projects.ts";
import { en as push } from "../../web/src/i18n/push.ts";
import { en as questions } from "../../web/src/i18n/questions.ts";
import { en as quickPrompts } from "../../web/src/i18n/quick-prompts.ts";
import { en as remote } from "../../web/src/i18n/remote.ts";
import { en as remoteLater } from "../../web/src/i18n/remote-later.ts";
import { en as shell } from "../../web/src/i18n/shell.ts";
import { en as update } from "../../web/src/i18n/update.ts";

/** The namespace each English module of `web/src/i18n` belongs to (a `-later` module with its first-page half). */
export const NAMESPACES: Record<string, object[]> = {
	common: [common],
	shell: [shell],
	chat: [chat, chatLater],
	panel: [panel, panelLater],
	pages: [pages, pagesLater],
	presets: [presets, presetsLater],
	mode: [mode, modeLater],
	loaded: [loaded, loadedLater],
	feedback: [feedback, feedbackLater],
	omp: [omp, ompLater],
	navLayout: [navLayout],
	errors: [errors],
	remote: [remote, remoteLater],
	update: [update],
	files: [files],
	issues: [issues],
	quickPrompts: [quickPrompts],
	controlsHelp: [controlsHelp],
	migrate: [migrate],
	guard: [guard],
	guidance: [guidance],
	questions: [questions],
	drop: [drop],
	presetAgents: [presetAgents],
	host: [host],
	memory: [memory],
	projects: [projects],
	projectGroups: [projectGroups],
	macs: [macs],
	push: [push],
};

const KEYS = new Set<string>();
for (const [ns, mods] of Object.entries(NAMESPACES)) {
	for (const mod of mods) for (const k of Object.keys(mod)) KEYS.add(`${ns}.${k}`);
}
const CANDIDATE = new RegExp(`\\b(?:${Object.keys(NAMESPACES).join("|")})\\.[A-Za-z][A-Za-z0-9]*`, "g");

/** The translation keys that `text` shows as they are (each once). */
export function rawKeysIn(text: string): string[] {
	const found = new Set<string>();
	for (const m of text.matchAll(CANDIDATE)) if (KEYS.has(m[0])) found.add(m[0]);
	return [...found];
}
