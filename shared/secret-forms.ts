/**
 * The forms a secret takes in text that is not a settings file: a prose file (AGENTS.md), a note a person types, a bug
 * report. Three places look for them and used to keep a list each (`server/migrate/secrets.ts` for an export made without
 * credentials, `web/src/lib/feedback.ts` for a public issue, `shared/memory.ts` for the Memory page's warning), and the
 * lists drifted: a database URL with a password, a `--password` argument or an `aws_secret_access_key =` line was caught by
 * one and kept by another (#338). This is the part every one of them shares; each may look for more besides.
 *
 * It looks only for what is unmistakably a credential, since what it finds is blanked from a file a person wrote: a token
 * of a known shape, a private key, a `Bearer` value, the password of `scheme://user:password@host`, the value of a flag
 * that names a secret (`--password x`), and a `password = x`, `pwd=x`, `…_secret_access_key = x` assignment.
 */

/** Token formats with a recognisable shape, wherever they appear. */
export const TOKEN_SHAPES: readonly RegExp[] = [
	/\bsk-[A-Za-z0-9_-]{16,}/g,
	/\b[rsp]k_(?:live|test)_[A-Za-z0-9]{8,}/g,
	/\bgh[pousr]_[A-Za-z0-9]{20,}/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}/g,
	/\bglpat-[A-Za-z0-9_-]{16,}/g,
	/\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
	/\b(?:AKIA|ASIA|AIDA|AROA|AGPA|ANPA|ANVA|AIPA)[0-9A-Z]{16}\b/g,
	/\bAIza[0-9A-Za-z_-]{30,}/g,
	/\bnpm_[A-Za-z0-9]{30,}/g,
	/\bhf_[A-Za-z0-9]{20,}/g,
	/\bya29\.[A-Za-z0-9_-]{20,}/g,
	/(?<![\w/.:-])1\/\/[A-Za-z0-9_-]{30,}/g,
	/\beyJ[\w-]{8,}\.[\w-]{8,}(?:\.[\w-]*)?/g,
];

/** A PEM / PGP private key, to its END line; a block pasted without one goes to the end of the text. */
export const PRIVATE_KEY_BLOCK =
	/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g;

/** `Bearer <token>`: the token. */
const BEARER = /(\bBearer\s+)([A-Za-z0-9._~+/=-]{12,})/gi;

/** `scheme://user:password@host`: the password. The scheme is bounded: an unbounded one is quadratic on a long run of `a.a.`. */
const URL_PASSWORD = /((?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,31}:\/\/[^/:@?#\s]+:)([^/?#@\s]+)(?=@)/gi;

// `pass` and `pwd` are a password as the last word of a longer name (`DB_PASS`, `MYSQL_PWD`), not in `bypass`; a bare `pwd=` is one too,
// unless its value is a folder (`PWD` is the shell's).
const PASSWORD_NAME = "(?:[\\w.-]*(?:password|passwd|passphrase)|[\\w.-]*[_.-](?:pwd|pass)|pwd)";
const OTHER_NAME =
	"[\\w.-]*(?:secret|token|(?:api|access|private|signing|encryption)[_-]?key|secret[_-]?access[_-]?key)";

/** A flag that takes the secret as its next argument: `--password S3cr3t`, `--api-key abc…`. */
const FLAG_VALUE =
	/((?<![\w-])--[\w-]*(?:password|passwd|passphrase|pwd|secret|token|api-?key|access-?key|private-?key)s?[ \t]+)("[^"\n]*"|'[^'\n]*'|[^\s"']+)/gi;

/** `password = x`, `PGPASSWORD=x`, `pwd=x`, `aws_secret_access_key = x`, `"password": "x"`: a name that says it is secret, and its value. */
const ASSIGNMENT = new RegExp(
	`((?<![\\w.-])(?:${PASSWORD_NAME}|${OTHER_NAME})["']?[ \\t]*[:=][ \\t]*)("[^"\\n]*"|'[^'\\n]*'|[^\\s,;&"')}]+)`,
	"gi",
);
const PASSWORD_ONLY = new RegExp(`^${PASSWORD_NAME}$`, "i");

/** `the password is hunter2`: the next word, unless it is one that ordinary text puts there (`password is required`). */
const PASSWORD_IS =
	/(?<![\w.-])([\w.-]*(?:password|passwd|pwd|passphrase|passcode)s?\s+(?:is|was|are|were)\s+)(?!(?:not|no|required|empty|wrong|incorrect|invalid|correct|missing|blank|too|shown|hidden|visible|saved|stored|set|being|never|still|rejected|accepted)(?![\w-]))("[^"\n]*"|'[^'\n]*'|[^\s,;)"']+)/gi;

/** A value that is not a secret but a way to find one: a variable, a placeholder, a word that says there is none. */
function isPlaceholder(value: string): boolean {
	const v = value.trim();
	if (v === "" || /^[$<{[*%(]/.test(v) || /^x{3,}$/i.test(v)) return true;
	return /^(?:none|null|nil|true|false|yes|no|unset|empty|redacted|\[?redacted\]?|changeme|your[-_ ]?\w*|example|secret|password|token)$/i.test(
		v,
	);
}

const unquote = (value: string): string => value.replace(/^["']|["']$/g, "");

/** A flag's value is a secret when it looks like one: a word of prose (`--token to the tool`) is not. */
function looksLikeFlagSecret(value: string): boolean {
	const v = unquote(value);
	if (v.length < 6 || isPlaceholder(v) || v.startsWith("-")) return false;
	return /\d/.test(v) || v.length >= 12;
}

/** `text` with every secret form blanked (replaced by `mark`; none by default), and how many there were. */
export function blankSecretForms(text: string, mark = ""): { text: string; count: number } {
	let count = 0;
	const hit = (): string => {
		count++;
		return mark;
	};
	let out = text.replace(PRIVATE_KEY_BLOCK, hit);
	for (const shape of TOKEN_SHAPES) out = out.replace(shape, hit);
	out = out.replace(BEARER, (all, head: string, token: string) => (token === mark ? all : `${head}${hit()}`));
	out = out.replace(URL_PASSWORD, (all, head: string, password: string) =>
		password === mark ? all : `${head}${hit()}`,
	);
	out = out.replace(FLAG_VALUE, (all, head: string, value: string) =>
		looksLikeFlagSecret(value) ? `${head}${/^["']/.test(value) ? `${value[0]}${hit()}${value[0]}` : hit()}` : all,
	);
	out = out.replace(PASSWORD_IS, (all, head: string, value: string) =>
		unquote(value) === mark || isPlaceholder(unquote(value))
			? all
			: `${head}${/^["']/.test(value) ? `${value[0]}${hit()}${value[0]}` : hit()}`,
	);
	out = out.replace(ASSIGNMENT, (all, head: string, value: string) => {
		const bare = unquote(value);
		if (bare === mark || isPlaceholder(bare)) return all;
		const name = head.replace(/["']?[ \t]*[:=][ \t]*$/, "");
		// A password is a password at any length; a token or key of a few characters is a setting (`key: id`).
		if (!PASSWORD_ONLY.test(name) && bare.length < 8) return all;
		if (/pwd$/i.test(name) && /^[/~.]/.test(bare)) return all;
		return `${head}${/^["']/.test(value) ? `${value[0]}${hit()}${value[0]}` : hit()}`;
	});
	return { text: out, count };
}

/** Whether `text` holds a secret in one of these forms. */
export function holdsSecretForm(text: string): boolean {
	return blankSecretForms(text, "\u0000").count > 0;
}
