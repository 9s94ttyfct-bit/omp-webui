import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { DEFAULT_REMOTE_CONFIG, type RemoteConfig, type RemoteSnapshot } from "../../shared/remote.ts";
import { NO_REMOTE_AI } from "../../shared/remote-ai.ts";
import { zh } from "../../web/src/i18n/zh-CN/remote.ts";
import { remoteEn as en } from "../support/i18n-en.ts";
import { type Msg, type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * Settings › Remote access, the sidebar's indicator and what a page that came in through the tunnel shows of a
 * conversation. The server's `/api/remote*` routes belong to the tunnel slice (tests of their own); here they are
 * answered by a small
 * stand-in that keeps the state the real ones keep, so every state of the card can be reached without a Cloudflare
 * account, a `cloudflared` or a browser sign-in. No model call: the permission-mode specs use the real omp the same way.
 */

const AUD = "0123456789abcdef".repeat(4);
const LOGIN_URL = "https://dash.cloudflare.com/argotunnel?callback=ompw-test";

const WORK = () => process.env.OMPW_E2E_WORK as string;

interface Call {
	method: string;
	path: string;
	body: unknown;
}

interface Fake {
	snap: RemoteSnapshot;
	calls: Call[];
	/** Answers a route with something else than the stand-in's own (an error the server would give). */
	refuse: Map<string, { status: number; error: string }>;
}

function snapshot(
	over: Omit<Partial<RemoteSnapshot>, "config"> & { config?: Partial<RemoteConfig> } = {},
): RemoteSnapshot {
	const { config, ...rest } = over;
	const merged = { ...DEFAULT_REMOTE_CONFIG, ...config };
	return {
		config: merged,
		status: { state: "off" },
		installed: false,
		loggedIn: false,
		url: merged.hostname ? `https://${merged.hostname}` : "",
		ai: NO_REMOTE_AI,
		...rest,
	};
}

/** What is on file once everything has been set up: every field filled, the tunnel made. */
const CONFIGURED = {
	hostname: "omp.example.com",
	team: "my-team",
	aud: AUD,
	emails: ["me@example.com"],
	tunnelId: "11111111-2222-3333-4444-555555555555",
	tunnelName: "omp-webui",
};

/** Answer `/api/remote*` as the server does: the same snapshot from every route, the login URL on login's. */
async function fakeRemote(page: Page, start: RemoteSnapshot): Promise<Fake> {
	const fake: Fake = { snap: start, calls: [], refuse: new Map() };
	await page.route(/\/api\/remote(\/|$)/, async (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname.replace("/api/remote", "") || "/";
		const body = req.method() === "POST" ? (req.postDataJSON() ?? {}) : undefined;
		fake.calls.push({ method: req.method(), path, body });
		// The snapshot is read with GET; every action is a POST (a GET to an action would be a request the server refuses).
		if ((path === "/") !== (req.method() === "GET"))
			return route.fulfill({ status: 405, json: { error: "Method not allowed" } });
		const refused = fake.refuse.get(path);
		if (refused) return route.fulfill({ status: refused.status, json: { error: refused.error } });
		const snap = fake.snap;
		if (path === "/config") {
			const config = { ...snap.config, ...(body as Partial<RemoteConfig>) };
			fake.snap = { ...snap, config, url: config.hostname ? `https://${config.hostname}` : "" };
		} else if (path === "/install") fake.snap = { ...snap, installed: true };
		else if (path === "/setup")
			fake.snap = {
				...snap,
				config: { ...snap.config, tunnelId: CONFIGURED.tunnelId, tunnelName: CONFIGURED.tunnelName },
			};
		else if (path === "/start")
			fake.snap = { ...snap, config: { ...snap.config, enabled: true }, status: { state: "starting" } };
		else if (path === "/stop") fake.snap = { ...snap, status: { state: "off" } };
		const answer = path === "/login" ? { ...fake.snap, loginUrl: LOGIN_URL } : fake.snap;
		return route.fulfill({ json: answer });
	});
	return fake;
}

/** The page's own copy of what the tunnel said, as the server pushes it on the socket. */
function push(tap: SocketTap, fake: Fake, status: RemoteSnapshot["status"]): void {
	fake.snap = { ...fake.snap, status };
	tap.push({ t: "remote", status } satisfies Msg);
}

async function openSettings(page: Page, lang = "en", theme = "light") {
	await page.addInitScript(
		([l, m]) => {
			localStorage.setItem("ompw.lang", l);
			localStorage.setItem("ompw.theme", m);
		},
		[lang, theme],
	);
	await page.goto("/#/settings/app");
}

const card = (page: Page) => page.getByTestId("remote-settings");
const indicator = (page: Page) => page.getByTestId("remote-indicator");
const call = (fake: Fake, method: string, path: string) =>
	fake.calls.filter((c) => c.method === method && c.path === path);

test("a fresh machine: nothing is done, the indicator says off, and a Start the server refuses says why", async ({
	page,
}) => {
	const fake = await fakeRemote(page, snapshot());
	await openSettings(page);
	await expect(card(page).getByRole("heading", { name: en.settingsTitle })).toBeVisible();
	await expect(page.getByTestId("remote-status")).toHaveAttribute("data-state", "off");
	await expect(page.getByTestId("remote-status")).toContainText("Tunnel: Off");
	await expect(card(page)).toContainText(en.urlEmpty);
	await expect(page.getByTestId("remote-step-install")).toHaveAttribute("data-done", "false");
	await expect(page.getByTestId("remote-step-login")).toHaveAttribute("data-done", "false");
	// The sign-in needs cloudflared; the tunnel needs a hostname and the steps before it.
	await expect(page.getByTestId("remote-login")).toBeDisabled();
	await expect(page.getByTestId("remote-setup")).toBeDisabled();
	await expect(page.getByTestId("remote-save")).toBeDisabled();
	// The guide is open while there is no AUD to paste yet.
	await expect(page.getByTestId("remote-guide")).toHaveAttribute("open", "");
	await expect(page.getByTestId("remote-guide")).toContainText("Zero Trust › Access › Applications");
	// The last step says how to sign in only about once a month.
	await expect(page.getByTestId("remote-guide").locator("li")).toHaveCount(5);
	await expect(page.getByTestId("remote-guide").locator("li").last()).toHaveText(en.guideSession);
	await expect(indicator(page)).toHaveAttribute("data-state", "off");
	await expect(indicator(page)).toHaveText("Remote off");

	fake.refuse.set("/start", { status: 400, error: "Set up the tunnel first: no tunnel has been created." });
	await page.getByTestId("remote-start").click();
	await expect(page.getByTestId("remote-error")).toContainText("Set up the tunnel first: no tunnel has been created.");
	await expect(page.getByTestId("remote-status")).toHaveAttribute("data-state", "off");

	// A second operation while one runs is refused by the server: the card says so, and the button is free again.
	fake.refuse.set("/install", { status: 409, error: "Another remote-access operation is running." });
	await page.getByTestId("remote-install").click();
	await expect(page.getByTestId("remote-error")).toContainText("Another remote-access operation is running.");
	await expect(page.getByTestId("remote-step-install")).toHaveAttribute("data-done", "false");
	await expect(page.getByTestId("remote-install")).toBeEnabled();
});

test("the card walks through install, login, the settings, set-up and start, and follows what the tunnel says", async ({
	page,
	context,
	e2eServer,
}) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: e2eServer.url });
	await context.route("https://dash.cloudflare.com/**", (route) => route.fulfill({ body: "signed in" }));
	const tap = await tapSocket(page);
	const fake = await fakeRemote(page, snapshot());
	await openSettings(page);

	// 1. cloudflared
	await page.getByTestId("remote-install").click();
	await expect(page.getByTestId("remote-step-install")).toHaveAttribute("data-done", "true");
	expect(call(fake, "POST", "/install")).toHaveLength(1);

	// 2. The sign-in opens the page the server named, and the card waits until the server sees the certificate.
	const popup = page.waitForEvent("popup");
	await page.getByTestId("remote-login").click();
	expect((await popup).url()).toBe(LOGIN_URL);
	await expect(page.getByTestId("remote-login-waiting")).toBeVisible();
	await expect(page.getByTestId("remote-login-link")).toHaveAttribute("href", LOGIN_URL);
	fake.snap = { ...fake.snap, loggedIn: true };
	// The server says so on the socket when its login process ends; the card asks again and notices.
	push(tap, fake, { state: "off", message: "Logged in to Cloudflare" });
	await expect(page.getByTestId("remote-step-login")).toHaveAttribute("data-done", "true");
	await expect(page.getByTestId("remote-login-waiting")).toHaveCount(0);

	// 3. The settings: nothing can be saved before something changes; what is sent is what was typed.
	await expect(page.getByTestId("remote-save")).toBeDisabled();
	await page.getByTestId("remote-hostname").fill("omp.example.com");
	await page.getByTestId("remote-team").fill("my-team");
	await page.getByTestId("remote-aud").fill(AUD);
	await page.getByTestId("remote-emails").fill("me@example.com, you@example.com\nme@example.com");
	await expect(page.getByTestId("remote-setup")).toBeDisabled(); // unsaved fields: set-up would use the old ones
	await page.getByTestId("remote-save").click();
	await expect(page.getByTestId("toast").filter({ hasText: en.saveDone })).toBeVisible();
	expect(call(fake, "POST", "/config").at(-1)?.body).toEqual({
		hostname: "omp.example.com",
		team: "my-team",
		aud: AUD,
		emails: ["me@example.com", "you@example.com"],
	});
	await expect(page.getByTestId("remote-save")).toBeDisabled();
	await expect(page.getByTestId("remote-url")).toHaveText("https://omp.example.com");

	// 4. Set up, then start: the line follows the server's pushes, `message` included.
	await expect(page.getByTestId("remote-setup")).toBeEnabled();
	await page.getByTestId("remote-setup").click();
	expect(call(fake, "POST", "/setup")).toHaveLength(1);
	await page.getByTestId("remote-start").click();
	await expect(page.getByTestId("remote-status")).toHaveAttribute("data-state", "starting");
	await expect(indicator(page)).toHaveAttribute("data-state", "starting");
	push(tap, fake, { state: "starting", message: "Registered tunnel connection 1 of 4" });
	await expect(page.getByTestId("remote-message")).toHaveText("Registered tunnel connection 1 of 4");
	push(tap, fake, { state: "connected" });
	await expect(page.getByTestId("remote-status")).toHaveAttribute("data-state", "connected");
	await expect(page.getByTestId("remote-status")).toContainText("Tunnel: Connected");
	await expect(indicator(page)).toHaveText("Remote connected");
	await expect(page.getByTestId("remote-message")).toHaveCount(0);

	// The address is one click from the clipboard.
	await page.getByTestId("remote-copy").click();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("https://omp.example.com");

	// While it runs it is stopped, not set up or started again.
	await expect(page.getByTestId("remote-setup")).toHaveCount(0);
	await expect(page.getByTestId("remote-start")).toHaveCount(0);
	await page.getByTestId("remote-stop").click();
	await expect(page.getByTestId("remote-status")).toHaveAttribute("data-state", "off");
	await expect(page.getByTestId("remote-start")).toBeEnabled();
	expect(call(fake, "POST", "/stop")).toHaveLength(1);
});

