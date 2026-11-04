import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Zippable, zipSync } from "fflate";
import pkg from "../../package.json";
import { platformId } from "../../server/platform/capabilities.ts";
import { AppUpdater, type InstallTarget } from "../../server/update/service.ts";
import { UpdateError } from "../../server/update/steps.ts";
import {
	memberAllowed,
	powershellCommand,
	stageWindows,
	startHidden,
	tarCommand,
	WINDOWS_EXE,
	type WindowsArch,
	zipTop,
} from "../../server/update/windows.ts";
import type { AppUpdateState } from "../../shared/update.ts";
import { writeBunProgram } from "../support/bun-program.ts";
import { type FakeReleases, startFakeReleases } from "../support/fake-releases.ts";
import { has } from "../support/needs.ts";
import { pollUntil, processExists } from "../support/poll.ts";
import { removeScratch } from "../support/scratch.ts";

/**
 * The Windows launcher's update, the part of it any system can run (`server/update/windows.ts`, and the service's Windows
 * install up to the handover): which zips are refused before anything is unpacked (a member that could land outside the
 * folder, a link, a second top folder), which are refused after (no program, no page, the wrong version), and what the
 * server hands to `helper.ps1`. The zips are made here, member by member; `tar` is the system's (bsdtar on macOS, as
 * `tar.exe` is on Windows). The program in a zip is a stand-in that prints a version. The swap itself is PowerShell's and
 * runs on Windows only (tests/contract/windows-update.test.ts).
 */

const root = mkdtempSync(join(tmpdir(), "ompw-win-update-"));
/** The x64 launcher's zip folder: the cases below are an x64 launcher's unless they say Arm. */
const ZIP_TOP = zipTop("x64");
/**
 * Whether this system's `tar` reads zips as Windows' `tar.exe` does: a bsdtar (Windows', macOS's, or `bsdtar` on Linux).
 * GNU tar does not read zips, so where it is the only one the cases that unpack one skip.
 */
const readsZips = platformId === "win32" || /bsdtar/.test(Bun.spawnSync([tarCommand(), "--version"]).stdout.toString());
let fake: FakeReleases;
let counter = 0;

beforeAll(async () => {
	fake = await startFakeReleases();
});
afterAll(async () => {
	await fake.stop();
	removeScratch(root);
});

/** A zip entry with Unix attributes (the mode the zip records, as `zip` on a Mac or Linux would). */
const entry = (bytes: Uint8Array, mode: number): Zippable[string] => [bytes, { os: 3, attrs: (mode << 16) >>> 0 }];
const text = (s: string) => new TextEncoder().encode(s);

/**
 * The files of a program that prints `version` for `--version`: on Windows `omp-webui.exe` (a small Bun program) and the
 * script it runs, `omp-webui.ts`; elsewhere `omp-webui.exe` itself, a script with a `#!` line.
 */
function standInProgram(version: string): Record<string, Uint8Array> {
	const dir = mkdtempSync(join(root, "program-"));
	const source = `if (process.argv.includes("--version")) console.log(${JSON.stringify(version)});\nelse process.exit(1);\n`;
	writeBunProgram(dir, platformId === "win32" ? "omp-webui" : WINDOWS_EXE, source);
	return Object.fromEntries(readdirSync(dir).map((name) => [name, new Uint8Array(readFileSync(join(dir, name)))]));
}

/**
 * The members of a release's zip as CI makes it: the top folder (`top`, the x64 zip's by default), the program saying
 * `version`, and `web/index.html`.
 */
function releaseMembers(version: string, top = ZIP_TOP): Zippable {
	const members: Zippable = {
		[`${top}/`]: entry(new Uint8Array(), 0o40755),
		[`${top}/web/`]: entry(new Uint8Array(), 0o40755),
		[`${top}/web/index.html`]: entry(text("<html></html>"), 0o100644),
	};
	for (const [name, bytes] of Object.entries(standInProgram(version))) {
		members[`${top}/${name}`] = entry(bytes, 0o100755);
	}
	return members;
}

