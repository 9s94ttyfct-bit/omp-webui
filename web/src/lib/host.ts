import type { HostHistory } from "@shared/host.ts";
import { useEffect } from "react";
import { useApp } from "../store/app.ts";
import { takeHistory, takeSample, useHost } from "./host-store.ts";
import { WatchBook } from "./host-watch.ts";
import { usePageVisible } from "./page-visible.ts";
import { socket } from "./ws.ts";

/**
 * The host's load as the page follows it (#613). The server samples the Mac it runs on and keeps the history (`lib/host-store.ts`
 * holds what it has told); this reads it, follows the socket's `host_sample`, and tells the server whether anything here shows
 * the load (`useHostWatch`), so that it looks at the live pace only while something does. Imported only by the lazy
 * chunks that draw it: none of it is in the first page.
 */

let loading: Promise<void> | null = null;

/** Read `GET /api/host` (one request at a time). A failure is kept as `failed` only while nothing has been heard at all. */
export function loadHost(): Promise<void> {
	loading ??= fetch("/api/host", { cache: "no-store" })
		.then(async (res) => {
			if (!res.ok) throw new Error(`host: ${res.status}`);
			takeHistory((await res.json()) as HostHistory);
		})
		.catch(() => useHost.setState((s) => ({ failed: s.fine.length === 0 })))
		.finally(() => {
			loading = null;
		});
	return loading;
}

const book = new WatchBook(
	() => socket.connected,
	(told) =>
		socket.post({
			t: "host_watch",
			on: told.on,
			...(told.detail ? { detail: true } : {}),
			...(told.procs ? { procs: true } : {}),
		}),
	// Figures of processes that nobody asks for any more would only be shown as if they were current.
	() => useHost.setState({ procs: null }),
);

// A connection that is gone took the server's note of what it watched with it: the next one starts from nothing.
socket.onStatus((connected) => {
	if (connected) book.reconnected();
	else book.disconnected();
});
socket.on((msg) => {
	if (msg.t === "host_sample" && takeSample(msg)) void loadHost();
});

/**
 * This page shows the host's load while whatever calls this is mounted. `detail`: it shows the graphs (the sidebar's
 * popover, the Host tab), which the server keeps at the live pace; without it the page shows only the line of figures, at
 * which the server looks at the background pace. Nothing is watched while the page is not on screen (a background tab) or
 * has no connection; the history is read again when it is shown, which is how the looks it missed come back. `procs`: it
 * also shows what omp, the relays and the server use, which makes the server list processes at each look (the pace is
 * `detail`'s).
 */
export function useHostWatch({ detail = false, procs = false }: { detail?: boolean; procs?: boolean } = {}): void {
	const visible = usePageVisible();
	const connected = useApp((s) => s.connected);
	useEffect(() => {
		if (!visible || !connected) return;
		const owner = {};
		// Looked at first thing: what the server holds is read, and the socket adds to it.
		if (book.watch(owner, { detail, procs })) void loadHost();
		return () => book.unwatch(owner);
	}, [visible, connected, detail, procs]);
}
