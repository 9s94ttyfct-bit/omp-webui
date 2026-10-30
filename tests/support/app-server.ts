import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { hostEnv } from "./omp-env.ts";
import { trackRelayDir } from "./relay-dirs.ts";
import { serverTmp } from "./tmp.ts";

export interface AppServer {
	proc: Subprocess;
	port: number;
	/** The access token the server was given, as the macOS app gives it one. */
	token: string;
	/** Everything the server has printed so far. */
	output(): string;
	/**
	 * What the server wrote to stderr so far (#774): not shown as it comes, since a test that means to hit an error (a stray
	 * rejection, a refused start) would look like a failure; `OMPW_SERVER_STDERR=1` shows it as it comes.
	 */
	errors(): string;
}

/**
 * Start the server the way the macOS app does (`OMP_WEBUI_AUTO_PORT=1`): it takes the next free port when
 * `port` is taken, and reports the one it took. `extra` adds to or overrides the environment (for example
 * `OMP_WEBUI_PARENT_PID`). Resolves once the server is ready; the caller stops it. `env` is `isolatedEnv`'s.
 */
export async function startAppServer(
	env: Record<string, string>,
	dataDir: string,
	port = 0,
	extra: Record<string, string> = {},
): Promise<AppServer> {
	const token = `tok-${crypto.randomUUID()}`;
	// "Guard dangerous commands" (#609) is on in a fresh install, and every risky call then waits for a reviewer: a test that is
	// about something else must not. The settings are in a file of the test's own beside the data folder, off unless it says
	// otherwise (a test of the guard writes the file before it starts the server, or passes its own `OMP_WEBUI_GUARD_CONFIG`).
	const guardFile = `${dataDir}.guard.json`;
	if (!existsSync(guardFile)) writeFileSync(guardFile, JSON.stringify({ mode: "off" }));
	trackRelayDir(dataDir);
	const proc = Bun.spawn(["bun", join(import.meta.dir, "../../server/main.ts")], {
		env: {
			...hostEnv(),
			...env,
			// The temp dir of this server: one of its own, so that the server of another data dir (another test file
			// running in parallel) never sweeps the overlay directories of this one's dead servers (#461).
			TMPDIR: serverTmp(env.TMPDIR ?? join(dataDir, "tmp"), dataDir),
			OMP_WEBUI_DATA_DIR: dataDir,
			OMP_WEBUI_PORT: String(port),
			OMP_WEBUI_AUTO_PORT: "1",
			OMP_WEBUI_GUARD_CONFIG: guardFile,
			OMP_WEBUI_TOKEN: token,
			OMP_WEBUI_UPDATE_CHECK: "off",
			// No title is asked of omp after a first exchange (a model call of its own) unless a test says so.
			OMP_WEBUI_AUTO_TITLE: "off",
			...extra,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	let printed = "";
	let errors = "";
	void (async () => {
		const decoder = new TextDecoder();
		for await (const chunk of proc.stderr) {
			const text = decoder.decode(chunk, { stream: true });
			errors += text;
			if (process.env.OMPW_SERVER_STDERR) process.stderr.write(text);
		}
	})();
	const ready = Promise.withResolvers<number>();
	void (async () => {
		const decoder = new TextDecoder();
		for await (const chunk of proc.stdout) {
			printed += decoder.decode(chunk, { stream: true });
			const line = /OMPW_READY (\{.*\})/.exec(printed);
			if (line) ready.resolve(JSON.parse(line[1]).port);
		}
		// Only matters when the server never got ready.
		await proc.exited;
		ready.reject(new Error(`server exited before it was ready: ${printed}${errors && `\nstderr:\n${errors}`}`));
	})();
	return { proc, port: await ready.promise, token, output: () => printed, errors: () => errors };
}
