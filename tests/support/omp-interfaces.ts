import { readFileSync } from "node:fs";

/**
 * What the server and the page ask of omp, read out of their source: the RPC commands sent to a process, the slash
 * commands run in one, the argument lists of omp's CLI, and the flags named. The compatibility table of docs/TECHNICAL.md
 * has to list each (tests/unit/compat-table.test.ts), so that an interface added in code is added there too.
 *
 * No compiler API is used (TypeScript 7 has none): a call is found by its name and its arguments are cut out with a
 * scanner that steps over strings, templates and comments. That is enough for how this code calls omp, and a call it
 * cannot read is reported (`unreadable`) rather than skipped.
 */

export interface Found {
	value: string;
	/** `file:line`, for the failure message. */
	at: string;
}

const ROOT = new URL("../../", import.meta.url).pathname;
const DIRS = ["server", "shared", "web/src"];

/**
 * The server's, the shared and the page's source, but not the strings of the interface, and not the classifier of risky
 * calls (`shared/remote-risk.ts`): the flags and commands in it are those of the programs an agent runs (`rm`, `git`,
 * `tar`, `curl`…), which it looks for, not omp's.
 */
export function sourceFiles(): string[] {
	const found = DIRS.flatMap((dir) => [...new Bun.Glob(`${dir}/**/*.{ts,tsx}`).scanSync({ cwd: ROOT })]);
	return found.filter((f) => !f.startsWith("web/src/i18n/") && f !== "shared/remote-risk.ts").sort();
}

export const read = (file: string): string => readFileSync(`${ROOT}${file}`, "utf8");

// ------------------------------------------------------------------ scanning

/** Index just past the string or template literal that starts at `i`. */
function skipString(src: string, i: number): number {
	const quote = src[i];
	let j = i + 1;
	while (j < src.length && src[j] !== quote) {
		if (src[j] === "\\") j++;
		else if (quote === "`" && src[j] === "$" && src[j + 1] === "{") {
			j = closing(src, j + 1);
		}
		j++;
	}
	return j + 1;
}

/** Index just past a comment that starts at `i`, or `i` when none does. */
function skipComment(src: string, i: number): number {
	if (src[i] !== "/") return i;
	if (src[i + 1] === "/") {
		const end = src.indexOf("\n", i);
		return end < 0 ? src.length : end;
	}
	if (src[i + 1] === "*") {
		const end = src.indexOf("*/", i + 2);
		return end < 0 ? src.length : end + 2;
	}
	return i;
}

/** Index of the bracket that closes the one at `open`, stepping over strings and comments. */
export function closing(src: string, open: number): number {
	let depth = 0;
	for (let i = open; i < src.length; ) {
		const c = src[i];
		const afterComment = skipComment(src, i);
		if (afterComment !== i) i = afterComment;
		else if (c === '"' || c === "'" || c === "`") i = skipString(src, i);
		else {
			if (c === "(" || c === "[" || c === "{") depth++;
			else if (c === ")" || c === "]" || c === "}") {
				depth--;
				if (depth === 0) return i;
			}
			i++;
		}
	}
	return src.length;
}

/** `text` cut at its commas outside any bracket or string, trimmed, empty pieces dropped. */
export function splitTop(text: string): string[] {
	const parts: string[] = [];
	let from = 0;
	for (let i = 0; i < text.length; ) {
		const c = text[i];
		const afterComment = skipComment(text, i);
		if (afterComment !== i) i = afterComment;
		else if (c === '"' || c === "'" || c === "`") i = skipString(text, i);
		else if (c === "(" || c === "[" || c === "{") i = closing(text, i) + 1;
		else {
			if (c === ",") {
				parts.push(text.slice(from, i));
				from = i + 1;
			}
			i++;
		}
	}
	parts.push(text.slice(from));
	return parts.map(stripComments).filter(Boolean);
}

