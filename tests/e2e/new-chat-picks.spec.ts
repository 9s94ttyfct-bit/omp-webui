import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { type StubOmlx, startStubOmlx } from "../support/stub-omlx.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The model, thinking level and preset picked on New chat belong to the warm-up process, which is replaced when the
 * folder or the options change. The choices are put on the next process before it is shown, per mode, and one the new
 * process refuses is dropped with a warning (#435). No model is called: switching a model only sets it.
 */

const api = (body: unknown) =>
	fetch(`${process.env.OMPW_E2E_URL}/api/mode`, {
		method: "POST",
		headers: {
			"x-omp-webui-token": String(process.env.OMPW_E2E_ACCESS_TOKEN),
			"x-omp-webui": "1",
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	});

const opens = (tap: SocketTap) => tap.sent.filter((m) => m.t === "open");
const OPTION = '[data-flag="--append-system-prompt"]';

async function newChat(page: Page) {
	const tap = await tapSocket(page);
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	await expect(page.getByTestId("thinking-picker")).toBeVisible({ timeout: 60_000 });
	return tap;
}

/** Switch to a model of the same provider other than the one in use (its credentials exist here). */
async function pickOtherModel(page: Page, tap: SocketTap) {
	const before = tap.commands("set_model").length;
	await page.getByTestId("model-picker").click();
	const current = page.locator("[cmdk-group]").filter({ has: page.locator("svg.opacity-100") });
	const others = current.getByRole("option").filter({ hasNot: page.locator("svg.opacity-100") });
	await expect(others.first()).toBeVisible({ timeout: 30_000 });
	await others.first().click();
	await expect.poll(() => tap.commands("set_model").length).toBe(before + 1);
}

/** Restart the warm-up process through Options: a value applied on Enter. */
async function restartThroughOptions(page: Page, tap: SocketTap, value: string) {
	const started = opens(tap).length;
	const field = page.locator(OPTION);
	if (!(await field.isVisible())) await page.getByRole("button", { name: /^Options/ }).click();
	await field.fill(value);
	await field.press("Enter");
	await expect.poll(() => opens(tap).length).toBe(started + 1);
}

test("a thinking level chosen before the options change is on the next process", async ({ page }) => {
	const tap = await newChat(page);
	const picker = page.getByTestId("thinking-picker");
	const levels = await picker
		.locator("option")
		.evaluateAll((els) => els.map((el) => (el instanceof HTMLOptionElement ? el.value : "")));
	const current = await picker.inputValue();
	const chosen = levels.find((l) => l !== current);
	expect(chosen).toBeTruthy();
	await picker.selectOption(chosen as string);
	await expect.poll(() => tap.commands("set_thinking_level")).toEqual([{ type: "set_thinking_level", level: chosen }]);

	await restartThroughOptions(page, tap, "kept");
	await expect(picker).toBeVisible({ timeout: 60_000 });
	await expect(picker).toHaveValue(chosen as string);
	// The new process was told, once: it started on the default.
	await expect.poll(() => tap.commands("set_thinking_level")).toHaveLength(2);
	expect(tap.commands("set_thinking_level")[1]).toEqual({ type: "set_thinking_level", level: chosen });
});

test("a model chosen before the folder changes is on the process started for the new folder", async ({ page }) => {
	const folder = join(process.env.OMPW_E2E_WORK as string, "proj2");
	mkdirSync(folder, { recursive: true });
	const tap = await newChat(page);
	await pickOtherModel(page, tap);
	const picked = tap.commands("set_model")[0];
	await expect(page.getByTestId("model-picker")).not.toContainText("Haiku 5.5");
	const label = await page.getByTestId("model-picker").innerText();

	const started = opens(tap).length;
	await page.getByTestId("cwd-picker").click();
	const dialog = page.getByRole("dialog");
	// The listing of the current folder fills the field when it arrives: type after it.
	await expect(dialog.getByTestId("dir-up")).toBeVisible();
	await dialog.getByLabel("Path").fill(folder);
	await dialog.getByRole("button", { name: "Use this folder" }).click();
	await expect.poll(() => opens(tap).length).toBe(started + 1);
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });

	// The new process was set to the same model before the composer showed it, and the picker says so.
	await expect.poll(() => tap.commands("set_model")).toHaveLength(2);
	expect(tap.commands("set_model")[1]).toEqual(picked);
	await expect(page.getByTestId("model-picker")).toHaveText(label);
});

test("a choice the new process refuses is dropped with a warning, and the process shows its own model", async ({
	page,
}) => {
	const tap = await tapSocket(page);
	// The first set_model (the user's) is the real omp's; the one for the restarted process is refused.
	let sets = 0;
	tap.answer("set_model", () => (sets++ === 0 ? undefined : { ok: false, error: "Model not found: gone" }));
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toContainText("Haiku 5.5", { timeout: 60_000 });
	await pickOtherModel(page, tap);

	await restartThroughOptions(page, tap, "dropped");
	await expect(page.getByTestId("toast").filter({ hasText: "Model not found: gone" })).toBeVisible({ timeout: 60_000 });
	await expect(page.getByTestId("model-picker")).toContainText("Haiku 5.5");

	// It is not tried again on the next process.
	await restartThroughOptions(page, tap, "dropped again");
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
	expect(tap.commands("set_model")).toHaveLength(2);
});

