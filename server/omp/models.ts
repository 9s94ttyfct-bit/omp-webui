import { homedir } from "node:os";
import { RpcClient } from "./rpc-client.ts";
import { withTimeout } from "./run.ts";

/**
 * Models omp can use right now (RPC `get_available_models`), from a short-lived
 * process. Used where no session is open, e.g. to pick a replacement model when
 * a resumed session's saved model can no longer be restored.
 *
 * An omp that does not say it is ready, or does not answer, within `START_MS` and `CALL_MS` is killed and the call fails;
 * the run under way is shared only until then, so that the next call starts a new one (a hung one used to keep every
 * later call waiting on it until the server restarted: #319).
 */

const START_MS = 60_000;
const CALL_MS = 60_000;

let cache: { at: number; models: unknown[] } | null = null;
let inflight: Promise<unknown[]> | null = null;

/** `force` skips the one-minute cache: a provider may have been signed in since the list was taken. */
export async function availableModels(
	bin: string,
	force = false,
	startMs = START_MS,
	callMs = CALL_MS,
): Promise<unknown[]> {
	if (!force && cache && Date.now() - cache.at < 60_000) return cache.models;
	inflight ??= (async () => {
		const client = new RpcClient({ bin, args: ["--no-session"], cwd: homedir(), onFrame: () => {}, onExit: () => {} });
		try {
			await withTimeout(client.ready, startMs, "omp did not start in time");
			const { models } = await client.call<{ models: unknown[] }>({ type: "get_available_models" }, callMs);
			cache = { at: Date.now(), models };
			return models;
		} catch (e) {
			// It did not answer: nothing it holds is worth waiting for.
			client.kill("SIGKILL");
			throw e;
		} finally {
			client.close();
			inflight = null;
		}
	})();
	return inflight;
}