function writeZip(members: Zippable): string {
	const file = join(root, `release-${++counter}.zip`);
	writeFileSync(file, zipSync(members, { level: 0 }));
	return file;
}

/** A folder to install into: `<dir>/omp-webui-windows-<arch>` is the installed launcher, its staged copy is beside it. */
function installDir(arch: WindowsArch = "x64"): { dir: string; staged: string } {
	const dir = mkdtempSync(join(root, "install-"));
	return { dir, staged: join(dir, `${zipTop(arch)}.updating`) };
}

async function refusal(promise: Promise<unknown>): Promise<UpdateError> {
	const e = await promise.then(
		() => null,
		(err: unknown) => err,
	);
	if (!(e instanceof UpdateError)) throw new Error(`expected an UpdateError, got ${String(e)}`);
	return e;
}

test.skipIf(platformId !== "win32")("helper.ps1 parses in Windows PowerShell, which runs it", () => {
	const script = join(import.meta.dir, "..", "..", "server", "update", "helper.ps1");
	const check = `$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${script}', [ref]$null, [ref]$errors); $errors | ForEach-Object { $_.ToString() }; exit @($errors).Count`;
	const ran = Bun.spawnSync([powershellCommand(), "-NoProfile", "-NonInteractive", "-Command", check]);
	expect(`${ran.stdout}${ran.stderr}`.trim()).toBe("");
	expect(ran.exitCode).toBe(0);
});

test.skipIf(platformId !== "win32")(
	"startHidden runs a PowerShell script apart from this process, with values that hold spaces and quotes",
	async () => {
		const dir = mkdtempSync(join(root, "start 'hidden' x-"));
		const script = join(dir, "write it.ps1");
		writeFileSync(script, "param([string]$Out, [string]$Text)\n[System.IO.File]::WriteAllText($Out, $Text)\n");
		const out = join(dir, "out file.txt");
		const pid = await startHidden(
			powershellCommand(),
			["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Out", out, "-Text", "it's here"],
			{ cwd: dir, env: process.env },
		);
		expect(pid).toBeGreaterThan(0);
		await pollUntil(() => existsSync(out), "the script to write its file", 30_000);
		expect(readFileSync(out, "utf8")).toBe("it's here");
	},
);

test("helper.ps1 is ASCII: Windows PowerShell reads a script without a byte-order mark in the ANSI code page", () => {
	const script = readFileSync(join(import.meta.dir, "..", "..", "server", "update", "helper.ps1"), "utf8");
	expect([...script].filter((c) => c.charCodeAt(0) > 0x7f)).toEqual([]);
});

// ------------------------------------------------------------------ the members

test("a member is allowed only under the one top folder, relative, without `..`, a drive or a stream", () => {
	for (const ok of [`${ZIP_TOP}/`, `${ZIP_TOP}/omp-webui.exe`, `${ZIP_TOP}/web/index.html`, `${ZIP_TOP}\\web\\a.js`]) {
		expect(memberAllowed(ok, ZIP_TOP), ok).toBe(true);
	}
	for (const bad of [
		"",
		"/etc/passwd",
		"\\Windows\\x",
		"C:/x",
		"c:x",
		`${ZIP_TOP}/web/index.html:stream`,
		`${ZIP_TOP}/../evil`,
		`${ZIP_TOP}\\..\\..\\evil`,
		`${ZIP_TOP}//x`,
		"../x",
		"other/x",
		`${ZIP_TOP}-2/x`,
		"omp-webui.exe",
	]) {
		expect(memberAllowed(bad, ZIP_TOP), bad).toBe(false);
	}
});

test("each processor's zip has a top folder of its own, and a launcher takes only its own processor's", () => {
	expect(zipTop("x64")).toBe("omp-webui-windows-x64");
	expect(zipTop("arm64")).toBe("omp-webui-windows-arm64");
	expect(memberAllowed("omp-webui-windows-arm64/omp-webui.exe", zipTop("arm64"))).toBe(true);
	expect(memberAllowed("omp-webui-windows-x64/omp-webui.exe", zipTop("arm64"))).toBe(false);
	expect(memberAllowed("omp-webui-windows-arm64/omp-webui.exe", zipTop("x64"))).toBe(false);
});