test("what the server refuses is shown with its reason, and the typed settings stay for another try", async ({
	page,
}) => {
	const fake = await fakeRemote(page, snapshot({ installed: true, loggedIn: true }));
	await openSettings(page);
	fake.refuse.set("/config", { status: 400, error: "hostname must be a DNS name under a zone you own" });
	await page.getByTestId("remote-hostname").fill("not a host");
	await page.getByTestId("remote-save").click();
	await expect(page.getByTestId("remote-error")).toContainText("hostname must be a DNS name under a zone you own");
	await expect(page.getByTestId("remote-hostname")).toHaveValue("not a host");
	await expect(page.getByTestId("remote-save")).toBeEnabled();

	// Cancel puts back what is on file; a later success clears the message.
	await page.getByTestId("remote-revert").click();
	await expect(page.getByTestId("remote-hostname")).toHaveValue("");
	fake.refuse.clear();
	await page.getByTestId("remote-hostname").fill("omp.example.com");
	await page.getByTestId("remote-save").click();
	await expect(page.getByTestId("remote-error")).toHaveCount(0);
	await expect(page.getByTestId("remote-hostname")).toHaveValue("omp.example.com");

	// A switch is saved as soon as it is flipped, and only that field is sent.
	// The box follows the server's answer, not the click: it is checked once the answer is in.
	await page.getByTestId("remote-autostart").click();
	await expect(page.getByTestId("remote-autostart")).toBeChecked();
	expect(call(fake, "POST", "/config").at(-1)?.body).toEqual({ autostart: true });
});

