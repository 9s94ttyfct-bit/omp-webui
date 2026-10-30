/**
 * Fails when what is, or is about to be, published holds personal data: examples, placeholders, fixtures and docs use
 * made-up names (`jdoe`, `omp.example.com`, `10.0.0.5`), never the developer's own.
 *
 *   bun scripts/check-personal.ts                       every tracked file as it is on disk (part of `bun run lint`)
 *   bun scripts/check-personal.ts --staged              what is staged (the pre-commit hook of `bun run hooks`)
 *   bun scripts/check-personal.ts --range [rev args]    every file a commit of the range adds or changes, and the commits'
 *                                                       names and messages (CI; which commits: scripts/lib/push-range.ts)
 *   bun scripts/check-personal.ts --pre-push <remote>   the same for what a push adds (the pre-push hook)
 *
 * Two kinds of check:
 * - this machine's words: its user name and home folder, and the lines of `.personal-words` (git-ignored, so the words
 *   themselves are never committed: a real name, e-mail addresses, a personal domain, a Cloudflare team, a temporary
 *   folder, a certificate hash, a network prefix, a host name). They only exist where that file does.
 * - patterns that need no list, so CI applies them too (`RULES`): a macOS per-user temporary folder
 *   (`/var/folders/<2>/<id>`), a home folder whose name is not a placeholder (`/Users/<name>`, `/home/<name>`,
 *   `C:\Users\<name>`, and omp's `-Users-<name>-` session folder names), an e-mail address outside the reserved and
 *   placeholder domains, and a private network address outside the placeholder ones.
 *
 * Text is read line by line. A binary file is read as bytes (every rule but the e-mail one, which random bytes could
 * match), and a zip (`.ompw` fixtures and any other) is opened and each member read the same way, its name included.
 * A finding names the place and the rule, never the text it matched, so that a CI log does not publish it either.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { ZipReader } from "../server/migrate/zip.ts";
import { git, publishRange } from "./lib/push-range.ts";

/** Names a CI runner or a container uses: too common to look for in ordinary text. */
const COMMON = new Set(["runner", "root", "admin", "user", "ubuntu", "node", "build", "ci"]);

/** Home folder names that are placeholders (and any name starting with `jdoe` or a dot). */
const PLACEHOLDER_HOMES: Record<string, true> = {
	me: true,
	jdo: true,
	alice: true,
	bob: true,
	jane: true,
	john: true,
	x: true,
	a: true,
	al: true,
	dev: true,
	someone: true,
	attacker: true,
	shared: true,
	old: true,
	new: true,
	"other.name": true,
	runner: true,
	user: true,
	nobody: true,
	test: true,
	linuxbrew: true,
	"ompw-bench-nobody": true,
};

/** E-mail domains that are not anybody's: reserved names and the short placeholders the tests use. */
const PLACEHOLDER_DOMAIN = /(^|\.)(example(\.(com|org|net|co\.uk))?|test|invalid|localhost|local)$/i;
const PLACEHOLDER_DOMAINS: Record<string, true> = {
	"users.noreply.github.com": true,
	"x.org": true,
	"x.io": true,
	"b.co": true,
	"evil.com": true,
	// The host of a URL with credentials in it (`https://<token>@github.com`), in the redaction tests.
	"github.com": true,
	"fcm.googleapis.com": true,
};
/** `name@2x.png`, `n@a.ts`: a file name, not an address. */
const FILE_SUFFIX = /\.(png|jpe?g|gif|svg|webp|ico|ts|tsx|js|mjs|cjs|json|md|css|html|swift|txt)$/i;

/** Private ranges (RFC 1918, and RFC 6598's shared 100.64/10), and the made-up addresses in them the tests use. */
const PRIVATE_NETS = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10"];
const PLACEHOLDER_NETS = [
	"10.0.0.0/24",
	"10.1.0.0/16",
	"10.255.255.255/32",
	"172.16.0.0/16",
	"172.20.1.1/32",
	"172.31.255.255/32",
	"192.168.0.0/24",
	"192.168.1.0/24",
	"100.64.0.0/24",
	"100.127.255.255/32",
	// Documented service addresses: Tailscale's resolver, and Alibaba Cloud's instance metadata.
	"100.100.100.100/32",
	"100.100.100.200/32",
];

function ipNumber(ip: string): number | null {
	const parts = ip.split(".").map(Number);
	if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p > 255)) return null;
	return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function inNet(n: number, cidr: string): boolean {
	const [base, bits] = cidr.split("/");
	const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
	return (n & mask) >>> 0 === ((ipNumber(base) ?? 0) & mask) >>> 0;
}

export interface Rule {
	name: string;
	/** What to use instead. */
	hint: string;
	pattern: RegExp;
	/** Whether a match is personal (it is, unless this says otherwise). */
	personal?: (m: RegExpExecArray) => boolean;
	/** Applied to text only, not to the bytes of a binary file. */
	textOnly?: boolean;
}