// ------------------------------------------------------------------ staging

test.skipIf(!readsZips)(
	"the release's zip is unpacked into the staged folder, its top folder unwrapped, and nothing else is left",
	async () => {
		const { dir, staged } = installDir();
		const phases: string[] = [];
		await stageWindows(writeZip(releaseMembers("9.0.0")), staged, "9.0.0", "x64", {
			onUnpack: () => phases.push("unpack"),
		});
		expect(phases).toEqual(["unpack"]);
		expect(existsSync(join(staged, WINDOWS_EXE))).toBe(true);
		expect(readFileSync(join(staged, "web", "index.html"), "utf8")).toBe("<html></html>");
		expect(existsSync(join(staged, ZIP_TOP))).toBe(false);
		// Only the staged folder beside the install: the folder it was unpacked into is gone.
		expect(readdirSync(dir)).toEqual([`${ZIP_TOP}.updating`]);
	},
);

test.skipIf(!readsZips)(
	"an Arm launcher stages the arm64 zip, and refuses the x64 one before anything is unpacked",
	async () => {
		const arm = zipTop("arm64");
		const { dir, staged } = installDir("arm64");
		await stageWindows(writeZip(releaseMembers("9.0.0", arm)), staged, "9.0.0", "arm64");
		expect(existsSync(join(staged, WINDOWS_EXE))).toBe(true);
		expect(readdirSync(dir)).toEqual([`${arm}.updating`]);

		const other = installDir("arm64");
		const e = await refusal(
			stageWindows(writeZip(releaseMembers("9.0.0")), other.staged, "9.0.0", "arm64", {
				onUnpack: () => {
					throw new Error("the x64 zip was unpacked");
				},
			}),
		);
		expect(e.code).toBe("noApp");
		expect(e.params).toEqual({ name: arm });
		expect(readdirSync(other.dir)).toEqual([]);
	},
);

test.skipIf(!readsZips)(
	"a program that says another version is refused with both versions, and the staged folder is removed",
	async () => {
		const { dir, staged } = installDir();
		const e = await refusal(stageWindows(writeZip(releaseMembers("8.0.0")), staged, "9.0.0", "x64"));
		expect(e.code).toBe("version");
		expect(e.params).toEqual({ tag: "v9.0.0", found: "8.0.0" });
		expect(readdirSync(dir)).toEqual([]);
	},
);

test.skipIf(!readsZips)(
	"a zip with a member that could land outside its folder, a link or a second top folder is refused before anything is unpacked",
	async () => {
		const good = releaseMembers("9.0.0");
		const cases: Record<string, Zippable> = {
			traversal: { ...good, [`${ZIP_TOP}/../evil.txt`]: entry(text("x"), 0o100644) },
			backslashTraversal: { ...good, [`${ZIP_TOP}\\..\\..\\evil.txt`]: entry(text("x"), 0o100644) },
			absolute: { ...good, "/tmp/evil.txt": entry(text("x"), 0o100644) },
			driveRooted: { ...good, "C:/evil.txt": entry(text("x"), 0o100644) },
			link: { ...good, [`${ZIP_TOP}/web/link`]: entry(text("/etc/passwd"), 0o120777) },
			secondTopFolder: { ...good, "other/readme.txt": entry(text("x"), 0o100644) },
			fileAtTop: { ...good, "readme.txt": entry(text("x"), 0o100644) },
		};
		for (const [name, members] of Object.entries(cases)) {
			const { dir, staged } = installDir();
			const e = await refusal(
				stageWindows(writeZip(members), staged, "9.0.0", "x64", {
					onUnpack: () => {
						throw new Error(`${name}: unpacked`);
					},
				}),
			);
			expect(e.code, name).toBe("noApp");
			expect(readdirSync(dir), name).toEqual([]);
		}
		expect(existsSync(join(root, "evil.txt"))).toBe(false);
	},
);

