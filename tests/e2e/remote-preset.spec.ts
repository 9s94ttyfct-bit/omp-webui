import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUD, claims, EMAIL, makeKey, sign, startJwks, TEAM } from "../support/access-jwt.ts";
import { ACCESS_COOKIE, startAccessTunnel } from "../support/access-tunnel.ts";
import { FIXTURE } from "../support/fixtures.ts";
import { holdState } from "../support/hold-state.ts";
import { startTestServer } from "../support/server.ts";
import { expect, test } from "./fixtures.ts";

/**
 * The composer's preset menu on a page that came in through the tunnel: it names the preset that was chosen, as on a
 * local page, before the conversation starts and after a reload, also while the connection is slow to deliver omp's
 * state. A remote page changes nothing about a conversation's permission mode, so the preset reads exactly as on a
 * local page. The real server and the real omp; a stand-in for `cloudflared` carries the browser
 * (`tests/support/access-tunnel.ts`). No model call.
 */

const HOSTNAME = "omp.example.com";
const HAIKU = "anthropic/claude-haiku-5-5";
const SONNET = "anthropic/claude-sonnet-5-5";
const DEEP = { default: `${SONNET}:high`, smol: HAIKU, slow: HAIKU, tiny: `${HAIKU}:low`, commit: HAIKU };

test("on a remote page the preset menu names the chosen preset before the conversation starts, and after a reload", async ({
	browser,
}) => {
	test.setTimeout(240_000);
	const dir = mkdtempSync(join(tmpdir(), "ompw-remote-preset-"));
	const key = await makeKey("preset-key");
	const jwks = await startJwks([key]);
	const jwt = await sign(key, claims(Math.floor(Date.now() / 1000)));
	const settings = join(dir, "remote.json");
	writeFileSync(settings, JSON.stringify({ enabled: true, hostname: HOSTNAME, team: TEAM, aud: AUD, emails: [EMAIL] }));
	const server = await startTestServer(
		0,
		{ OMP_WEBUI_REMOTE_CONFIG: settings, OMP_WEBUI_ACCESS_CERTS_URL: jwks.url },
		{ login: false },
	);
	const tunnel = await startAccessTunnel(Number(new URL(server.url).port), { hostname: HOSTNAME });
	try {
		// Only `deep`: nothing else can stand in for it, so a label that does not name it reads Custom.
		await fetch(`${server.url}/api/model-config/preset/save`, {
			method: "POST",
			headers: { "x-omp-webui-token": server.accessToken, "x-omp-webui": "1", "content-type": "application/json" },
			body: JSON.stringify({ name: "deep", roles: DEEP, defaultThinkingLevel: "high" }),
		});
		mkdirSync(server.work, { recursive: true });

		const context = await browser.newContext();
		await context.addCookies([{ name: ACCESS_COOKIE, value: jwt, url: tunnel.url, httpOnly: true }]);
		await context.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), server.work);
		const page = await context.newPage();
		const state = await holdState(page);
		await page.goto(tunnel.url);
		expect(await page.evaluate(async () => (await (await fetch("/api/meta")).json()).remote)).toBe(true);

		// New chat, before anything is sent: the answer to `get_state` is late, as on a slow connection.
		await expect(page.getByTestId("model-picker")).toContainText("Haiku 5.5", { timeout: 60_000 });
		await expect(page.getByTestId("preset-picker")).toContainText("Custom");
		state.hold();
		await page.getByTestId("preset-picker").click();
		await page.getByTestId("preset-menu").locator('[data-preset="deep"]').click();
		await expect(page.getByTestId("preset-picker")).toContainText("deep");
		await expect(page.getByTestId("preset-picker")).not.toContainText("Custom");
		state.release();
		await expect(page.getByTestId("model-picker")).toContainText("Sonnet 5.5", { timeout: 30_000 });
		await expect(page.getByTestId("preset-picker")).toContainText("deep");
		await page.getByTestId("preset-picker").click();
		await expect(page.getByTestId("preset-menu").locator('[data-preset="deep"]')).toHaveAttribute(
			"aria-checked",
			"true",
		);
		await page.keyboard.press("Escape");

		// A conversation of this folder, switched: the label holds, and holds after a reload.
		await page.locator('[data-testid="session-item"]', { hasText: FIXTURE.alphaTitle }).click();
		await expect(page.getByTestId("composer")).toBeVisible();
		await page.getByTestId("preset-picker").click();
		await page.getByTestId("preset-menu").locator('[data-preset="deep"]').click();
		await expect(page.getByTestId("preset-picker")).toContainText("deep");
		await expect(page.getByTestId("preset-picker")).not.toContainText("Custom");
		await page.reload();
		await expect(page.getByTestId("preset-picker")).toContainText("deep", { timeout: 30_000 });
		await expect(page.getByTestId("preset-picker")).not.toContainText("Custom");
	} finally {
		await tunnel.stop();
		await server.stop();
		jwks.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});