test("a tunnel that failed says why, in the warning colour, and offers Start again", async ({ page }) => {
	await fakeRemote(
		page,
		snapshot({
			installed: true,
			loggedIn: true,
			config: { ...CONFIGURED, enabled: true },
			status: { state: "error", message: "Unable to reach the Cloudflare edge: no route to host" },
		}),
	);
	await openSettings(page);
	await expect(page.getByTestId("remote-status")).toHaveAttribute("data-state", "error");
	await expect(page.getByTestId("remote-status")).toContainText("Tunnel: Not running");
	await expect(page.getByTestId("remote-message")).toHaveText("Unable to reach the Cloudflare edge: no route to host");
	await expect(page.getByTestId("remote-message")).toHaveClass(/text-danger/);
	await expect(indicator(page)).toHaveAttribute("data-state", "error");
	await expect(indicator(page)).toHaveText("Remote not running");
	await expect(page.getByTestId("remote-start")).toBeEnabled();
	// The guide is put away once there is an AUD.
	await expect(page.getByTestId("remote-guide")).not.toHaveAttribute("open", "");
});

test("the indicator opens Settings, and a server without the routes shows neither the card nor the indicator", async ({
	page,
}) => {
	await fakeRemote(page, snapshot({ installed: true }));
	await page.goto("/");
	await indicator(page).click();
	await expect(page).toHaveURL(/#\/settings\/app$/);
	await expect(card(page)).toBeVisible();

	const other = await page.context().newPage();
	await other.route(/\/api\/remote(\/|$)/, (route) => route.fulfill({ status: 404, json: { error: "Not found" } }));
	await other.goto("/#/settings/app");
	await expect(other.getByTestId("settings-page")).toBeVisible();
	await expect(other.getByTestId("remote-settings")).toHaveCount(0);
	await expect(other.getByTestId("remote-indicator")).toHaveCount(0);
	await other.close();
});

test("on a page that came in through the tunnel the card is refused and never asks the tunnel anything", async ({
	page,
}) => {
	const asked: string[] = [];
	page.on("request", (r) => {
		if (/\/api\/remote(\/|$)/.test(new URL(r.url()).pathname)) asked.push(r.url());
	});
	await page.route("**/api/meta", async (route) => {
		const real = await (await route.fetch()).json();
		return route.fulfill({ json: { ...real, remote: true } });
	});
	await page.goto("/#/settings/app");
	await expect(page.getByTestId("remote-refused")).toHaveText(en.settingsRemoteRefused);
	await expect(page.getByTestId("remote-install")).toHaveCount(0);
	await expect(page.getByTestId("remote-indicator")).toHaveCount(0);
	expect(asked).toEqual([]);
});

/** A new chat in the shared folder; the test omp has no mode configured, so it starts in Auto-approve. */
async function newChat(page: Page): Promise<SocketTap> {
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), WORK());
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.route(/\/api\/remote(\/|$)/, (route) => route.fulfill({ status: 403, json: { error: "forbidden" } }));
	return tap;
}

