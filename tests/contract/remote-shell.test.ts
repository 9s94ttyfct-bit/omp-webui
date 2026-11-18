import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REMOTE_SHELL_OFF } from "../../shared/remote.ts";
import { type AccessKey, type Jwks, makeKey, startJwks } from "../support/access-jwt.ts";
import { pollUntil } from "../support/poll.ts";
import { rejectionOf } from "../support/rejection.ts";
import { proxiedClient, type RemoteClient, remoteClient, remoteSettings } from "../support/remote-client.ts";
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
/** A page that is not the person's own (behind a proxy without Access): the switch is about such a page's shells. */
let phone: ReturnType<typeof proxiedClient>;
/** A page signed in through Access: the person's own, whose shells the switch does not touch. */
let signedIn: RemoteClient;

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
	phone = proxiedClient(s);
	signedIn = remoteClient(s, key);
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

test("a page that is not the person's own has a shell by default; off refuses new ones and ends its open one; the person's own pages keep theirs", async () => {
	let remote = await phone.socket();
	if (!remote) throw new Error("the tunnel refused the page");
	const local = await connect(s);
	try {
		const meta = await (await phone.fetch("/api/meta")).json();
		expect(meta.shell).toBe(true);

		const { ptyId: remoteId } = await openShell(remote);
		const remoteSeen = follow(remote, remoteId);
		remote.send(JSON.stringify({ t: "pty_input", ptyId: remoteId, data: "echo REMOTE-$((40+2))\r" }));
		// A shell's first answer includes its start. On a loaded Windows runner this wait once timed out at 10 s with no
		// matching output (run 42221419329; the cause was not measured, a slow start is the likely one). The waits on a
		// shell that has already answered stay short.
		await pollUntil(() => remoteSeen.text.includes("REMOTE-42"), "the remote shell to answer", 30_000);

		const { ptyId: localId } = await openShell(local);
		const localSeen = follow(local, localId);

		await setRemoteShell(false);
		await pollUntil(() => remoteSeen.exited, "the remote page's shell to end", 5000);
		// A change of the remote settings closes the remote pages' sockets (they come back through Access): a new one asks.
		const again = await phone.socket();
		if (!again) throw new Error("the tunnel refused the page");
		remote.close();
		remote = again;
		expect(await rejectionOf(openShell(remote))).toThrow(REMOTE_SHELL_OFF);
		expect((await (await phone.fetch("/api/meta")).json()).shell).toBe(false);

		// This computer's shell goes on, and this computer may still open one; so may a page signed in through Access.
		const access = await signedIn.socket();
		if (!access) throw new Error("the tunnel refused the page");
		await openShell(access);
		expect((await (await signedIn.fetch("/api/meta")).json()).shell).toBe(true);
		access.close();
		local.send(JSON.stringify({ t: "pty_input", ptyId: localId, data: "echo LOCAL-$((6*7))\r" }));
		await pollUntil(() => localSeen.text.includes("LOCAL-42"), "this computer's shell to answer", 30_000);
		expect(localSeen.exited).toBe(false);
		await openShell(local);
		// Nor any other terminal: omp's console runs `!command`s, its `shell` is one (#682), its RPC mode takes `bash`.
		for (const args of [["--version"], ["shell"], ["--mode", "rpc"]])
			expect(
				await rejectionOf(request(remote, { t: "pty_open", args, cwd: root, cols: 80, rows: 24, lines: true })),
			).toThrow(REMOTE_SHELL_OFF);
		// Nor the composer's `!command`, nor omp started with a flag that loads code; a conversation it may still have.
		expect(
			await rejectionOf(request(remote, { t: "open", target: { kind: "new", cwd: root, args: ["--extension=x.ts"] } })),
		).toThrow(REMOTE_SHELL_OFF);
		const chat = await request<{ liveId: string }>(remote, {
			t: "open",
			target: { kind: "new", cwd: root, args: ["--no-title"] },
		});
		expect(
			await rejectionOf(
				request(remote, { t: "rpc", liveId: chat.liveId, command: { type: "bash", command: "echo RAN" } }),
			),
		).toThrow(REMOTE_SHELL_OFF);
		await request(remote, { t: "close", liveId: chat.liveId });
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

test("with shells off, a page that is not the person's own installs and turns on no plugin, skill, marketplace or MCP server (#209)", async () => {
	await setRemoteShell(false);
	try {
		const post = (client: Pick<RemoteClient, "fetch">, path: string, body: unknown) =>
			client.fetch(
				path,
				{ method: "POST", headers: { "x-omp-webui": "1", "content-type": "application/json" } },
				JSON.stringify(body),
			);
		const writes: [string, unknown][] = [
			["/api/plugins/jobs", { action: "install", spec: "./evil-plugin" }],
			["/api/plugins/jobs", { action: "marketplace-add", spec: "https://example.com/market" }],
			["/api/plugins/mcp", { name: "evil", command: "/bin/sh", args: ["-c", "echo RAN"] }],
			["/api/plugins/config", { name: "x", key: "y", value: "z" }],
			["/api/plugins/enable", { name: "x", enabled: true }],
			["/api/plugins/skills/enable", { name: "x", enabled: true }],
			["/api/controls/plugin", { name: "x", enabled: true }],
			["/api/controls/mcp", { name: "x", enabled: true }],
		];
		for (const [path, body] of writes) {
			const res = await post(phone, path, body);
			expect(res.status, path).toBe(403);
			expect(((await res.json()) as { error: string }).error, path).toBe(REMOTE_SHELL_OFF);
		}
		// What the page shows is still its to read.
		expect((await phone.fetch("/api/plugins")).status).toBe(200);
		// The person's own page, signed in through Access, is not held back: its request reaches the Plugins page.
		expect((await post(signedIn, "/api/plugins/jobs", { action: "install", spec: "--force" })).status).not.toBe(403);
	} finally {
		await setRemoteShell(true);
	}
}, 60_000);

test("a page that is not the person's own runs no slash command omp runs itself that writes or runs things: /export never, /mcp add and the like while shells are off (#213)", async () => {
	const marker = join(root, "slash-marker");
	const exported = join(root, "slash-export.html");
	const prompt = (ws: WebSocket, liveId: string, message: string) =>
		request(ws, { t: "rpc", liveId, command: { type: "prompt", message } });
	let remote = await phone.socket();
	if (!remote) throw new Error("the tunnel refused the page");
	try {
		let chat = await request<{ liveId: string }>(remote, {
			t: "open",
			target: { kind: "new", cwd: root, args: ["--no-title"] },
		});
		// `/export` writes wherever it is told, as `export_html` does: never such a page's, shells or not.
		expect(await rejectionOf(prompt(remote, chat.liveId, `/export ${exported}`))).toThrow("may export this way");
		await request(remote, { t: "close", liveId: chat.liveId });

		await setRemoteShell(false);
		remote.close();
		const again = await phone.socket();
		if (!again) throw new Error("the tunnel refused the page");
		remote = again;
		chat = await request<{ liveId: string }>(remote, {
			t: "open",
			target: { kind: "new", cwd: root, args: ["--no-title"] },
		});
		for (const line of [
			`/mcp add evil -- /bin/sh -c "echo RAN > ${marker}"`,
			"  /mcp test evil",
			"/marketplace add https://example.com/market",
			"/plugin install evil",
			"/ssh add evil example.com",
			`/move ${tmpdir()}`,
		])
			expect(await rejectionOf(prompt(remote, chat.liveId, line)), line).toThrow(REMOTE_SHELL_OFF);
		expect(await rejectionOf(prompt(remote, chat.liveId, `/export ${exported}`))).toThrow("may export this way");
		// What only shows the conversation still goes to omp.
		await prompt(remote, chat.liveId, "/tools");
		await request(remote, { t: "close", liveId: chat.liveId });
		expect(existsSync(join(root, ".omp", "mcp.json"))).toBe(false);
		expect(existsSync(marker)).toBe(false);
		expect(existsSync(exported)).toBe(false);
	} finally {
		remote.close();
		await setRemoteShell(true);
	}
}, 60_000);
