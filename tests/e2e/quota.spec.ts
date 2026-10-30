import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_BUCKET, FIXTURE_CWD } from "../support/fixtures.ts";
import { boxOf } from "../support/geometry.ts";
import { openSidebar, ownSession, sessionRow, startLive } from "../support/live.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { patchReplies } from "../support/state-patch.ts";
import { type StubOmlx, startStubOmlx } from "../support/stub-omlx.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The header shows the provider's remaining quota (the account with the most left; a popover lists every
 * account's windows) on New chat and on saved conversations too, not only while omp runs. No model call; usage
 * data is stubbed.
 */

const windowsOf = (email: string | undefined, fiveHour: number, sevenDay: number) => ({
	provider: "anthropic",
	limits: [
		{
			id: "anthropic:5h",
			label: "Claude 5 Hour",
			window: { resetsAt: Date.now() + 2 * 3_600_000 + 5 * 60_000 },
			amount: { remainingFraction: fiveHour, unit: "percent" },
			status: "ok",
		},
		{
			id: "anthropic:7d",
			label: "Claude 7 Day",
			window: { resetsAt: Date.now() + 3 * 86_400_000 },
			amount: { remainingFraction: sevenDay, unit: "percent" },
			status: "ok",
		},
	],
	...(email ? { metadata: { email } } : {}),
});

const reports = (fraction: number) => [windowsOf(undefined, 0.8, fraction)];