function stripComments(text: string): string {
	let out = "";
	for (let i = 0; i < text.length; ) {
		const c = text[i];
		const afterComment = skipComment(text, i);
		if (afterComment !== i) i = afterComment;
		else if (c === '"' || c === "'" || c === "`") {
			const end = skipString(text, i);
			out += text.slice(i, end);
			i = end;
		} else {
			out += c;
			i++;
		}
	}
	return out.trim();
}

const lineOf = (src: string, at: number): number => src.slice(0, at).split("\n").length;

/** A match that sits in a comment (a line that is one, or after a `//`) is not code. */
function inComment(src: string, at: number): boolean {
	const line = src.slice(src.lastIndexOf("\n", at - 1) + 1, at);
	return /^\s*(\/\/|\/?\*)/.test(line) || /(^|[^:])\/\//.test(line);
}

interface Call {
	name: string;
	args: string[];
	at: string;
}

/** Every call of a function or method called one of `names`, with its arguments as text. */
function calls(file: string, src: string, names: string[]): Call[] {
	const found: Call[] = [];
	const pattern = new RegExp(`(?<![\\w$])(${names.join("|")})\\s*(?:<[^()]*?>)?\\s*\\(`, "g");
	for (let m = pattern.exec(src); m; m = pattern.exec(src)) {
		if (inComment(src, m.index)) continue;
		const open = m.index + m[0].length - 1;
		found.push({
			name: m[1],
			args: splitTop(src.slice(open + 1, closing(src, open))),
			at: `${file}:${lineOf(src, m.index)}`,
		});
	}
	return found;
}

/** The `{…}` blocks of `text` that are not inside any other bracket (a conditional can have two). */
function topObjects(text: string): string[] {
	const found: string[] = [];
	for (let i = 0; i < text.length; ) {
		const c = text[i];
		if (c === '"' || c === "'" || c === "`") i = skipString(text, i);
		else if (c === "(" || c === "[") i = closing(text, i) + 1;
		else if (c === "{") {
			const end = closing(text, i);
			found.push(text.slice(i, end + 1));
			i = end + 1;
		} else i++;
	}
	return found;
}

/** The `key: value` properties of an object literal, and the names written as `{ key }`. */
function props(object: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const piece of splitTop(object.slice(1, -1))) {
		const m = /^([A-Za-z_$][\w$]*)\s*(?::\s*([\s\S]*))?$/.exec(piece);
		if (m) out.set(m[1], m[2] ?? "");
	}
	return out;
}

