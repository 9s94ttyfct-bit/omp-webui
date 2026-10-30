import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUD, claims, EMAIL, type Jwks, makeKey, sign, startJwks, TEAM } from "../support/access-jwt.ts";
import { ACCESS_COOKIE, type AccessTunnel, startAccessTunnel } from "../support/access-tunnel.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type Browser, type BrowserContext, devices, expect, type Page, test, webkit } from "./fixtures.ts";

/**
 * A remote page's connection, in a real browser through a stand-in for Cloudflare Access and its tunnel
 * (`tests/support/access-tunnel.ts`): the page reconnects by itself when the connection is cut under it, with the
 * Access session on every upgrade; a page whose Access session ended while it was away, or while its socket was open,
 * ends up at the Access sign-in instead of retrying for ever. Desktop Chrome, and WebKit as an iPad has it.
 */

const HOSTNAME = "omp.example.com";
const RECONNECTING = "Reconnecting to the omp-webui server";
/** What the page shows once its first answers have come in through the tunnel (the layout, which an iPad's is not the desktop's, does not matter). */
const loaded = (page: Page) => page.getByTestId("approval-picker");

let root: string;
let jwks: Jwks;
let server: TestServer;
let mintToken: (over?: Record<string, unknown>) => Promise<string>;

test.beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "ompw-remote-reconnect-"));
	const settings = join(root, "remote.json");
	writeFileSync(settings, JSON.stringify({ enabled: true, hostname: HOSTNAME, team: TEAM, aud: AUD, emails: [EMAIL] }));
	const key = await makeKey("reconnect-key");
	jwks = await startJwks([key]);
	const now = () => Math.floor(Date.now() / 1000);
	mintToken = (over = {}) => sign(key, claims(now(), { exp: now() + 3600, ...over }));
	// Nothing here calls a model.
	server = await startTestServer(
		0,
		{ OMP_WEBUI_REMOTE_CONFIG: settings, OMP_WEBUI_ACCESS_CERTS_URL: jwks.url },
		{ login: false },
	);
});

test.afterAll(async () => {
	await server?.stop();
	jwks?.stop();
	rmSync(root, { recursive: true, force: true });
});

interface World {
	tunnel: AccessTunnel;
	context: BrowserContext;
	page: Page;
	/** The browser has this Access session: Cloudflare put it in its cookie when the person signed in. */
	signIn(jwt: string): Promise<void>;
	/** The session ended: the browser no longer holds the cookie. */
	signOut(): Promise<void>;
}

/** A browser at the public hostname: the tunnel, a context with `contextOptions`, and a page that is not loaded yet. */
async function world(browser: Browser, contextOptions: Parameters<Browser["newContext"]>[0] = {}): Promise<World> {
	const tunnel = await startAccessTunnel(Number(new URL(server.url).port), { hostname: HOSTNAME });
	const context = await browser.newContext(contextOptions);
	const page = await context.newPage();
	return {
		tunnel,
		context,
		page,
		signIn: (jwt) => context.addCookies([{ name: ACCESS_COOKIE, value: jwt, url: tunnel.url, httpOnly: true }]),
		signOut: () => context.clearCookies({ name: ACCESS_COOKIE }),
	};
}

/** The page has loaded through the tunnel and its socket is open: the server said hello, and the list is there. */
async function connected(w: World): Promise<void> {
	await w.page.goto(w.tunnel.url);
	await expect(loaded(w.page)).toBeVisible();
	await expect.poll(() => w.tunnel.sockets.filter((s) => s.end === "open").length).toBe(1);
	await expect(w.page.getByText(RECONNECTING)).toHaveCount(0);
}

const { defaultBrowserType: _webkit, ...ipad } = devices["iPad Pro 11"];
const browsers: {
	name: string;
	launch: (chrome: Browser) => Promise<Browser>;
	options: Parameters<Browser["newContext"]>[0];
}[] = [
	{ name: "desktop Chrome", launch: async (chrome) => chrome, options: {} },
	// The config's `channel` is Chrome's: WebKit is launched on its own.
	{ name: "iPad Safari (WebKit)", launch: () => webkit.launch({ channel: undefined }), options: ipad },
];

