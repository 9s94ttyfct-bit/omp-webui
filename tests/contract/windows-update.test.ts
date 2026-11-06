// needs: windowsLauncher
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import pkg from "../../package.json";
import { runningServer } from "../../server/instance.ts";
import { tarCommand, WINDOWS_EXE, type WindowsArch, zipTop } from "../../server/update/windows.ts";
import type { AppUpdateState, UpdateSnapshot } from "../../shared/update.ts";
import { writeBunProgram } from "../support/bun-program.ts";
import { type FakeReleases, startFakeReleases } from "../support/fake-releases.ts";
import { has } from "../support/needs.ts";
import { hostEnv, isolatedEnv } from "../support/omp-env.ts";
import { pollUntil, processExists } from "../support/poll.ts";
import { removeScratch } from "../support/scratch.ts";

/**
 * The Windows launcher updates itself (server/update/windows.ts, helper.ps1), as a person's copy would: the built launcher
 * (`OMPW_LAUNCHER_EXE`) is copied to a folder of its own and started; a fake GitHub (`OMP_WEBUI_APP_UPDATE_API`) offers a
 * release whose zip is the same launcher built as 99.0.0 (`OMPW_NEXT_ZIP`, CI's windows-launcher job makes both); the page's
 * install request starts it. The server exits, PowerShell swaps the folders and starts the new program, which says it is up.
 * Then: a zip whose program is another version than the release says is refused and changes nothing, and a new program that
 * does not start is taken out again, the old folder put back and started. The browser is a program of the test's own
 * (`BROWSER`): a launcher opens its page with it.
 */

const exe = process.env.OMPW_LAUNCHER_EXE ?? "";
const nextZip = process.env.OMPW_NEXT_ZIP ?? "";
const root = mkdtempSync(join(tmpdir(), "ompw-win-update-"));
/** The built launcher's processor: this runner's (CI builds each natively), whose zip and top folder the updater takes. */
const ARCH: WindowsArch = process.arch === "arm64" ? "arm64" : "x64";
const ZIP_TOP = zipTop(ARCH);
const zipName = (version: string) => `omp-webui-v${version}-windows-${ARCH}.zip`;
const opened = join(root, "opened.txt");
const NEXT = "99.0.0";
let fake: FakeReleases;
let browser: string;
const started: ChildProcess[] = [];
const dataDirs: string[] = [];
let counter = 0;

beforeAll(async () => {
	fake = await startFakeReleases();
	browser = writeBunProgram(
		root,
		"browser",
		`import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(opened)}, process.argv.at(-1) + "\\n");\n`,
	);
});

/** Every server a test started, and those the helper started after it (found by their data folder's record), ended. */
async function stopAll(): Promise<void> {
	const pids: number[] = [];
	for (const child of started.splice(0)) {
		child.kill();
		if (child.pid !== undefined) pids.push(child.pid);
	}
	for (const data of dataDirs.splice(0)) {
		const server = runningServer(data);
		if (!server) continue;
		pids.push(server.pid);
		try {
			process.kill(server.pid);
		} catch {
			// gone already
		}
	}
	// Their programs stay locked in their folders until they have ended: the folders are removed after that.
	await pollUntil(() => pids.every((pid) => !processExists(pid)), "the test's servers to end", 30_000);
}

afterEach(stopAll);
afterAll(async () => {
	await stopAll();
	await fake?.stop();
	removeScratch(root);
});

interface Install {
	folder: string;
	data: string;
	update: string;
	/** What the launcher this test started printed (its server's own log). */
	output(): string;
}

