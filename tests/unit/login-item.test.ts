import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoginStart } from "../../server/login-start.ts";
import { platformFor } from "../../server/platform/index.ts";
import { autostartEntry } from "../../server/platform/linux.ts";
import { runCommand } from "../../server/platform/win32.ts";
import { removeScratch } from "../support/scratch.ts";

/**
 * Settings › Start at login on Linux and Windows (server/login-start.ts and `platform.loginItem`): the XDG autostart entry and
 * the user's `Run` value, read back as the switch shows them. Windows' `reg.exe` is stood in for; the real one is run by the
 * launcher's contract test on Windows (tests/contract/launcher.test.ts).
 */

const root = mkdtempSync(join(tmpdir(), "ompw-login-item-"));
afterAll(() => removeScratch(root));

test("Linux: the autostart entry starts the program in the background, is read back, and goes", async () => {
	const config = join(root, "config");
	const item = platformFor("linux", { env: { XDG_CONFIG_HOME: config } }).loginItem;
	if (!item) throw new Error("Linux has a login item");
	const file = join(config, "autostart", "omp-webui.desktop");
	expect(await item.read("/home/me")).toBe(false);
	await item.write("/home/me", "/home/me/.local/share/omp-webui/omp-webui");
	expect(readFileSync(file, "utf8")).toContain('Exec="/home/me/.local/share/omp-webui/omp-webui" --background\n');
	expect(readFileSync(file, "utf8")).toContain("Terminal=false\n");
	expect(await item.read("/home/me")).toBe(true);
	// A desktop that turns the entry off in it: off.
	writeFileSync(file, `${readFileSync(file, "utf8")}Hidden=true\n`);
	expect(await item.read("/home/me")).toBe(false);
	await item.write("/home/me", null);
	expect(existsSync(file)).toBe(false);
	// Off when it is off already: nothing to do, no error.
	await item.write("/home/me", null);
	expect(await item.read("/home/me")).toBe(false);
});

test("Linux: without XDG_CONFIG_HOME the entry is in ~/.config; a path it cannot quote is refused", async () => {
	const home = join(root, "home");
	const item = platformFor("linux", { env: {} }).loginItem;
	await item?.write(home, "/opt/omp-webui/omp-webui");
	expect(existsSync(join(home, ".config", "autostart", "omp-webui.desktop"))).toBe(true);
	for (const bad of ['/a"b', "/a$b", "/a`b", "/a\\b", "/a%b", "/a\nb"]) expect(() => autostartEntry(bad)).toThrow();
});

test("Windows: the Run value starts the launcher minimized, in the background; deleting one that is not there is no error", async () => {
	expect(runCommand("C:\\Windows", "C:\\Users\\Me Too\\omp-webui\\omp-webui.exe")).toBe(
		'"C:\\Windows\\System32\\cmd.exe" /d /c start "" /min "C:\\Users\\Me Too\\omp-webui\\omp-webui.exe" --background',
	);
	expect(() => runCommand("C:\\Windows", 'C:\\a"b.exe')).toThrow();

	let value: string | null = null;
	const calls: string[][] = [];
	const run = async (argv: string[]) => {
		calls.push(argv);
		const [, verb] = argv;
		if (verb === "query") return { code: value === null ? 1 : 0, stdout: "", stderr: "" };
		if (verb === "add") value = argv[argv.indexOf("/d") + 1];
		if (verb === "delete") {
			if (value === null)
				return {
					code: 1,
					stdout: "",
					stderr: "ERROR: The system was unable to find the specified registry key or value.",
				};
			value = null;
		}
		return { code: 0, stdout: "", stderr: "" };
	};
	const item = platformFor("win32", { env: { SystemRoot: "D:\\Win" }, run: run as never }).loginItem;
	if (!item) throw new Error("Windows has a login item");
	expect(await item.read("C:\\Users\\Me")).toBe(false);
	await item.write("C:\\Users\\Me", "C:\\Apps\\omp-webui\\omp-webui.exe");
	expect(calls.at(-1)).toEqual([
		"D:\\Win\\System32\\reg.exe",
		"add",
		"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
		"/v",
		"omp-webui",
		"/t",
		"REG_SZ",
		"/d",
		'"D:\\Win\\System32\\cmd.exe" /d /c start "" /min "C:\\Apps\\omp-webui\\omp-webui.exe" --background',
		"/f",
	]);
	expect(await item.read("C:\\Users\\Me")).toBe(true);
	await item.write("C:\\Users\\Me", null);
	expect(await item.read("C:\\Users\\Me")).toBe(false);
	await item.write("C:\\Users\\Me", null);
});

test("the route: unavailable without the launcher's program or a login item; on and off with them; a bad body is refused", async () => {
	const post = (on: unknown) =>
		new Request("http://127.0.0.1/api/login-start", { method: "POST", body: JSON.stringify({ on }) });
	const get = new Request("http://127.0.0.1/api/login-start");
	const fromSource = new LoginStart(
		undefined,
		platformFor("linux", { env: { XDG_CONFIG_HOME: join(root, "c2") } }).loginItem,
	);
	expect(await (await fromSource.handle(get)).json()).toEqual({ available: false, on: false });
	expect((await fromSource.handle(post(true))).status).toBe(409);
	expect(await (await new LoginStart("/x/omp-webui", null).handle(get)).json()).toEqual({
		available: false,
		on: false,
	});

	const start = new LoginStart(
		"/x/omp-webui",
		platformFor("linux", { env: { XDG_CONFIG_HOME: join(root, "c3") } }).loginItem,
		"/home/me",
	);
	expect(await (await start.handle(post(true))).json()).toEqual({ available: true, on: true });
	expect(await (await start.handle(get)).json()).toEqual({ available: true, on: true });
	expect(await (await start.handle(post(false))).json()).toEqual({ available: true, on: false });
	expect((await start.handle(post("yes"))).status).toBe(400);
	expect((await start.handle(new Request("http://127.0.0.1/api/login-start", { method: "PUT" }))).status).toBe(405);
});
