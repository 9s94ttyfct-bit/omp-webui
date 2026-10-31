import { PREF } from "@shared/prefs.ts";
import { create } from "zustand";
import { setPref } from "../lib/prefs.ts";
import * as chat from "./chat.ts";
import type * as chatLater from "./chat-later.ts";
import type * as ci from "./ci.ts";
import * as common from "./common.ts";
// Not imported for its values: the English strings of a namespace that only a lazily loaded chunk uses are registered by
// that chunk (`registerStrings`), so the first page does not carry them. The type is what keeps its keys checked.
import type * as controlsHelp from "./controls-help.ts";
import type * as drop from "./drop.ts";
import * as errors from "./errors.ts";
import * as feedback from "./feedback.ts";
import type * as feedbackLater from "./feedback-later.ts";
import type * as files from "./files.ts";
import type * as guard from "./guard.ts";
import type * as guidance from "./guidance.ts";
import type * as host from "./host.ts";
import type * as issues from "./issues.ts";
import * as loaded from "./loaded.ts";
import type * as loadedLater from "./loaded-later.ts";
import type * as macs from "./macs.ts";
import type * as memory from "./memory.ts";
import type * as migrate from "./migrate.ts";
import * as mode from "./mode.ts";
import type * as modeLater from "./mode-later.ts";
import type * as navLayout from "./nav-layout.ts";
import * as omp from "./omp.ts";
import type * as ompLater from "./omp-later.ts";
import * as pages from "./pages.ts";
import type * as pagesLater from "./pages-later.ts";
import * as panel from "./panel.ts";
import type * as panelLater from "./panel-later.ts";
import type * as presetAgents from "./preset-agents.ts";
import * as presets from "./presets.ts";
import type * as presetsLater from "./presets-later.ts";
import type * as projectGroups from "./project-groups.ts";
import type * as projects from "./projects.ts";
import type * as push from "./push.ts";
import type * as questions from "./questions.ts";
import type * as quickPrompts from "./quick-prompts.ts";
import * as remote from "./remote.ts";
import type * as remoteLater from "./remote-later.ts";
import * as shell from "./shell.ts";
import type * as update from "./update.ts";

/**
 * Interface language. Each namespace module exports `en` (the source strings);
 * `zh-CN/<namespace>.ts` exports `zh` typed as `Record<keyof typeof en, string>`,
 * so a missing translation is a type error. The zh-CN pack is a separate chunk
 * loaded only when chosen. Keys are `<namespace>.<key>`; `{name}` placeholders
 * are filled from `vars`. omp's own content is never translated.
 *
 * The strings of the first page are the ones its modules ask for, and the ones the chunks the home page fetches as its
 * process starts ask for (the New chat pickers, request cards and quota meter). A namespace that has more than that
 * keeps the rest in `<namespace>-later.ts`, which `later.ts` registers: a module outside the first page that uses one
 * of them imports `later.ts`. `tests/unit/i18n-first-load.test.ts` holds both halves to that.
 */

export type Lang = "en" | "zh-CN";
export const LANGS: { value: Lang; label: string }[] = [
	{ value: "en", label: "English" },
	{ value: "zh-CN", label: "简体中文" },
];

const MODULES = { common, shell, chat, panel, pages, presets, mode, loaded, feedback, omp, errors, remote };
/** Namespaces whose English strings are not in the first page (see `registerStrings`). */
type LazyModules = {
	update: typeof update;
	files: typeof files;
	issues: typeof issues;
	ci: typeof ci;
	quickPrompts: typeof quickPrompts;
	controlsHelp: typeof controlsHelp;
	presetAgents: typeof presetAgents;
	drop: typeof drop;
	navLayout: typeof navLayout;
};
type Modules = typeof MODULES & LazyModules;
/**
 * The `-later` halves of the namespaces in `MODULES` that have one. Only their types are imported here: the keys are
 * known to `t()`, the text is registered by `later.ts` (see `registerLater`).
 */
type LaterModules = {
	chat: typeof chatLater;
	panel: typeof panelLater;
	pages: typeof pagesLater;
	presets: typeof presetsLater;
	mode: typeof modeLater;
	loaded: typeof loadedLater;
	feedback: typeof feedbackLater;
	omp: typeof ompLater;
	remote: typeof remoteLater;
};
/** Every key of a namespace: those of its module and, when it has one, those of its `-later` module. */
type NamespaceKeys<NS extends keyof Modules> =
	| keyof Modules[NS]["en"]
	| (NS extends keyof LaterModules ? keyof LaterModules[NS]["en"] : never);

/**
 * Namespaces that are not in `MODULES` because their strings travel with a lazy chunk (`addStrings`), so that the first
 * chunk does not carry them. Only their types are imported here: the keys are known to `t()`, the text arrives at run time.
 */
