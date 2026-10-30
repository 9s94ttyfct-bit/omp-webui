import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withYaml } from "../support/config-yml.ts";
import { unfoldAdvanced } from "../support/controls.ts";
import { ownSession, sessionRow, startLive } from "../support/live.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * "Set as default" in the session controls: what a row shows becomes omp's global default (`omp config set`, as the
 * terminal does), a conversation started afterwards begins with it, and the conversations already open are left as they
 * are, although omp's running processes follow the global config for every setting they were not given a value of their
 * own for. No model call is made: the controls only need a process.
 */

let configFile: string;
let original = "";
test.beforeAll(() => {
	configFile = join(process.env.OMPW_E2E_AGENT_DIR as string, "config.yml");
	original = readFileSync(configFile, "utf8");
});
test.beforeEach(() => writeFileSync(configFile, original));
test.afterEach(() => writeFileSync(configFile, original));

/** A page of its own on the shared server, with the page's socket tapped before it loads. */
async function openPage(page: Page, title: string) {
	const next = await page.context().newPage();
	await next.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(next);
	await next.goto("/");
	await expect(sessionRow(next, title)).toHaveCount(1, { timeout: 15_000 });
	return { page: next, tap };
}

const panel = (page: Page) => page.getByTestId("session-controls-panel");
const radio = (page: Page, row: string, name: string) => panel(page).getByTestId(row).getByRole("radio", { name });

/** The panel of the open conversation: its omp's own settings, as `get_state` reports them. */
async function openPanel(page: Page) {
	await page.getByTestId("session-controls").click();
	await expect(panel(page)).toBeVisible({ timeout: 60_000 });
	await unfoldAdvanced(page);
}

test("Set as default writes omp's global default; a new conversation starts with it and open ones keep theirs", async ({
	page,
}) => {
	ownSession(0xd1, "Defaults origin");
	ownSession(0xd2, "Defaults bystander");
	ownSession(0xd3, "Defaults newcomer");
	const origin = await openPage(page, "Defaults origin");
	const bystander = await openPage(page, "Defaults bystander");
	await startLive(origin.page, origin.tap, "Defaults origin", "defaults-origin-up");
	await startLive(bystander.page, bystander.tap, "Defaults bystander", "defaults-bystander-up");

	// Both are on omp's defaults. In the origin, change two settings and make each the default.
	await openPanel(origin.page);
	await expect(radio(origin.page, "steering-mode", "One at a time")).toBeChecked();
	await expect(radio(origin.page, "auto-compaction", "On")).toBeChecked();
	await panel(origin.page).getByTestId("steering-mode").getByText("All", { exact: true }).click();
	await expect(radio(origin.page, "steering-mode", "All")).toBeChecked();
	await panel(origin.page).getByTestId("auto-compaction").getByText("Off", { exact: true }).click();
	await expect(radio(origin.page, "auto-compaction", "Off")).toBeChecked();
	// Nothing is the default yet: the choices were this session's.
	expect(readFileSync(configFile, "utf8")).not.toMatch(/steeringMode: all/);

	await panel(origin.page).getByTestId("steering-mode-set-default").click();
	await expect(
		origin.page.getByTestId("toast").filter({ hasText: "Steering delivery is now All by default" }),
	).toBeVisible();
	await panel(origin.page).getByTestId("auto-compaction-set-default").click();
	await expect(
		origin.page.getByTestId("toast").filter({ hasText: "Auto-compaction is now Off by default" }),
	).toBeVisible();
	await expect
		.poll(() => readFileSync(configFile, "utf8"), { timeout: 15_000 })
		.toMatch(/steeringMode: all[\s\S]*enabled: false|enabled: false[\s\S]*steeringMode: all/);

	// The session keeps its value.
	await expect(radio(origin.page, "steering-mode", "All")).toBeChecked();
	await expect(radio(origin.page, "auto-compaction", "Off")).toBeChecked();

	// The conversation that was open meanwhile has what it had. A running omp follows a change of config.yml within about
	// 200 ms (measured), and the margin is what lets a missing hold show: unheld, it reads the new default. A reload
	// then asks its omp again, so the panel shows omp's own state and not the page's earlier one.
	await origin.page.waitForTimeout(3000);
	await bystander.page.reload();
	await sessionRow(bystander.page, "Defaults bystander").click();
	await openPanel(bystander.page);
	await expect(radio(bystander.page, "steering-mode", "One at a time")).toBeChecked();
	await expect(radio(bystander.page, "auto-compaction", "On")).toBeChecked();

	// A conversation started now begins with the default.
	const newcomer = await openPage(page, "Defaults newcomer");
	await sessionRow(newcomer.page, "Defaults newcomer").click();
	await openPanel(newcomer.page);
	await expect(radio(newcomer.page, "steering-mode", "All")).toBeChecked();
	await expect(radio(newcomer.page, "auto-compaction", "Off")).toBeChecked();
});

