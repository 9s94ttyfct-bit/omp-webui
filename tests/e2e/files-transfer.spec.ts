import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { writeChatSession } from "../support/chat-session.ts";
import { makeFilesProject } from "../support/files-project.ts";
import { openSidebar } from "../support/live.ts";
import { writeLongFakeOmp } from "../support/long-fake-omp-bin.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { boxOf } from "../support/style.ts";
import { removeTrackedTempDirs, tempDir } from "../support/temp-dirs.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * Moving files between a page and the computer the server runs on (#614, step two), from the Files tab: downloading a file
 * and a folder's ZIP, uploading files and folders by the pickers and by dropping them, the progress and the cancelling, the
 * question about files that are there, what a refusal says, and who is offered what (`/api/meta.fileTransfer`). The page here
 * is on the computer the server runs on (`full`); the other settings are put in `/api/meta` by the test. No model call.
 */

let s: TestServer;
let binDir: string;
let root: string;
let proj: string;
const TITLE = "File transfer conversation";

test.beforeAll(async () => {
	binDir = tempDir("ompw-transfer-bin-");
	s = await startTestServer(0, { OMP_BIN: writeLongFakeOmp(binDir) }, { login: false });
	root = realpathSync(s.work);
	proj = makeFilesProject(root);
	const put = (rel: string, text: string) => {
		const path = join(proj, rel);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, text);
	};
	// Hidden by default in the tree, and reachable by path.
	put("dist/out.js", "console.log('built');\n");
	// Folders that uploads go into, one for each thing a test does to them.
	for (const dir of ["landing", "drop-target", "conflict-keep", "conflict-replace", "conflict-skip", "cancelled"])
		mkdirSync(join(proj, dir), { recursive: true });
	for (const dir of ["conflict-keep", "conflict-replace", "conflict-skip"]) put(`${dir}/a.txt`, "old");
	writeChatSession(s.agentDir, { n: 0x91, title: TITLE, cwd: proj, turns: [{ prompt: "hello", reply: "hi" }] });
});
test.afterAll(async () => {
	await s?.stop();
	removeTrackedTempDirs();
});
test.afterEach(async ({ page }) => {
	await page.unrouteAll({ behavior: "wait" });
});

const row = (page: Page, path: string) => page.locator(`[data-testid="file-row"][data-path="${path}"]`);
const panel = (page: Page) => page.getByTestId("right-panel");
const body = (path: string) => readFileSync(join(proj, path), "utf8");

async function openFiles(page: Page): Promise<void> {
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	await page.goto(`${s.url}/?token=${s.accessToken}`);
	const item = page.locator('[data-testid="session-item"]', { hasText: TITLE });
	await expect(item).toHaveCount(1, { timeout: 30_000 });
	await item.click();
	await expect(page.getByTestId("composer")).toBeVisible();
	await page.getByTestId("toggle-panel").click();
	await panel(page)
		.getByTestId("panel-pane-bottom")
		.getByRole("tab", { name: /^Files|^文件/ })
		.click();
	await expect(page.getByTestId("files-pane")).toBeVisible();
	await expect(row(page, "src")).toBeVisible();
}

/** Say what `/api/meta` tells this page about file transfer (a server of an earlier version tells nothing). */
async function setting(page: Page, value: "off" | "download" | "full" | "omitted"): Promise<void> {
	await page.route("**/api/meta", async (route) => {
		const response = await route.fetch();
		const meta = (await response.json()) as Record<string, unknown>;
		if (value === "omitted") delete meta.fileTransfer;
		else meta.fileTransfer = value;
		await route.fulfill({ response, json: meta });
	});
}

const openTransfer = async (page: Page) => {
	await page.getByTestId("files-transfer").click();
	await expect(page.getByTestId("transfer-panel")).toBeVisible();
};

interface Dropped {
	name: string;
	text?: string;
	size?: number;
}

/**
 * Drop files on `target` the way a browser does for a drag from the Finder: dragenter, dragover, drop, with a `DataTransfer`
 * that holds `File`s. `stopAfterOver` leaves the drag over the target (to look at what it shows).
 */
