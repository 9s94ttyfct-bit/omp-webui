/**
 * The Windows launcher (`omp-webui.exe`, built by scripts/windows-launcher.ts): what a double-click runs. It is the
 * server, with what a program started from Explorer cannot be told:
 *
 * - The web UI is the `web` folder beside the program (unless `OMP_WEBUI_DIST` says).
 * - A taken port is no error: the next free one is taken (`OMP_WEBUI_PORT_WINDOW`).
 * - The page opens in the default browser once the server listens, with the access token in its address.
 * - When this data folder's server already runs (a second double-click), its page is opened and nothing else starts.
 *
 * Its console window is the server's: it says where the page is, and closing it stops the server. An error while
 * starting is left on the screen until Enter is pressed, rather than closing the window with it.
 *
 * `BROWSER` names another program to open the page with (it is given the address); it is also how the tests see
 * which page was opened.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Auth } from "./auth.ts";
import { loadConfig } from "./config.ts";
import { runningServer } from "./instance.ts";
import { platform } from "./platform/index.ts";

const web = join(dirname(process.execPath), "web");
if (!process.env.OMP_WEBUI_DIST && existsSync(web)) process.env.OMP_WEBUI_DIST = web;
process.env.OMP_WEBUI_PORT_WINDOW ??= "1";

/** The page of the server on `port`, signed in. */
function pageOf(dataDir: string, port: number): string {
	const token = new Auth(dataDir).token;
	return `http://127.0.0.1:${port}/${token ? `?token=${token}` : ""}`;
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

try {
	const { dataDir } = loadConfig();
	const running = runningServer(dataDir);
	if (running) {
		console.log(`omp-webui is already running (port ${running.port}): opening its page.`);
		await openPage(pageOf(dataDir, running.port));
		process.exit(0);
	}
	// The server's modules read their configuration as they load: they are loaded only now that it is set.
	await import("./main.ts");
	const self = runningServer(dataDir);
	if (!self) throw new Error("the server did not record the port it listens on");
	await openPage(pageOf(dataDir, self.port));
	console.log("\nomp-webui is running and its page is open in your browser. Close this window to stop it.");
} catch (e) {
	console.error(`omp-webui could not start: ${(e as Error).message}`);
	await holdWindow();
	process.exit(1);
}