test("auto-retry and cache warming show what the process uses, and their stars save it as omp's default (#597)", async ({
	page,
}) => {
	// omp reports neither in `get_state`: the server works it out from the configuration the process loaded (here a
	// global config that differs from omp's defaults, so that a guess at the defaults would show). The text starts a line
	// of its own: `omp config set` leaves config.yml with no final newline, and a first key glued to the last line is no
	// YAML: omp moves such a file aside and reads its defaults (#600).
	writeFileSync(configFile, withYaml(original, "retry:\n  enabled: false\nproviders:\n  cacheWarming: streaming"));
	ownSession(0x6a, "Defaults retry");
	const only = await openPage(page, "Defaults retry");
	await startLive(only.page, only.tap, "Defaults retry", "defaults-retry-up");
	await openPanel(only.page);

	await expect(radio(only.page, "auto-retry", "Off")).toBeChecked();
	await expect(radio(only.page, "cache-warming", "Streaming")).toBeChecked();
	// What they show is what omp's configuration says, which is the default: both stars are filled, and a filled star
	// saves nothing (#610).
	for (const row of ["auto-retry", "cache-warming"]) {
		await expect(panel(only.page).getByTestId(`${row}-set-default`)).toBeEnabled();
		await expect(panel(only.page).getByTestId(`${row}-set-default`)).toHaveAttribute("aria-pressed", "true");
	}

	// A choice of this process's own is not the default: its star is hollow, and saves what is shown.
	await panel(only.page).getByTestId("cache-warming").getByText("Idle", { exact: true }).click();
	await expect(radio(only.page, "cache-warming", "Idle")).toBeChecked();
	await expect(panel(only.page).getByTestId("cache-warming-set-default")).toHaveAttribute("aria-pressed", "false");
	await panel(only.page).getByTestId("cache-warming-set-default").click();
	await expect(
		only.page.getByTestId("toast").filter({ hasText: "Prompt-cache warming is now Idle by default" }),
	).toBeVisible();
	await expect.poll(() => readFileSync(configFile, "utf8"), { timeout: 15_000 }).toMatch(/cacheWarming: "?idle"?/);
	await expect(panel(only.page).getByTestId("cache-warming-set-default")).toHaveAttribute("aria-pressed", "true");
});

test("a choice of auto-retry or cache warming is the process's own: shown again, shown on another page, saved by the star (#597)", async ({
	page,
}) => {
	ownSession(0x6b, "Defaults retry choice");
	const only = await openPage(page, "Defaults retry choice");
	await startLive(only.page, only.tap, "Defaults retry choice", "defaults-retry-choice-up");
	await openPanel(only.page);

	// omp's own defaults: retry on, warming while idle.
	await expect(radio(only.page, "auto-retry", "On")).toBeChecked();
	await expect(radio(only.page, "cache-warming", "Idle")).toBeChecked();

	await panel(only.page).getByTestId("auto-retry").getByText("Off", { exact: true }).click();
	await expect(radio(only.page, "auto-retry", "Off")).toBeChecked();
	await panel(only.page).getByTestId("cache-warming").getByText("Off", { exact: true }).click();
	await expect(radio(only.page, "cache-warming", "Off")).toBeChecked();
	// Nothing is the default yet: the choices were this process's.
	expect(readFileSync(configFile, "utf8")).toBe(original);

	// Closing and opening the panel shows the same.
	await only.page.keyboard.press("Escape");
	await expect(panel(only.page)).toBeHidden();
	await openPanel(only.page);
	await expect(radio(only.page, "auto-retry", "Off")).toBeChecked();
	await expect(radio(only.page, "cache-warming", "Off")).toBeChecked();

	// Another page on the same conversation shows what the process was told, not omp's defaults.
	const other = await openPage(page, "Defaults retry choice");
	await sessionRow(other.page, "Defaults retry choice").click();
	await openPanel(other.page);
	await expect(radio(other.page, "auto-retry", "Off")).toBeChecked();
	await expect(radio(other.page, "cache-warming", "Off")).toBeChecked();
	// And hears the next choice while its panel is open.
	await panel(only.page).getByTestId("cache-warming").getByText("Streaming", { exact: true }).click();
	await expect(radio(other.page, "cache-warming", "Streaming")).toBeChecked();

	await panel(only.page).getByTestId("auto-retry-set-default").click();
	await expect(only.page.getByTestId("toast").filter({ hasText: "Auto-retry is now Off by default" })).toBeVisible();
	await expect.poll(() => readFileSync(configFile, "utf8"), { timeout: 15_000 }).toMatch(/retry:[\s\S]*enabled: false/);
	await panel(only.page).getByTestId("cache-warming-set-default").click();
	await expect(
		only.page.getByTestId("toast").filter({ hasText: "Prompt-cache warming is now Streaming by default" }),
	).toBeVisible();
	await expect.poll(() => readFileSync(configFile, "utf8"), { timeout: 15_000 }).toMatch(/cacheWarming: "?streaming"?/);
});

