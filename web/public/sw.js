/*
 * The service worker of omp-webui: it exists to show a Web Push notification when no page is open, and to open the conversation
 * a click on it names. It does nothing else, on purpose:
 *
 *   - no `fetch` handler and no `caches`: every request of the page goes to the network as it would without a worker, so that
 *     what the server answers a signed-in page (the conversations, the files) is never kept anywhere a later visitor of the
 *     browser could read it, and a page is never an older build than the server's;
 *   - the payload is what the server sent encrypted to this browser (RFC 8291): a notification's title and two words, and
 *     which conversation. A message that cannot be read still shows a notification (iOS and Chrome revoke a subscription
 *     that gets a push and shows nothing), a plain one that names nothing.
 *
 * `shared/push.ts` (`isPushPayload`, `openHash`) is the source of the payload's shape and of where a click goes;
 * `tests/unit/service-worker.test.ts` holds this file to both. This file is plain JavaScript because it is not built.
 */

self.addEventListener("install", () => {
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(self.clients.claim());
});

/** The page address a click opens, as `hashOf` of the page's store writes it: a conversation by its file, else by its process. */
function openHash(p) {
	if (p.file) return `#/s/${encodeURIComponent(p.file)}`;
	if (p.liveId) return `#/live/${p.liveId}`;
	return "#/";
}

function isPayload(v) {
	return (
		typeof v === "object" &&
		v !== null &&
		v.v === 1 &&
		(v.kind === "asking" || v.kind === "finished" || v.kind === "test") &&
		typeof v.title === "string" &&
		typeof v.body === "string" &&
		(v.liveId === null || typeof v.liveId === "string") &&
		(v.file === null || typeof v.file === "string")
	);
}

/** What is shown for a message that is no notification of ours (a push service's own, or a payload from a newer server). */
function plain() {
	const zh = /^zh/i.test(self.navigator.language || "");
	return { title: "omp", body: zh ? "有对话需要你" : "A conversation needs you" };
}

self.addEventListener("push", (event) => {
	let payload = null;
	try {
		payload = event.data ? event.data.json() : null;
	} catch {
		payload = null;
	}
	const shown = isPayload(payload) ? payload : null;
	const { title, body } = shown ?? plain();
	event.waitUntil(
		self.registration.showNotification(title, {
			body,
			// One notification per conversation: a newer one replaces the older (and alerts again).
			tag: shown?.liveId ? `omp-${shown.liveId}` : "omp",
			renotify: true,
			icon: "/icon-192.png",
			data: { hash: shown ? openHash(shown) : "#/" },
		}),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const hash = typeof event.notification.data?.hash === "string" ? event.notification.data.hash : "#/";
	event.waitUntil(
		(async () => {
			const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
			// A window of this app that is open (in the background, or suspended by the system) is brought forward and told where to go;
			// none: a new one is opened on the conversation.
			for (const w of windows) {
				if (new URL(w.url).origin !== self.location.origin) continue;
				try {
					await w.focus();
				} catch {
					// A window that cannot be focused is still told.
				}
				w.postMessage({ type: "ompw-open", hash });
				return;
			}
			await self.clients.openWindow(`/${hash}`);
		})(),
	);
});
