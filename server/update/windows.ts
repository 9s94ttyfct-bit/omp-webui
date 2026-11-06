import { randomUUID } from "node:crypto";
import {
	closeSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	renameSync,
	rmdirSync,
	rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { run } from "../omp/run.ts";
import { removeLeftovers } from "./files.ts";
import { detailOf, freeSpace, UpdateError } from "./steps.ts";

/**
 * The Windows launcher's own update (`omp-webui.exe`, scripts/windows-launcher.ts): the release's zip is looked at, unpacked
 * next to the install folder and checked here; `helper.ps1` swaps the folders once this server has exited. The zip is CI's
 * (the windows-launcher job, one per processor): one top folder, `omp-webui-windows-<arch>/`, holding `omp-webui.exe` and
 * `web/`.
 *
 * Nothing in the zip is taken at its word before it is on disk: the members are listed first, and a zip with a member that
 * could land outside the folder it is unpacked into (an absolute or drive-rooted name, a `..` segment, a link) or outside
 * its one top folder is refused before anything is unpacked. What was unpacked is looked at once more for links and
 * junctions, which `tar` could have made of something the listing did not show as one.
 */

/** The processors a Windows launcher is built for: x64 and Arm (arm64). */
export type WindowsArch = "x64" | "arm64";

/** The one top folder of the zip for `arch`: an arm64 launcher takes only the arm64 zip, an x64 one only the x64 zip. */
export const zipTop = (arch: WindowsArch): string => `omp-webui-windows-${arch}`;
/** What the top folder must hold. */
export const WINDOWS_EXE = "omp-webui.exe";
const WEB_INDEX = join("web", "index.html");

const COMMAND_MS = 120_000;
/** How long `omp-webui.exe --version` may take: it prints a line and ends, without starting the server. */
export const VERSION_MS = 10_000;

/**
 * The `tar` that reads the zip: Windows' own (`%SystemRoot%\System32\tar.exe`, bsdtar, there since Windows 10 1803), by its
 * full path so that nothing on PATH stands in for it. Elsewhere (a test) bsdtar, which reads zips as Windows' does (macOS's
 * `tar` is one; GNU tar is not), or `tar` when there is none.
 */
export function tarCommand(): string {
	if (process.platform !== "win32") return Bun.which("bsdtar") ?? "tar";
	return join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
}

/** Windows PowerShell, by its full path, which runs the helper. */
export function powershellCommand(): string {
	return join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** `text` as a PowerShell string literal (single quotes, a quote in it doubled). */
const psLiteral = (text: string): string => `'${text.replace(/'/g, "''")}'`;

/**
 * Start `powershell args…` hidden, so that it outlives this process, and return its pid. Not as a detached child: Windows
 * PowerShell started without a console (Node's and Bun's `detached`) ends at once, successfully, without running anything
 * (CI, run 41342601834). And a child that is not detached is in the job object Bun puts its children in, which ends them
 * all when this process exits. So a short-lived PowerShell, a child of this one, starts the helper with `Start-Process`
 * (hidden, with a console of its own) and prints its pid: what that one starts is not in the job (it allows its processes'
 * children to break away, and they do). The command is passed encoded, so that no path in it needs quoting for a shell;
 * each value is quoted for the command line `Start-Process` makes of the list.
 */
export async function startHidden(
	powershell: string,
	args: string[],
	opts: { cwd: string; env: Record<string, string | undefined> },
): Promise<number> {
	const list = args.map((a) => psLiteral(/^-[A-Za-z]+$/.test(a) ? a : `"${a}"`)).join(",");
	const command = [
		`$p = Start-Process -FilePath ${psLiteral(powershell)} -ArgumentList @(${list})`,
		`-WorkingDirectory ${psLiteral(opts.cwd)} -WindowStyle Hidden -PassThru;`,
		"[Console]::Out.Write($p.Id)",
	].join(" ");
	const proc = Bun.spawn(
		[
			powershell,
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-EncodedCommand",
			Buffer.from(command, "utf16le").toString("base64"),
		],
		{ cwd: opts.cwd, env: opts.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true },
	);
	const timer = setTimeout(() => proc.kill(), 30_000);
	try {
		const [out, err, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		const pid = Number(out.trim());
		if (code !== 0 || !Number.isSafeInteger(pid) || pid <= 0) {
			throw new Error(`exit ${code}: ${`${err}\n${out}`.trim().slice(0, 300)}`);
		}
		return pid;
	} finally {
		clearTimeout(timer);
	}
}

export interface StageWindowsOptions {
	/** The `tar` to list and unpack with (`tarCommand()` by default). */
	tar?: string;
	/** Free bytes in a directory, null where it cannot be told. For tests. */
	freeBytes?: (dir: string) => number | null;
	/** Called once the listing has been accepted, before anything is unpacked (the page's "Preparing the new version…"). */
	onUnpack?: () => void;
}

/** A member of the zip as the listing says it: its name, and whether it is a plain file or folder (anything else is not). */
interface Member {
	name: string;
	kind: "file" | "dir" | "other";
	size: number;
}

/** The start of every zip (a local file header): anything else is not unpacked at all, whatever `tar` could make of it. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

function isZip(file: string): boolean {
	const fd = openSync(file, "r");
	try {
		const head = Buffer.alloc(4);
		return readSync(fd, head, 0, 4, 0) === 4 && ZIP_MAGIC.every((b, i) => head[i] === b);
	} finally {
		closeSync(fd);
	}
}

async function tar(argv: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
	return run(argv, { timeoutMs: COMMAND_MS, cwd }).catch((e: Error) => ({ code: 1, stdout: "", stderr: e.message }));
}

/** The lines `tar` printed, without the empty last one (and a `\r` Windows may end them with). */
const linesOf = (text: string): string[] =>
	text
		.split("\n")
		.map((l) => l.replace(/\r$/, ""))
		.filter((l) => l !== "");

/** One line of `tar -tvf`: `<mode> <links> <uid> <gid> <size> <date…> <name>`. Only the type and the size are read here. */
const VERBOSE_LINE = /^(\S)\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s/;

/**
 * The zip's members, by `tar -tf` (the names exactly) and `tar -tvf` (their types and sizes, in the same order). A listing
 * whose two halves do not line up (a name with a line break in it) or that cannot be read is no listing of ours.
 */
async function listMembers(command: string, zip: string, top: string): Promise<Member[]> {
	const names = await tar([command, "-tf", zip]);
	const verbose = await tar([command, "-tvf", zip]);
	if (names.code !== 0 || verbose.code !== 0)
		throw new UpdateError("stage", { detail: detailOf(names.code ? names : verbose) });
	const nameLines = linesOf(names.stdout);
	const verboseLines = linesOf(verbose.stdout);
	if (nameLines.length === 0 || nameLines.length !== verboseLines.length) throw new UpdateError("noApp", { name: top });
	return nameLines.map((name, i) => {
		const m = VERBOSE_LINE.exec(verboseLines[i] as string);
		if (!m) throw new UpdateError("noApp", { name: top });
		const type = m[1];
		return { name, kind: type === "-" ? "file" : type === "d" ? "dir" : "other", size: Number(m[2]) };
	});
}

/**
 * Whether `name` (a member's name as the zip has it) unpacks inside the top folder `top` (`zipTop`): not absolute (`/x`,
 * `\x`), not rooted at a drive or naming a stream (any `:`, which no file of ours has), no `..` segment, and under `top/`.
 * Both separators count: Windows takes `\` as one.
 */
export function memberAllowed(name: string, top: string): boolean {
	if (name === "" || name.includes(":") || name.includes("\0")) return false;
	const path = name.replace(/\\/g, "/");
	if (path.startsWith("/")) return false;
	const segments = path.split("/").filter((s, i, all) => s !== "" || i < all.length - 1);
	if (segments.some((s) => s === ".." || s === "")) return false;
	return segments[0] === top;
}

/**
 * Everything under `dir` is a plain folder or a plain file with one name: no link, junction or other reparse point (Node
 * reports symbolic links and junctions as links on Windows), no hard link to a file elsewhere, nothing else.
 */
function plainTree(dir: string): boolean {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		const st = lstatSync(path);
		if (st.isDirectory()) {
			if (!plainTree(path)) return false;
		} else if (!st.isFile() || st.nlink > 1) {
			return false;
		}
	}
	return true;
}

/** `path` is a plain file (not a link to one). */
function isPlainFile(path: string): boolean {
	try {
		return lstatSync(path).isFile();
	} catch {
		return false;
	}
}

/** The errors of a rename or removal that a moment later may work: a file in the folder is still open. */
const BUSY: Record<string, true> = { EPERM: true, EBUSY: true, EACCES: true };

/**
 * `op` (a rename or a removal in the update's folders), tried for about ten seconds while it fails as busy: Windows refuses
 * to rename or remove a folder while a file in it is open, antivirus software opens a program that was just written to scan
 * it, and a program that was just run is held a moment after it has ended (helper.ps1's `Move-Folder` waits the same way).
 */
export async function whileBusy(op: () => void, tries = 20, gapMs = 500): Promise<void> {
	for (let i = 1; ; i++) {
		try {
			op();
			return;
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code ?? "";
			if (i >= tries || !Object.hasOwn(BUSY, code)) throw e;
			await Bun.sleep(gapMs);
		}
	}
}

/**
 * Unpack the release's `zip` (downloaded, its size and SHA-256 checked) into `staged`, next to the install folder, and check
 * it: the members are listed and vetted first (`memberAllowed` under `zipTop(arch)`, files and folders only), the room for
 * them is looked at, then the zip is unpacked into a fresh folder beside `staged`, looked at again for links, and its top
 * folder becomes `staged`. It must hold `omp-webui.exe` and `web/index.html`, and `omp-webui.exe --version` must print
 * `expectedVersion`. Whatever is refused leaves nothing behind but what was there.
 */
export async function stageWindows(
	zip: string,
	staged: string,
	expectedVersion: string,
	arch: WindowsArch,
	opts: StageWindowsOptions = {},
): Promise<void> {
	const command = opts.tar ?? tarCommand();
	const topName = zipTop(arch);
	if (!isZip(zip)) throw new UpdateError("noApp", { name: topName });
	const members = await listMembers(command, zip, topName);
	for (const m of members) {
		if (m.kind === "other" || !memberAllowed(m.name, topName)) throw new UpdateError("noApp", { name: topName });
	}

	const dir = dirname(staged);
	const bytes = members.reduce((sum, m) => sum + m.size, 0);
	const needed = Math.ceil(bytes * 1.1) + 10 * 1024 * 1024;
	const free = (opts.freeBytes ?? freeSpace)(dir);
	if (free !== null && free < needed) throw new UpdateError("space", { needed, free });

	opts.onUnpack?.();
	// Fresh: made here, by this name, now (`mkdirSync` without `recursive` refuses one that is there already).
	const unpack = `${staged}.unzip-${randomUUID().slice(0, 8)}`;
	try {
		mkdirSync(unpack);
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "EACCES" || code === "EPERM") throw new UpdateError("notWritable", { dir });
		throw new UpdateError("stage", { detail: (e as Error).message.slice(0, 300) });
	}
	try {
		const unpacked = await tar([command, "-xf", zip], unpack);
		if (unpacked.code !== 0) throw new UpdateError("stage", { detail: detailOf(unpacked) });
		const top = join(unpack, topName);
		const roots = readdirSync(unpack);
		if (roots.length !== 1 || roots[0] !== topName || !lstatSync(top).isDirectory() || !plainTree(top)) {
			throw new UpdateError("noApp", { name: topName });
		}
		rmSync(staged, { recursive: true, force: true });
		await whileBusy(() => renameSync(top, staged));
	} finally {
		rmSync(unpack, { recursive: true, force: true });
	}

	try {
		const exe = join(staged, WINDOWS_EXE);
		if (!isPlainFile(exe) || !isPlainFile(join(staged, WEB_INDEX)))
			throw new UpdateError("noApp", { name: WINDOWS_EXE });
		const said = await run([exe, "--version"], { timeoutMs: VERSION_MS, cwd: staged }).catch(() => null);
		const found = said?.code === 0 ? (linesOf(said.stdout)[0] ?? "").trim() : "";
		if (found !== expectedVersion) {
			throw new UpdateError("version", { tag: `v${expectedVersion}`, found: found.slice(0, 40) || "?" });
		}
	} catch (e) {
		// The program was just run: Windows holds it a moment after it has ended (seen in CI: EBUSY at once, and the refused
		// install's folder left beside the app). A removal that still fails is logged, never thrown: its error would take the
		// place of the refusal (the install then said "stage" where it should say which version it found).
		await whileBusy(() => rmSync(staged, { recursive: true, force: true })).catch(() => removeLeftovers(staged));
		throw e;
	}
}

/**
 * Whether this user can make and rename things in `dir`, found by doing it: on Windows `access(W_OK)` looks only at the
 * read-only attribute, and a folder under Program Files has none while only an administrator may write there.
 */
export function canWriteIn(dir: string): boolean {
	const probe = join(dir, `.omp-webui-write-test-${process.pid}-${randomUUID().slice(0, 8)}`);
	try {
		mkdirSync(probe);
	} catch {
		return false;
	}
	try {
		rmdirSync(probe);
	} catch {
		// made, so writable; a probe that cannot be removed is left (it is empty)
	}
	return true;
}
