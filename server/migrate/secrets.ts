import { isRecord } from "../../shared/guards.ts";

/**
 * Secrets that live inside configuration files. omp keeps logins in `agent.db`, but `models.yml` may hold a provider's
 * `apiKey`, `mcp.json` an `Authorization` header or a token in `env`, and so on: written there as plain text by the user.
 * An archive without credentials must hold none of them, so the values are blanked in what goes into it (and, when
 * credentials are asked for, the original files travel in the encrypted part).
 *
 * This is a best effort, and says so wherever it is shown: a value is a secret when the key it is under ends in a word
 * that names one, when it is shaped like a well-known credential, or when it sits in a connection string or a command
 * line. A secret under a name that gives it away by no word is not found; the plan lists the files that had some, and
 * the person is asked to look at what the file holds.
 */

export type ConfigFormat = "json" | "yaml";
/** `text`: a file written for a person to read, where only what is unmistakably a credential is looked for. */
export type RedactFormat = ConfigFormat | "text";

/** Shapes of well-known credentials that are secret wherever they stand. */
const SECRET_SHAPES: RegExp[] = [
	/\bsk-[A-Za-z0-9_-]{16,}/,
	/\bgh[pousr]_[A-Za-z0-9]{20,}/,
	/\bgithub_pat_[A-Za-z0-9_]{20,}/,
	/\bglpat-[A-Za-z0-9_-]{16,}/,
	/\bxox[baprs]-[A-Za-z0-9-]{10,}/,
	/\bAKIA[0-9A-Z]{16}\b/,
	/\bAIza[0-9A-Za-z_-]{30,}/,
	/\bhf_[A-Za-z0-9]{20,}/,
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
	/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/,
	// A webhook's address is its secret: whoever has it can post.
	/https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9/_-]{8,}/,
	/https:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[A-Za-z0-9_-]{16,}/,
	/https:\/\/[a-z0-9.-]+\.webhook\.office\.com\/webhook[a-z0-9]*\/[A-Za-z0-9@/_.-]{16,}/,
	/https:\/\/[a-z0-9.-]+\/(?:api\/)?webhooks?\/[A-Za-z0-9_-]{24,}/,
];
const SHAPES_GLOBAL = SECRET_SHAPES.map(
	(re) => new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`),
);

/** Key names (lower case, without `-`, `_`, `.` and spaces) that end in one of these hold a secret. */
const SECRET_SUFFIXES = [
	"key",
	"secret",
	"token",
	"password",
	"passwd",
	"passphrase",
	"pat",
	"credential",
	"credentials",
	"authorization",
	"cookie",
	"bearer",
	"auth",
	"pwd",
	"webhook",
	"webhookurl",
];

/**
 * Names that end in "key" and are no secret: a key of the keyboard, of a sort or of a cache, of a table. (The names are
 * what a settings file of omp, an editor or a database client has; a secret under one of them is not found, which the
 * plan's "best effort" says.)
 */
const NOT_SECRET_KEYS = [
	"hotkey",
	"shortcutkey",
	"sortkey",
	"orderkey",
	"groupkey",
	"cachekey",
	"foreignkey",
	"partitionkey",
	"rowkey",
	"objectkey",
	"tabkey",
	"enterkey",
	"escapekey",
	"modifierkey",
	"leaderkey",
	"prefixkey",
	"submitkey",
	"togglekey",
	"newlinekey",
	"keybinding",
	"keybindings",
	"keymap",
];
/** An object under one of these keys is secret all through. */
const SECRET_OBJECTS = new Set(["credential", "credentials", "secret", "secrets"]);

/** A name that gives a secret away, as a flag or as a variable: `--api-key`, `SERVICE_TOKEN`, `db.password`. */
// `pwd` and `pass` are a password only as the last word of a longer name (`MYSQL_PWD`, `DB_PASS`): `PWD` is the folder you are in.
const NAME = "(?:[A-Za-z0-9_.-]*(?:key|token|secret|password|passwd|passphrase|pat)|[A-Za-z0-9_.-]*[_.-](?:pwd|pass))";
/** A flag that takes the secret as the next argument. */
const SECRET_FLAG = new RegExp(`^--?${NAME}$`, "i");
/** `NAME=value` anywhere in a string: a command line, an environment assignment. */
const ASSIGNMENT = new RegExp(`((?:^|[\\s;&|(])-{0,2}${NAME}\\s*=\\s*)("[^"]*"|'[^']*'|[^\\s;&|"')]+)`, "gi");
/** `Password=…` in a connection string. */
const CONNECTION = /((?:^|[;,\s])(?:password|pwd|pass)\s*=\s*)("[^"]*"|'[^']*'|[^;,\s"']*)/gi;
/** `scheme://user:password@host` */
const URL_PASSWORD = /([a-z][a-z0-9+.-]*:\/\/[^/:@\s]+):([^@/\s]+)@/gi;

const normal = (key: string): string => key.toLowerCase().replace(/[-_.\s]/g, "");

/** Words that name a password when they end a key of their own (`DB_PASS`, `dbPass`), though `bypass` and `compass` do not. */
const PASS_WORD = /(?:^|[_.\-\s])pass$|(?:db|mysql|pg|postgres|redis|smtp|ftp|ssh|sql|mongo)pass$/i;

export function isSecretKey(key: string): boolean {
	const k = normal(key);
	if (k === "pwd" || NOT_SECRET_KEYS.some((n) => k.endsWith(n))) return false;
	return SECRET_SUFFIXES.some((s) => k.endsWith(s)) || PASS_WORD.test(key) || PASS_WORD.test(k);
}

const NUMBER = /^-?\d+(?:\.\d+)?$/;
/** A number this long under a secret key is one (a PIN or an id of a few digits is a setting). */
const SECRET_DIGITS = 6;

/**
 * A value that is not a secret but a way to find one: nothing, a variable that is filled in later (`${TOKEN}`, also after
 * `Bearer`), a word that names a method. omp reads an `apiKey` that is a variable's name (`OPENAI_API_KEY`, at least one
 * underscore) or starts with `!` (a command) as such; under any other name those are values like any other.
 */
function isReference(value: string, key: string | null): boolean {
	const v = value.trim();
	if (v === "") return true;
	const left = v
		.replace(/\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*/g, "")
		.replace(/^(bearer|basic|token)\s*/i, "")
		.trim();
	if (left === "" && v !== left) return true;
	if (/^(none|null|true|false|oauth|apikey|api_key|bearer|basic)$/i.test(v)) return true;
	if (key !== null && normal(key) === "apikey") {
		if (v.startsWith("!")) return true;
		if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(v)) return true;
	}
	return false;
}

/** Whether a scalar under `key` is a secret: a string by its words, a long number by its digits. */
function secretScalar(value: string | number, key: string | null): boolean {
	if (key === null || !isSecretKey(key)) return false;
	if (typeof value === "number") return String(Math.abs(value)).replace(".", "").length >= SECRET_DIGITS;
	if (isReference(value, key)) return false;
	return !(NUMBER.test(value.trim()) && value.trim().replace(/[-.]/g, "").length < SECRET_DIGITS);
}

/** `text` with the secret parts of a string blanked: the part that is the secret only, so what is around it stays. */
function blankString(text: string): { text: string; count: number } {
	let count = 0;
	let out = text.replace(ASSIGNMENT, (whole, head: string, value: string) => {
		const bare = value.replace(/^["']|["']$/g, "");
		if (isReference(bare, null)) return whole;
		count++;
		return `${head}${/^["']/.test(value) ? value[0] + value[0] : ""}`;
	});
	out = out.replace(CONNECTION, (whole, head: string, value: string) => {
		if (value.replace(/^["']|["']$/g, "") === "") return whole;
		count++;
		return head;
	});
	out = out.replace(URL_PASSWORD, (_whole, head: string) => {
		count++;
		return `${head}@`;
	});
	for (const re of SHAPES_GLOBAL) {
		out = out.replace(re, () => {
			count++;
			return "";
		});
	}
	return { text: out, count };
}

/** Blank every secret in a parsed document, in place; how many there were. */
function blankTree(root: unknown): number {
	let count = 0;
	const visit = (
		parent: Record<string, unknown> | unknown[],
		key: string | number,
		name: string | null,
		forced: boolean,
		flag: string | null,
	): void => {
		const slot = parent as Record<string | number, unknown>;
		const v = slot[key];
		if (typeof v === "string" || typeof v === "number") {
			if (forced ? typeof v === "string" && !isReference(v, null) : secretScalar(v, name)) {
				slot[key] = "";
				count++;
				return;
			}
			if (typeof v === "string") {
				if (flag !== null && SECRET_FLAG.test(flag) && !isReference(v, null)) {
					slot[key] = "";
					count++;
					return;
				}
				const blanked = blankString(v);
				if (blanked.count > 0) {
					slot[key] = blanked.text;
					count += blanked.count;
				}
			}
			return;
		}
		if (Array.isArray(v)) {
			for (let i = 0; i < v.length; i++) {
				const before = v[i - 1];
				visit(v, i, name, forced, typeof before === "string" ? before : null);
			}
			return;
		}
		if (isRecord(v)) for (const k of Object.keys(v)) visit(v, k, k, forced || SECRET_OBJECTS.has(normal(k)), null);
	};
	const top = { root };
	visit(top, "root", null, false, null);
	return count;
}

function parse(text: string, format: ConfigFormat): unknown {
	return format === "json" ? JSON.parse(text) : Bun.YAML.parse(text);
}

const KEY_LINE = /^(\s*(?:-\s+)?)(?:"([^"\\]+)"|'([^']+)'|([A-Za-z0-9_.@/-]+))(\s*:[ \t]*)(.*)$/;

/** The scalar at the start of `rest` (a quoted or plain value), and what follows it. */
function scalarOf(rest: string): { value: string; after: string } | null {
	if (rest.startsWith('"')) {
		for (let i = 1; i < rest.length; i++) {
			if (rest[i] === "\\") i++;
			else if (rest[i] === '"') return { value: rest.slice(0, i + 1), after: rest.slice(i + 1) };
		}
		return null;
	}
	if (rest.startsWith("'")) {
		for (let i = 1; i < rest.length; i++) {
			if (rest[i] === "'") {
				if (rest[i + 1] === "'") i++;
				else return { value: rest.slice(0, i + 1), after: rest.slice(i + 1) };
			}
		}
		return null;
	}
	if (/^[[{|>&*]/.test(rest)) return null;
	const hash = rest.search(/\s#/);
	const end = hash < 0 ? rest.length : hash;
	const plain = rest.slice(0, end).replace(/,\s*$/, "");
	return { value: plain.trimEnd(), after: rest.slice(plain.trimEnd().length) };
}

/** Blank the value of every secret key that is written on its own line, keeping the file as it was written. */
function blankLines(text: string): string {
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const m = KEY_LINE.exec(lines[i]);
		if (!m) continue;
		const key = m[2] ?? m[3] ?? m[4] ?? "";
		const rest = m[6];
		if (!isSecretKey(key)) continue;
		const quote = m[2] !== undefined ? `"${key}"` : m[3] !== undefined ? `'${key}'` : key;
		// A block scalar: its text is the lines below, indented deeper than the key.
		if (/^[|>]/.test(rest)) {
			const indent = m[1].length;
			let j = i + 1;
			while (j < lines.length && (lines[j].trim() === "" || lines[j].length - lines[j].trimStart().length > indent))
				j++;
			lines.splice(i + 1, j - i - 1);
			lines[i] = `${m[1]}${quote}${m[5]}""`;
			continue;
		}
		const scalar = scalarOf(rest);
		if (!scalar) continue;
		const bare = scalar.value.replace(/^["']|["']$/g, "");
		if (!secretScalar(bare, key)) continue;
		lines[i] = `${m[1]}${quote}${m[5]}""${scalar.after}`;
	}
	return lines.join("\n");
}

/**
 * A file that is no document this can read (a JSON with comments, a half-written YAML): its lines are searched for a name
 * that gives a secret away followed by `:` or `=` and a value, and for the shapes of credentials.
 */
const LOOSE = new RegExp(
	`(["']?)(${NAME}|credentials?|authorization|cookie|bearer)\\1(\\s*[:=]\\s*)("(?:[^"\\\\\\n]|\\\\.)*"|'[^'\\n]*'|[^\\s,}\\]#;]+)`,
	"gi",
);

function blankLoose(text: string): { text: string; count: number } {
	let count = 0;
	const out = text.replace(LOOSE, (whole, quote: string, name: string, sep: string, value: string) => {
		const bare = value.replace(/^["']|["']$/g, "");
		if (isReference(bare, name) || (NUMBER.test(bare) && bare.replace(/[-.]/g, "").length < SECRET_DIGITS))
			return whole;
		count++;
		return `${quote}${name}${quote}${sep}${/^["']/.test(value) ? value[0] + value[0] : ""}`;
	});
	const rest = blankString(out);
	return { text: rest.text, count: count + rest.count };
}

/** `NAME=value` lines and the shapes of credentials: all that is looked for in a file written for a person to read. */
function blankProse(text: string): { text: string; count: number } {
	let count = 0;
	const lines = text.split("\n").map((line) => {
		const m = /^(\s*(?:export\s+)?[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PAT)=)(\S+)\s*$/.exec(line);
		if (!m || isReference(m[2].replace(/^["']|["']$/g, ""), null)) return line;
		count++;
		return m[1];
	});
	let out = lines.join("\n");
	for (const re of SHAPES_GLOBAL) {
		out = out.replace(re, () => {
			count++;
			return "";
		});
	}
	return { text: out, count };
}

function indentOf(text: string): string | number {
	const m = /^\n?([ \t]+)\S/m.exec(text);
	if (!m) return 2;
	return m[1].includes("\t") ? "\t" : m[1].length;
}

export interface Redaction {
	text: string;
	/** How many secret values were blanked. */
	count: number;
	/** False when a secret is still in `text`: the file must not go into an archive without credentials. */
	clean: boolean;
}

const holdsShape = (text: string): boolean => SECRET_SHAPES.some((re) => re.test(text));

/** The secrets of one file counted and blanked; a file with none comes back as it was, byte for byte. */
export function redactSecrets(text: string, format: RedactFormat): Redaction {
	if (format === "text") {
		const r = blankProse(text);
		return { text: r.count > 0 ? r.text : text, count: r.count, clean: !holdsShape(r.text) };
	}
	let tree: unknown;
	try {
		tree = parse(text, format);
	} catch {
		const r = blankLoose(text);
		return { text: r.count > 0 ? r.text : text, count: r.count, clean: !holdsShape(r.text) };
	}
	const had = blankTree(structuredClone(tree));
	if (had === 0) return { text, count: 0, clean: true };
	const remaining = (candidate: string): number => {
		try {
			return blankTree(parse(candidate, format));
		} catch {
			return -1;
		}
	};
	// First the lines (they keep the file as it was written, comments included); the document is the proof.
	let result = blankLines(text);
	let left = remaining(result);
	if (left !== 0) {
		// Not one value to a line (a minified file, a flow style): the document is written again, blanked.
		const copy = parse(text, format);
		blankTree(copy);
		result = format === "json" ? `${JSON.stringify(copy, null, indentOf(text))}\n` : Bun.YAML.stringify(copy, null, 2);
		left = remaining(result);
	}
	return { text: result, count: had, clean: left === 0 };
}

/** How many secret values a file holds, without changing it. */
export function countSecrets(text: string, format: RedactFormat): number {
	return redactSecrets(text, format).count;
}
