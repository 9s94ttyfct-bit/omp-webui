import { afterAll, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../../package.json";
import { writeBunProgram } from "../support/bun-program.ts";
import { hostEnv, isolatedEnv } from "../support/omp-env.ts";
import { pollUntil } from "../support/poll.ts";
import { removeScratch } from "../support/scratch.ts";

/**
 * The launcher (`server/launcher.ts`, built as the Windows launcher's `omp-webui.exe` and the Linux package's
 * `omp-webui`): a double-click starts the server and opens its page in the browser; a second one opens the page of the
 * server that runs. The browser is a program of the test's own (`BROWSER`), which writes down each address it is given.
 * `OMPW_LAUNCHER_EXE` runs the built program instead of the source (the Windows launcher and Linux package jobs in CI):
 * its page is then the `web` folder beside it.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-launcher-"));
const opened = join(root, "opened.txt");
const browser = writeBunProgram(
	root,
	"browser",
	`import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(opened)}, process.argv.at(-1) + "\\n");\n`,
);
const exe = process.env.OMPW_LAUNCHER_EXE;
const command = exe ? [exe] : ["bun", join(import.meta.dir, "..", "..", "server", "launcher.ts")];
const started: ChildProcess[] = [];

afterAll(async () => {
	for (const child of started) child.kill("SIGKILL");
	await Bun.sleep(200);
	removeScratch(root);
});

async function launch(extra: Record<string, string>, args: string[] = []) {
	const env = await isolatedEnv(join(root, "world"), { login: false });
	const child = spawn(command[0], [...command.slice(1), ...args], {
		env: {
			...hostEnv(),
			...env,
			BROWSER: browser,
			OMP_WEBUI_UPDATE_CHECK: "off",
			OMP_WEBUI_AUTO_TITLE: "off",
			...extra,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	started.push(child);
	let out = "";
	child.stdout?.on("data", (d: Buffer) => {
		out += d.toString();
	});
	child.stderr?.on("data", (d: Buffer) => {
		out += d.toString();
	});
	const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
	return { child, output: () => out, exited };
}

const pages = () => (existsSync(opened) ? readFileSync(opened, "utf8").split("\n").filter(Boolean) : []);
const dataDir = join(root, "data");

test("a double-click starts the server on the next free port and opens its page, signed in", async () => {
	// The port it is told is taken: a program started from Explorer cannot be told another, so it takes the next one.
	const taken = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("someone else") });
	try {
		const first = await launch({ OMP_WEBUI_DATA_DIR: dataDir, OMP_WEBUI_PORT: String(taken.port) });
		await pollUntil(() => pages().length === 1, `the page to be opened; output:\n${first.output()}`, 60_000);
		const url = new URL(pages()[0]);
		expect(url.hostname).toBe("127.0.0.1");
		const port = Number(url.port);
		expect(port).toBeGreaterThan(taken.port as number);
		expect(port).toBeLessThanOrEqual((taken.port as number) + 20);
		// The address carries this data folder's token, which signs the page in.
		const token = readFileSync(join(dataDir, "token"), "utf8").trim();
		expect(url.searchParams.get("token")).toBe(token);
		const meta = await fetch(`http://127.0.0.1:${port}/api/meta`, {
			headers: { "x-omp-webui-token": token, "x-omp-webui": "1" },
		});
		expect(meta.status).toBe(200);
		if (exe) {
			// The built program serves the web UI beside it.
			const page = await fetch(url);
			expect(page.status).toBe(200);
			expect(await page.text()).toContain("<html");
		}
		expect(first.output()).toContain("Close this window to stop it.");

		// A second double-click opens the page of the server that runs, and starts nothing.
		const second = await launch({ OMP_WEBUI_DATA_DIR: dataDir, OMP_WEBUI_PORT: String(taken.port) });
		expect(await second.exited).toBe(0);
		expect(second.output()).toContain("already running");
		expect(pages()).toEqual([pages()[0], pages()[0]]);
		expect(first.child.exitCode).toBeNull();
	} finally {
		taken.stop(true);
	}
}, 120_000);

test("a server that cannot start says why and ends, without waiting for a key nobody can press", async () => {
	// The data folder's place is a file: nothing can be kept there.
	const file = join(root, "not-a-folder");
	writeFileSync(file, "");
	const run = await launch({ OMP_WEBUI_DATA_DIR: file });
	expect(await run.exited).toBe(1);
	expect(run.output()).toContain("omp-webui could not start:");
}, 60_000);

test("--version prints the version and ends: no server, no page, no data folder", async () => {
	const folder = join(root, "version-data");
	const before = pages().length;
	const run = await launch({ OMP_WEBUI_DATA_DIR: folder }, ["--version"]);
	expect(await run.exited).toBe(0);
	expect(run.output()).toBe(`${pkg.version}\n`);
	expect(existsSync(folder)).toBe(false);
	expect(pages()).toHaveLength(before);
}, 60_000);

test("--background starts the server and opens no page; --stop stops it", async () => {
	const folder = join(root, "background-data");
	const before = pages().length;
	const run = await launch({ OMP_WEBUI_DATA_DIR: folder }, ["--background"]);
	await pollUntil(
		() => run.output().includes("running in the background"),
		`the server to start; output:\n${run.output()}`,
		60_000,
	);
	// Started again in the background while it runs: nothing more, and still no page.
	const again = await launch({ OMP_WEBUI_DATA_DIR: folder }, ["--background"]);
	expect(await again.exited).toBe(0);
	expect(again.output()).toContain("already running");
	expect(pages()).toHaveLength(before);

	const stop = await launch({ OMP_WEBUI_DATA_DIR: folder }, ["--stop"]);
	expect(await stop.exited).toBe(0);
	expect(stop.output()).toContain("omp-webui is stopped.");
	await run.exited;
	const none = await launch({ OMP_WEBUI_DATA_DIR: folder }, ["--stop"]);
	expect(await none.exited).toBe(0);
	expect(none.output()).toContain("not running");
}, 120_000);

// The built program only: it is what the entry names (from source the program is Bun, and the switch is not offered).
test.skipIf(!exe)(
	"Start at login writes the system's entry for the program, and takes it away",
	async () => {
		const folder = join(root, "login-data");
		const config = join(root, "xdg");
		const run = await launch({ OMP_WEBUI_DATA_DIR: folder, XDG_CONFIG_HOME: config }, ["--background"]);
		await pollUntil(
			() => run.output().includes("running in the background"),
			`the server to start; output:\n${run.output()}`,
			60_000,
		);
		const port = Number(/port (\d+)/.exec(run.output())?.[1]);
		const token = readFileSync(join(folder, "token"), "utf8").trim();
		const headers = { "x-omp-webui-token": token, "x-omp-webui": "1", "content-type": "application/json" };
		const url = `http://127.0.0.1:${port}/api/login-start`;
		const set = async (on: boolean) =>
			(await fetch(url, { method: "POST", headers, body: JSON.stringify({ on }) })).json() as Promise<unknown>;
		expect(await (await fetch(url, { headers })).json()).toEqual({ available: true, on: false });
		try {
			expect(await set(true)).toEqual({ available: true, on: true });
			if (process.platform === "linux") {
				const entry = readFileSync(join(config, "autostart", "omp-webui.desktop"), "utf8");
				expect(entry).toContain(`Exec="${exe}" --background`);
			} else {
				const value = Bun.spawnSync([
					"reg",
					"query",
					"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
					"/v",
					"omp-webui",
				]);
				expect(value.stdout.toString()).toContain(`start "" /min "${exe}" --background`);
			}
		} finally {
			expect(await set(false)).toEqual({ available: true, on: false });
		}
		if (process.platform === "linux") expect(existsSync(join(config, "autostart", "omp-webui.desktop"))).toBe(false);
		await launch({ OMP_WEBUI_DATA_DIR: folder }, ["--stop"]);
	},
	120_000,
);
