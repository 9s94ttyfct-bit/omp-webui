/**
 * The operating system is asked through one place, `server/platform/` (the adapter: darwin, linux, win32), so that a
 * system is supported by writing its module rather than by finding every `ps` and `/tmp` in the tree. This fails the
 * lint (`bun run lint`) where code outside the adapter asks the system itself:
 *
 * - `process.platform` (and `platform` from `node:os`): ask `platform`, or a capability (`platform.capabilities`);
 * - `process.getuid` and its kin: `platform.proc.uid()`;
 * - `process.kill` (or a child's `kill`) with a signal Windows has not (anything but SIGINT, SIGTERM, SIGKILL), or with a
 *   negative pid (a process group): `platform.proc`;
 * - a macOS or POSIX command run by name (`ps`, `kill`, `pgrep`, `lsof`, `open`, `osascript`, `security`, `sips`,
 *   `defaults`, `launchctl`, `pbcopy`, `caffeinate`, `sw_vers`, `df`) as the head of an argument list or a spawn's first
 *   argument, and a shell asked to run a string (`sh -c`, `bash -c`);
 * - a program by its POSIX path (`/bin/…`, `/usr/bin/…`, `/usr/sbin/…`, `/sbin/…`);
 * - a hardcoded `/tmp`: `os.tmpdir()`, or `platform.socketTemp` for a socket.
 *
 * Where one of these is right (a name the risk classifier compares paths with, a fixture's recorded path), the line says
 * why with an allow comment, on the line itself or alone on the line above it, and the reason is required:
 *
 *     // platform-allow: the risk classifier's POSIX temp folders, compared with; no file is used
 *
 * An allow comment that allows nothing is an error too, so that one never outlives what it was for. Whole files that are
 * about one system by nature are on `ALLOWLIST`, each with its reason.
 *
 * The source is read with TypeScript's own scanner (comments, strings, template literals and regular expressions are
 * told apart as the compiler tells them), and the rules match its tokens. Scope: server/, shared/, scripts/ and
 * tests/support/. Run it: `bun scripts/check-platform.ts`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { SyntaxKind } from "typescript/unstable/ast";
import { computeLineStarts, createScanner } from "typescript/unstable/ast/scanner";

const ROOT = join(import.meta.dirname, "..");

/** The folders the check reads. */
export const SCOPE = ["server", "shared", "scripts", "tests/support"];

/**
 * Files and folders (a trailing `/`) that are about one system by nature: what they do with it is the point of them. A
 * path is relative to the checkout.
 */
export const ALLOWLIST: Record<string, string> = {
	"server/platform/": "the adapter itself: the one place the system is asked",
	"server/update/": "the in-app updater, macOS-only (capabilities.appUpdate): disk images, codesign, the bundle swap",
	"scripts/check-platform.ts": "this check: it lists the names it looks for",
	"scripts/dmg.ts": "builds the macOS disk image",
	"scripts/signing-identity.ts": "the macOS signing identity (security, codesign)",
	"scripts/app-shots.ts": "screenshots of the macOS app's windows",
	"scripts/mac-tests.ts": "runs the tests only macOS runs, and refuses elsewhere",
	"scripts/update-smoke.ts": "the in-app updater's smoke test, macOS-only",
	"scripts/upgrade-pause-check.ts": "an upgrade of the macOS app with paused conversations, macOS-only",
	"scripts/bench.ts": "the release's benchmark on its Mac (caffeinate, sw_vers, process listings)",
	"scripts/bench-gate.ts": "the benchmark's budgets, by the system the run was on",
	"scripts/soak.ts": "the soak run on a Mac (caffeinate, pmset, process signals)",
	"scripts/long-run.ts": "the long run on a Mac: pauses omp with SIGSTOP/SIGCONT to test the pause",
	"scripts/freeze/": "the freeze harness, run on a Mac (process signals, a fixed scratch folder)",
	"scripts/lib/release-preflight.ts": "what the release needs of its Mac (Finder automation, the keychain)",
	"scripts/open-big.ts": "a measurement against checkouts on a Mac (#590): its process listings and sysctl",
	"tests/support/update-fixtures.ts":
		"the in-app updater's test fixtures, macOS-only (disk images, xattr, the keychain)",
	"tests/support/update-world.ts": "the in-app updater's test world, macOS-only (ditto, the bundle swap)",
};

/** What a rule found: `file:line` and what to do instead. */
export interface Problem {
	at: string;
	what: string;
}

