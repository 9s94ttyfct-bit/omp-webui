import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteSnapshot } from "../../shared/remote.ts";
import { AUD, claims, EMAIL, makeKey, sign, startJwks, TEAM } from "../support/access-jwt.ts";
import { FAKE_TUNNEL_ID, makeFakeCloudflared } from "../support/fake-cloudflared.ts";
import { FIXTURE } from "../support/fixtures.ts";
import { startTestServer } from "../support/server.ts";
import { expect, test } from "./fixtures.ts";

/**
 * Remote access end to end, with nothing faked in the page or in the server: the real server, its real `/api/remote*`
 * routes and the real Settings card, a `cloudflared` and a `brew` that are scripts (`fake-cloudflared.ts`: the real ones
 * are not installed here and must not be), and the keys of Cloudflare Access generated here and served by a local
 * stand-in for the team's certs endpoint (`access-jwt.ts`).
 *
 * The card is driven from install to start. Then requests arrive as the tunnel's would: the public hostname as `Host`
 * and `Origin`, the Access token (signed with the fake key) in `Cf-Access-Jwt-Assertion`, `Cf-Visitor` saying https.
 * `cloudflared` itself is the one part that cannot be run, so a small proxy does what it does with a request (rewrites
 * `Host`, adds Cloudflare's headers, carries the WebSocket) and a real browser goes through it: the page and its socket
 * work with the token, and without it the same page is refused, with the app's own cookie in hand.
 */

const HOSTNAME = "omp.example.com";

interface Tunnel {
	/** Where a browser reaches the stand-in. */
	url: string;
	/** The Access token the next request carries; null: none (a request that never went through Access). */
	jwt: string | null;
	stop(): Promise<void>;
}

/** The headers a request has once Cloudflare and `cloudflared` have carried it to the origin. */
function throughTunnel(headers: IncomingHttpHeaders, jwt: string | null): Record<string, string | string[]> {
	const out: Record<string, string | string[] | undefined> = {
		...headers,
		host: HOSTNAME,
		// The browser is at https://<hostname> as far as the server can tell.
		...(headers.origin === undefined ? {} : { origin: `https://${HOSTNAME}` }),
		"cf-visitor": '{"scheme":"https"}',
		"cf-ray": "8f0000000000aaaa-SJC",
		"cf-connecting-ip": "203.0.113.7",
		"cdn-loop": "cloudflare; loops=1",
	};
	if (jwt !== null) out["cf-access-jwt-assertion"] = jwt;
	return Object.fromEntries(Object.entries(out).filter((e): e is [string, string | string[]] => e[1] !== undefined));
}

