import {
	createCssVariablesTheme,
	createHighlighterCore,
	type HighlighterCore,
	type LanguageRegistration,
} from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

/**
 * Code highlighting: shiki's core with its JavaScript regex engine (no WebAssembly), one theme whose colours are CSS
 * variables (`--shiki-token-keyword` and the rest, defined per palette and mode in palettes.css, so the same HTML suits
 * every palette and recolours when the palette changes) and the grammars below, each its own chunk, loaded the first
 * time a code block names it. A language that is not here is shown as plain text. Runs inside `highlight.worker.ts`;
 * nothing here touches the page.
 */

/** The one theme: shiki's CSS-variables theme, variables prefixed `--shiki-`. */
const THEME_NAME = "omp";
const THEME = createCssVariablesTheme({ name: THEME_NAME, variablePrefix: "--shiki-" });

type Grammar = () => Promise<{ default: LanguageRegistration[] }>;

const GRAMMARS = {
	ada: () => import("shiki/langs/ada.mjs"),
	apache: () => import("shiki/langs/apache.mjs"),
	asciidoc: () => import("shiki/langs/asciidoc.mjs"),
	astro: () => import("shiki/langs/astro.mjs"),
	awk: () => import("shiki/langs/awk.mjs"),
	bat: () => import("shiki/langs/bat.mjs"),
	bicep: () => import("shiki/langs/bicep.mjs"),
	c: () => import("shiki/langs/c.mjs"),
	clojure: () => import("shiki/langs/clojure.mjs"),
	cmake: () => import("shiki/langs/cmake.mjs"),
	coffee: () => import("shiki/langs/coffee.mjs"),
	cpp: () => import("shiki/langs/cpp.mjs"),
	crystal: () => import("shiki/langs/crystal.mjs"),
	csharp: () => import("shiki/langs/csharp.mjs"),
	css: () => import("shiki/langs/css.mjs"),
	csv: () => import("shiki/langs/csv.mjs"),
	cue: () => import("shiki/langs/cue.mjs"),
	d: () => import("shiki/langs/d.mjs"),
	dart: () => import("shiki/langs/dart.mjs"),
	diff: () => import("shiki/langs/diff.mjs"),
	docker: () => import("shiki/langs/docker.mjs"),
	dotenv: () => import("shiki/langs/dotenv.mjs"),
	elixir: () => import("shiki/langs/elixir.mjs"),
	elm: () => import("shiki/langs/elm.mjs"),
	"emacs-lisp": () => import("shiki/langs/emacs-lisp.mjs"),
	erb: () => import("shiki/langs/erb.mjs"),
	erlang: () => import("shiki/langs/erlang.mjs"),
	fish: () => import("shiki/langs/fish.mjs"),
	"fortran-free-form": () => import("shiki/langs/fortran-free-form.mjs"),
	fsharp: () => import("shiki/langs/fsharp.mjs"),
	gdscript: () => import("shiki/langs/gdscript.mjs"),
	"git-commit": () => import("shiki/langs/git-commit.mjs"),
	"git-rebase": () => import("shiki/langs/git-rebase.mjs"),
	gleam: () => import("shiki/langs/gleam.mjs"),
	glsl: () => import("shiki/langs/glsl.mjs"),
	go: () => import("shiki/langs/go.mjs"),
	graphql: () => import("shiki/langs/graphql.mjs"),
	groovy: () => import("shiki/langs/groovy.mjs"),
	haml: () => import("shiki/langs/haml.mjs"),
	handlebars: () => import("shiki/langs/handlebars.mjs"),
	haskell: () => import("shiki/langs/haskell.mjs"),
	hcl: () => import("shiki/langs/hcl.mjs"),
	hjson: () => import("shiki/langs/hjson.mjs"),
	hlsl: () => import("shiki/langs/hlsl.mjs"),
	html: () => import("shiki/langs/html.mjs"),
	http: () => import("shiki/langs/http.mjs"),
	ini: () => import("shiki/langs/ini.mjs"),
	java: () => import("shiki/langs/java.mjs"),
	javascript: () => import("shiki/langs/javascript.mjs"),
	jinja: () => import("shiki/langs/jinja.mjs"),
	json: () => import("shiki/langs/json.mjs"),
	json5: () => import("shiki/langs/json5.mjs"),
	jsonc: () => import("shiki/langs/jsonc.mjs"),
	jsonl: () => import("shiki/langs/jsonl.mjs"),
	jsonnet: () => import("shiki/langs/jsonnet.mjs"),
	jsx: () => import("shiki/langs/jsx.mjs"),
	julia: () => import("shiki/langs/julia.mjs"),
	just: () => import("shiki/langs/just.mjs"),
	kdl: () => import("shiki/langs/kdl.mjs"),
	kotlin: () => import("shiki/langs/kotlin.mjs"),
	latex: () => import("shiki/langs/latex.mjs"),
	lean: () => import("shiki/langs/lean.mjs"),
	less: () => import("shiki/langs/less.mjs"),
	liquid: () => import("shiki/langs/liquid.mjs"),
	log: () => import("shiki/langs/log.mjs"),
	lua: () => import("shiki/langs/lua.mjs"),
	make: () => import("shiki/langs/make.mjs"),
	markdown: () => import("shiki/langs/markdown.mjs"),
	matlab: () => import("shiki/langs/matlab.mjs"),
	mdx: () => import("shiki/langs/mdx.mjs"),
	mermaid: () => import("shiki/langs/mermaid.mjs"),
	nginx: () => import("shiki/langs/nginx.mjs"),
	nim: () => import("shiki/langs/nim.mjs"),
	nix: () => import("shiki/langs/nix.mjs"),
	nushell: () => import("shiki/langs/nushell.mjs"),
	"objective-c": () => import("shiki/langs/objective-c.mjs"),
	"objective-cpp": () => import("shiki/langs/objective-cpp.mjs"),
	ocaml: () => import("shiki/langs/ocaml.mjs"),
	odin: () => import("shiki/langs/odin.mjs"),
	pascal: () => import("shiki/langs/pascal.mjs"),
	perl: () => import("shiki/langs/perl.mjs"),
	php: () => import("shiki/langs/php.mjs"),
	postcss: () => import("shiki/langs/postcss.mjs"),
	powershell: () => import("shiki/langs/powershell.mjs"),
	prisma: () => import("shiki/langs/prisma.mjs"),
	proto: () => import("shiki/langs/proto.mjs"),
	pug: () => import("shiki/langs/pug.mjs"),
	python: () => import("shiki/langs/python.mjs"),
	r: () => import("shiki/langs/r.mjs"),
	racket: () => import("shiki/langs/racket.mjs"),
	razor: () => import("shiki/langs/razor.mjs"),
	regexp: () => import("shiki/langs/regexp.mjs"),
	ron: () => import("shiki/langs/ron.mjs"),
	rst: () => import("shiki/langs/rst.mjs"),
	ruby: () => import("shiki/langs/ruby.mjs"),
	rust: () => import("shiki/langs/rust.mjs"),
	sass: () => import("shiki/langs/sass.mjs"),
	scala: () => import("shiki/langs/scala.mjs"),
	scheme: () => import("shiki/langs/scheme.mjs"),
	scss: () => import("shiki/langs/scss.mjs"),
	shellscript: () => import("shiki/langs/shellscript.mjs"),
	shellsession: () => import("shiki/langs/shellsession.mjs"),
	solidity: () => import("shiki/langs/solidity.mjs"),
	"ssh-config": () => import("shiki/langs/ssh-config.mjs"),
	stylus: () => import("shiki/langs/stylus.mjs"),
	svelte: () => import("shiki/langs/svelte.mjs"),
	swift: () => import("shiki/langs/swift.mjs"),
	systemd: () => import("shiki/langs/systemd.mjs"),
	tcl: () => import("shiki/langs/tcl.mjs"),
	templ: () => import("shiki/langs/templ.mjs"),
	terraform: () => import("shiki/langs/terraform.mjs"),
	toml: () => import("shiki/langs/toml.mjs"),
	tsv: () => import("shiki/langs/tsv.mjs"),
	tsx: () => import("shiki/langs/tsx.mjs"),
	twig: () => import("shiki/langs/twig.mjs"),
	typescript: () => import("shiki/langs/typescript.mjs"),
	typespec: () => import("shiki/langs/typespec.mjs"),
	typst: () => import("shiki/langs/typst.mjs"),
	verilog: () => import("shiki/langs/verilog.mjs"),
	vhdl: () => import("shiki/langs/vhdl.mjs"),
	viml: () => import("shiki/langs/viml.mjs"),
	vb: () => import("shiki/langs/vb.mjs"),
	vue: () => import("shiki/langs/vue.mjs"),
	wgsl: () => import("shiki/langs/wgsl.mjs"),
	xml: () => import("shiki/langs/xml.mjs"),
	yaml: () => import("shiki/langs/yaml.mjs"),
	zig: () => import("shiki/langs/zig.mjs"),
} satisfies Record<string, Grammar>;

