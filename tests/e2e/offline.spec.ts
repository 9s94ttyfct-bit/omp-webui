import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModeState } from "../../shared/offline.ts";
import { ownSession, sessionRow, startLive } from "../support/live.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { type StubOmlx, startStubOmlx } from "../support/stub-omlx.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * Full and Light mode (no model call: stubs stand in for oMLX, Ollama and LM Studio, and nothing here prompts): the
 * choice in Settings and in New chat's chip, Light's models (your own, or a local server's), the local server and what
 * Settings offers for Light, the badge on Light conversations, and the measured saving.
 */

let agentDir: string;
let base: string;
const stubMcp = join(import.meta.dirname, "..", "support", "stub-mcp.ts");
let modelsPath: string;
let mcpPath: string;

let omlx: StubOmlx;
/** Answers as Ollama does (no key, its own model list). */
let ollama: StubOmlx;
/** Answers as LM Studio does (no key; ids with a slash). */
let lmStudio: StubOmlx;
/** The user's models.yml: oMLX, and Ollama at an address nothing listens at. LM Studio has no entry at all. */
const modelsYml = (url: string) =>
	`providers:\n  omlx:\n    baseUrl: ${url}\n    api: openai-completions\n    apiKey: ${omlx.apiKey}\n    discovery:\n      type: openai-models-list\n  ollama:\n    baseUrl: http://127.0.0.1:1/v1\n`;
/** What the backend choice starts from and returns to. */
const NO_ADDRESSES = { omlx: null, ollama: null, "lm-studio": null };

/** The server's API, as the test server's own token allows (these specs also change what the next spec sees). */
function api(path: string, body?: unknown): Promise<Response> {
	return fetch(`${base}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			"x-omp-webui-token": String(process.env.OMPW_E2E_ACCESS_TOKEN),
			"x-omp-webui": "1",
			"content-type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
	agentDir = process.env.OMPW_E2E_AGENT_DIR as string;
	base = process.env.OMPW_E2E_URL as string;
	modelsPath = join(agentDir, "models.yml");
	mcpPath = join(agentDir, "mcp.json");
	omlx = await startStubOmlx({ models: ["stub-model", "stub-two"] });
	ollama = await startStubOmlx({ models: ["stub-ollama-model"], apiKey: null, ollama: true });
	lmStudio = await startStubOmlx({ models: ["stub/lm-model", "stub/lm-other"], apiKey: null });
	writeFileSync(modelsPath, modelsYml(omlx.url));
	writeFileSync(
		mcpPath,
		JSON.stringify({
			mcpServers: {
				rea: { type: "stdio", command: "bun", args: [stubMcp, "rea"] },
				other: { type: "stdio", command: "bun", args: [stubMcp, "other"] },
			},
		}),
	);
	await api("/api/mode", {
		mode: "full",
		lightModels: "local",
		offline: {
			backend: "omlx",
			baseUrls: NO_ADDRESSES,
			mcp: ["rea"],
			tools: ["read", "bash", "edit", "write", "grep", "glob", "todo"],
			skills: ["reverse-engineer-anything"],
			agentsMd: false,
			model: null,
			thinking: "medium",
		},
	});
});

test.afterAll(async () => {
	// What the next spec starts: Full on the person's own models, with the user's files as they were.
	await api("/api/mode", { mode: "full", lightModels: "yours" });
	rmSync(modelsPath, { force: true });
	rmSync(mcpPath, { force: true });
	await Promise.all([omlx.stop(), ollama.stop(), lmStudio.stop()]);
});

/** Choose the mode of new conversations in New chat's chip. */
const pick = async (page: Page, mode: "full" | "light") => {
	await page.getByTestId("mode-picker").click();
	await page.getByTestId(`mode-picker-${mode}`).click();
	await expect(page.getByTestId("mode-picker")).toHaveAttribute("data-mode", mode);
};
const setting = (page: Page, mode: "full" | "light") =>
	page.getByTestId("mode-settings").locator("label", { has: page.getByTestId(`mode-setting-${mode}`) });
const modelsSetting = (page: Page, models: "yours" | "local") =>
	page.getByTestId("mode-settings").locator("label", { has: page.getByTestId(`models-setting-${models}`) });

test("Settings › Full / Light: choosing Light is kept for every tab and for the next visit", async ({ page }) => {
	await page.goto("/#/settings/models");
	await expect(page.getByTestId("mode-settings")).toBeVisible();
	await expect(page.getByTestId("mode-setting-full")).toBeChecked();
	// Light's models are a local server's (beforeAll), so its options are there.
	await expect(page.getByTestId("models-setting-local")).toBeChecked();
	await expect(page.getByTestId("local-server-options")).toBeVisible();

	await setting(page, "light").click();
	await expect(page.getByTestId("mode-setting-light")).toBeChecked();
	// Choosing Light on a local server looks at oMLX right away.
	await expect(page.getByTestId("backend-models")).toContainText("serves 2 models");

	await page.reload();
	await expect(page.getByTestId("mode-setting-light")).toBeChecked();
	expect(await (await api("/api/mode")).json()).toMatchObject({ mode: "light", lightModels: "local" });
	// New chat's chip is the same choice.
	await page.goto("/");
	await expect(page.getByTestId("mode-picker")).toHaveAttribute("data-mode", "light");
});

test("Settings › Full / Light: Light's models are your own or a local server's, and the server's options show only for the latter", async ({
	page,
}) => {
	await page.goto("/#/settings/models");
	try {
		await expect(page.getByTestId("local-server-options")).toBeVisible();
		await modelsSetting(page, "yours").click();
		await expect(page.getByTestId("models-setting-yours")).toBeChecked();
		await expect(page.getByTestId("local-server-options")).toHaveCount(0);
		// What Light loads is the same whichever models it runs on.
		await expect(page.getByTestId("offline-options")).toBeVisible();
		await expect.poll(async () => (await (await api("/api/mode")).json()).lightModels).toBe("yours");

		await modelsSetting(page, "local").click();
		await expect(page.getByTestId("local-server-options")).toBeVisible();
		await expect(page.getByTestId("backend-models")).toContainText("serves 2 models");
		await expect.poll(async () => (await (await api("/api/mode")).json()).lightModels).toBe("local");
	} finally {
		await api("/api/mode", { lightModels: "local" });
	}
});

test("New chat's chip changes the mode, and another tab follows without a reload", async ({ page }) => {
	// Starts from Light, whatever ran before it in this file (or none did: a run of this test alone).
	await api("/api/mode", { mode: "light" });
	const other = await page.context().newPage();
	await other.goto("/#/settings/models");
	await expect(other.getByTestId("mode-setting-light")).toBeChecked();
	await page.goto("/");

	await pick(page, "full");
	await expect(other.getByTestId("mode-setting-full")).toBeChecked();
	await pick(page, "light");
	await expect(other.getByTestId("mode-setting-light")).toBeChecked();
	await other.close();
});

test("offline settings: model, thinking, MCP servers, tools, skills and AGENTS.md are kept as chosen", async ({
	page,
}) => {
	const offline = async () => ((await (await api("/api/mode")).json()) as { offline: Record<string, unknown> }).offline;
	await page.goto("/#/settings/models");
	await expect(page.getByTestId("backend-models")).toContainText("serves 2 models");

	await page.getByTestId("offline-model").selectOption("omlx/stub-two");
	await page.getByTestId("offline-thinking").selectOption("low");
	// The MCP servers are the ones in mcp.json; `rea` is on by default.
	await expect(page.getByTestId("offline-mcp-rea")).toBeChecked();
	await expect(page.getByTestId("offline-mcp-other")).not.toBeChecked();
	await page.getByTestId("offline-mcp-other").check();
	await page.getByTestId("offline-mcp-rea").uncheck();
	// Tools: the core set is on; ask is an extra.
	await expect(page.getByTestId("offline-tool-read")).toBeChecked();
	await expect(page.getByTestId("offline-tool-ask")).not.toBeChecked();
	await page.getByTestId("offline-tool-ask").check();
	await page.getByTestId("offline-tool-todo").uncheck();
	await page.getByTestId("offline-skills").fill("git-*, docker");
	await page.getByTestId("offline-skills").blur();
	await page.getByTestId("offline-agents-md").check();

	await expect.poll(offline).toEqual({
		backend: "omlx",
		baseUrls: NO_ADDRESSES,
		model: "omlx/stub-two",
		thinking: "low",
		mcp: ["other"],
		tools: ["read", "bash", "edit", "write", "grep", "glob", "ask"],
		skills: ["git-*", "docker"],
		agentsMd: true,
	});

	// Kept across a visit.
	await page.reload();
	await expect(page.getByTestId("offline-model")).toHaveValue("omlx/stub-two");
	await expect(page.getByTestId("offline-thinking")).toHaveValue("low");
	await expect(page.getByTestId("offline-mcp-other")).toBeChecked();
	await expect(page.getByTestId("offline-tool-ask")).toBeChecked();
	await expect(page.getByTestId("offline-tool-todo")).not.toBeChecked();
	await expect(page.getByTestId("offline-skills")).toHaveValue("git-*, docker");
	await expect(page.getByTestId("offline-agents-md")).toBeChecked();

	// No skills at all is a valid choice, and one tool stays whatever is clicked.
	await page.getByTestId("offline-skills").fill("");
	await page.getByTestId("offline-skills").blur();
	await expect.poll(async () => (await offline()).skills).toEqual([]);
	for (const tool of ["bash", "edit", "write", "grep", "ask"]) await page.getByTestId(`offline-tool-${tool}`).uncheck();
	await expect(page.getByTestId("offline-tool-glob")).toBeChecked();
	await page.getByTestId("offline-tool-glob").uncheck();
	await expect(page.getByTestId("offline-tool-read")).toBeChecked();
	await expect(page.getByTestId("offline-tool-read")).toBeDisabled();

	await api("/api/mode", {
		offline: {
			model: null,
			thinking: "medium",
			mcp: ["rea"],
			tools: ["read", "bash", "edit", "write", "grep", "glob", "todo"],
			skills: ["reverse-engineer-anything"],
			agentsMd: false,
		},
	});
});

test("an offline settings change shows in the other tabs at once, and what a tab saves next is made on top of it", async ({
	page,
}) => {
	const offline = async (): Promise<ModeState["offline"]> => {
		const mode: ModeState = await (await api("/api/mode")).json();
		return mode.offline;
	};
	// The list this test starts from, whatever an earlier test left (the file's tests share the server's settings).
	await api("/api/mode", { offline: { mcp: ["rea"] } });
	const other = await page.context().newPage();
	try {
		await page.goto("/#/settings/models");
		await other.goto("/#/settings/models");
		await expect(other.getByTestId("offline-mcp-other")).not.toBeChecked();
		await expect(other.getByTestId("offline-mcp-rea")).toBeChecked();

		await page.getByTestId("offline-mcp-other").check();
		await expect(other.getByTestId("offline-mcp-other")).toBeChecked();
		// A list is sent whole: this tab's is the one it was just shown, so the choice of the first tab is kept.
		await other.getByTestId("offline-mcp-rea").uncheck();
		await expect.poll(async () => (await offline()).mcp).toEqual(["other"]);
		await expect(page.getByTestId("offline-mcp-rea")).not.toBeChecked();
		await expect(page.getByTestId("offline-mcp-other")).toBeChecked();
	} finally {
		await other.close();
		await api("/api/mode", { offline: { mcp: ["rea"] } });
	}
});

test("a read of the mode that was made before another tab's change but arrives after its announcement does not put the old state back", async ({
	page,
}) => {
	// The page reads the mode when its socket connects, and again after its own save when another tab's announcement came
	// meanwhile. The server answers a read with the state of the moment it was handled, and announces a change on the
	// socket: the two travel on separate connections, so a read can arrive after an announcement that is newer than it.
	// Taking it then shows the old state (a stale checkbox) and builds the next save from it, undoing the other tab's
	// choice (#303). Here the read is held until the announcement has been shown.
	await api("/api/mode", { offline: { mcp: ["rea"] } });
	const tap = await tapSocket(page);
	await page.goto("/#/settings/models");
	await expect(page.getByTestId("offline-mcp-rea")).toBeChecked();
	await expect(page.getByTestId("offline-mcp-other")).not.toBeChecked();

	const { promise: gate, resolve: release } = Promise.withResolvers<void>();
	let read = 0;
	await page.route("**/api/mode", async (route) => {
		if (route.request().method() !== "GET") return route.continue();
		const answer = await route.fetch();
		read++;
		await gate;
		await route.fulfill({ response: answer });
	});
	try {
		// The page's socket reconnects, and the page reads the mode: this read is held with the state as it is now.
		tap.drop();
		await expect.poll(() => read, { timeout: 30_000 }).toBe(1);
		// Another tab changes the list; the announcement reaches the page on the new connection.
		await api("/api/mode", { offline: { mcp: ["other"] } });
		await expect(page.getByTestId("offline-mcp-other")).toBeChecked();
		await expect(page.getByTestId("offline-mcp-rea")).not.toBeChecked();
		// Now the older read arrives.
		const arrived = page.waitForResponse((r) => r.url().includes("/api/mode") && r.request().method() === "GET");
		release();
		await arrived;
		await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
		await expect(page.getByTestId("offline-mcp-other")).toBeChecked();
		await expect(page.getByTestId("offline-mcp-rea")).not.toBeChecked();
	} finally {
		release();
		await page.unroute("**/api/mode");
		await api("/api/mode", { offline: { mcp: ["rea"] } });
	}
});

test("Settings › Mode: a read handled before a save does not undo it while the save is out (#337)", async ({
	page,
}) => {
	// Choosing Ollama shows Ollama at once; the server's answer takes a while. A read of the mode that the server
	// handled before that save reaches the page meanwhile. It carries the old revision, which the page's own state (not
	// yet answered) also has, so it was taken: it put the old backend and its address back under what the user was
	// typing. The cleared address was then never saved, and the field ended on Ollama's old address.
	await api("/api/mode", {
		offline: { backend: "omlx", baseUrls: { ...NO_ADDRESSES, ollama: ollama.url }, model: null },
	});
	const tap = await tapSocket(page);
	await page.goto("/#/settings/models");
	const address = page.getByTestId("offline-base-url");
	await expect(address).toHaveValue(omlx.url);

	const { promise: readGate, resolve: releaseRead } = Promise.withResolvers<void>();
	const { promise: saveGate, resolve: releaseSave } = Promise.withResolvers<void>();
	const { promise: saveHandled, resolve: saveIsHandled } = Promise.withResolvers<void>();
	let reads = 0;
	let saves = 0;
	await page.route("**/api/mode", async (route) => {
		const method = route.request().method();
		if (method === "GET" && reads === 0) {
			reads++;
			const answer = await route.fetch();
			await readGate;
			return route.fulfill({ response: answer });
		}
		if (method === "POST" && ++saves === 1) {
			const answer = await route.fetch();
			saveIsHandled();
			await saveGate;
			return route.fulfill({ response: answer });
		}
		return route.continue();
	});
	try {
		// The page's socket reconnects and the page reads the mode: the server answers with oMLX, and the answer is held.
		tap.drop();
		await expect.poll(() => reads, { timeout: 30_000 }).toBe(1);
		await page
			.getByTestId("local-server-options")
			.locator("label", { has: page.getByTestId("offline-backend-ollama") })
			.click();
		await saveHandled;
		await expect(address).toHaveValue(ollama.url);
		await address.fill("");

		// Now the older read arrives, while the choice of Ollama is not answered.
		const arrived = page.waitForResponse((r) => r.url().includes("/api/mode") && r.request().method() === "GET");
		releaseRead();
		await arrived;
		await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
		await expect(page.getByTestId("offline-backend-ollama")).toBeChecked();
		await expect(address).toHaveValue("");
		await address.blur();
		releaseSave();

		await expect(page.getByTestId("offline-base-url-source")).toContainText(
			"From the Ollama provider in your models.yml",
		);
		await expect(address).toHaveValue("http://127.0.0.1:1/v1");
		await expect(page.getByTestId("offline-backend-ollama")).toBeChecked();
		await expect
			.poll(async () => (await (await api("/api/mode")).json()).offline)
			.toMatchObject({ backend: "ollama", baseUrls: { ollama: null } });
	} finally {
		releaseRead();
		releaseSave();
		await page.unroute("**/api/mode");
		await api("/api/mode", { offline: { backend: "omlx", baseUrls: NO_ADDRESSES, model: null } });
	}
});

test("Settings › Mode: a state that arrives while an address is being typed does not replace the text (#341)", async ({
	page,
}) => {
	await api("/api/mode", { offline: { backend: "omlx", baseUrls: NO_ADDRESSES, model: null } });
	const offline = async () => ((await (await api("/api/mode")).json()) as { offline: Record<string, unknown> }).offline;
	await page.goto("/#/settings/models");
	const address = page.getByTestId("offline-base-url");
	const source = page.getByTestId("offline-base-url-source");
	await expect(address).toHaveValue(omlx.url);
	try {
		await address.click();
		await address.fill("http://127.0.0.1:2/v1");
		// Another tab changes the same address meanwhile: the page shows its state (the hint says where the address is
		// from), but the text being typed stays.
		await api("/api/mode", { offline: { baseUrls: { omlx: lmStudio.url } } });
		await expect(source).toContainText("Set here");
		await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
		await expect(address).toHaveValue("http://127.0.0.1:2/v1");
		await expect(address).toBeFocused();
		// Left, it is saved as any edit is.
		await address.blur();
		await expect.poll(offline).toMatchObject({ baseUrls: { omlx: "http://127.0.0.1:2/v1" } });
		await expect(address).toHaveValue("http://127.0.0.1:2/v1");
	} finally {
		await api("/api/mode", { offline: { backend: "omlx", baseUrls: NO_ADDRESSES, model: null } });
	}
});

test("Settings › Mode: an address cleared right after choosing the backend is saved, not overwritten by the choice (#337)", async ({
	page,
}) => {
	// The field used to be reset to the chosen backend's address in an effect, after the page had drawn the choice. A
	// user who selects the text in between (here: select all, then delete a moment later) lost the edit: the reset
	// replaced the text under the selection, the delete found nothing selected, nothing differed on leaving the field,
	// and the old address stayed. Clearing it must go back to the address in models.yml.
	await api("/api/mode", {
		offline: { backend: "omlx", baseUrls: { ...NO_ADDRESSES, ollama: ollama.url }, model: null },
	});
	await page.addInitScript(() => {
		document.addEventListener("click", (e) => {
			if (!(e.target instanceof HTMLElement) || e.target.dataset.testid !== "offline-backend-ollama") return;
			const field = document.querySelector<HTMLInputElement>('[data-testid="offline-base-url"]');
			if (!field) return;
			field.focus();
			field.select();
			// The hand takes a moment to delete what it selected (a keystroke, a slow machine).
			setTimeout(() => document.execCommand("delete"), 100);
		});
	});
	await page.goto("/#/settings/models");
	const address = page.getByTestId("offline-base-url");
	await expect(address).toHaveValue(omlx.url);
	try {
		await page
			.getByTestId("local-server-options")
			.locator("label", { has: page.getByTestId("offline-backend-ollama") })
			.click();
		await expect(page.getByTestId("offline-backend-ollama")).toBeChecked();
		await expect(address).toHaveValue("");
		await address.blur();
		await expect(address).toHaveValue("http://127.0.0.1:1/v1");
		await expect(page.getByTestId("offline-base-url-source")).toContainText(
			"From the Ollama provider in your models.yml",
		);
		await expect
			.poll(async () => (await (await api("/api/mode")).json()).offline)
			.toMatchObject({ backend: "ollama", baseUrls: { ollama: null } });
	} finally {
		await api("/api/mode", { offline: { backend: "omlx", baseUrls: NO_ADDRESSES, model: null } });
	}
});

test("Settings › Mode: the local backend is oMLX, Ollama or LM Studio, each with its address, status and models", async ({
	page,
}) => {
	const offline = async () => ((await (await api("/api/mode")).json()) as { offline: Record<string, unknown> }).offline;
	// LM Studio's default address is where a real LM Studio may listen: it has the stub's before it is chosen.
	await api("/api/mode", { offline: { baseUrls: { "lm-studio": lmStudio.url } } });
	try {
		await page.goto("/#/settings/models");
		const options = page.getByTestId("local-server-options");
		const choose = (id: string) => options.locator("label", { has: page.getByTestId(`offline-backend-${id}`) }).click();
		const address = page.getByTestId("offline-base-url");
		const source = page.getByTestId("offline-base-url-source");
		const status = page.getByTestId("backend-models");
		const modelOptions = page.getByTestId("offline-model").getByRole("option");

		// oMLX is as it was: the address of its provider in models.yml, and its models.
		await expect(page.getByTestId("offline-backend-omlx")).toBeChecked();
		await expect(address).toHaveValue(omlx.url);
		await expect(source).toContainText("From the oMLX provider in your models.yml");
		await expect(status).toContainText(`oMLX at ${omlx.url} serves 2 models.`);
		await expect(modelOptions).toHaveText(["Automatic (the first model oMLX serves)", "stub-model", "stub-two"]);

		// Ollama: models.yml has an entry at an address nothing listens at, and the status says so.
		await choose("ollama");
		await expect(page.getByTestId("offline-backend-ollama")).toBeChecked();
		await expect(address).toHaveValue("http://127.0.0.1:1/v1");
		await expect(page.getByTestId("backend-error")).toContainText(
			"Ollama is not reachable at http://127.0.0.1:1/v1 (connection refused)",
		);
		await expect(modelOptions).toHaveText(["Automatic (the first model Ollama serves)"]);
		// The address of the server is all it takes.
		await address.fill(ollama.url);
		await address.blur();
		await expect(status).toContainText(`Ollama at ${ollama.url} serves 1 models.`);
		await expect(page.getByTestId("backend-error")).toHaveCount(0);
		await expect(source).toContainText("Set here");
		await page.getByTestId("offline-model").selectOption("ollama/stub-ollama-model");
		await expect
			.poll(offline)
			.toMatchObject({ backend: "ollama", model: "ollama/stub-ollama-model", baseUrls: { ollama: ollama.url } });

		// An address that is not one is refused, and the field shows what is kept.
		await address.fill("not an address");
		await address.blur();
		await expect(page.getByTestId("toast").filter({ hasText: "must be an address like" })).toBeVisible();
		await expect(address).toHaveValue(ollama.url);

		// LM Studio: no entry in models.yml needed; its model ids have slashes. Ollama's model is not kept for it.
		await choose("lm-studio");
		await expect(address).toHaveValue(lmStudio.url);
		await expect(status).toContainText(`LM Studio at ${lmStudio.url} serves 2 models.`);
		await expect(page.getByTestId("offline-model")).toHaveValue("");
		await page.getByTestId("offline-model").selectOption("lm-studio/stub/lm-other");
		await expect.poll(offline).toMatchObject({ backend: "lm-studio", model: "lm-studio/stub/lm-other" });
		await page.reload();
		await expect(page.getByTestId("offline-backend-lm-studio")).toBeChecked();
		await expect(page.getByTestId("offline-model")).toHaveValue("lm-studio/stub/lm-other");

		// Clearing an address goes back to the one in models.yml.
		await choose("ollama");
		await address.fill("");
		await address.blur();
		await expect(address).toHaveValue("http://127.0.0.1:1/v1");
		await expect(source).toContainText("From the Ollama provider in your models.yml");
		await expect.poll(offline).toMatchObject({ baseUrls: { ollama: null } });
	} finally {
		await api("/api/mode", { offline: { backend: "omlx", baseUrls: NO_ADDRESSES, model: null } });
	}
});

test("a new chat runs on the chosen backend, not on an unused process the old choice left behind", async ({ page }) => {
	await api("/api/mode", {
		mode: "light",
		offline: { backend: "omlx", baseUrls: { ...NO_ADDRESSES, ollama: ollama.url }, model: null },
	});
	try {
		await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
		await page.goto("/");
		const picker = page.getByTestId("model-picker");
		await expect(picker).toContainText("stub-model", { timeout: 60_000 });
		await page.getByTestId("mode-picker").click();
		await expect(page.getByTestId("mode-picker-light")).toContainText("on oMLX models");
		await page.keyboard.press("Escape");

		// Another backend is chosen while this chat's unused oMLX process is still there; the reloaded page must not take it.
		await api("/api/mode", { offline: { backend: "ollama" } });
		await page.reload();
		await expect(picker).toContainText("stub-ollama-model", { timeout: 60_000 });
		await page.getByTestId("mode-picker").click();
		await expect(page.getByTestId("mode-picker-light")).toContainText("on Ollama models");
		await page.keyboard.press("Escape");
		// What the model can be switched to is Ollama's list, nothing else.
		await picker.click();
		await expect(page.locator("[cmdk-list]").getByRole("option")).toHaveText([/stub-ollama-model/]);
	} finally {
		await api("/api/mode", { offline: { backend: "omlx", baseUrls: NO_ADDRESSES, model: null } });
	}
});

test("a new chat starts in the selected mode, again when the mode changes", async ({ page }) => {
	await api("/api/mode", { mode: "light" });
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	const picker = page.getByTestId("model-picker");
	// Light on a local server: oMLX's model. Full: the model of the user's own configuration.
	await expect(picker).toContainText("stub-model", { timeout: 60_000 });
	await pick(page, "full");
	await expect(picker).toContainText("Haiku 5.5", { timeout: 60_000 });
	await pick(page, "light");
	await expect(picker).toContainText("stub-model", { timeout: 60_000 });
	// What the model can be switched to is oMLX's list, nothing else.
	await picker.click();
	await expect(page.locator("[cmdk-list]").getByRole("option")).toHaveText([/stub-model/, /stub-two/]);
});

test("a Light conversation says so in its header and on its sidebar row, and keeps saying so when the mode changes", async ({
	page,
}) => {
	await api("/api/mode", { mode: "light" });
	const title = "Light probe";
	// A number no other spec uses: a conversation is reopened in the mode it last ran in, and another spec's Full run of a
	// shared one would bring this one back Full.
	ownSession(0xac, title);
	const tap = await tapSocket(page);
	await page.goto("/");
	await startLive(page, tap, title, "light-probe-1");
	const badge = page.getByTestId("mode-badge");
	await expect(badge).toBeVisible();
	await expect(badge).toHaveText("Light · local");
	await expect(badge).toHaveAttribute("data-models", "local");
	await expect(badge).toHaveAttribute("title", /local server's models/);
	const dot = sessionRow(page, title).locator('[role="img"]');
	await expect(dot).toHaveAttribute("title", "Open · Light mode");

	// The mode is for conversations to come: this one is still the Light process it was.
	await api("/api/mode", { mode: "full" });
	await expect(badge).toBeVisible();
	await expect(dot).toHaveAttribute("title", "Open · Light mode");
	await api("/api/mode", { mode: "light" });
});

test("oMLX not answering is said where the user is looking, and the way back is one click", async ({ page }) => {
	await api("/api/mode", { mode: "light" });
	writeFileSync(modelsPath, modelsYml("http://127.0.0.1:1/v1"));
	try {
		await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
		await page.goto("/");
		await expect(page.getByText(/oMLX is not reachable at http:\/\/127\.0\.0\.1:1\/v1/).first()).toBeVisible({
			timeout: 30_000,
		});
		await page.goto("/#/settings/models");
		await expect(page.getByTestId("backend-error")).toContainText("connection refused");
		// The way back is one click, in New chat itself: the chip stays beside the error.
		await page.goto("/");
		await expect(page.getByTestId("new-chat-error")).toBeVisible({ timeout: 30_000 });
		await expect(page.getByTestId("mode-picker")).toHaveAttribute("data-mode", "light");
		await pick(page, "full");
		await expect(page.getByTestId("model-picker")).toContainText("Haiku 5.5", { timeout: 60_000 });
		await expect(page.getByTestId("new-chat-error")).toHaveCount(0);
		// And Light again: the error is back, with the chip.
		await pick(page, "light");
		await expect(page.getByTestId("new-chat-error")).toBeVisible({ timeout: 30_000 });
	} finally {
		writeFileSync(modelsPath, modelsYml(omlx.url));
	}
});

test("Settings shows what Light saves, measured with omp's /context", async ({ page }) => {
	await page.goto("/#/settings/models");
	const summary = page.getByTestId("context-summary");
	await expect(summary).toContainText(/Light starts a conversation with [\d.]+K? tokens/, { timeout: 120_000 });
	await expect(summary).toContainText(/: \d+% less\./);
	await expect(page.getByTestId("context-table")).toContainText("Tool definitions");
	await expect(page.getByTestId("context-table").getByRole("columnheader")).toHaveText([
		"What fills the context window",
		"Full",
		"Light",
	]);
	const total = async (side: "full" | "light") =>
		Number.parseFloat((await page.getByTestId(`context-total-${side}`).innerText()).replace("K", "")) *
		((await page.getByTestId(`context-total-${side}`).innerText()).endsWith("K") ? 1000 : 1);
	expect(await total("light")).toBeLessThan(await total("full"));

	// A change of the selection measures Light again; Measure again measures both.
	await page.getByTestId("offline-tool-todo").uncheck();
	await expect(page.getByTestId("context-measuring")).toBeVisible();
	await expect(page.getByTestId("context-measuring")).toBeHidden({ timeout: 120_000 });
	await page.getByTestId("context-remeasure").click();
	await expect(page.getByTestId("context-measuring")).toBeVisible();
	await expect(page.getByTestId("context-measuring")).toBeHidden({ timeout: 120_000 });
	await expect(summary).toBeVisible();
	await page.getByTestId("offline-tool-todo").check();
});

/** Run `body` with mcp.json lacking `rea`, which Light has selected; mcp.json and the selection are put back. */
async function withoutRea(body: () => Promise<void>): Promise<void> {
	const original = readFileSync(mcpPath, "utf8");
	writeFileSync(
		mcpPath,
		JSON.stringify({ mcpServers: { other: { type: "stdio", command: "bun", args: [stubMcp, "other"] } } }),
	);
	try {
		await body();
	} finally {
		writeFileSync(mcpPath, original);
		await api("/api/mode", { offline: { mcp: ["rea"] } });
	}
}

test("a Light conversation on a local server has no presets: the picker is disabled with a note, the shortcut does nothing, nothing is sent", async ({
	page,
}) => {
	const tap = await tapSocket(page);
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	await pick(page, "light");
	await expect(page.getByTestId("model-picker")).toContainText("stub-model", { timeout: 60_000 });
	const picker = page.getByTestId("preset-picker");
	await expect(picker).toBeDisabled();
	await expect(picker).toHaveAttribute("title", /Presets apply to conversations on your own models/);
	await expect(
		page.getByRole("button", { name: /^Model presets: Presets apply to conversations on your own/ }),
	).toBeVisible();

	// In Full, the same keys would say there is nothing to switch to; here they do nothing at all.
	await page.keyboard.press("ControlOrMeta+Shift+M");
	await page.waitForTimeout(500);
	await expect(page.getByTestId("toast").filter({ hasText: "No presets" })).toHaveCount(0);
	expect(tap.commands("prompt")).toEqual([]);

	// The menu is there in Full.
	await pick(page, "full");
	await expect(page.getByTestId("preset-picker")).toBeEnabled({ timeout: 60_000 });
	await page.keyboard.press("ControlOrMeta+Shift+M");
	await expect(page.getByTestId("toast").filter({ hasText: "No presets" })).toBeVisible();
	await pick(page, "light");
});

test("Settings say that model roles and presets are for your own models while Light on a local server is selected", async ({
	page,
}) => {
	await page.goto("/#/settings/models");
	await setting(page, "light").click();
	const note = page.getByTestId("presets-local-note");
	await expect(note).toContainText("Model roles and presets apply to your own models");
	await setting(page, "full").click();
	await expect(note).toHaveCount(0);
	await setting(page, "light").click();
	await expect(note).toBeVisible();
});

test("selected MCP servers that mcp.json no longer has are listed in Settings, and choosing Light warns once", async ({
	page,
}) => {
	await withoutRea(async () => {
		await page.goto("/#/settings/models");
		await setting(page, "full").click();
		const missing = page.getByTestId("offline-mcp-missing");
		await expect(missing).toContainText("Not in mcp.json: rea");
		await expect(page.getByTestId("offline-mcp-rea")).toHaveCount(0);

		await setting(page, "light").click();
		await expect(page.getByTestId("toast").filter({ hasText: "not in your mcp.json: rea" })).toHaveCount(1);

		// A name that is gone for good can be taken off the list.
		await page.getByTestId("offline-mcp-forget").click();
		await expect(missing).toHaveCount(0);
		await expect
			.poll(async () => ((await (await api("/api/mode")).json()) as { offline: { mcp: string[] } }).offline.mcp)
			.toEqual([]);
	});
});

test("New chat does not offer model-selecting flags in Light on a local server, and does not send ones typed in Full", async ({
	page,
}) => {
	const tap = await tapSocket(page);
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	await pick(page, "full");
	await page.getByRole("button", { name: /^Options/ }).click();
	const form = page.getByTestId("flag-form");
	const flag = (name: string) => form.locator(`[data-flag="${name}"]`);
	await expect(flag("--model")).toBeVisible();
	await flag("--model").fill("anthropic/claude-haiku-5-5");
	// A value is applied when the field is committed (Enter or leaving it), not per keystroke (#436).
	await flag("--model").press("Enter");
	const opened = () => tap.sent.findLast((m) => m.t === "open")?.target;
	await expect.poll(() => opened()?.args).toEqual(["--model=anthropic/claude-haiku-5-5"]);

	await pick(page, "light");
	for (const name of ["--model", "--smol", "--slow", "--plan", "--models", "--provider"]) {
		await expect(flag(name)).toHaveCount(0);
	}
	await expect(flag("--thinking")).toBeVisible();
	await expect.poll(() => opened()?.args).toEqual([]);

	// Back in Full, what was typed is there again.
	await pick(page, "full");
	await expect(flag("--model")).toHaveValue("anthropic/claude-haiku-5-5");
	await pick(page, "light");
});

test("Settings warns when a backend's address is neither on this computer nor on its network, and refuses link-local ones", async ({
	page,
}) => {
	// A name that never resolves (the reserved .invalid): the check Settings makes of the address sends nothing anywhere.
	const stranger = "https://models.example.invalid/v1";
	try {
		await page.goto("/#/settings/models");
		const address = page.getByTestId("offline-base-url");
		const warning = page.getByTestId("offline-base-url-public");
		await expect(address).toHaveValue(omlx.url);
		await expect(warning).toHaveCount(0);

		await address.fill(stranger);
		await address.blur();
		await expect(warning).toBeVisible();
		await expect(warning).toContainText("models.example.invalid is not on this computer or your local network");
		await expect(warning).toContainText(
			"An API key from models.yml goes along only if models.yml gives this address too",
		);
		const shownAddress = async (): Promise<string | null> => {
			const mode: ModeState = await (await api("/api/mode")).json();
			return mode.backends.omlx.baseUrl;
		};
		await expect.poll(shownAddress).toBe(stranger);

		// Back on this computer by another name: nothing to warn about.
		await address.fill(omlx.url.replace("127.0.0.1", "localhost"));
		await address.blur();
		await expect(warning).toHaveCount(0);
		await expect(page.getByTestId("backend-models")).toContainText("serves 2 models");

		// Where cloud metadata services answer is no place for a model server: refused, and the field shows what is kept.
		const kept = await address.inputValue();
		await address.fill("http://169.254.169.254/v1");
		await address.blur();
		await expect(page.getByTestId("toast").filter({ hasText: "link-local address" })).toBeVisible();
		await expect(address).toHaveValue(kept);
		await expect(warning).toHaveCount(0);
	} finally {
		await api("/api/mode", { offline: { baseUrls: NO_ADDRESSES } });
	}
});

test.describe("in Chinese", () => {
	test.use({ locale: "zh-CN" });
	test("the chip and the Settings section are in zh-CN", async ({ page }) => {
		await page.goto("/#/settings/models");
		await expect(
			page.getByTestId("mode-settings").getByRole("heading", { name: "完整 / 轻量", exact: true }),
		).toBeVisible();
		await expect(page.getByTestId("mode-setting-full").locator("..")).toContainText("完整");
		await expect(page.getByTestId("mode-setting-light").locator("..")).toContainText("轻量");
		await expect(page.getByTestId("local-server-options")).toContainText("oMLX 模型");
		await expect(page.getByTestId("local-server-options")).toContainText("本地模型服务器");
		await expect(page.getByTestId("local-server-options")).toContainText("oMLX 地址");
		await page.goto("/");
		await expect(page.getByTestId("mode-picker")).toContainText(/完整|轻量/);
	});

	test("a selected MCP server that mcp.json no longer has is named in zh-CN too", async ({ page }) => {
		await withoutRea(async () => {
			await page.goto("/#/settings/models");
			await expect(page.getByTestId("offline-mcp-missing")).toContainText("不在 mcp.json 中：rea");
		});
	});

	test("the warning about an address beyond the local network is in zh-CN too", async ({ page }) => {
		try {
			await page.goto("/#/settings/models");
			const address = page.getByTestId("offline-base-url");
			await address.fill("https://models.example.invalid/v1");
			await address.blur();
			await expect(page.getByTestId("offline-base-url-public")).toContainText(
				"models.example.invalid 不在本机，也不在你的局域网内",
			);
		} finally {
			await api("/api/mode", { offline: { baseUrls: NO_ADDRESSES } });
		}
	});
});