test.skipIf(!readsZips)(
	"a zip without the program or its page, or that is no zip at all, is refused and leaves nothing",
	async () => {
		const good = releaseMembers("9.0.0");
		const noExe = Object.fromEntries(Object.entries(good).filter(([name]) => !name.includes("omp-webui.")));
		const noPage = Object.fromEntries(Object.entries(good).filter(([name]) => !name.endsWith("index.html")));
		for (const [name, members] of Object.entries({ noExe, noPage })) {
			const { dir, staged } = installDir();
			const e = await refusal(stageWindows(writeZip(members), staged, "9.0.0", "x64"));
			expect(e.code, name).toBe("noApp");
			expect(readdirSync(dir), name).toEqual([]);
		}
		const { dir, staged } = installDir();
		const notZip = join(root, "not-a-zip.zip");
		writeFileSync(notZip, "this is not a zip");
		expect((await refusal(stageWindows(notZip, staged, "9.0.0", "x64"))).code).toBe("noApp");
		expect(readdirSync(dir)).toEqual([]);
	},
);

test.skipIf(!readsZips)(
	"a zip that does not fit on the install folder's volume is refused before it is unpacked",
	async () => {
		const { dir, staged } = installDir();
		const e = await refusal(
			stageWindows(writeZip(releaseMembers("9.0.0")), staged, "9.0.0", "x64", { freeBytes: () => 1024 }),
		);
		expect(e.code).toBe("space");
		expect(e.params.free).toBe(1024);
		expect(readdirSync(dir)).toEqual([]);
	},
);

// ------------------------------------------------------------------ the service, as the launcher runs it

interface Launcher {
	data: string;
	folder: string;
	updater: AppUpdater;
	states: AppUpdateState[];
	quits: number;
	/** The arguments the stand-in for PowerShell was started with, once it has been. */
	helperArgs(): string[] | null;
	/** The stand-in's pid, once it has started. */
	helperPid(): number | null;
}

const launchers: AppUpdater[] = [];
afterEach(() => {
	for (const u of launchers.splice(0)) u.stop();
	fake.publish({ tag: "v0.0.0" });
});

/**
 * A launcher's updater, with a stand-in for PowerShell that records how it was started and then does what `helper.ps1`
 * does first (`starts`: writes `helper-started-<id>` and ends), or never gets that far and stays (`never`: a policy that
 * stops the script). It is an x64 launcher on Windows unless `extra.system` says otherwise, whatever this machine is.
 */
