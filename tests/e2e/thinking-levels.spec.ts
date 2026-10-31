import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeChatSession } from "../support/chat-session.ts";
import { appReady } from "../support/live.ts";
import { choose, readOptions } from "../support/select.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/** The thinking-level picker lists the model's levels on arrival and again after every model switch (no model call). */

const LEVELS = "get_available_thinking_levels";

/**
 * The levels the picker offers (option values: the labels are translated). The list is opened to read them, and closed
 * again: what is checked is that they are there, which was asked for on arrival, with no focus needed for it.
 */
const levelsShown = async (page: Page) => (await readOptions(page.getByTestId("thinking-picker"))).map((o) => o.value);

/** `levels` of an omp `get_available_thinking_levels` reply. */
function levelsOf(reply: unknown): string[] {
	return reply && typeof reply === "object" && "levels" in reply && Array.isArray(reply.levels)
		? reply.levels.map(String)
		: [];
}

test("levels are listed without focusing the picker and follow the model", async ({ page }) => {
	const tap = await tapSocket(page);
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	const picker = page.getByTestId("thinking-picker");
	await expect(picker).toBeVisible({ timeout: 60_000 });

	// On arrival, with the control untouched: the levels are asked for, and every level the model offers is listed, not just
	// the current one.
	await expect.poll(() => tap.commands(LEVELS).length).toBeGreaterThanOrEqual(1);
	await expect.poll(async () => (await levelsShown(page)).length).toBeGreaterThan(1);
	const before = tap.commands(LEVELS).length;

	// Switch to another model of the same provider (its credentials exist in this environment).
	await page.getByTestId("model-picker").click();
	const current = page.locator("[cmdk-group]").filter({ has: page.locator("svg.opacity-100") });
	const others = current.getByRole("option").filter({ hasNot: page.locator("svg.opacity-100") });
	await expect(others.first()).toBeVisible({ timeout: 30_000 });
	await others.first().click();
	await expect.poll(() => tap.commands("set_model").length).toBe(1);

	// The levels are asked for again, and the picker shows what omp answered, plus the level now selected, and `auto`
	// (which omp never lists) after `off` for a model that can think: one that answers only `off` gets none.
	await expect.poll(() => tap.commands(LEVELS).length).toBeGreaterThan(before);
	await expect
		.poll(async () => {
			const answered = levelsOf(tap.replies(LEVELS).at(-1));
			const offered = answered.some((l) => l !== "off")
				? [...answered.slice(0, 1), "auto", ...answered.slice(1)]
				: answered;
			return (
				(await levelsShown(page)).join() ===
				[...new Set([(await picker.getAttribute("data-value")) ?? "", ...offered])].join()
			);
		})
		.toBe(true);
});

/**
 * omp's `auto` level: it resolves to a level of its own for each turn, reports that one as the conversation's level, and
 * does not list `auto` among the levels it offers. The picker has to add it and to say `auto` while it is what is set.
 */
test("`auto` is offered, shown with the level it resolved to, and left and chosen again", async ({ page }) => {
	const tap = await tapSocket(page);
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	const picker = page.getByTestId("thinking-picker");
	await expect(picker).toBeVisible({ timeout: 60_000 });
	await expect.poll(() => tap.commands(LEVELS).length).toBeGreaterThanOrEqual(1);

	// omp's own list has no `auto`; the picker offers it next to `off`, where the terminal UI has it.
	await expect.poll(() => levelsShown(page), { timeout: 15_000 }).toContain("auto");
	expect(levelsOf(tap.replies(LEVELS).at(-1))).not.toContain("auto");
	const shown = await levelsShown(page);
	expect(shown.indexOf("auto")).toBe(shown.indexOf("off") + 1);

	// Choosing it sets it, and the picker keeps saying `auto` (omp reports the level it resolved to as its level), with
	// that level as a hint.
	await choose(picker, "auto");
	await expect.poll(() => tap.commands("set_thinking_level").at(-1)?.level).toBe("auto");
	await expect(picker).toHaveAttribute("data-value", "auto");
	await expect(picker).toHaveText(/^Auto \(.+\)$/);

	// An explicit level ends it, and `auto` can be chosen again.
	await choose(picker, "low");
	await expect.poll(() => tap.commands("set_thinking_level").at(-1)?.level).toBe("low");
	await expect(picker).toHaveAttribute("data-value", "low");
	await expect(picker).toHaveText("Low");
	await choose(picker, "auto");
	await expect.poll(() => tap.commands("set_thinking_level").at(-1)?.level).toBe("auto");
	await expect(picker).toHaveAttribute("data-value", "auto");
});