async function drop(page: Page, target: string, files: Dropped[], stopAfterOver = false): Promise<void> {
	await page.evaluate(
		({ selector, list, stop }) => {
			const el = document.querySelector(selector);
			if (!el) throw new Error(`nothing at ${selector}`);
			const data = new DataTransfer();
			for (const f of list) {
				const content = f.size !== undefined ? new Uint8Array(f.size) : (f.text ?? "");
				data.items.add(new File([content], f.name));
			}
			const fire = (type: string) =>
				el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
			fire("dragenter");
			fire("dragover");
			if (!stop) fire("drop");
		},
		{ selector: target, list: files, stop: stopAfterOver },
	);
}

const pane = '[data-testid="files-pane"]';
const rowSel = (path: string) => `[data-testid="file-row"][data-path="${path}"]`;
const rows = (page: Page) => page.getByTestId("transfer-row");
const finished = (page: Page, count: number) =>
	expect(page.locator('[data-testid="transfer-row"][data-state="done"]')).toHaveCount(count);

test.describe("who is offered what", () => {
	test("a page on this computer has the Transfer button, a Download button on a file, and the upload actions", async ({
		page,
	}) => {
		await openFiles(page);
		await openTransfer(page);
		await expect(page.getByTestId("transfer-upload-files")).toBeVisible();
		await expect(page.getByTestId("transfer-upload-folder")).toBeVisible();
		await expect(page.getByTestId("transfer-zip")).toBeVisible();
		await expect(page.getByTestId("transfer-path")).toBeVisible();
		await page.keyboard.press("Escape");
		await row(page, "README.md").click();
		await expect(page.getByTestId("file-download")).toBeVisible();
	});

	test("download only: the downloads are offered, the uploads are not, and a drop is left alone", async ({ page }) => {
		await setting(page, "download");
		await openFiles(page);
		await openTransfer(page);
		await expect(page.getByTestId("transfer-zip")).toBeVisible();
		await expect(page.getByTestId("transfer-path")).toBeVisible();
		await expect(page.getByTestId("transfer-upload-files")).toHaveCount(0);
		await expect(page.getByTestId("transfer-upload-folder")).toHaveCount(0);
		await expect(page.getByTestId("transfer-input-files")).toHaveCount(0);
		await page.keyboard.press("Escape");
		let uploads = 0;
		page.on("request", (r) => {
			if (r.url().includes("/api/folder/upload")) uploads++;
		});
		await drop(page, pane, [{ name: "ignored.txt", text: "x" }]);
		await expect(page.getByTestId("transfer-drop-hint")).toHaveCount(0);
		expect(uploads).toBe(0);
		expect(existsSync(join(proj, "ignored.txt"))).toBe(false);
		await row(page, "README.md").click();
		await expect(page.getByTestId("file-download")).toBeVisible();
	});

	test("off, and a server that says nothing: no Transfer button and no Download button", async ({ page }) => {
		for (const value of ["off", "omitted"] as const) {
			await page.unrouteAll({ behavior: "wait" });
			await setting(page, value);
			await openFiles(page);
			await expect(page.getByTestId("files-refresh")).toBeVisible();
			await expect(page.getByTestId("files-transfer"), value).toHaveCount(0);
			await row(page, "README.md").click();
			await expect(page.getByTestId("file-preview")).toBeVisible();
			await expect(page.getByTestId("file-download"), value).toHaveCount(0);
		}
	});

	test("the transfer code is not fetched until it is needed", async ({ page }) => {
		const chunks: string[] = [];
		page.on("request", (r) => {
			const path = new URL(r.url()).pathname;
			if (/TransferPanel-.*\.js$/.test(path)) chunks.push(path);
		});
		await openFiles(page);
		await page.waitForLoadState("networkidle");
		expect(chunks).toEqual([]);
		await page.getByTestId("files-transfer").hover();
		await expect.poll(() => chunks.length).toBe(1);
	});
});

