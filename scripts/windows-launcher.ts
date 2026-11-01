/**
 * Builds the Windows launcher (`bun run windows-launcher`, on Windows) → dist/omp-webui-windows-x64:
 *
 *   omp-webui.exe   the launcher (server/launcher.ts): the Bun server compiled with its runtime, with the app's icon
 *   web/            the built web UI
 *
 * A double-click on omp-webui.exe starts the server and opens its page in the default browser. omp is not bundled:
 * the first-run page installs it. CI builds it and zips the folder (the `windows-launcher` job); a release attaches
 * that zip.
 *
 * It runs on Windows only: Bun writes the icon and the version details into the program only when it compiles on
 * Windows (a cross-compile refuses the `--windows-*` options).
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const out = join(root, "dist", "omp-webui-windows-x64");
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
			"--target=bun-windows-x64",
			`--windows-icon=${icon}`,
			"--windows-title=omp-webui",
			"--windows-description=omp-webui",
			`--windows-version=${pkg.version}.0`,
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
