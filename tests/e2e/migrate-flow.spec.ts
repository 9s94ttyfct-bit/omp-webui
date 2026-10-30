import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { writeSimpleSession } from "../support/fixtures.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type Browser, expect, type Page, test } from "./fixtures.ts";

/**
 * Moving between two real servers through the real page, as a person does it: Export on one, the file saved, Import on the
 * other, the preview read, the summary read, the conversation found where it was left (#572). Real omp, no model calls.
 * Pictures of each step are written to `OMPW_SHOTS` when it is set (the way the screenshots of a feature are made).
 */

const shots = process.env.OMPW_SHOTS;

async function shoot(page: Page, name: string): Promise<void> {
	if (!shots) return;
	const path = join(shots, `${name}.png`);
	mkdirSync(dirname(path), { recursive: true });
	// The machine this runs on has a user and a computer name of its own: the pictures show made-up ones.
	await page.evaluate(
		([user, host]) => {
			const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				const text = node.nodeValue ?? "";
				const next = text.replaceAll(user, "jdoe").replaceAll(host, "old-mac");
				if (next !== text) node.nodeValue = next;
			}
		},
		[userInfo().username, hostname().replace(/\.local$/, "")],
	);
	const card = page.getByTestId("migrate-settings");
	await card.scrollIntoViewIfNeeded();
	await card.screenshot({ path, animations: "disabled" });
}

/** A page of `server`, signed in the way the test fixtures sign in the first one. */
async function pageOf(browser: Browser, server: TestServer, lang: string, theme: string, clipboard = false) {
	const context = await browser.newContext({
		baseURL: server.url,
		viewport: { width: 1400, height: 2400 },
		acceptDownloads: true,
		permissions: clipboard ? ["clipboard-read", "clipboard-write"] : [],
		storageState: {
			cookies: [
				{
					name: "ompw_token",
					value: server.accessToken,
					domain: "127.0.0.1",
					path: "/",
					expires: -1,
					httpOnly: true,
					secure: false,
					sameSite: "Strict",
				},
			],
			origins: [
				{
					origin: server.url,
					localStorage: [
						{ name: "ompw.lang", value: lang },
						{ name: "ompw.theme", value: theme },
					],
				},
			],
		},
	});
	return { context, page: await context.newPage() };
}