/** omp only reports its provider after a model call: say it, so the pill has one before any. */
const sayProvider = (page: Page) =>
	patchReplies(page, {
		get_state: (data) => {
			const state = typeof data === "object" && data !== null ? data : {};
			const model = "model" in state && typeof state.model === "object" ? state.model : {};
			return { ...state, model: { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", ...model, provider: "anthropic" } };
		},
	});

/** A saved conversation of the spec's own (no omp process runs for it), opened from the sidebar. */
async function openSaved(page: Page, n: number, title: string) {
	ownSession(n, title);
	await page.goto("/");
	await openSidebar(page);
	await expect(sessionRow(page, title)).toHaveCount(1, { timeout: 15_000 });
	await sessionRow(page, title).click();
	await expect(page.getByTestId("chat-title")).toHaveText(title);
}

test("the provider's remaining quota is shown in the chat header", async ({ page }) => {
	let fraction = 0.22;
	await page.route("**/api/usage**", (route) => route.fulfill({ json: reports(fraction) }));
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
	await page.getByTestId("composer").fill("!echo quota");
	await page.getByTestId("composer").press("Enter");

	const pill = page.getByTestId("quota");
	await expect(pill.getByTestId("quota-figure")).toHaveText("22% left");
	await expect(pill).toHaveAttribute("data-level", "low");
	// The pill is named by what it shows (the window's reset is inside it), and described with the provider and window.
	await expect(pill).toHaveAccessibleName(/^22% left resets in 3d \d+h$/);
	await expect(pill).toHaveAccessibleDescription(/^anthropic quota: 22% left in Claude 7 Day · resets in 3d \d+h$/);
	await pill.click();
	const popover = page.getByTestId("quota-popover");
	await expect(popover).toContainText("anthropic usage limits");
	await expect(popover.getByTestId("quota-window").nth(0)).toHaveText(/Claude 5 Hour: 80% left · resets in 2h [45]m/);
	await expect(popover.getByTestId("quota-window").nth(1)).toContainText("Claude 7 Day: 22% left · resets in");
	// One unnamed account needs no heading.
	await expect(popover).not.toContainText("Account 1");
	await page.keyboard.press("Escape");
	await expect(popover).toHaveCount(0);

	// A finished turn refreshes it.
	fraction = 0.04;
	await page.getByTestId("composer").fill("!echo again");
	await page.getByTestId("composer").press("Enter");
	await expect(pill.getByTestId("quota-figure")).toHaveText("4% left");
	await expect(pill).toHaveAttribute("data-level", "critical");
});

test("New chat shows the quota once the warm omp reports its provider", async ({ page }) => {
	await page.route("**/api/usage**", (route) => route.fulfill({ json: reports(0.5) }));
	await sayProvider(page);
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
	await expect(page.getByTestId("quota").getByTestId("quota-figure")).toHaveText("50% left", { timeout: 30_000 });
});

test("a saved conversation shows the quota of its last assistant message's provider, with no omp running", async ({
	page,
}) => {
	await page.route("**/api/usage**", (route) => route.fulfill({ json: reports(0.3) }));
	await openSaved(page, 0xf0, "Quota probe: saved chat");
	await expect(page.getByTestId("quota").getByTestId("quota-figure")).toHaveText("30% left", { timeout: 15_000 });
});

test("with several accounts the pill shows the best one and the popover lists every account, best first", async ({
	page,
}) => {
	const accounts = [windowsOf("a@x.org", 0.03, 0.4), windowsOf("b@x.org", 0.92, 0.6)];
	await page.route("**/api/usage**", (route) => route.fulfill({ json: accounts }));
	await openSaved(page, 0xf1, "Quota probe: two accounts");

	const pill = page.getByTestId("quota");
	await expect(pill.getByTestId("quota-figure")).toHaveText("60% left", { timeout: 15_000 });
	await expect(pill).toHaveAttribute("data-level", "ok");
	await expect(pill).toHaveAccessibleDescription("anthropic quota: 60% left in Claude 7 Day (b@x.org)");

	await pill.click();
	const sections = page.getByTestId("quota-popover").getByTestId("quota-account");
	await expect(sections).toHaveCount(2);
	await expect(sections.nth(0)).toContainText("b@x.org");
	await expect(sections.nth(0)).toContainText("Best");
	await expect(sections.nth(0).getByTestId("quota-window").nth(0)).toContainText("Claude 5 Hour: 92% left");
	await expect(sections.nth(0).getByTestId("quota-window").nth(1)).toContainText("Claude 7 Day: 60% left");
	await expect(sections.nth(1)).toContainText("a@x.org");
	await expect(sections.nth(1)).not.toContainText("Best");
	await expect(sections.nth(1).getByTestId("quota-window").nth(0)).toContainText("Claude 5 Hour: 3% left");
	await expect(sections.nth(1).getByTestId("quota-window").nth(1)).toContainText("Claude 7 Day: 40% left");
});

test("the pill is a button that the keyboard opens and Escape closes, returning focus to it", async ({ page }) => {
	await page.route("**/api/usage**", (route) => route.fulfill({ json: reports(0.5) }));
	await openSaved(page, 0xf2, "Quota probe: keyboard");

	const pill = page.getByTestId("quota");
	await expect(pill.getByTestId("quota-figure")).toHaveText("50% left", { timeout: 15_000 });
	await expect(pill).toHaveRole("button");
	await pill.focus();
	await expect(pill).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("quota-popover")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("quota-popover")).toHaveCount(0);
	await expect(pill).toBeFocused();
});

test("a provider without usage data shows no pill", async ({ page }) => {
	await page.route("**/api/usage**", (route) => route.fulfill({ json: [] }));
	const asked = page.waitForResponse("**/api/usage**");
	await openSaved(page, 0xf3, "Quota probe: no data");
	await asked;
	await expect(page.getByTestId("quota")).toHaveCount(0);
});

// ------------------------------------------------------------------ every provider a conversation used

const NOW = Date.parse("2026-10-18T12:00:00Z");

/** One account's 5-hour window: `fraction` left, resetting at `resetsAt` (past used up, `status` says so too). */
const fiveHour = (provider: string, fraction: number, resetsAt: number) => [
	{
		provider,
		limits: [
			{
				id: `${provider}:5h`,
				label: "5 Hour",
				window: { resetsAt },
				amount: { remainingFraction: fraction, unit: "percent" },
				status: fraction === 0 ? "exhausted" : "ok",
			},
		],
	},
];

/** Answer `/api/usage` per provider, with what `byProvider` holds when it is asked (read each time: a spec can change it). */
const stubUsage = (page: Page, byProvider: Record<string, unknown>, asked: string[] = []) =>
	page.route("**/api/usage**", (route) => {
		const url = route.request().url();
		asked.push(url);
		return route.fulfill({ json: byProvider[new URL(url).searchParams.get("provider") ?? ""] ?? [] });
	});

/** A saved conversation that spoke with anthropic, then switched to openai-codex and spoke with that. */
function writeMixedSession(id: string, prompt: string): void {
	const dir = join(process.env.OMPW_E2E_AGENT_DIR as string, "sessions", FIXTURE_BUCKET);
	mkdirSync(dir, { recursive: true });
	const stamp = (minute: number) => new Date(Date.UTC(2026, 0, 9, 10, minute)).toISOString();
	const tail = id.slice(-4);
	const user = (n: number, parent: string | null, minute: number, text: string) => ({
		type: "message",
		id: `q${tail}0${n}`,
		parentId: parent,
		timestamp: stamp(minute),
		message: {
			role: "user",
			content: [{ type: "text", text }],
			attribution: "user",
			timestamp: Date.parse(stamp(minute)),
		},
	});
	const reply = (n: number, parent: string, minute: number, provider: string, model: string) => ({
		type: "message",
		id: `q${tail}0${n}`,
		parentId: parent,
		timestamp: stamp(minute),
		message: {
			role: "assistant",
			content: [{ type: "text", text: `${provider} says hi` }],
			provider,
			model,
			stopReason: "stop",
			timestamp: Date.parse(stamp(minute)),
		},
	});
	const entries = [
		{ type: "session", version: 3, id, timestamp: stamp(0), cwd: FIXTURE_CWD },
		user(1, null, 1, prompt),
		reply(2, `q${tail}01`, 2, "anthropic", "claude-haiku-5-5"),
		{
			type: "model_change",
			id: `q${tail}03`,
			parentId: `q${tail}02`,
			timestamp: stamp(3),
			model: "openai-codex/gpt-5.2:high",
		},
		user(4, `q${tail}03`, 4, "And now with the other one"),
		reply(5, `q${tail}04`, 5, "openai-codex", "gpt-5.2"),
	];
	writeFileSync(
		join(dir, `2026-01-09T10-00-00-000Z_${id}.jsonl`),
		`${entries.map((e) => JSON.stringify(e)).join("\n")}\n`,
	);
}

async function openByPrompt(page: Page, prompt: string) {
	await page.goto("/");
	await openSidebar(page);
	await expect(sessionRow(page, prompt)).toHaveCount(1, { timeout: 15_000 });
	await sessionRow(page, prompt).click();
}

test("a conversation that mixed providers shows every one's quota, the most recent first; one that is used up says when it resets", async ({
	page,
}) => {
	const prompt = "Quota probe: two providers";
	writeMixedSession("01a00000-0000-7000-8000-00000000e9e1", prompt);
	await page.clock.install({ time: NOW });
	await stubUsage(page, {
		anthropic: fiveHour("anthropic", 0.4, NOW + 2 * 3_600_000),
		"openai-codex": fiveHour("openai-codex", 0, NOW + 3 * 3_600_000 + 5 * 60_000),
	});
	await openByPrompt(page, prompt);

	const pills = page.getByTestId("quota");
	await expect(pills).toHaveCount(2, { timeout: 15_000 });
	// Named, because there is more than one; the provider of the latest reply first.
	await expect(pills.nth(0)).toHaveText("openai-codex · resets in 3h 5m");
	await expect(pills.nth(0)).toHaveAttribute("data-exhausted", "true");
	await expect(pills.nth(0)).toHaveAttribute("data-level", "critical");
	await expect(pills.nth(0)).toHaveAccessibleDescription("openai-codex quota used up, resets in 3h 5m");
	await expect(pills.nth(1)).toHaveText("anthropic · 40% left");
	await expect(pills.nth(1)).not.toHaveAttribute("data-exhausted", "true");
	await expect(pills.nth(1)).toHaveAccessibleDescription("anthropic quota: 40% left in 5 Hour");
	// One look for every pill: each has its ring, whichever provider is the conversation's own.
	await expect(pills.nth(0).getByTestId("quota-meter")).toHaveCount(1);
	await expect(pills.nth(1).getByTestId("quota-meter")).toHaveCount(1);

	// Each pill opens its own provider's windows.
	await pills.nth(1).click();
	await expect(page.getByTestId("quota-popover")).toContainText("anthropic usage limits");
	await page.keyboard.press("Escape");
	await pills.nth(0).click();
	await expect(page.getByTestId("quota-popover")).toContainText("openai-codex usage limits");
	await expect(page.getByTestId("quota-popover").getByTestId("quota-window")).toContainText(
		"5 Hour: 0% left · resets in 3h",
	);
});

/** omp's OpenAI usage report: the 5-hour window comes first here, but the pill must not depend on that (`omp usage --json`). */
const chatgpt = (fiveHourLeft: number, weeklyLeft: number) => [
	{
		provider: "openai-codex",
		limits: [
			{
				id: "openai-codex:primary",
				label: "5 hours",
				scope: { provider: "openai-codex", windowId: "5h", shared: true },
				window: { id: "5h", label: "5 hours", durationMs: 5 * 3_600_000, resetsAt: NOW + 2 * 3_600_000 + 5 * 60_000 },
				amount: { used: 100 - fiveHourLeft * 100, limit: 100, remainingFraction: fiveHourLeft, unit: "percent" },
				status: fiveHourLeft === 0 ? "exhausted" : "ok",
			},
			{
				id: "openai-codex:secondary",
				label: "7 days",
				scope: { provider: "openai-codex", windowId: "7d", shared: true },
				window: {
					id: "7d",
					label: "7 days",
					durationMs: 7 * 86_400_000,
					resetsAt: NOW + 3 * 86_400_000 + 4 * 3_600_000,
				},
				amount: { used: 100 - weeklyLeft * 100, limit: 100, remainingFraction: weeklyLeft, unit: "percent" },
				status: weeklyLeft === 0 ? "exhausted" : "ok",
			},
		],
		metadata: { email: "o@x.org" },
	},
];

test("OpenAI: the pill shows the 5-hour window while the weekly one is lower; the popover lists both", async ({
	page,
}) => {
	const prompt = "Quota probe: openai 5h";
	writeMixedSession("01a00000-0000-7000-8000-00000000e9e2", prompt);
	await page.clock.install({ time: NOW });
	await stubUsage(page, { "openai-codex": chatgpt(0.8, 0.04) });
	await openByPrompt(page, prompt);

	const pill = page.getByTestId("quota");
	await expect(pill.getByTestId("quota-figure")).toHaveText("openai-codex · 80% left", { timeout: 15_000 });
	await expect(pill).toHaveAttribute("data-level", "ok");
	await expect(pill).not.toHaveAttribute("data-exhausted", "true");
	await expect(pill).toHaveAccessibleDescription("openai-codex quota: 80% left in 5 hours (o@x.org)");
	await pill.click();
	const windows = page.getByTestId("quota-popover").getByTestId("quota-window");
	await expect(windows).toHaveCount(2);
	await expect(windows.nth(0)).toHaveText("5 hours: 80% left · resets in 2h 5m");
	await expect(windows.nth(1)).toContainText("7 days: 4% left · resets in 3d");
});

test("OpenAI: once the weekly window is used up the pill shows it with its reset countdown", async ({ page }) => {
	const prompt = "Quota probe: openai 7d";
	writeMixedSession("01a00000-0000-7000-8000-00000000e9e3", prompt);
	await page.clock.install({ time: NOW });
	await stubUsage(page, { "openai-codex": chatgpt(0.8, 0) });
	await openByPrompt(page, prompt);

	const pill = page.getByTestId("quota");
	await expect(pill.getByTestId("quota-figure")).toHaveText("openai-codex · resets in 3d 4h", { timeout: 15_000 });
	await expect(pill).toHaveAttribute("data-exhausted", "true");
	await expect(pill).toHaveAttribute("data-level", "critical");
	await pill.click();
	const windows = page.getByTestId("quota-popover").getByTestId("quota-window");
	await expect(windows).toHaveCount(2);
	await expect(windows.nth(0)).toHaveText("5 hours: 80% left · resets in 2h 5m");
	await expect(windows.nth(1)).toHaveText("7 days: 0% left · resets in 3d 4h");
});

/**
 * Moves the page's clock on, a look's wait (15 s, and a second) at a time, until `holds`. A fake clock that jumps makes
 * every timer that is due fire at once, in the order they were set, and an answer the page reads while that goes on sets
 * the wait for its next look afresh from the end of the jump: so how many jumps a look takes is up to when the answers
 * come in, which is not the test's to say. Time is driven until the look has been made, and not guessed at.
 */
async function untilClockHas(page: Page, holds: () => boolean | Promise<boolean>) {
	await expect
		.poll(async () => {
			if (!(await holds())) await page.clock.fastForward(16_000);
			return holds();
		})
		.toBe(true);
}

test("a provider that is used up counts down to its reset, and is looked at again once the time has come", async ({
	page,
}) => {
	await page.clock.install({ time: NOW });
	const byProvider: Record<string, unknown> = { anthropic: fiveHour("anthropic", 0, NOW + 72 * 60_000) };
	const asked: string[] = [];
	await stubUsage(page, byProvider, asked);
	await openSaved(page, 0xf4, "Quota probe: used up");

	// One provider: no name in front, and the countdown rounds up so that it never reads zero early.
	const pill = page.getByTestId("quota");
	await expect(pill.getByTestId("quota-figure")).toHaveText("resets in 1h 12m", { timeout: 15_000 });
	await expect(pill).toHaveAttribute("data-level", "critical");
	await page.clock.fastForward(5 * 60_000);
	await expect(pill.getByTestId("quota-figure")).toHaveText("resets in 1h 7m");
	await page.clock.fastForward(66 * 60_000);
	// Under an hour the seconds show.
	await expect(pill.getByTestId("quota-figure")).toHaveText(/^resets in (\d+m \d{2}s|\d+s)$/);

	// The reset time passes and the provider still says no: the pill says it is resetting, and asks again.
	const beforeReset = asked.length;
	await page.clock.fastForward(5 * 60_000);
	await expect(pill.getByTestId("quota-figure")).toHaveText("resetting…");
	await expect(pill).toHaveAttribute("data-exhausted", "true");
	// Asking again bypasses the server's cache, as a look after finished work does. (Not "the last look is that one": the
	// periodic look is due in the same jump, and which of the two comes last is the order their timers were set in.)
	await untilClockHas(page, () => asked.slice(beforeReset).some((url) => url.includes("force=1")));

	// Now the provider has lifted it: the next look is told so, and the pill shows it.
	byProvider.anthropic = fiveHour("anthropic", 0.6, NOW + 5 * 3_600_000);
	await untilClockHas(page, async () => (await pill.getByTestId("quota-figure").textContent()) === "60% left");
	await expect(pill.getByTestId("quota-figure")).toHaveText("60% left");
	await expect(pill).not.toHaveAttribute("data-exhausted", "true");
});

test.describe("phone", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("with several providers the pills show only their figures, and the title and the menu stay on screen", async ({
		page,
	}) => {
		const prompt = "Quota probe: phone";
		writeMixedSession("01a00000-0000-7000-8000-00000000e9e2", prompt);
		await page.clock.install({ time: NOW });
		await stubUsage(page, {
			anthropic: fiveHour("anthropic", 0.4, NOW + 2 * 3_600_000),
			"openai-codex": fiveHour("openai-codex", 0, NOW + 3 * 3_600_000 + 5 * 60_000),
		});
		await openByPrompt(page, prompt);

		const pills = page.getByTestId("quota");
		await expect(pills).toHaveCount(2, { timeout: 15_000 });
		await expect(pills.nth(0)).toHaveText("3h 5m");
		await expect(pills.nth(1)).toHaveText("40%");
		// The provider is still named: by the description, which is also the tooltip.
		await expect(pills.nth(0)).toHaveAccessibleDescription("openai-codex quota used up, resets in 3h 5m");
		await expect(pills.nth(1)).toHaveAttribute("title", "anthropic quota: 40% left in 5 Hour");
		// Two pills cost the title some room (one pill leaves it 120 px, see chat-header.spec), but not all of it.
		expect((await boxOf(page.getByTestId("chat-title"))).width).toBeGreaterThanOrEqual(90);
		const toggle = await boxOf(page.getByTestId("toggle-panel"));
		expect(toggle.x + toggle.width).toBeLessThanOrEqual(390);
	});
});