export const RULES: Rule[] = [
	{
		name: "temporary folder",
		hint: "a made-up /var/folders/<xx>/<id> with `example` in the id, or /tmp",
		pattern: /(?<![A-Za-z0-9])var[/-]folders[/-][A-Za-z0-9_+]{2}[/-]([A-Za-z0-9_+]{20,})/g,
		personal: (m) => !/example/i.test(m[1]),
	},
	{
		name: "home folder",
		hint: "a placeholder user: jdoe, me, alice, dev, someone",
		pattern:
			/(?:\/Users\/|\/home\/|[A-Za-z]:\\{1,2}Users\\{1,2})([A-Za-z0-9._-]+)|(?<![A-Za-z0-9])-Users-([A-Za-z0-9._]+)-/g,
		personal: (m) => {
			const name = (m[1] ?? m[2]).replace(/\.+$/, "").toLowerCase();
			return !(name.startsWith(".") || name.startsWith("jdoe") || PLACEHOLDER_HOMES[name]);
		},
	},
	{
		name: "e-mail address",
		hint: "an address at example.com, .test or .invalid",
		pattern: /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g,
		personal: (m) => {
			const domain = m[1].toLowerCase();
			return !(PLACEHOLDER_DOMAIN.test(domain) || PLACEHOLDER_DOMAINS[domain] || FILE_SUFFIX.test(domain));
		},
		textOnly: true,
	},
	{
		name: "private network address",
		hint: "10.0.0.x, 192.168.1.x, or a documentation range (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24)",
		pattern: /(?<![0-9.])(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?![0-9]|\.\d)/g,
		personal: (m) => {
			const n = ipNumber(m[1]);
			if (n === null) return false;
			return PRIVATE_NETS.some((c) => inNet(n, c)) && !PLACEHOLDER_NETS.some((c) => inNet(n, c));
		},
	},
];

/** This machine's words (see the header); empty on a machine with none, as in CI. */
export function machineWords(root: string): string[] {
	const words: string[] = [];
	const user = userInfo().username;
	if (user.length >= 3 && !COMMON.has(user.toLowerCase())) words.push(user);
	const home = homedir();
	if (home.length > 1 && !COMMON.has(home.split(/[\\/]/).at(-1)?.toLowerCase() ?? "")) words.push(home);
	const extra = join(root, ".personal-words");
	if (existsSync(extra)) {
		for (const line of readFileSync(extra, "utf8").split("\n")) if (line.trim()) words.push(line.trim());
	}
	return words;
}

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function wordPattern(words: string[]): RegExp | null {
	if (words.length === 0) return null;
	return new RegExp(words.map((w) => `(?<![A-Za-z0-9])${literal(w)}(?![A-Za-z0-9])`).join("|"), "i");
}

/** The rules a piece of text breaks: `[rule, ...]`, a rule once however often it matches. */
function broken(text: string, words: RegExp | null, binary: boolean): string[] {
	const found: string[] = [];
	if (words?.test(text)) found.push("this machine's personal words (.personal-words, user name, home folder)");
	for (const rule of RULES) {
		if (binary && rule.textOnly) continue;
		for (const m of text.matchAll(rule.pattern)) {
			if (!rule.personal || rule.personal(m as RegExpExecArray)) {
				found.push(`${rule.name} (use ${rule.hint})`);
				break;
			}
		}
	}
	return found;
}

const isZip = (b: Uint8Array) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5);

/** Every finding in `bytes`, the content of `where`: `<where>[:<line>]: <rule>`. Zips are opened, members in turn. */
export async function scanBytes(bytes: Uint8Array, where: string, words: RegExp | null): Promise<string[]> {
	if (isZip(bytes)) {
		const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const zip = await ZipReader.from(
			{
				read: async (into, offset, length, position) => ({
					bytesRead: buf.copy(into, offset, position, position + length),
				}),
				close: async () => {},
			},
			buf.length,
		).catch(() => null);
		if (zip) {
			const found: string[] = [];
			try {
				for (const entry of zip.entries) {
					for (const rule of broken(entry.name, words, false))
						found.push(`${where}:${entry.name} (member name): ${rule}`);
					found.push(...(await scanBytes(await zip.bytes(entry.name, 1 << 30), `${where}:${entry.name}`, words)));
				}
			} finally {
				await zip.close();
			}
			return found;
		}
	}
	if (bytes.includes(0)) {
		return broken(Buffer.from(bytes).toString("latin1"), words, true).map((rule) => `${where} (binary): ${rule}`);
	}
	const found: string[] = [];
	Buffer.from(bytes)
		.toString("utf8")
		.split("\n")
		.forEach((line, i) => {
			for (const rule of broken(line, words, false)) found.push(`${where}:${i + 1}: ${rule}`);
		});
	return found;
}

