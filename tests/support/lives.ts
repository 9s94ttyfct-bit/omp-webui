import { setTimeout as sleep } from "node:timers/promises";
import type { LiveListing } from "../../shared/protocol.ts";
import type { TestServer } from "./server.ts";
import { connect, request } from "./ws.ts";

/**
 * End every omp process a server holds, and return once each has ended. A spec that starts omp on a conversation does
 * not end it, and the server of a Playwright worker outlives the spec: the process stays on its conversation's file,
 * and a later spec that writes a file of the same name (the fixture numbers are shared by convention only) finds the
 * conversation already open, in whatever folder the first one chose, instead of the state it set up.
 *
 * Closing is asynchronous on the server (it waits for the process to end), so the listing is read until nothing runs.
 */
export async function endAllLives(
	server: Pick<TestServer, "url" | "accessToken">,
	{ timeoutMs = 30_000 }: { timeoutMs?: number } = {},
): Promise<void> {
	const ws = await connect(server);
	try {
		const closing = new Set<string>();
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const running = (await request<LiveListing[]>(ws, { t: "list_lives" })).filter((l) => !l.exited);
			if (running.length === 0) return;
			if (Date.now() > deadline) {
				throw new Error(
					`omp processes still running after ${timeoutMs} ms: ${running.map((l) => l.liveId).join(", ")}`,
				);
			}
			for (const l of running) {
				if (closing.has(l.liveId)) continue;
				closing.add(l.liveId);
				await request(ws, { t: "close", liveId: l.liveId });
			}
			await sleep(100);
		}
	} finally {
		ws.close();
	}
}
