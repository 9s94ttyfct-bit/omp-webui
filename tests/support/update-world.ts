import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakeReleases } from "./fake-releases.ts";
import { startTestServer, type TestServer } from "./server.ts";
import type { Fixtures, Variant } from "./update-fixtures.ts";

/**
 * The pieces a spec (or a screenshot run) of the app's own updates (#571) puts together: signed installers, a server
 * pointed at the fake GitHub, and, for the server that can install, a copy of the running app next to a stand-in for the
 * macOS shell. Plain Node APIs, so that it runs under Playwright and Bun alike; the signing is done by a Bun program
 * (`update-fixtures.ts`: it needs `bun:ffi`), which this calls.
 */

const FIXTURES = join(import.meta.dirname, "update-fixtures.ts");

export interface Installers {
	manifest: Fixtures;
	/** Remove the throwaway keychains and the files. */
	dispose(): void;
}

/** Build the signed installers of these variants (about 2–4 s each) into a fresh temp dir. */
export function buildInstallers(...variants: Variant[]): Installers {
	const dir = mkdtempSync(join(tmpdir(), "ompw-upd-fixtures-"));
	try {
		execFileSync("bun", [FIXTURES, dir, ...variants], { stdio: ["ignore", "ignore", "inherit"], timeout: 180_000 });
	} catch (error) {
		execFileSync("bun", [FIXTURES, "--dispose", dir], { stdio: "ignore" });
		rmSync(dir, { recursive: true, force: true });
		throw error;
	}
	const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Fixtures;
	return {
		manifest,
		dispose() {
			execFileSync("bun", [FIXTURES, "--dispose", dir], { stdio: "ignore" });
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

export interface UpdateServer {
	server: TestServer;
	/** The address with the access token, which sets the cookie. */
	url: string;
	/** The folder the app copy is in, when the server can install. */
	installDir: string | null;
	/** Exists once the stand-in for the shell was asked to quit (the handover happened). */
	flag: string | null;
	/** The helper the install started, once there is one. */
	helperPid(): number | null;
	/** What the server says of itself, as a page would ask. */
	api(path: string, init?: RequestInit): Promise<Response>;
	stop(): Promise<void>;
}

/** Kill a process and its group (the helper is a session leader, the stand-in is started as one). */
function killGroup(pid: number): void {
	for (const target of [-pid, pid]) {
		try {
			process.kill(target, "SIGKILL");
		} catch {}
	}
}

/**
 * A server that looks for releases at `fake` soon after it starts. Given `running` (the signed stand-in for the app, from
 * `buildInstallers`) it is an app that can replace itself: a copy of `running` in a folder of its own is its bundle, and
 * a separate process is its shell, which on `SIGUSR1` (the handover) leaves `flag`. It is NOT the process of the caller:
 * Node uses `SIGUSR1` for its inspector. Without `running` it is no app (`notApp`).
 */
export async function startUpdateServer(options: {
	fake: FakeReleases;
	running?: string;
	env?: Record<string, string>;
}): Promise<UpdateServer> {
	let installDir: string | null = null;
	let flag: string | null = null;
	let shell: ChildProcess | null = null;
	const env: Record<string, string> = {
		OMP_WEBUI_APP_UPDATE_API: options.fake.url,
		OMP_WEBUI_APP_UPDATE_FIRST_MS: "100",
		...options.env,
	};
	if (options.running) {
		installDir = mkdtempSync(join(tmpdir(), "ompw-upd-app-"));
		mkdirSync(installDir, { recursive: true });
		const bundle = join(installDir, "omp-webui.app");
		execFileSync("ditto", [options.running, bundle]);
		flag = join(installDir, "asked-to-quit");
		shell = spawn("/bin/sh", ["-c", `trap 'echo asked > "${flag}"' USR1; while :; do sleep 0.2; done`], {
			detached: true,
			stdio: "ignore",
		});
		shell.unref();
		env.OMP_WEBUI_APP_BUNDLE = bundle;
		env.OMP_WEBUI_PARENT_PID = String(shell.pid);
	}
	let server: TestServer;
	try {
		server = await startTestServer(0, env, { login: false });
	} catch (error) {
		if (shell?.pid) killGroup(shell.pid);
		if (installDir) rmSync(installDir, { recursive: true, force: true });
		throw error;
	}
	const handover = join(server.root, "data", "update", "handover.json");
	const helperPid = (): number | null => {
		if (!existsSync(handover)) return null;
		try {
			const record: unknown = JSON.parse(readFileSync(handover, "utf8"));
			return typeof record === "object" &&
				record !== null &&
				"helperPid" in record &&
				typeof record.helperPid === "number"
				? record.helperPid
				: null;
		} catch {
			return null;
		}
	};
	return {
		server,
		url: `${server.url}/?token=${server.accessToken}`,
		installDir,
		flag,
		helperPid,
		api: (path, init = {}) =>
			fetch(`${server.url}${path}`, {
				...init,
				headers: { "x-omp-webui-token": server.accessToken, "x-omp-webui": "1", ...init.headers },
			}),
		async stop() {
			// The helper waits for the shell to quit and would then swap the copy in installDir: it ends before anything else.
			const helper = helperPid();
			if (helper !== null) killGroup(helper);
			if (shell?.pid) killGroup(shell.pid);
			await server.stop();
			if (installDir) rmSync(installDir, { recursive: true, force: true });
		},
	};
}
