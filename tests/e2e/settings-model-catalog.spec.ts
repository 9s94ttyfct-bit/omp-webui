import { type StubOmlx, startStubOmlx } from "../support/stub-omlx.ts";
import { expect, test } from "./fixtures.ts";

/**
 * Settings › Model roles edits omp's own roles, which name the person's own models: its model chooser lists omp's models
 * while Light on a local server is selected, not the ones the local backend serves (#441). A stub stands in for Ollama;
 * no model is called.
 */

let ollama: StubOmlx;
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

test.skip(Boolean(process.env.OMPW_E2E_OFFLINE), "omp lists the models of the providers it is signed in to");
test.beforeAll(async () => {
	ollama = await startStubOmlx({ models: ["stub-ollama-model"], apiKey: null, ollama: true });
});
test.afterAll(async () => {
	await api({ mode: "full", lightModels: "yours", offline: { backend: "omlx", baseUrls: { ollama: null } } });
	await ollama.stop();
});

test("the role's model chooser lists omp's models while Light on a local server is selected, and the backend's are not in it", async ({
	page,
}) => {
	await api({
		mode: "light",
		lightModels: "local",
		offline: { backend: "ollama", baseUrls: { ollama: ollama.url } },
	});
	await page.goto("/#/settings/models");
	await expect(page.getByTestId("presets-local-note")).toBeVisible();
	await page.getByTestId("role-model").first().click();
	const options = page.locator("[cmdk-list]").getByRole("option");
	await expect(options.filter({ hasText: "Claude Haiku 5.5" })).toBeVisible();
	await expect(options.filter({ hasText: "stub-ollama-model" })).toHaveCount(0);
});