test("a saved conversation that was on `auto` shows `auto`, not the level it resolved to", async ({ page }) => {
	const file = writeChatSession(process.env.OMPW_E2E_AGENT_DIR as string, {
		n: 0x94,
		title: "Auto level probe",
		turns: [{ prompt: "Question", reply: "Answer" }],
	});
	// What omp journals when `auto` is picked: the level it resolved to, and the selector as configured.
	appendFileSync(
		file,
		`${JSON.stringify({
			type: "thinking_level_change",
			id: "t0auto",
			parentId: "t0r",
			timestamp: new Date(Date.UTC(2026, 0, 9, 0, 1, 0)).toISOString(),
			thinkingLevel: "high",
			configured: "auto",
		})}\n`,
	);
	await page.goto(`/#/s/${encodeURIComponent(file)}`);
	await appReady(page);
	const picker = page.getByTestId("thinking-picker");
	await expect(picker).toHaveAttribute("data-value", "auto");
	await expect(picker).toHaveText(/^Auto/);
});

/**
 * omp starts on `auto` without a `--thinking auto` when the default role's selector (`:auto`) or `defaultThinkingLevel` says so,
 * and announces nothing: `get_state` reports only the level it resolved to. The page takes the selector from the config.
 */
test("a conversation omp starts on `auto` by its config shows Auto", async ({ page }) => {
	const file = join(process.env.OMPW_E2E_AGENT_DIR as string, "config.yml");
	const original = readFileSync(file, "utf8");
	try {
		const global = await (await page.request.get("/api/model-config")).json();
		await page.request.post("/api/model-config/roles", {
			headers: { "x-omp-webui": "1" },
			data: { roles: { ...global.roles, default: "anthropic/claude-haiku-5-5:auto" } },
		});
		await expect
			.poll(async () => (await (await page.request.get("/api/model-config")).json()).roles.default, {
				timeout: 15_000,
			})
			.toBe("anthropic/claude-haiku-5-5:auto");
		await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
		await page.goto("/");
		const picker = page.getByTestId("thinking-picker");
		await expect(picker).toBeVisible({ timeout: 60_000 });
		await expect(picker).toHaveAttribute("data-value", "auto", { timeout: 15_000 });
		await expect(picker).toHaveText(/^Auto/);
	} finally {
		writeFileSync(file, original);
	}
});

/**
 * omp sends no `thinking_level_changed` for a selector that did not change (`set_thinking_level auto` on a process
 * already on auto: success and silence). The picker must keep what was accepted, not fall back to the resolved level.
 */
test("choosing Auto keeps it selected when omp accepts it without announcing a change", async ({ page }) => {
	const tap = await tapSocket(page);
	tap.answer("set_thinking_level", () => ({ ok: true }));
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	const picker = page.getByTestId("thinking-picker");
	await expect(picker).toBeVisible({ timeout: 60_000 });
	await expect.poll(() => levelsShown(page)).toContain("auto");
	await choose(picker, "auto");
	await expect.poll(() => tap.commands("set_thinking_level").length).toBe(1);
	await page.waitForTimeout(500);
	await expect(picker).toHaveAttribute("data-value", "auto");
});