type GrammarName = keyof typeof GRAMMARS;

/** What a fence names (lower case) when it is not a grammar's own name: the aliases shiki's grammars declare, and common ones. */
const ALIASES: Record<string, GrammarName> = {
	"c#": "csharp",
	"c++": "cpp",
	"f#": "fsharp",
	adoc: "asciidoc",
	bash: "shellscript",
	batch: "bat",
	cjs: "javascript",
	clj: "clojure",
	cmd: "bat",
	console: "shellsession",
	coffeescript: "coffee",
	cs: "csharp",
	cts: "typescript",
	dockerfile: "docker",
	elisp: "emacs-lisp",
	erl: "erlang",
	f03: "fortran-free-form",
	f08: "fortran-free-form",
	f18: "fortran-free-form",
	f90: "fortran-free-form",
	f95: "fortran-free-form",
	fs: "fsharp",
	gd: "gdscript",
	golang: "go",
	gql: "graphql",
	hbs: "handlebars",
	hs: "haskell",
	jade: "pug",
	js: "javascript",
	justfile: "just",
	kt: "kotlin",
	kts: "kotlin",
	lean4: "lean",
	makefile: "make",
	md: "markdown",
	mjs: "javascript",
	mmd: "mermaid",
	mts: "typescript",
	nu: "nushell",
	objc: "objective-c",
	properties: "ini",
	protobuf: "proto",
	ps: "powershell",
	ps1: "powershell",
	pwsh: "powershell",
	py: "python",
	rb: "ruby",
	rs: "rust",
	sh: "shellscript",
	shell: "shellscript",
	styl: "stylus",
	tf: "terraform",
	tfvars: "terraform",
	ts: "typescript",
	tsp: "typespec",
	typ: "typst",
	vim: "viml",
	vimscript: "viml",
	yml: "yaml",
	zsh: "shellscript",
};

