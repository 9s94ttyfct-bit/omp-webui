import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import pkg from "../../package.json";
import { platformId } from "../../server/platform/capabilities.ts";
import { removeScratch } from "../support/scratch.ts";

/**
 * The Linux package's install.sh (scripts/linux-install.sh): it installs the unpacked folder for the user, with a command
 * and an applications-menu entry, installs a newer one over it (also run from the installed copy), and uninstalls it all
 * but the data. Each run has a home of its own (`HOME` and `XDG_DATA_HOME` in the test's scratch folder), and
 * `update-desktop-database` is a stand-in that writes down the folder it is given.
 *
 * `OMPW_LINUX_PACKAGE` is a built package folder (CI's linux-package job); without it the package is a stand-in: a shell
 * script that answers `--version` as the program, `web/index.html`, an icon and the script itself. A built program is
 * run (through the installed command) only on Linux: a package cross-built on another system is installed and checked,
 * but its program cannot start there.
 */

const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "linux-install.sh");
const root = mkdtempSync(join(tmpdir(), "ompw-linux-install-"));
const tools = join(root, "tools");
const refreshed = join(root, "refreshed.txt");

/** A folder laid out as the package is, whose program is a shell script that says it is `version`. */
function standIn(dir: string, version: string): string {
	mkdirSync(join(dir, "web"), { recursive: true });
	writeFileSync(join(dir, "web", "index.html"), "<!doctype html>\n");
	writeFileSync(join(dir, "omp-webui.png"), "png\n");
	writeFileSync(
		join(dir, "omp-webui"),
		`#!/bin/sh\nif [ "$1" = --version ]; then echo ${version}; exit 0; fi\nfor a in "$@"; do echo "arg: $a"; done\n`,
	);
	chmodSync(join(dir, "omp-webui"), 0o755);
	copyFileSync(SCRIPT, join(dir, "install.sh"));
	chmodSync(join(dir, "install.sh"), 0o755);
	return dir;
}

const built = process.env.OMPW_LINUX_PACKAGE;
const pack = built ?? standIn(join(root, "package", "omp-webui-linux-x64"), "9.9.9");
const version = built ? pkg.version : "9.9.9";
/** Whether the installed program can be run here. */
const runnable = !built || platformId === "linux";

mkdirSync(tools);
writeFileSync(join(tools, "update-desktop-database"), `#!/bin/sh\necho "$1" >> '${refreshed}'\n`);
chmodSync(join(tools, "update-desktop-database"), 0o755);

afterAll(() => removeScratch(root));

let homes = 0;

/** A home of its own, and where install.sh puts things in it. */
function home() {
	const dir = join(root, `home-${++homes}`);
	const data = join(dir, "data");
	mkdirSync(dir, { recursive: true });
	const env = {
		HOME: dir,
		XDG_DATA_HOME: data,
		PATH: [tools, process.env.PATH ?? ""].join(delimiter),
	};
	const run = (cmd: string[]) => {
		const r = Bun.spawnSync(cmd, { env, cwd: dir, stdout: "pipe", stderr: "pipe" });
		return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
	};
	return {
		dir,
		data,
		installed: join(data, "omp-webui"),
		wrapper: join(dir, ".local", "bin", "omp-webui"),
		icon: join(data, "icons", "hicolor", "256x256", "apps", "omp-webui.png"),
		entry: join(data, "applications", "omp-webui.desktop"),
		install: (from: string, args: string[] = []) => run([join(from, "install.sh"), ...args]),
		run,
	};
}

const executable = (path: string) => (statSync(path).mode & 0o111) === 0o111;
const refreshes = () => (existsSync(refreshed) ? readFileSync(refreshed, "utf8").split("\n").filter(Boolean) : []);