/** Answer every `HEAD` before a download with a refusal: no body, the code in `x-omp-webui-error` (403). */
async function refuseDownloads(page: Page, code: string): Promise<void> {
	await page.route("**/api/folder/download?**", (route) =>
		route.request().method() === "HEAD"
			? route.fulfill({ status: 403, headers: { "x-omp-webui-error": code } })
			: route.continue(),
	);
}

test.describe("downloading", () => {
	test("a file from its preview is saved with its own bytes, a binary one too", async ({ page }) => {
		await openFiles(page);
		for (const name of ["README.md", "data.bin"]) {
			await row(page, name).click();
			await expect(page.getByTestId("file-preview")).toBeVisible();
			const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("file-download").click()]);
			expect(download.suggestedFilename()).toBe(name);
			const saved = readFileSync((await download.path()) as string);
			expect(saved.equals(readFileSync(join(proj, name)))).toBe(true);
			await page.getByTestId("file-back").click();
			await expect(row(page, name)).toBeVisible();
		}
	});

	test("a folder is a ZIP: what it holds is said first, secrets and hidden things are left out, and the ZIP has the rest", async ({
		page,
	}) => {
		await openFiles(page);
		await openTransfer(page);
		await page.getByTestId("transfer-zip").click();
		const plan = page.getByTestId("transfer-plan");
		await expect(plan).toBeVisible();
		await expect(page.getByTestId("transfer-plan-summary")).toContainText("proj.zip");
		await expect(page.getByTestId("transfer-plan-summary")).toContainText(/\d+ files/);
		// .env looks like a secret, node_modules and the dotfiles are hidden.
		await expect(page.getByTestId("transfer-plan-left-out")).toContainText("secret");
		await expect(page.getByTestId("transfer-plan-left-out")).toContainText("hidden");
		const [download] = await Promise.all([
			page.waitForEvent("download"),
			page.getByTestId("transfer-plan-download").click(),
		]);
		expect(download.suggestedFilename()).toBe("proj.zip");
		const names = execFileSync("unzip", ["-Z1", (await download.path()) as string], { encoding: "utf8" })
			.split("\n")
			.filter(Boolean);
		expect(names).toContain("proj/src/app.ts");
		expect(names).toContain("proj/README.md");
		expect(names.some((n) => n.endsWith(".env"))).toBe(false);
		expect(names.some((n) => n.includes("node_modules"))).toBe(false);
		await expect(plan).toHaveCount(0);
	});

	test("the checkbox asks for the hidden files too, and the plan is made again", async ({ page }) => {
		await openFiles(page);
		await openTransfer(page);
		await page.getByTestId("transfer-zip").click();
		const hidden = page.getByTestId("transfer-plan-hidden");
		await expect(hidden).toBeEnabled();
		await expect(hidden).not.toBeChecked();
		const before = await page.getByTestId("transfer-plan-summary").innerText();
		await hidden.click();
		await expect(page.getByTestId("transfer-plan-hidden")).toBeChecked();
		await expect.poll(() => page.getByTestId("transfer-plan-summary").innerText()).not.toBe(before);
		const [download] = await Promise.all([
			page.waitForEvent("download"),
			page.getByTestId("transfer-plan-download").click(),
		]);
		const names = execFileSync("unzip", ["-Z1", (await download.path()) as string], { encoding: "utf8" });
		expect(names).toContain("proj/node_modules/dep/index.js");
	});

	test("by path: a folder the tree hides is a ZIP, and a file is a file", async ({ page }) => {
		await openFiles(page);
		await openTransfer(page);
		await page.getByTestId("transfer-path").fill("dist");
		await page.getByTestId("transfer-path-go").click();
		await expect(page.getByTestId("transfer-plan-summary")).toContainText("dist.zip");
		const [zip] = await Promise.all([
			page.waitForEvent("download"),
			page.getByTestId("transfer-plan-download").click(),
		]);
		expect(execFileSync("unzip", ["-Z1", (await zip.path()) as string], { encoding: "utf8" })).toContain("out.js");

		await page.getByTestId("transfer-path").fill("dist/out.js");
		const [file] = await Promise.all([page.waitForEvent("download"), page.getByTestId("transfer-path-go").click()]);
		expect(file.suggestedFilename()).toBe("out.js");
		expect(readFileSync((await file.path()) as string, "utf8")).toBe(body("dist/out.js"));
	});

	test("a refusal is said in words before anything is saved, and a path that leaves the folder is not even sent", async ({
		page,
	}) => {
		let downloads = 0;
		page.on("download", () => downloads++);
		await openFiles(page);
		await openTransfer(page);
		// The server holds a remote page back from what looks like a secret; this page is on the computer, so the answer is made
		// up here: no body, the code in the header (what a refused HEAD looks like).
		await refuseDownloads(page, "secret");
		await page.getByTestId("transfer-path").fill(".env");
		await page.getByTestId("transfer-path-go").click();
		await expect(page.getByTestId("transfer-error")).toContainText("looks like a secret");
		expect(downloads).toBe(0);
		await page.unrouteAll({ behavior: "wait" });

		// A file that is not there is the server's own refusal.
		await page.getByTestId("transfer-path").fill("not-here.txt");
		await page.getByTestId("transfer-path-go").click();
		await expect(page.getByTestId("transfer-error")).toContainText("It is not there");
		expect(downloads).toBe(0);

		let requests = 0;
		page.on("request", (r) => {
			if (r.url().includes("/api/folder/download") || r.url().includes("/api/folder/archive")) requests++;
		});
		await page.getByTestId("transfer-path").fill("../secret.txt");
		await page.getByTestId("transfer-path-go").click();
		await expect(page.getByTestId("transfer-error")).toBeVisible();
		expect(requests).toBe(0);
		expect(downloads).toBe(0);
	});
});