const asRemotePage = (page: Page) =>
	page.route("**/api/meta", async (route) => {
		const real = await (await route.fetch()).json();
		return route.fulfill({ json: { ...real, remote: true } });
	});

test("a remote page shows a conversation's permission mode exactly as a local page does: no warning, no forced label, no take-back control", async ({
	page,
}) => {
	const picker = page.getByTestId("approval-picker");
	await newChat(page);
	await page.goto("/");
	await expect(picker).toHaveAttribute("data-mode", "yolo", { timeout: 60_000 });
	await expect(picker).toContainText("Auto-approve");

	await asRemotePage(page);
	await page.reload();
	await expect(picker).toHaveAttribute("data-mode", "yolo", { timeout: 60_000 });
	await expect(picker).toContainText("Auto-approve");
	await expect(page.getByTestId("remote-banner")).toHaveCount(0);
	await picker.click();
	await expect(page.getByTestId("approval-yolo")).toHaveAttribute("aria-checked", "true");
	await expect(page.getByTestId("approval-forced-note")).toHaveCount(0);
	await expect(page.getByTestId("approval-takeover")).toHaveCount(0);

	// Choosing a mode is the same ordinary change as on a local page.
	await page.getByTestId("approval-always-ask").click();
	await expect(picker).toHaveAttribute("data-mode", "always-ask");
	await expect(picker).toContainText("Ask every time");
	await expect(page.getByTestId("remote-banner")).toHaveCount(0);
	// Back to the default for the specs after this one.
	await page.request.post("/api/approval", { data: { mode: null }, headers: { "x-omp-webui": "1" } });
});

