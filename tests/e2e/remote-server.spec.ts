import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "@playwright/test";
import { startTestServer, type TestServer } from "../support/server.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The card against the server's own routes (the tunnel slice): what the page asks for, what it reads of the answer,
 * what it shows of an error, and what the server keeps. The tunnel program itself is that slice's business (its own
 * specs drive `cloudflared`); what this pins is the page's half of the contract, against the real server and not a
 * stand-in for it.
 *
 * `OMP_WEBUI_CLOUDFLARED` and `OMP_WEBUI_BREW` are the server's own switches for it, and both are exclusive: the first
 * points at a program that is not there until this spec's own `brew` puts it there (so the machine's own `cloudflared`
 * is never found, and none is ever installed), the second at a script of this spec's (so Homebrew is never run).
 */

const LOGIN_URL = "https://dash.cloudflare.com/argotunnel?callback=ompw-test";

/**
 * The program of this spec's own: it answers `--version`, and for `tunnel login` it prints the URL a person has to
 * open and waits until this spec approves it, then leaves the certificate Cloudflare would leave.
 */
function fakeProgram(dir: string): string {
	const state = join(dir, "state");
	const program = join(dir, "template", "cloudflared");
	mkdirSync(state, { recursive: true });
	mkdirSync(join(dir, "template"), { recursive: true });
	mkdirSync(join(dir, "bin"), { recursive: true });
	writeFileSync(
		program,
		`#!/bin/sh
case "$1" in
  --version) echo "cloudflared version 2026.10.0 (built 2026-10-01-0000 UTC)"; exit 0 ;;
esac
if [ "$1" = tunnel ] && [ "$2" = login ]; then
  echo "Please open the following URL and log in with your Cloudflare account:"
  echo "${LOGIN_URL}"
  while [ ! -e "${state}/login-approve" ]; do sleep 0.05; done
  mkdir -p "$HOME/.cloudflared"; echo cert > "$HOME/.cloudflared/cert.pem"
  echo "You have successfully logged in."
  exit 0
fi
exit 1
`,
	);
	chmodSync(program, 0o755);
	return program;
}

/** The `brew` of this spec's own: it puts the program where `OMP_WEBUI_CLOUDFLARED` points, and says what it did. */
function fakeBrew(dir: string, program: string, target: string): string {
	const brew = join(dir, "brew");
	writeFileSync(
		brew,
		`#!/bin/sh
echo "==> Pouring cloudflared--2026.10.0.arm64_sequoia.bottle.tar.gz"
sleep 2
cp "${program}" "${target}"
chmod 755 "${target}"
echo "🍺  /opt/homebrew/Cellar/cloudflared/2026.10.0: 12 files"
`,
	);
	chmodSync(brew, 0o755);
	return brew;
}

interface Run {
	server: TestServer;
	dir: string;
	stop(): Promise<void>;
}