// ------------------------------------------------------------------ a failed look keeps the last known figures

test("a failed look keeps the pill and marks it out of date; the next successful look clears the mark", async ({
	page,
}) => {
	await page.clock.install({ time: NOW });
	let failing = false;
	await page.route("**/api/usage**", (route) =>
		failing
			? route.fulfill({ status: 500, json: { error: "omp usage exited 1" } })
			: route.fulfill({ json: fiveHour("anthropic", 0.4, NOW + 5 * 3_600_000) }),
	);
	await openSaved(page, 0xf5, "Quota probe: failed look");

	const pill = page.getByTestId("quota");
	await expect(pill.getByTestId("quota-figure")).toHaveText("40% left", { timeout: 15_000 });
	await expect(pill).not.toHaveAttribute("data-stale", "true");
	await expect(pill).toHaveAccessibleDescription("anthropic quota: 40% left in 5 Hour");

	// The periodic look fails: the figure stays, and says that it may be out of date.
	failing = true;
	await page.clock.fastForward(121_000);
	await expect(pill).toHaveAttribute("data-stale", "true");
	await expect(pill.getByTestId("quota-figure")).toHaveText("40% left");
	await expect(pill).toHaveAttribute("title", "Couldn't refresh · showing the last known value");
	await expect(pill).toHaveAccessibleDescription(
		"anthropic quota: 40% left in 5 Hour (couldn't refresh, showing the last known value)",
	);
	// Its popover still lists the windows of the last look.
	await pill.click();
	await expect(page.getByTestId("quota-popover").getByTestId("quota-window")).toContainText("5 Hour: 40% left");
	await page.keyboard.press("Escape");

	// The provider answers again.
	failing = false;
	await page.clock.fastForward(121_000);
	await expect(pill).not.toHaveAttribute("data-stale", "true");
	await expect(pill.getByTestId("quota-figure")).toHaveText("40% left");
	await expect(pill).not.toHaveAttribute("title", /refresh/);
	await expect(pill).toHaveAccessibleDescription("anthropic quota: 40% left in 5 Hour");
});