test("a socket the server ended with 4401 (the Access token ran out) loads the page again instead of retrying forever", async ({
	page,
}) => {
	let connections = 0;
	await page.routeWebSocket(/\/ws$/, (ws) => {
		const server = ws.connectToServer();
		connections++;
		if (connections === 1) return ws.close({ code: 4401, reason: "Access session expired" });
		ws.onMessage((raw) => server.send(raw));
		server.onMessage((raw) => ws.send(raw));
	});
	let loads = 0;
	page.on("load", () => loads++);
	await page.goto("/");
	await expect.poll(() => loads).toBe(2);
	await expect(page.getByTestId("session-list")).toBeVisible();
	expect(connections).toBe(2);
	expect(loads).toBe(2);
});

test("Chinese: the card, the indicator and the strings under them are the Chinese pack's", async ({ page }) => {
	await fakeRemote(
		page,
		snapshot({ installed: true, config: { ...CONFIGURED, enabled: true }, status: { state: "off" } }),
	);
	await openSettings(page, "zh-CN");
	await expect(card(page).getByRole("heading", { name: zh.settingsTitle })).toBeVisible();
	await expect(page.getByTestId("remote-status")).toContainText("隧道：已关闭");
	await expect(page.getByTestId("remote-step-install")).toContainText(zh.stepInstallDone);
	await expect(page.getByTestId("remote-step-login")).toContainText(zh.stepLogin);
	await expect(page.getByTestId("remote-guide")).toContainText(zh.guideTitle);
	await expect(indicator(page)).toHaveText(zh.indicatorOff);
});

for (const lang of ["en", "zh-CN"]) {
	for (const theme of ["light", "dark"]) {
		test(`the card is readable in ${lang} ${theme}, and its picture is kept`, async ({ page }, testInfo) => {
			await page.setViewportSize({ width: 1400, height: 1500 });
			await fakeRemote(
				page,
				snapshot({
					installed: true,
					loggedIn: true,
					config: { ...CONFIGURED, enabled: true, emails: ["me@example.com", "you@example.com"] },
					status: { state: "connected" },
				}),
			);
			await openSettings(page, lang, theme);
			await expect(page.getByTestId("remote-status")).toHaveAttribute("data-state", "connected");
			await page.getByTestId("remote-guide").evaluate((el) => el.setAttribute("open", ""));
			await card(page).scrollIntoViewIfNeeded();
			const { violations } = await new AxeBuilder({ page })
				.include('[data-testid="remote-settings"]')
				.withRules(["color-contrast", "label", "aria-allowed-attr"])
				.analyze();
			expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
			// The picture goes to the report; with OMPW_REMOTE_SHOTS set it is also written there (the PR's screenshots).
			const path = process.env.OMPW_REMOTE_SHOTS
				? `${process.env.OMPW_REMOTE_SHOTS}/remote-${lang}-${theme}.png`
				: undefined;
			const png = await card(page).screenshot({ path, animations: "disabled" });
			await testInfo.attach(`remote-${lang}-${theme}`, { body: png, contentType: "image/png" });
		});
	}
}

/** A remote access settings file as another Mac exported it (`shared/remote-transfer.ts`), as a file the page can be given. */
const settingsFile = (content: unknown, name = "omp-webui-remote-access.json") => ({
	name,
	mimeType: "application/json",
	buffer: Buffer.from(typeof content === "string" ? content : JSON.stringify(content)),
});

test("Export settings saves the team, the AUD tag and the allowed addresses, and nothing else of this Mac", async ({
	page,
}) => {
	await fakeRemote(
		page,
		snapshot({
			installed: true,
			loggedIn: true,
			config: { ...CONFIGURED, emails: ["me@example.com", "you@example.com"] },
		}),
	);
	await openSettings(page);
	await expect(page.getByTestId("remote-transfer")).toContainText(en.transferTitle);
	const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("remote-export").click()]);
	expect(download.suggestedFilename()).toBe("omp-webui-remote-access.json");
	const text = readFileSync(await download.path(), "utf8");
	expect(JSON.parse(text)).toEqual({
		kind: "omp-webui-remote-access",
		version: 1,
		team: "my-team",
		aud: AUD,
		emails: ["me@example.com", "you@example.com"],
	});
	// Nothing that belongs to this Mac alone: not its hostname, not its tunnel.
	for (const own of [CONFIGURED.hostname, CONFIGURED.tunnelId]) expect(text).not.toContain(own);
	// (The tunnel's name, omp-webui, is also in the file's kind: the key set above is what shows it is not there.)
	await expect(page.getByTestId("toast").filter({ hasText: "omp-webui-remote-access.json" })).toBeVisible();
});