/** A copy of the built launcher in a folder of its own, started as a double-click would, and its server up. */
async function startInstall(): Promise<Install> {
	const dir = join(root, `case-${++counter}`);
	const folder = join(dir, ZIP_TOP);
	cpSync(dirname(exe), folder, { recursive: true });
	const data = join(dir, "data");
	dataDirs.push(data);
	const env = await isolatedEnv(join(dir, "world"), { login: false });
	const child = spawn(join(folder, WINDOWS_EXE), [], {
		cwd: folder,
		env: {
			...hostEnv(),
			...env,
			BROWSER: browser,
			OMP_WEBUI_DATA_DIR: data,
			OMP_WEBUI_AUTO_TITLE: "off",
			OMP_WEBUI_APP_UPDATE_API: fake.url,
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
	await pollUntil(() => runningServer(data) !== null, `the launcher's server to start; output:\n${out}`, 60_000);
	return { folder, data, update: join(data, "update"), output: () => out };
}

async function api(install: Install, path: string, body?: unknown): Promise<Response> {
	const server = runningServer(install.data);
	if (!server) throw new Error("no server runs for this install");
	const token = readFileSync(join(install.data, "token"), "utf8").trim();
	return fetch(`http://127.0.0.1:${server.port}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: { "x-omp-webui-token": token, "x-omp-webui": "1", "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

/** Look for the release just published and start installing it. */
async function installRelease(install: Install, tag: string): Promise<void> {
	expect((await api(install, "/api/update/check", {})).status).toBe(200);
	const answer = await api(install, "/api/update/install", { tag, anyway: true });
	expect(answer.status, await answer.clone().text()).toBe(200);
}

/** The update state the install's server says now (`GET /api/update`, this app's own answer). */
async function updateState(install: Install): Promise<AppUpdateState> {
	const snapshot: UpdateSnapshot = await (await api(install, "/api/update")).json();
	return snapshot.state;
}

const versionOf = (folder: string): string =>
	execFileSync(join(folder, WINDOWS_EXE), ["--version"], { encoding: "utf8" }).trim();

const readJson = (file: string): Record<string, unknown> | null => {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
};

/** The files in `dir`, one per line with its size, or why they cannot be listed. */
function listing(dir: string): string {
	try {
		return readdirSync(dir)
			.map((name) => {
				const st = statSync(join(dir, name));
				return `  ${name}${st.isDirectory() ? "/" : ` (${st.size} bytes)`}`;
			})
			.join("\n");
	} catch (e) {
		return `  (${(e as Error).message})`;
	}
}

/**
 * Everything there is to know of an update that did not end as it should: the update folder and the small files the
 * server, the helper and the new server tell each other things by, the helper's log, what is beside the install folder,
 * what the launcher printed, and what its server (or the one started after it) says of the update now.
 */
async function diagnosis(install: Install): Promise<string> {
	const parts = [`update folder ${install.update}:\n${listing(install.update)}`];
	for (const name of existsSync(install.update) ? readdirSync(install.update) : []) {
		if (/\.json$|^helper-started-|\.log$/.test(name)) {
			parts.push(`--- ${name}:\n${readFileSync(join(install.update, name), "utf8")}`);
		}
	}
	parts.push(`beside the install folder ${dirname(install.folder)}:\n${listing(dirname(install.folder))}`);
	parts.push(`--- the launcher's output:\n${install.output()}`);
	try {
		const state = await updateState(install);
		parts.push(`--- /api/update now: ${JSON.stringify({ ...state, latest: state.latest?.tag })}`);
	} catch (e) {
		parts.push(`--- /api/update now: ${(e as Error).message}`);
	}
	return parts.join("\n");
}

/** Wait for `condition`; a wait that ends without it says everything `diagnosis` finds. */
async function untilHelper(install: Install, condition: () => boolean, what: string, ms: number): Promise<void> {
	try {
		await pollUntil(condition, what, ms);
	} catch (e) {
		throw new Error(`${(e as Error).message}\n${await diagnosis(install)}`);
	}
}

describe.skipIf(!has.windowsLauncher)("the Windows launcher's update", () => {
	test("installs the release: the new program is in the folder, says it is up, and the old folder is removed", async () => {
		const install = await startInstall();
		expect(versionOf(install.folder)).toBe(pkg.version);
		fake.publish({ tag: `v${NEXT}`, dmg: nextZip, assetName: zipName(NEXT) });
		await installRelease(install, `v${NEXT}`);
		const result = join(install.update, "result.json");
		await untilHelper(
			install,
			() => readJson(result)?.ok === true && readJson(result)?.to === NEXT,
			"the new version to say it is up",
			240_000,
		);
		expect(readJson(result)).toMatchObject({ ok: true, from: pkg.version, to: NEXT });
		await untilHelper(install, () => !existsSync(`${install.folder}.previous`), "the old folder to be removed", 30_000);
		expect(versionOf(install.folder)).toBe(NEXT);
		expect(existsSync(join(install.folder, "web", "index.html"))).toBe(true);
		expect(existsSync(`${install.folder}.updating`)).toBe(false);
		expect(existsSync(join(install.update, "handover.json"))).toBe(false);
		// The new server says so to the page as well.
		const state = await updateState(install);
		expect(state.installed).toBe(NEXT);
		expect(state.outcome).toMatchObject({ ok: true, to: NEXT });
	}, 300_000);

	test("refuses a zip whose program is not the version the release says, and changes nothing", async () => {
		const install = await startInstall();
		// The 99.0.0 build offered as 98.0.0: the SHA-256 is right (it is the asset's), the version is not.
		fake.publish({ tag: "v98.0.0", dmg: nextZip, assetName: zipName("98.0.0") });
		await installRelease(install, "v98.0.0");
		let failed: AppUpdateState["failed"] = null;
		// Asked every half second, not every 25 ms: this process also serves the release's zip (`fake`), and on Windows asking
		// its server 40 times a second starved that download (timed in CI: 0.3-0.5 s unasked, 6-41 s asked, the test's own event
		// loop up to 0.6 s late), which is why arm64 took 66-86 s here. A wait that ends without the refusal says where the
		// install got to (its phase, the launcher's output), as `untilHelper` does.
		try {
			await pollUntil(
				async () => {
					failed = (await updateState(install)).failed;
					return failed !== null;
				},
				"the install to be refused",
				120_000,
				500,
			);
		} catch (e) {
			throw new Error(`${(e as Error).message}\n${await diagnosis(install)}`);
		}
		expect(failed).toMatchObject({ code: "version", params: { tag: "v98.0.0", found: NEXT } });
		expect(versionOf(install.folder)).toBe(pkg.version);
		expect(existsSync(`${install.folder}.updating`)).toBe(false);
		expect(existsSync(join(install.update, "handover.json"))).toBe(false);
		expect(runningServer(install.data)).not.toBeNull();
	}, 180_000);

	test("a new program that does not start is taken out: the old folder is back and started, and says why", async () => {
		const install = await startInstall();
		// The release's folder with a program that says it is 99.0.0 when asked and otherwise ends at once, unsuccessfully.
		const work = mkdtempSync(join(root, "broken-"));
		const top = join(work, ZIP_TOP);
		cpSync(dirname(exe), top, { recursive: true });
		const source = join(work, "stand-in.ts");
		writeFileSync(
			source,
			`if (process.argv.includes("--version")) console.log(${JSON.stringify(NEXT)});\nelse process.exit(1);\n`,
		);
		rmSync(join(top, WINDOWS_EXE));
		execFileSync("bun", ["build", "--compile", source, "--outfile", join(top, WINDOWS_EXE)], { stdio: "ignore" });
		const zip = join(work, zipName(NEXT));
		execFileSync(tarCommand(), ["-a", "-cf", zip, ZIP_TOP], { cwd: work });

		fake.publish({ tag: `v${NEXT}`, dmg: zip, assetName: zipName(NEXT) });
		await installRelease(install, `v${NEXT}`);
		const result = join(install.update, "result.json");
		await untilHelper(
			install,
			() => readJson(result)?.ok === false,
			"the helper to give up on the new program",
			240_000,
		);
		expect(readJson(result)).toMatchObject({ ok: false, from: pkg.version, to: NEXT, problem: "didNotStart" });
		// The old program is back in its place and was started again.
		expect(versionOf(install.folder)).toBe(pkg.version);
		for (const left of [".previous", ".failed", ".updating"]) {
			expect(existsSync(`${install.folder}${left}`), left).toBe(false);
		}
		await untilHelper(
			install,
			() => runningServer(install.data) !== null,
			"the old version to be started again",
			60_000,
		);
		const state = await updateState(install);
		expect(state.installed).toBe(pkg.version);
		expect(state.outcome).toMatchObject({ ok: false, problem: "didNotStart" });
	}, 300_000);
});
