import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures.ts";

/**
 * A models.yml that cannot be parsed fails every local backend, Ollama's too (which needs no entry in it). Settings
 * › Full / Light says that, with the parse error, instead of telling an Ollama user that Light on a local server needs
 * an oMLX provider (#444). No chat is started and no model is called.
 */

let modelsPath: string;
const api = (path: string, body: unknown) =>
	fetch(`${process.env.OMPW_E2E_URL}${path}`, {
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
	// Full stays the mode: the local server's settings are kept and shown, and Light is not chosen.
	await api("/api/mode", { mode: "full", lightModels: "local" });
});
test.afterAll(async () => {
	rmSync(modelsPath, { force: true });
	await api("/api/mode", { mode: "full", lightModels: "yours", offline: { backend: "omlx" } });
});

test("Settings › Full / Light: an unreadable models.yml is named as the reason, for Ollama as for oMLX", async ({
	page,
}) => {
	writeFileSync(modelsPath, "providers:\n  ollama: {baseUrl: [\n");
	await page.goto("/#/settings/models");
	const section = page.getByTestId("mode-settings");
	const missing = page.getByTestId("backend-missing");
	for (const backend of ["ollama", "omlx"]) {
		await section.locator("label", { has: page.getByTestId(`offline-backend-${backend}`) }).click();
		await expect(missing).toContainText(`${modelsPath} could not be read`);
		await expect(missing).toContainText("YAML Parse error");
		await expect(missing).not.toContainText("needs a provider");
	}

	// Fixed, the address of Ollama is back and the warning is gone.
	writeFileSync(modelsPath, "providers:\n  ollama:\n    baseUrl: http://127.0.0.1:1/v1\n");
	await page.reload();
	await section.locator("label", { has: page.getByTestId("offline-backend-ollama") }).click();
	await expect(page.getByTestId("offline-base-url")).toHaveValue("http://127.0.0.1:1/v1");
	await expect(missing).toHaveCount(0);
});

test("Settings › Full / Light: without an oMLX provider in a readable models.yml the hint stays the oMLX one", async ({
	page,
}) => {
	writeFileSync(modelsPath, "providers:\n  other:\n    baseUrl: http://127.0.0.1:9/v1\n");
	await page.goto("/#/settings/models");
	await page
		.getByTestId("mode-settings")
		.locator("label", { has: page.getByTestId("offline-backend-omlx") })
		.click();
	await expect(page.getByTestId("backend-missing")).toContainText("needs a provider");
	await expect(page.getByTestId("backend-missing")).not.toContainText("could not be read");
});
