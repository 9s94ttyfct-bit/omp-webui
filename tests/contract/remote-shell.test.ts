import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REMOTE_SHELL_OFF } from "../../shared/remote.ts";
import { type AccessKey, type Jwks, makeKey, startJwks } from "../support/access-jwt.ts";
import { pollUntil } from "../support/poll.ts";
import { type RemoteClient, remoteClient, remoteSettings } from "../support/remote-client.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { connect, request } from "../support/ws.ts";

/**
 * The panel's Terminal tab is a login shell on this computer (v0.11.18 §8). A page through the tunnel may open one while
 * Settings › Remote access allows it (the default), and is refused once it is turned off; turning it off ends the shells
 * remote pages have open. A page on this computer is never refused. The gate is the server's socket, not the page.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-remote-shell-"));
const settingsFile = join(root, "remote.json");
const dist = join(root, "dist");
let key: AccessKey;
let jwks: Jwks;
let s: TestServer;
let phone: RemoteClient;

beforeAll(async () => {
	key = await makeKey("kid-1");
	jwks = await startJwks([key]);
	mkdirSync(join(dist, "assets"), { recursive: true });
	writeFileSync(
		join(dist, "index.html"),
		'<!doctype html>\n<html><head></head><body><div id="root"></div></body></html>\n',
	);
	writeFileSync(settingsFile, JSON.stringify(remoteSettings()));
	s = await startTestServer(
		0,
		{ OMP_WEBUI_REMOTE_CONFIG: settingsFile, OMP_WEBUI_ACCESS_CERTS_URL: jwks.url, OMP_WEBUI_DIST: dist },
		{ login: false },
	);
	phone = remoteClient(s, key);
}, 120_000);

afterAll(async () => {
	await s?.stop();
	jwks?.stop();
	rmSync(root, { recursive: true, force: true });
});

const openShell = (ws: WebSocket) =>
	request<{ ptyId: string }>(ws, { t: "pty_open", args: [], cwd: root, cols: 80, rows: 24, shell: true });

/** Everything a socket is told of one terminal: its output, and whether it ended. */
function follow(ws: WebSocket, ptyId: string) {
	const seen = { text: "", exited: false };
	ws.addEventListener("message", (ev) => {
		const m = JSON.parse(String(ev.data));
		if (m.ptyId !== ptyId) return;
		if (m.t === "pty_data") seen.text += m.data;
		if (m.t === "pty_exit") seen.exited = true;
	});
	return seen;
}

/** Change the setting as the card does: the route of this computer's page. */
async function setRemoteShell(on: boolean) {
	const res = await fetch(`${s.url}/api/remote/config`, {
		method: "POST",
		headers: { "x-omp-webui-token": s.accessToken, "x-omp-webui": "1", "content-type": "application/json" },
		body: JSON.stringify({ remoteShell: on }),
	});
	expect(res.status).toBe(200);
}

test("a remote page has a shell by default; off refuses new ones and ends its open one; this computer's stays", async () => {
	let remote = await phone.socket();
	if (!remote) throw new Error("the tunnel refused the page");
	const local = await connect(s);
	try {
		const meta = await (await phone.fetch("/api/meta")).json();
		expect(meta.shell).toBe(true);

		const { ptyId: remoteId } = await openShell(remote);
		const remoteSeen = follow(remote, remoteId);
		remote.send(JSON.stringify({ t: "pty_input", ptyId: remoteId, data: "echo REMOTE-$((40+2))\r" }));
		await pollUntil(() => remoteSeen.text.includes("REMOTE-42"), "the remote shell to answer", 10_000);

		const { ptyId: localId } = await openShell(local);
		const localSeen = follow(local, localId);

		await setRemoteShell(false);
		await pollUntil(() => remoteSeen.exited, "the remote page's shell to end", 5000);
		// A change of the remote settings closes the remote pages' sockets (they come back through Access): a new one asks.
		const again = await phone.socket();
		if (!again) throw new Error("the tunnel refused the page");
		remote.close();
		remote = again;
		await expect(openShell(remote)).rejects.toThrow(REMOTE_SHELL_OFF);
		expect((await (await phone.fetch("/api/meta")).json()).shell).toBe(false);

		// This computer's shell goes on, and this computer may still open one.
		local.send(JSON.stringify({ t: "pty_input", ptyId: localId, data: "echo LOCAL-$((6*7))\r" }));
		await pollUntil(() => localSeen.text.includes("LOCAL-42"), "this computer's shell to answer", 10_000);
		expect(localSeen.exited).toBe(false);
		await openShell(local);

		// A remote page may still run `omp` in a terminal: the switch is about shells. omp's own shell console is one (#682).
		await request(remote, { t: "pty_open", args: ["--version"], cwd: root, cols: 80, rows: 24 });
		await expect(request(remote, { t: "pty_open", args: ["shell"], cwd: root, cols: 80, rows: 24 })).rejects.toThrow(
			REMOTE_SHELL_OFF,
		);
		// Nor does it reach this computer's shell by its id (#682): what it types there is not run, and its kill ends nothing.
		remote.send(JSON.stringify({ t: "pty_input", ptyId: localId, data: "echo HIJACK-$((1+1))\r" }));
		remote.send(JSON.stringify({ t: "pty_kill", ptyId: localId }));
		local.send(JSON.stringify({ t: "pty_input", ptyId: localId, data: "echo AFTER-$((3*3))\r" }));
		await pollUntil(() => localSeen.text.includes("AFTER-9"), "this computer's shell to answer after it", 10_000);
		expect(localSeen.text).not.toContain("HIJACK-2");
		expect(localSeen.exited).toBe(false);

		await setRemoteShell(true);
		const back = await phone.socket();
		if (!back) throw new Error("the tunnel refused the page");
		remote.close();
		remote = back;
		await openShell(remote);
	} finally {
		remote.close();
		local.close();
	}
}, 60_000);