describe.skipIf(platformId === "win32")("the Linux package's install.sh", () => {
	test("installs the folder, a command that starts it and a menu entry that starts it in a terminal", () => {
		const h = home();
		const before = refreshes().length;
		const r = h.install(pack);
		expect(r.err).toBe("");
		expect(r.code).toBe(0);
		for (const name of ["omp-webui", "install.sh"]) expect(executable(join(h.installed, name))).toBe(true);
		expect(existsSync(join(h.installed, "web", "index.html"))).toBe(true);
		expect(readFileSync(h.icon)).toEqual(readFileSync(join(pack, "omp-webui.png")));
		expect(executable(h.wrapper)).toBe(true);
		expect(readFileSync(h.entry, "utf8").split("\n")).toEqual([
			"[Desktop Entry]",
			"Type=Application",
			"Name=omp-webui",
			"Comment=A web UI for the omp coding agent",
			`Exec="${join(h.installed, "omp-webui")}"`,
			`Icon=${h.icon}`,
			"Terminal=true",
			"Categories=Development;",
			"",
		]);
		expect(refreshes().slice(before)).toEqual([join(h.data, "applications")]);
		expect(r.out).toContain(`omp-webui is installed in ${h.installed}.`);
		// The test's PATH has no ~/.local/bin of this home.
		expect(r.out).toContain(`Note: ${join(h.dir, ".local", "bin")} is not on your PATH`);
		// Only the installed folder is left beside it: no half-copied or previous one.
		expect(readdirSync(h.data).sort()).toEqual(["applications", "icons", "omp-webui"]);
		if (runnable) expect(h.run([h.wrapper, "--version"]).out).toBe(`${version}\n`);
		if (!built) expect(h.run([h.wrapper, "a b", "c"]).out).toBe("arg: a b\narg: c\n");
	});

	test("a newer package installs over the old one, and the installed copy's install.sh runs again without harm", () => {
		const h = home();
		expect(h.install(pack).code).toBe(0);
		writeFileSync(join(h.installed, "stale.txt"), "left by the old copy\n");

		const next = standIn(join(root, `next-${homes}`, "omp-webui-linux-x64"), "9.9.10");
		const upgraded = h.install(next);
		expect(upgraded.err).toBe("");
		expect(upgraded.code).toBe(0);
		expect(existsSync(join(h.installed, "stale.txt"))).toBe(false);
		expect(h.run([h.wrapper, "--version"]).out).toBe("9.9.10\n");
		expect(readdirSync(h.data).sort()).toEqual(["applications", "icons", "omp-webui"]);

		// Back to the package under test, then install.sh run from where it was installed.
		expect(h.install(pack).code).toBe(0);
		const again = h.install(h.installed);
		expect(again.err).toBe("");
		expect(again.code).toBe(0);
		expect(executable(join(h.installed, "omp-webui"))).toBe(true);
		expect(existsSync(join(h.installed, "web", "index.html"))).toBe(true);
		expect(readFileSync(h.entry, "utf8")).toContain(`Exec="${join(h.installed, "omp-webui")}"`);
		expect(readdirSync(h.data).sort()).toEqual(["applications", "icons", "omp-webui"]);
		if (runnable) expect(h.run([h.wrapper, "--version"]).out).toBe(`${version}\n`);
	});

	test("--uninstall removes the folder, the command, the icon and the menu entry, and keeps the data", () => {
		const h = home();
		expect(h.install(pack).code).toBe(0);
		const unrelated = join(h.data, "applications", "other.desktop");
		writeFileSync(unrelated, "[Desktop Entry]\n");
		const dataDir = join(h.dir, ".omp-webui");
		mkdirSync(dataDir);
		writeFileSync(join(dataDir, "settings.json"), "{}\n");
		const before = refreshes().length;

		// Run as it is after an install: the installed copy removes itself.
		const r = h.install(h.installed, ["--uninstall"]);
		expect(r.err).toBe("");
		expect(r.code).toBe(0);
		for (const gone of [h.installed, h.wrapper, h.icon, h.entry]) expect(existsSync(gone)).toBe(false);
		expect(readFileSync(unrelated, "utf8")).toBe("[Desktop Entry]\n");
		expect(readFileSync(join(dataDir, "settings.json"), "utf8")).toBe("{}\n");
		expect(refreshes().slice(before)).toEqual([join(h.data, "applications")]);
		expect(r.out).toContain("omp-webui is uninstalled");
	});

	test("unknown arguments are refused with the usage, and nothing is installed", () => {
		const h = home();
		for (const args of [["--bogus"], ["--uninstall", "now"], ["install"]]) {
			const r = h.install(pack, args);
			expect(r.code, args.join(" ")).toBe(2);
			expect(r.err).toBe("usage: ./install.sh [--uninstall]\n");
		}
		expect(existsSync(h.data)).toBe(false);
		expect(existsSync(h.wrapper)).toBe(false);
	});

	test("a folder without the program or web/ beside the script is refused, and nothing is installed", () => {
		const h = home();
		const lone = join(root, "lone");
		mkdirSync(lone);
		copyFileSync(SCRIPT, join(lone, "install.sh"));
		chmodSync(join(lone, "install.sh"), 0o755);
		writeFileSync(join(lone, "omp-webui"), "");
		const r = h.install(lone);
		expect(r.code).toBe(1);
		expect(r.err).toContain("omp-webui and web/ must be beside it");
		expect(existsSync(h.data)).toBe(false);
		expect(existsSync(h.wrapper)).toBe(false);
	});
});
