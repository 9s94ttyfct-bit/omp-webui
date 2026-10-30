import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boxOf } from "../support/geometry.ts";
import { openSidebar, sessionRow, startLive } from "../support/live.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { removeTrackedTempDirs, tempDir } from "../support/temp-dirs.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The TUI's git segments on the status line: the branch with its staged, changed and untracked counts, and the pull
 * request. The server runs `git status` in the conversation's folder, here a temporary repository; the pull request
 * comes from `gh`, which is answered here by rewriting the server's reply (the server's own `gh` handling is covered by
 * tests/contract/git.test.ts). No model call is made.
 */

// Made in `beforeAll`, not when the file is loaded: Playwright also loads it to list the tests, where no `afterAll` runs.
let root: string;
let repo: string;
let plain: string;
let gone: string;
const PR = { number: 149, url: "https://github.com/o/r/pull/149" };

/** Run git in the repository with an identity, so nothing depends on the machine's configuration. */
function git(...args: string[]): void {
	runGit(repo, ...args);
}

function runGit(cwd: string, ...args: string[]): void {
	execFileSync(
		"git",
		["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
		{ cwd, stdio: "ignore" },
	);
}

/** A saved conversation whose folder is `cwd`; `k` makes it unique. */
function writeSession(k: number, cwd: string): string {
	const title = `Git status probe ${k}`;
	const id = `01a00000-0000-7000-8000-0000000c5a0${k}`;
	const t0 = Date.UTC(2026, 0, 11, 10, k, 0);
	const entries = [
		{ type: "session", version: 3, id, timestamp: new Date(t0).toISOString(), cwd, title },
		{
			type: "message",
			id: `g${k}01`,
			parentId: null,
			timestamp: new Date(t0).toISOString(),
			message: { role: "user", content: [{ type: "text", text: title }], attribution: "user", timestamp: t0 },
		},
		{
			type: "message",
			id: `g${k}02`,
			parentId: `g${k}01`,
			timestamp: new Date(t0 + 1000).toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Done." }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-opus-5-5",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
				stopReason: "stop",
				timestamp: t0 + 1000,
			},
		},
	];
	const dir = join(process.env.OMPW_E2E_AGENT_DIR as string, "sessions", "-git-status-probe");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `2026-01-11T10-0${k}-00-000Z_${id}.jsonl`),
		`${entries.map((e) => JSON.stringify(e)).join("\n")}\n`,
	);
	return title;
}

test.beforeAll(() => {
	root = tempDir("ompw-e2e-git-");
	repo = join(root, "repo");
	plain = join(root, "plain");
	gone = join(root, "gone");
	mkdirSync(repo, { recursive: true });
	mkdirSync(plain, { recursive: true });
	git("init", "-q", "-b", "main");
	writeFileSync(join(repo, "a.txt"), "a\n");
	writeFileSync(join(repo, "b.txt"), "b\n");
	git("add", ".");
	git("commit", "-q", "-m", "first");
	git("checkout", "-q", "-b", "fix/status-line");
	// One staged, two changed in the working tree (one of them also staged), two untracked.
	writeFileSync(join(repo, "staged.txt"), "s\n");
	git("add", "staged.txt");
	writeFileSync(join(repo, "a.txt"), "a changed\n");
	writeFileSync(join(repo, "b.txt"), "b changed\n");
	git("add", "b.txt");
	writeFileSync(join(repo, "b.txt"), "b changed twice\n");
	writeFileSync(join(repo, "new1.txt"), "1\n");
	writeFileSync(join(repo, "new2.txt"), "2\n");
});

test.afterAll(removeTrackedTempDirs);

async function openChat(page: Page, title: string): Promise<void> {
	// Auto-titling would send a prompt to the model.
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	await page.goto("/");
	await openSidebar(page);
	await expect(sessionRow(page, title)).toHaveCount(1, { timeout: 15_000 });
	await sessionRow(page, title).click();
}

const line = (page: Page, id: string) => page.getByTestId("chat-status").getByTestId(id);

