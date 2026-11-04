/**
 * Builds the Windows launcher (`bun run windows-launcher`, on Windows) → dist/omp-webui-windows-<arch>:
 *
 *   omp-webui.exe   the launcher (server/launcher.ts): the Bun server compiled with its runtime, with the app's icon
 *   web/            the built web UI
 *
 * A double-click on omp-webui.exe starts the server and opens its page in the default browser. omp is not bundled:
 * the first-run page installs it. CI builds it per processor and zips the folder (the `windows-launcher` job: x64 on
 * `windows-latest`, arm64 on `windows-11-arm`); a release attaches both zips.
 *
 * It runs on Windows only: Bun writes the icon and the version details into the program only when it compiles on
 * Windows (a cross-compile refuses the `--windows-*` options). So each processor's is built on a Windows of its own.
 *
 * `--arch x64|arm64` is the processor it is built for (`--target=bun-windows-<arch>`; this machine's by default).
 * `--out <dir>` builds into another folder, and `--version <x.y.z>` builds a program that says it is that version
 * (`omp-webui.exe --version`, the server's own): the updater's tests install it as a later release.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import pkg from "../package.json";
import { readMaster, renderIcon } from "./icons.ts";
import { encodeIco } from "./lib/ico.ts";
import { encodePng } from "./lib/png.ts";

// platform-allow: a build script for the machine it runs on, which must be Windows (see above)
if (process.platform !== "win32") {
	console.error("The Windows launcher is built on Windows (CI's windows-launcher job builds it).");
	process.exit(1);
}

const root = join(import.meta.dir, "..");
const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : undefined;
};
const version = arg("version") ?? pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
	console.error(`--version wants x.y.z, not ${version}`);
	process.exit(1);
}
const arch = arg("arch") ?? process.arch;
if (arch !== "x64" && arch !== "arm64") {
	console.error(`--arch wants x64 or arm64, not ${arch}`);
	process.exit(1);
}
const outArg = arg("out");
const out = outArg ? resolve(root, outArg) : join(root, "dist", `omp-webui-windows-${arch}`);
// The folder is emptied before the build: only one that is new, empty or an earlier build's, never the checkout or a
// folder that holds it.
const rel = relative(out, root);
const holdsCheckout = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
const earlierBuild = existsSync(join(out, "omp-webui.exe"));
if (holdsCheckout || (existsSync(out) && readdirSync(out).length > 0 && !earlierBuild)) {
	console.error(`--out ${out}: give a new or empty folder, or an earlier build's (it is emptied first)`);
	process.exit(1);
}
const stage = mkdtempSync(join(tmpdir(), "ompw-win-"));

async function run(cmd: string[], cwd = root): Promise<void> {
	console.log(`$ ${cmd.join(" ")}`);
	const code = await Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" }).exited;
	if (code !== 0) throw new Error(`${cmd[0]} exited with ${code}`);
}

try {
	rmSync(out, { recursive: true, force: true });
	mkdirSync(out, { recursive: true });

	await run(["bunx", "vite", "build"]);
	cpSync(join(root, "dist", "web"), join(out, "web"), { recursive: true });

	// The icon: the sizes Explorer and the taskbar show, each rendered the way the macOS app's are.
	const master = readMaster();
	const icon = join(stage, "omp-webui.ico");
	writeFileSync(
		icon,
		encodeIco(
			[16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: encodePng(renderIcon(master, size, "plate")) })),
		),
	);

	// Run from the staging dir: `bun build --compile` leaves a `.*.bun-build` temp file in its cwd.
	await run(
		[
			"bun",
			"build",
			"--compile",
			"--minify",
			`--target=bun-windows-${arch}`,
			`--windows-icon=${icon}`,
			"--windows-title=omp-webui",
			"--windows-description=omp-webui",
			`--windows-version=${version}.0`,
			...(version === pkg.version ? [] : [`--define=OMPW_BUILD_VERSION=${JSON.stringify(version)}`]),
			join(root, "server", "launcher.ts"),
			// The workers the server starts by relative URLs (see scripts/app.ts): entry points of their own.
			join(root, "server", "family-worker.ts"),
			join(root, "server", "search-index-worker.ts"),
			join(root, "server", "host-gpu-worker.ts"),
			"--outfile",
			join(out, "omp-webui.exe"),
		],
		stage,
	);
	console.log(`\nBuilt ${out}`);
} finally {
	rmSync(stage, { recursive: true, force: true });
}
