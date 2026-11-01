import { closeSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
import type { InstallMethod, InstallOption, InstallOptionId, OmpInstall } from "../../shared/omp-install.ts";
import { childEnv } from "../env.ts";
import { platform } from "../platform/index.ts";
import { run } from "./run.ts";

/**
 * Finding omp, telling how it was installed, and installing it. Nothing here runs a package manager on its own:
 * the commands are the ones omp documents (https://github.com/can1357/oh-my-pi#install) and the first-run screen
 * shows each one before it is run.
 */

type Env = Record<string, string | undefined>;

/** Homebrew's formula for omp (the tap `can1357/tap`). */
export const HOMEBREW_FORMULA = "can1357/tap/omp";
/** omp's npm package, which bun installs globally. */
export const NPM_PACKAGE = "@oh-my-pi/pi-coding-agent";

// ------------------------------------------------------------------ finding omp

/**
 * Where an omp may be: the directories of `PATH`, then where omp's own installers put it — its installer's
 * (`$PI_INSTALL_DIR`, else `~/.local/bin`, which the installer leaves off `PATH` and asks the user to add; Windows:
 * `%LOCALAPPDATA%\omp`, which it adds to the user's `PATH` for programs started after it) and bun's global bin
 * (`$BUN_INSTALL/bin`, else `~/.bun/bin`). A macOS app started from Finder has a minimal `PATH`: the server takes its
 * login shell's (`login-env.ts`), and these two cover what that shell does not export.
 */
export function searchDirs(env: Env = process.env, home: string = homedir()): string[] {
	const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
	dirs.push(env.PI_INSTALL_DIR || platform.commands.ompInstallDir(home));
	dirs.push(join(env.BUN_INSTALL || join(home, ".bun"), "bin"));
	return [...new Set(dirs)];
}

/**
 * The omp to run. `configured` is `OMP_BIN`: a path, or a name looked up like `omp`; one that cannot be run is
 * ignored in favour of the search, so a stale setting does not leave the app without omp.
 */
export function findOmp(env: Env = process.env, configured?: string, home: string = homedir()): string | null {
	const dirs = searchDirs(env, home);
	const { which, isExecutable } = platform.commands;
	if (configured && configured !== "omp") {
		const explicit = configured.includes(sep) ? configured : which(configured, dirs);
		if (explicit && isExecutable(explicit)) return explicit;
	}
	return which("omp", dirs);
}

/**
 * Run `bin --version`: the version it reports, or why it cannot run. One that exits cleanly runs, even when what
 * it prints is not a version number this can read (a future format): the app must not turn it away for that;
 * compatibility with it is then simply unknown.
 */
export async function probeOmp(
	bin: string,
	env: Env = process.env,
	timeoutMs = 20_000,
): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
	try {
		const { code, stdout, stderr } = await run([bin, "--version"], { base: env, timeoutMs });
		const version = /(\d+\.\d+\.\d+[\w.-]*)/.exec(stdout)?.[1];
		if (code === 0) return { ok: true, version: version ?? (stdout.trim().slice(0, 80) || "unknown") };
		const said = (stderr || stdout).trim().slice(0, 600);
		return { ok: false, error: said || `exited with code ${code}` };
	} catch (e) {
		return { ok: false, error: (e as Error).message };
	}
}

// ------------------------------------------------------------------ how it was installed