test.describe("uploading", () => {
	test("by the file picker: into the folder that is picked in the tree", async ({ page }) => {
		await openFiles(page);
		await row(page, "landing").click();
		await openTransfer(page);
		await expect(page.getByTestId("transfer-target")).toHaveText("landing");
		await page.getByTestId("transfer-input-files").setInputFiles([
			{ name: "one.txt", mimeType: "text/plain", buffer: Buffer.from("first") },
			{ name: "two.bin", mimeType: "application/octet-stream", buffer: Buffer.from([0, 1, 2, 255]) },
		]);
		await finished(page, 2);
		expect(body("landing/one.txt")).toBe("first");
		expect([...readFileSync(join(proj, "landing/two.bin"))]).toEqual([0, 1, 2, 255]);
		await expect(page.getByTestId("transfer-overall")).toContainText("2 of 2 files sent");
		await expect(page.getByTestId("toast")).toContainText("2 files uploaded");
		// What was sent is in the tree.
		await page.keyboard.press("Escape");
		await expect(row(page, "landing/one.txt")).toBeVisible();
	});

	test("with no folder picked it goes into the conversation's own folder", async ({ page }) => {
		await openFiles(page);
		await openTransfer(page);
		await expect(page.getByTestId("transfer-target")).toHaveText("The conversation's folder");
		await page.getByTestId("transfer-input-files").setInputFiles({
			name: "top.txt",
			mimeType: "text/plain",
			buffer: Buffer.from("at the top"),
		});
		await finished(page, 1);
		expect(body("top.txt")).toBe("at the top");
	});

	test("a folder by the folder picker: its files keep their folders, and what is hidden is left out and counted", async ({
		page,
	}) => {
		const picked = tempDir("ompw-transfer-pick-");
		const make = (rel: string, text: string) => {
			mkdirSync(join(picked, rel, ".."), { recursive: true });
			writeFileSync(join(picked, rel), text);
		};
		make("a.txt", "A");
		make("sub/b.txt", "B");
		make(".hidden", "no");
		make("node_modules/x.js", "no");
		await openFiles(page);
		await openTransfer(page);
		await page.getByTestId("transfer-input-folder").setInputFiles(picked);
		await finished(page, 2);
		const name = picked.slice(picked.lastIndexOf("/") + 1);
		expect(body(`${name}/a.txt`)).toBe("A");
		expect(body(`${name}/sub/b.txt`)).toBe("B");
		expect(existsSync(join(proj, name, ".hidden"))).toBe(false);
		expect(existsSync(join(proj, name, "node_modules"))).toBe(false);
		await expect(page.getByTestId("transfer-notes")).toContainText("2 hidden items left out");
	});

	test("a drop on the tab uploads, a drop on a folder row goes into that folder, and the row is marked while the drag is over it", async ({
		page,
	}) => {
		await openFiles(page);
		await drop(page, rowSel("drop-target"), [{ name: "dropped.txt", text: "by a drop" }], true);
		await expect(page.locator(rowSel("drop-target"))).toHaveAttribute("data-drop-target", "");
		await expect(page.getByTestId("transfer-drop-hint")).toContainText("drop-target");
		// The drag leaves, and the row is not marked any more.
		await page.evaluate((selector) => {
			document.querySelector(selector)?.dispatchEvent(new DragEvent("dragleave", { bubbles: true, cancelable: true }));
		}, pane);
		await drop(page, rowSel("drop-target"), [{ name: "dropped.txt", text: "by a drop" }]);
		await expect(page.getByTestId("transfer-panel")).toBeVisible();
		await finished(page, 1);
		expect(body("drop-target/dropped.txt")).toBe("by a drop");
		await page.keyboard.press("Escape");
		await drop(page, pane, [{ name: "loose-drop.txt", text: "on the pane" }]);
		await expect(page.getByTestId("transfer-row").filter({ hasText: "loose-drop.txt" })).toHaveAttribute(
			"data-state",
			"done",
		);
		expect(body("loose-drop.txt")).toBe("on the pane");
	});

	test("a drag that carries no files is not the upload's: nothing is marked and nothing is fetched", async ({
		page,
	}) => {
		const chunks: string[] = [];
		page.on("request", (r) => {
			const path = new URL(r.url()).pathname;
			if (/TransferPanel-.*\.js$/.test(path)) chunks.push(path);
		});
		await openFiles(page);
		await page.evaluate((selector) => {
			const data = new DataTransfer();
			data.setData("text/plain", "just text");
			for (const type of ["dragenter", "dragover"]) {
				document
					.querySelector(selector)
					?.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
			}
		}, pane);
		await expect(page.getByTestId("files-pane")).not.toHaveAttribute("data-dropping", "");
		await expect(page.getByTestId("transfer-drop-hint")).toHaveCount(0);
		await page.waitForLoadState("networkidle");
		expect(chunks).toEqual([]);
		// A drag that carries files fetches it.
		await page.evaluate((selector) => {
			const data = new DataTransfer();
			data.items.add(new File(["x"], "x.txt"));
			document
				.querySelector(selector)
				?.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: data }));
		}, pane);
		await expect.poll(() => chunks.length).toBe(1);
	});

	test("hidden names in a drop are not sent: they are counted", async ({ page }) => {
		const requested: string[] = [];
		page.on("request", (r) => {
			if (r.url().includes("/api/folder/upload?")) requested.push(new URL(r.url()).searchParams.get("name") ?? "");
		});
		await openFiles(page);
		await drop(page, pane, [
			{ name: ".env.local", text: "TOKEN=1" },
			{ name: "visible-after-hidden.txt", text: "ok" },
		]);
		await finished(page, 1);
		await expect(page.getByTestId("transfer-notes")).toContainText("1 hidden items left out");
		expect(requested).toEqual(["visible-after-hidden.txt"]);
		expect(existsSync(join(proj, ".env.local"))).toBe(false);
	});

	test("a name the server refuses is said in words, and the others go on", async ({ page }) => {
		await openFiles(page);
		await drop(page, pane, [
			{ name: "id_rsa", text: "-----BEGIN OPENSSH PRIVATE KEY-----" },
			{ name: "fine.txt", text: "ok" },
		]);
		const refused = page.locator('[data-testid="transfer-row"][data-name="id_rsa"]');
		await expect(refused).toHaveAttribute("data-state", "failed");
		await expect(refused.getByTestId("transfer-row-note")).toContainText("looks like a secret");
		await expect(page.locator('[data-testid="transfer-row"][data-name="fine.txt"]')).toHaveAttribute(
			"data-state",
			"done",
		);
		expect(existsSync(join(proj, "id_rsa"))).toBe(false);
	});

	test("a setting turned off since the page was told: the words, not an error", async ({ page }) => {
		await openFiles(page);
		await page.route("**/api/folder/upload?**", (route) =>
			route.fulfill({
				status: 403,
				contentType: "application/json",
				headers: { "x-omp-webui-error": "uploadOff" },
				body: JSON.stringify({ error: "Uploads are turned off.", code: "uploadOff" }),
			}),
		);
		await drop(page, pane, [
			{ name: "a1.txt", text: "1" },
			{ name: "a2.txt", text: "2" },
		]);
		await expect(page.getByTestId("transfer-halted")).toContainText("Uploads are turned off for this page");
		await expect(page.getByTestId("transfer-halted")).not.toContainText("HTTP");
	});
});

