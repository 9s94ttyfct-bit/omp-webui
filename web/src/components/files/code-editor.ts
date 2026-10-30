import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
	drawSelection,
	EditorView,
	highlightActiveLine,
	highlightActiveLineGutter,
	highlightSpecialChars,
	keymap,
	lineNumbers,
	type ViewUpdate,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { extensionOf } from "@shared/folder.ts";

/**
 * The editor of the Files tab's large view (`FileEditor.tsx`): CodeMirror 6 with what a person editing a file expects (undo and
 * redo, find and replace on ⌘F, indent, brackets, the file's language for the common ones) and nothing else. It is loaded when
 * Edit is pressed and not before: none of this is in the first page load. A language is loaded after that, when a file of
 * it is edited (`setLanguage`): the editor is usable at once, and colours arrive with the mode.
 *
 * The look is the page's: the colours are the palette's CSS variables (`palettes.css`: the same `--shiki-*` colours the file
 * is shown in, `--code-bg`, `--fg`, `--border`…), so a change of palette or of light and dark needs no change here; the
 * face is `--font-mono` and the size is the container's (`text-xs`, the caption step of the type scale), which CodeMirror
 * inherits.
 */

/** The modes worth having, by the extension of the file's name; a file of another kind is plain text. Each is a chunk of its own. */
const LANGUAGES: Record<string, () => Promise<Extension>> = {
	js: () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
	mjs: () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
	cjs: () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
	jsx: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true })),
	ts: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true })),
	mts: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true })),
	cts: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true })),
	tsx: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true, jsx: true })),
	json: () => import("@codemirror/lang-json").then((m) => m.json()),
	jsonc: () => import("@codemirror/lang-json").then((m) => m.json()),
	css: () => import("@codemirror/lang-css").then((m) => m.css()),
	html: () => import("@codemirror/lang-html").then((m) => m.html()),
	htm: () => import("@codemirror/lang-html").then((m) => m.html()),
	svg: () => import("@codemirror/lang-html").then((m) => m.html()),
	xml: () => import("@codemirror/lang-html").then((m) => m.html()),
	md: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),
	markdown: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),
	py: () => import("@codemirror/lang-python").then((m) => m.python()),
};

/** Where a state's language goes: filled by `setLanguage` once the mode is loaded. */
const language = new Compartment();

/** Give the editor the mode of the file `name` (nothing for a file that has none, or when the editor is gone by the time it is loaded). */
export async function setLanguage(view: EditorView, name: string): Promise<void> {
	const load = LANGUAGES[extensionOf(name)];
	if (!load) return;
	const mode = await load().catch(() => null);
	if (mode && view.dom.isConnected) view.dispatch({ effects: language.reconfigure(mode) });
}

/** Prose wraps; code scrolls sideways (as the read-only view's does). */
const wraps = (name: string): boolean => ["md", "markdown"].includes(extensionOf(name));

const mix = (colour: string, percent: number) => `color-mix(in srgb, ${colour} ${percent}%, transparent)`;

const theme = EditorView.theme({
	"&": { height: "100%", color: "var(--shiki-foreground)", backgroundColor: "var(--code-bg)" },
	"&.cm-focused": { outline: "none" },
	".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.625", overflow: "auto" },
	".cm-content": { padding: "0.75rem 0", caretColor: "var(--fg)" },
	".cm-line": { padding: "0 0.75rem" },
	".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg)" },
	"&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
		{ backgroundColor: mix("var(--accent)", 28) },
	".cm-activeLine": { backgroundColor: mix("var(--fg)", 5) },
	".cm-gutters": { backgroundColor: "transparent", color: "var(--faint)", border: "none" },
	".cm-lineNumbers .cm-gutterElement": { minWidth: "3.5ch", padding: "0 0.5rem 0 0.75rem" },
	".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--fg)" },
	"&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket": {
		backgroundColor: "var(--accent-soft)",
		outline: `1px solid ${mix("var(--accent)", 55)}`,
	},
	// Matches are outlined, not tinted: the colour of a comment (and of any token) keeps the contrast the palette gives it on the
	// editor's own background, and a tint under it would not. (CodeMirror's own tints are for its light and dark themes, and this
	// one is neither: the palette decides, so they are taken off.)
	".cm-selectionMatch": { backgroundColor: "transparent", outline: `1px solid ${mix("var(--fg)", 40)}` },
	".cm-searchMatch": { backgroundColor: "transparent", outline: `1px solid ${mix("var(--accent)", 70)}` },
	".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "transparent", outline: "2px solid var(--accent)" },
	".cm-panels": { backgroundColor: "var(--surface)", color: "var(--fg)" },
	".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
	".cm-panel.cm-search": { padding: "0.5rem 2rem 0.5rem 0.75rem" },
	".cm-panel.cm-search label": { color: "var(--muted)" },
	".cm-panel.cm-search [name=close]": { color: "var(--muted)", cursor: "pointer" },
	".cm-textfield": {
		backgroundColor: "var(--code-bg)",
		color: "var(--fg)",
		border: "1px solid var(--border)",
		borderRadius: "var(--radius-md)",
		padding: "0.125rem 0.5rem",
	},
	".cm-textfield:focus": { outline: "2px solid var(--ring)", outlineOffset: "0" },
	".cm-button": {
		backgroundColor: "var(--bg-soft)",
		backgroundImage: "none",
		color: "var(--fg)",
		border: "1px solid var(--border)",
		borderRadius: "var(--radius-md)",
		padding: "0.125rem 0.5rem",
	},
	".cm-button:hover": { backgroundColor: "var(--hover)" },
	".cm-button:active": { backgroundColor: "var(--hover)", backgroundImage: "none" },
	".cm-tooltip": { backgroundColor: "var(--surface)", color: "var(--fg)", border: "1px solid var(--border)" },
});