test("the line shows the branch with its staged, changed and untracked counts", async ({ page }) => {
	const title = writeSession(1, repo);
	await openChat(page, title);
	const chip = line(page, "status-git");
	await expect(chip).toHaveAttribute("data-branch", "fix/status-line");
	await expect(chip).toContainText("fix/status-line");
	await expect(chip).toHaveAttribute("data-clean", "false");
	// staged.txt and b.txt; a.txt and b.txt; new1.txt and new2.txt.
	await expect(line(page, "status-git-staged")).toHaveAttribute("data-count", "2");
	await expect(line(page, "status-git-staged")).toContainText("+2");
	await expect(line(page, "status-git-unstaged")).toHaveAttribute("data-count", "2");
	await expect(line(page, "status-git-unstaged")).toContainText("~2");
	await expect(line(page, "status-git-untracked")).toHaveAttribute("data-count", "2");
	await expect(line(page, "status-git-untracked")).toContainText("?2");
	await expect(chip).toHaveAttribute("title", "Branch fix/status-line · 2 staged, 2 unstaged, 2 untracked");
	// Without a reply from gh there is no pull request chip, and nothing is wrong with the line.
	await expect(page.getByTestId("status-pr")).toHaveCount(0);
});

test("the pull request of the branch is a link on the line", async ({ page }) => {
	const title = writeSession(2, repo);
	await page.route(/\/api\/git\?.*pr=1/, async (route) => {
		const reply = await route.fetch();
		const body = await reply.json();
		await route.fulfill({ response: reply, json: { ...body, pr: PR } });
	});
	await openChat(page, title);
	const pr = line(page, "status-pr");
	await expect(pr).toHaveText("#149");
	await expect(pr).toHaveAttribute("href", PR.url);
	await expect(pr).toHaveAttribute("target", "_blank");
	await expect(pr).toHaveAttribute("rel", /noopener/);
	await expect(pr).toHaveAttribute("title", "Pull request #149");
});

test("changes made outside show when the window gets focus back", async ({ page }) => {
	const title = writeSession(3, repo);
	await openChat(page, title);
	await expect(line(page, "status-git-untracked")).toHaveAttribute("data-count", "2");
	// The server keeps a status for half a second, and a fresh ask within it joins that look.
	await page.waitForTimeout(700);
	writeFileSync(join(repo, "new3.txt"), "3\n");
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect(line(page, "status-git-untracked")).toHaveAttribute("data-count", "3");
	await page.waitForTimeout(700);
	rmSync(join(repo, "new3.txt"));
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect(line(page, "status-git-untracked")).toHaveAttribute("data-count", "2");
});

test("a clean repository shows its branch and no counts; a folder outside any repository shows nothing", async ({
	page,
}) => {
	const title = writeSession(4, plain);
	await openChat(page, title);
	// The folder is there (its name is on the line), and there is nothing to say about git.
	await expect(line(page, "status-cwd")).toContainText("plain");
	await expect(page.getByTestId("status-git")).toHaveCount(0);

	const fresh = join(root, "clean");
	mkdirSync(fresh);
	runGit(fresh, "init", "-q", "-b", "trunk");
	const cleanTitle = writeSession(5, fresh);
	await page.reload();
	await expect(sessionRow(page, cleanTitle)).toHaveCount(1, { timeout: 15_000 });
	await sessionRow(page, cleanTitle).click();
	const chip = line(page, "status-git");
	await expect(chip).toHaveAttribute("data-branch", "trunk");
	await expect(chip).toHaveAttribute("data-clean", "true");
	await expect(page.getByTestId("status-git-staged")).toHaveCount(0);
});

test("a folder that is gone costs the page nothing", async ({ page }) => {
	const title = writeSession(6, gone);
	const answered = page.waitForResponse(
		(r) => r.url().includes("/api/git?") && r.url().includes(encodeURIComponent(gone)),
	);
	await openChat(page, title);
	expect((await answered).status()).toBe(400);
	await expect(page.getByTestId("status-git")).toHaveCount(0);
	// The line is still there, and no toast complains.
	await expect(page.getByTestId("chat-status")).toBeVisible();
	await expect(page.getByTestId("toast")).toHaveCount(0);
});

