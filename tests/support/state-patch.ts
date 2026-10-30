import type { Page } from "@playwright/test";

/**
 * Rewrite what the real server answers to some `rpc` commands, so a spec can show UI that depends on state omp
 * only reports after a model call (context usage, the current provider). Replaces any other WebSocket route
 * on the page: install before `page.goto`, and not together with `tapSocket`.
 */
export async function patchReplies(page: Page, patches: Record<string, (data: unknown) => unknown>): Promise<void> {
	await page.routeWebSocket(/\/ws$/, (ws) => {
		const server = ws.connectToServer();
		/** Forwarded commands awaiting the server's reply: req → command type. */
		const awaiting = new Map<string, string>();
		ws.onMessage((raw) => {
			const msg = JSON.parse(String(raw));
			const type: string | undefined = msg.t === "rpc" ? msg.command?.type : undefined;
			if (type && type in patches) awaiting.set(String(msg.req), type);
			server.send(raw);
		});
		server.onMessage((raw) => {
			const msg = JSON.parse(String(raw));
			const type = msg.t === "reply" ? awaiting.get(String(msg.req)) : undefined;
			if (type === undefined) {
				ws.send(raw);
				return;
			}
			awaiting.delete(String(msg.req));
			ws.send(JSON.stringify({ ...msg, data: patches[type](msg.data) }));
		});
	});
}