test.describe("progress, cancel and files that are there", () => {
	test("a big file goes in pieces with a progress bar, and Cancel stops it and the server throws away what arrived", async ({
		page,
	}) => {
		const pieces: { url: string }[] = [];
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		await page.route("**/api/folder/upload?**", async (route) => {
			pieces.push({ url: route.request().url() });
			// The first piece goes through (and gives the upload its id); the second waits, so that the file is under way.
			if (pieces.length === 2) await held;
			await route.continue();
		});
		await openFiles(page);
		await drop(page, rowSel("cancelled"), [{ name: "big.bin", size: 20 * 1024 * 1024 }]);
		const big = page.locator('[data-testid="transfer-row"][data-name="big.bin"]');
		await expect(big).toHaveAttribute("data-state", "sending");
		await expect.poll(() => pieces.length).toBe(2);
		const bar = big.getByTestId("transfer-row-bar");
		await expect(bar).toHaveAttribute("role", "progressbar");
		await expect.poll(async () => Number(await bar.getAttribute("aria-valuenow"))).toBeGreaterThan(0);
		await expect(page.getByTestId("transfer-overall-bar")).toHaveAttribute("aria-valuenow", /\d+/);
		expect(new URL(pieces[1]?.url ?? "", s.url).searchParams.get("offset")).toBe(String(8 * 1024 * 1024));
		const cancelled = page.waitForRequest((r) => r.url().includes("/api/folder/upload/cancel"));
		await big.getByTestId("transfer-row-cancel").click();
		await cancelled;
		await expect(big).toHaveAttribute("data-state", "cancelled");
		release();
		await expect(page.getByTestId("transfer-clear")).toBeVisible();
		expect(readdirSync(join(proj, "cancelled"))).toEqual([]);
	});

	test("a big file that is let through arrives whole", async ({ page }) => {
		await openFiles(page);
		await drop(page, rowSel("landing"), [{ name: "whole.bin", size: 9 * 1024 * 1024 }]);
		await finished(page, 1);
		expect(readFileSync(join(proj, "landing/whole.bin")).length).toBe(9 * 1024 * 1024);
	});

	test("a name that is taken waits for the others, and one question is asked for all: Keep both", async ({ page }) => {
		await openFiles(page);
		await drop(page, rowSel("conflict-keep"), [
			{ name: "a.txt", text: "new" },
			{ name: "b.txt", text: "fresh" },
		]);
		const dialog = page.getByTestId("transfer-conflict");
		await expect(dialog).toBeVisible();
		await expect(page.locator('[data-testid="transfer-row"][data-name="b.txt"]')).toHaveAttribute("data-state", "done");
		await expect(page.locator('[data-testid="transfer-row"][data-name="a.txt"]')).toHaveAttribute("data-state", "held");
		expect(body("conflict-keep/a.txt")).toBe("old");
		await page.getByTestId("transfer-keep").click();
		await expect(dialog).toHaveCount(0);
		await expect(page.locator('[data-testid="transfer-row"][data-state="done"]')).toHaveCount(2);
		expect(body("conflict-keep/a.txt")).toBe("old");
		// Saved under a free name, whatever number the server gives it.
		const kept = readdirSync(join(proj, "conflict-keep")).filter((n) => n !== "a.txt" && n !== "b.txt");
		expect(kept).toHaveLength(1);
		expect(kept[0]).toMatch(/^a \(\d+\)\.txt$/);
		expect(body(`conflict-keep/${kept[0]}`)).toBe("new");
	});

	test("Replace puts the new file in place of the one that is there", async ({ page }) => {
		await openFiles(page);
		await drop(page, rowSel("conflict-replace"), [{ name: "a.txt", text: "replaced" }]);
		await expect(page.getByTestId("transfer-conflict")).toBeVisible();
		await page.getByTestId("transfer-replace").click();
		await finished(page, 1);
		expect(body("conflict-replace/a.txt")).toBe("replaced");
		expect(readdirSync(join(proj, "conflict-replace"))).toEqual(["a.txt"]);
	});

	test("Skip leaves the new file out", async ({ page }) => {
		await openFiles(page);
		await drop(page, rowSel("conflict-skip"), [{ name: "a.txt", text: "unwanted" }]);
		await expect(page.getByTestId("transfer-conflict")).toBeVisible();
		await page.getByTestId("transfer-skip").click();
		await expect(page.locator('[data-testid="transfer-row"][data-name="a.txt"]')).toHaveAttribute(
			"data-state",
			"skipped",
		);
		expect(body("conflict-skip/a.txt")).toBe("old");
		expect(readdirSync(join(proj, "conflict-skip"))).toEqual(["a.txt"]);
		await expect(rows(page)).toHaveCount(1);
	});
});