for (const [lang, theme] of [
	["en", "light"],
	["zh-CN", "dark"],
] as const) {
	test(`export on one Mac, import on another with another home folder (${lang}, ${theme}): the conversation is there, and the logins only with the password`, async ({
		browser,
	}, testInfo) => {
		test.setTimeout(240_000);
		// Two servers of its own: the worker's shared one holds what the specs before this one wrote, so its counts are
		// not this test's to know.
		const old = await startTestServer(0, {}, { login: false });
		const fresh = await startTestServer(0, {}, { login: false });
		const dir = testInfo.outputPath("moved");
		mkdirSync(dir, { recursive: true });
		const tag = `${lang}-${theme}`;
		const oldPage = await pageOf(browser, old, lang, theme);
		const newPage = await pageOf(browser, fresh, lang, theme);
		try {
			// The old Mac: a conversation of a project under its home folder, and a secret in its settings.
			const oldCwd = join(realpathSync(old.home), "proj");
			const made = writeSimpleSession(old.agentDir, 0x61, "Home project talk");
			mkdirSync(join(old.agentDir, "sessions", "-proj"), { recursive: true });
			writeFileSync(
				join(old.agentDir, "sessions", "-proj", basename(made)),
				readFileSync(made, "utf8").replace('"cwd":"/tmp/ompw-fixture-project"', `"cwd":${JSON.stringify(oldCwd)}`),
			);
			rmSync(made);
			writeFileSync(
				join(old.agentDir, "models.yml"),
				"providers:\n  local:\n    apiKey: sk-test-0123456789abcdefghijklmnop\n",
			);
			const logins = new DatabaseSync(join(old.agentDir, "agent.db"));
			// One login, whatever the fixtures put there.
			logins.exec("DELETE FROM auth_credentials");
			logins
				.prepare(
					"INSERT INTO auth_credentials (provider, credential_type, data, identity_key) VALUES (?, 'oauth', ?, 'acct-1')",
				)
				.run("anthropic", JSON.stringify({ refresh: "oauth-refresh-token-0123456789abcdef" }));
			logins.close();

			// Export, with the logins and a password.
			const o = oldPage.page;
			await o.goto("/#/settings/app");
			await expect(o.getByTestId("migrate-plan")).toBeVisible();
			await expect(o.getByTestId("migrate-cat-conversations")).toBeVisible();
			await expect(o.getByTestId("migrate-creds")).not.toBeChecked();
			await shoot(o, `${tag}/1-export-plan`);
			await o.getByTestId("migrate-creds").click();
			// The logins turn the whole file's encryption on with them; this test is the logins-only archive of before, so it is
			// switched off (the whole file has its own test below).
			await expect(o.getByTestId("migrate-whole")).toHaveAttribute("aria-checked", "true");
			await o.getByTestId("migrate-whole").click();
			await o.getByTestId("migrate-password").fill("correct horse battery");
			await o.getByTestId("migrate-password-confirm").fill("correct horse battery");
			await expect(o.getByTestId("migrate-export")).toBeEnabled();
			await o.getByTestId("migrate-export").click();
			await expect(o.getByTestId("migrate-export-done")).toBeVisible();
			await shoot(o, `${tag}/2-export-done`);
			const download = o.waitForEvent("download");
			await o.getByTestId("migrate-download").click();
			const file = join(dir, "moved.ompw");
			await (await download).saveAs(file);
			expect(readFileSync(file).toString("latin1")).not.toContain("sk-test-0123456789abcdefghijklmnop");
			await o.getByTestId("migrate-export-finish").click();
			expect(existsSync(join(old.root, "data", "migrate", basename(file)))).toBe(false);

			// The new Mac: pick the file, read what it holds before anything is written.
			const n = newPage.page;
			await n.goto("/#/settings/app");
			await n.getByTestId("migrate-file").setInputFiles(file);
			const preview = n.getByTestId("migrate-preview");
			await expect(preview).toBeVisible({ timeout: 60_000 });
			await expect(n.getByTestId("migrate-source")).toContainText(old.home);
			await expect(n.getByTestId("migrate-warnings")).toContainText(fresh.home);
			await expect(n.getByTestId("migrate-conversations-line")).toContainText("6");
			await shoot(n, `${tag}/3-import-preview`);

			// A wrong password is refused, with the preview still there; then the right one.
			await n.getByTestId("migrate-import-password").fill("not the password");
			await n.getByTestId("migrate-import").click();
			await expect(n.getByTestId("migrate-import-error")).toBeVisible();
			await expect(preview).toBeVisible();
			expect(existsSync(join(fresh.root, "data", "migration-backups"))).toBe(false);
			await shoot(n, `${tag}/4-wrong-password`);
			await n.getByTestId("migrate-import-password").fill("correct horse battery");
			await n.getByTestId("migrate-import").click();
			const summary = n.getByTestId("migrate-summary");
			await expect(summary).toBeVisible({ timeout: 60_000 });
			await expect(n.getByTestId("migrate-missing-folders")).toContainText(join(realpathSync(fresh.home), "proj"));
			await expect(n.getByTestId("migrate-summary-credentials")).toContainText("1");
			await expect(n.getByTestId("migrate-summary-credentials")).not.toContainText("0");
			await shoot(n, `${tag}/5-import-summary`);
			expect(readFileSync(join(fresh.agentDir, "models.yml"), "utf8")).toContain("sk-test-0123456789abcdefghijklmnop");
			const restored = new DatabaseSync(join(fresh.agentDir, "agent.db"));
			expect(restored.prepare("SELECT provider FROM auth_credentials").all()).toEqual([{ provider: "anthropic" }]);
			restored.close();
			await n.getByTestId("migrate-close").click();

			// And there it is, in the sidebar of the new Mac, with its messages.
			await n.goto("/");
			await n.getByText("Home project talk").first().click();
			await expect(n.getByText("Home project talk.").first()).toBeVisible();
			if (shots) await n.screenshot({ path: join(shots, tag, "6-conversation.png") });
		} finally {
			await oldPage.context.close();
			await newPage.context.close();
			await fresh.stop();
			await old.stop();
		}
	});
}