/** The contents of these blobs, by id, read with one `git cat-file --batch`. */
function blobs(cwd: string, ids: string[]): Map<string, Uint8Array> {
	const out = new Map<string, Uint8Array>();
	if (ids.length === 0) return out;
	const r = spawnSync("git", ["cat-file", "--batch"], { cwd, input: `${ids.join("\n")}\n`, maxBuffer: 2 ** 31 });
	if (r.status !== 0) throw new Error(`git cat-file --batch failed: ${r.stderr}`);
	const buf = r.stdout;
	let at = 0;
	while (at < buf.length) {
		const eol = buf.indexOf(0x0a, at);
		const [id, type, size] = buf.subarray(at, eol).toString().split(" ");
		if (type === "missing") throw new Error(`git has no object ${id}`);
		const start = eol + 1;
		out.set(id, buf.subarray(start, start + Number(size)));
		at = start + Number(size) + 1;
	}
	return out;
}

/** The blobs (id → path) that the commits of `range` add or change, and their names and messages. */
function rangeContent(cwd: string, range: string[]): { files: Map<string, string>; commits: Map<string, string> } {
	const files = new Map<string, string>();
	const commits = new Map<string, string>();
	if (range.length === 0) return { files, commits };
	const shas = git(cwd, ["rev-list", ...range, "--"]);
	if (shas.code !== 0) throw new Error(`git rev-list ${range.join(" ")} failed: ${shas.err}`);
	for (const sha of shas.out.split("\n").filter(Boolean)) {
		const tree = spawnSync(
			"git",
			["diff-tree", "-r", "-z", "-m", "--root", "--no-commit-id", "--diff-filter=ACMR", sha],
			{
				cwd,
				encoding: "utf8",
				maxBuffer: 1 << 30,
			},
		).stdout;
		const fields = tree.split("\0");
		for (let i = 0; i + 1 < fields.length; ) {
			const meta = fields[i].split(" ");
			// A rename or copy names two paths; the second is where the blob is now.
			const status = meta[4] ?? "";
			const path = /^[RC]/.test(status) ? fields[i + 2] : fields[i + 1];
			if (meta[0].startsWith(":") && meta[1] !== "160000") files.set(meta[3], path);
			i += /^[RC]/.test(status) ? 3 : 2;
		}
		commits.set(sha, git(cwd, ["log", "-1", "--format=%an%n%cn%n%B", sha]).out);
	}
	return { files, commits };
}

async function main(): Promise<number> {
	const cwd = process.cwd();
	const root = git(cwd, ["rev-parse", "--show-toplevel"]).out || cwd;
	const words = wordPattern(machineWords(root));
	const args = process.argv.slice(2);
	const found: string[] = [];
	let what: string;
	if (args[0] === "--staged") {
		const listed = spawnSync("git", ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"], {
			cwd,
			encoding: "utf8",
		});
		const paths = listed.stdout.split("\0").filter(Boolean);
		const ids = paths.map((p) => git(cwd, ["rev-parse", `:${p}`]).out);
		const content = blobs(cwd, ids);
		for (const [i, p] of paths.entries())
			found.push(...(await scanBytes(content.get(ids[i]) ?? new Uint8Array(), p, words)));
		what = `${paths.length} staged files`;
	} else if (args[0] === "--range" || args[0] === "--pre-push") {
		const chosen = publishRange(cwd, args[0] === "--range" ? args.slice(1) : args);
		const { files, commits } = rangeContent(cwd, chosen.range);
		const content = blobs(cwd, [...files.keys()]);
		for (const [id, path] of files) found.push(...(await scanBytes(content.get(id) ?? new Uint8Array(), path, words)));
		for (const [sha, text] of commits) {
			found.push(...(await scanBytes(Buffer.from(text), `commit ${sha.slice(0, 12)} (names and message)`, words)));
		}
		what = `${chosen.what}: ${commits.size} commits, ${files.size} files`;
	} else {
		const files = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 30 })
			.stdout.split("\0")
			.filter(Boolean);
		for (const file of files) {
			let bytes: Uint8Array;
			try {
				bytes = readFileSync(join(root, file));
			} catch {
				continue; // deleted, not yet staged
			}
			found.push(...(await scanBytes(bytes, file, words)));
		}
		what = `${files.length} tracked files`;
	}
	if (found.length > 0) {
		console.error(`Personal data in ${what} (use made-up names such as jdoe or omp.example.com):\n${found.join("\n")}`);
		return 1;
	}
	console.log(`No personal data in ${what}.`);
	return 0;
}

if (import.meta.main) {
	try {
		process.exit(await main());
	} catch (e) {
		console.error(e instanceof Error ? e.message : String(e));
		process.exit(1);
	}
}
