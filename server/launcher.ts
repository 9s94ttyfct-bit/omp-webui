/**
 * The launcher: what a double-click runs. It is the program of the Windows launcher (`omp-webui.exe`, built by
 * scripts/windows-launcher.ts) and of the Linux package (`omp-webui`, built by scripts/linux-package.ts, started from
 * the applications menu or the `omp-webui` command its install.sh writes). It is the server, with what a program started
 * from Explorer or a menu cannot be told:
 *
 * - The web UI is the `web` folder beside the program (unless `OMP_WEBUI_DIST` says).
 * - A taken port is no error: the next free one is taken (`OMP_WEBUI_PORT_WINDOW`).
 * - The page opens in the default browser once the server listens, with the access token in its address.
 * - When this data folder's server already runs (a second double-click), its page is opened and nothing else starts. Two
 *   started together decide one after the other (`holdStart`): the second waits for the first one's server, then opens its page.
 * - On Windows it updates itself from the releases (Settings › Updates): the folder it is in is the one the updater
 *   replaces (`OMP_WEBUI_APP_FOLDER`, server/update/windows.ts and helper.ps1). The Linux package does not: the server
 *   takes that folder only on Windows (server/main.ts), and a newer package is installed with its install.sh.
 *
 * Its console window (on Linux, the terminal the menu entry opens) is the server's: it says where the page is, and
 * closing it stops the server. An error while starting is left on the screen until Enter is pressed, rather than closing
 * the window with it.
 *
 * `BROWSER` names another program to open the page with (it is given the address); it is also how the tests see
 * which page was opened.
 *
 * `omp-webui --version` prints the version and ends (no server, no page): the updater checks a staged program with it.
 *
 * `omp-webui --background` is what the system starts at login when Settings › Start at login is on (server/login-start.ts):
 * the server starts and no page is opened (nor is one when this data folder's server already runs). On Windows its console
 * window is minimized (the `Run` value starts it with `start /min`); on Linux it has no terminal, and `omp-webui --stop`
 * stops it (it stops this data folder's server, however it was started).
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Auth } from "./auth.ts";
import { loadConfig } from "./config.ts";
import { holdStart, runningServer } from "./instance.ts";
import { platform } from "./platform/index.ts";
import { APP_VERSION } from "./version.ts";

if (process.argv.slice(2).includes("--version")) {
	console.log(APP_VERSION);
	process.exit(0);
}

const background = process.argv.slice(2).includes("--background");
const folder = dirname(process.execPath);
const web = join(folder, "web");
if (!process.env.OMP_WEBUI_DIST && existsSync(web)) process.env.OMP_WEBUI_DIST = web;
// The folder this program came in (it and `web/`, as the release's zip holds them) is what the updater replaces, and the
// program is what starts at login. Run from source (`bun server/launcher.ts`) the program is Bun, and nothing beside it is ours.
if (existsSync(web)) {
	process.env.OMP_WEBUI_APP_FOLDER = folder;
	process.env.OMP_WEBUI_LAUNCHER ??= process.execPath;
}
process.env.OMP_WEBUI_PORT_WINDOW ??= "1";

/** The page of the server on `port`, signed in. */
function pageOf(dataDir: string, port: number): string {
	return new Auth(dataDir).link(`http://127.0.0.1:${port}`);
}

async function openPage(url: string): Promise<void> {
	const argv = process.env.BROWSER ? [process.env.BROWSER, url] : platform.openUrlArgv(url);
	try {
		await Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited;
	} catch (e) {
		console.error(`omp-webui: the browser could not be opened (${(e as Error).message}): open ${url} yourself.`);
	}
}

/** Leave a message on the screen of a console that closes when the program ends, until Enter is pressed. */
async function holdWindow(): Promise<void> {
	if (!process.stdin.isTTY) return;
	console.error("\nPress Enter to close this window.");
	for await (const _ of console) break;
}

// Lets go of the start of this data folder's server (`holdStart`): once it has recorded itself, or this launcher ends or fails.
let letGo = () => {};
try {
	const { dataDir } = loadConfig();
	if (process.argv.slice(2).includes("--stop")) {
		const running = runningServer(dataDir);
		if (!running) {
			console.log("omp-webui is not running.");
			process.exit(0);
		}
		process.kill(running.pid, "SIGTERM");
		const until = Date.now() + 15_000;
		while (runningServer(dataDir) && Date.now() < until) await Bun.sleep(100);
		if (runningServer(dataDir)) throw new Error(`the server (pid ${running.pid}) did not stop within 15 s`);
		console.log("omp-webui is stopped.");
		process.exit(0);
	}
	letGo = await holdStart(dataDir);
	process.on("exit", letGo);
	const running = runningServer(dataDir);
	if (running) {
		if (background) {
			console.log(`omp-webui is already running (port ${running.port}).`);
			process.exit(0);
		}
		console.log(`omp-webui is already running (port ${running.port}): opening its page.`);
		await openPage(pageOf(dataDir, running.port));
		process.exit(0);
	}
	// The server's modules read their configuration as they load: they are loaded only now that it is set.
	await import("./main.ts");
	const self = runningServer(dataDir);
	if (!self) throw new Error("the server did not record the port it listens on");
	letGo();
	if (background) {
		console.log(`\nomp-webui is running in the background (port ${self.port}). Open omp-webui again to see its page.`);
	} else {
		await openPage(pageOf(dataDir, self.port));
		console.log("\nomp-webui is running and its page is open in your browser. Close this window to stop it.");
	}
} catch (e) {
	letGo();
	console.error(`omp-webui could not start: ${(e as Error).message}`);
	await holdWindow();
	process.exit(1);
}
