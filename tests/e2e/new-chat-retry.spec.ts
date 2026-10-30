import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { type StubOmlx, startStubOmlx } from "../support/stub-omlx.ts";
import { expect, test } from "./fixtures.ts";

/**
 * New chat starts omp for the folder in advance. When that start fails (a folder that is not there, a local backend
 * that does not answer) the footer says why and offers Retry, a start that failed on a setting is tried again when
 * the setting changes, and Send never claims omp "is still starting" while nothing is starting (#434). No model call.
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

test("a failed start shows its error in full with Retry; Send says why instead of 'still starting'; Retry recovers", async ({
	page,
}) => {
	const folder = join(process.env.OMPW_E2E_WORK as string, "not-yet");
	const tap = await tapSocket(page);
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), folder);
	await page.goto("/");
	const error = page.getByTestId("new-chat-error");
	await expect(error).toContainText(/does not exist/i);
	// The whole text is shown (wrapped), not cut to one line.
	await expect(error).toHaveCSS("white-space", "normal");
	const retry = page.getByRole("button", { name: "Retry" });
	await expect(retry).toBeVisible();
	expect(opens(tap)).toHaveLength(1);

	// Send during the failed state: the error is said, and it is not claimed that omp is starting.
	const composer = page.getByTestId("composer");
	await composer.fill("hello");
	await composer.press("Enter");
	await expect(page.getByTestId("toast").filter({ hasText: /does not exist/i })).toBeVisible();
	await expect(page.getByText("omp is still starting…")).toHaveCount(0);
	// The draft is kept, and Send tried to start omp again (it failed the same way: the folder is still not there).
	await expect(composer).toHaveValue("hello");
	await expect.poll(() => opens(tap).length).toBe(2);
	// The error is back only once that second start has failed: the folder is made after it, not under it.
	await expect(error).toBeVisible();

	// The folder appears; Retry starts omp.
	mkdirSync(folder, { recursive: true });
	await retry.click();
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
	await expect(error).toHaveCount(0);
	expect(opens(tap)).toHaveLength(3);
});

test.describe("a local backend that does not answer", () => {
	test.skip(Boolean(process.env.OMPW_E2E_OFFLINE), "the stub backend needs no login, but the online start does");
	let ollama: StubOmlx;
	test.beforeAll(async () => {
		ollama = await startStubOmlx({ models: ["stub-ollama-model"], apiKey: null, ollama: true });
	});
	test.afterAll(async () => {
		await api({ mode: "full", lightModels: "yours", offline: { backend: "omlx", baseUrls: { ollama: null } } });
		await ollama.stop();
	});

	test("the start is tried again by itself once the backend's address is fixed", async ({ page }) => {
		await api({
			mode: "light",
			lightModels: "local",
			offline: { backend: "ollama", baseUrls: { ollama: "http://127.0.0.1:1/v1" } },
		});
		const tap = await tapSocket(page);
		await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
		await page.goto("/");
		await expect(page.getByTestId("new-chat-error")).toBeVisible({ timeout: 30_000 });
		expect(opens(tap)).toHaveLength(1);

		// The address is fixed somewhere else (Settings, another tab): nothing in this page's folder or options changes.
		await api({ offline: { baseUrls: { ollama: ollama.url } } });
		await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
		await expect(page.getByTestId("new-chat-error")).toHaveCount(0);
		expect(opens(tap)).toHaveLength(2);
	});
});
