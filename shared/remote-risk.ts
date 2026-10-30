import { RISK_COMMAND, RISK_IN, type RiskKind } from "./risk-confirm.ts";

/**
 * Which tool calls are "high-risk", for the opt-in confirmation of risky calls that a remote page drives (Settings ›
 * Remote access). One module, importing nothing but the kind names and the labels of a command's detail
 * (`shared/risk-confirm.ts`, which the gate is installed with), so that the gate inside omp (`server/omp/gate/
 * extension.ts`, which is copied next to this file and runs in omp's own process) and the unit tests read the same code.
 *
 * It is a best effort and says so wherever it is documented: it reads the command or the path a call carries and knows a
 * short list of things (docs/TECHNICAL.md, "Confirm risky commands from remote pages"). It is not a sandbox. A script that is run by
 * name, a command assembled when it runs, a path a program works out: none of it can be seen from here. A call it does
 * not recognise runs as the conversation's permission mode says. Read-only tools never need confirming.
 */

/** Where the call runs and what is its own: every other place is "outside the project". */
export interface RiskContext {
	/** The conversation's folder, and each other spelling of it (its real path). */
	roots: readonly string[];
	home: string;
	/** Temporary folders: a file there is not "outside the project" (build output, scratch files). */
	temp: readonly string[];
	/** Places an agent never changes unasked besides the built-in ones: the app's data folder, omp's agent folder, the gate's own state. */
	protect: readonly string[];
	/**
	 * The loopback ports an omp-webui may serve its API on (the server's own, the ones it may fall back through, other
	 * instances', the dev proxy's), so that only their `/api/` is protected and not any loopback one. Absent or empty where
	 * the server has not said (it has not bound yet, or a state from before this): then every loopback `/api/` URL asks.
	 */
	ports?: readonly number[];
	/**
	 * The addresses this server answers on besides the loopback, as `OMP_WEBUI_HOST` bound it (a network address or a name
	 * of this computer on one), so that a model's command that calls their `/api/` is treated like one that calls the
	 * loopback's: a server bound to `192.168.1.5` is the same gate whichever of its addresses a command names. Absent or
	 * empty where it is bound to the loopback, to every address (`0.0.0.0`, `::`), or where the server has not said: then
	 * only the loopback spellings ask (see `ownApi`).
	 */
	hosts?: readonly string[];
}

/** What a risky call is: why (most serious first), and what the person is shown (the exact command or paths). */
export interface Risk {
	kinds: RiskKind[];
	detail: string;
}

type Table = Readonly<Record<string, true>>;
const table = (...names: string[]): Table => Object.fromEntries(names.map((n) => [n, true]));
const listed = (t: Table, name: string): boolean => Object.hasOwn(t, name);

/** Tools that only read: never confirmed. */
const READ_ONLY_TOOLS = table(
	"read",
	"grep",
	"glob",
	"find",
	"ast_grep",
	"lsp",
	"todo",
	"ask",
	"wait",
	"web_search",
	"recall",
	"reflect",
	"search",
	"ls",
	"checkpoint",
	"rewind",
	"new_context",
	"context_notes",
);

/** `remote_access_*` tools that read (see `shared/remote-ai.ts`): the others change the tunnel or its settings. */
const REMOTE_TOOLS_READING = table("remote_access_guide", "remote_access_status", "remote_access_check");

/** Folders that hold credentials or the configuration of omp, wherever they are. */
const PROTECTED_SEGMENTS = table(".ssh", ".gnupg", ".aws", ".omp");
/** Files in the home folder that run code or hold credentials: a shell's start-up files, git's config, `.netrc`. */
const PROTECTED_HOME_FILES = table(
	".zshrc",
	".zshenv",
	".zprofile",
	".zlogin",
	".zlogout",
	".bashrc",
	".bash_profile",
	".bash_login",
	".profile",
	".gitconfig",
	".netrc",
);
/** Folders whose files launchd starts, in the home folder or the system's: a lasting way to run something. */
const LAUNCH_DIR = /\/Library\/Launch(Agents|Daemons)(\/|$)/;

/** Programs that only read what they are given: naming a protected place to one of them is not a change. */
const READING_PROGRAMS = table(
	"cat",
	"ls",
	"head",
	"tail",
	"less",
	"more",
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"stat",
	"file",
	"wc",
	"du",
	"df",
	"diff",
	"cmp",
	"tree",
	"echo",
	"printf",
	"pwd",
	"realpath",
	"readlink",
	"basename",
	"dirname",
	"test",
	"[",
	"md5",
	"md5sum",
	"shasum",
	"sha256sum",
	"strings",
	"hexdump",
	"xxd",
	"od",
	"jq",
	"cd",
	"pushd",
	"popd",
	"true",
	"false",
	"which",
	"type",
);

/**
 * Programs that look at a path and not into the file: what they print of a secret is its name or size, never the secret.
 * Any other program given a secret (`cat`, `grep`, `cp`, `base64`, `scp`…) reads it (`secret_read`).
 */
const METADATA_PROGRAMS = table(
	"ls",
	"stat",
	"file",
	"du",
	"df",
	"tree",
	"echo",
	"printf",
	"pwd",
	"realpath",
	"readlink",
	"basename",
	"dirname",
	"test",
	"[",
	"cd",
	"pushd",
	"popd",
	"true",
	"false",
	"which",
	"type",
	"mkdir",
	"chmod",
);
/** Tools that read what is in a file (not only its name): handing one a secret is reading it. */
const CONTENT_TOOLS = table("read", "grep", "ast_grep", "search");
/** Folders whose files are credentials, wherever they are. */
const SECRET_SEGMENTS = table(".gnupg", ".aws");
/** What in an `.ssh` folder is not a secret: public keys, the hosts it knows and has let in, its own settings. */
const SSH_NOT_SECRET = /^(.+\.pub|known_hosts(\.old)?|authorized_keys2?|config)$/;
/** Files directly in the home folder that hold a password or a token. */
const SECRET_HOME_FILES = table(".netrc", ".git-credentials", ".npmrc", ".pgpass", ".pypirc");
/** Places under the home folder that hold tokens or keys: gh's login, docker's and kubectl's credentials, the keychains, gcloud's. */
const SECRET_HOME_PLACES = [
	".config/gh/hosts.yml",
	".docker/config.json",
	".kube/config",
	"Library/Keychains",
	".config/gcloud",
];

/** A path whose content is a credential: reading it hands over a key, a token or a password. */
function isSecret(abs: string, home: string): boolean {
	const parts = abs.split("/");
	if (parts.some((s) => listed(SECRET_SEGMENTS, s))) return true;
	const ssh = parts.lastIndexOf(".ssh");
	if (ssh >= 0) {
		const rest = parts.slice(ssh + 1).filter((s) => s !== "");
		// The folder itself (`grep -r`, `cat ~/.ssh/*`) or a file in it that is not public.
		return rest.length === 0 || !SSH_NOT_SECRET.test(rest[rest.length - 1]);
	}
	const h = normalize(home);
	if (parentOf(abs) === h && listed(SECRET_HOME_FILES, abs.slice(abs.lastIndexOf("/") + 1))) return true;
	return SECRET_HOME_PLACES.some((p) => within(abs, `${h}/${p}`));
}

const SHELLS = table("sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh");
const CODE_INTERPRETERS = table(
	"python",
	"python2",
	"python3",
	"perl",
	"ruby",
	"node",
	"bun",
	"deno",
	"php",
	"lua",
	"osascript",
);
const FETCHERS = table("curl", "wget", "fetch");
const PRIVILEGE = table("sudo", "doas", "pkexec", "run0", "su");
/** Programs whose job is to carry this computer onto the internet. */
const TUNNELS = table("cloudflared", "ngrok", "bore", "frpc", "frps", "localtunnel", "serveo");
const DELETERS = table("rm", "unlink", "rmdir", "shred", "srm");
const SYSTEM_PROGRAMS = table(
	"shutdown",
	"reboot",
	"halt",
	"poweroff",
	"csrutil",
	"fdisk",
	"gdisk",
	"parted",
	"mkswap",
	"newfs",
	"newfs_apfs",
	"newfs_hfs",
);

/** The most nested `$(…)`, `bash -c '…'` and `eval` that are looked into; what is deeper is not understood, so it asks. */
const MAX_DEPTH = 8;
/** The most characters of a program's source that are searched for strings (more asks: it cannot be read through). */
const MAX_CODE = 200_000;

/**
 * The hosts that are this computer's own, in the spellings a client resolves to the loopback (best effort: a shell or a
 * program can always spell one more): `127.1`, `0x7f.1`, `0x7f000001`, octal `0177.0.0.1`, decimal `2130706433`, `0`,
 * `[::1]`, `[::ffff:127.0.0.1]`, `localhost.`, and the host's own name as the shell gives it (`$HOSTNAME`, `$(hostname)`).
 */
