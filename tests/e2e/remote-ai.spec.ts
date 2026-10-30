import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { RemoteSnapshot } from "../../shared/remote.ts";
import { REMOTE_AI_TOOL, REMOTE_AI_TOOL_NAMES } from "../../shared/remote-ai.ts";
import { zh } from "../../web/src/i18n/zh-CN/remote.ts";
import { makeFakeCloudflared } from "../support/fake-cloudflared.ts";
import { writeFakeHostOmp } from "../support/fake-host-omp.ts";
import { remoteEn as en } from "../support/i18n-en.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { connect, request } from "../support/ws.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * "Set up with AI" end to end, with nothing faked in the page or in the server: the real server, its real `/api/remote*`
 * routes, the real Settings card and a scripted omp (`fake-host-omp.ts`) that logs everything it is sent and calls the
 * tools it is told to (`tool <name> <json>`). The `cloudflared` and `brew` are scripts too (`fake-cloudflared.ts`): no
 * Cloudflare is reached and nothing is installed.
 *
 * What a model does with the tools is checked in `tests/contract/remote-ai-live.test.ts`; this is the page's half: the
 * switch, the button, the conversation it opens with its starting prompt, and the card following what the agent does.
 */

const HOSTNAME = "omp.example.com";
const LOGIN_URL =
	"https://dash.cloudflare.com/argotunnel?aud=&callback=https%3A%2F%2Flogin.example.com%2Fone-time-secret";
const AUD = "c".repeat(64);

interface Run {
	server: TestServer;
	dir: string;
	/** Everything the scripted omp was sent, one frame per line. */
	sent(): { in?: Record<string, unknown> }[];
	stop(): Promise<void>;
}

