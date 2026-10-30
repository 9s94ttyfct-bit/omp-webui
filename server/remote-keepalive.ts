/**
 * Cloudflare closes a WebSocket that has carried nothing, in either direction, for about 100 s. The server's own ping
 * (Bun's `sendPings`) goes out only after 104 s of silence, too late, and a page whose timers are not running (a hidden
 * tab, a locked iPad) says nothing meanwhile. So the server pings every remote page's socket itself, well inside the
 * limit: a browser answers a ping on its own, without running the page, and each ping is traffic the edge sees. A local
 * socket has no edge in front of it and is not pinged.
 */
export const REMOTE_PING_MS = 30_000;

/** `REMOTE_PING_MS`, or what `OMP_WEBUI_REMOTE_KEEPALIVE_MS` says (tests scale it down with the edge's limit). */
export function remotePingMs(env: Record<string, string | undefined> = process.env): number {
	const set = Number(env.OMP_WEBUI_REMOTE_KEEPALIVE_MS ?? Number.NaN);
	// At least 10 ms (a smaller interval fires every millisecond) and within what a timer can hold.
	return Number.isFinite(set) && set >= 10 && set <= 2_147_483_647 ? set : REMOTE_PING_MS;
}