const SELF_HOSTS = [
	/\b127(?:\.\d+){1,3}/,
	/\b0x7f[\da-f]*(?:\.[\da-fx]+){0,3}/,
	/\b0177\d*(?:\.\d+){0,3}/,
	/\b2130706433/,
	/\b0\.0\.0\.0/,
	/(?<=\/\/|@)0/,
	/\blocalhost\.?/,
	/\[(?:0{0,4}:){0,8}:?0{0,3}1\]/,
	/\[::ffff:(?:127(?:\.\d+){3}|7f[\da-f]{2}:[\da-f]{1,4})\]/,
	/\$\{?HOST(?:NAME)?\b\}?/,
	/\$\(\s{0,20}(?:hostname|uname\s{1,20}-n)\b[^)]{0,80}\)/,
	/`\s{0,20}(?:hostname|uname\s{1,20}-n)\b[^`]{0,80}`/,
];

/** The server's sign-in token: its header and its cookie. */
const SELF_TOKEN = /x-omp-webui-token|ompw_token/i;
/**
 * A loopback `/api/` URL, with its port (group 1, absent when the URL has none) as written: whoever can call the server's
 * own API can switch the gate off (`selfAccess` says which of these are the server's).
 */
const SELF_API = new RegExp(
	`(?:${SELF_HOSTS.map((r) => r.source).join("|")})(?::([^\\s/'"\`]{0,80}))?\\/api(?![\\w.-])`,
	"gi",
);

/** Addresses that name every address of this computer rather than one: a command never reaches the server by writing one. */
const ANY_ADDRESS = table("0.0.0.0", "::", "0:0:0:0:0:0:0:0", "*");

/** The last pattern built for a list of the server's own addresses: the gate reads it before every tool call. */
let ownApiCache: { key: string; pattern: RegExp } | null = null;

/**
 * The `/api/` URLs of the addresses this server is bound to besides the loopback (`ctx.hosts`), read as `SELF_API` reads
 * the loopback ones: the host, then its port (group 1, absent when the URL has none) as written, then `/api`. Nothing
 * that is not one address or name a URL could carry is read (a wildcard, a list, a path): such a host is the server's
 * anyway, and the loopback spellings cover it. Built for one list and kept while that list is the same; null when no host
 * of the list counts.
 */
function ownApi(hosts: readonly string[]): RegExp | null {
	const own = [
		...new Set(
			hosts
				.map((h) =>
					h
						.trim()
						.replace(/^\[|\]$/g, "")
						.toLowerCase(),
				)
				.filter((h) => h !== "" && !listed(ANY_ADDRESS, h) && !/[\s/\\?#@,]/.test(h)),
		),
	];
	if (own.length === 0) return null;
	const key = own.join("\n");
	if (ownApiCache?.key === key) return ownApiCache.pattern;
	// An address with a port in it is an IPv6 one, written in brackets in a URL and bare elsewhere; `%en0` is `%25en0`.
	const patterns = own.map((h) => {
		const escaped = h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const zoned = h.includes("%") ? escaped.replace(/%25|%/, "%(?:25)?") : escaped;
		return h.includes(":") ? `(?:\\[${zoned}\\]|${zoned})` : zoned;
	});
	const pattern = new RegExp(`(?<![\\w.-])(?:${patterns.join("|")})(?::([^\\s/'"\`]{0,80}))?\\/api(?![\\w.-])`, "gi");
	ownApiCache = { key, pattern };
	return pattern;
}

/**
 * Whether the port a `/api/` URL writes (`group`) is one an omp-webui may serve on: one that is not written out digit by
 * digit (`:$PORT`, `:${P}`) asks, as does every one while the ports are not known.
 */
function servesOn(group: string | undefined, ports: readonly number[] | undefined): boolean {
	if (!ports || ports.length === 0) return true;
	// No port written: the scheme's default one, which is an omp-webui's only if it listens there.
	if (group === undefined) return ports.includes(80) || ports.includes(443);
	return !/^\d{1,5}$/.test(group) || ports.includes(Number(group));
}

/**
 * Whether `text` (a command or a program) names the server's sign-in token or its own API: whoever has them can switch
 * the gate off, so any mention asks. Of the `/api/` URLs only those on a port an omp-webui may serve on count
 * (`ctx.ports`: `curl localhost:3000/api/health` in ordinary web development is nobody's business, and so is the API of
 * another program on this server's own network address): on the loopback ones, and on the addresses this server is bound
 * to besides the loopback (`ctx.hosts`, `OMP_WEBUI_HOST`: `curl http://192.168.1.5:7878/api/remote` reaches the same
 * server as `127.0.0.1` does).
 */
function selfAccess(text: string, ctx: RiskContext): boolean {
	if (SELF_TOKEN.test(text)) return true;
	for (const url of text.matchAll(SELF_API)) if (servesOn(url[1], ctx.ports)) return true;
	const own = ctx.hosts && ctx.hosts.length > 0 ? ownApi(ctx.hosts) : null;
	if (own === null) return false;
	for (const url of text.matchAll(own)) if (servesOn(url[1], ctx.ports)) return true;
	return false;
}

/** What `omp` is asked to change that is its own configuration or the code it loads: `omp config set …`, `omp plugin install …`. */
const OMP_CHANGES: Readonly<Record<string, Table>> = {
	config: table("set", "unset"),
	plugin: table("install", "uninstall", "enable", "disable", "link", "unlink"),
};
/** Programs that fetch another program and run it: `npx rimraf …`, `npm exec rm …`, `bunx …`, `pnpm dlx …`. */
const RUNNERS = table("npx", "bunx", "pnpx");
const RUNNER_MANAGERS = table("npm", "pnpm", "yarn", "bun");
const RUNNER_VERBS = table("exec", "x", "dlx");
const RUNNER_VALUES = table(
	"-p",
	"--package",
	"-w",
	"--workspace",
	"--registry",
	"--cache",
	"--prefix",
	"--userconfig",
);

/** Calls in a program's source that delete their first argument, write it, put something at their second, or move it. */
const CODE_DELETE = table(
	"rmtree",
	"rm_rf",
	"rm_r",
	"remove_entry",
	"remove_dir",
	"rmSync",
	"rmdirSync",
	"unlinkSync",
	"removeSync",
	"remove",
	"unlink",
	"rmdir",
	"rm",
	"rimraf",
	"rimrafSync",
	"rimraf.sync",
	"emptyDir",
	"emptyDirSync",
);
/** The deletes that take everything under their path with them, whatever options they are given. */
const CODE_DELETE_TREE = table(
	"rmtree",
	"rm_rf",
	"rm_r",
	"remove_entry",
	"remove_dir",
	"rimraf",
	"rimrafSync",
	"rimraf.sync",
	"removeSync",
	"emptyDir",
	"emptyDirSync",
);
const CODE_WRITE = table(
	"writeFileSync",
	"writeFile",
	"writeTextFileSync",
	"writeTextFile",
	"appendFileSync",
	"appendFile",
	"outputFile",
	"outputFileSync",
	"mkdirSync",
	"mkdir",
	"makedirs",
	"write_text",
	"write_bytes",
	"touch",
	"open",
	"openSync",
	"Bun.write",
);
const CODE_COPY = table(
	"copyFileSync",
	"copyFile",
	"copySync",
	"cpSync",
	"cp",
	"copy",
	"copy2",
	"copyfile",
	"copytree",
	"symlinkSync",
	"symlink",
	"link",
	"linkSync",
);
const CODE_MOVE = table("renameSync", "rename", "move", "moveSync");
const CODE_CALL = new RegExp(
	`\\b(Bun\\.write|${[
		...Object.keys(CODE_DELETE),
		...Object.keys(CODE_WRITE),
		...Object.keys(CODE_COPY),
		...Object.keys(CODE_MOVE),
	]
		.filter((n) => n !== "Bun.write")
		.join("|")})\\s*\\(`,
	"g",
);
/** A program that works with the home folder: what it deletes or writes may well be in it, however the path is built. */
const HOME_USE =
	/\bPath\s*\.\s*home\s*\(|\bexpanduser\s*\(|\benviron\s*(?:\[\s*|\.get\s*\(\s*)["']HOME["']|\bgetenv\s*\(\s*["']HOME["']|\bhomedir\s*\(|\b(?:process|Bun|Deno)\.env(?:\.HOME\b|\[\s*["']HOME["']|\.get\(\s*["']HOME["'])|\$HOME\b|\$\{HOME\}|["'`]~\//;
/**
 * `Path('/x').unlink()`, `Bun.file('/x').delete()`: a method called on a path written as a literal. The chain between the
 * path and the method is bounded (300 characters): an unbounded lazy span is quadratic on a long line with many `Path('…')`
 * and no such method, and the classifier runs synchronously in omp's `tool_call` handler.
 */
const PATH_CHAIN =
	/\b(?:Bun\.file|(?:pathlib\.)?Path)\(\s*((?:[rRbBuUfF]{0,2})(["'])(?:\\.|(?!\2)[^\\\n])*\2)\s*\)[^\n;]{0,300}?\.(unlink|rmdir|rmtree|write_text|write_bytes|touch|mkdir|rename|symlink_to|hardlink_to|write|writer|delete)\s*\(/g;
/** A call that starts a program from a list of arguments (`subprocess.run([…])`, `execFileSync('rm', […])`, `Bun.spawn([…])`). */
const ARGV_CALL =
	/\b(?:subprocess\.(?:run|call|check_call|check_output|Popen)|Popen|os\.(?:exec|spawn|posix_spawn)\w*|Bun\.spawn(?:Sync)?|(?:child_process\.)?(?:spawn|spawnSync|execFile|execFileSync|fork)|execa(?:Sync)?)\s*\(\s*(?:(["'])([^"'\n]*)\1\s*,\s*)?\[/g;
/**
 * A call that starts a program or a shell from a command written as one string or built (`execSync(cmd)`, `os.system(cmd)`,
 * `subprocess.run(cmd, shell=True)`). A command written out in it is read as a shell command; one only known when the
 * program runs cannot be, and is `shell_out`. (The bare `exec`, `execFile` and `spawn` count where the program says it
 * brings them in from `child_process`: `regex.exec(…)` is no program.)
 */
const SHELL_CALL =
	/\b(?:os\.(?:system|popen)|subprocess\.(?:run|call|check_call|check_output|Popen|getoutput|getstatusoutput)|commands\.getoutput|Bun\.spawn(?:Sync)?|(?:child_process\.)?(?:execSync|execFileSync|spawnSync)|child_process\.(?:exec|execFile|spawn)|execa(?:Sync)?|Deno\.Command)\s*\(/g;
const SHELL_CALL_BARE = /(?<![.\w])(?:exec|execFile|spawn)\s*\(/g;
/** A tagged template whose command is nothing but a part worked out when it runs: ``Bun.$`${cmd}` ``, ``$`${cmd} ${x}` ``. */
const SHELL_TEMPLATE = /\$\s*`\s*\$\{/;
/** What stands in a word for a part that is only known when the command runs (`$VAR`, `$(…)`): a private-use character. */
const DYN = "\uE000";

// ---------------------------------------------------------------------------------------------------- paths

/** `p` (absolute) with `.`, `..` and repeated slashes resolved. */
function normalize(p: string): string {
	const out: string[] = [];
	for (const segment of p.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") out.pop();
		else out.push(segment);
	}
	return `/${out.join("/")}`;
}

const parentOf = (p: string): string => (p === "/" ? "/" : normalize(`${p}/..`));
const within = (p: string, dir: string): boolean => dir === "/" || p === dir || p.startsWith(`${dir}/`);

/** Places a program may be told to write that are no one's file. */
const SAFE_DEVICES = table("/dev/null", "/dev/stdout", "/dev/stderr", "/dev/stdin", "/dev/tty", "/dev/zero");
const isSafeDevice = (p: string): boolean => listed(SAFE_DEVICES, p) || p.startsWith("/dev/fd/");

function inProject(abs: string, ctx: RiskContext): boolean {
	return ctx.roots.some((r) => within(abs, r));
}

function inTemp(abs: string, ctx: RiskContext): boolean {
	return isSafeDevice(abs) || ctx.temp.some((t) => within(abs, t));
}

/** A place nothing changes unasked: credentials, omp's configuration, the app's data, files that start programs. */
function isProtected(abs: string, ctx: RiskContext): boolean {
	if (abs.split("/").some((s) => listed(PROTECTED_SEGMENTS, s))) return true;
	if (ctx.protect.some((d) => d !== "" && within(abs, d))) return true;
	if (LAUNCH_DIR.test(abs)) return true;
	return parentOf(abs) === normalize(ctx.home) && listed(PROTECTED_HOME_FILES, abs.slice(abs.lastIndexOf("/") + 1));
}

/**
 * Whether `abs` is a place nothing is changed in or carried out of unasked (`isProtected`), for code that is not a gate: the
 * file transfer of a page that is not on this computer (`server/folder-transfer.ts`) asks the same question of what it
 * would read or write, so there is one definition of such a place. `abs` is a real path; `protect` are the app's data
 * folders, omp's agent folder and the gate's own state, as the gate is given them.
 */
export function isProtectedPath(abs: string, places: { home: string; protect: readonly string[] }): boolean {
	return isProtected(normalize(abs), { roots: [], temp: [], ...places });
}

/** Too much to delete or change in one go: the root, the home folder, and what is directly in either. */
function isBroad(abs: string, ctx: RiskContext): boolean {
	const home = normalize(ctx.home);
	return abs === "/" || abs === home || parentOf(abs) === "/" || parentOf(abs) === home;
}

/**
 * Where a word points: its absolute path, resolved against `cwd` (null: not known). A glob or a part only known when the
 * command runs (`$DIR/x`, `/tmp/$(date)`) answers with the folder it is in, which is as much as can be said; a word that
 * starts with such a part has no folder: unknown.
 */
function resolveWord(w: Word, cwd: string | null): string | null {
	const text = w.text;
	const cut = text.search(/[\uE000*?[{]/);
	let base = text;
	if (cut >= 0) {
		base = text.slice(0, text.lastIndexOf("/", cut) + 1);
		if (base === "" && text[cut] === DYN) return null;
	}
	if (base.startsWith("/")) return normalize(base);
	return cwd === null ? null : normalize(`${cwd}/${base}`);
}

// ---------------------------------------------------------------------------------------------------- the shell

/** One word of a command, as the shell takes it apart: quotes and escapes gone, `~` and `$HOME` written out. */
interface Word {
	text: string;
	/** Part of it is only known when the command runs: those parts are `DYN` in `text`. */
	dynamic: boolean;
	/** The commands inside it: `$(…)`, backticks, `<(…)`. */
	subs: string[];
	/** The shell variable the word is, when it is nothing but one (`"$f"`, `${f}`): a `for` loop's, for instance. */
	named?: string;
}

interface Redirect {
	op: string;
	target: Word;
}

/** One command: its words, its redirections, and what it is fed as input (a here-document or a here-string). */
interface Simple {
	words: Word[];
	redirects: Redirect[];
	body: string | null;
}

const emptyWord = (): Word => ({ text: "", dynamic: false, subs: [] });
const emptySimple = (): Simple => ({ words: [], redirects: [], body: null });

/** The text between `start` (just after an opening `open`) and its matching `close`, and where it ends. Quotes are respected. */
function readBalanced(src: string, start: number, open: string, close: string): { text: string; end: number } {
	let depth = 1;
	let i = start;
	while (i < src.length) {
		const c = src[i];
		if (c === "\\") {
			i += 2;
			continue;
		}
		if (c === "'") {
			const end = src.indexOf("'", i + 1);
			i = end < 0 ? src.length : end + 1;
			continue;
		}
		if (c === '"') {
			i = skipDouble(src, i + 1);
			continue;
		}
		if (c === open) depth++;
		else if (c === close && --depth === 0) return { text: src.slice(start, i), end: i + 1 };
		i++;
	}
	return { text: src.slice(start), end: src.length };
}

/** Where a double-quoted string ends: `start` is just after its opening quote; the answer is just after the closing one. */
function skipDouble(src: string, start: number): number {
	let i = start;
	while (i < src.length) {
		const c = src[i];
		if (c === "\\") i += 2;
		else if (c === '"') return i + 1;
		else if (c === "$" && src[i + 1] === "(") i = readBalanced(src, i + 2, "(", ")").end;
		else if (c === "`") i = readBackticks(src, i + 1).end;
		else i++;
	}
	return src.length;
}

function readBackticks(src: string, start: number): { text: string; end: number } {
	let i = start;
	while (i < src.length && src[i] !== "`") i += src[i] === "\\" ? 2 : 1;
	return { text: src.slice(start, i), end: Math.min(i + 1, src.length) };
}

/**
 * Take a script apart into pipelines of simple commands. It knows quoting, escapes, comments, `$(…)`, backticks,
 * process substitution, redirections and here-documents, and where one command ends and the next begins (`;`, `&&`,
 * `||`, `&`, a new line, a pipe, parentheses, braces). It runs, expands and understands nothing else; it never throws.
 */
function parseScript(src: string, home: string): Simple[][] {
	const pipelines: Simple[][] = [];
	let stages: Simple[] = [];
	let cur = emptySimple();
	// Assigned in closures, which the compiler does not follow: say what it can be.
	let word = null as Word | null;
	let redirect: string | null = null;
	/** Here-documents waiting for the lines after this one: the command they feed, the delimiter, and whether tabs are stripped. */
	const heredocs: { into: Simple; delimiter: string; strip: boolean }[] = [];

	const endWord = (): void => {
		if (word === null) return;
		if (redirect === "<<" || redirect === "<<-")
			heredocs.push({ into: cur, delimiter: word.text, strip: redirect === "<<-" });
		else if (redirect === "<<<") cur.body = word.text;
		else if (redirect !== null) cur.redirects.push({ op: redirect, target: word });
		else cur.words.push(word);
		redirect = null;
		word = null;
	};
	const endSimple = (): void => {
		endWord();
		if (cur.words.length > 0 || cur.redirects.length > 0) stages.push(cur);
		cur = emptySimple();
	};
	const endPipeline = (): void => {
		endSimple();
		if (stages.length > 0) pipelines.push(stages);
		stages = [];
	};
	const ensure = (): Word => {
		word ??= emptyWord();
		return word;
	};
	const dynamic = (sub?: string, name?: string): void => {
		const w = ensure();
		// Only a word that is nothing but the variable names it: `$f.bak` is not what the loop goes over.
		if (name !== undefined && w.text === "") w.named = name;
		w.dynamic = true;
		w.text += DYN;
		if (sub !== undefined) w.subs.push(sub);
	};
	/** A `$…` at `i`: what it stands for is added to the word; the answer is the index after it. */
	const variable = (i: number): number => {
		const next = src[i + 1];
		if (next === "(") {
			if (src[i + 2] === "(") {
				dynamic();
				return readBalanced(src, i + 3, "(", ")").end;
			}
			const inner = readBalanced(src, i + 2, "(", ")");
			dynamic(inner.text);
			return inner.end;
		}
		if (next === "{") {
			const inner = readBalanced(src, i + 2, "{", "}");
			if (inner.text === "HOME") ensure().text += home;
			else dynamic(undefined, /^[A-Za-z_][A-Za-z0-9_]*$/.test(inner.text) ? inner.text : undefined);
			return inner.end;
		}
		const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i + 1, i + 80))?.[0];
		if (name !== undefined) {
			if (name === "HOME") ensure().text += home;
			else dynamic(undefined, name);
			return i + 1 + name.length;
		}
		if (next !== undefined && /[0-9?$!@*#-]/.test(next)) {
			dynamic();
			return i + 2;
		}
		ensure().text += "$";
		return i + 1;
	};
	/** The bodies of the here-documents that wait, which start at `from` (just after a new line); the answer is the index after them. */
	const readHeredocs = (from: number): number => {
		let i = from;
		for (const doc of heredocs.splice(0)) {
			const lines: string[] = [];
			while (i < src.length) {
				const nl = src.indexOf("\n", i);
				const line = src.slice(i, nl < 0 ? src.length : nl);
				i = nl < 0 ? src.length : nl + 1;
				if ((doc.strip ? line.replace(/^\t+/, "") : line) === doc.delimiter) break;
				lines.push(line);
			}
			doc.into.body = `${doc.into.body === null ? "" : `${doc.into.body}\n`}${lines.join("\n")}`;
		}
		return i;
	};

	let i = 0;
	while (i < src.length) {
		const c = src[i];
		const next = src[i + 1];
		const atStart = word === null || word.text === "";
		if (c === " " || c === "\t" || c === "\r") {
			endWord();
			i++;
		} else if (c === "\n") {
			endPipeline();
			i = heredocs.length > 0 ? readHeredocs(i + 1) : i + 1;
		} else if (c === "#" && word === null) {
			while (i < src.length && src[i] !== "\n") i++;
		} else if (c === "\\") {
			if (next === "\n") i += 2;
			else {
				ensure().text += next ?? "";
				i += 2;
			}
		} else if (c === "'") {
			const end = src.indexOf("'", i + 1);
			ensure().text += src.slice(i + 1, end < 0 ? src.length : end);
			i = end < 0 ? src.length : end + 1;
		} else if (c === '"') {
			ensure();
			i++;
			while (i < src.length && src[i] !== '"') {
				const d = src[i];
				if (d === "\\" && i + 1 < src.length) {
					// Inside double quotes a backslash escapes only these characters.
					const n = src[i + 1];
					ensure().text += n === "\n" ? "" : '$`"\\'.includes(n) ? n : `\\${n}`;
					i += 2;
				} else if (d === "$") i = variable(i);
				else if (d === "`") {
					const inner = readBackticks(src, i + 1);
					dynamic(inner.text);
					i = inner.end;
				} else {
					ensure().text += d;
					i++;
				}
			}
			i++;
		} else if (c === "$" && next === "'") {
			// $'…': C-style escapes; the text is kept as written, which is enough to read a path or a word.
			ensure();
			i += 2;
			while (i < src.length && src[i] !== "'") {
				if (src[i] === "\\" && i + 1 < src.length) i++;
				ensure().text += src[i++];
			}
			i++;
		} else if (c === "$") {
			i = variable(i);
		} else if (c === "`") {
			const inner = readBackticks(src, i + 1);
			dynamic(inner.text);
			i = inner.end;
		} else if ((c === "<" || c === ">") && next === "(") {
			const inner = readBalanced(src, i + 2, "(", ")");
			dynamic(inner.text);
			i = inner.end;
		} else if (c === "~" && atStart && (next === undefined || /[\s/;&|)<>]/.test(next))) {
			ensure().text += home;
			i++;
		} else if (c === ";" || c === "(" || c === ")" || (c === "&" && next !== ">" && src[i - 1] !== ">")) {
			endPipeline();
			i += c === "&" && next === "&" ? 2 : 1;
		} else if (c === "|") {
			if (next === "|") {
				endPipeline();
				i += 2;
			} else {
				endSimple();
				i += next === "&" ? 2 : 1;
			}
		} else if ((c === "{" || c === "}") && atStart && (next === undefined || /[\s;)&|]/.test(next))) {
			endPipeline();
			i++;
		} else if (c === ">" || c === "<" || (c === "&" && next === ">")) {
			// A file-descriptor number right before the operator belongs to it (`2>file`).
			if (word !== null && /^\d+$/.test(word.text) && c !== "&") word = null;
			else endWord();
			let op: string;
			if (c === "&") {
				op = src[i + 2] === ">" ? "&>>" : "&>";
				i += op.length;
			} else {
				const two = src.slice(i, i + 2);
				const three = src.slice(i, i + 3);
				op = three === "<<<" || three === "<<-" ? three : /^(>>|>\||>&|<<|<&|<>)$/.test(two) ? two : c;
				i += op.length;
			}
			redirect = op;
			if (op === ">&" || op === "<&") {
				// A descriptor, not a file (`2>&1`, `<&-`): the word that names it is skipped.
				const named = /^\s*([0-9]+|-)/.exec(src.slice(i, i + 20));
				if (named) {
					i += named[0].length;
					redirect = null;
				}
			}
		} else {
			const w = ensure();
			if (c === DYN) w.dynamic = true;
			w.text += c;
			i++;
		}
	}
	endPipeline();
	return pipelines;
}

// ---------------------------------------------------------------------------------------------------- commands

const baseName = (s: string): string => s.slice(s.lastIndexOf("/") + 1);
const RESERVED = table("if", "then", "else", "elif", "do", "while", "until", "!", "time", "coproc", "exec", "builtin");
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** What a command runs once its wrappers are looked through (`env X=1 nice -n 5 rm …` runs `rm`), and what it is given. */
interface Command {
	name: string;
	args: Word[];
	/** It came through `xargs`: what it is given is not known (`ls | xargs rm`). */
	viaXargs: boolean;
}

/** The programs that run another: the options that take a value, and how many plain words come before the command. */
const WRAPPERS: Readonly<Record<string, { value: Table; positional: number }>> = {
	env: { value: table("-u", "-C", "-S", "-P"), positional: 0 },
	nohup: { value: table(), positional: 0 },
	command: { value: table(), positional: 0 },
	nice: { value: table("-n"), positional: 0 },
	ionice: { value: table("-c", "-n", "-p"), positional: 0 },
	stdbuf: { value: table("-i", "-o", "-e"), positional: 0 },
	timeout: { value: table("-s", "-k"), positional: 1 },
	xargs: { value: table("-I", "-n", "-P", "-L", "-s", "-d", "-E", "-a"), positional: 0 },
	caffeinate: { value: table("-t", "-w"), positional: 0 },
	setsid: { value: table(), positional: 0 },
	unbuffer: { value: table(), positional: 0 },
};

function commandOf(words: readonly Word[]): Command | null {
	let i = 0;
	let viaXargs = false;
	for (let guard = 0; guard < 16; guard++) {
		while (i < words.length && (listed(RESERVED, words[i].text) || ASSIGNMENT.test(words[i].text))) i++;
		if (i >= words.length || words[i].dynamic) return null;
		const name = baseName(words[i].text);
		const wrapper = Object.hasOwn(WRAPPERS, name) ? WRAPPERS[name] : undefined;
		if (!wrapper) return { name, args: words.slice(i + 1), viaXargs };
		if (name === "xargs") viaXargs = true;
		// Look through the wrapper: its options, then what it runs.
		let j = i + 1;
		let positional = wrapper.positional;
		while (j < words.length) {
			const t = words[j].text;
			if (t === "--") {
				j++;
				break;
			}
			if (listed(wrapper.value, t)) j += 2;
			else if (t.startsWith("-") && t.length > 1) j++;
			else if (name === "env" && ASSIGNMENT.test(t)) j++;
			else if (positional > 0) {
				positional--;
				j++;
			} else break;
		}
		i = j;
	}
	return null;
}

/** `args` apart into the options (starting with `-`, before any `--`) and the operands. */
function splitArgs(args: readonly Word[]): { opts: string[]; operands: Word[] } {
	const opts: string[] = [];
	const operands: Word[] = [];
	let ended = false;
	for (const a of args) {
		if (!ended && a.text === "--") ended = true;
		else if (!ended && a.text.startsWith("-") && a.text.length > 1) opts.push(a.text);
		else operands.push(a);
	}
	return { opts, operands };
}

/** One of the letters is among the short options (`-rf` has `r` and `f`). */
const hasShort = (opts: readonly string[], letters: string): boolean =>
	opts.some((o) => /^-[^-]/.test(o) && [...letters].some((l) => o.includes(l)));
const hasLong = (opts: readonly string[], ...names: string[]): boolean =>
	opts.some((o) => names.some((n) => o === n || o.startsWith(`${n}=`)));

/** The values of an option that takes one: `-o FILE`, `-oFILE`, `--output FILE`, `--output=FILE`. */
function optionValues(args: readonly Word[], short: readonly string[], long: readonly string[]): Word[] {
	const out: Word[] = [];
	for (let i = 0; i < args.length; i++) {
		const t = args[i].text;
		if (t === "--") break;
		if (short.includes(t) || long.includes(t)) {
			if (args[i + 1]) out.push(args[i + 1]);
			i++;
			continue;
		}
		const eq = long.find((l) => t.startsWith(`${l}=`));
		const attached = short.find((s) => t.startsWith(s) && t.length > s.length && !t.startsWith("--"));
		if (eq) out.push({ ...args[i], text: t.slice(eq.length + 1) });
		else if (attached) out.push({ ...args[i], text: t.slice(attached.length) });
	}
	return out;
}

/** `args` of `sudo` (or `doas`) without its own options: what is left is the command it runs. */
function afterPrivilegeOptions(args: readonly Word[]): Word[] {
	let i = 0;
	while (i < args.length && args[i].text.startsWith("-") && args[i].text !== "--")
		i += /^-[ughpCTUrtDR]$/.test(args[i].text) ? 2 : 1;
	return args.slice(args[i]?.text === "--" ? i + 1 : i);
}

/** Whether `stage` reads a script from its input and runs it: a shell with no script, an interpreter with no program. */
function readsStdinAsCode(stage: Command): boolean {
	const { name } = stage;
	if (listed(PRIVILEGE, name)) return true;
	const { opts, operands } = splitArgs(stage.args);
	if (listed(SHELLS, name))
		return opts.includes("-s") || (operands.length === 0 && !opts.some((o) => /^-[a-z]*c/.test(o)));
	if (listed(CODE_INTERPRETERS, name)) {
		if (opts.some((o) => /^-(c|e|m|p|pe|ne|r)$/.test(o))) return false;
		return operands.length === 0 || operands[0].text === "-";
	}
	return name === "source" || name === "eval";
}

/** Whether a script runs one of `programs` as a command (`curl` in the `$(curl …)` that a shell is asked to run). */
function mentions(src: string, programs: Table, home: string): boolean {
	return parseScript(src, home).some((p) => p.some((s) => listed(programs, commandOf(s.words)?.name ?? "")));
}

/** `text` apart at the commas that are not inside a string or a bracket. */
function splitTop(text: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let from = 0;
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (c === "\\") {
			i += 2;
			continue;
		}
		if (c === "'" || c === '"' || c === "`") {
			let j = i + 1;
			while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
			i = j + 1;
			continue;
		}
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") depth--;
		else if (c === "," && depth === 0) {
			parts.push(text.slice(from, i));
			from = i + 1;
		}
		i++;
	}
	parts.push(text.slice(from));
	return parts.map((p) => p.trim()).filter((p) => p !== "");
}

const LITERAL = /^([rRbBuUfF]{0,2})(["'`])((?:\\.|(?!\2)[^\\])*)\2$/s;

/** The text of an expression that is one string written out (nothing worked out in it), or null. */
function literalOf(expression: string): string | null {
	const m = LITERAL.exec(expression.trim());
	if (!m) return null;
	if (/[fF]/.test(m[1]) && m[3].includes("{")) return null;
	if (m[2] === "`" && m[3].includes("${")) return null;
	return m[3];
}

/** The text an argument of a call writes out (`'/x'`, `Path('/x')`, `expanduser('~/x')`), or null when it is worked out when the program runs. */
function writtenOut(argument: string): string | null {
	const bare = argument.trim().replace(/^[A-Za-z_]\w*\s*=(?!=)\s*/, "");
	const wrapped = /^(?:Bun\.file|(?:pathlib\.)?Path|os\.path\.expanduser|path\.resolve)\(\s*(.+?)\s*\)$/s.exec(bare);
	return literalOf(wrapped?.[1] ?? bare);
}

/** The absolute path an argument of a call names when it is written out (`'/x'`, `'~/x'`, `Path('/x')`, `expanduser('~/x')`). */
function pathLiteral(argument: string, ctx: RiskContext): string | null {
	const s = writtenOut(argument);
	if (s === null) return null;
	if (s === "~") return normalize(ctx.home);
	if (s.startsWith("~/")) return normalize(`${ctx.home}/${s.slice(2)}`);
	return s.startsWith("/") ? normalize(s) : null;
}

/** A program that makes and removes a temporary folder of its own: what it deletes by a path it works out is likely that. */
const TEMP_USE = /\bmkdtemp(?:Sync)?\b|\btmpdir\s*\(|\bTemporaryDirectory\b|\btempfile\.|\bos\.tmpdir\b/;

/**
 * Whether a program starts another from a command it only works out when it runs (`execSync(cmd)`, `os.system(cmd)`,
 * `subprocess.run(args)`): what that is cannot be read here, and it may be anything the shell can do.
 */
function startsUnseenProgram(code: string): boolean {
	if (SHELL_TEMPLATE.test(code)) return true;
	const patterns = /child_process/.test(code) ? [SHELL_CALL, SHELL_CALL_BARE] : [SHELL_CALL];
	for (const pattern of patterns) {
		for (const m of code.matchAll(pattern)) {
			const at = m.index + m[0].length;
			const first = splitTop(readBalanced(code.slice(at, at + 4000), 0, "(", ")").text)[0];
			if (first === undefined) continue;
			const bare = first.trim().replace(/^[A-Za-z_]\w*\s*=(?!=)\s*/, "");
			// Written out, or begun with a string that is (read as shell by the caller), or a list that begins with a program.
			if (/^[rRbBuUfF]{0,2}["'`]/.test(bare)) continue;
			if (bare.startsWith("[")) {
				const head = splitTop(readBalanced(bare, 1, "[", "]").text)[0];
				if (head !== undefined && literalOf(head) !== null) continue;
			}
			return true;
		}
	}
	return false;
}

/** What a program that deletes or writes `abs` is: protected, or `kind` when it is outside the project (null: neither). */
function judgePath(abs: string | null, kind: RiskKind, ctx: RiskContext): RiskKind | null {
	if (abs === null) return null;
	if (isProtected(abs, ctx)) return "protected";
	return inProject(abs, ctx) || inTemp(abs, ctx) ? null : kind;
}

/** The programs that a source starts from lists of arguments, each as the shell line it stands for (what is not written out is `$X`). */
function argvLists(code: string): string[] {
	const lines: string[] = [];
	for (const m of code.matchAll(ARGV_CALL)) {
		// Only the start of what follows is read: a call is not followed to its end in a source of any size.
		const at = m.index + m[0].length;
		const list = readBalanced(code.slice(at, at + 4000), 0, "[", "]");
		const words = splitTop(list.text).map((e) => {
			const s = literalOf(e);
			return s === null ? '"$X"' : `'${s.replace(/'/g, `'\\''`)}'`;
		});
		if (m[2] !== undefined) words.unshift(`'${m[2].replace(/'/g, `'\\''`)}'`);
		// `["rm", "-rf"] + paths`: more follows that is not known.
		if (/^\s*\+/.test(code.slice(at + list.end, at + list.end + 16))) words.push('"$X"');
		lines.push(words.join(" "));
	}
	return lines;
}

/** What is put into a string that is not known (`f"rm -rf {path}"`, `` `rm -rf ${path}` ``), which a shell word says as `$X`. */
const UNKNOWN_PART = /\$\{(?!HOME\})[^{}\n]*\}|(?<![$\w{])\{[A-Za-z_][^{},\n"']*\}/g;

/**
 * What a program's source says that matters without running it: a protected place named in it, a recursive delete or a
 * write of a path outside the project in a call that does that, and (when it works with the home folder) any delete or
 * write at all, since the path may be built from it. (A string in it that is a shell command, and each program it starts
 * from a list of arguments, is looked at as one, by `Scan.code`.)
 */
function codeKinds(code: string, ctx: RiskContext): RiskKind[] {
	const kinds: RiskKind[] = [];
	const protectedNames = [
		...Object.keys(PROTECTED_SEGMENTS).map((s) => `${s}/`),
		...ctx.protect.filter((d) => d !== ""),
	];
	if (
		protectedNames.some((n) => code.includes(n)) ||
		LAUNCH_DIR.test(code) ||
		/(^|[^\w.])\.(ssh|gnupg|aws|omp)\b/.test(code)
	)
		kinds.push("protected");
	const found = (abs: string | null, kind: RiskKind): void => {
		const k = judgePath(abs, kind, ctx);
		if (k !== null) kinds.push(k);
	};
	let deletes = false;
	let writes = false;
	for (const m of code.matchAll(CODE_CALL)) {
		const name = m[1];
		const at = m.index + m[0].length;
		const args = splitTop(readBalanced(code.slice(at, at + 4000), 0, "(", ")").text);
		const first = args.length > 0 ? pathLiteral(args[0], ctx) : null;
		if (listed(CODE_DELETE, name)) {
			found(first, "delete_outside");
			// A whole tree removed by a path the program works out (`rmSync(dir, { recursive: true })`, `shutil.rmtree(p)`): it may be anything.
			// (A program that makes a temporary folder of its own, and has no use for the home folder, is taken to remove that.)
			const tree = listed(CODE_DELETE_TREE, name) || args.slice(1).some((a) => /\brecursive\b/.test(a));
			// A whole tree of something too broad (the home folder, a folder directly in it) is a mass delete.
			if (tree && first !== null && !isProtected(first, ctx) && isBroad(first, ctx)) kinds.push("mass_delete");
			if (tree && args.length > 0 && writtenOut(args[0]) === null && (!TEMP_USE.test(code) || HOME_USE.test(code)))
				kinds.push("delete_outside", "mass_delete");
			// A bare `remove(` is as likely a list's: only `os.remove` and the like count for the home folder.
			if (name !== "remove" || /\b(?:os|fs|fse|Deno)\.$/.test(code.slice(Math.max(0, m.index - 5), m.index)))
				deletes = true;
		} else if (listed(CODE_WRITE, name)) {
			// Python's `open` writes only in a mode that says so.
			const mode = args.slice(1).some((a) => /^(?:mode\s*=\s*)?[rRbBuUfF]*["'`][^"'`]*[wax+]/.test(a));
			if ((name === "open" || name === "openSync") && !mode) continue;
			found(first, "write_outside");
			writes = true;
		} else if (args.length >= 2) {
			// A copy or a move puts something at its second argument; a move takes it from the first.
			found(pathLiteral(args[1], ctx), "write_outside");
			writes = true;
			if (listed(CODE_MOVE, name)) {
				found(first, "delete_outside");
				deletes = true;
			}
		}
	}
	for (const m of code.matchAll(PATH_CHAIN))
		found(pathLiteral(m[1], ctx), /^(unlink|rmdir|rmtree|delete)$/.test(m[3]) ? "delete_outside" : "write_outside");
	if (HOME_USE.test(code)) {
		if (deletes) kinds.push("delete_outside");
		if (writes) kinds.push("write_outside");
	}
	if (startsUnseenProgram(code)) kinds.push("shell_out");
	return kinds;
}

/** Whether the glob `pattern` (`*`, `?`, `[…]`; a part only known when the command runs matches anything) matches `name`. */
function globMatches(pattern: string, name: string): boolean {
	const source = [...pattern]
		.map((c) => (c === "*" || c === DYN ? ".*" : c === "?" ? "." : /[.+^${}()|\\]/.test(c) ? `\\${c}` : c))
		.join("");
	try {
		return new RegExp(`^${source}$`).test(name);
	} catch {
		return false;
	}
}

/** Whether `w` names more than one place: a glob in its last part, or a part only known when the command runs. */
const globby = (w: Word): boolean => /[*?[\uE000]/.test(w.text.slice(w.text.lastIndexOf("/") + 1));

/** A command that writes nothing: what a redirect after it only empties. */
function emptyCommand(cmd: Command): boolean {
	if (cmd.name === ":" || cmd.name === "true") return true;
	const files = cmd.args.filter((a) => !a.text.startsWith("-"));
	return cmd.name === "cat" && files.length > 0 && files.every((a) => a.text === "/dev/null");
}

/** The names the app keeps its private state under, which no read may see: the sign-in token, the guard's settings and log, a process's word to its gate. */
const PRIVATE_NAME = /^(?:token|guard\.json(?:\.tmp)?|decisions\.jsonl(?:\.1)?|.+\.risk(?:\.loaded|\.tmp)?)$/;
/** One name of each kind, for a glob to be matched against. */
const PRIVATE_SAMPLES = ["token", "guard.json", "decisions.jsonl", "L1-abc.yml.risk"];

/**
 * A word that names the app's private state: the sign-in token, the guard's settings (`guard.json`), its log of decisions
 * (`guard/decisions.jsonl`) or a process's word to its gate (`<overlay>.risk`), in one of the protected folders, or a glob
 * that matches one of them. Reading them is as telling as the token: what the guard's settings say is where a call can be
 * sent that the guard lets through.
 */
function namesPrivateFile(w: Word, cwd: string | null, ctx: RiskContext): boolean {
	const dirs = ctx.protect.filter((d) => d !== "");
	if (dirs.length === 0) return false;
	// `--file=/…/token`: the value is what is named.
	const text = w.text.startsWith("-") && w.text.includes("=") ? w.text.slice(w.text.indexOf("=") + 1) : w.text;
	const last = text.slice(text.lastIndexOf("/") + 1);
	const abs = resolveWord({ ...w, text }, cwd);
	if (abs === null) return false;
	if (/[*?[\uE000]/.test(last))
		return PRIVATE_SAMPLES.some((n) => globMatches(last, n)) && dirs.some((d) => within(abs, d));
	return PRIVATE_NAME.test(last) && !/[*?[{\uE000]/.test(text) && dirs.some((d) => within(abs, d));
}

/** The whole working tree as a git path: `.`, `./`, `:/`, `*`. */
const wholeTree = (w: Word): boolean => /^(?:\.\/?|:\/\.?|\*)$/.test(w.text);

/** What is found while a script is read. */
class Scan {
	readonly kinds = new Set<RiskKind>();
	constructor(readonly ctx: RiskContext) {}

	/** What each `for` loop of the script goes over, by its variable (`for f in ~/x/*; do …; done`): `"$f"` is one of those. */
	private readonly loops = new Map<string, Word[]>();

	/** What `w` names: the words the loop goes over when it is a loop's variable, else itself. */
	private named(w: Word): Word[] {
		if (w.text !== DYN || w.named === undefined) return [w];
		return this.loops.get(w.named) ?? [w];
	}

	add(kind: RiskKind): void {
		this.kinds.add(kind);
	}

	/** A command writes (creates, changes) the place `w` points to: outside the project, or protected. */
	write(w: Word, cwd: string | null): void {
		for (const each of this.named(w)) {
			const abs = resolveWord(each, cwd);
			if (abs === null) continue;
			if (isProtected(abs, this.ctx)) this.add("protected");
			else if (!inProject(abs, this.ctx) && !inTemp(abs, this.ctx)) this.add("write_outside");
		}
	}

	/**
	 * A command deletes the place `w` points to: protected, outside the project, or (when deleting everything under it) the
	 * project itself or something too broad. Where it is not known, a deletion that is recursive or forced asks. A deletion
	 * of something broad (the root, the home folder, a folder directly in either), of a glob or of a place that is not known
	 * is also `mass_delete`, and so is anything outside the project that `many` says goes through everything it finds
	 * (`find -delete`, `rsync --delete`).
	 */
	delete(w: Word, cwd: string | null, strong: boolean, recursive: boolean, many = false): void {
		const each = this.named(w);
		// A loop's variable is no less unknown for the loop's list: a forced or recursive delete of it asks, as it always did.
		if (strong && (each.length !== 1 || each[0] !== w)) this.add("delete_outside");
		for (const one of each) {
			const abs = resolveWord(one, cwd);
			if (abs === null) {
				if (strong) {
					this.add("delete_outside");
					this.add("mass_delete");
				}
			} else if (isProtected(abs, this.ctx)) this.add("protected");
			else if (recursive && (this.ctx.roots.includes(abs) || isBroad(abs, this.ctx))) {
				this.add("delete_outside");
				this.add("mass_delete");
			} else if (!inProject(abs, this.ctx) && !inTemp(abs, this.ctx)) {
				this.add("delete_outside");
				if (many || globby(one)) this.add("mass_delete");
			}
		}
	}

	/**
	 * A command empties or replaces the place `w` points to (`truncate`, `: >`, `cp /dev/null`, `dd if=/dev/zero`): a write,
	 * and outside the project a delete of what was there, which over a glob or a loop's variable is a mass one.
	 */
	overwrite(w: Word, cwd: string | null): void {
		this.write(w, cwd);
		const each = this.named(w);
		const several = each.length !== 1 || each[0] !== w;
		for (const one of each) {
			const abs = resolveWord(one, cwd);
			if (abs === null || isProtected(abs, this.ctx) || inProject(abs, this.ctx) || inTemp(abs, this.ctx)) continue;
			this.add("delete_outside");
			if (several || globby(one)) this.add("mass_delete");
		}
	}

	/** Look into a script: each command in it, each leaving the folder the next runs in. */
	script(src: string, cwd: string | null, depth: number): void {
		if (depth > MAX_DEPTH) {
			this.add("unreadable");
			return;
		}
		if (selfAccess(src, this.ctx)) this.add("protected");
		let here = cwd;
		for (const pipeline of parseScript(src, this.ctx.home)) {
			const named = pipeline.map((s) => commandOf(s.words));
			named.forEach((cmd, n) => {
				if (cmd && listed(FETCHERS, cmd.name) && named.slice(n + 1).some((c) => c && readsStdinAsCode(c)))
					this.add("remote_exec");
			});
			for (const simple of pipeline) here = this.simple(simple, here, depth);
		}
	}

	/** One command; the answer is the folder the next one runs in. */
	private simple(simple: Simple, cwd: string | null, depth: number): string | null {
		// A redirect with nothing to write (`: > f`, `> f`, `true > f`, `cat /dev/null > f`) empties its target.
		const cmd = commandOf(simple.words);
		const empties = cmd === null ? simple.words.length === 0 : emptyCommand(cmd);
		for (const r of simple.redirects) {
			if (namesPrivateFile(r.target, cwd, this.ctx)) this.add("protected");
			// `< ~/.ssh/id_ed25519`: the command reads the secret from its input.
			if (/^(<|<>)$/.test(r.op) && this.touchesSecret(r.target, cwd)) this.add("secret_read");
			if (empties && /^(>|>\||&>)$/.test(r.op)) this.overwrite(r.target, cwd);
			else if (/^(>|>>|>\||&>|&>>|<>)$/.test(r.op)) this.write(r.target, cwd);
			for (const sub of r.target.subs) this.script(sub, cwd, depth + 1);
		}
		for (const w of simple.words) {
			if (namesPrivateFile(w, cwd, this.ctx)) this.add("protected");
			for (const sub of w.subs) this.script(sub, cwd, depth + 1);
		}
		return cmd ? this.command(cmd, simple.body, cwd, depth) : cwd;
	}

	private command(cmd: Command, body: string | null, cwd: string | null, depth: number): string | null {
		const { name, args } = cmd;
		const { opts, operands } = splitArgs(args);
		// `for f in a b c`: the variable stands for those words in the commands that follow.
		if (name === "for" && args.length >= 2 && args[1].text === "in") this.loops.set(args[0].text, args.slice(2));

		if (name === "cd" || name === "pushd") {
			const target = operands[0];
			if (!target) return name === "cd" ? this.ctx.home : cwd;
			return target.text === "-" ? null : resolveWord(target, cwd);
		}
		if (listed(PRIVILEGE, name)) {
			this.add("privilege");
			// What it runs with those rights is looked at too (`sudo rm -rf /x` also deletes outside the project).
			const inner = name === "su" ? null : commandOf(afterPrivilegeOptions(args));
			if (inner) this.command(inner, body, cwd, depth + 1);
		}
		if (name === "osascript") {
			this.add("osascript");
			// `tell application "Finder" to empty the trash`: everything in it, for good.
			if (args.some((a) => /empty\s+(?:the\s+)?trash/i.test(a.text))) this.add("mass_delete");
		}
		if (name === "launchctl") this.add("launchctl");
		if (listed(TUNNELS, name)) this.add("tunnel");
		if (name === "tailscale" && operands.some((o) => o.text === "serve" || o.text === "funnel")) this.add("tunnel");
		if ((name === "ssh" || name === "autossh") && args.some((a) => /^-[A-Za-z]*[RD]$|^-[RD][^A-Za-z]/.test(a.text)))
			this.add("tunnel");
		if (listed(SYSTEM_PROGRAMS, name) || name.startsWith("mkfs")) this.add("system");
		if (name === "diskutil" && /^(erase|partition|zero|secure|reformat|apfs)/i.test(operands[0]?.text ?? ""))
			this.add("system");
		this.install(name, operands, opts);
		if (name === "omp") {
			const group = operands[0]?.text ?? "";
			if (Object.hasOwn(OMP_CHANGES, group) && listed(OMP_CHANGES[group], operands[1]?.text ?? ""))
				this.add("protected");
		}
		const verb = operands[0]?.text ?? "";
		if (listed(RUNNERS, name)) this.runner(args, cwd, depth);
		else if (listed(RUNNER_MANAGERS, name) && listed(RUNNER_VERBS, verb))
			this.runner(args.slice(args.findIndex((a) => a.text === verb) + 1), cwd, depth);
		// What comes through `xargs` is not known: a delete there is a delete of a place that is not known.
		if (cmd.viaXargs && (listed(DELETERS, name) || name === "rimraf" || name === "del-cli")) {
			this.add("delete_outside");
			this.add("mass_delete");
		}

		const runs = listed(SHELLS, name) || name === "eval" || name === "source" || name === ".";
		if (runs && args.some((a) => a.subs.some((s) => mentions(s, FETCHERS, this.ctx.home)))) this.add("remote_exec");
		if (listed(SHELLS, name)) {
			// A shell that is handed a script (`-c`), or reads one from its input (a here-document).
			const at = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a.text));
			const script = at >= 0 ? args.slice(at + 1).find((a) => !a.text.startsWith("-")) : undefined;
			if (script) this.script(script.text, cwd, depth + 1);
			else if (body !== null) this.script(body, cwd, depth + 1);
		} else if (name === "eval") {
			this.script(args.map((a) => a.text).join(" "), cwd, depth + 1);
		} else if (listed(CODE_INTERPRETERS, name)) {
			const at = args.findIndex((a) => /^-(c|e|p|pe|ne|ep|r)$|^--eval$/.test(a.text));
			const code = at >= 0 ? args[at + 1]?.text : body;
			if (code) this.code(code, cwd, depth + 1);
		}

		switch (name) {
			case "git":
				this.git(args, cwd);
				break;
			case "rm":
			case "unlink":
			case "rmdir":
			case "shred":
			case "srm": {
				const recursive = hasShort(opts, "rR") || hasLong(opts, "--recursive");
				const strong = recursive || hasShort(opts, "f") || hasLong(opts, "--force");
				for (const t of operands) this.delete(t, cwd, strong, recursive);
				break;
			}
			case "rimraf":
			case "del-cli":
				// Recursive and forced by nature.
				for (const t of operands) this.delete(t, cwd, true, true);
				break;
			case "find":
				this.find(args, cwd, depth);
				break;
			case "chmod":
			case "chown":
			case "chgrp":
				this.permissions(name, opts, operands, cwd);
				break;
			case "tee":
			case "touch":
			case "mkdir":
			case "mkfifo":
				for (const t of operands) this.write(t, cwd);
				break;
			case "truncate":
				// It can empty the file: outside the project that destroys what was there.
				for (const t of operands) this.overwrite(t, cwd);
				break;
			case "cp":
			case "mv":
			case "ln":
			case "install":
			case "ditto":
				this.copy(name, opts, args, operands, cwd);
				break;
			case "rsync": {
				// A destination or a source of the form `host:path` is another computer's, not a file here.
				const remote = (w: Word): boolean => /^[^/.~][^/]*:/.test(w.text);
				const dest = operands.length >= 2 ? operands[operands.length - 1] : undefined;
				if (dest && !remote(dest)) {
					this.write(dest, cwd);
					// `--delete` removes what the destination holds and the source does not: a recursive delete of the destination.
					if (opts.some((o) => /^--(?:delete(?:-[a-z-]+)?|del)$/.test(o))) this.delete(dest, cwd, true, true, true);
				}
				// `--remove-source-files` removes what it copied.
				if (opts.includes("--remove-source-files"))
					for (const src of operands.slice(0, -1)) if (!remote(src)) this.delete(src, cwd, true, true, true);
				break;
			}
			case "dd":
				for (const a of args) {
					if (!a.text.startsWith("of=")) continue;
					let target = a.text.slice(3);
					// The shell writes `~` out after the `=` too.
					if (target === "~" || target.startsWith("~/")) target = `${this.ctx.home}${target.slice(1)}`;
					const of = { ...a, text: target };
					if (of.text.startsWith("/dev/") && !isSafeDevice(of.text)) this.add("system");
					else if (args.some((x) => /^if=\/dev\/(?:zero|null|u?random)$/.test(x.text))) this.overwrite(of, cwd);
					else this.write(of, cwd);
				}
				break;
			case "sed":
			case "perl": {
				const inPlace =
					name === "sed"
						? hasShort(opts, "i") || hasLong(opts, "--in-place")
						: opts.some((o) => /^-[A-Za-z]*i/.test(o));
				if (!inPlace) break;
				// The first operand is the script unless an option gave it.
				const scripted = opts.some((o) => /^(-[A-Za-z]*[ef]|--expression|--file)/.test(o));
				for (const t of scripted ? operands : operands.slice(1)) this.write(t, cwd);
				break;
			}
			case "curl":
				for (const v of optionValues(args, ["-o"], ["--output", "--output-dir"]))
					if (v.text !== "-") this.write(v, cwd);
				break;
			case "wget":
				for (const v of optionValues(args, ["-O", "-P"], ["--output-document", "--directory-prefix"]))
					if (v.text !== "-") this.write(v, cwd);
				break;
			case "unzip":
				for (const v of optionValues(args, ["-d"], [])) this.write(v, cwd);
				break;
			case "tar":
				this.tar(args, opts, operands, cwd);
				break;
			default:
		}

		// A command that is given a protected place is stopped unless it only reads.
		if (!listed(READING_PROGRAMS, name) && args.some((a) => this.touchesProtected(a, cwd))) this.add("protected");
		// Reading a credential is asked about too, by any program that looks into the file (`cat`, `grep`, `cp`, `base64`).
		if (!listed(METADATA_PROGRAMS, name) && args.some((a) => this.touchesSecret(a, cwd))) this.add("secret_read");
		return cwd;
	}

	/** A word that names a protected place: as a path, or as the value of an option (`--file=/…/.ssh/x`). */
	private touchesProtected(w: Word, cwd: string | null): boolean {
		if (w.text.startsWith("-") && !w.text.includes("=")) return false;
		if (w.text.split(/[/=:,]/).some((p) => listed(PROTECTED_SEGMENTS, p))) return true;
		if (this.ctx.protect.some((d) => d !== "" && w.text.includes(d))) return true;
		const abs = w.text.startsWith("-") ? null : resolveWord(w, cwd);
		return abs !== null && isProtected(abs, this.ctx);
	}

	/** A word that names a credential (`isSecret`): as a path, the value of an option (`--key=…`), or curl's `@file`. */
	private touchesSecret(w: Word, cwd: string | null): boolean {
		let text = w.text;
		if (text.startsWith("-")) {
			const eq = text.indexOf("=");
			if (eq < 0) return false;
			text = text.slice(eq + 1);
		}
		for (const part of text.split(/[=,]/)) {
			const path = part.replace(/^@/, "");
			if (path === "") continue;
			const abs = resolveWord({ ...w, text: path }, cwd);
			if (abs !== null && isSecret(abs, this.ctx.home)) return true;
		}
		return false;
	}

	private permissions(name: string, opts: string[], operands: Word[], cwd: string | null): void {
		const recursive = hasShort(opts, "R") || hasLong(opts, "--recursive");
		// The mode (or the owner) is the first operand, unless `--reference` took its place.
		const first = operands[0]?.text ?? "";
		const given =
			name === "chmod" ? /^([0-7]{3,4}|[ugoa]*[-+=][rwxXst,ugo+=-]*)$/.test(first) : !hasLong(opts, "--reference");
		for (const t of given ? operands.slice(1) : operands) {
			const abs = resolveWord(t, cwd);
			if (abs !== null && isProtected(abs, this.ctx)) this.add("protected");
			else if (recursive && (abs === null || isBroad(abs, this.ctx) || !inProject(abs, this.ctx)))
				this.add("permissions");
		}
	}

	private copy(name: string, opts: string[], args: Word[], operands: Word[], cwd: string | null): void {
		if (name === "install" && hasShort(opts, "d")) {
			for (const o of operands) this.write(o, cwd);
			return;
		}
		const target = optionValues(args, ["-t"], ["--target-directory"]);
		if (target.length > 0) {
			this.write(target[0], cwd);
			return;
		}
		if (operands.length < 2) return;
		const dest = operands[operands.length - 1];
		const sources = operands.slice(0, -1);
		// `cp /dev/null file` empties the file, as `truncate` does.
		if (name !== "mv" && sources.some((s) => s.text === "/dev/null" || s.text === "/dev/zero"))
			this.overwrite(dest, cwd);
		else this.write(dest, cwd);
		if (name === "mv") {
			// A move takes what it moves out of where it was; to a device that discards what it is given (`mv ~/x /dev/null`), it is a delete.
			const target = resolveWord(dest, cwd);
			const discards = target !== null && isSafeDevice(target);
			for (const s of sources) this.delete(s, cwd, discards, discards, discards);
		}
	}

	private tar(args: Word[], opts: string[], operands: Word[], cwd: string | null): void {
		// `tar xzf a.tgz` (the first operand holds the options) and `tar -xzf a.tgz`.
		const old = operands[0] && /^[cxtuAdrf][A-Za-z0-9]*$/.test(operands[0].text) ? operands[0].text : "";
		const cluster = old || opts.filter((o) => /^-[^-]/.test(o)).join("");
		for (const d of optionValues(args, ["-C"], ["--directory"])) this.write(d, cwd);
		if (!cluster.includes("c") && !hasLong(opts, "--create")) return;
		const files = optionValues(args, ["-f"], ["--file"]);
		const archive = files[0] ?? (cluster.includes("f") ? (old ? operands[1] : operands[0]) : undefined);
		if (archive && archive.text !== "-") this.write(archive, cwd);
	}

	private git(args: Word[], cwd: string | null): void {
		const takesValue = table("-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env");
		let i = 0;
		// Where git works: the folder it was started in, or the one `-C` names (null: not known).
		let dir: string | null = cwd;
		while (i < args.length && args[i].text.startsWith("-")) {
			if (args[i].text === "-C" && args[i + 1]) dir = resolveWord(args[i + 1], dir);
			i += listed(takesValue, args[i].text) ? 2 : 1;
		}
		const rest = args.slice(i + 1);
		const { opts, operands } = splitArgs(rest);
		switch (args[i]?.text) {
			case "push": {
				const force =
					hasShort(opts, "fd") ||
					hasLong(opts, "--force", "--force-with-lease", "--force-if-includes", "--mirror", "--delete", "--prune");
				// `+main` forces a ref, `:main` deletes it on the remote.
				const refspec = operands.some((o) => o.text.startsWith("+") || o.text.startsWith(":"));
				if (force || refspec) this.add("force_push");
				break;
			}
			case "reset":
				if (hasLong(opts, "--hard")) this.add("discard");
				break;
			case "clean":
				if (hasShort(opts, "f") || hasLong(opts, "--force")) {
					this.add("discard");
					// It removes every file git does not track, wherever the folder is: outside the project that is a delete, and in a
					// folder as broad as the home folder or a top-level one, a mass one.
					if (dir === null || (!inProject(dir, this.ctx) && !inTemp(dir, this.ctx))) {
						this.add("delete_outside");
						if (dir !== null && isBroad(dir, this.ctx)) this.add("mass_delete");
					}
				}
				break;
			case "filter-branch":
			case "filter-repo":
				this.add("discard");
				break;
			case "reflog":
				if (operands[0]?.text === "expire" || operands[0]?.text === "delete") this.add("discard");
				break;
			case "gc":
				if (rest.some((a) => a.text === "--prune=now")) this.add("discard");
				break;
			case "clone":
				if (operands.length >= 2) this.write(operands[operands.length - 1], cwd);
				break;
			case "worktree":
				if (operands[0]?.text === "add" && operands[1]) this.write(operands[1], cwd);
				break;
			case "checkout":
			case "switch":
				// `-f` throws away what is changed; so does naming the whole tree (`checkout -- .`, `checkout .`).
				if (hasShort(opts, "f") || hasLong(opts, "--force", "--discard-changes") || operands.some(wholeTree))
					this.add("discard");
				break;
			case "restore": {
				const worktree = hasLong(opts, "--worktree") || hasShort(opts, "W");
				const stagedOnly = (hasLong(opts, "--staged") || hasShort(opts, "S")) && !worktree;
				if (worktree || (!stagedOnly && operands.some(wholeTree))) this.add("discard");
				break;
			}
			case "stash":
				if (operands[0]?.text === "clear" || operands[0]?.text === "drop") this.add("discard");
				break;
			case "branch":
				if (
					hasShort(opts, "D") ||
					((hasShort(opts, "d") || hasLong(opts, "--delete")) && (hasShort(opts, "f") || hasLong(opts, "--force")))
				)
					this.add("discard");
				break;
			case "config":
				this.gitConfig(rest, opts, operands, cwd);
				break;
			default:
		}
	}

	/** `git config` that writes: the global or system file (the home folder's `.gitconfig`) or a file outside the project. */
	private gitConfig(args: Word[], opts: string[], operands: Word[], cwd: string | null): void {
		const reads =
			hasLong(
				opts,
				"--get",
				"--get-all",
				"--get-regexp",
				"--get-urlmatch",
				"--list",
				"--name-only",
				"--show-origin",
				"--show-scope",
			) || hasShort(opts, "l");
		// `git config user.name` reads, `git config user.name x` writes.
		const writes =
			hasLong(
				opts,
				"--unset",
				"--unset-all",
				"--add",
				"--replace-all",
				"--edit",
				"--rename-section",
				"--remove-section",
			) ||
			hasShort(opts, "e") ||
			operands.length >= 2;
		if (reads || !writes) return;
		if (hasLong(opts, "--global", "--system")) this.add("protected");
		for (const f of optionValues(args, ["-f"], ["--file"])) this.write(f, cwd);
	}

	/** `npx …`, `npm exec …`: the program it fetches and runs is looked at as a command. */
	private runner(args: Word[], cwd: string | null, depth: number): void {
		let i = 0;
		for (; i < args.length; i++) {
			const t = args[i].text;
			if (t === "--") {
				i++;
				break;
			}
			if (t === "-c" || t === "--call") {
				const script = args[i + 1];
				if (script) this.script(script.text, cwd, depth + 1);
				return;
			}
			if (listed(RUNNER_VALUES, t)) i++;
			else if (!t.startsWith("-")) break;
		}
		const inner = commandOf(args.slice(i));
		if (inner) this.command(inner, null, cwd, depth + 1);
	}

	private find(args: Word[], cwd: string | null, depth: number): void {
		const end = args.findIndex((a) => a.text.startsWith("-") || a.text === "(" || a.text === "!");
		const roots = end < 0 ? args : args.slice(0, end);
		const expression = end < 0 ? [] : args.slice(end);
		// What the search finds under its roots is deleted, not the roots themselves: only a root that is too broad matters.
		const sweep = (recursive: boolean): void => {
			for (const r of roots) {
				const abs = resolveWord(r, cwd);
				this.delete(r, cwd, true, recursive && !(abs !== null && this.ctx.roots.includes(abs)), true);
			}
		};
		if (expression.some((a) => a.text === "-delete")) sweep(true);
		const exec = expression.findIndex(
			(a) => a.text === "-exec" || a.text === "-execdir" || a.text === "-ok" || a.text === "-okdir",
		);
		if (exec < 0) return;
		let stop = expression.findIndex((a, n) => n > exec && (a.text === ";" || a.text === "+"));
		if (stop < 0) stop = expression.length;
		const inner = commandOf(expression.slice(exec + 1, stop));
		if (!inner) return;
		if (listed(DELETERS, inner.name)) {
			// `find / -exec rm -rf {} +`: what is deleted is what the search finds under its roots.
			sweep(hasShort(splitArgs(inner.args).opts, "rR"));
			return;
		}
		this.command(inner, null, cwd, depth + 1);
	}

	private install(name: string, operands: Word[], opts: string[]): void {
		const verb = operands[0]?.text ?? "";
		if (name === "brew" && /^(install|reinstall|uninstall|remove|upgrade|tap|untap|link|unlink|cleanup)$/.test(verb))
			this.add("global_install");
		const global = hasLong(opts, "--global") || opts.includes("-g") || verb === "global";
		if (
			(name === "npm" || name === "pnpm" || name === "yarn" || name === "bun") &&
			global &&
			/^(install|i|add|remove|uninstall|rm|update|up|upgrade|link|unlink|global)$/.test(verb)
		)
			this.add("global_install");
		if ((name === "cargo" || name === "pipx") && verb === "install") this.add("global_install");
	}

	/** Code handed to an interpreter (`python -c`, an `eval` cell): read line by line and string by string, as shell. */
	code(code: string, cwd: string | null, depth: number): void {
		if (code.length > MAX_CODE) {
			this.add("unreadable");
			return;
		}
		if (selfAccess(code, this.ctx)) this.add("protected");
		for (const line of code.split("\n")) if (line.trim() !== "") this.script(line, cwd, depth);
		const strings = [
			...[...code.matchAll(/(["'])((?:\\.|(?!\1).){3,2000}?)\1/g)].map((m) => m[2]),
			...[...code.matchAll(/`((?:\\.|[^`\\]){3,2000}?)`/g)].map((m) => m[1]),
		];
		for (const s of strings) if (/\s/.test(s)) this.script(s.replace(UNKNOWN_PART, "$X"), cwd, depth);
		// A credential named in the code (`"~/.ssh/id_ed25519"`, `Path.home() / ".ssh"`, `join(homedir(), ".aws", …)`): the
		// code may read it. A name relative to nothing is read as the home folder's, where these places are.
		const home = normalize(this.ctx.home);
		for (const s of strings) {
			if (/\s/.test(s)) continue;
			const path = s === "~" ? home : s.startsWith("~/") ? `${home}${s.slice(1)}` : s;
			if (isSecret(normalize(path.startsWith("/") ? path : `${home}/${path}`), home)) {
				this.add("secret_read");
				break;
			}
		}
		for (const argv of argvLists(code)) this.script(argv, cwd, depth);
		for (const kind of codeKinds(code, this.ctx)) this.add(kind);
	}
}

// ---------------------------------------------------------------------------------------------------- tool calls

/** The most serious first. */
const ORDER: readonly RiskKind[] = [
	"privilege",
	"remote_exec",
	"shell_out",
	"mass_delete",
	"delete_outside",
	"force_push",
	"discard",
	"protected",
	"secret_read",
	"write_outside",
	"permissions",
	"launchctl",
	"osascript",
	"tunnel",
	"global_install",
	"system",
	"remote_tool",
	"unreadable",
];

const ordered = (found: ReadonlySet<RiskKind>): RiskKind[] => ORDER.filter((k) => found.has(k));

/** The high-risk things `command` does, most serious first (empty: none that are known). `cwd`: where it starts. */
export function classifyShell(
	command: string,
	ctx: RiskContext,
	cwd: string | null = ctx.roots[0] ?? null,
): RiskKind[] {
	const scan = new Scan(ctx);
	scan.script(command, cwd, 0);
	return ordered(scan.kinds);
}

/** The high-risk things in the source of a program that a tool runs (an `eval` cell), most serious first. */
export function classifyCode(code: string, ctx: RiskContext): RiskKind[] {
	const scan = new Scan(ctx);
	scan.code(code, ctx.roots[0] ?? null, 0);
	return ordered(scan.kinds);
}

const isString = (v: unknown): v is string => typeof v === "string";

function safeJson(v: unknown): string {
	try {
		return JSON.stringify(v) ?? String(v);
	} catch {
		return String(v);
	}
}

/**
 * What a tool's path argument says as a file path: a `[PATH#TAG]` wrapper, `file://`, a `:member` selector and `~`
 * written out (null: it is not a file, an internal address like `local://` or `proc://`).
 */
function pathText(raw: string, ctx: RiskContext): string | null {
	let s = raw.trim();
	const wrapped = /^\[(.+?)(#[0-9A-Fa-f]{4})?\]$/.exec(s);
	if (wrapped) s = wrapped[1];
	const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
	if (scheme) {
		if (scheme[1].toLowerCase() !== "file") return null;
		s = decodeURIComponent(s.slice(scheme[0].length - 1));
	}
	// `archive.zip:member`, `data.db:table:key`: the file is what comes before.
	const colon = s.indexOf(":");
	if (colon > 0) s = s.slice(0, colon);
	if (s === "~") s = ctx.home;
	else if (s.startsWith("~/")) s = `${ctx.home}${s.slice(1)}`;
	return s;
}

/** The file a path points to, or null for something that is not a file (an internal address: `local://`, `proc://`). */
function filePathOf(raw: string, ctx: RiskContext, cwd: string | null): string | null {
	const s = pathText(raw, ctx);
	return s === null ? null : resolveWord({ text: s, dynamic: false, subs: [] }, cwd);
}

/** A file tool writes `raw`: protected, or outside the project. */
function classifyPath(raw: string, ctx: RiskContext, cwd: string | null, found: Set<RiskKind>): void {
	const abs = filePathOf(raw, ctx, cwd);
	if (abs === null) return;
	if (isProtected(abs, ctx)) found.add("protected");
	else if (!inProject(abs, ctx) && !inTemp(abs, ctx)) found.add("write_outside");
}

/**
 * The files an `edit` call changes: its `path` (and each entry's of `edits`), the `[PATH#TAG]` sections of a patch, `MV`
 * targets, `*** Update File:` lines, and the `*** Edit File:` lines of the sloppy mode.
 */
function editPaths(input: Record<string, unknown>): string[] {
	const paths: string[] = [];
	for (const entry of [input, ...(Array.isArray(input.edits) ? input.edits : [])]) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		for (const key of ["path", "file", "file_path", "filePath"]) {
			const value = record[key];
			if (isString(value)) paths.push(value);
		}
	}
	const patch = isString(input.input) ? input.input : isString(input.patch) ? input.patch : "";
	for (const line of patch.split("\n")) {
		const found =
			/^\[(.+?)(?:#[0-9A-Fa-f]{4})?\]\s*$/.exec(line)?.[1] ??
			/^MV\s+(.+?)\s*$/.exec(line)?.[1] ??
			/^[ \t]*\*{3}[ \t]*(?:Add|Update|Delete|Edit|Create)[ \t]+File:[ \t]*(.+?)\s*$/i.exec(line)?.[1] ??
			/^[ \t]*\*{3}[ \t]*Move[ \t]+to:[ \t]*(.+?)\s*$/i.exec(line)?.[1] ??
			/^\+\+\+ (?:b\/)?(\S+)/.exec(line)?.[1];
		if (found !== undefined) paths.push(found.replace(/^(["'])(.*)\1$/, "$2"));
	}
	return paths;
}

/** What the person is shown of a file tool's call: each path as given, and where it leads when that is not the same. */
function describePaths(paths: readonly string[], ctx: RiskContext, cwd: string | null): string {
	const lines = paths.slice(0, 20).map((p) => {
		const abs = filePathOf(p, ctx, cwd);
		return abs !== null && abs !== p ? `Path: ${p}\n  → ${abs}` : `Path: ${p}`;
	});
	if (paths.length > 20) lines.push(`… and ${paths.length - 20} more`);
	return lines.join("\n");
}

/** A risk from the paths a file tool writes (null: none is risky). */
function fromPaths(paths: readonly string[], ctx: RiskContext, root: string | null): Risk | null {
	const found = new Set<RiskKind>();
	for (const p of paths) classifyPath(p, ctx, root, found);
	return found.size === 0 ? null : { kinds: ordered(found), detail: describePaths(paths, ctx, root) };
}

/**
 * Whether a tool call is high-risk, and what to show the person: null when it is not one that is known. `tool` is the
 * name omp gives the call and `input` its arguments, as an extension's `tool_call` handler sees them. It never throws:
 * a call it cannot make sense of is `unreadable`, which asks.
 */
export function classifyToolCall(tool: string, input: unknown, ctx: RiskContext, depth = 0): Risk | null {
	try {
		return classify(
			tool,
			typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {},
			ctx,
			depth,
		);
	} catch {
		return { kinds: ["unreadable"], detail: `Tool: ${tool}\n${safeJson(input)}` };
	}
}

/**
 * A tool that only reads is never asked about, but for the sign-in token (what it reads there opens the server) and for a
 * credential that a tool reading what is in files (`read`, `grep`…) is given (`secret_read`): listing names is not reading.
 */
function readsToken(tool: string, input: Record<string, unknown>, ctx: RiskContext): Risk | null {
	const root = ctx.roots[0] ?? null;
	const given = [input.path, ...(Array.isArray(input.paths) ? input.paths : [])]
		.filter(isString)
		// `grep`'s and `glob`'s `a;b;!c`: several paths in one.
		.flatMap((p) => p.split(";"))
		.filter((p) => p.trim() !== "" && !p.trim().startsWith("!"));
	const named = given.filter((p) => {
		const s = pathText(p, ctx);
		return s !== null && namesPrivateFile({ text: s, dynamic: false, subs: [] }, root, ctx);
	});
	const secrets = listed(CONTENT_TOOLS, tool.toLowerCase())
		? given.filter((p) => {
				const s = pathText(p, ctx);
				const abs = s === null ? null : resolveWord({ text: s, dynamic: false, subs: [] }, root);
				return abs !== null && isSecret(abs, ctx.home);
			})
		: [];
	const kinds: RiskKind[] = [];
	if (named.length > 0) kinds.push("protected");
	if (secrets.length > 0) kinds.push("secret_read");
	return kinds.length === 0
		? null
		: { kinds, detail: `Tool: ${tool}\n${describePaths([...new Set([...named, ...secrets])], ctx, root)}` };
}

function classify(tool: string, input: Record<string, unknown>, ctx: RiskContext, depth: number): Risk | null {
	const name = tool.toLowerCase();
	if (listed(READ_ONLY_TOOLS, name)) return readsToken(tool, input, ctx);
	const root = ctx.roots[0] ?? null;

	if (name.startsWith("remote_access_")) {
		return listed(REMOTE_TOOLS_READING, name)
			? null
			: { kinds: ["remote_tool"], detail: `Tool: ${tool}\n${safeJson(input)}` };
	}
	if (name === "write" && isString(input.path)) {
		if (!input.path.startsWith("xd://")) return fromPaths([input.path], ctx, root);
		// A tool mounted behind `write`: its arguments are the content, as JSON.
		const device = input.path.slice("xd://".length).split(/[/?#]/)[0];
		if (device === "" || depth >= 3 || !isString(input.content)) return null;
		let inner: unknown = null;
		try {
			inner = JSON.parse(input.content);
		} catch {
			// Not arguments: nothing to look at.
		}
		return classifyToolCall(device, inner, ctx, depth + 1);
	}
	if (name === "edit") return fromPaths(editPaths(input), ctx, root);
	if (name === "ast_edit") {
		const paths = Array.isArray(input.paths) ? input.paths.filter(isString) : isString(input.path) ? [input.path] : [];
		return fromPaths(paths, ctx, root);
	}
	if (name === "eval") {
		const code = isString(input.code) ? input.code : "";
		const kinds = classifyCode(code, ctx);
		return kinds.length === 0
			? null
			: { kinds, detail: `Code${isString(input.language) ? ` (${input.language})` : ""}:\n${code}` };
	}
	// `bash`, and any other tool that is handed a shell command (an MCP server's `execute_shell_command`).
	if (isString(input.command) && name !== "write") {
		const start = isString(input.cwd) && root !== null ? (filePathOf(input.cwd, ctx, root) ?? root) : root;
		const kinds = classifyShell(input.command, ctx, start);
		if (kinds.length === 0) return null;
		// The folder first, on one line: the command may hold any line, and the page reads the two apart (`riskCommand`).
		const where = isString(input.cwd) ? `${RISK_IN} ${input.cwd.replace(/[\r\n]+/g, " ")}\n` : "";
		return { kinds, detail: `${where}${RISK_COMMAND} ${input.command}` };
	}
	return null;
}
