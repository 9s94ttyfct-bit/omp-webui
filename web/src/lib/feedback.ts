import { REPO_URL } from "@shared/repo.ts";

/**
 * The Feedback dialog's text: what leaves the machine is built here, and `sanitize` runs over all of it first.
 * GitHub's new-issue page takes the title, body and labels from the link, so nothing is sent anywhere by the app.
 */

export type FeedbackKind = "bug" | "feature";

export interface FeedbackField {
	key: string;
	/** The heading the field gets in the issue; issues are read in English whatever the interface language is. */
	heading: string;
	required: boolean;
}

/** The guided fields of each kind, in the order the issue lists them. */
export const FEEDBACK_FIELDS: Record<FeedbackKind, FeedbackField[]> = {
	bug: [
		{ key: "happened", heading: "What happened", required: true },
		{ key: "steps", heading: "Steps to reproduce", required: false },
		{ key: "expected", heading: "What I expected", required: false },
		{ key: "actual", heading: "What actually happened", required: false },
	],
	feature: [
		{ key: "problem", heading: "The problem this solves", required: true },
		{ key: "solution", heading: "What I would like", required: false },
	],
};

const TITLE_PREFIX: Record<FeedbackKind, string> = { bug: "Bug: ", feature: "Feature: " };
/** Labels GitHub gives every repository; the link ignores a label the repository does not have. */
const LABELS: Record<FeedbackKind, string> = { bug: "bug", feature: "enhancement" };
export const TITLE_MAX = 120;

/** A longer new-issue link is refused by GitHub (HTTP 414 above about 8 KB); this leaves room. */
export const URL_LIMIT = 7000;

const REDACTED = "[redacted]";
const SECRET_KEY =
	"(?:[\\w.-]*(?:token|secret|password|passwd|pwd|passphrase|passcode|api[_-]?key|access[_-]?key|account[_-]?key|private[_-]?key|shared[_-]?access[_-]?key|credential|signature|cookie|auth)s?|sig)";
/** `key = value`, `"key": "value"`, `?key=value`: the value of a setting whose name says it is secret. */
const SECRET_VALUE = new RegExp(
	`(?<![\\w.-])(${SECRET_KEY})(["']?\\s*[:=]\\s*)("[^"\\n]*"|'[^'\\n]*'|[^\\s,;&"'}]+)`,
	"gi",
);

const PASSWORD_WORD = "[\\w.-]*(?:password|passwd|pwd|passphrase|passcode)s?";
/**
 * `password: correct horse battery staple`: a password written in prose after `: ` can be several words, so the whole
 * unquoted run up to a comma, semicolon, bracket or the end of the line goes. (`pwd=x` and `"password": "x"` are
 * `SECRET_VALUE`'s.)
 */
const PASSWORD_PROSE = new RegExp(
	`(?<![\\w.-])(${PASSWORD_WORD}["']?\\s*:[ \\t]+)(?!["'])([^\\n,;&"')}]*[^\\s,;&"')}])`,
	"gi",
);
/** `the password is hunter2`: the next word, unless it is one that ordinary text puts there (`password is required`). */
const PASSWORD_IS = new RegExp(
	`(?<![\\w.-])(${PASSWORD_WORD}\\s+(?:is|was|are|were)\\s+)(?!(?:not|no|required|empty|wrong|incorrect|invalid|correct|missing|blank|too|shown|hidden|visible|saved|stored|set|being|never|still|rejected|accepted)(?![\\w-]))("[^"\\n]*"|'[^'\\n]*'|[^\\s,;)"']+)`,
	"gi",
);
/** A PEM / PGP private key, to its END line; a block pasted without one goes to the end of the text. */
const PRIVATE_KEY_BLOCK =
	/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g;