/** Commands of macOS or of POSIX systems that a Windows server would not find, by the name they are run as. */
const COMMANDS: Record<string, true> = {
	ps: true,
	kill: true,
	pgrep: true,
	pkill: true,
	killall: true,
	lsof: true,
	open: true,
	osascript: true,
	security: true,
	sips: true,
	defaults: true,
	launchctl: true,
	pbcopy: true,
	pbpaste: true,
	caffeinate: true,
	sw_vers: true,
	df: true,
	sysctl: true,
	codesign: true,
	hdiutil: true,
	ditto: true,
	xattr: true,
	pmset: true,
};
/** Shells, asked to run a string with `-c` (or `-lc`, `-ilc`). */
const SHELLS: Record<string, true> = { sh: true, bash: true, zsh: true };
/** Functions whose first argument is the program to run (or its argument list). */
const SPAWNERS: Record<string, true> = {
	spawn: true,
	spawnSync: true,
	exec: true,
	execSync: true,
	execFile: true,
	execFileSync: true,
	which: true,
};
/** The signals Node can send on Windows (where the process is ended outright); every other is POSIX's alone. */
const PORTABLE_SIGNALS: Record<string, true> = { SIGINT: true, SIGTERM: true, SIGKILL: true };
/** The paths of POSIX programs. */
const POSIX_BIN = /^\/(?:usr\/)?s?bin\//;
/** The allow comment, and its reason. */
const ALLOW = /\bplatform-allow\b:?\s*(.*)$/;

interface Token {
	kind: SyntaxKind;
	/** A literal's value (a string's text, unquoted); the text of anything else. */
	value: string;
	line: number;
}

/** Tokens after which a `/` divides: anything else makes it the start of a regular expression. */
const ENDS_OPERAND = new Set([
	SyntaxKind.Identifier,
	SyntaxKind.NumericLiteral,
	SyntaxKind.BigIntLiteral,
	SyntaxKind.StringLiteral,
	SyntaxKind.NoSubstitutionTemplateLiteral,
	SyntaxKind.TemplateTail,
	SyntaxKind.RegularExpressionLiteral,
	SyntaxKind.CloseParenToken,
	SyntaxKind.CloseBracketToken,
	SyntaxKind.CloseBraceToken,
	SyntaxKind.ThisKeyword,
	SyntaxKind.SuperKeyword,
	SyntaxKind.TrueKeyword,
	SyntaxKind.FalseKeyword,
	SyntaxKind.NullKeyword,
	SyntaxKind.PlusPlusToken,
	SyntaxKind.MinusMinusToken,
]);

const TRIVIA = new Set([SyntaxKind.WhitespaceTrivia, SyntaxKind.NewLineTrivia, SyntaxKind.ConflictMarkerTrivia]);
const OPENERS = new Set([
	SyntaxKind.OpenParenToken,
	SyntaxKind.OpenBracketToken,
	SyntaxKind.OpenBraceToken,
	SyntaxKind.TemplateHead,
]);
const CLOSERS = new Set([
	SyntaxKind.CloseParenToken,
	SyntaxKind.CloseBracketToken,
	SyntaxKind.CloseBraceToken,
	SyntaxKind.TemplateTail,
]);

/** The line (1-based) of `pos`. */
function lineAt(starts: readonly number[], pos: number): number {
	let lo = 0;
	let hi = starts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (starts[mid] <= pos) lo = mid;
		else hi = mid - 1;
	}
	return lo + 1;
}

/** The code's tokens, and its comments by line. Template literals and regular expressions are scanned as the parser would. */
function scan(src: string): { tokens: Token[]; comments: { line: number; text: string; alone: boolean }[] } {
	const scanner = createScanner(false);
	scanner.setText(src);
	const starts = computeLineStarts(src);
	const tokens: Token[] = [];
	const comments: { line: number; text: string; alone: boolean }[] = [];
	/** The brace depth at each template substitution that is open. */
	const templates: number[] = [];
	let depth = 0;
	let lastLine = 0;
	for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
		if (TRIVIA.has(kind)) continue;
		const line = lineAt(starts, scanner.getTokenStart());
		if (kind === SyntaxKind.SingleLineCommentTrivia || kind === SyntaxKind.MultiLineCommentTrivia) {
			comments.push({ line, text: scanner.getTokenText(), alone: line !== lastLine });
			continue;
		}
		if (kind === SyntaxKind.CloseBraceToken && templates.at(-1) === depth) {
			kind = scanner.reScanTemplateToken(false);
			if (kind === SyntaxKind.TemplateTail) templates.pop();
		} else if (kind === SyntaxKind.OpenBraceToken) depth++;
		else if (kind === SyntaxKind.CloseBraceToken) depth--;
		else if (kind === SyntaxKind.TemplateHead) templates.push(depth);
		else if (
			(kind === SyntaxKind.SlashToken || kind === SyntaxKind.SlashEqualsToken) &&
			!ENDS_OPERAND.has(tokens.at(-1)?.kind as SyntaxKind)
		)
			kind = scanner.reScanSlashToken();
		const literal =
			kind === SyntaxKind.StringLiteral ||
			kind === SyntaxKind.NoSubstitutionTemplateLiteral ||
			kind === SyntaxKind.TemplateHead ||
			kind === SyntaxKind.TemplateMiddle ||
			kind === SyntaxKind.TemplateTail;
		tokens.push({ kind, value: literal ? scanner.getTokenValue() : scanner.getTokenText(), line });
		lastLine = lineAt(starts, scanner.getTokenEnd());
	}
	return { tokens, comments };
}