/** A server with the remote-access routes, a `brew` of this spec's own and a program that is not there yet. */
async function serve(): Promise<Run> {
	const dir = mkdtempSync(join(tmpdir(), "ompw-remote-"));
	const program = fakeProgram(dir);
	const target = join(dir, "bin", "cloudflared");
	const server = await startTestServer(0, {
		OMP_WEBUI_CLOUDFLARED: target,
		OMP_WEBUI_BREW: fakeBrew(dir, program, target),
	});
	return {
		server,
		dir,
		async stop() {
			await server.stop();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

/** What the server says about remote access, asked of it directly. */
async function snapshot(run: Run): Promise<{ status: number; body: Record<string, unknown> }> {
	const res = await fetch(`${run.server.url}/api/remote`, {
		headers: { "x-omp-webui-token": run.server.accessToken },
	});
	return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** The card, on a page of a server of this spec's own (its own context: the token is that server's). */
async function openCard(browser: Browser, run: Run): Promise<Page> {
	const context = await browser.newContext();
	const page = await context.newPage();
	await page.goto(`${run.server.url}/?token=${run.server.accessToken}#/settings/app`);
	await expect(page.getByTestId("settings-page")).toBeVisible();
	return page;
}

test("the card talks to the server's own routes: it keeps what the server keeps, and says what the server refuses", async ({
	browser,
}) => {
	const run = await serve();
	try {
		const answer = await snapshot(run);
		// Without the tunnel slice's routes there is nothing to talk to: the spec says so and stops.
		test.skip(answer.status === 404, "the server has no /api/remote routes (the tunnel slice is not merged)");

		const page = await openCard(browser, run);
		const card = page.getByTestId("remote-settings");
		await expect(card).toBeVisible();
		await expect(page.getByTestId("remote-status")).toHaveAttribute("data-state", "off");
		await expect(page.getByTestId("remote-step-install")).toHaveAttribute("data-done", "false");
		await expect(page.getByTestId("remote-step-login")).toHaveAttribute("data-done", "false");

		// The settings the page sends are the settings the server keeps.
		await page.getByTestId("remote-hostname").fill("omp.example.com");
		await page.getByTestId("remote-team").fill("my-team");
		await page.getByTestId("remote-aud").fill("0123456789abcdef".repeat(4));
		await page.getByTestId("remote-emails").fill("me@example.com\nyou@example.com");
		await page.getByTestId("remote-save").click();
		await expect(page.getByTestId("toast").filter({ hasText: "Settings saved" })).toBeVisible();
		const kept = await snapshot(run);
		expect(kept.body.config).toMatchObject({
			hostname: "omp.example.com",
			team: "my-team",
			emails: ["me@example.com", "you@example.com"],
		});
		await expect(page.getByTestId("remote-url")).toHaveText("https://omp.example.com");

		// A switch is kept too, and the box follows the click at once.
		await page.getByTestId("remote-autostart").click();
		await expect(page.getByTestId("remote-autostart")).toBeChecked();
		await expect.poll(async () => (await snapshot(run)).body.config).toMatchObject({ autostart: true });

		// What the server refuses is said as the server said it.
		await page.getByTestId("remote-start").click();
		await expect(page.getByTestId("remote-error")).toContainText("cloudflared is not installed");

		// The install runs the `brew` of this spec, and the program it puts there is the one the server finds.
		await page.getByTestId("remote-install").click();
		// While it runs, the line says what brew is doing (the server pushes it).
		await expect(page.getByTestId("remote-message")).toContainText("Installing cloudflared");
		await expect(page.getByTestId("remote-step-install")).toHaveAttribute("data-done", "true");
		expect((await snapshot(run)).body.installed).toBe(true);

		// The sign-in opens the page the server named, and the card waits until the server sees the certificate.
		const popup = page.waitForEvent("popup");
		await page.getByTestId("remote-login").click();
		expect((await popup).url()).toBe(LOGIN_URL);
		await expect(page.getByTestId("remote-login-waiting")).toBeVisible();
		await expect(page.getByTestId("remote-login-link")).toHaveAttribute("href", LOGIN_URL);
		writeFileSync(join(run.dir, "state", "login-approve"), "");
		await expect(page.getByTestId("remote-step-login")).toHaveAttribute("data-done", "true", { timeout: 30_000 });
		await expect(page.getByTestId("remote-login-waiting")).toHaveCount(0);

		// The certificate is where the server looks for it: in its own home.
		expect(readFileSync(join(run.server.home, ".cloudflared", "cert.pem"), "utf8")).toContain("cert");

		// The routes are for this computer only: a request that carries what Cloudflare adds is refused.
		const remote = await fetch(`${run.server.url}/api/remote`, {
			headers: { "x-omp-webui-token": run.server.accessToken, "cf-ray": "abc" },
		});
		expect(remote.status).toBe(403);
	} finally {
		await run.stop();
	}
});