/** The grammar a fence's language names, or null when it names none (plain text, or a language that is not bundled). */
export function grammarFor(lang: string): GrammarName | null {
	const key = lang.trim().toLowerCase();
	if (Object.hasOwn(GRAMMARS, key)) return key as GrammarName;
	if (Object.hasOwn(ALIASES, key)) return ALIASES[key];
	return null;
}

let instance: Promise<HighlighterCore> | null = null;

function highlighter(): Promise<HighlighterCore> {
	// `forgiving`: a pattern the JavaScript engine cannot express is skipped, not an error that loses the whole block.
	instance ??= createHighlighterCore({
		engine: createJavaScriptRegexEngine({ forgiving: true }),
		themes: [THEME],
		langs: [],
	});
	return instance;
}

/** Grammars being loaded or loaded: whether each is usable. A grammar that failed to load stays unusable until the page reloads. */
const loaded = new Map<GrammarName, Promise<boolean>>();

function load(h: HighlighterCore, name: GrammarName): Promise<boolean> {
	let ready = loaded.get(name);
	if (!ready) {
		ready = h.loadLanguage(GRAMMARS[name]()).then(
			() => true,
			() => false,
		);
		loaded.set(name, ready);
	}
	return ready;
}

/**
 * Lines this long or longer are not tokenised: they come out as plain text, and the lines around them are coloured as
 * usual. It replaces shiki's own cutoff, a wall-clock budget of 500 ms per line, which made how a block came out depend
 * on the machine: the first line of a language pays for compiling its grammar (about 400 ms for TypeScript on a fast
 * laptop), so on a busy machine or a phone the first block was cut after its first word, and `highlight.ts` keeps what
 * it is given. A length limit is the same on every machine. It is what the budget was for: tokenising a long string
 * literal takes time quadratic in its length (2,000 characters about 0.4 s, 5,000 about 2.3 s), and it falls on the one
 * worker that colours every block of the page.
 */
export const MAX_LINE_CHARS = 2000;

/** `code` as themed HTML (a `<pre class="shiki …">`); text of a language that is not bundled, or that failed to load, is uncoloured. */
export async function highlightToHtml(code: string, lang: string): Promise<string> {
	const h = await highlighter();
	const name = grammarFor(lang);
	const use = name && (await load(h, name)) ? name : "text";
	return h.codeToHtml(code, {
		lang: use,
		theme: THEME_NAME,
		// No wall-clock budget (0): `MAX_LINE_CHARS` bounds the work instead.
		tokenizeTimeLimit: 0,
		tokenizeMaxLineLength: MAX_LINE_CHARS,
	});
}