/** The path of a Slack incoming webhook is its credential. */
const SLACK_WEBHOOK = /(?<![\w.-])(hooks\.slack\.com\/(?:services|workflows|triggers|actions)\/)[A-Za-z0-9/_-]+/g;
/** `curl -u user:pw`, `--user user:pw`, `--proxy-user=user:pw`: only a value of the `user:password` form (`git push -u origin` stays). */
const CURL_LOGIN =
	/(?<![\w-])(-[uU]\s*|--(?:proxy-)?user(?:\s+|=))("[^"\n:]+:[^"\n]*"|'[^'\n:]+:[^'\n]*'|[^\s"':]+:[^\s"']*)/g;

/** Token formats with a recognisable shape, wherever they appear. */
const TOKEN_SHAPES: RegExp[] = [
	/\bsk-[A-Za-z0-9_-]{16,}/g,
	/\b[rsp]k_(?:live|test)_[A-Za-z0-9]{8,}/g,
	/\bgh[pousr]_[A-Za-z0-9]{20,}/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}/g,
	/\bglpat-[A-Za-z0-9_-]{16,}/g,
	/\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
	/\b(?:AKIA|ASIA|AIDA|AROA|AGPA|ANPA|ANVA|AIPA)[0-9A-Z]{16}\b/g,
	/\bAIza[0-9A-Za-z_-]{30,}/g,
	/\bnpm_[A-Za-z0-9]{30,}/g,
	/\bhf_[A-Za-z0-9]{30,}/g,
	/\bya29\.[A-Za-z0-9_-]{20,}/g,
	/(?<![\w/.:-])1\/\/[A-Za-z0-9_-]{30,}/g,
	/\beyJ[\w-]{8,}\.[\w-]{8,}(?:\.[\w-]*)?/g,
];

/** A path segment (a user name): up to the next separator or punctuation that ends a path in prose. */
const SEGMENT = String.raw`[^/\\\s"'\`:;,)\]}]+`;
/** The words of a name with spaces (`John Smith`), taken only when a path separator follows them directly. */
const MORE_WORDS = String.raw`(?:(?: [A-Z0-9][^/\\\s"'\`:;,)\]}]*){1,2}(?=[/\\]))?`;
const UNIX_HOME = new RegExp(`/(?:Users|home)/${SEGMENT}${MORE_WORDS}`, "g");
const WINDOWS_HOME = new RegExp(String.raw`\b[A-Za-z]:\\Users\\${SEGMENT}${MORE_WORDS}`, "g");
/** omp names a conversation's folder after the working directory, `--Users-me-work--`. */
const DASHED_HOME = /(?<=--)(?:Users|home)-[^-\s/\\]+/g;

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Names that identify no one. */
const COMMON_USERS: Record<string, true> = { root: true, user: true, users: true, admin: true, home: true };

/**
 * Take what must not leave the machine out of a text: API keys and tokens, `Bearer …` and `Authorization:`
 * credentials, cookies, the user name and password of a link, values of `token=` / `"apiKey":` / `--password x` style
 * settings, signed-link and connection-string keys, long opaque strings, e-mail addresses, this machine's user name,
 * and the home folder (`/Users/me/work` → `~/work`; `home` is this machine's own, other users' folders are recognised
 * by their shape, spaces in the name included). Running it twice changes nothing more.
 */
export function sanitize(text: string, home?: string, user?: string): string {
	let out = text.replace(PRIVATE_KEY_BLOCK, REDACTED);
	if (home && home.length > 1) {
		const bare = home.replace(/[\\/]+$/, "");
		out = out.split(bare).join("~");
		const dashed = bare.replace(/^[\\/]+/, "").replace(/[\\/:]/g, "-");
		if (dashed.includes("-")) {
			out = out.replace(new RegExp(`(?<![A-Za-z0-9])${literal(dashed)}(?![A-Za-z0-9])`, "g"), "~");
		}
	}
	out = out.replace(UNIX_HOME, "~").replace(WINDOWS_HOME, "~").replace(DASHED_HOME, "~");
	out = out.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`);
	// Whole lines: the scheme and the value of the header, and every cookie.
	out = out.replace(/(?<![\w.-])([\w.-]*authorization["']?\s*[:=]\s*["']?)[^\r\n"']+/gi, `$1${REDACTED}`);
	out = out.replace(/(?<![\w.-])((?:set-)?cookie\s*:\s*)[^\r\n]+/gi, `$1${REDACTED}`);
	// `scheme://user:password@host`: the whole userinfo, a token used as the user name included.
	out = out.replace(/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s/@"'<>?#]+@/gi, `$1${REDACTED}@`);
	out = out.replace(
		/(?<![\w-])(--[\w-]*(?:token|secret|password|passwd|pwd|passphrase|passcode|api-?key|access-?key|private-?key|credential|cookie)s?\s+)(?!-)("[^"\n]*"|'[^'\n]*'|\S+)/gi,
		`$1${REDACTED}`,
	);
	out = out.replace(CURL_LOGIN, `$1${REDACTED}`).replace(SLACK_WEBHOOK, `$1${REDACTED}`);
	for (const shape of TOKEN_SHAPES) out = out.replace(shape, REDACTED);
	out = out.replace(PASSWORD_PROSE, `$1${REDACTED}`).replace(PASSWORD_IS, `$1${REDACTED}`);
	out = out.replace(SECRET_VALUE, (_all, key: string, sep: string, value: string) =>
		value.startsWith(REDACTED) ? _all : `${key}${sep}${REDACTED}`,
	);
	out = out.replace(
		/(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
		"[email]",
	);
	// An AWS secret access key: 40 base64 characters, mixed, with a `/` or `+` in them.
	out = out.replace(
		/(?<![A-Za-z0-9/+=_.-])(?=[A-Za-z0-9/+]*[A-Z])(?=[A-Za-z0-9/+]*[a-z])(?=[A-Za-z0-9/+]*\d)(?=[A-Za-z0-9/+]*[/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=_.-])/g,
		REDACTED,
	);
	// A long run of letters and digits that is not an ordinary word, path or git hash is most likely a credential.
	out = out.replace(
		/(?<![\w/.-])(?![0-9a-f]{40}(?![\w-]))(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}(?![\w/.-])/g,
		REDACTED,
	);
	// The OS user name wherever it still shows: a shell prompt (`me@host`), a log line, a path that is not the home folder.
	if (user && user.length >= 3 && !COMMON_USERS[user.toLowerCase()]) {
		out = out.replace(new RegExp(`(?<![A-Za-z0-9])${literal(user)}(?![A-Za-z0-9])`, "gi"), "[user]");
	}
	return out;
}

export interface DiagnosticsInput {
	webui: string;
	omp: string;
	/** From the server: `macOS 15.1 (arm64)`. Absent when the server could not say. */
	os?: string;
	mode?: string;
	browser: string;
	language: string;
}

/** The environment lines an issue gets when the user agrees to attach them. */
export function diagnosticsText(d: DiagnosticsInput): string {
	return [
		`web UI: ${d.webui}`,
		`omp: ${d.omp}`,
		...(d.os ? [`OS: ${d.os}`] : []),
		...(d.mode ? [`Mode: ${d.mode}`] : []),
		`Browser: ${d.browser}`,
		`Interface language: ${d.language}`,
	].join("\n");
}

export interface FeedbackDraft {
	kind: FeedbackKind;
	summary: string;
	/** Field values by `FEEDBACK_FIELDS` key. */
	fields: Record<string, string>;
}

/** The first of the draft's required fields (the summary included) that is still empty, else null. */
export function missingField(draft: FeedbackDraft): "summary" | string | null {
	if (!draft.summary.trim()) return "summary";
	for (const f of FEEDBACK_FIELDS[draft.kind]) {
		if (f.required && !draft.fields[f.key]?.trim()) return f.key;
	}
	return null;
}

export interface Issue {
	title: string;
	labels: string[];
	/** The text before the diagnostics block (the guided fields). */
	text: string;
	diagnostics: string | null;
}

/** The longest summary the title can hold after its `Bug: ` / `Feature: ` prefix. */
export const summaryMax = (kind: FeedbackKind): number => TITLE_MAX - TITLE_PREFIX[kind].length;

/** The sanitized issue for a draft. `home` is this machine's home folder, so it reads `~`; `user` is its user name. */
export function buildIssue(draft: FeedbackDraft, diagnostics: string | null, home?: string, user?: string): Issue {
	const clean = (s: string) => sanitize(s, home, user).trim();
	const title = cut(`${TITLE_PREFIX[draft.kind]}${clean(draft.summary).replace(/\s+/g, " ")}`, TITLE_MAX).trimEnd();
	const text = FEEDBACK_FIELDS[draft.kind]
		.map((f) => ({ heading: f.heading, value: clean(draft.fields[f.key] ?? "") }))
		.filter((f) => f.value)
		.map((f) => `### ${f.heading}\n\n${f.value}`)
		.join("\n\n");
	return {
		title,
		labels: [LABELS[draft.kind]],
		text,
		diagnostics: diagnostics ? sanitize(diagnostics, home, user).trim() : null,
	};
}

const DIAGNOSTICS_NOTE = "_Diagnostics were left out or cut: the link would have been too long._";
const TEXT_NOTE =
	"_…cut: the text was too long for a link. The full text was copied to your clipboard: paste it here to replace this cut one._";

function diagnosticsBlock(diagnostics: string): string {
	return `### Diagnostics\n\n\`\`\`\n${diagnostics}\n\`\`\``;
}

/** Everything the report says, uncut: the title, the text and the diagnostics. What Copy puts on the clipboard. */
export function fullText(issue: Issue): string {
	return [issue.title, issue.text, issue.diagnostics ? diagnosticsBlock(issue.diagnostics) : null]
		.filter((p) => p)
		.join("\n\n");
}

function link(issue: Pick<Issue, "title" | "labels">, body: string): string {
	const params = new URLSearchParams({ title: issue.title, body, labels: issue.labels.join(",") });
	return `${REPO_URL}/issues/new?${params}`;
}

/** The longest prefix of `text` (by UTF-16 units, never splitting a surrogate pair) for which `fits` holds. */
function longestFit(text: string, fits: (prefix: string) => boolean): string {
	let lo = 0;
	let hi = text.length;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (fits(cut(text, mid))) lo = mid;
		else hi = mid - 1;
	}
	return cut(text, lo);
}

function cut(text: string, end: number): string {
	const last = text.charCodeAt(end - 1);
	return text.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end);
}

export interface IssueLink {
	url: string;
	/** The body as it will arrive on GitHub. */
	body: string;
	/** What had to give way to keep the link under the limit: the diagnostics first, then the text itself. */
	truncated: "diagnostics" | "text" | null;
}

/** The new-issue link for `issue`, shortened to fit `limit` characters: diagnostics are cut first, the text last. */
export function issueLink(issue: Issue, limit = URL_LIMIT): IssueLink {
	const join = (...parts: (string | null)[]) => parts.filter((p) => p).join("\n\n");
	const full = join(issue.text, issue.diagnostics ? diagnosticsBlock(issue.diagnostics) : null);
	if (link(issue, full).length <= limit) return { url: link(issue, full), body: full, truncated: null };
	const withNote = (diagnostics: string) =>
		join(issue.text, diagnostics ? diagnosticsBlock(diagnostics) : null, DIAGNOSTICS_NOTE);
	if (link(issue, withNote("")).length <= limit) {
		const kept = longestFit(issue.diagnostics ?? "", (d) => link(issue, withNote(d)).length <= limit);
		const body = withNote(kept.trim());
		return { url: link(issue, body), body, truncated: "diagnostics" };
	}
	const kept = longestFit(issue.text, (t) => link(issue, join(t, TEXT_NOTE)).length <= limit);
	const body = join(kept.trimEnd(), TEXT_NOTE);
	return { url: link(issue, body), body, truncated: "text" };
}
