import { afterAll, beforeAll, expect, test } from "bun:test";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { connect, request } from "../support/ws.ts";

/**
 * A terminal survives Run in Background (#627), against the real server and the real omp (an interactive `omp` in the
 * pseudo-terminal, no model call): the macOS app tells the server it is going to close its window (`POST /api/shell/background`,
 * local-only), the page's socket closes with the window, and the terminal is kept, with what it printed, for the page of the
 * window that opens again. Without that notice a closed page kills its terminals, as it always did. `tests/unit/pty-held.test.ts`
 * has the rules of `PtyManager`; that the route is refused to a page that is not this computer's is `lan-local.test.ts` and
 * `remote-auth.test.ts`.
 */

let s: TestServer;

beforeAll(async () => {
	s = await startTestServer(0, {}, { login: false });
}, 120_000);
afterAll(async () => {
	await s?.stop();
});

interface Held {
	terminals: { ptyId: string; args: string[]; cwd: string; exited?: number | null }[];
}

const announce = (method = "POST") =>
	fetch(`${s.url}/api/shell/background`, {
		method,
		headers: { "x-omp-webui-token": s.accessToken, "x-omp-webui": "1" },
	});

/** A page with a terminal that has printed something. */
async function pageWithTerminal() {
	const ws = await connect(s);
	let printed = false;
	ws.addEventListener("message", (ev) => {
		if (String(ev.data).includes('"pty_data"')) printed = true;
	});
	const { ptyId } = await request<{ ptyId: string }>(ws, { t: "pty_open", args: [], cols: 100, rows: 30 });
	await pollUntil(() => printed, "the terminal printed something");
	return { ws, ptyId };
}

test("the notice is POST only, and needs the token", async () => {
	expect(
		(await fetch(`${s.url}/api/shell/background`, { method: "POST", headers: { "x-omp-webui": "1" } })).status,
	).toBe(401);
	expect((await announce("GET")).status).toBe(405);
	expect((await announce()).status).toBe(200);
});

test("a window closed after the notice leaves its terminal, which the next page takes over with what it printed", async () => {
	const { ws, ptyId } = await pageWithTerminal();
	expect((await announce()).status).toBe(200);
	ws.close();

	const next = await connect(s);
	let held: Held = { terminals: [] };
	await pollUntil(async () => {
		held = await request<Held>(next, { t: "pty_held" });
		return held.terminals.some((t) => t.ptyId === ptyId);
	}, "the terminal is held");
	expect(held.terminals.find((t) => t.ptyId === ptyId)).toMatchObject({ args: [] });

	const taken = await request<{ replay: string; exited?: number | null }>(next, { t: "pty_attach", ptyId });
	expect(taken.replay.length).toBeGreaterThan(0);
	expect(taken.exited).toBeUndefined();
	// It is the page's now: nobody else is offered it, and it is not held any more.
	expect((await request<Held>(next, { t: "pty_held" })).terminals).toEqual([]);
	await expect(request(next, { t: "pty_attach", ptyId })).rejects.toThrow("gone");
	next.send(JSON.stringify({ t: "pty_kill", ptyId }));
	next.close();
});

test("the notice is one close's: the next page that closes kills its terminals, and nothing is held", async () => {
	const { ws, ptyId } = await pageWithTerminal();
	ws.close();
	const next = await connect(s);
	// The process is ended with the socket; a later page is offered nothing, now or once it is gone.
	await pollUntil(async () => (await request<Held>(next, { t: "pty_held" })).terminals.length === 0, "nothing is held");
	await expect(request(next, { t: "pty_attach", ptyId })).rejects.toThrow("gone");
	next.close();
});

test("a notice the app withdrew (DELETE: its window was opened again) leaves nothing: a tab that closes next loses its terminals", async () => {
	const { ws, ptyId } = await pageWithTerminal();
	expect((await announce()).status).toBe(200);
	expect((await announce("DELETE")).status).toBe(200);
	ws.close();
	const next = await connect(s);
	await pollUntil(async () => (await request<Held>(next, { t: "pty_held" })).terminals.length === 0, "nothing is held");
	await expect(request(next, { t: "pty_attach", ptyId })).rejects.toThrow("gone");
	next.close();
});
