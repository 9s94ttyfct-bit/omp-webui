import { expect, test } from "bun:test";
import { launchArgv, parseCmdShim, shimScript } from "../../server/platform/cmd-shim.ts";

/**
 * npm's Windows launcher for a global package is a `.cmd` shim. Bun refuses to start one with an argument that has a cmd.exe
 * metacharacter (`omp config set disabledExtensions ["skill:x"]`), so what the shim runs is started (#296). The shim is
 * `cmd-shim`'s template; paths are Windows paths, read the Windows way on any system.
 */

const DIR = "C:\\Users\\me\\AppData\\Roaming\\npm";
const shim = (prog: string, script: string): string =>
	[
		"@ECHO off",
		"GOTO start",
		":find_dp0",
		"SET dp0=%~dp0",
		"EXIT /b",
		":start",
		"SETLOCAL",
		"CALL :find_dp0",
		"",
		`IF EXIST "%dp0%\\${prog}.exe" (`,
		`  SET "_prog=%dp0%\\${prog}.exe"`,
		") ELSE (",
		`  SET "_prog=${prog}"`,
		"  SET PATHEXT=%PATHEXT:;.JS;=;%",
		")",
		"",
		`endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${script}" %*`,
		"",
	].join("\r\n");
const SCRIPT = "node_modules\\@oh-my-pi\\pi-coding-agent\\src\\cli.ts";

test("the shim's program is the one beside it when there is one, else the name it falls back on; the script is in the package", () => {
	expect(parseCmdShim(shim("bun", SCRIPT), DIR, () => false)).toEqual([
		"bun",
		`${DIR}\\node_modules\\@oh-my-pi\\pi-coding-agent\\src\\cli.ts`,
	]);
	expect(parseCmdShim(shim("bun", SCRIPT), DIR, (p) => p === `${DIR}\\bun.exe`)).toEqual([
		`${DIR}\\bun.exe`,
		`${DIR}\\node_modules\\@oh-my-pi\\pi-coding-agent\\src\\cli.ts`,
	]);
});

test("a shim that is not npm's, or has no command line, is not read", () => {
	expect(parseCmdShim("@echo off\r\nomp-real.exe %*\r\n", DIR, () => false)).toBeNull();
	expect(parseCmdShim('SET "_prog=node"\r\n"%_prog%" %*', DIR, () => false)).toBeNull();
});

test("the command that is started keeps every argument as it was, however many cmd.exe metacharacters it holds", () => {
	const hard = ["config", "set", "disabledExtensions", '["skill:a&b"]', "--json", "100%", "a^b", "x|y"];
	const read = () => shim("bun", SCRIPT);
	const out = launchArgv([`${DIR}\\omp.cmd`, ...hard], read, () => false);
	expect(out).toEqual(["bun", `${DIR}\\node_modules\\@oh-my-pi\\pi-coding-agent\\src\\cli.ts`, ...hard]);
	expect(shimScript(out)).toBe(`${DIR}\\node_modules\\@oh-my-pi\\pi-coding-agent\\src\\cli.ts`);
});

test("what is no .cmd, or cannot be read, is started as it is", () => {
	const none = () => null;
	expect(
		launchArgv(
			["C:\\omp\\omp.exe", "--version"],
			() => shim("bun", SCRIPT),
			() => false,
		),
	).toEqual(["C:\\omp\\omp.exe", "--version"]);
	expect(launchArgv([`${DIR}\\omp.cmd`, "--version"], none, () => false)).toEqual([`${DIR}\\omp.cmd`, "--version"]);
	expect(launchArgv([], none, () => false)).toEqual([]);
});