/** Whether `t` is a string (a template literal without substitutions is one). */
function isString(t: Token | undefined): boolean {
	return t?.kind === SyntaxKind.StringLiteral || t?.kind === SyntaxKind.NoSubstitutionTemplateLiteral;
}

/** The tokens of each item of the list (a call's arguments, an array's elements) whose `(` or `[` is at `open`. */
function itemsAt(tokens: readonly Token[], open: number): Token[][] {
	const items: Token[][] = [[]];
	let depth = 0;
	for (let i = open + 1; i < tokens.length; i++) {
		const t = tokens[i];
		if (CLOSERS.has(t.kind)) {
			if (depth === 0) break;
			depth--;
		} else if (OPENERS.has(t.kind)) depth++;
		else if (t.kind === SyntaxKind.CommaToken && depth === 0) {
			items.push([]);
			continue;
		}
		items.at(-1)?.push(t);
	}
	return items.filter((item) => item.length > 0);
}

/** Whether the call whose `(` is at `open` runs a program named by its first argument (`spawn(…)`, `Bun.spawnSync(…)`). */
function spawnCall(tokens: readonly Token[], open: number): boolean {
	return tokens[open]?.kind === SyntaxKind.OpenParenToken && SPAWNERS[tokens[open - 1]?.value ?? ""] === true;
}

/** Whether `tokens[i]` is `.name` after `process`. */
function processMember(tokens: readonly Token[], i: number): string | null {
	const t = tokens[i];
	if (t.kind !== SyntaxKind.Identifier || t.value !== "process") return null;
	if (tokens[i + 1]?.kind !== SyntaxKind.DotToken) return null;
	const name = tokens[i + 2];
	return name?.kind === SyntaxKind.Identifier ? name.value : null;
}

/** What the rules find in one file's tokens, before allow comments are applied. */
function findings(tokens: readonly Token[]): { line: number; what: string }[] {
	const out: { line: number; what: string }[] = [];
	const say = (t: Token, what: string) => out.push({ line: t.line, what });
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		const member = processMember(tokens, i);
		if (member === "platform")
			say(t, "process.platform: ask `platform` (server/platform) or a capability (`platform.capabilities`)");
		if (member && /^get(e?uid|e?gid|groups)$/.test(member))
			say(t, `process.${member}: ask the adapter (\`platform.proc.uid()\`)`);
		// A signal: `process.kill(pid, sig)`, or a child's `kill(sig)`.
		if (t.kind === SyntaxKind.Identifier && t.value === "kill" && tokens[i - 1]?.kind === SyntaxKind.DotToken) {
			if (tokens[i + 1]?.kind !== SyntaxKind.OpenParenToken) continue;
			const args = itemsAt(tokens, i + 1);
			const onProcess = tokens[i - 2]?.kind === SyntaxKind.Identifier && tokens[i - 2]?.value === "process";
			const signal = onProcess ? args[1] : args[0];
			const sig = signal?.length === 1 && isString(signal[0]) ? signal[0].value : null;
			if (sig && !PORTABLE_SIGNALS[sig])
				say(t, `${sig} is POSIX's alone (Windows has SIGINT, SIGTERM and SIGKILL): signal through \`platform.proc\``);
			if (onProcess && args[0]?.[0]?.kind === SyntaxKind.MinusToken)
				say(t, "a negative pid signals a process group, which Windows has not: `platform.proc.signalGroup`");
		}
		// `platform` from node:os.
		if (t.kind === SyntaxKind.ImportKeyword) {
			let j = i + 1;
			const names: Token[] = [];
			while (
				j < tokens.length &&
				tokens[j].kind !== SyntaxKind.FromKeyword &&
				tokens[j].kind !== SyntaxKind.SemicolonToken
			) {
				names.push(tokens[j]);
				j++;
			}
			const from = tokens[j + 1];
			if (
				tokens[j]?.kind === SyntaxKind.FromKeyword &&
				isString(from) &&
				(from?.value === "os" || from?.value === "node:os")
			) {
				const index = names.findIndex((n) => n.kind === SyntaxKind.Identifier && n.value === "platform");
				if (index >= 0 && names[index - 1]?.kind !== SyntaxKind.AsKeyword)
					say(names[index], "platform() from node:os: ask `platform` (server/platform) or a capability");
			}
		}
		if (!isString(t) && t.kind !== SyntaxKind.TemplateHead) continue;
		const value = t.value;
		if (value === "/tmp" || value.startsWith("/tmp/"))
			say(t, "a hardcoded /tmp: `os.tmpdir()`, or `platform.socketTemp` for a socket");
		if (POSIX_BIN.test(value)) say(t, `${value.split(/\s/)[0]} is a POSIX path: ask the adapter for what it runs`);
		// A command run by name: a spawn's first argument, the head of an argument list (one that is not a list of plain
		// words, `["open", "closed"]`), or the start of a `$` template.
		const before = tokens[i - 1];
		let head = false;
		if (before?.kind === SyntaxKind.OpenParenToken) head = spawnCall(tokens, i - 1);
		else if (before?.kind === SyntaxKind.OpenBracketToken)
			head =
				spawnCall(tokens, i - 2) ||
				!itemsAt(tokens, i - 1).every(
					(item) => item.length === 1 && isString(item[0]) && /^[A-Za-z]+$/.test(item[0].value),
				);
		else if (before?.kind === SyntaxKind.Identifier && before.value === "$") head = true;
		if (!head) continue;
		const word = before?.value === "$" ? value.trimStart().split(/\s/)[0] : value;
		if (COMMANDS[word]) say(t, `\`${word}\` is a macOS or POSIX command: ask the adapter (server/platform)`);
		const next = tokens[i + 2];
		if (
			SHELLS[word] &&
			tokens[i + 1]?.kind === SyntaxKind.CommaToken &&
			isString(next) &&
			/^-[a-z]*c$/.test(next.value)
		)
			say(t, `\`${word} ${next.value}\` runs a string in a POSIX shell: ask the adapter (\`platform.shell\`)`);
	}
	return out;
}