/** The colours of the code are the ones the file is shown in (`--shiki-*`), by what CodeMirror's parsers call things. */
const colours = HighlightStyle.define([
	{ tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: "var(--shiki-token-comment)" },
	{
		tag: [
			tags.keyword,
			tags.modifier,
			tags.operatorKeyword,
			tags.controlKeyword,
			tags.definitionKeyword,
			tags.moduleKeyword,
			tags.tagName,
		],
		color: "var(--shiki-token-keyword)",
	},
	{
		tag: [tags.string, tags.special(tags.string), tags.regexp, tags.character, tags.attributeValue],
		color: "var(--shiki-token-string)",
	},
	{
		tag: [tags.number, tags.bool, tags.null, tags.atom, tags.self, tags.constant(tags.name), tags.propertyName],
		color: "var(--shiki-token-constant)",
	},
	{
		tag: [
			tags.function(tags.variableName),
			tags.function(tags.propertyName),
			tags.definition(tags.variableName),
			tags.className,
			tags.typeName,
			tags.namespace,
			tags.attributeName,
		],
		color: "var(--shiki-token-function)",
	},
	{ tag: [tags.link, tags.url], color: "var(--shiki-token-link)", textDecoration: "underline" },
	{ tag: [tags.heading, tags.strong], fontWeight: "bold" },
	{ tag: tags.heading, color: "var(--shiki-token-keyword)" },
	{ tag: tags.emphasis, fontStyle: "italic" },
	{ tag: tags.strikethrough, textDecoration: "line-through" },
	{ tag: tags.inserted, color: "var(--shiki-token-inserted)" },
	{ tag: tags.deleted, color: "var(--shiki-token-deleted)" },
	{ tag: tags.changed, color: "var(--shiki-token-changed)" },
	{ tag: [tags.punctuation, tags.bracket, tags.separator, tags.operator], color: "var(--shiki-token-punctuation)" },
]);

export interface EditorConfig {
	/** The file's name: its extension picks the language. */
	name: string;
	/** What a screen reader says of the text area. */
	label: string;
	/** The find panel's words in the page's language (CodeMirror's own phrases are English). */
	phrases: Record<string, string>;
	/** Told of every change of the view (the text, the selection, the focus). */
	onUpdate(update: ViewUpdate): void;
}

/** The state of an editor holding `doc`: its history is its own, so a state made for another text starts with none. */
export function editorState(doc: string, config: EditorConfig): EditorState {
	return EditorState.create({
		doc,
		extensions: [
			lineNumbers(),
			highlightActiveLineGutter(),
			highlightSpecialChars(),
			history(),
			drawSelection(),
			indentOnInput(),
			bracketMatching(),
			highlightActiveLine(),
			highlightSelectionMatches(),
			search({ top: true }),
			keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
			syntaxHighlighting(colours),
			theme,
			EditorState.phrases.of(config.phrases),
			EditorView.contentAttributes.of({
				"aria-label": config.label,
				spellcheck: "false",
				autocapitalize: "off",
				autocorrect: "off",
			}),
			EditorView.updateListener.of(config.onUpdate),
			...(wraps(config.name) ? [EditorView.lineWrapping] : []),
			// Empty until `setLanguage` has the mode.
			language.of([]),
		],
	});
}

export { EditorView };