type LazyKey =
	| `migrate.${Extract<keyof typeof migrate.en, string>}`
	| `guard.${Extract<keyof typeof guard.en, string>}`
	| `memory.${Extract<keyof typeof memory.en, string>}`
	| `host.${Extract<keyof typeof host.en, string>}`
	| `projects.${Extract<keyof typeof projects.en, string>}`
	| `projectGroups.${Extract<keyof typeof projectGroups.en, string>}`
	| `macs.${Extract<keyof typeof macs.en, string>}`
	| `push.${Extract<keyof typeof push.en, string>}`
	| `questions.${Extract<keyof typeof questions.en, string>}`
	| `guidance.${Extract<keyof typeof guidance.en, string>}`;

export type MessageKey =
	| { [NS in keyof Modules]: `${NS}.${Extract<NamespaceKeys<NS>, string>}` }[keyof Modules]
	| LazyKey;

/** What a language pack must provide: every namespace, every key. */
type Pack = { [NS in keyof Modules]: { zh: Record<NamespaceKeys<NS>, string> } };

function flatten(mods: Record<string, Record<string, string>>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [ns, strings] of Object.entries(mods)) {
		for (const [k, v] of Object.entries(strings)) out[`${ns}.${k}`] = v;
	}
	return out;
}

const EN = flatten(Object.fromEntries(Object.entries(MODULES).map(([ns, m]) => [ns, m.en])));

const DICTS: Partial<Record<Lang, Record<string, string>>> = { en: EN };

/** Make the English strings of a lazily loaded namespace known. Called when its chunk is evaluated, before it renders. */
export function registerStrings<NS extends keyof LazyModules>(ns: NS, strings: LazyModules[NS]["en"]): void {
	addStrings("en", ns, strings);
}

/** Make the English strings of the `-later` modules known. `later.ts` does this when it is evaluated, before a module that imports it runs. */
export function registerLater(strings: { [NS in keyof LaterModules]: LaterModules[NS]["en"] }): void {
	Object.assign(EN, flatten(strings));
}

/**
 * Add the strings of one namespace to `lang` (a lazy chunk does this when it loads, for English at once and for another
 * language once its pack for the namespace has arrived). Until then `t()` answers with English, then with the key.
 * The dictionary is added to in place, never replaced: `registerStrings` and `addStrings` both write to the one
 * `DICTS[lang]`, so a namespace registered after another one was added is not lost (v0.11.11's Files tab showed its
 * keys once the guard's strings had been added first).
 */
export function addStrings(lang: Lang, namespace: string, strings: Record<string, string>): void {
	const dict = DICTS[lang] ?? {};
	DICTS[lang] = Object.assign(dict, flatten({ [namespace]: strings }));
}

/** The languages whose pack has been loaded (a lazy namespace may already have put strings in `DICTS[lang]`). */
const packed = new Set<Lang>(["en"]);

async function loadPack(lang: Lang): Promise<void> {
	if (packed.has(lang)) return;
	// Runtime-selected language pack: a dynamic import keeps it out of the initial chunk.
	const pack: Pack = await import("./zh-CN/index.ts");
	// What a lazy namespace added already is the same text: the pack's own strings go under it.
	DICTS[lang] = {
		...flatten(Object.fromEntries(Object.entries(pack).map(([ns, m]) => [ns, m.zh]))),
		...DICTS[lang],
	};
	packed.add(lang);
}

// Browser globals are absent when helpers that translate are unit-tested outside a page.
const inBrowser = typeof window !== "undefined";

function preferredLang(): Lang {
	if (!inBrowser) return "en";
	const saved = localStorage.getItem(PREF.lang);
	if (saved === "en" || saved === "zh-CN") return saved;
	return navigator.language?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

function apply(lang: Lang): void {
	if (inBrowser) document.documentElement.lang = lang;
	useLang.setState({ lang });
}

/** Show `lang` without choosing it: another page chose it and the preference is already stored (`lib/prefs-live.ts`). */
export async function showLang(lang: Lang): Promise<void> {
	await loadPack(lang);
	apply(lang);
}

export const useLang = create<{ lang: Lang; setLang: (l: Lang) => Promise<void> }>(() => ({
	lang: "en",
	setLang: async (lang) => {
		setPref(PREF.lang, lang);
		await showLang(lang);
	},
}));

/** Resolves once the preferred language is loaded; render after it to avoid a flash of English. */
export const i18nReady: Promise<void> = (async () => {
	const lang = preferredLang();
	try {
		await loadPack(lang);
		apply(lang);
	} catch {
		apply("en");
	}
})();

export type Vars = Record<string, string | number>;

/** How the page translates: `t` outside React, `useT` in components. */
export type Translate = (key: MessageKey, vars?: Vars) => string;

function format(lang: Lang, key: MessageKey, vars?: Vars): string {
	const s = DICTS[lang]?.[key] ?? DICTS.en?.[key] ?? key;
	return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** Translate outside React (stores, toasts). */
export function t(key: MessageKey, vars?: Vars): string {
	return format(useLang.getState().lang, key, vars);
}

/** Translate in components; re-renders when the language changes. */
export function useT(): Translate {
	const lang = useLang((s) => s.lang);
	return (key, vars) => format(lang, key, vars);
}