/** A stand-in for `cloudflared` carrying `https://<hostname>` to `port`: plain HTTP and the WebSocket upgrade. */
async function startTunnel(port: number, jwt: string | null): Promise<Tunnel> {
	const tunnel: Tunnel = { url: "", jwt, stop: async () => {} };
	const open = new Set<Socket>();
	const server: Server = createServer((req, res) => {
		const up = httpRequest(
			{ host: "127.0.0.1", port, method: req.method, path: req.url, headers: throughTunnel(req.headers, tunnel.jwt) },
			(answer) => {
				res.writeHead(answer.statusCode ?? 502, answer.headers);
				answer.pipe(res);
			},
		);
		up.on("error", () => res.destroy());
		req.pipe(up);
	});
	server.on("connection", (socket) => {
		open.add(socket);
		socket.on("close", () => open.delete(socket));
	});
	server.on("upgrade", (req, client, head) => {
		const up = netConnect(port, "127.0.0.1", () => {
			const headers = throughTunnel(req.headers, tunnel.jwt);
			const lines = Object.entries(headers).flatMap(([name, value]) =>
				(Array.isArray(value) ? value : [value]).map((v) => `${name}: ${v}`),
			);
			up.write(`${req.method} ${req.url} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
			if (head.length > 0) up.write(head);
			client.pipe(up);
			up.pipe(client);
		});
		open.add(up);
		up.on("close", () => {
			open.delete(up);
			client.destroy();
		});
		up.on("error", () => client.destroy());
		client.on("error", () => up.destroy());
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("the tunnel stand-in did not listen");
	tunnel.url = `http://127.0.0.1:${address.port}`;
	tunnel.stop = async () => {
		for (const socket of open) socket.destroy();
		const closed = Promise.withResolvers<void>();
		server.close(() => closed.resolve());
		await closed.promise;
	};
	return tunnel;
}

interface Answer {
	status: number;
	headers: IncomingHttpHeaders;
	body: string;
}

/** One request to the server exactly as the tunnel would make it (no browser, no proxy): the status, the headers, the body. */
function viaTunnel(
	port: number,
	path: string,
	o: { jwt?: string | null; cookie?: string; method?: string } = {},
): Promise<Answer> {
	const headers: Record<string, string> = {
		host: HOSTNAME,
		"cf-visitor": '{"scheme":"https"}',
		"cf-ray": "8f0000000000aaaa-SJC",
		"cf-connecting-ip": "203.0.113.7",
		...(o.cookie ? { cookie: o.cookie } : {}),
		...(o.jwt ? { "cf-access-jwt-assertion": o.jwt } : {}),
	};
	const done = Promise.withResolvers<Answer>();
	const req = httpRequest({ host: "127.0.0.1", port, path, method: o.method ?? "GET", headers }, (res) => {
		const chunks: Buffer[] = [];
		res.on("data", (c: Buffer) => chunks.push(c));
		res.on("end", () =>
			done.resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
		);
	});
	req.on("error", done.reject);
	req.end();
	return done.promise;
}

test("the card sets the tunnel up against the real routes; then the page and its socket work through it with an Access token, and not without one", async ({
	browser,
}) => {
	test.setTimeout(240_000);
	const dir = mkdtempSync(join(tmpdir(), "ompw-remote-flow-"));
	const fake = makeFakeCloudflared(join(dir, "fake"), { installed: false });
	const key = await makeKey("flow-key");
	const jwks = await startJwks([key]);
	const jwt = await sign(key, claims(Math.floor(Date.now() / 1000)));
	// Nothing here calls a model.
	const server = await startTestServer(
		0,
		{
			OMP_WEBUI_CLOUDFLARED: fake.bin,
			OMP_WEBUI_BREW: fake.brew,
			OMP_WEBUI_ACCESS_CERTS_URL: jwks.url,
		},
		{ login: false },
	);
	const port = Number(new URL(server.url).port);
	const snapshot = async (): Promise<RemoteSnapshot> =>
		(await (
			await fetch(`${server.url}/api/remote`, { headers: { "x-omp-webui-token": server.accessToken } })
		).json()) as RemoteSnapshot;
	let tunnel: Tunnel | null = null;
	try {
		// ------------------------------------------------------------ nothing is on yet: the hostname is a foreign Host
		const off = await viaTunnel(port, "/", { jwt });
		expect(off.status, "a valid token does not open a hostname that remote access is not enabled for").toBe(403);

		// ------------------------------------------------------------ the Settings card, install to start
		const local = await browser.newContext();
		await local.route("https://dash.cloudflare.com/**", (route) => route.fulfill({ body: "signed in" }));
		const settings = await local.newPage();
		await settings.goto(`${server.url}/?token=${server.accessToken}#/settings/app`);
		await expect(settings.getByTestId("remote-settings")).toBeVisible();
		await expect(settings.getByTestId("remote-status")).toHaveAttribute("data-state", "off");

		// install: the `brew` of the fake puts the program where OMP_WEBUI_CLOUDFLARED points
		await settings.getByTestId("remote-install").click();
		await expect(settings.getByTestId("remote-step-install")).toHaveAttribute("data-done", "true");
		expect(fake.brewCalls()).toEqual(["install cloudflared"]);
		expect((await snapshot()).installed).toBe(true);

		// log in: the page opens the URL cloudflared printed, and the card waits for the certificate
		const popup = settings.waitForEvent("popup");
		await settings.getByTestId("remote-login").click();
		expect((await popup).url()).toMatch(/^https:\/\/dash\.cloudflare\.com\/argotunnel/);
		await expect(settings.getByTestId("remote-login-waiting")).toBeVisible();
		fake.approveLogin();
		await expect(settings.getByTestId("remote-step-login")).toHaveAttribute("data-done", "true", { timeout: 30_000 });
		expect(existsSync(join(server.home, ".cloudflared", "cert.pem"))).toBe(true);

		// the settings: what the page sends is what the server keeps (and what RemoteAuth will check requests against)
		await settings.getByTestId("remote-hostname").fill(HOSTNAME);
		await settings.getByTestId("remote-team").fill(TEAM);
		await settings.getByTestId("remote-aud").fill(AUD);
		await settings.getByTestId("remote-emails").fill(EMAIL);
		await settings.getByTestId("remote-save").click();
		await expect(settings.getByTestId("remote-url")).toHaveText(`https://${HOSTNAME}`);
		await expect
			.poll(async () => (await snapshot()).config)
			.toMatchObject({
				hostname: HOSTNAME,
				team: TEAM,
				aud: AUD,
				emails: [EMAIL],
				enabled: false,
			});

		// set up: the tunnel is made, the hostname is pointed at it, cloudflared.yml says where it goes
		await settings.getByTestId("remote-setup").click();
		await expect.poll(async () => (await snapshot()).config.tunnelId).toBe(FAKE_TUNNEL_ID);
		await expect(settings.getByTestId("remote-setup")).toBeEnabled();
		expect(fake.calls().some((c) => c.startsWith("tunnel create "))).toBe(true);
		expect(fake.calls()).toContain(`tunnel route dns ${FAKE_TUNNEL_ID} ${HOSTNAME}`);
		expect(existsSync(join(server.home, ".cloudflared", `${FAKE_TUNNEL_ID}.json`))).toBe(true);

		// start: the tunnel runs, says it is connected, and remote access is enabled
		await settings.getByTestId("remote-start").click();
		await expect(settings.getByTestId("remote-status")).toHaveAttribute("data-state", "connected");
		await expect.poll(() => fake.runs()).toBe(1);
		expect(fake.runConfig(1)).toContain(`service: "http://127.0.0.1:${port}"`);
		expect(fake.runConfig(1)).toContain(`hostname: "${HOSTNAME}"`);
		expect((await snapshot()).config.enabled).toBe(true);

		// ------------------------------------------------------------ requests as the tunnel makes them
		const page = await viaTunnel(port, "/", { jwt });
		expect(page.status).toBe(200);
		expect(page.body).toContain('id="root"');
		const cookie = String(page.headers["set-cookie"] ?? "");
		expect(cookie).toContain("ompw_token=");
		for (const attribute of ["Secure", "HttpOnly", "SameSite=Strict"]) expect(cookie).toContain(attribute);
		const own = cookie.split(";")[0];

		// the API takes the Access token and the app's own cookie, both
		const meta = await viaTunnel(port, "/api/meta", { jwt, cookie: own });
		expect(meta.status).toBe(200);
		expect(JSON.parse(meta.body).remote).toBe(true);
		expect((await viaTunnel(port, "/api/meta", { jwt })).status, "the app's own cookie is needed too").toBe(401);
		// and the tunnel's own settings are never a remote page's to change
		expect((await viaTunnel(port, "/api/remote", { jwt, cookie: own })).status).toBe(403);
		expect((await viaTunnel(port, "/api/remote/stop", { jwt, cookie: own, method: "POST" })).status).toBe(403);
		expect((await snapshot()).status.state, "the refused Stop did not stop it").toBe("connected");

		// ------------------------------------------------------------ without the Access token: refused
		const none = await viaTunnel(port, "/");
		expect(none.status, "no Access token at all").toBe(403);
		expect(none.headers["set-cookie"]).toBeUndefined();
		expect((await viaTunnel(port, "/api/meta", { cookie: own })).status, "the app's cookie alone is not enough").toBe(
			403,
		);
		const forged = `${jwt.split(".").slice(0, 2).join(".")}.${jwt.split(".")[2]?.split("").reverse().join("")}`;
		expect((await viaTunnel(port, "/", { jwt: forged })).status, "a token whose signature does not verify").toBe(403);
		const stranger = await makeKey("flow-key");
		const foreign = await sign(stranger, claims(Math.floor(Date.now() / 1000)));
		expect((await viaTunnel(port, "/", { jwt: foreign })).status, "a token of another key under the same kid").toBe(
			403,
		);
		const wrongEmail = await sign(key, claims(Math.floor(Date.now() / 1000), { email: "someone@else.test" }));
		expect((await viaTunnel(port, "/", { jwt: wrongEmail })).status, "an email that is not allowed").toBe(403);

		// ------------------------------------------------------------ a browser through the tunnel: the page and the socket
		tunnel = await startTunnel(port, jwt);
		const remote = await browser.newContext();
		const remotePage = await remote.newPage();
		const received: string[] = [];
		let socketClosed = false;
		remotePage.on("websocket", (ws) => {
			ws.on("framereceived", (f) => received.push(String(f.payload)));
			ws.on("close", () => {
				socketClosed = true;
			});
		});
		const first = await remotePage.goto(tunnel.url);
		expect(first?.status()).toBe(200);
		// the page loads its data with the cookie the server gave it, and the socket says hello
		await expect(remotePage.locator('[data-testid="session-item"]', { hasText: FIXTURE.alphaTitle })).toBeVisible();
		await expect.poll(() => received.some((m) => m.includes('"t":"hello"'))).toBe(true);
		expect(await remotePage.evaluate(async () => (await (await fetch("/api/meta")).json()).remote)).toBe(true);
		// a conversation opens over the socket: omp is started for it, and the page gets its transcript
		await remotePage.locator('[data-testid="session-item"]', { hasText: FIXTURE.alphaTitle }).click();
		await expect(remotePage.getByTestId("composer")).toBeVisible();
		await expect(remotePage.getByText(FIXTURE.alphaReply).first()).toBeVisible();
		expect(socketClosed).toBe(false);

		// the same browser, the same cookies, but no Access token any more: the page and the socket are refused
		tunnel.jwt = null;
		expect(await remotePage.evaluate(() => fetch("/api/meta").then((r) => r.status))).toBe(403);
		const opened = await remotePage.evaluate(
			() =>
				new Promise<string>((resolve) => {
					const ws = new WebSocket(`ws://${location.host}/ws`);
					ws.onopen = () => {
						ws.close();
						resolve("open");
					};
					ws.onerror = () => resolve("refused");
				}),
		);
		expect(opened).toBe("refused");
		const reloaded = await remotePage.reload();
		expect(reloaded?.status()).toBe(403);
		tunnel.jwt = jwt;

		// ------------------------------------------------------------ Stop turns remote access off, and ends what is open
		// The token is back: the page loads again, with a socket of its own (the one it had went with the 403 page).
		received.length = 0;
		socketClosed = false;
		expect((await remotePage.reload())?.status()).toBe(200);
		await expect(remotePage.locator('[data-testid="session-item"]', { hasText: FIXTURE.alphaTitle })).toBeVisible();
		await expect.poll(() => received.some((m) => m.includes('"t":"hello"'))).toBe(true);
		expect(socketClosed).toBe(false);
		await expect(settings.getByTestId("remote-stop")).toBeVisible();
		await settings.getByTestId("remote-stop").click();
		await expect(settings.getByTestId("remote-status")).toHaveAttribute("data-state", "off");
		expect((await snapshot()).config.enabled).toBe(false);
		// the open socket is ended by the server (remote access changed), and a valid token no longer opens anything
		await expect.poll(() => socketClosed, { timeout: 15_000 }).toBe(true);
		expect((await viaTunnel(port, "/", { jwt })).status, "a valid token after Stop").toBe(403);
	} finally {
		await tunnel?.stop();
		// A tunnel that outlived its server must not outlive the run.
		for (const line of fake.events()) {
			const pid = /^run \d+ pid=(\d+)$/.exec(line)?.[1];
			if (!pid) continue;
			try {
				process.kill(-Number(pid), "SIGKILL");
			} catch {}
		}
		await server.stop();
		jwks.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});
