/**
 * Builds the Linux package (`bun run linux-package`) → dist/omp-webui-linux-<arch>:
 *
 *   omp-webui       the launcher (server/launcher.ts): the Bun server compiled with its runtime
 *   web/            the built web UI
 *   omp-webui.png   the app's icon, for the applications menu
 *   install.sh      installs the package for the current user (scripts/linux-install.sh)
 *
 * `./install.sh` copies the folder into ~/.local/share/omp-webui, puts an `omp-webui` command in ~/.local/bin and an
 * entry in the applications menu; started from either, the program starts the server and opens its page in the default
 * browser, as the Windows launcher does. omp is not bundled: the first-run page installs it. CI builds it for x64 and
 * arm64 and packs each folder as a tarball (the `linux-package` job); a release attaches them.
 *
 * `--arch x64|arm64` builds for that processor (the machine's by default); Bun cross-compiles, so it builds on any
 * system. `--out <dir>` builds into another folder, and `--version <x.y.z>` builds a program that says it is that version
 * (`omp-webui --version`, the server's own). `--tar` also packs the folder as `<folder>.tar.gz`, with the folder as its one
 * top entry: dist/omp-webui-linux-<arch>.tar.gz by default.
 */
import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import pkg from "../package.json";
import { readMaster, renderIcon } from "./icons.ts";
import { encodePng } from "./lib/png.ts";

const ARCHES: Record<string, true> = { x64: true, arm64: true };

const root = join(import.meta.dir, "..");
const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : undefined;
};
const arch = arg("arch") ?? process.arch;
if (!ARCHES[arch]) {
	console.error(`--arch wants x64 or arm64, not ${arch}`);
	process.exit(1);
}
const version = arg("version") ?? pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
	console.error(`--version wants x.y.z, not ${version}`);
	process.exit(1);
}
const outArg = arg("out");
const out = outArg ? resolve(root, outArg) : join(root, "dist", `omp-webui-linux-${arch}`);
// The folder is emptied before the build: only one that is new, empty or an earlier build's, never the checkout or a
// folder that holds it.
const rel = relative(out, root);
const holdsCheckout = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
const earlierBuild = existsSync(join(out, "omp-webui")) && existsSync(join(out, "install.sh"));
if (holdsCheckout || (existsSync(out) && readdirSync(out).length > 0 && !earlierBuild)) {
	console.error(`--out ${out}: give a new or empty folder, or an earlier build's (it is emptied first)`);
	process.exit(1);
}
const stage = mkdtempSync(join(tmpdir(), "ompw-linux-"));

async function run(cmd: string[], cwd = root, env?: Record<string, string>): Promise<void> {
	console.log(`$ ${cmd.join(" ")}`);
	const code = await Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "inherit", stderr: "inherit" })
		.exited;
	if (code !== 0) throw new Error(`${cmd[0]} exited with ${code}`);
}

try {
	rmSync(out, { recursive: true, force: true });
	mkdirSync(out, { recursive: true });

	await run(["bunx", "vite", "build"]);
	cpSync(join(root, "dist", "web"), join(out, "web"), { recursive: true });

	// The icon the applications menu shows, rendered the way the macOS app's and the Windows launcher's are.
	writeFileSync(join(out, "omp-webui.png"), encodePng(renderIcon(readMaster(), 256, "plate")));

	const installer = join(out, "install.sh");
	copyFileSync(join(root, "scripts", "linux-install.sh"), installer);
	chmodSync(installer, 0o755);

	// Run from the staging dir: `bun build --compile` leaves a `.*.bun-build` temp file in its cwd.
	await run(
		[
			"bun",
			"build",
			"--compile",
			"--minify",
			`--target=bun-linux-${arch}`,
			...(version === pkg.version ? [] : [`--define=OMPW_BUILD_VERSION=${JSON.stringify(version)}`]),
			join(root, "server", "launcher.ts"),
			// The workers the server starts by relative URLs (see scripts/app.ts): entry points of their own.
			join(root, "server", "family-worker.ts"),
			join(root, "server", "search-index-worker.ts"),
			join(root, "server", "host-gpu-worker.ts"),
			"--outfile",
			join(out, "omp-webui"),
		],
		stage,
	);
	console.log(`\nBuilt ${out}`);

	if (argv.includes("--tar")) {
		const tarball = `${out}.tar.gz`;
		// The folder is the archive's one top entry, its modes kept (the program and install.sh stay executable). macOS's
		// tar would add AppleDouble `._` files for extended attributes: COPYFILE_DISABLE leaves them out.
		await run(["tar", "-czf", tarball, "-C", dirname(out), basename(out)], root, { COPYFILE_DISABLE: "1" });
		console.log(`Packed ${tarball}`);
	}
} finally {
	rmSync(stage, { recursive: true, force: true });
}