test.describe("in Chinese", () => {
	test.use({ locale: "zh-CN" });

	test("the button, the panel, the plan and a refusal are in Simplified Chinese", async ({ page }) => {
		await openFiles(page);
		await expect(page.getByTestId("files-transfer")).toHaveAccessibleName("传输文件");
		await openTransfer(page);
		await expect(page.getByTestId("transfer-upload-files")).toContainText("上传文件");
		await expect(page.getByTestId("transfer-zip")).toContainText("把文件夹下载为 ZIP");
		await page.getByTestId("transfer-zip").click();
		await expect(page.getByTestId("transfer-plan-summary")).toContainText("个文件");
		await expect(page.getByTestId("transfer-plan-hidden")).toBeVisible();
		await page.getByTestId("transfer-plan-cancel").click();
		// A page on this computer is refused nothing; what a remote page is told is made up here.
		await refuseDownloads(page, "secret");
		await page.getByTestId("transfer-path").fill(".env");
		await page.getByTestId("transfer-path-go").click();
		await expect(page.getByTestId("transfer-error")).toContainText("看起来像机密");
	});
});

test.describe("on a phone", () => {
	test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

	test("the panel fits the screen and its controls are as tall as a finger needs", async ({ page }) => {
		await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
		await page.goto(`${s.url}/?token=${s.accessToken}`);
		await page.getByRole("button", { name: /Show sidebar/ }).click();
		await page.locator('[data-testid="session-item"]', { hasText: TITLE }).click();
		await expect(page.getByTestId("composer")).toBeVisible();
		await page.getByTestId("toggle-panel").click();
		await panel(page).getByTestId("panel-pane-top").getByRole("tab", { name: "Files" }).click();
		await expect(row(page, "src")).toBeVisible();
		await openTransfer(page);
		const box = await boxOf(page.getByTestId("transfer-panel"));
		expect(box.x).toBeGreaterThanOrEqual(0);
		expect(box.x + box.width).toBeLessThanOrEqual(390);
		for (const id of ["transfer-upload-files", "transfer-upload-folder", "transfer-zip", "transfer-path"]) {
			expect((await boxOf(page.getByTestId(id))).height, id).toBeGreaterThanOrEqual(36);
		}
		expect(
			await page.getByTestId("transfer-panel").evaluate((el) => el.scrollWidth > el.clientWidth),
			"the panel scrolls sideways",
		).toBe(false);
	});
});