test("a branch switched in a terminal shows with its own pull request once the window gets focus back", async ({
	page,
}) => {
	const work = join(root, "switch");
	mkdirSync(work, { recursive: true });
	runGit(work, "init", "-q", "-b", "main");
	writeFileSync(join(work, "a.txt"), "a\n");
	runGit(work, "add", ".");
	runGit(work, "commit", "-q", "-m", "first");
	runGit(work, "branch", "other");
	const title = writeSession(8, realpathSync(work));
	// gh would say which pull request a branch has: main has #149, other has #150.
	await page.route(/\/api\/git\?.*pr=1/, async (route) => {
		const reply = await route.fetch();
		const body = await reply.json();
		const number = body.git?.branch === "other" ? 150 : 149;
		await route.fulfill({
			response: reply,
			json: { ...body, pr: { number, url: `https://github.com/o/r/pull/${number}` } },
		});
	});
	await openChat(page, title);
	await expect(line(page, "status-git")).toHaveAttribute("data-branch", "main");
	await expect(line(page, "status-pr")).toHaveText("#149");
	// The server keeps a status for half a second, and a fresh ask within it joins that look.
	await page.waitForTimeout(700);

	runGit(work, "checkout", "-q", "other");
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect(line(page, "status-git")).toHaveAttribute("data-branch", "other");
	// Focus asks for the branch alone; the pull request of the new branch follows without a turn ending.
	await expect(line(page, "status-pr")).toHaveText("#150");
});

test("a detached HEAD says so in text, not only in a tooltip", async ({ page }) => {
	const work = join(root, "detached");
	mkdirSync(work, { recursive: true });
	runGit(work, "init", "-q", "-b", "main");
	writeFileSync(join(work, "a.txt"), "a\n");
	runGit(work, "add", ".");
	runGit(work, "commit", "-q", "-m", "first");
	runGit(work, "checkout", "-q", "--detach");
	const title = writeSession(9, realpathSync(work));
	await openChat(page, title);
	const chip = line(page, "status-git");
	await expect(chip).toContainText(/Detached HEAD at [0-9a-f]{7,}/);
	await expect(chip.locator(".sr-only").first()).toHaveText(/Detached HEAD at [0-9a-f]{7,}/);
	// The short commit id is what shows; it is hidden from readers so it is not announced twice.
	await expect(chip.locator("[aria-hidden=true]").filter({ hasText: /^[0-9a-f]{7,}$/ })).toHaveCount(1);
});

