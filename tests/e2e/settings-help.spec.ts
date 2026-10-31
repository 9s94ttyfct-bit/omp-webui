import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SETTINGS_TOOL, type SettingsHelpState } from "../../shared/settings-help.ts";
import { writeFakeHostOmp } from "../support/fake-host-omp.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { connect, request } from "../support/ws.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * Ask agent for help end to end: the real server and Settings, and a scripted omp (`fake-host-omp.ts`) that calls the
 * tool it is told to (`tool <name> <json>`). The button opens the dedicated conversation with its badge, countdown and
 * Revoke now; a security change shows its card there and waits for Allow; Settings lists the change with Undo; and the
 * strip and the card fit a phone. `OMPW_ASK_HELP_SHOTS` names a folder for the screenshots.
 */

interface Run {
	server: TestServer;
	sent(): { in?: Record<string, unknown> }[];
	stop(): Promise<void>;
}

async function serve(): Promise<Run> {
	const dir = mkdtempSync(join(tmpdir(), "ompw-settings-help-e2e-"));
	const log = join(dir, "omp.log");
	writeFileSync(log, "");
	const server = await startTestServer(
		0,
		{ OMP_BIN: writeFakeHostOmp(dir, log, { configured: "write" }) },
		{ login: false },
	);
	return {
		server,
		sent: () =>
			readFileSync(log, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l)),
		async stop() {
			await server.stop();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

const api = async (run: Run, path: string) =>
	(await fetch(`${run.server.url}${path}`, { headers: { "x-omp-webui-token": run.server.accessToken } })).json();

/** The agent of `liveId` calls `webui_settings` (the scripted omp does). */
async function agentCalls(run: Run, liveId: string, args: unknown): Promise<void> {
	const ws = await connect(run.server);
	await request(ws, { t: "attach", liveId });
	await request(ws, {
		t: "rpc",
		liveId,
		command: { type: "prompt", message: `tool ${SETTINGS_TOOL} ${JSON.stringify(args)}` },
	});
	ws.close();
}

async function openSettings(page: Page, run: Run, lang = "en"): Promise<void> {
	await page.addInitScript((l) => localStorage.setItem("ompw.lang", l), lang);
	await page.goto(`${run.server.url}/?token=${run.server.accessToken}#/settings/look`);
	await expect(page.getByTestId("settings-help")).toBeVisible();
}

async function shot(page: Page, name: string): Promise<void> {
	const dir = process.env.OMPW_ASK_HELP_SHOTS;
	if (dir) writeFileSync(join(dir, `${name}.png`), await page.screenshot());
}

test("the button opens the dedicated conversation with its badge, countdown and Revoke now", async ({ page }) => {
	const run = await serve();
	try {
		await openSettings(page, run);
		// Keyboard: the button is reached and pressed without the mouse.
		await page.getByTestId("settings-help-start").focus();
		await page.keyboard.press("Enter");
		await expect(page.getByTestId("composer")).toBeVisible();
		const bar = page.getByTestId("settings-help-bar");
		await expect(bar.getByTestId("settings-help-badge")).toHaveText("Settings help");
		await expect(bar.getByTestId("settings-help-countdown")).toContainText(
			/Can change settings · (30:00|29:\d\d) left/,
		);
		// Named, and told where it was opened from.
		const sent = run.sent().map((l) => l.in);
		expect(sent.some((f) => f?.type === "set_session_name" && f.name === "Settings help")).toBe(true);
		expect(sent.some((f) => f?.type === "prompt" && String(f.message).includes("Settings › Look & layout"))).toBe(true);
		await shot(page, "conversation-countdown-desktop");

		await bar.getByTestId("settings-help-revoke").click();
		await expect(bar.getByTestId("settings-help-ended")).toHaveText("Settings access ended: you revoked it.");
		expect(((await api(run, "/api/settings-help")) as SettingsHelpState).grants).toEqual([]);
	} finally {
		await run.stop();
	}
});

test("a security change shows its card and waits for Allow; Settings lists it with Undo", async ({ page }) => {
	const run = await serve();
	try {
		await openSettings(page, run);
		await page.getByTestId("settings-help-start").click();
		await expect(page.getByTestId("settings-help-bar")).toBeVisible();
		const { grants } = (await api(run, "/api/settings-help")) as SettingsHelpState;
		const liveId = grants[0]?.liveId as string;

		await agentCalls(run, liveId, { action: "set", changes: [{ key: "ompw.unattended", value: "on" }] });
		const card = page.getByTestId("settings-help-bar").getByTestId("settings-request");
		await expect(card).toBeVisible();
		await expect(card.getByTestId("settings-request-key")).toHaveText("ompw.unattended");
		await expect(card.getByTestId("settings-request-old")).toHaveText("not set");
		await expect(card.getByTestId("settings-request-new")).toHaveText("on");
		await shot(page, "confirmation-card-desktop");
		await card.getByTestId("settings-request-allow").click();
		await expect(card).toHaveCount(0);
		await expect
			.poll(
				async () =>
					((await api(run, "/api/prefs")) as { values: Record<string, string | null> }).values["ompw.unattended"],
			)
			.toBe("on");

		await page.evaluate(() => {
			location.hash = "#/settings/look";
		});
		const change = page.getByTestId("settings-help-change").filter({ hasText: "ompw.unattended" });
		await expect(change).toContainText("allowed by you");
		await shot(page, "change-log-desktop");
		await change.getByTestId("settings-help-undo").click();
		await expect(change).toContainText("Undone");
		await expect
			.poll(
				async () =>
					((await api(run, "/api/prefs")) as { values: Record<string, string | null> }).values["ompw.unattended"],
			)
			.toBeNull();
	} finally {
		await run.stop();
	}
});

for (const lang of ["en", "zh-CN"] as const) {
	test(`the strip, the card and the change log fit a phone (${lang})`, async ({ browser }) => {
		const run = await serve();
		const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
		const page = await context.newPage();
		try {
			await openSettings(page, run, lang);
			await page.getByTestId("settings-help-start").click();
			const bar = page.getByTestId("settings-help-bar");
			await expect(bar).toBeVisible();
			const { grants } = (await api(run, "/api/settings-help")) as SettingsHelpState;
			await agentCalls(run, grants[0]?.liveId as string, {
				action: "set",
				changes: [{ key: "remote.json:remoteShell", value: false }],
			});
			await expect(bar.getByTestId("settings-request")).toBeVisible();
			const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
			expect(fits).toBe(true);
			for (const id of ["settings-request-allow", "settings-request-deny", "settings-help-revoke"]) {
				const box = await bar.getByTestId(id).boundingBox();
				expect(box, id).not.toBeNull();
				expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= 391, id).toBe(true);
			}
			await shot(page, `phone-conversation-${lang}`);
			await bar.getByTestId("settings-request-deny").click();
			await expect(bar.getByTestId("settings-request")).toHaveCount(0);
			await page.evaluate(() => {
				location.hash = "#/settings/look";
			});
			await expect(page.getByTestId("settings-help")).toBeVisible();
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
			await page.getByTestId("settings-help").scrollIntoViewIfNeeded();
			await shot(page, `phone-settings-${lang}`);
		} finally {
			await context.close();
			await run.stop();
		}
	});
}