for (const theme of ["light", "dark"] as const) {
	test.describe(`${theme} theme`, () => {
		test.beforeEach(async ({ page }) => {
			await page.addInitScript((t) => localStorage.setItem("ompw.theme", t), theme);
		});

		test("the panel, a plan, the progress list and the conflict dialog pass axe", async ({ page }) => {
			await openFiles(page);
			const scan = async (where: string, include: string) => {
				// A dialog fades in: axe reads the colours of what is on screen, so it waits for the fade.
				await page.evaluate(() =>
					Promise.allSettled(
						document
							.getAnimations()
							.filter((a) => a.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY)
							.map((a) => a.finished),
					),
				);
				const { violations } = await new AxeBuilder({ page }).include(include).analyze();
				expect(
					violations.map((v) => `${where}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`),
					where,
				).toEqual([]);
			};
			await openTransfer(page);
			await scan("panel", '[data-testid="transfer-panel"]');
			await page.getByTestId("transfer-zip").click();
			await expect(page.getByTestId("transfer-plan")).toBeVisible();
			await scan("plan", '[data-testid="transfer-panel"]');
			await page.getByTestId("transfer-plan-cancel").click();
			await page.getByTestId("transfer-input-files").setInputFiles({
				name: `axe-${theme}.txt`,
				mimeType: "text/plain",
				buffer: Buffer.from("axe"),
			});
			await finished(page, 1);
			await scan("progress", '[data-testid="transfer-panel"]');
			await page.getByTestId("transfer-clear").click();
			await page.keyboard.press("Escape");
			await drop(page, rowSel("conflict-skip"), [{ name: "a.txt", text: "again" }]);
			await expect(page.getByTestId("transfer-conflict")).toBeVisible();
			await scan("conflict", '[role="dialog"]');
			await page.getByTestId("transfer-skip").click();
		});
	});
}