test.describe("phone", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("the branch and the pull request stay on the line, and the line fits the screen", async ({ page }) => {
		const title = writeSession(7, realpathSync(repo));
		await page.route(/\/api\/git\?.*pr=1/, async (route) => {
			const reply = await route.fetch();
			await route.fulfill({ response: reply, json: { ...(await reply.json()), pr: PR } });
		});
		await openChat(page, title);
		await expect(line(page, "status-git")).toContainText("fix/status-line");
		await expect(line(page, "status-pr")).toHaveText("#149");
		const box = await boxOf(page.getByTestId("chat-status"));
		expect(box.x + box.width).toBeLessThanOrEqual(390);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no sideways scroll").toBe(
			true,
		);
	});

	test("the model's name keeps its room on the line; the branch gives way first, then is its icon, named in its title", async ({
		page,
	}) => {
		// The line as the audit saw it on a phone: main with a change and a new file, a model with a name of some length.
		const work = join(root, "phone-model");
		mkdirSync(work, { recursive: true });
		runGit(work, "init", "-q", "-b", "main");
		writeFileSync(join(work, "a.txt"), "a\n");
		runGit(work, "add", ".");
		runGit(work, "commit", "-q", "-m", "first");
		writeFileSync(join(work, "a.txt"), "a changed\n");
		writeFileSync(join(work, "new.txt"), "n\n");
		const title = writeSession(0, realpathSync(work));
		await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
		const tap = await tapSocket(page);
		await page.goto("/");
		await openSidebar(page);
		const liveId = await startLive(page, tap, title, "git-status-model");
		// What omp reports after a model call: the model with its thinking level, and the context.
		tap.answer("get_state", () => ({
			ok: true,
			data: {
				isStreaming: false,
				isCompacting: false,
				messageCount: 2,
				queuedMessageCount: 0,
				thinkingLevel: "high",
				model: { id: "claude-opus-5-5", name: "Claude Opus 5.5", provider: "anthropic", contextWindow: 1_000_000 },
				contextUsage: { tokens: 120_000, contextWindow: 1_000_000, percent: 12 },
			},
		}));
		tap.push({ t: "frame", liveId, frame: { type: "model_changed" } });
		await expect(line(page, "status-model-name")).toHaveText("Claude Opus 5.5");
		const chip = line(page, "status-git");
		await expect(chip).toHaveAttribute("data-branch", "main");
		/**
		 * What of the two names shows: whether each is cut (to the fraction of a pixel: an ellipsis shows for less than one),
		 * and how many pixels of the branch's are on the line.
		 */
		const shown = () =>
			page.getByTestId("chat-status").evaluate((el) => {
				const cut = (name: HTMLElement) => {
					const words = document.createRange();
					words.selectNodeContents(name);
					return words.getBoundingClientRect().width > name.getBoundingClientRect().width + 0.01;
				};
				const model = el.querySelector('[data-testid="status-model-name"]') as HTMLElement;
				const branch = el.querySelector('[data-testid="status-git-name"]') as HTMLElement;
				const branchPx = branch.getBoundingClientRect().width;
				return {
					modelCut: cut(model),
					branchCut: branchPx > 1 && cut(branch),
					branchPx,
					oneRow: el.getBoundingClientRect().height < 28,
				};
			});
		const settled = () =>
			page.evaluate(() => {
				const { promise, resolve } = Promise.withResolvers<void>();
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
				return promise;
			});

		// 390 px: "main" would be "m…" beside the whole model's name (before, the model's was "Claude Opus…" too). The
		// model's name is whole; the branch is its icon and its counts, its name in the chip's title and read out.
		await expect.poll(async () => (await shown()).modelCut).toBe(false);
		await expect(page.getByTestId("chat-status")).toHaveAttribute("data-no-branch-name", "");
		expect((await shown()).branchPx, "the branch's name is not on the line").toBeLessThanOrEqual(1);
		expect((await shown()).oneRow).toBe(true);
		await expect(chip).toHaveAttribute("title", /^Branch main · /);
		await expect(chip).toContainText("main");
		await expect(line(page, "status-git-unstaged")).toBeVisible();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no sideways scroll").toBe(
			true,
		);

		// A little wider, there is room for both, whole.
		await page.setViewportSize({ width: 430, height: 844 });
		await expect(page.getByTestId("chat-status")).not.toHaveAttribute("data-no-branch-name");
		expect(await shown()).toMatchObject({ modelCut: false, branchCut: false, oneRow: true });

		// Pixel by pixel across the width where both just fit: "main" is whole or its icon, never "ma…" (the line full to a
		// fraction of a pixel cut it, and the whole pixels `scrollWidth` reports did not say so).
		for (const width of [
			...Array.from({ length: 16 }, (_, i) => 412 - i),
			...Array.from({ length: 16 }, (_, i) => 397 + i),
		]) {
			await page.setViewportSize({ width, height: 844 });
			await settled();
			const s = await shown();
			expect(s.modelCut, `the model's name is whole at ${width} px`).toBe(false);
			expect(s.branchCut, `"main" is whole or not shown at ${width} px (${s.branchPx} px of it)`).toBe(false);
		}

		// A long branch gives way before the model's name does, keeping a few readable characters; then it is its icon.
		runGit(work, "branch", "-m", "feature/a-rather-long-branch-name");
		await page.waitForTimeout(700);
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		await expect(chip).toHaveAttribute("data-branch", "feature/a-rather-long-branch-name");
		const states: { width: number; modelCut: boolean; branchCut: boolean; branchPx: number; oneRow: boolean }[] = [];
		for (const width of [520, 500, 480, 460, 440, 420, 400, 390, 400, 420, 440, 460, 480, 500, 520]) {
			await page.setViewportSize({ width, height: 844 });
			await settled();
			states.push({ width, ...(await shown()) });
		}
		for (const s of states) {
			expect(s.modelCut, `the model's name is whole at ${s.width} px`).toBe(false);
			expect(s.oneRow, `one row at ${s.width} px`).toBe(true);
			// Either a few readable characters of the branch, or none of them: never "m…".
			expect(s.branchPx <= 1 || s.branchPx >= 32, `${s.branchPx} px of the branch at ${s.width} px`).toBe(true);
		}
		expect(
			states.some((s) => s.branchCut && s.branchPx >= 32),
			"the branch gives way, keeping a few characters",
		).toBe(true);
		// Narrowing, the branch's name goes once; widening, it comes back once: no back and forth.
		const icon = states.map((s) => s.branchPx <= 1);
		const turns = icon.filter((s, i) => i > 0 && s !== icon[i - 1]).length;
		expect(turns, icon.map(Number).join("")).toBe(2);
	});
});