function launcher(
	extra: Partial<ConstructorParameters<typeof AppUpdater>[0]> = {},
	helper: "starts" | "never" = "starts",
): Launcher {
	const system = extra.system ?? { id: "win32" as const, arch: "x64" };
	const dir = mkdtempSync(join(root, "launcher-"));
	const data = join(dir, "data");
	const folder = join(dir, zipTop(system.arch === "arm64" ? "arm64" : "x64"));
	mkdirSync(join(folder, "web"), { recursive: true });
	writeFileSync(join(folder, WINDOWS_EXE), "the installed program");
	writeFileSync(join(folder, "web", "index.html"), "old");
	const argsFile = join(dir, "helper-args.json");
	const pidFile = join(dir, "helper-pid");
	const powershell = writeBunProgram(
		dir,
		"powershell",
		[
			'import { writeFileSync } from "node:fs";',
			'import { join } from "node:path";',
			"const args = process.argv.slice(2);",
			`writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));`,
			`writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
			'const named = (name) => args[args.indexOf("-" + name) + 1];',
			helper === "starts"
				? 'writeFileSync(join(named("StateDir"), "helper-started-" + named("Id")), String(process.pid));'
				: "setInterval(() => {}, 60_000);",
			"",
		].join("\n"),
	);
	const target: InstallTarget = { kind: "windows", folder };
	const l: Launcher = {
		data,
		folder,
		states: [],
		quits: 0,
		helperArgs: () => (existsSync(argsFile) ? JSON.parse(readFileSync(argsFile, "utf8")) : null),
		helperPid: () => (existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : null),
		updater: undefined as unknown as AppUpdater,
	};
	l.updater = new AppUpdater({
		dataDir: data,
		installed: pkg.version,
		target,
		system,
		parentPid: null,
		api: fake.url,
		automatic: false,
		autoChecks: () => true,
		autoInstall: () => false,
		conversations: () => ({ working: 0, asking: 0, paused: 0, waiting: 0 }),
		broadcast: (s) => l.states.push(s),
		// What `startHidden` does on Windows, with the stand-in for PowerShell: started apart from this process, its pid.
		startHelper: async (args) => {
			const child = spawn(powershell, args, { detached: true, stdio: "ignore" });
			child.unref();
			if (child.pid === undefined) throw new Error("the stand-in did not start");
			return child.pid;
		},
		quit: () => {
			l.quits++;
		},
		...extra,
	});
	launchers.push(l.updater);
	return l;
}

const zipName = (version: string, arch: WindowsArch = "x64") => `omp-webui-v${version}-windows-${arch}.zip`;

test.skipIf(!readsZips)(
	"the launcher installs the release's zip: staged beside its folder, checked, and handed to helper.ps1, then it exits",
	async () => {
		const l = launcher();
		expect(l.updater.state().install).toEqual({ allowed: true });
		fake.publish({ tag: "v9.0.0", dmg: writeZip(releaseMembers("9.0.0")), assetName: zipName("9.0.0") });
		await l.updater.check();
		expect(l.updater.state().latest?.asset?.name).toBe(zipName("9.0.0"));
		expect(await l.updater.install("v9.0.0", false)).toHaveProperty("state");
		await pollUntil(() => l.quits > 0, "the launcher to exit after the handover", 30_000);

		const staged = `${l.folder}.updating`;
		expect(existsSync(join(staged, WINDOWS_EXE))).toBe(true);
		expect(readFileSync(join(staged, "web", "index.html"), "utf8")).toBe("<html></html>");
		// Nothing was swapped: that is the helper's, after this server has exited.
		expect(readFileSync(join(l.folder, "web", "index.html"), "utf8")).toBe("old");
		const update = join(l.data, "update");
		// No download left, and the helper's word that it runs was read and removed.
		expect(readdirSync(update).filter((n) => /\.(zip|part)$|^helper-started-/.test(n))).toEqual([]);
		expect(readFileSync(join(update, "helper.ps1"), "utf8")).toContain("param(");
		const handover = JSON.parse(readFileSync(join(update, "handover.json"), "utf8"));
		expect(handover).toMatchObject({
			from: pkg.version,
			to: "9.0.0",
			installed: l.folder,
			staged,
			backup: `${l.folder}.previous`,
		});
		await pollUntil(() => l.helperArgs() !== null, "the helper's arguments", 10_000);
		const args = l.helperArgs() as string[];
		expect(args.slice(0, 7)).toEqual([
			"-NoProfile",
			"-ExecutionPolicy",
			"Bypass",
			"-WindowStyle",
			"Hidden",
			"-File",
			join(update, "helper.ps1"),
		]);
		const named = (name: string) => args[args.indexOf(`-${name}`) + 1];
		expect(named("Id")).toBe(handover.id);
		expect(named("AppPid")).toBe(String(process.pid));
		expect(named("Installed")).toBe(l.folder);
		expect(named("Staged")).toBe(staged);
		expect(named("Backup")).toBe(`${l.folder}.previous`);
		expect(named("StateDir")).toBe(update);
		expect(named("From")).toBe(pkg.version);
		expect(named("To")).toBe("9.0.0");
		expect(named("Exe")).toBe(join(l.folder, WINDOWS_EXE));
		expect(l.updater.state().job?.phase).toBe("handover");
	},
);

test.skipIf(!readsZips)(
	"a helper that never says it runs is ended, the install fails with nothing changed, and the launcher keeps running",
	async () => {
		const l = launcher({ helperStartMs: 1500 }, "never");
		fake.publish({ tag: "v9.0.0", dmg: writeZip(releaseMembers("9.0.0")), assetName: zipName("9.0.0") });
		await l.updater.check();
		await l.updater.install("v9.0.0", false);
		await pollUntil(() => l.updater.state().failed !== null, "the install to fail", 30_000);
		expect(l.updater.state().failed).toEqual({ code: "helper", tag: "v9.0.0", params: {} });
		expect(l.updater.state().job).toBeNull();
		const pid = l.helperPid();
		expect(pid).not.toBeNull();
		await pollUntil(() => !processExists(pid as number), "the stand-in for PowerShell to be ended", 10_000);
		expect(existsSync(join(l.data, "update", "handover.json"))).toBe(false);
		expect(existsSync(`${l.folder}.updating`)).toBe(false);
		expect(readFileSync(join(l.folder, "web", "index.html"), "utf8")).toBe("old");
		expect(l.quits).toBe(0);
	},
);

test.skipIf(!readsZips)(
	"the launcher refuses a zip whose program is another version, and its folder is untouched",
	async () => {
		const l = launcher();
		fake.publish({ tag: "v9.0.0", dmg: writeZip(releaseMembers("8.0.0")), assetName: zipName("9.0.0") });
		await l.updater.check();
		await l.updater.install("v9.0.0", false);
		await pollUntil(() => l.updater.state().failed !== null, "the install to fail", 30_000);
		expect(l.updater.state().failed).toEqual({
			code: "version",
			tag: "v9.0.0",
			params: { tag: "v9.0.0", found: "8.0.0" },
		});
		expect(l.updater.state().job).toBeNull();
		expect(existsSync(`${l.folder}.updating`)).toBe(false);
		expect(readFileSync(join(l.folder, "web", "index.html"), "utf8")).toBe("old");
		expect(l.quits).toBe(0);
		expect(l.helperArgs()).toBeNull();
	},
);

test("a zip GitHub lists no SHA-256 for is no installer: the release is shown, and nothing is installed", async () => {
	const l = launcher();
	fake.publish({ tag: "v9.0.0", dmg: writeZip(releaseMembers("9.0.0")), assetName: zipName("9.0.0"), digest: "none" });
	await l.updater.check();
	expect(l.updater.state()).toMatchObject({ newer: true, latest: { tag: "v9.0.0", asset: null } });
	expect(await l.updater.install("v9.0.0", false)).toMatchObject({ code: "nothingToInstall" });
});

const ARM = { system: { id: "win32" as const, arch: "arm64" } };

test("an Arm launcher takes only the arm64 zip: a release with just the x64 one has no installer for it", async () => {
	const l = launcher(ARM);
	fake.publish({ tag: "v9.0.0", dmg: writeZip(releaseMembers("9.0.0")), assetName: zipName("9.0.0") });
	await l.updater.check();
	expect(l.updater.state()).toMatchObject({ newer: true, latest: { tag: "v9.0.0", asset: null } });
	expect(await l.updater.install("v9.0.0", false)).toMatchObject({ code: "nothingToInstall" });
	// Nor one whose arm64 zip GitHub lists no SHA-256 for.
	const other = launcher(ARM);
	fake.publish({
		tag: "v9.0.1",
		dmg: writeZip(releaseMembers("9.0.1", zipTop("arm64"))),
		assetName: zipName("9.0.1", "arm64"),
		digest: "none",
	});
	await other.updater.check();
	expect(other.updater.state()).toMatchObject({ newer: true, latest: { tag: "v9.0.1", asset: null } });
});

test.skipIf(!readsZips)(
	"an Arm launcher installs the release's arm64 zip, staged from its own top folder, and hands it to helper.ps1",
	async () => {
		const l = launcher(ARM);
		const arm = zipTop("arm64");
		expect(l.folder.endsWith(arm)).toBe(true);
		fake.publish({
			tag: "v9.0.0",
			dmg: writeZip(releaseMembers("9.0.0", arm)),
			assetName: zipName("9.0.0", "arm64"),
		});
		await l.updater.check();
		expect(l.updater.state().latest?.asset?.name).toBe(zipName("9.0.0", "arm64"));
		expect(await l.updater.install("v9.0.0", false)).toHaveProperty("state");
		await pollUntil(() => l.quits > 0, "the launcher to exit after the handover", 30_000);
		expect(readFileSync(join(`${l.folder}.updating`, "web", "index.html"), "utf8")).toBe("<html></html>");
	},
);

test.skipIf(!readsZips)(
	"an Arm launcher refuses an x64 zip published under the arm64 name, and its folder is untouched",
	async () => {
		const l = launcher(ARM);
		fake.publish({ tag: "v9.0.0", dmg: writeZip(releaseMembers("9.0.0")), assetName: zipName("9.0.0", "arm64") });
		await l.updater.check();
		await l.updater.install("v9.0.0", false);
		await pollUntil(() => l.updater.state().failed !== null, "the install to fail", 30_000);
		expect(l.updater.state().failed).toMatchObject({ code: "noApp", tag: "v9.0.0", params: { name: zipTop("arm64") } });
		expect(existsSync(`${l.folder}.updating`)).toBe(false);
		expect(readFileSync(join(l.folder, "web", "index.html"), "utf8")).toBe("old");
		expect(l.quits).toBe(0);
	},
);

test.skipIf(!has.posixModes)("a launcher in a folder this user cannot write in cannot update itself", async () => {
	const l = launcher();
	const parent = join(l.folder, "..");
	chmodSync(parent, 0o555);
	try {
		const locked = launcher({
			dataDir: join(root, `locked-data-${++counter}`),
			target: { kind: "windows", folder: l.folder },
		});
		expect(await locked.updater.install("v9.0.0", false)).toMatchObject({
			code: "blocked",
			params: { reason: "notWritable" },
		});
	} finally {
		chmodSync(parent, 0o755);
	}
});

test("a server that is not the launcher cannot update itself; one that is finds what an install left and says it is up", async () => {
	const none = new AppUpdater({ ...optionsOf(launcher()), target: null });
	launchers.push(none);
	expect(none.state().install).toEqual({ allowed: false, reason: "notApp" });

	// What an install cut short left beside the folder, and a handover whose helper waits for this version.
	const l = launcher();
	const update = join(l.data, "update");
	for (const left of [`${l.folder}.updating`, `${l.folder}.failed`, `${l.folder}.updating.unzip-1234abcd`]) {
		mkdirSync(left, { recursive: true });
		writeFileSync(join(left, "x"), "x");
	}
	writeFileSync(join(update, "v9.0.0.zip"), "half");
	writeFileSync(
		join(update, "handover.json"),
		JSON.stringify({
			id: "the-id",
			from: "0.0.1",
			to: pkg.version,
			installed: l.folder,
			staged: `${l.folder}.updating`,
			backup: `${l.folder}.previous`,
			helperPid: 2 ** 22 + 7,
		}),
	);
	const next = new AppUpdater({ ...optionsOf(l), target: { kind: "windows", folder: l.folder } });
	launchers.push(next);
	await pollUntil(() => next.state().outcome !== null, "the success being noted");
	expect(JSON.parse(readFileSync(join(update, "ack.json"), "utf8"))).toMatchObject({
		id: "the-id",
		version: pkg.version,
	});
	expect(next.state().outcome).toMatchObject({ ok: true, from: "0.0.1", to: pkg.version });
	for (const left of [`${l.folder}.updating`, `${l.folder}.failed`, `${l.folder}.updating.unzip-1234abcd`]) {
		expect(existsSync(left), left).toBe(false);
	}
	expect(existsSync(join(update, "v9.0.0.zip"))).toBe(false);
	expect(existsSync(join(l.folder, WINDOWS_EXE))).toBe(true);
});

/** The options of a launcher's updater, for a second updater on the same data folder. */
function optionsOf(l: Launcher): ConstructorParameters<typeof AppUpdater>[0] {
	return {
		dataDir: l.data,
		installed: pkg.version,
		target: { kind: "windows", folder: l.folder },
		system: { id: "win32", arch: "x64" },
		parentPid: null,
		api: fake.url,
		automatic: false,
		autoChecks: () => true,
		autoInstall: () => false,
		conversations: () => ({ working: 0, asking: 0, paused: 0, waiting: 0 }),
		broadcast: () => {},
	};
}