test.describe("on a phone", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("the transfer panel stays inside the sheet it was opened in, and its path box shows what it asks for", async ({
		page,
	}) => {
		await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
		await page.goto(`${s.url}/?token=${s.accessToken}`);
		await openSidebar(page);
		const item = page.locator('[data-testid="session-item"]', { hasText: TITLE });
		await expect(item).toHaveCount(1, { timeout: 30_000 });
		await item.click();
		await expect(page.getByTestId("composer")).toBeVisible();
		await page.getByTestId("toggle-panel").click();
		await page.getByTestId("pane-tab-files").click();
		await expect(page.getByTestId("files-pane")).toBeVisible();
		await openTransfer(page);

		const sheet = await boxOf(panel(page));
		const popover = await boxOf(page.getByTestId("transfer-panel"));
		expect(popover.x, "not past the sheet's left edge").toBeGreaterThanOrEqual(sheet.x);
		expect(popover.x + popover.width, "not past its right edge").toBeLessThanOrEqual(sheet.x + sheet.width);
		// The hint in the empty box is not cut: its text is no wider than the room inside the box.
		const hint = await page.getByTestId("transfer-path").evaluate((input: HTMLInputElement) => {
			const canvas = document.createElement("canvas").getContext("2d");
			const style = getComputedStyle(input);
			if (!canvas) throw new Error("no canvas");
			canvas.font = `${style.fontSize} ${style.fontFamily}`;
			return {
				text: canvas.measureText(input.placeholder).width,
				room: input.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight),
			};
		});
		expect(hint.text).toBeLessThanOrEqual(hint.room);
	});
});
