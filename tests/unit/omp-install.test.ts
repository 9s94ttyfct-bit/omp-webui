import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	detectInstall,
	findOmp,
	installCommand,
	installOptions,
	jobEnv,
	searchDirs,
} from "../../server/omp/install.ts";
import { compareVersions, compatOf, OMP_COMPAT } from "../../shared/omp-install.ts";

/**
 * Finding omp, telling how it was installed and what the first-run screen offers, each on real files in a
 * temporary home. Nothing here starts a package manager.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-install-"));
let n = 0;
/** A home of its own, so a test's `~/.local/bin` is never another's. */
function home(): string {
	const dir = join(root, `home${++n}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}
afterAll(() => rmSync(root, { recursive: true, force: true }));

function executable(path: string, body = "#!/bin/sh\nexit 0\n"): string {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, body);
	chmodSync(path, 0o755);
	return path;
}

/** Bytes that start like a Mach-O binary: what omp's standalone build is, as far as telling it from a script goes. */
const NATIVE = Buffer.from("cffaedfe0700000100000000", "hex");

test("versions compare as semver: numbers, not text, and a prerelease is older than its release", () => {
	expect(compareVersions("18.12.1", "18.12.0")).toBeGreaterThan(0);
	expect(compareVersions("18.9.0", "18.12.0")).toBeLessThan(0);
	expect(compareVersions("19.0.0", "18.99.99")).toBeGreaterThan(0);
	expect(compareVersions("v18.12.1", "omp/18.12.1")).toBe(0);
	expect(compareVersions("18.13.0-canary.2", "18.13.0")).toBeLessThan(0);
	expect(compareVersions("18.13.0-canary.10", "18.13.0-canary.2")).toBeGreaterThan(0);
	// Not versions: no order to speak of.
	expect(compareVersions("latest", "18.0.0")).toBe(0);
});

test("the supported range starts at its minimum and stops before the next major", () => {
	expect(compatOf(OMP_COMPAT.min)).toBe("supported");
	expect(compatOf("18.99.0")).toBe("supported");
	expect(compatOf("18.10.9")).toBe("older");
	expect(compatOf(OMP_COMPAT.below)).toBe("newer");
	expect(compatOf("19.0.0-canary.1")).toBe("newer");
	expect(compatOf("20.1.0")).toBe("newer");
	expect(compatOf(null)).toBe("unknown");
	expect(compatOf("not a version")).toBe("unknown");
});

test("omp is looked for on PATH, then where omp's own installers put it", () => {
	const h = home();
	const onPath = executable(join(root, "path-dir", "omp"));
	const local = join(h, ".local", "bin");
	const bun = join(h, ".bun", "bin");
	expect(searchDirs({ PATH: join(root, "path-dir") }, h)).toEqual([join(root, "path-dir"), local, bun]);
	// The installer's directory and bun's are the environment's to move.
	expect(searchDirs({ PATH: "/a", PI_INSTALL_DIR: "/opt/omp", BUN_INSTALL: "/opt/bun" }, h)).toEqual([
		"/a",
		"/opt/omp",
		join("/opt/bun", "bin"),
	]);

	expect(findOmp({ PATH: join(root, "path-dir") }, undefined, h)).toBe(onPath);
	// Not on PATH, but where the installer leaves it (and asks the user to add to PATH).
	const installed = executable(join(local, "omp"));
	expect(findOmp({ PATH: "/nonexistent" }, undefined, h)).toBe(installed);
	expect(findOmp({ PATH: "/nonexistent" }, undefined, home())).toBeNull();
	// A file that cannot run is not omp.
	const h2 = home();
	mkdirSync(join(h2, ".local", "bin"), { recursive: true });
	writeFileSync(join(h2, ".local", "bin", "omp"), "not executable");
	expect(findOmp({ PATH: "/nonexistent" }, undefined, h2)).toBeNull();
});

test("OMP_BIN wins when it runs, and is ignored when it does not", () => {
	const h = home();
	const mine = executable(join(root, "mine", "my-omp"));
	const onPath = executable(join(root, "other", "omp"));
	const env = { PATH: join(root, "other") };
	expect(findOmp(env, mine, h)).toBe(mine);
	// A bare name is looked up like omp itself.
	expect(findOmp({ PATH: join(root, "mine") }, "my-omp", h)).toBe(mine);
	// A stale setting leaves the app with the omp it can find, not with none.
	expect(findOmp(env, join(root, "gone", "omp"), h)).toBe(onPath);
	expect(findOmp(env, "omp", h)).toBe(onPath);
});

test("Homebrew, mise, bun and npm installs are told apart by where the file really is", () => {
	const h = home();
	// Homebrew: a link in the prefix's bin into a Cellar.
	const brew = executable(join(h, "brew", "Cellar", "omp", "18.12.1", "bin", "omp"));
	mkdirSync(join(h, "brew", "bin"));
	symlinkSync(brew, join(h, "brew", "bin", "omp"));
	expect(detectInstall(join(h, "brew", "bin", "omp"))).toMatchObject({ method: "homebrew", updatable: true });

	// mise: its installs directory.
	const mise = executable(join(h, ".local", "share", "mise", "installs", "github-can1357-oh-my-pi", "18.12.1", "omp"));
	expect(detectInstall(mise).method).toBe("mise");

	// bun: a launcher in the global node_modules bun keeps under install/global.
	const bunCli = executable(
		join(h, ".bun", "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent", "dist", "cli.js"),
		"#!/usr/bin/env bun\n",
	);
	mkdirSync(join(h, ".bun", "bin"), { recursive: true });
	symlinkSync(bunCli, join(h, ".bun", "bin", "omp"));
	expect(detectInstall(join(h, ".bun", "bin", "omp"))).toMatchObject({ method: "bun", updatable: true });

	// npm: any other node_modules.
	const npmCli = executable(
		join(h, "npm", "lib", "node_modules", "@oh-my-pi", "pi-coding-agent", "dist", "cli.js"),
		"#!/usr/bin/env bun\n",
	);
	mkdirSync(join(h, "npm", "bin"), { recursive: true });
	symlinkSync(npmCli, join(h, "npm", "bin", "omp"));
	expect(detectInstall(join(h, "npm", "bin", "omp"))).toMatchObject({ method: "npm", updatable: true });
});

test("a standalone binary is omp's installer; a script of no package is left alone; a manager's omp is its own", () => {
	const h = home();
	const standalone = join(h, ".local", "bin", "omp");
	mkdirSync(join(standalone, ".."), { recursive: true });
	writeFileSync(standalone, NATIVE);
	chmodSync(standalone, 0o755);
	expect(detectInstall(standalone)).toMatchObject({ method: "installer", managedBy: null, updatable: true });

	// A script in a source checkout (`bun link`) is updated with git, not by omp.
	const checkout = executable(join(h, "src", "oh-my-pi", "cli.ts"), "#!/usr/bin/env bun\n");
	expect(detectInstall(checkout)).toMatchObject({ method: "unknown", updatable: false });

	// An app that manages omp says so in a manager.json two directories up.
	const managed = join(h, "tern", "bin", "omp");
	mkdirSync(join(managed, ".."), { recursive: true });
	writeFileSync(managed, NATIVE);
	chmodSync(managed, 0o755);
	writeFileSync(join(h, "tern", "manager.json"), JSON.stringify({ manager: "tern", name: "Tern" }));
	expect(detectInstall(managed)).toMatchObject({ method: "managed", managedBy: "Tern", updatable: false });
});

test("the first-run screen offers what can run here and recommends Homebrew over the standalone binary", () => {
	const h = home();
	const tools = join(h, "tools");
	executable(join(tools, "curl"));
	// Only curl: the installer, and it is the one to try.
	const bare = installOptions({ PATH: tools }, h);
	expect(bare.map((o) => [o.id, o.available, o.recommended])).toEqual([
		["homebrew", false, false],
		["installer", true, true],
		["bun", false, false],
	]);
	// The exact commands, as omp documents them.
	expect(bare.map((o) => o.command)).toEqual([
		"brew install can1357/tap/omp",
		"curl -fsSL https://omp.sh/install | sh -s -- --binary",
		"bun install -g @oh-my-pi/pi-coding-agent",
	]);

	executable(join(tools, "brew"));
	executable(join(tools, "bun"));
	const all = installOptions({ PATH: tools }, h);
	expect(all.map((o) => [o.id, o.available, o.recommended])).toEqual([
		["homebrew", true, true],
		["installer", true, false],
		["bun", true, false],
	]);
});

test("an install command is built from the table, never from what the page sends", () => {
	const h = home();
	const tools = join(h, "tools");
	const brew = executable(join(tools, "brew"));
	executable(join(tools, "curl"));
	const env = { PATH: tools };
	expect(installCommand("homebrew", env, h)).toEqual({
		argv: [brew, "install", "can1357/tap/omp"],
		command: "brew install can1357/tap/omp",
	});
	const installer = installCommand("installer", env, h);
	if ("error" in installer) throw new Error(installer.error);
	// The screen shows the README's one-liner; what runs downloads to a file first, so a failed download fails the job.
	expect(installer.command).toBe("curl -fsSL https://omp.sh/install | sh -s -- --binary");
	expect(installer.argv.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
	expect(installer.argv[2]).toContain('curl -fsSL -o "$tmp" https://omp.sh/install');
	expect(installer.argv[2]).toContain('sh "$tmp" --binary');
	expect(installer.argv[2]).not.toContain("|");
	// Its program is missing, or it is no choice at all.
	expect(installCommand("bun", env, h)).toEqual({ error: "bun was not found on this computer" });
	expect(installCommand("rm -rf /", env, h)).toEqual({ error: "Unknown install method: rm -rf /" });
});

test("an install runs with the directories omp's installers use on its PATH, and none of the web UI's own settings", () => {
	const h = home();
	const env = jobEnv({ PATH: "/usr/bin", OMP_WEBUI_TOKEN: "secret", OMP_WEBUI_PORT: "7878" }, h);
	expect(env.PATH).toBe(["/usr/bin", join(h, ".local", "bin"), join(h, ".bun", "bin")].join(":"));
	expect(env.OMP_WEBUI_TOKEN).toBeUndefined();
	expect(env.OMP_WEBUI_PORT).toBeUndefined();
});
