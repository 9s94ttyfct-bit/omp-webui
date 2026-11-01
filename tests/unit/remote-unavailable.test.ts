import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../server/config.ts";
import { isLoopbackHost } from "../../server/loopback-listener.ts";
import { UNAVAILABLE } from "../../server/platform/capabilities.ts";
import { platformFor } from "../../server/platform/index.ts";
import { LazyRemote } from "../../server/remote-lazy.ts";
import { DEFAULT_REMOTE_CONFIG } from "../../shared/remote.ts";

/**
 * Remote access where the system has it off (`capabilities.remoteAccess`: Windows, until the risk classifier knows its
 * paths and shells): the settings count as off whatever the file says, nothing of the chain is loaded or started,
 * `/api/remote*` answer 501 with the reason, and a server is not let listen where other computers reach it. Each case
 * runs on any system: the capability is handed in, as `platformFor("win32")` has it.
 */

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "ompw-remote-unavailable-"));
	dirs.push(dir);
	return dir;
}

const windows = platformFor("win32").capabilities.remoteAccess;
const mac = platformFor("darwin").capabilities.remoteAccess;

/** A data dir whose settings file has remote access on, complete. */
function remoteOn(): string {
	const dir = scratch();
	const config = {
		...DEFAULT_REMOTE_CONFIG,
		enabled: true,
		hostname: "omp.example.com",
		team: "my-team",
		aud: "c".repeat(64),
		emails: ["me@example.com"],
	};
	writeFileSync(join(dir, "remote.json"), JSON.stringify(config));
	return dir;
}

const lazy = (dir: string, available: boolean) =>
	new LazyRemote(
		dir,
		() => {},
		"127.0.0.1",
		() => 0,
		undefined,
		undefined,
		available,
	);

test("Windows has remote access off, macOS and Linux on", () => {
	expect(windows).toBe(false);
	expect(mac).toBe(true);
	expect(platformFor("linux").capabilities.remoteAccess).toBe(true);
});

test("settings that turn remote access on count as off where the system has none", async () => {
	const dir = remoteOn();
	// The same file turns it on where the system has it: the contrast is the capability alone.
	const there = lazy(dir, mac);
	expect(there.settings()?.hostname).toBe("omp.example.com");
	expect(there.isPublicHost("omp.example.com")).toBe(true);

	const here = lazy(dir, windows);
	expect(here.settings()).toBeNull();
	expect(here.isPublicHost("omp.example.com")).toBe(false);
	// Every request is a local one: nothing to verify, and the chain is not loaded for it.
	expect(await here.verify(new Request("http://omp.example.com/api/meta"))).toBeNull();
});

test("/api/remote* answer 501 with the reason, and other paths are not theirs", async () => {
	const here = lazy(remoteOn(), windows);
	for (const path of ["/api/remote", "/api/remote/config", "/api/remote/start", "/api/remote/ai/start"]) {
		const url = new URL(`http://127.0.0.1${path}`);
		const res = await here.handle(
			new Request(url, { method: path === "/api/remote" ? "GET" : "POST" }),
			url,
			"127.0.0.1",
		);
		expect(res?.status, path).toBe(501);
		expect(await res?.json(), path).toEqual({ error: UNAVAILABLE.remoteAccess });
	}
	const other = new URL("http://127.0.0.1/api/remoteness");
	expect(await here.handle(new Request(other), other, "127.0.0.1")).toBeNull();
});

test("the tunnel is never started, and the settings cannot be read or saved through it", async () => {
	const dir = remoteOn();
	// A record of a tunnel a former server left: where the system has remote access, it would load the chain to end it.
	writeFileSync(join(dir, "cloudflared.pid"), "999999");
	const here = lazy(dir, windows);
	here.start();
	await expect(here.config()).rejects.toThrow(UNAVAILABLE.remoteAccess);
	await expect(here.saveConfig({ enabled: false })).rejects.toThrow(UNAVAILABLE.remoteAccess);
	// Nothing was started, so there is nothing to stop.
	await here.stop();
	expect(here.settings()).toBeNull();
});

test("only the loopback is a host this computer alone reaches", () => {
	for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]", ""])
		expect(isLoopbackHost(host), host).toBe(true);
	for (const host of ["0.0.0.0", "::", "[::]", "192.168.1.5", "fe80::1", "mymac.local"])
		expect(isLoopbackHost(host), host).toBe(false);
});

test("a server is refused an OMP_WEBUI_HOST other computers reach where remote access is off", () => {
	const data = scratch();
	const env = (host: string) => ({ OMP_WEBUI_DATA_DIR: data, PI_CODING_AGENT_DIR: data, OMP_WEBUI_HOST: host });
	for (const host of ["0.0.0.0", "::", "192.168.1.5", "mymac.local"]) {
		expect(() => loadConfig(env(host), windows), host).toThrow(UNAVAILABLE.remoteAccess);
		expect(loadConfig(env(host), mac).host, host).toBe(host);
	}
	for (const host of ["127.0.0.1", "localhost", "::1"]) expect(loadConfig(env(host), windows).host, host).toBe(host);
	expect(loadConfig({ OMP_WEBUI_DATA_DIR: data, PI_CODING_AGENT_DIR: data }, windows).host).toBe("127.0.0.1");
});