test("a Mac with no team, AUD tag or address has nothing to export", async ({ page }) => {
	await fakeRemote(page, snapshot());
	await openSettings(page);
	await expect(page.getByTestId("remote-export")).toBeDisabled();
	await expect(page.getByTestId("remote-import")).toBeEnabled();
});

test("Import settings fills the form from the file, keeps this Mac's own hostname, and nothing is saved until Save", async ({
	page,
}) => {
	const fake = await fakeRemote(page, snapshot({ installed: true, loggedIn: true }));
	await openSettings(page);
	await page.getByTestId("remote-hostname").fill("second.example.com");
	await page.getByTestId("remote-import-file").setInputFiles(
		settingsFile({
			kind: "omp-webui-remote-access",
			version: 1,
			team: "my-team",
			aud: AUD,
			emails: ["me@example.com", "you@example.com"],
		}),
	);
	const note = page.getByTestId("remote-transfer-note");
	await expect(note).toHaveText(en.transferImported);
	await expect(note).toHaveAttribute("data-error", "false");
	await expect(page.getByTestId("remote-team")).toHaveValue("my-team");
	await expect(page.getByTestId("remote-aud")).toHaveValue(AUD);
	await expect(page.getByTestId("remote-emails")).toHaveValue("me@example.com\nyou@example.com");
	await expect(page.getByTestId("remote-hostname")).toHaveValue("second.example.com");
	// The file only filled the form: the server has heard nothing until the person saves.
	expect(call(fake, "POST", "/config")).toHaveLength(0);
	await page.getByTestId("remote-save").click();
	await expect(page.getByTestId("toast").filter({ hasText: en.saveDone })).toBeVisible();
	expect(call(fake, "POST", "/config").at(-1)?.body).toEqual({
		hostname: "second.example.com",
		team: "my-team",
		aud: AUD,
		emails: ["me@example.com", "you@example.com"],
	});
});

test("a file that is not a settings file is refused with its reason, and the form is left as it was", async ({
	page,
}) => {
	const fake = await fakeRemote(page, snapshot({ installed: true, loggedIn: true }));
	await openSettings(page);
	await page.getByTestId("remote-team").fill("typed-team");
	const note = page.getByTestId("remote-transfer-note");
	const input = page.getByTestId("remote-import-file");
	const refused = async (content: unknown, words: string) => {
		await input.setInputFiles(settingsFile(content));
		await expect(note).toHaveText(words);
		await expect(note).toHaveAttribute("data-error", "true");
		await expect(page.getByTestId("remote-team")).toHaveValue("typed-team");
	};
	await refused("this is not json", en.transferNotJson);
	await refused({ kind: "something-else", version: 1, team: "x" }, en.transferNotOurs);
	await refused({ kind: "omp-webui-remote-access", version: 99, team: "x" }, en.transferVersion);
	await refused({ kind: "omp-webui-remote-access", version: 1, team: "", aud: "", emails: [] }, en.transferEmpty);
	await refused(
		{ kind: "omp-webui-remote-access", version: 1, emails: Array.from({ length: 201 }, (_, i) => `u${i}@example.com`) },
		en.transferTooMany,
	);
	// Another try with a good file takes it, and the same file may be chosen twice.
	await input.setInputFiles(settingsFile({ kind: "omp-webui-remote-access", version: 1, team: "good-team" }));
	await expect(page.getByTestId("remote-team")).toHaveValue("good-team");
	expect(call(fake, "POST", "/config")).toHaveLength(0);
});

test("Chinese: the export and import words are the Chinese pack's", async ({ page }) => {
	await fakeRemote(page, snapshot({ installed: true, loggedIn: true, config: CONFIGURED }));
	await openSettings(page, "zh-CN");
	await expect(page.getByTestId("remote-transfer")).toContainText(zh.transferTitle);
	await expect(page.getByTestId("remote-export")).toContainText(zh.transferExport);
	await expect(page.getByTestId("remote-import")).toContainText(zh.transferImport);
	await page.getByTestId("remote-import-file").setInputFiles(settingsFile("not json"));
	await expect(page.getByTestId("remote-transfer-note")).toHaveText(zh.transferNotJson);
});