test.describe("per mode", () => {
	test.skip(Boolean(process.env.OMPW_E2E_OFFLINE), "the Full start needs the login");
	let ollama: StubOmlx;
	test.beforeAll(async () => {
		ollama = await startStubOmlx({ models: ["stub-ollama-model"], apiKey: null, ollama: true });
	});
	test.afterAll(async () => {
		await api({ mode: "full", lightModels: "yours", offline: { backend: "omlx", baseUrls: { ollama: null } } });
		await ollama.stop();
	});

	/** Choose the mode of the next process in New chat's chip. */
	const chip = async (page: Page, mode: "full" | "light") => {
		await page.getByTestId("mode-picker").click();
		await page.getByTestId(`mode-picker-${mode}`).click();
		await expect(page.getByTestId("mode-picker")).toHaveAttribute("data-mode", mode);
	};

	test("your own model is not put on a process that runs on a local server, and is back when Full is selected again", async ({
		page,
	}) => {
		await api({
			mode: "full",
			lightModels: "local",
			offline: { backend: "ollama", baseUrls: { ollama: ollama.url } },
		});
		const tap = await newChat(page);
		await pickOtherModel(page, tap);
		const picked = tap.commands("set_model")[0];
		await expect(page.getByTestId("model-picker")).not.toContainText("Haiku 5.5");
		const label = await page.getByTestId("model-picker").innerText();

		await chip(page, "light");
		await expect(page.getByTestId("model-picker")).toContainText("stub-ollama-model", { timeout: 60_000 });
		// Your model is not asked of the process on the local server: nothing was set, and nothing was dropped with a warning.
		expect(tap.commands("set_model")).toHaveLength(1);
		await expect(page.getByTestId("toast")).toHaveCount(0);

		await chip(page, "full");
		await expect.poll(() => tap.commands("set_model")).toHaveLength(2);
		expect(tap.commands("set_model")[1]).toEqual(picked);
		await expect(page.getByTestId("model-picker")).toHaveText(label, { timeout: 60_000 });
	});

	test("your own model is kept when Light runs on your own models too", async ({ page }) => {
		await api({ mode: "full", lightModels: "yours", offline: { backend: "omlx", baseUrls: { ollama: null } } });
		const tap = await newChat(page);
		await pickOtherModel(page, tap);
		const picked = tap.commands("set_model")[0];
		// The model picker shows the pick once omp has answered; its label is read then.
		await expect(page.getByTestId("model-picker")).not.toContainText("Haiku 5.5");
		const label = await page.getByTestId("model-picker").innerText();

		await chip(page, "light");
		await expect.poll(() => tap.commands("set_model")).toHaveLength(2);
		expect(tap.commands("set_model")[1]).toEqual(picked);
		await expect(page.getByTestId("model-picker")).toHaveText(label, { timeout: 60_000 });
		await expect(page.getByTestId("toast")).toHaveCount(0);
	});
});

test.describe("presets", () => {
	let configFile: string;
	let original: string;
	test.beforeAll(() => {
		configFile = join(process.env.OMPW_E2E_AGENT_DIR as string, "config.yml");
		original = readFileSync(configFile, "utf8");
	});
	// A preset is omp's own: the config file is put back, so the other specs find the model the server started with.
	test.afterEach(() => writeFileSync(configFile, original));

	test("a preset chosen before the folder or options change is switched to again on the next process", async ({
		page,
		request,
	}) => {
		const csrf = { "x-omp-webui": "1" };
		const haiku = "anthropic/claude-haiku-5-5";
		await request.post("/api/model-config/preset/save", { headers: csrf, data: { name: "fast" } });
		await request.post("/api/model-config/preset/save", {
			headers: csrf,
			data: {
				name: "deep",
				roles: { default: "anthropic/claude-sonnet-5-5:high", smol: haiku, slow: haiku, tiny: haiku, commit: haiku },
				defaultThinkingLevel: "high",
			},
		});
		const tap = await newChat(page);
		await page.getByTestId("preset-picker").click();
		await page.getByTestId("preset-menu").locator('[data-preset="deep"]').click();
		await expect(page.getByTestId("model-picker")).toContainText("Sonnet 5.5", { timeout: 30_000 });

		await restartThroughOptions(page, tap, "kept");
		await expect(page.getByTestId("model-picker")).toContainText("Sonnet 5.5", { timeout: 60_000 });
		await expect(page.getByTestId("preset-picker")).toContainText("deep");
		expect(tap.sent.filter((m) => m.t === "model_preset").map((m) => m.name)).toEqual(["deep", "deep"]);
	});
});