/** The first bytes of Mach-O, ELF and Windows (PE, `MZ`) executables: what a standalone omp binary is, unlike a script. */
function isNativeExecutable(path: string): boolean {
	let fd: number | null = null;
	try {
		fd = openSync(path, "r");
		const head = Buffer.alloc(4);
		if (readSync(fd, head, 0, 4, 0) < 4) return false;
		const magic = head.toString("hex");
		if (magic.startsWith("4d5a")) return true;
		return magic === "7f454c46" || ["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe"].includes(magic);
	} catch {
		return false;
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

/** An app that manages this omp keeps `manager.json` two directories above it (`<root>/bin/omp`, `<root>/versions/<v>/omp`). */
function managerName(realPath: string): string | null {
	try {
		const manifest: unknown = JSON.parse(readFileSync(join(dirname(dirname(realPath)), "manager.json"), "utf8"));
		if (typeof manifest !== "object" || manifest === null) return null;
		const { name, manager } = manifest as { name?: unknown; manager?: unknown };
		const text = typeof name === "string" && name ? name : manager;
		return typeof text === "string" && text ? text : null;
	} catch {
		return null;
	}
}

/**
 * How the omp at `bin` was installed, from where its file really is — the way `omp update` itself decides what
 * to update with (`resolveUpdateMethod` in omp's `cli/update-cli.ts`), minus the questions that need a package
 * manager to answer: Homebrew keeps its files in a `Cellar`, mise in `installs` (its `shims` point at mise itself),
 * Nix in the store, and a global npm or bun package is a launcher inside a `node_modules`. Bun keeps its global
 * packages in `install/global/node_modules`; any other `node_modules` is npm's (or a Node version manager's).
 * A native executable anywhere else is omp's standalone binary, which is what its installer leaves.
 */
export function detectInstall(bin: string): OmpInstall {
	let realPath = bin;
	try {
		realPath = realpathSync(bin);
	} catch {
		// A launcher that cannot be resolved is classified by the path it was found at.
	}
	const managedBy = managerName(realPath);
	const posix = (p: string) => p.split(sep).join("/");
	const real = posix(realPath);
	const asFound = posix(bin);
	let method: InstallMethod;
	if (managedBy) method = "managed";
	else if (real.startsWith("/nix/store/")) method = "nix";
	else if (/\/(Cellar|Caskroom)\//.test(real)) method = "homebrew";
	else if (/\/mise\/(installs|shims)\//.test(real) || /\/mise\/shims\//.test(asFound)) method = "mise";
	else if (real.includes("/node_modules/")) method = real.includes("/install/global/node_modules/") ? "bun" : "npm";
	else if (isNativeExecutable(realPath)) method = "installer";
	else method = "unknown";
	return { method, managedBy, realPath, updatable: method !== "nix" && method !== "managed" && method !== "unknown" };
}

// ------------------------------------------------------------------ installing

interface InstallRecipe {
	id: InstallOptionId;
	/** What the first-run screen shows. */
	command: string;
	/** The program it needs. */
	needs: string;
	/** What to run, with `tool` the resolved path of `needs`. */
	argv(tool: string): string[];
}

/**
 * The install commands of omp's README, which the first-run screen offers. The installer's `--binary` (`-Binary`)
 * always installs the standalone build: its default installs through bun when bun exists, which is the Bun option's job.
 */
function recipes(): InstallRecipe[] {
	// What the screen shows (and a terminal can paste) is the README's one-liner for this system; the server runs the same
	// download and install in a way that reports a download that fails (`ShellOps.installer`).
	const installer = platform.shell.installer();
	return [
		{
			id: "homebrew",
			command: `brew install ${HOMEBREW_FORMULA}`,
			needs: "brew",
			argv: (brew) => [brew, "install", HOMEBREW_FORMULA],
		},
		{ id: "installer", command: installer.command, needs: installer.needs, argv: () => installer.argv },
		{
			id: "bun",
			command: `bun install -g ${NPM_PACKAGE}`,
			needs: "bun",
			argv: (bun) => [bun, "install", "-g", NPM_PACKAGE],
		},
	];
}

/** The options the first-run screen lists, which of them can run here, and the one to try first. */
export function installOptions(env: Env = process.env, home: string = homedir()): InstallOption[] {
	const dirs = searchDirs(env, home);
	const options = recipes().map((r) => {
		const tool = platform.commands.which(r.needs, dirs);
		return {
			id: r.id,
			command: r.command,
			needs: r.needs,
			available: tool !== null,
			recommended: false,
		};
	});
	// Homebrew where it exists (it is what a Mac user expects, and brew keeps omp updated); otherwise the standalone binary.
	const first =
		options.find((o) => o.id === "homebrew" && o.available) ?? options.find((o) => o.id === "installer" && o.available);
	if (first) first.recommended = true;
	return options;
}

/** The command line of an install option, or why it cannot run. */
export function installCommand(
	id: string,
	env: Env = process.env,
	home: string = homedir(),
): { argv: string[]; command: string } | { error: string } {
	const recipe = recipes().find((r) => r.id === id);
	if (!recipe) return { error: `Unknown install method: ${id}` };
	const tool = platform.commands.which(recipe.needs, searchDirs(env, home));
	if (!tool) return { error: `${recipe.needs} was not found on this computer` };
	return { argv: recipe.argv(tool), command: recipe.command };
}

/** `PATH` for a command the server runs: where omp and the tools it installs with are (see `searchDirs`). */
export function jobEnv(env: Env = process.env, home: string = homedir()): Record<string, string | undefined> {
	return childEnv({ PATH: searchDirs(env, home).join(delimiter) }, env);
}