test("the stars of a conversation on a local server are disabled with the reason, and a click asks the server nothing (#488)", async ({
	page,
}) => {
	ownSession(0xd5, "Defaults local");
	const only = await openPage(page, "Defaults local");
	// The conversation runs in Full here (no model is needed); what the page is told is that it is Light on a local server.
	const local = (info: Record<string, unknown>) => ({ ...info, mode: "light", lightModels: "local" });
	only.tap.rewrite((msg, request) => {
		if (msg.t === "reply" && request?.t === "open" && msg.ok)
			return { ...msg, data: local(msg.data as Record<string, unknown>) };
		if (msg.t === "live") return { ...msg, info: local(msg.info as Record<string, unknown>) };
		return msg;
	});
	await startLive(only.page, only.tap, "Defaults local", "defaults-local-up");
	const requests: string[] = [];
	only.page.on("request", (r) => {
		if (r.url().includes("/api/controls/default")) requests.push(r.url());
	});
	await openPanel(only.page);
	const star = panel(only.page).getByTestId("steering-mode-set-default");
	await expect(star).toBeDisabled();
	await expect(star).toHaveAccessibleName(/local server/i);
	for (const row of ["auto-compaction", "auto-retry", "follow-up-mode", "interrupt-mode", "fast-mode", "cache-warming"])
		await expect(panel(only.page).getByTestId(`${row}-set-default`)).toBeDisabled();
	await star.click({ force: true });
	expect(requests).toEqual([]);
});

/** What omp keeps of `tier` in config.yml, as `omp config set tier.<family>` wrote it. */
const tiers = () => {
	const text = readFileSync(configFile, "utf8");
	const block = /^tier:\n((?: {2}.*\n?)*)/m.exec(text)?.[1] ?? "";
	return Object.fromEntries([...block.matchAll(/^ {2}(\w+): (\S+)$/gm)].map((m) => [m[1], m[2]]));
};

test("Fast mode's star sets the service tier of the conversation's own provider and leaves the other families' alone (#486)", async ({
	page,
}) => {
	// omp's /fast only touches the family of the model it runs on; a user may keep a cheaper tier for the others.
	writeFileSync(configFile, withYaml(original, "tier:\n  openai: flex\n  google: flex"));
	ownSession(0xd6, "Defaults fast");
	ownSession(0xd9, "Claude bystander");
	const only = await openPage(page, "Defaults fast");
	const bystander = await openPage(page, "Claude bystander");
	await startLive(only.page, only.tap, "Defaults fast", "defaults-fast-up");
	await startLive(bystander.page, bystander.tap, "Claude bystander", "defaults-fast-by-up");
	await openPanel(only.page);
	await panel(only.page).getByTestId("fast-mode").getByText("On", { exact: true }).click();
	await expect(radio(only.page, "fast-mode", "On")).toBeChecked();
	await panel(only.page).getByTestId("fast-mode-set-default").click();
	await expect(
		only.page.getByTestId("toast").filter({ hasText: "Fast mode (Anthropic) is now On by default" }),
	).toBeVisible();
	await expect.poll(tiers, { timeout: 15_000 }).toMatchObject({ anthropic: "priority" });
	expect(tiers()).toEqual({ anthropic: "priority", openai: "flex", google: "flex" });
	// Another conversation on the same provider is not made fast by it.
	await bystander.page.waitForTimeout(3000);
	await bystander.page.reload();
	await sessionRow(bystander.page, "Claude bystander").click();
	await openPanel(bystander.page);
	await expect(radio(bystander.page, "fast-mode", "Off")).toBeChecked();
});