/** The problems of one file: what the rules find, less what an allow comment allows, plus allow comments that are wrong. */
export function checkSource(src: string, file: string): Problem[] {
	const { tokens, comments } = scan(src);
	const found = findings(tokens);
	const problems: Problem[] = [];
	/** The line each allow comment covers, and whether it was used. */
	const allows = new Map<number, { line: number; used: boolean }>();
	for (const c of comments) {
		const m = ALLOW.exec(c.text.replace(/\*\/\s*$/, ""));
		if (!m) continue;
		if (m[1].trim().length < 3) {
			problems.push({ at: `${file}:${c.line}`, what: "platform-allow needs a reason: `// platform-allow: <why>`" });
			continue;
		}
		// Alone on its line it covers the next line; after code, its own.
		allows.set(c.alone ? c.line + 1 : c.line, { line: c.line, used: false });
	}
	for (const f of found) {
		const allow = allows.get(f.line);
		if (allow) allow.used = true;
		else problems.push({ at: `${file}:${f.line}`, what: f.what });
	}
	for (const allow of allows.values())
		if (!allow.used)
			problems.push({ at: `${file}:${allow.line}`, what: "this platform-allow allows nothing: remove it" });
	return problems;
}

/** The allowlist entry that covers `file` (relative to the checkout), if one does. */
function allowlistEntry(file: string): string | undefined {
	return Object.keys(ALLOWLIST).find((entry) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry));
}

/**
 * The problems of `files` (relative to the checkout; `read` gives each one's text): every file's own, but those of a
 * file on the allowlist, and an allowlist entry that covers nothing the rules find (it is to be taken off).
 */
export function checkTree(files: readonly string[], read: (file: string) => string): Problem[] {
	const problems: Problem[] = [];
	const used = new Set<string>();
	for (const file of files) {
		const entry = allowlistEntry(file);
		const found = checkSource(read(file), file);
		if (entry === undefined) problems.push(...found);
		else if (found.length > 0) used.add(entry);
	}
	for (const entry of Object.keys(ALLOWLIST))
		if (!used.has(entry))
			problems.push({
				at: entry,
				what: "on the allowlist (scripts/check-platform.ts) but asks the system nowhere: take it off",
			});
	return problems;
}

/** The TypeScript files of the scope, relative to the checkout. */
export function scopeFiles(root = ROOT): string[] {
	const files: string[] = [];
	for (const dir of SCOPE) {
		for (const name of readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })) {
			if (!/\.(m?ts|tsx)$/.test(name) || name.includes("node_modules")) continue;
			files.push(
				relative(root, join(root, dir, name))
					.split("\\")
					.join("/"),
			);
		}
	}
	return files.sort();
}

if (import.meta.main) {
	const problems = checkTree(scopeFiles(), (file) => readFileSync(join(ROOT, file), "utf8"));
	if (problems.length > 0) {
		for (const p of problems) console.error(`${p.at}: ${p.what}`);
		console.error(
			`\n${problems.length} place(s) ask the operating system outside server/platform/. Ask the adapter, or say why on the line: // platform-allow: <why>`,
		);
		process.exit(1);
	}
}
