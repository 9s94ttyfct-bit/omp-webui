import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { processTree } from "../../server/omp/process-tree.ts";
import type { LiveInfo, LiveListing } from "../../shared/protocol.ts";
import { startAppServer } from "./app-server.ts";
import { writeFakeOmp } from "./fake-omp.ts";
import { isolatedEnv } from "./omp-env.ts";
import { pollUntil, processExists } from "./poll.ts";
import { connect, request } from "./ws.ts";

/**
 * A server the macOS app started stops its omp processes when the app is gone — force-quit or crashed — also while omp
 * is working, which it keeps doing after its stdin closes. Real server, real omp and a real tool process; no model
 * calls. The scenarios are run by tests/contract/shutdown.test.ts, for what the server leaves behind, and by
 * tests/performance/shutdown.test.ts, for how soon: that is a real-clock budget, which the parallel pool cannot keep.
 */

/** What happened after the app was killed. */
export interface KilledApp {
	/** Milliseconds from the kill until omp (and the tool it ran) were gone. */
	goneAfterMs: number;
	/** How the server ended. */
	exitCode: number;
	/** Whether the server left its record (`server.pid`) in the data directory. */
	pidFileLeft: boolean;
}

export type Scenario =
	/** omp is working: a `!command` runs, and omp ignores a closed stdin meanwhile. */
	| "working"
	/** omp is idle: a closed stdin ends it. */
	| "idle"
	/** An omp that ignores both its closed stdin and SIGTERM, with a tool in a session of its own: only SIGKILL ends them. */
	| "stubborn";

export class ShutdownWorld {
	readonly root = mkdtempSync(join(tmpdir(), "ompw-shutdown-"));
	private env: Record<string, string> = {};
	private readonly procs: Subprocess[] = [];
	/** Processes a failing test may leave behind. */
	private readonly strays: number[] = [];

	async setup(): Promise<void> {
		this.env = await isolatedEnv(this.root);
	}

	/** After each test: what it started, and what it left. */
	reap(): void {
		for (const p of this.procs.splice(0)) p.kill("SIGKILL");
		for (const pid of this.strays.splice(0)) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// already gone
			}
		}
	}

	close(): void {
		rmSync(this.root, { recursive: true, force: true });
	}

	/**
	 * A server started like the app does, its "app" a process this test can kill, and one omp opened on it.
	 * `extra` is added to the server's environment (`OMP_BIN`, for a fake omp).
	 */
	private async start(extra: Record<string, string> = {}) {
		const app = Bun.spawn(["sleep", "600"]);
		this.procs.push(app);
		const dataDir = mkdtempSync(join(this.root, "data-"));
		const work = join(this.root, "work");
		mkdirSync(dataDir, { recursive: true });
		mkdirSync(work, { recursive: true });
		const server = await startAppServer(this.env, dataDir, 0, { OMP_WEBUI_PARENT_PID: String(app.pid), ...extra });
		this.procs.push(server.proc);
		const url = `http://127.0.0.1:${server.port}`;
		const ws = await connect({ url, accessToken: server.token });
		const live = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: work } });
		this.strays.push(live.pid as number);
		const lives = async (): Promise<LiveListing[]> =>
			(await fetch(`${url}/api/lives`, { headers: { "x-omp-webui-token": server.token } })).json();
		return { app, server, ws, live, dataDir, lives };
	}

	/** The app is killed (SIGKILL); returns once omp and its tool are gone and the server has ended. */
	async killTheApp(scenario: Scenario): Promise<KilledApp> {
		const stubborn = scenario === "stubborn";
		const bin = stubborn
			? writeFakeOmp(this.root, { ignoreClose: true, ignoreTerm: true, tool: true, toolDetached: true })
			: null;
		const { app, server, ws, live, dataDir, lives } = await this.start(bin ? { OMP_BIN: bin } : {});
		const omp = live.pid as number;
		let tool = 0;
		if (scenario === "working") {
			// `!command`: omp answers only when the command ends, so it is busy for as long as that takes, and it ignores a
			// closed stdin meanwhile. omp starts the command in a session of its own.
			request(ws, { t: "rpc", liveId: live.liveId, command: { type: "bash", command: "/bin/sleep 300" } }).catch(
				() => {},
			);
			await pollUntil(
				async () => (await lives()).find((l) => l.liveId === live.liveId)?.busy === true,
				"omp to be busy",
			);
		}
		if (scenario !== "idle") {
			await pollUntil(async () => {
				tool = (await processTree(omp)).find((p) => p !== omp) ?? 0;
				return tool > 0;
			}, "omp's tool process");
			this.strays.push(tool);
		}

		const killedAt = performance.now();
		app.kill("SIGKILL");
		await pollUntil(
			() => !processExists(omp) && (tool === 0 || !processExists(tool)),
			"omp and its tool to be gone",
			30_000,
		);
		const goneAfterMs = performance.now() - killedAt;
		const exitCode = await server.proc.exited;
		return { goneAfterMs, exitCode, pidFileLeft: existsSync(join(dataDir, "server.pid")) };
	}
}