for (const kind of browsers) {
	test.describe(kind.name, () => {
		// A page that is away, and a connection that is cut meanwhile.
		test("a page whose connection was cut reconnects by itself, with the Access session on the upgrade", async ({
			browser,
		}) => {
			const own = await kind.launch(browser);
			const w = await world(own, kind.options);
			try {
				const jwt = await mintToken();
				await w.signIn(jwt);
				await connected(w);
				expect(w.tunnel.upgrades).toEqual([{ token: jwt }]);

				// The network goes away under the socket, and stays away for a while.
				w.tunnel.holdUpgrades = true;
				w.tunnel.drop();
				await expect(w.page.getByText(RECONNECTING)).toBeVisible();
				await w.page.waitForTimeout(2500);
				await expect(w.page.getByText(RECONNECTING)).toBeVisible();

				// It comes back: no reload, no click. The page makes a socket of its own, with the session it has.
				w.tunnel.holdUpgrades = false;
				await expect(w.page.getByText(RECONNECTING)).toHaveCount(0, { timeout: 30_000 });
				await expect.poll(() => w.tunnel.sockets.filter((s) => s.end === "open").length).toBe(1);
				expect(w.tunnel.upgrades.at(-1)).toEqual({ token: jwt });
				expect(w.tunnel.upgrades.every((u) => u.token === jwt)).toBe(true);
				await expect(loaded(w.page)).toBeVisible();
			} finally {
				await w.context.close();
				if (own !== browser) await own.close();
				await w.tunnel.stop();
			}
		});

		test("a page whose Access session ended while it was away goes to the sign-in, and is back when the person has signed in", async ({
			browser,
		}) => {
			const own = await kind.launch(browser);
			const w = await world(own, kind.options);
			try {
				await w.signIn(await mintToken());
				await connected(w);

				// The device slept past its session: the cookie is gone, and the connection with it. Every way back is a
				// redirect to the sign-in, which a socket cannot follow.
				await w.signOut();
				w.tunnel.drop();
				await expect(w.page).toHaveURL(new RegExp(`^${w.tunnel.loginUrl}`), { timeout: 30_000 });
				await expect(w.page.getByText("Sign in to my-team")).toBeVisible();

				// Signed in again, Access sends the person back to the app, which is as it was left.
				const again = await mintToken();
				await w.signIn(again);
				await connected(w);
				expect(w.tunnel.upgrades.at(-1)).toEqual({ token: again });
			} finally {
				await w.context.close();
				if (own !== browser) await own.close();
				await w.tunnel.stop();
			}
		});

		test("a socket that is open when the Access session ends is closed by the server, and the page goes to the sign-in", async ({
			browser,
		}) => {
			const own = await kind.launch(browser);
			const w = await world(own, kind.options);
			try {
				// 50 s past its exp is inside the 60 s of skew the server allows: it works, for ten seconds more.
				const now = Math.floor(Date.now() / 1000);
				await w.signIn(await mintToken({ iat: now - 3600, exp: now - 50 }));
				await connected(w);

				await w.signOut();
				await expect(w.page).toHaveURL(new RegExp(`^${w.tunnel.loginUrl}`), { timeout: 30_000 });
				expect(w.tunnel.sockets.map((s) => s.end)).toEqual(["origin"]);
			} finally {
				await w.context.close();
				if (own !== browser) await own.close();
				await w.tunnel.stop();
			}
		});
	});
}

test("a page frozen while its connection is cut (a tab put to sleep) reconnects when it wakes", async ({ browser }) => {
	const w = await world(browser);
	try {
		await w.signIn(await mintToken());
		await connected(w);

		const cdp = await w.context.newCDPSession(w.page);
		await cdp.send("Page.enable");
		await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
		w.tunnel.drop();
		await new Promise((resolve) => setTimeout(resolve, 1500));
		await cdp.send("Page.setWebLifecycleState", { state: "active" });

		await expect.poll(() => w.tunnel.sockets.filter((s) => s.end === "open").length, { timeout: 30_000 }).toBe(1);
		await expect(w.page.getByText(RECONNECTING)).toHaveCount(0, { timeout: 30_000 });
		await expect(loaded(w.page)).toBeVisible();
	} finally {
		await w.context.close();
		await w.tunnel.stop();
	}
});