async function serve(): Promise<Run> {
	const dir = mkdtempSync(join(tmpdir(), "ompw-remote-ai-e2e-"));
	const log = join(dir, "omp.log");
	writeFileSync(log, "");
	const program = makeFakeCloudflared(join(dir, "cf"), { installed: false });
	program.setLoginUrl(LOGIN_URL);
	const server = await startTestServer(
		0,
		{
			OMP_BIN: writeFakeHostOmp(dir, log, { configured: "write" }),
			OMP_WEBUI_CLOUDFLARED: program.bin,
			OMP_WEBUI_BREW: program.brew,
		},
		{ login: false },
	);
	return {
		server,
		dir,
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

const api = (run: Run, path: string, body?: unknown) =>
	fetch(`${run.server.url}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: { "x-omp-webui-token": run.server.accessToken, "x-omp-webui": "1", "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
const snapshot = async (run: Run): Promise<RemoteSnapshot> => (await api(run, "/api/remote")).json();

async function openCard(page: Page, run: Run, lang = "en", theme = "light"): Promise<void> {
	await page.addInitScript(
		([l, m]) => {
			localStorage.setItem("ompw.lang", l);
			localStorage.setItem("ompw.theme", m);
		},
		[lang, theme],
	);
	await page.goto(`${run.server.url}/?token=${run.server.accessToken}#/settings/app`);
	await expect(page.getByTestId("remote-settings")).toBeVisible();
}

/** The prompts the scripted omp was sent. */
const prompts = (run: Run): string[] =>
	run.sent().flatMap((l) => (l.in?.type === "prompt" && typeof l.in.message === "string" ? [l.in.message] : []));

const answers = (run: Run) => run.sent().filter((l) => l.in?.type === "host_tool_result").length;

/**
 * The agent of the conversation `liveId` calls `name` (the scripted omp does): sent the way the composer sends a message.
 * Resolves once omp has the server's answer, as the agent's next call comes after it.
 */
async function agentCalls(run: Run, liveId: string, name: string, args: unknown = {}): Promise<void> {
	const before = answers(run);
	const ws = await connect(run.server);
	await request(ws, { t: "attach", liveId });
	await request(ws, {
		t: "rpc",
		liveId,
		command: { type: "prompt", message: `tool ${name} ${JSON.stringify(args)}` },
	});
	ws.close();
	await expect.poll(() => answers(run), { timeout: 60_000 }).toBeGreaterThan(before);
}

const switchOf = (page: Page) => page.getByTestId("remote-ai-switch");

for (const [lang, words] of [
	["en", en],
	["zh-CN", zh],
] as const) {
	test(`Set up with AI turns the switch on, opens a conversation and sends it the starting prompt (${lang})`, async ({
		page,
	}) => {
		const run = await serve();
		try {
			await openCard(page, run, lang);
			// Off until the person turns it on.
			await expect(switchOf(page)).not.toBeChecked();
			await expect(page.getByTestId("remote-ai")).toContainText(words.aiSwitch);
			await expect(page.getByTestId("remote-ai-active")).toHaveCount(0);
			expect(run.sent().filter((l) => l.in?.type === "set_host_tools")).toEqual([]);

			await page.getByTestId("remote-ai-start").click();

			// The conversation is open: its composer is here, and its address names the process.
			await expect(page.getByTestId("composer")).toBeVisible();
			await expect(page).toHaveURL(/#\/live\/L/);
			const liveId = (await snapshot(run)).ai.conversations[0] as string;
			expect(liveId).toBeDefined();
			expect(page.url()).toContain(liveId);

			// omp was given the nine tools, and the starting prompt in the language of the page, with where things stand.
			const sets = run.sent().filter((l) => l.in?.type === "set_host_tools");
			expect(sets).toHaveLength(1);
			expect(((sets[0]?.in?.tools ?? []) as { name: string }[]).map((t) => t.name)).toEqual([...REMOTE_AI_TOOL_NAMES]);
			await expect.poll(() => prompts(run)).toHaveLength(1);
			const [prompt] = prompts(run);
			expect(prompt).toContain(words.aiPrompt.split("{state}")[0]?.slice(0, 40));
			expect(prompt).toContain(words.aiStateTools.replace("{installed}", words.aiNo).replace("{login}", words.aiNo));
			expect(prompt).toContain(
				words.aiStateSettings
					.replace("{hostname}", words.aiUnset)
					.replace("{team}", words.aiUnset)
					.replace("{aud}", words.aiUnset)
					.replace("{emails}", words.aiUnset),
			);
			expect(prompt).toContain(words.aiStateTunnel.replace("{state}", words.stateOff));
			// Nothing a person would not want sent: no token, and none of the settings' values (there are none yet).
			expect(prompt).not.toContain(run.server.accessToken);

			// Back in Settings the switch is on, and the card says where the tools are.
			await page.goto(`${run.server.url}/#/settings/app`);
			await expect(switchOf(page)).toBeChecked();
			await expect(page.getByTestId("remote-ai-active")).toHaveText(words.aiActiveOne);
		} finally {
			await run.stop();
		}
	});
}

test("what the agent does, the card shows as it happens: settings, steps and the sign-in link, with no reload", async ({
	page,
}) => {
	const run = await serve();
	try {
		await openCard(page, run);
		await page.getByTestId("remote-ai-start").click();
		await expect(page.getByTestId("composer")).toBeVisible();
		const liveId = (await snapshot(run)).ai.conversations[0] as string;
		// The card is on the page again, the same page: from here nothing is reloaded.
		await page.evaluate(() => {
			location.hash = "#/settings/app";
		});
		await expect(page.getByTestId("remote-settings")).toBeVisible();
		await expect(page.getByTestId("remote-step-install")).toHaveAttribute("data-done", "false");

		await agentCalls(run, liveId, REMOTE_AI_TOOL.save, { hostname: HOSTNAME, team: "my-team" });
		await expect(page.getByTestId("remote-hostname")).toHaveValue(HOSTNAME);
		await expect(page.getByTestId("remote-team")).toHaveValue("my-team");
		await expect(page.getByTestId("remote-url")).toHaveText(`https://${HOSTNAME}`);

		await agentCalls(run, liveId, REMOTE_AI_TOOL.install);
		await expect(page.getByTestId("remote-step-install")).toHaveAttribute("data-done", "true");

		// The login the agent started waits for the person: the card has the link, and a notice offers it.
		await agentCalls(run, liveId, REMOTE_AI_TOOL.login);
		await expect(page.getByTestId("remote-login-waiting")).toBeVisible();
		await expect(page.getByTestId("remote-login-link")).toHaveAttribute("href", LOGIN_URL);
		const notice = page.getByTestId("toast").filter({ hasText: en.loginReady });
		await expect(notice).toBeVisible();
		const popup = page.waitForEvent("popup");
		await notice.getByTestId("toast-action").click();
		expect((await popup).url()).toBe(LOGIN_URL);

		// The agent never saw the link: it is nowhere in what omp was sent.
		expect(JSON.stringify(run.sent())).not.toContain("one-time-secret");

		writeFileSync(join(run.dir, "cf", "state", "login-approve"), "");
		await expect(page.getByTestId("remote-step-login")).toHaveAttribute("data-done", "true", { timeout: 30_000 });

		await agentCalls(run, liveId, REMOTE_AI_TOOL.save, { aud: AUD, emails: ["me@example.com"] });
		await expect(page.getByTestId("remote-aud")).toHaveValue(AUD);
		await expect(page.getByTestId("remote-emails")).toHaveValue("me@example.com");

		await agentCalls(run, liveId, REMOTE_AI_TOOL.setup);
		await agentCalls(run, liveId, REMOTE_AI_TOOL.start);
		await expect(page.getByTestId("remote-status")).toHaveAttribute("data-state", "connected", { timeout: 30_000 });
		await expect(page.getByTestId("remote-stop")).toBeVisible();
	} finally {
		await run.stop();
	}
});

test("turning the switch off from the card takes the tools away, and the agent's next call is refused", async ({
	page,
}) => {
	const run = await serve();
	try {
		await openCard(page, run);
		await page.getByTestId("remote-ai-start").click();
		await expect(page.getByTestId("composer")).toBeVisible();
		const liveId = (await snapshot(run)).ai.conversations[0] as string;
		await page.evaluate(() => {
			location.hash = "#/settings/app";
		});
		await expect(page.getByTestId("remote-ai-active")).toBeVisible();

		// Keyboard: the switch is reached and flipped without the mouse.
		await switchOf(page).focus();
		await page.keyboard.press("Space");
		await expect(switchOf(page)).not.toBeChecked();
		await expect(page.getByTestId("remote-ai-active")).toHaveCount(0);
		expect((await snapshot(run)).ai).toEqual({ enabled: false, conversations: [] });
		// omp was told it has no tools any more.
		const sets = run.sent().filter((l) => l.in?.type === "set_host_tools");
		expect(sets.at(-1)?.in?.tools).toEqual([]);

		await agentCalls(run, liveId, REMOTE_AI_TOOL.save, { hostname: "other.example.com" });
		await expect.poll(() => run.sent().filter((l) => l.in?.type === "host_tool_result").length).toBeGreaterThan(0);
		const answered = run.sent().findLast((l) => l.in?.type === "host_tool_result")?.in;
		expect(answered?.isError).toBe(true);
		expect((await snapshot(run)).config.hostname).toBe("");
	} finally {
		await run.stop();
	}
});

test("the check of the address is a button of the card", async ({ page }) => {
	const run = await serve();
	try {
		await openCard(page, run);
		// It needs a hostname first.
		await expect(page.getByTestId("remote-check")).toBeDisabled();
		await page.getByTestId("remote-hostname").fill(HOSTNAME);
		await page.getByTestId("remote-save").click();
		await expect(page.getByTestId("remote-check")).toBeEnabled();
	} finally {
		await run.stop();
	}
});

for (const lang of ["en", "zh-CN"]) {
	for (const theme of ["light", "dark"]) {
		test(`the AI block of the card is readable and reachable from the keyboard in ${lang} ${theme}`, async ({
			page,
		}, testInfo) => {
			const run = await serve();
			try {
				await openCard(page, run, lang, theme);
				const block = page.getByTestId("remote-ai");
				await expect(block).toBeVisible();
				const axe = await new AxeBuilder({ page }).include('[data-testid="remote-ai"]').analyze();
				expect(axe.violations).toEqual([]);
				await switchOf(page).focus();
				await page.keyboard.press("Tab");
				await expect(page.getByTestId("remote-ai-start")).toBeFocused();
				const png = await block.screenshot();
				if (process.env.OMPW_REMOTE_AI_SHOTS)
					writeFileSync(`${process.env.OMPW_REMOTE_AI_SHOTS}/remote-ai-card-${lang}-${theme}.png`, png);
				await testInfo.attach(`remote-ai-${lang}-${theme}`, { body: png, contentType: "image/png" });
			} finally {
				await run.stop();
			}
		});
	}
}

const VIEWPORTS = {
	desktop: { width: 1400, height: 900 },
	phone: { width: 390, height: 844 },
} as const;

for (const lang of ["en", "zh-CN"] as const) {
	test(`the switch, the button and the sign-in notice are laid out and readable, light and dark, on a desktop and a phone (${lang})`, async ({
		browser,
	}, testInfo) => {
		test.setTimeout(180_000);
		const words = lang === "en" ? en : zh;
		const run = await serve();
		try {
			// The agent starts the Cloudflare login and it waits for the browser: every page that opens now is offered the link.
			const starter = await browser.newPage();
			await openCard(starter, run, lang);
			await starter.getByTestId("remote-ai-start").click();
			await expect(starter.getByTestId("composer")).toBeVisible();
			const liveId = (await snapshot(run)).ai.conversations[0] as string;
			await agentCalls(run, liveId, REMOTE_AI_TOOL.install);
			await agentCalls(run, liveId, REMOTE_AI_TOOL.login);
			await starter.close();
			// Not switched off by this: the card's switch is on, and the conversation holds the tools.
			expect((await snapshot(run)).ai).toEqual({ enabled: true, conversations: [liveId] });

			for (const theme of ["light", "dark"] as const) {
				for (const [name, viewport] of Object.entries(VIEWPORTS)) {
					const context = await browser.newContext({ viewport });
					const page = await context.newPage();
					await openCard(page, run, lang, theme);
					const block = page.getByTestId("remote-ai");
					const notice = page.getByTestId("toast").filter({ hasText: words.loginReady });
					await expect(notice).toBeVisible();
					await expect(switchOf(page)).toBeChecked();
					await expect(page.getByTestId("remote-ai-active")).toHaveText(words.aiActiveOne);
					await block.scrollIntoViewIfNeeded();

					// Nothing runs off the page: the block and the notice are inside it, and the page does not scroll sideways.
					const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
					expect(fits, `${name} ${theme}: the page scrolls sideways`).toBe(true);
					for (const box of [await block.boundingBox(), await notice.boundingBox()]) {
						expect(box).not.toBeNull();
						expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= viewport.width + 1).toBe(true);
					}
					// The two buttons that matter are at least as big as a thumb on the phone.
					const start = await page.getByTestId("remote-ai-start").boundingBox();
					expect(start?.height ?? 0).toBeGreaterThanOrEqual(name === "phone" ? 28 : 24);

					const png = await page.screenshot();
					if (process.env.OMPW_REMOTE_AI_SHOTS)
						writeFileSync(`${process.env.OMPW_REMOTE_AI_SHOTS}/remote-ai-${lang}-${theme}-${name}.png`, png);
					await testInfo.attach(`remote-ai-${lang}-${theme}-${name}`, { body: png, contentType: "image/png" });
					await context.close();
				}
			}
		} finally {
			await run.stop();
		}
	});
}