/** The value of a string (or template without a placeholder) literal, else null. */
function literal(text: string): string | null {
	const m = /^(["'`])((?:\\.|(?!\1)[^\\])*)\1$/s.exec(text.trim());
	return m && !(m[1] === "`" && m[2].includes("${")) ? m[2] : null;
}

/** The text of a string literal before its first placeholder, else null. */
function literalHead(text: string): string | null {
	const m = /^(["'`])((?:\\.|(?!\1)[^\\$])*)/s.exec(text.trim());
	return m ? m[2] : null;
}

// ------------------------------------------------------------------ RPC commands

/** What omp is sent: frames with a `type`, as `rpc`, `act`, `call`, `request` and `send` take them. */
const SENDERS = ["rpc", "act", "call", "request", "send"];

export interface RpcScan {
	types: Found[];
	slash: Found[];
	/** A command whose `type` is not a string literal: its value cannot be told from here. */
	unreadable: Found[];
}

/** The commands in the arguments of a sender: `{ type }` objects (also inside a `command` property) and their `message`. */
function commandsIn(arg: string, at: string, into: RpcScan): void {
	for (const object of topObjects(arg)) {
		const p = props(object);
		const type = p.get("type");
		if (type !== undefined) {
			const value = literal(type);
			if (value === null) into.unreadable.push({ value: type, at });
			else into.types.push({ value, at });
		}
		const message = p.get("message");
		if (message !== undefined) addSlash(literalHead(message), at, into);
		const nested = p.get("command");
		if (nested?.startsWith("{")) commandsIn(nested, at, into);
	}
}

/** `/todo import "<file>"` is the command `/todo import`: the words that are written out, up to the first that is not. */
function addSlash(text: string | null, at: string, into: RpcScan): void {
	if (!text?.startsWith("/")) return;
	const words: string[] = [];
	for (const w of text.split(/\s+/)) {
		if (!/^\/?[a-z][\w-]*$/.test(w) || (words.length > 0 && w.startsWith("/"))) break;
		words.push(w);
	}
	if (words.length) into.slash.push({ value: words.join(" "), at });
}

export function scanRpc(files: string[] = sourceFiles(), source: (file: string) => string = read): RpcScan {
	const out: RpcScan = { types: [], slash: [], unreadable: [] };
	for (const file of files) {
		const src = source(file);
		for (const call of calls(file, src, [...SENDERS, "command"])) {
			if (call.name === "command") {
				addSlash(literalHead(call.args[0] ?? ""), call.at, out);
				continue;
			}
			for (const arg of call.args) commandsIn(arg, call.at, out);
			// `send("/retry", …)`: the composer's send, which hands a slash command to omp.
			if (call.name === "send") addSlash(literalHead(call.args[0] ?? ""), call.at, out);
		}
	}
	return out;
}

// ------------------------------------------------------------------ omp's CLI

/** One argument list given to omp: the words written out in it, in order, `null` where it is not known. */
export interface Argv {
	/** Elements in order; an alternative (`a ? "x" : "y"`) is `"x|y"`, anything not written out is `null`. */
	elements: (string | null)[];
	at: string;
}

/** A binary: `bin`, `ompBin`, `cfg.ompBin`, `this.bin`. */
const BIN = /^(?:[\w$]+\.)*[\w$]*[bB]in$/;

/** An argument list: `[…]` read into words; the optional `...(cond ? [flags] : [])` and the `?:` of two words are kept. */
function elementsOf(array: string): (string | null)[] {
	const out: (string | null)[] = [];
	for (const piece of splitTop(array.slice(1, -1))) {
		const direct = literal(piece) ?? literalHead(piece);
		const whole = literal(piece);
		const either = /^[^?]+\?\s*(["'`][^"'`]*["'`])\s*:\s*(["'`][^"'`]*["'`])$/.exec(piece);
		const spread = /^\.\.\.\(?[^[]*\?\s*(\[[\s\S]*\])\s*:\s*\[\s*\]\)?$/.exec(piece);
		if (whole !== null) out.push(whole);
		else if (either) out.push(`${literal(either[1])}|${literal(either[2])}`);
		else if (spread) out.push(...elementsOf(spread[1]));
		// `--provider=${provider}`: the flag is written out, its value is not.
		else if (direct?.startsWith("-") && piece.startsWith("`")) out.push(direct.replace(/=$/, ""), null);
		else out.push(null);
	}
	return out;
}

/** Every argument list the server hands to omp's CLI, with a call that wraps one (`ompConfig`) accounted for. */
export function scanArgv(files: string[] = sourceFiles(), source: (file: string) => string = read): Argv[] {
	const out: Argv[] = [];
	for (const file of files) {
		const src = source(file);
		// `[bin, "usage", "--json"]`: an array whose first element is the binary.
		for (const m of src.matchAll(/\[\s*((?:[\w$]+\.)*[\w$]*[bB]in)\s*,/g)) {
			if (inComment(src, m.index) || !BIN.test(m[1])) continue;
			const array = src.slice(m.index, closing(src, m.index) + 1);
			out.push({ elements: elementsOf(array).slice(1), at: `${file}:${lineOf(src, m.index)}` });
		}
		// `runJson(bin, [...])`, `runHelp(bin, [...])`; `ompConfig(bin, cwd, [...])` runs `omp config ...`.
		for (const call of calls(file, src, ["runJson", "runHelp", "ompConfig"])) {
			const arg = call.args[call.name === "ompConfig" ? 2 : 1];
			if (arg === undefined) continue;
			const array = arg.startsWith("[") ? arg : arrayNamed(src, arg);
			if (!array) continue;
			const elements = elementsOf(array);
			out.push({ elements: call.name === "ompConfig" ? ["config", ...elements] : elements, at: call.at });
		}
	}
	return out;
}

/** The array literal a `const name = [...]` of this file holds. */
function arrayNamed(src: string, name: string): string | null {
	if (!/^[\w$]+$/.test(name)) return null;
	const m = new RegExp(`(?:const|let)\\s+${name}\\s*(?::[^=]+)?=\\s*\\[`).exec(src);
	if (!m) return null;
	const open = m.index + m[0].length - 1;
	return src.slice(open, closing(src, open) + 1);
}

/** The commands an argument list can name: its leading words, each alternative of `a|b` on its own. */
export function commandsOfArgv(argv: Argv): string[] {
	let paths = [""];
	for (const e of argv.elements) {
		if (e === null || e.startsWith("-")) break;
		paths = paths.flatMap((p) => e.split("|").map((w) => `${p} ${w}`.trim()));
	}
	return paths.filter(Boolean);
}

/** The flags an argument list names. */
export function flagsOfArgv(argv: Argv): string[] {
	return argv.elements.flatMap((e) => (e?.startsWith("--") ? [e.replace(/=.*/, "")] : []));
}

// ------------------------------------------------------------------ flags

/** `--flag` written as a string in the source (a CSS custom property is not one: those are found in the stylesheets). */
export function scanFlags(files: string[] = sourceFiles(), source: (file: string) => string = read): Found[] {
	const css = new Set<string>();
	for (const f of new Bun.Glob("web/src/**/*.css").scanSync({ cwd: ROOT }))
		for (const m of read(f).matchAll(/--[a-z][a-z0-9]*(?:-[a-z0-9]+)*/g)) css.add(m[0]);
	const out: Found[] = [];
	for (const file of files) {
		const src = source(file);
		for (const m of src.matchAll(/["'`](--[a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?=["'`=\s])/g)) {
			if (inComment(src, m.index) || css.has(m[1]) || /^--shiki/.test(m[1])) continue;
			out.push({ value: m[1], at: `${file}:${lineOf(src, m.index)}` });
		}
	}
	return out;
}

// ------------------------------------------------------------------ the technical documentation

/** The table rows (the lines that start with `|`) of the section of docs/TECHNICAL.md under `heading`: prose around it does not count. */
export function docsTable(heading: string): string {
	return docsSection(heading)
		.split("\n")
		.filter((line) => line.startsWith("|"))
		.join("\n");
}

/** The section of docs/TECHNICAL.md under `heading`, down to the next heading of its level. */
function docsSection(heading: string): string {
	const docs = readFileSync(`${ROOT}docs/TECHNICAL.md`, "utf8");
	const start = docs.indexOf(`\n## ${heading}\n`);
	if (start < 0) throw new Error(`docs/TECHNICAL.md has no section "${heading}"`);
	const next = docs.indexOf("\n## ", start + 1);
	return docs.slice(start, next < 0 ? undefined : next);
}

/**
 * The code spans of a section as the phrases they stand for: `\|` in a table cell is a choice between words
 * (`omp plugin enable\|disable`), so a span is every phrase its choices make.
 */
export function phrases(section: string): string[] {
	const out: string[] = [];
	for (const m of section.matchAll(/`([^`]+)`/g)) {
		let list = [""];
		for (const word of m[1].replace(/\\\|/g, "|").split(/\s+/)) {
			const options = word.split("|");
			list = list.flatMap((p) => options.map((o) => `${p} ${o}`.trim()));
			if (list.length > 256) throw new Error(`too many choices in \`${m[1]}\``);
		}
		out.push(...list);
	}
	return out;
}