// ------------------------------------------------------------------ Light conversations on a local server

test.describe("Light conversation on a local server", () => {
	test.describe.configure({ mode: "serial" });
	let modelsPath: string;
	let base: string;
	let omlx: StubOmlx;

	/** The server's mode API, as the test server's own token allows. */
	const setMode = (body: unknown) =>
		fetch(`${base}/api/mode`, {
			method: "POST",
			headers: {
				"x-omp-webui-token": String(process.env.OMPW_E2E_ACCESS_TOKEN),
				"x-omp-webui": "1",
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		});

	test.beforeAll(async () => {
		modelsPath = join(process.env.OMPW_E2E_AGENT_DIR as string, "models.yml");
		base = process.env.OMPW_E2E_URL as string;
		omlx = await startStubOmlx({ models: ["stub-model"] });
		writeFileSync(
			modelsPath,
			`providers:\n  omlx:\n    baseUrl: ${omlx.url}\n    api: openai-completions\n    apiKey: ${omlx.apiKey}\n    discovery:\n      type: openai-models-list\n`,
		);
		expect((await setMode({ mode: "light", lightModels: "local", offline: { backend: "omlx" } })).ok).toBe(true);
	});

	test.afterAll(async () => {
		// What the next spec starts: Full on the person's own models, with the user's files as they were.
		await setMode({ mode: "full", lightModels: "yours" });
		rmSync(modelsPath, { force: true });
		await omlx.stop();
	});

	test("shows its local backend's pill only, and asks for no cloud provider's usage that its history names", async ({
		page,
	}) => {
		const prompt = "Quota probe: Light on a local server, history";
		writeMixedSession("01a00000-0000-7000-8000-00000000e9e3", prompt);
		await page.clock.install({ time: NOW });
		const asked: string[] = [];
		await stubUsage(
			page,
			{
				omlx: fiveHour("omlx", 0.7, NOW + 5 * 3_600_000),
				anthropic: fiveHour("anthropic", 0.4, NOW + 2 * 3_600_000),
				"openai-codex": fiveHour("openai-codex", 0.2, NOW + 3 * 3_600_000),
			},
			asked,
		);
		// omp names its provider only after a model call: say it, so the process has one at once.
		await patchReplies(page, {
			get_state: (data) => {
				const state = typeof data === "object" && data !== null ? data : {};
				return { ...state, model: { id: "stub-model", name: "stub-model", provider: "omlx" } };
			},
		});
		await openByPrompt(page, prompt);
		// Not running yet: the history's providers are what the conversation would spend.
		await expect(page.getByTestId("quota")).toHaveCount(2, { timeout: 15_000 });

		// Start its process (a `!command` needs no model call): it is Light on the local server, and spends that backend only.
		const composer = page.getByTestId("composer");
		await composer.fill("!echo light-quota-probe");
		await composer.press("Enter");
		await expect(page.getByText("light-quota-probe", { exact: true })).toBeVisible({ timeout: 30_000 });
		await expect(page.getByTestId("mode-badge")).toBeVisible();
		const pill = page.getByTestId("quota");
		await expect(pill).toHaveCount(1);
		await expect(pill).toHaveAttribute("data-provider", "omlx");
		await expect(pill.getByTestId("quota-figure")).toHaveText("70% left");

		// From here on the usage of the cloud providers is not asked for either, however often it is looked at.
		asked.length = 0;
		await page.clock.fastForward(121_000);
		await expect.poll(() => asked.length).toBeGreaterThan(0);
		for (const url of asked) expect(new URL(url).searchParams.get("provider")).toBe("omlx");
	});
});

test("the quota popover is a dialog named by its title", async ({ page }) => {
	await page.route("**/api/usage**", (route) => route.fulfill({ json: reports(0.3) }));
	await openSaved(page, 0xf6, "Quota probe: dialog name");
	await page.getByTestId("quota").click();
	await expect(page.getByTestId("quota-popover")).toBeVisible();
	await expect(page.getByRole("dialog", { name: "anthropic usage limits" })).toBeVisible();
});

// ------------------------------------------------------------------ far-off resets, and a page nobody looks at

test("a provider used up until a reset more than 24.8 days away is not asked about again and again", async ({
	page,
}) => {
	await page.clock.install({ time: NOW });
	const asked: string[] = [];
	// A monthly window (Copilot premium requests, GLM, Kimi): too far for a browser timer, which then fires at once.
	await stubUsage(page, { anthropic: fiveHour("anthropic", 0, NOW + 30 * 86_400_000) }, asked);
	await openSaved(page, 0xf7, "Quota probe: monthly reset");

	const pill = page.getByTestId("quota");
	await expect(pill).toHaveAttribute("data-exhausted", "true", { timeout: 15_000 });
	// Two minutes pass (the clock runs on, in steps); only the periodic look may ask, never a forced one.
	for (let i = 0; i < 4; i++) await page.clock.fastForward(30_000);
	// A forced look would have come back at once and again, a round trip each: give those time to show.
	await page.waitForTimeout(1000);
	expect(asked.filter((url) => url.includes("force=1"))).toEqual([]);
	await expect(pill).toHaveAttribute("data-exhausted", "true");
});

/** Make the page hidden or visible, as a window behind others or a background tab is. */
const setHidden = (page: Page, hidden: boolean) =>
	page.evaluate((h) => {
		Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
		Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
		document.dispatchEvent(new Event("visibilitychange"));
	}, hidden);

test("a hidden page stops asking for the quota, and looks once when it is shown again", async ({ page }) => {
	await page.clock.install({ time: NOW });
	const asked: string[] = [];
	await stubUsage(page, { anthropic: fiveHour("anthropic", 0.4, NOW + 5 * 3_600_000) }, asked);
	await openSaved(page, 0xf8, "Quota probe: hidden page");
	const pill = page.getByTestId("quota");
	await expect(pill.getByTestId("quota-figure")).toHaveText("40% left", { timeout: 15_000 });

	await setHidden(page, true);
	const before = asked.length;
	// Ten minutes behind other windows: five periodic looks, none of which anybody would see.
	for (let i = 0; i < 20; i++) await page.clock.fastForward(30_000);
	await page.waitForTimeout(500);
	expect(asked.length).toBe(before);

	// Shown again: the figure is ten minutes old, so it is looked at once, and the periodic look goes on from there.
	await setHidden(page, false);
	await expect.poll(() => asked.length).toBe(before + 1);
	await page.waitForTimeout(500);
	expect(asked.length).toBe(before + 1);
	await page.clock.fastForward(121_000);
	await expect.poll(() => asked.length).toBe(before + 2);
});

test("a page that is shown again soon after a look does not ask for another", async ({ page }) => {
	await page.clock.install({ time: NOW });
	const asked: string[] = [];
	await stubUsage(page, { anthropic: fiveHour("anthropic", 0.4, NOW + 5 * 3_600_000) }, asked);
	await openSaved(page, 0xf9, "Quota probe: brief hide");
	await expect(page.getByTestId("quota").getByTestId("quota-figure")).toHaveText("40% left", { timeout: 15_000 });

	await setHidden(page, true);
	await page.clock.fastForward(30_000);
	const before = asked.length;
	await setHidden(page, false);
	await page.waitForTimeout(500);
	expect(asked.length).toBe(before);
});

// ------------------------------------------------------------------ the header's quota bar (#454)

/**
 * The header of a running conversation shows the provider's remaining quota behind a meter, with the window's reset
 * beside it; the context share stays under the composer, where the status line has always shown it.
 */
test("the header shows the provider's remaining quota with a meter and the window's reset, and the context only under the composer", async ({
	page,
}) => {
	const title = "Quota bar probe";
	ownSession(0xfa, title);
	await page.clock.install({ time: NOW });
	await stubUsage(page, { anthropic: fiveHour("anthropic", 0.4, NOW + 2 * 3_600_000) });
	// omp reports the provider and the context only after a model call.
	await patchReplies(page, {
		get_state: (data) => {
			const state = typeof data === "object" && data !== null ? data : {};
			const model = "model" in state && typeof state.model === "object" ? state.model : {};
			return {
				...state,
				model: { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", ...model, provider: "anthropic" },
				contextUsage: { tokens: 4200, contextWindow: 200_000, percent: 2.1 },
			};
		},
	});
	await page.goto("/");
	await openSidebar(page);
	await expect(sessionRow(page, title)).toHaveCount(1, { timeout: 15_000 });
	await sessionRow(page, title).click();
	await page.getByTestId("composer").fill("!echo quota-bar-probe");
	await page.getByTestId("composer").press("Enter");
	await expect(page.getByTestId("msg-exec").filter({ hasText: "quota-bar-probe" })).toBeVisible({ timeout: 60_000 });

	// The header's figure: the quota, with its meter.
	const bar = page.getByTestId("quota-bar");
	await expect(bar).toBeVisible({ timeout: 15_000 });
	await expect(bar.getByTestId("quota-figure")).toHaveText("40% left");
	await expect(bar.getByTestId("quota-meter")).toHaveAttribute("data-left", "40");
	// The window's reset, inside the same pill: with a second provider's pill beside it, it cannot read as that one's.
	await expect(bar.getByTestId("quota").getByTestId("quota-reset")).toHaveText("resets in 2h 0m");

	// The context share is not in the header any more: the status line under the composer shows it, once.
	await expect(page.getByTestId("context-meter")).toHaveCount(0);
	const context = page.getByTestId("status-context");
	await expect(context).toHaveCount(1);
	await expect(context).toHaveAttribute("data-percent", "2");
});

/** The ring in the header: the arc is the share left, in the pill's tone for its level (#575). */
test("the header's quota ring draws the share left as its arc, in the tone of its level", async ({ page }) => {
	const title = "Quota ring probe";
	ownSession(0xfe, title);
	await page.clock.install({ time: NOW });
	const byProvider: Record<string, unknown> = { anthropic: fiveHour("anthropic", 0.53, NOW + 2 * 3_600_000) };
	await stubUsage(page, byProvider);
	await sayProvider(page);
	await page.goto("/");
	await openSidebar(page);
	await expect(sessionRow(page, title)).toHaveCount(1, { timeout: 15_000 });
	await sessionRow(page, title).click();
	await page.getByTestId("composer").fill("!echo ring-0");
	await page.getByTestId("composer").press("Enter");
	await expect(page.getByTestId("msg-exec").filter({ hasText: "ring-0" })).toBeVisible({ timeout: 60_000 });

	const pill = page.getByTestId("quota-bar").getByTestId("quota");
	const meter = pill.getByTestId("quota-meter");
	const arc = meter.getByTestId("quota-ring-arc");
	// The ring is a circle in an SVG, hidden from assistive technology: the pill's own name says what it shows.
	await expect(meter).toHaveJSProperty("tagName", "svg");
	await expect(meter).toHaveAttribute("aria-hidden", "true");
	// What the pill takes: no wider than its text and a 14 px ring (the bar was 48 px wide).
	await expect(meter).toHaveAttribute("width", "14");

	/** The computed colour of a theme token, as the browser resolves it. */
	const tone = (token: string) =>
		page.evaluate((t) => {
			const probe = document.createElement("i");
			probe.style.color = `var(${t})`;
			document.body.append(probe);
			const colour = getComputedStyle(probe).color;
			probe.remove();
			return colour;
		}, token);
	const stroke = () => arc.evaluate((el) => getComputedStyle(el).stroke);

	let turn = 0;
	const show = async (fraction: number, text: string) => {
		byProvider.anthropic = fiveHour("anthropic", fraction, NOW + 2 * 3_600_000);
		turn++;
		await page.getByTestId("composer").fill(`!echo ring-${turn}`);
		await page.getByTestId("composer").press("Enter");
		await expect(pill).toContainText(text);
	};

	// 53% left: more than half a circle, in the accent.
	await expect(pill.getByTestId("quota-figure")).toHaveText("53% left");
	await expect(meter).toHaveAttribute("data-left", "53");
	await expect(arc).toHaveAttribute("stroke-dasharray", "53 100");
	await expect(arc).toHaveAttribute("pathLength", "100");
	expect(await stroke()).toBe(await tone("--accent"));
	await expect(pill).toHaveAttribute("data-level", "ok");

	// 25% is the last of "ok", 24% the first of "low" (the warning tone).
	await show(0.25, "25% left");
	await expect(arc).toHaveAttribute("stroke-dasharray", "25 100");
	await expect(pill).toHaveAttribute("data-level", "ok");
	expect(await stroke()).toBe(await tone("--accent"));
	await show(0.24, "24% left");
	await expect(arc).toHaveAttribute("stroke-dasharray", "24 100");
	await expect(pill).toHaveAttribute("data-level", "low");
	expect(await stroke()).toBe(await tone("--warning"));

	// 10% is the last of "low", 9% the first of "critical" (the danger tone).
	await show(0.1, "10% left");
	await expect(pill).toHaveAttribute("data-level", "low");
	expect(await stroke()).toBe(await tone("--warning"));
	await show(0.09, "9% left");
	await expect(arc).toHaveAttribute("stroke-dasharray", "9 100");
	await expect(pill).toHaveAttribute("data-level", "critical");
	expect(await stroke()).toBe(await tone("--danger"));

	// All left: the whole circle. None left (the provider says used up): no arc, only the track.
	await show(1, "100% left");
	await expect(meter).toHaveAttribute("data-left", "100");
	await expect(arc).toHaveAttribute("stroke-dasharray", "100 100");
	expect(await stroke()).toBe(await tone("--accent"));
	await show(0, "resets in");
	await expect(meter).toHaveAttribute("data-left", "0");
	await expect(arc).toHaveCount(0);
	await expect(pill).toHaveAttribute("data-level", "critical");
});

test("the header's quota bar opens the same details popover, and the narrow header keeps the figure alone", async ({
	page,
}) => {
	const title = "Quota bar popover probe";
	ownSession(0xfb, title);
	await page.clock.install({ time: NOW });
	await stubUsage(page, { anthropic: fiveHour("anthropic", 0.4, NOW + 2 * 3_600_000) });
	await patchReplies(page, {
		get_state: (data) => {
			const state = typeof data === "object" && data !== null ? data : {};
			const model = "model" in state && typeof state.model === "object" ? state.model : {};
			return {
				...state,
				model: { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", ...model, provider: "anthropic" },
			};
		},
	});
	await page.goto("/");
	await openSidebar(page);
	await expect(sessionRow(page, title)).toHaveCount(1, { timeout: 15_000 });
	await sessionRow(page, title).click();
	await page.getByTestId("composer").fill("!echo quota-bar-popover");
	await page.getByTestId("composer").press("Enter");
	await expect(page.getByTestId("msg-exec").filter({ hasText: "quota-bar-popover" })).toBeVisible({ timeout: 60_000 });

	await page.getByTestId("quota-bar").getByTestId("quota").click();
	const popover = page.getByTestId("quota-popover");
	await expect(popover).toBeVisible();
	await expect(popover).toContainText("anthropic usage limits");
	await expect(popover.getByTestId("quota-window")).toContainText("5 Hour: 40% left");
	await page.keyboard.press("Escape");
	await expect(popover).toHaveCount(0);
});

// ------------------------------------------------------------------ how often the quota is looked at (#458)

/**
 * A conversation that works looks at its provider's quota every 30 seconds, and once more when the work ends: a turn
 * spends quota the whole time it runs, and the figures a page shows are otherwise minutes out of date. A conversation
 * that does nothing is looked at far less often. A page nobody sees is not looked at at all (#396).
 */
test("a conversation that works looks at the quota every 30 seconds, and once more when the turn ends", async ({
	page,
}) => {
	const title = "Quota refresh probe";
	ownSession(0xfc, title);
	await page.clock.install({ time: NOW });
	const asked: string[] = [];
	await stubUsage(page, { anthropic: fiveHour("anthropic", 0.4, NOW + 5 * 3_600_000) }, asked);
	await patchReplies(page, {
		get_state: (data) => {
			const state = typeof data === "object" && data !== null ? data : {};
			const model = "model" in state && typeof state.model === "object" ? state.model : {};
			return {
				...state,
				model: { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", ...model, provider: "anthropic" },
			};
		},
	});
	const tap = await tapSocket(page);
	await page.goto("/");
	await openSidebar(page);
	await expect(sessionRow(page, title)).toHaveCount(1, { timeout: 15_000 });
	await sessionRow(page, title).click();
	const liveId = await startLive(page, tap, title, "quota-refresh-up");
	await expect(page.getByTestId("quota").getByTestId("quota-figure")).toHaveText("40% left", { timeout: 15_000 });
	const afterFirst = asked.length;
	expect(afterFirst).toBeGreaterThan(0);

	// A turn runs: the quota is looked at every 30 s.
	tap.push({ t: "frame", liveId, frame: { type: "agent_start" } });
	await expect(page.getByTestId("stop")).toBeVisible();
	await page.clock.fastForward(30_000);
	await expect.poll(() => asked.length).toBe(afterFirst + 1);
	await page.clock.fastForward(30_000);
	await expect.poll(() => asked.length).toBe(afterFirst + 2);

	// The turn ends: the quota is looked at once more, right away (the figures are what the turn spent).
	const before = asked.length;
	tap.push({ t: "frame", liveId, frame: { type: "agent_end", messages: [] } });
	await expect.poll(() => asked.length).toBe(before + 1);
	// The conversation is idle again, so the next look is the idle one, two minutes later.
	const afterEnd = asked.length;
	await page.clock.fastForward(60_000);
	expect(asked.length).toBe(afterEnd);
	await page.clock.fastForward(61_000);
	await expect.poll(() => asked.length).toBe(afterEnd + 1);
});

test("a conversation that does nothing is looked at far less often than one that works", async ({ page }) => {
	await page.clock.install({ time: NOW });
	const asked: string[] = [];
	await stubUsage(page, { anthropic: fiveHour("anthropic", 0.4, NOW + 5 * 3_600_000) }, asked);
	await openSaved(page, 0xfd, "Quota probe: idle refresh");
	await expect(page.getByTestId("quota").getByTestId("quota-figure")).toHaveText("40% left", { timeout: 15_000 });
	const afterFirst = asked.length;

	// A minute passes: an idle conversation is not looked at every 30 s.
	await page.clock.fastForward(60_000);
	await page.waitForTimeout(500);
	expect(asked.length).toBe(afterFirst);
});