test("Fast mode off as the default clears only what /fast clears: priority or ultrafast of this family, nothing else (#486)", async ({
	page,
}) => {
	writeFileSync(configFile, withYaml(original, "tier:\n  anthropic: priority\n  openai: ultrafast\n  google: flex"));
	ownSession(0xd7, "Defaults fast off");
	const only = await openPage(page, "Defaults fast off");
	await startLive(only.page, only.tap, "Defaults fast off", "defaults-fast-off-up");
	await openPanel(only.page);
	await expect(radio(only.page, "fast-mode", "On")).toBeChecked();
	await panel(only.page).getByTestId("fast-mode").getByText("Off", { exact: true }).click();
	await expect(radio(only.page, "fast-mode", "Off")).toBeChecked();
	await panel(only.page).getByTestId("fast-mode-set-default").click();
	await expect(
		only.page.getByTestId("toast").filter({ hasText: "Fast mode (Anthropic) is now Off by default" }),
	).toBeVisible();
	await expect.poll(tiers, { timeout: 15_000 }).toMatchObject({ anthropic: "none" });
	expect(tiers()).toEqual({ anthropic: "none", openai: "ultrafast", google: "flex" });
});

test("Fast mode has no star to press on a model with no service-tier family, and says why (#486)", async ({ page }) => {
	ownSession(0xd8, "Defaults fast none");
	const only = await openPage(page, "Defaults fast none");
	await startLive(only.page, only.tap, "Defaults fast none", "defaults-fast-none-up");
	// The page is told the conversation runs on a provider omp has no tier family for (a local one).
	only.tap.rewrite((msg, request) => {
		if (msg.t === "reply" && msg.ok && request?.t === "rpc" && request.command?.type === "get_state") {
			const data = msg.data as { model?: Record<string, unknown> };
			return { ...msg, data: { ...data, model: { ...data.model, provider: "omlx", api: "openai-completions" } } };
		}
		return msg;
	});
	await openPanel(only.page);
	await panel(only.page).getByTestId("fast-mode").getByText("On", { exact: true }).click();
	const star = panel(only.page).getByTestId("fast-mode-set-default");
	await expect(star).toBeDisabled();
	await expect(star).toHaveAccessibleName(/no service tier/i);
	await expect(panel(only.page).getByTestId("steering-mode-set-default")).toBeEnabled();
});

test("a conversation started with a --config of its own keeps what that file says when another's default changes (#487)", async ({
	page,
}) => {
	// Global: one at a time. The conversation below runs on `all` from its own file, which beats the global config.
	const own = join(process.env.OMPW_E2E_ROOT as string, "own-config-487.yml");
	writeFileSync(own, "steeringMode: all\n");
	ownSession(0xda, "Defaults origin 487");
	const origin = await openPage(page, "Defaults origin 487");
	await startLive(origin.page, origin.tap, "Defaults origin 487", "defaults-487-up");

	// A conversation of the server's own, opened as New chat does with the option typed in: a socket of its own in the page.
	const flagged = await origin.page.evaluate(
		async ({ cwd, config }) => {
			const ws = new WebSocket(`${location.origin.replace("http", "ws")}/ws`);
			await new Promise((ok) => {
				ws.onopen = ok;
			});
			const ask = (msg: Record<string, unknown>) =>
				new Promise<{ ok: boolean; data: Record<string, unknown> }>((resolve) => {
					const req = crypto.randomUUID();
					const on = (ev: MessageEvent) => {
						const m = JSON.parse(String(ev.data));
						if (m.t === "reply" && m.req === req) {
							ws.removeEventListener("message", on);
							resolve(m);
						}
					};
					ws.addEventListener("message", on);
					ws.send(JSON.stringify({ ...msg, req }));
				});
			const opened = await ask({ t: "open", target: { kind: "new", cwd, args: [`--config=${config}`] } });
			const liveId = String(opened.data.liveId);
			(window as unknown as { askFlagged: unknown }).askFlagged = async () =>
				(await ask({ t: "rpc", liveId, command: { type: "get_state" } })).data;
			return liveId;
		},
		{ cwd: process.env.OMPW_E2E_WORK as string, config: own },
	);
	const steering = () =>
		origin.page.evaluate(async () => {
			const ask = (window as unknown as { askFlagged: () => Promise<{ steeringMode?: string }> }).askFlagged;
			return (await ask()).steeringMode;
		});
	expect(flagged).not.toBe("undefined");
	await expect.poll(steering, { timeout: 30_000 }).toBe("all");

	// The first conversation makes `all` the default. The flagged one, whose own file already says it, is left as it is:
	// pinning it to what the global config said before would put `one-at-a-time` over its file.
	await openPanel(origin.page);
	await panel(origin.page).getByTestId("steering-mode").getByText("All", { exact: true }).click();
	await expect(radio(origin.page, "steering-mode", "All")).toBeChecked();
	await panel(origin.page).getByTestId("steering-mode-set-default").click();
	await expect.poll(() => readFileSync(configFile, "utf8"), { timeout: 15_000 }).toMatch(/steeringMode: all/);
	await origin.page.waitForTimeout(3000);
	expect(await steering()).toBe("all");
});
