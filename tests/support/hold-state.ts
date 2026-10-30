import type { Page } from "@playwright/test";

/**
 * Hold back omp's `get_state` answers on the page's socket, as a slow connection (a remote page) would deliver them
 * late: from `hold` on, every answer to a `get_state` (also one asked before) waits when it arrives, and `release` lets
 * them through. Every other message goes through. Install before `page.goto`.
 */
export async function holdState(page: Page): Promise<{ hold(): void; release(): void }> {
	let held = false;
	const states = new Set<string>();
	const queued: Array<() => void> = [];
	await page.routeWebSocket(/\/ws$/, (ws) => {
		const server = ws.connectToServer();
		ws.onMessage((raw) => {
			const msg = JSON.parse(String(raw));
			if (msg.t === "rpc" && msg.command?.type === "get_state") states.add(String(msg.req));
			server.send(raw);
		});
		server.onMessage((raw) => {
			const text = String(raw);
			const msg = text.startsWith("{") && text.includes('"reply"') ? JSON.parse(text) : null;
			if (held && msg?.t === "reply" && states.has(String(msg.req))) queued.push(() => ws.send(raw));
			else ws.send(raw);
		});
	});
	return {
		hold: () => {
			held = true;
		},
		release: () => {
			held = false;
			for (const send of queued.splice(0)) send();
		},
	};
}