/**
 * "Encrypt the whole file" (#607), end to end with the page as a person uses it: the logins switch turns it on, a password
 * is made by the page, copied, and exported with; the file holds nothing readable; on the other Mac it is locked until the
 * password is typed, a wrong one is refused, the right one shows the preview, and the import brings the logins with no
 * second password. The pictures go to `OMPW_SHOTS` when it is set.
 */
for (const [lang, theme] of [
	["en", "light"],
	["en", "dark"],
	["zh-CN", "light"],
	["zh-CN", "dark"],
] as const) {
	test(`encrypt the whole file with a made password, export, then open it on another Mac (${lang}, ${theme})`, async ({
		browser,
	}, testInfo) => {
		test.setTimeout(300_000);
		const old = await startTestServer(0, {}, { login: false });
		const fresh = await startTestServer(0, {}, { login: false });
		const dir = testInfo.outputPath("moved-whole");
		mkdirSync(dir, { recursive: true });
		const tag = `whole-${lang}-${theme}`;
		const oldPage = await pageOf(browser, old, lang, theme, true);
		const newPage = await pageOf(browser, fresh, lang, theme, true);
		try {
			const oldCwd = join(realpathSync(old.home), "proj");
			const made = writeSimpleSession(old.agentDir, 0x62, "Whole file talk");
			mkdirSync(join(old.agentDir, "sessions", "-proj"), { recursive: true });
			writeFileSync(
				join(old.agentDir, "sessions", "-proj", basename(made)),
				readFileSync(made, "utf8").replace('"cwd":"/tmp/ompw-fixture-project"', `"cwd":${JSON.stringify(oldCwd)}`),
			);
			rmSync(made);
			writeFileSync(
				join(old.agentDir, "models.yml"),
				"providers:\n  local:\n    apiKey: sk-test-0123456789abcdefghijklmnop\n",
			);
			const logins = new DatabaseSync(join(old.agentDir, "agent.db"));
			logins.exec("DELETE FROM auth_credentials");
			logins
				.prepare(
					"INSERT INTO auth_credentials (provider, credential_type, data, identity_key) VALUES (?, 'oauth', ?, 'acct-1')",
				)
				.run("anthropic", JSON.stringify({ refresh: "oauth-refresh-token-0123456789abcdef" }));
			logins.close();

			// The old Mac: the logins switch turns the whole file on with it, and a weak password is told so.
			const o = oldPage.page;
			await o.goto("/#/settings/app");
			await expect(o.getByTestId("migrate-plan")).toBeVisible();
			await expect(o.getByTestId("migrate-whole")).toHaveAttribute("aria-checked", "false");
			await o.getByTestId("migrate-creds").click();
			await expect(o.getByTestId("migrate-whole")).toHaveAttribute("aria-checked", "true");
			await o.getByTestId("migrate-password").fill("password1");
			await expect(o.getByTestId("migrate-strength")).toHaveAttribute("data-score", "0");
			await expect(o.getByTestId("migrate-export")).toBeDisabled();
			await shoot(o, `${tag}/1-weak-hint`);

			// A password is made by the page: in clear, with the warning, the same in both fields; copied for safe keeping.
			await o.getByTestId("migrate-generate").click();
			const password = await o.getByTestId("migrate-password").inputValue();
			expect(password).toHaveLength(24);
			await expect(o.getByTestId("migrate-password-confirm")).toHaveValue(password);
			await expect(o.getByTestId("migrate-password-made")).toBeVisible();
			await expect(o.getByTestId("migrate-strength")).toHaveAttribute("data-score", "4");
			await o.getByTestId("migrate-password-copy").click();
			await expect(o.getByTestId("migrate-password-copy")).toBeEnabled();
			expect(await o.evaluate(() => navigator.clipboard.readText())).toBe(password);
			await shoot(o, `${tag}/2-made-password`);
			await expect(o.getByTestId("migrate-export")).toBeEnabled();
			await o.getByTestId("migrate-export").click();
			await expect(o.getByTestId("migrate-export-done")).toBeVisible();
			await expect(o.getByTestId("migrate-export-encrypted")).toBeVisible();
			await shoot(o, `${tag}/3-export-done`);
			const download = o.waitForEvent("download");
			await o.getByTestId("migrate-download").click();
			const file = join(dir, "moved.ompw");
			await (await download).saveAs(file);
			// Nothing is readable in it: not a name, not a conversation, not a secret, not the password.
			const bytes = readFileSync(file);
			expect(bytes.subarray(0, 8).toString()).toBe("OMPWENC2");
			const text = bytes.toString("latin1");
			for (const readable of [
				"sk-test-0123456789abcdefghijklmnop",
				"oauth-refresh-token",
				"manifest.json",
				"models.yml",
				"Whole file talk",
				password,
			]) {
				expect(text.includes(readable), readable).toBe(false);
			}
			await o.getByTestId("migrate-export-finish").click();

			// The new Mac: the file is locked, and nothing of it is shown until the password is right.
			const n = newPage.page;
			await n.goto("/#/settings/app");
			await n.getByTestId("migrate-file").setInputFiles(file);
			const locked = n.getByTestId("migrate-locked");
			await expect(locked).toBeVisible({ timeout: 60_000 });
			await expect(n.getByTestId("migrate-preview")).toHaveCount(0);
			await expect(n.getByTestId("migrate-source")).toHaveCount(0);
			await shoot(n, `${tag}/4-locked`);
			await n.getByTestId("migrate-unlock-password").fill("not the password");
			await n.getByTestId("migrate-unlock").click();
			await expect(n.getByTestId("migrate-import-error")).toBeVisible();
			await expect(locked).toBeVisible();
			await expect(n.getByTestId("migrate-preview")).toHaveCount(0);
			await shoot(n, `${tag}/5-wrong-password`);
			await n.getByTestId("migrate-unlock-password").fill(password);
			await n.getByTestId("migrate-unlock").click();
			await expect(n.getByTestId("migrate-preview")).toBeVisible({ timeout: 60_000 });
			await expect(n.getByTestId("migrate-source")).toContainText(old.home);
			await expect(n.getByTestId("migrate-conversations-line")).toContainText("6");
			// The logins come with no second password.
			await expect(n.getByTestId("migrate-import-password")).toHaveCount(0);
			await expect(n.getByTestId("migrate-whole-note")).toBeVisible();
			await shoot(n, `${tag}/6-preview`);
			await n.getByTestId("migrate-import").click();
			await expect(n.getByTestId("migrate-summary")).toBeVisible({ timeout: 60_000 });
			await expect(n.getByTestId("migrate-summary-credentials")).toContainText("1");
			await shoot(n, `${tag}/7-summary`);
			expect(readFileSync(join(fresh.agentDir, "models.yml"), "utf8")).toContain("sk-test-0123456789abcdefghijklmnop");
			const restored = new DatabaseSync(join(fresh.agentDir, "agent.db"));
			expect(restored.prepare("SELECT provider FROM auth_credentials").all()).toEqual([{ provider: "anthropic" }]);
			restored.close();
			await n.getByTestId("migrate-close").click();
			await n.goto("/");
			await n.getByText("Whole file talk").first().click();
			await expect(n.getByText("Whole file talk.").first()).toBeVisible();
		} finally {
			await oldPage.context.close();
			await newPage.context.close();
			await fresh.stop();
			await old.stop();
		}
	});
}
