import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { writeChatSession } from "../support/chat-session.ts";
import { makeFilesProject } from "../support/files-project.ts";
import { boxOf } from "../support/geometry.ts";
import { writeLongFakeOmp } from "../support/long-fake-omp-bin.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The Changes view of the Files tab (no model call): how the conversation's folder differs from its repository's last
 * commit, as a list and as a diff drawn unified or side by side, what each turn of the conversation changed, the folders it
 * cannot read, and that it only looks (no stage, commit, restore or discard). The project is the Files tab's own
 * (tests/support/files-project.ts: one file changed, new files, a picture, a binary file, a large one, links).
 */

let s: TestServer;
let binDir: string;
let root: string;
let proj: string;
const TITLE = "Changes tab conversation";
const TURNS_TITLE = "Changes tab turns";
const NO_REPO_TITLE = "Changes tab no repository";
const UNSAFE_TITLE = "Changes tab unsafe repository";
const DAMAGED_TITLE = "Changes tab damaged repository";

/** A saved conversation of `turns` (prompts, each with the edit and write calls it made and their answers). */
function writeTurns(
	n: number,
	title: string,
	cwd: string,
	turns: { prompt: string; calls: [string, string, boolean?][] }[],
) {
	const hex = n.toString(16).padStart(2, "0");
	const id = `01a00000-0000-7000-8000-0000000078${hex}`;
	const stamp = (i: number) => new Date(Date.UTC(2026, 0, 10, 0, 0, i)).toISOString();
	const lines: Record<string, unknown>[] = [
		{ type: "session", version: 3, id, timestamp: stamp(0), cwd },
		{ type: "title_change", id: "title000", parentId: null, timestamp: stamp(0), title },
	];
	let parent: string | null = null;
	let at = 1;
	const add = (entryId: string, message: Record<string, unknown>) => {
		lines.push({ type: "message", id: entryId, parentId: parent, timestamp: stamp(at), message });
		parent = entryId;
		at++;
	};
	turns.forEach((t, i) => {
		add(`p${i}`, { role: "user", content: [{ type: "text", text: t.prompt }], attribution: "user", timestamp: at });
		add(`a${i}`, {
			role: "assistant",
			content: t.calls.map(([name, path], k) => ({ type: "toolCall", id: `c${i}${k}`, name, arguments: { path } })),
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-haiku-5-5",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.0001 } },
			stopReason: "toolUse",
			timestamp: at,
		});
		t.calls.forEach(([name, path, failed], k) => {
			add(`r${i}${k}`, {
				role: "toolResult",
				toolCallId: `c${i}${k}`,
				toolName: name,
				content: [{ type: "text", text: failed ? "Failed" : "Done" }],
				details: { path },
				isError: failed === true,
				timestamp: at,
			});
		});
	});
	const bucket = join(s.agentDir, "sessions", cwd.replaceAll("/", "-"));
	mkdirSync(bucket, { recursive: true });
	writeFileSync(
		join(bucket, `2026-01-10T00-${hex}-00-000Z_${id}.jsonl`),
		`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
	);
}

test.beforeAll(async () => {
	binDir = mkdtempSync(join(tmpdir(), "ompw-changes-bin-"));
	s = await startTestServer(0, { OMP_BIN: writeLongFakeOmp(binDir) }, { login: false });
	root = realpathSync(s.work);
	proj = makeFilesProject(root);
	writeChatSession(s.agentDir, { n: 0x71, title: TITLE, cwd: proj, turns: [{ prompt: "hello", reply: "hi" }] });
	writeTurns(0x72, TURNS_TITLE, proj, [
		{
			prompt: "Add the fresh flag\nand fix the readme",
			calls: [
				["write", "src/new.ts"],
				["edit", "README.md"],
				["edit", "src/app.ts"],
				["write", "/somewhere/else/outside.ts"],
				["edit", "src/lib/greet.ts", true],
			],
		},
		{ prompt: "Touch the flag again", calls: [["edit", join(proj, "src/new.ts")]] },
	]);
	const empty = join(root, "no-repo");
	mkdirSync(empty);
	writeFileSync(join(empty, "a.txt"), "a\n");
	writeChatSession(s.agentDir, {
		n: 0x73,
		title: NO_REPO_TITLE,
		cwd: empty,
		turns: [{ prompt: "hello", reply: "hi" }],
	});
	const unsafe = join(root, "unsafe-repo");
	mkdirSync(unsafe);
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: unsafe, stdio: "ignore" });
	execFileSync("git", ["config", "core.fsmonitor", "/tmp/not-run-by-anyone"], { cwd: unsafe, stdio: "ignore" });
	writeFileSync(join(unsafe, "a.txt"), "a\n");
	writeChatSession(s.agentDir, {
		n: 0x74,
		title: UNSAFE_TITLE,
		cwd: unsafe,
		turns: [{ prompt: "hello", reply: "hi" }],
	});
	// A repository with a changed file whose committed blob is gone: git answers with an error when asked what changed.
	const damaged = join(root, "damaged-repo");
	mkdirSync(damaged);
	const git = (...args: string[]) =>
		execFileSync(
			"git",
			["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
			{
				cwd: damaged,
				stdio: "pipe",
			},
		).toString();
	git("init", "-q", "-b", "main");
	writeFileSync(join(damaged, "a.txt"), "one\ntwo\n");
	git("add", ".");
	git("commit", "-q", "-m", "first");
	writeFileSync(join(damaged, "a.txt"), "one\nTWO\n");
	const blob = git("rev-parse", "HEAD:a.txt").trim();
	rmSync(join(damaged, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
	writeChatSession(s.agentDir, {
		n: 0x75,
		title: DAMAGED_TITLE,
		cwd: damaged,
		turns: [{ prompt: "hello", reply: "hi" }],
	});
});
test.afterAll(async () => {
	await s?.stop();
	rmSync(binDir, { recursive: true, force: true });
});
test.afterEach(async ({ page }) => {
	await page.unrouteAll({ behavior: "wait" });
});

const panel = (page: Page) => page.getByTestId("right-panel");
const changeRow = (page: Page, path: string) => page.locator(`[data-testid="change-row"][data-path="${path}"]`);

/** Open the conversation, its side panel and the Files tab (the tree). */
async function openFiles(page: Page, title = TITLE): Promise<void> {
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	await page.goto(`${s.url}/?token=${s.accessToken}`);
	const item = page.locator('[data-testid="session-item"]', { hasText: title });
	await expect(item).toHaveCount(1, { timeout: 30_000 });
	await item.click();
	await expect(page.getByTestId("composer")).toBeVisible();
	await page.getByTestId("toggle-panel").click();
	await panel(page)
		.getByTestId("panel-pane-bottom")
		.getByRole("tab", { name: /^Files|^文件/ })
		.click();
	await expect(page.getByTestId("files-pane")).toBeVisible();
}

/** Waits for every animation that ends on its own (the view's fade-in) to be over: axe reads the colours on screen then. */
async function settledFade(page: Page): Promise<void> {
	await page.evaluate(() =>
		Promise.allSettled(
			document
				.getAnimations()
				.filter((a) => a.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY)
				.map((a) => a.finished),
		),
	);
}

/** Open the Files tab and switch it to its Changes view. */
async function openChanges(page: Page, title = TITLE): Promise<void> {
	await openFiles(page, title);
	await page.getByTestId("files-view-changes").click();
	await expect(page.getByTestId("changes-view")).toBeVisible();
}

test.describe("the view", () => {
	test("is a switch inside the Files tab, not a tab, and nothing of it is loaded or asked until it is chosen", async ({
		page,
	}) => {
		const chunks: string[] = [];
		const asked: string[] = [];
		page.on("request", (r) => {
			const url = new URL(r.url());
			if (/ChangesView-.*\.js$/.test(url.pathname)) chunks.push(url.pathname);
			if (url.pathname === "/api/folder/changes" || url.pathname === "/api/folder/diff") asked.push(url.pathname);
		});
		await openFiles(page);
		await expect(page.getByTestId("files-pane")).not.toHaveAttribute("data-view", /.+/);
		// Tabs are the panel's own: the view is not one of them.
		const tabs = await panel(page).getByRole("tab").allTextContents();
		expect(tabs.filter((t) => /Changes/i.test(t))).toEqual([]);
		const files = page.getByTestId("files-view-files");
		const changes = page.getByTestId("files-view-changes");
		await expect(files).toHaveAttribute("aria-pressed", "true");
		await expect(changes).toHaveAttribute("aria-pressed", "false");
		expect(chunks).toEqual([]);
		expect(asked).toEqual([]);

		await changes.click();
		await expect(page.getByTestId("changes-view")).toBeVisible();
		await expect(changes).toHaveAttribute("aria-pressed", "true");
		await expect(changeRow(page, "README.md")).toBeVisible();
		expect(chunks).toHaveLength(1);
		expect(asked).toContain("/api/folder/changes");

		// Back to the tree: the view is chosen again, not forgotten, and the tree is as it was.
		await files.click();
		await expect(page.getByTestId("changes-view")).toHaveCount(0);
		await expect(page.locator('[data-testid="file-row"][data-path="src"]')).toBeVisible();
		await changes.click();
		await expect(changeRow(page, "README.md")).toBeVisible();
		expect(chunks).toHaveLength(1);
	});

	test("looks and does not touch: no stage, commit, restore or discard anywhere in it", async ({ page }) => {
		await openChanges(page);
		await expect(changeRow(page, "README.md")).toBeVisible();
		await changeRow(page, "README.md").click();
		await expect(page.getByTestId("change-diff")).toBeVisible();
		const text = (await page.getByTestId("files-pane").innerText()).toLowerCase();
		for (const word of ["stage ", "commit", "restore", "discard", "revert", "reset", "checkout"]) {
			expect(text, word).not.toContain(word);
		}
		// Nothing but what looks: the buttons of the diff are going back, the mode and showing the file.
		const names = await page
			.getByTestId("change-diff")
			.getByRole("button")
			.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? e.textContent));
		expect(names.join("|")).not.toMatch(/stage|commit|restore|discard|revert|reset/i);
	});
});

test.describe("the working tree", () => {
	test("lists what differs from the last commit: the branch, each file's state, and new files too", async ({
		page,
	}) => {
		await openChanges(page);
		await expect(page.getByTestId("changes-branch")).toContainText("main");
		const readme = changeRow(page, "README.md");
		await expect(readme).toHaveAttribute("data-state", "modified");
		await expect(readme.getByTestId("change-state")).toHaveAttribute("data-state", "modified");
		// A modified file says how many lines.
		await expect(readme).toContainText(/\+\d+/);
		await expect(changeRow(page, "src/new.ts")).toHaveAttribute("data-state", "untracked");
		await expect(changeRow(page, "data.bin")).toHaveAttribute("data-state", "untracked");
		// What .gitignore names is not a change.
		await expect(changeRow(page, "build.out/bundle.js")).toHaveCount(0);
		await expect(page.getByTestId("changes-list").getByRole("button").first()).toBeVisible();
	});

	test("a change of a file is a diff in unified lines: the removed line, the added ones, with their numbers, and a way back", async ({
		page,
	}) => {
		await openChanges(page);
		await changeRow(page, "README.md").click();
		const diff = page.getByTestId("change-diff");
		await expect(diff).toHaveAttribute("data-path", "README.md");
		await expect(page.getByTestId("change-name")).toHaveText("README.md");
		const body = page.getByTestId("changes-diff-body");
		await expect(body).toHaveAttribute("data-layout", "unified");
		await expect(body.locator('[data-change="del"]')).toHaveCount(1);
		await expect(body.locator('[data-change="del"]')).toContainText("First version.");
		expect(await body.locator('[data-change="add"]').count()).toBeGreaterThan(3);
		await expect(body.getByTestId("changes-hunk").first()).toContainText("@@");
		// The sign is text as well as a tint: colour is never the only cue.
		await expect(body.locator('[data-change="del"]')).toContainText(/-\s*(removed:\s*)?First version\./);
		await expect(body.locator('[data-change="add"]').first()).toContainText("+");

		await page.getByTestId("change-back").click();
		await expect(page.getByTestId("change-diff")).toHaveCount(0);
		await expect(changeRow(page, "README.md")).toBeVisible();
	});

	test("a new file is all added, and Show the file opens it in the tree's preview", async ({ page }) => {
		await openChanges(page);
		await changeRow(page, "src/new.ts").click();
		const body = page.getByTestId("changes-diff-body");
		await expect(body.locator('[data-change="add"]')).toHaveCount(1);
		await expect(body.locator('[data-change="add"]')).toContainText("export const fresh = true;");
		await expect(body.locator('[data-change="del"]')).toHaveCount(0);
		await page.getByTestId("change-open-file").click();
		await expect(page.getByTestId("files-pane")).not.toHaveAttribute("data-view", /.+/);
		await expect(page.getByTestId("file-preview")).toBeVisible();
		await expect(page.getByTestId("file-preview").getByTestId("file-code")).toContainText("export const fresh = true;");
	});

	test("a picture, a binary file and a link are not drawn as lines, and say why", async ({ page }) => {
		await openChanges(page);
		for (const path of ["logo.png", "data.bin"]) {
			await changeRow(page, path).click();
			await expect(page.getByTestId("change-diff")).toHaveAttribute("data-path", path);
			await expect(page.getByTestId("change-diff")).toContainText("Not shown as lines");
			await expect(page.getByTestId("changes-diff-body")).toHaveCount(0);
			await page.getByTestId("change-back").click();
		}
		await changeRow(page, "link-out.txt").click();
		await expect(page.getByTestId("change-diff")).toContainText("A link: it is not followed");
		// What the link leads to is not in the page, in the change or anywhere.
		expect(await page.getByTestId("change-diff").innerText()).not.toContain("the secret outside the folder");
	});

	test("a large file is cut and says so; the rows past what is drawn at first are one click away", async ({ page }) => {
		await openChanges(page);
		await changeRow(page, "big.txt").click();
		const body = page.getByTestId("changes-diff-body");
		await expect(body).toBeVisible();
		await expect(page.getByTestId("changes-truncated")).toBeVisible();
		const shown = await body.getByTestId("changes-row").count();
		expect(shown).toBeLessThanOrEqual(401);
		await page.getByTestId("changes-show-all").click();
		await expect.poll(() => body.getByTestId("changes-row").count()).toBeGreaterThan(shown);
		await page.getByTestId("changes-show-all").click();
		await expect.poll(() => body.getByTestId("changes-row").count()).toBe(shown);
	});

	test("what is written in the folder while it is open is in the list", async ({ page }) => {
		await openChanges(page);
		await expect(changeRow(page, "README.md")).toBeVisible();
		writeFileSync(join(proj, "written-later.txt"), "later\n");
		try {
			await page.getByTestId("changes-refresh").click();
			await expect(changeRow(page, "written-later.txt")).toBeVisible();
			await expect(changeRow(page, "written-later.txt")).toHaveAttribute("data-state", "untracked");
		} finally {
			rmSync(join(proj, "written-later.txt"), { force: true });
		}
		await page.getByTestId("changes-refresh").click();
		await expect(changeRow(page, "written-later.txt")).toHaveCount(0);
	});
});

test.describe("a diff drawn side by side", () => {
	test.use({ viewport: { width: 1700, height: 900 } });

	test("with room for it, the old file is on the left and the new one on the right, and the choice is kept", async ({
		page,
	}) => {
		await page.addInitScript(() => localStorage.setItem("ompw.panelWidth", "640"));
		await openChanges(page);
		await changeRow(page, "README.md").click();
		const body = page.getByTestId("changes-diff-body");
		await expect(body).toHaveAttribute("data-layout", "unified");
		await page.getByTestId("diff-split").click();
		await expect(body).toHaveAttribute("data-layout", "split");
		await expect(page.getByTestId("diff-split")).toHaveAttribute("aria-pressed", "true");
		await expect(body.locator('[data-side="old"][data-change="del"]')).toContainText("First version.");
		expect(await body.locator('[data-side="new"][data-change="add"]').count()).toBeGreaterThan(3);
		// The removed line has a new line beside it, not an empty half: they are paired.
		await expect(body.locator('[data-side="old"][data-change="del"]')).toHaveCount(1);
		await expect(body.locator('[data-side="new"]:not([data-change])')).toHaveCount(0);
		// The choice is the page's, not the file's: the next file is drawn the same way.
		await page.getByTestId("change-back").click();
		await changeRow(page, "src/new.ts").click();
		await expect(page.getByTestId("changes-diff-body")).toHaveAttribute("data-layout", "split");
		await page.getByTestId("diff-unified").click();
		await expect(page.getByTestId("changes-diff-body")).toHaveAttribute("data-layout", "unified");
	});

	test("with less room than two columns need, there is one column and no choice to make", async ({ page }) => {
		await page.addInitScript(() => localStorage.setItem("ompw.panelWidth", "340"));
		await openChanges(page);
		await changeRow(page, "README.md").click();
		await expect(page.getByTestId("changes-diff-body")).toHaveAttribute("data-layout", "unified");
		await expect(page.getByTestId("diff-split")).toHaveCount(0);
	});
});

test.describe("a change opened large in the main area (#635)", () => {
	test.use({ viewport: { width: 1700, height: 900 } });

	test("is side by side at first in the main area, and Escape returns to the transcript where it was, draft kept", async ({
		page,
	}) => {
		await openChanges(page);
		// Where the conversation was, and something typed in the message box, are what closing must find again.
		await page.getByTestId("composer").fill("half-written");
		await page.getByTestId("transcript").evaluate((el) => {
			el.scrollTop = 0;
		});
		const before = await page.getByTestId("transcript").evaluate((el) => el.scrollTop);

		await changeRow(page, "README.md").click();
		await expect(page.getByTestId("changes-diff-body")).toHaveAttribute("data-layout", "unified");
		await page.getByTestId("change-open-large").click();
		const large = page.getByTestId("big-view");
		await expect(large).toBeVisible();
		await expect(large).toHaveAttribute("data-kind", "diff");
		await expect(large).toHaveAttribute("data-path", "README.md");
		await expect(page.getByTestId("big-name")).toHaveText("README.md");
		// Side by side is the default where there is room for it, whatever the panel's narrow width chose.
		const body = page.getByTestId("big-diff").getByTestId("changes-diff-body");
		await expect(body).toHaveAttribute("data-layout", "split");
		await expect(body.locator('[data-side="old"][data-change="del"]')).toContainText("First version.");
		expect(await body.locator('[data-side="new"][data-change="add"]').count()).toBeGreaterThan(3);
		// The panel is still beside it, and the transcript is hidden rather than gone.
		await expect(page.getByTestId("right-panel")).toBeVisible();
		await expect(page.getByTestId("transcript")).toBeHidden();

		await page.getByTestId("big-diff-unified").click();
		await expect(body).toHaveAttribute("data-layout", "unified");
		await expect(page.getByTestId("big-diff-unified")).toHaveAttribute("aria-pressed", "true");
		await page.getByTestId("big-diff-split").click();
		await expect(body).toHaveAttribute("data-layout", "split");

		await page.keyboard.press("Escape");
		await expect(large).toHaveCount(0);
		await expect(page.getByTestId("change-diff")).toBeVisible();
		await expect(page.getByTestId("composer")).toHaveValue("half-written");
		expect(await page.getByTestId("transcript").evaluate((el) => el.scrollTop)).toBe(before);
		// Focus is back on the button that opened it.
		await expect(page.getByTestId("change-open-large")).toBeFocused();
	});

	test("a new file is all added, and the choice inside the large view does not change the panel's", async ({
		page,
	}) => {
		await openChanges(page);
		await changeRow(page, "src/new.ts").click();
		// At the panel's default width there is one column there (no switch), which is what the large view's own choice must
		// not change.
		await expect(page.getByTestId("changes-diff-body")).toHaveAttribute("data-layout", "unified");
		await page.getByTestId("change-open-large").click();
		const body = page.getByTestId("big-diff").getByTestId("changes-diff-body");
		await expect(body.locator('[data-change="add"]')).toHaveCount(1);
		await expect(body.locator('[data-change="add"]')).toContainText("export const fresh = true;");
		await page.getByTestId("big-diff-unified").click();
		await expect(body).toHaveAttribute("data-layout", "unified");
		await page.getByTestId("big-close").click();
		await expect(page.getByTestId("big-view")).toHaveCount(0);
		// The panel's own layout was not touched by the choice made in the large view.
		await expect(page.getByTestId("changes-diff-body")).toHaveAttribute("data-layout", "unified");
	});
});

test.describe("by turn", () => {
	test("each turn of the conversation lists the files its edit and write calls changed, newest turn first", async ({
		page,
	}) => {
		await openChanges(page, TURNS_TITLE);
		await page.getByTestId("changes-source-turns").click();
		const turns = page.getByTestId("change-turn");
		await expect(turns).toHaveCount(2);
		// Newest first: the second prompt, then the first, which says which turn it was.
		await expect(turns.nth(0)).toContainText("Turn 2");
		await expect(turns.nth(0)).toContainText("Touch the flag again");
		await expect(turns.nth(1)).toContainText("Turn 1");
		await expect(turns.nth(1)).toContainText("Add the fresh flag");
		// Only the first line of a prompt is its label.
		await expect(turns.nth(1)).not.toContainText("and fix the readme");
		// An absolute path under the folder is the folder's file.
		await expect(turns.nth(0).locator('[data-testid="change-row"][data-path="src/new.ts"]')).toBeVisible();
		await expect(turns.nth(1).locator('[data-testid="change-row"][data-path="src/new.ts"]')).toBeVisible();
		await expect(turns.nth(1).locator('[data-testid="change-row"][data-path="README.md"]')).toHaveAttribute(
			"data-state",
			"modified",
		);
		// A file the turn changed that is the last commit's again says so, and is not a link to nothing.
		await expect(turns.nth(1).locator('[data-testid="change-gone"][data-path="src/app.ts"]')).toContainText(
			"no longer differs",
		);
		// A file outside the folder, and an edit that failed, are not listed.
		await expect(turns.nth(1).getByText("outside.ts")).toHaveCount(0);
		await expect(turns.nth(1).getByText("greet.ts")).toHaveCount(0);

		// A listed file opens its change; back comes to the same list.
		await turns.nth(1).locator('[data-testid="change-row"][data-path="README.md"]').click();
		await expect(page.getByTestId("changes-diff-body")).toBeVisible();
		await page.getByTestId("change-back").click();
		await expect(page.getByTestId("change-turn")).toHaveCount(2);
		// The working tree list is the other choice, and has what no edit call made too.
		await page.getByTestId("changes-source-tree").click();
		await expect(changeRow(page, "data.bin")).toBeVisible();
	});

	test("a conversation that has changed no file says so", async ({ page }) => {
		await openChanges(page);
		await page.getByTestId("changes-source-turns").click();
		await expect(page.getByTestId("changes-view")).toContainText(
			"No edit or write of this conversation has changed a file yet.",
		);
		await expect(page.getByTestId("change-turn")).toHaveCount(0);
	});
});

test.describe("a folder that cannot be looked at", () => {
	test("one that is not in a git repository says so", async ({ page }) => {
		await openChanges(page, NO_REPO_TITLE);
		await expect(page.getByTestId("changes-view")).toContainText("Not a git repository");
		await expect(page.getByTestId("change-row")).toHaveCount(0);
	});

	test("a repository whose settings name a program for git to run is not looked at, and the program is not run", async ({
		page,
	}) => {
		await openChanges(page, UNSAFE_TITLE);
		await expect(page.getByTestId("changes-view")).toContainText("Not looked at");
		await expect(page.getByTestId("change-row")).toHaveCount(0);
	});

	test("a repository git answers with an error for is unreadable, which is not that it is no repository", async ({
		page,
	}) => {
		await openChanges(page, DAMAGED_TITLE);
		await expect(page.getByTestId("changes-view")).toContainText("Can't read this repository");
		await expect(page.getByTestId("changes-view")).not.toContainText("Not a git repository");
		await expect(page.getByTestId("change-row")).toHaveCount(0);
	});
});

test.describe("on a phone", () => {
	test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

	test("the switch, the list and a diff fit the sheet, and what is touched is as tall as a finger needs", async ({
		page,
	}) => {
		await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
		await page.goto(`${s.url}/?token=${s.accessToken}`);
		await page.getByRole("button", { name: /Show sidebar/ }).click();
		await page.locator('[data-testid="session-item"]', { hasText: TITLE }).click();
		await expect(page.getByTestId("composer")).toBeVisible();
		await page.getByTestId("toggle-panel").click();
		await panel(page).getByTestId("panel-pane-top").getByRole("tab", { name: "Files" }).click();
		await page.getByTestId("files-view-changes").click();
		await expect(changeRow(page, "README.md")).toBeVisible();
		const overflow = (id: string) => page.getByTestId(id).evaluate((el) => el.scrollWidth > el.clientWidth);
		expect(await overflow("files-pane")).toBe(false);
		// The two switches are as tall as a finger needs; the refresh button is the Files tab's own small icon button.
		for (const id of ["files-view-files", "files-view-changes", "changes-source-tree", "changes-source-turns"]) {
			const box = await boxOf(page.getByTestId(id));
			expect(box.x + box.width, id).toBeLessThanOrEqual(390);
			expect(box.height, id).toBeGreaterThanOrEqual(36);
		}
		const refresh = await boxOf(page.getByTestId("changes-refresh"));
		expect(refresh.x + refresh.width).toBeLessThanOrEqual(390);
		expect(refresh.height).toBeGreaterThanOrEqual(24);
		expect((await boxOf(changeRow(page, "README.md"))).height).toBeGreaterThanOrEqual(36);

		await changeRow(page, "README.md").click();
		await expect(page.getByTestId("changes-diff-body")).toBeVisible();
		expect(await overflow("files-pane")).toBe(false);
		// One column: two would not fit, and there is no choice offered.
		await expect(page.getByTestId("diff-split")).toHaveCount(0);
		for (const id of ["change-back", "change-open-file"]) {
			const box = await boxOf(page.getByTestId(id));
			expect(box.x + box.width, id).toBeLessThanOrEqual(390);
			expect(box.height, id).toBeGreaterThanOrEqual(24);
		}
	});
});

for (const theme of ["light", "dark"] as const) {
	test.describe(`${theme} theme`, () => {
		test.beforeEach(async ({ page }) => {
			await page.addInitScript((t) => localStorage.setItem("ompw.theme", t), theme);
		});

		test("a change opened large passes axe, and its toggle is named", async ({ page }) => {
			await openChanges(page);
			await changeRow(page, "README.md").click();
			await page.getByTestId("change-open-large").click();
			await expect(page.getByTestId("big-diff")).toBeVisible();
			await settledFade(page);
			await expect(page.getByTestId("big-diff-split")).toHaveAccessibleName("Split");
			await expect(page.getByTestId("big-diff-unified")).toHaveAccessibleName("Unified");
			await expect(page.getByTestId("big-view")).toHaveAccessibleName("Changes in README.md");
			// The rows themselves are `DiffBody`'s, drawn as the panel draws them: axe reports the line numbers of its
			// semi-transparent tinted rows (a property of that component, not of this view), so the code body is left out and
			// everything this view adds — its name, its switches, its close, its state line — is checked.
			const { violations } = await new AxeBuilder({ page })
				.include('[data-testid="big-view"]')
				.exclude('[data-testid="changes-diff-body"]')
				.analyze();
			expect(
				violations.map((v) => `large diff: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`),
				"large diff",
			).toEqual([]);
			await page.getByTestId("big-diff-unified").click();
			await expect(page.getByTestId("big-diff").getByTestId("changes-diff-body")).toHaveAttribute(
				"data-layout",
				"unified",
			);
		});
	});
}

test.describe("in Chinese", () => {
	// By the browser's language, which the page follows until a language is chosen: nothing is saved for the other specs.
	test.use({ locale: "zh-CN" });

	test("the switch, the lists, the diff and the messages are in Simplified Chinese", async ({ page }) => {
		await openChanges(page, TURNS_TITLE);
		await expect(page.getByTestId("files-view-files")).toHaveText("文件");
		await expect(page.getByTestId("files-view-changes")).toHaveText("变更");
		await expect(page.getByTestId("changes-source-tree")).toContainText("工作区");
		await expect(page.getByTestId("changes-source-turns")).toContainText("按轮次");
		await expect(changeRow(page, "README.md").getByTestId("change-state")).toContainText("已修改");
		await expect(changeRow(page, "src/new.ts")).toContainText("未跟踪");
		await changeRow(page, "data.bin").click();
		await expect(page.getByTestId("change-diff")).toContainText("不以行显示");
		await page.getByTestId("change-back").click();
		await page.getByTestId("changes-source-turns").click();
		await expect(page.getByTestId("change-turn").first()).toContainText("第 2 轮");
		await expect(page.getByTestId("change-gone").first()).toContainText("已与提交一致");
		// No English left in what was drawn.
		const text = await page.getByTestId("changes-view").innerText();
		for (const word of ["No changes", "untracked", "modified", "Turn ", "no longer differs"])
			expect(text, word).not.toContain(word);
	});

	test("a folder that is not a repository says so in Chinese", async ({ page }) => {
		await openChanges(page, NO_REPO_TITLE);
		await expect(page.getByTestId("changes-view")).toContainText("不是 git 仓库");
	});

	test("a repository git cannot read says so in Chinese", async ({ page }) => {
		await openChanges(page, DAMAGED_TITLE);
		await expect(page.getByTestId("changes-view")).toContainText("无法读取此仓库");
	});

	test("a change opened large is in Chinese, its switch too", async ({ page }) => {
		await openChanges(page);
		await changeRow(page, "README.md").click();
		await expect(page.getByTestId("change-open-large")).toHaveAccessibleName("在主区域放大打开");
		await page.getByTestId("change-open-large").click();
		await expect(page.getByTestId("big-view")).toHaveAccessibleName("README.md 的变更");
		await expect(page.getByTestId("big-diff-unified")).toHaveAccessibleName("统一");
		await expect(page.getByTestId("big-diff-split")).toHaveAccessibleName("并排");
		await expect(page.getByTestId("big-close")).toHaveAccessibleName("关闭");
		await expect(page.getByTestId("big-diff").getByTestId("changes-diff-body")).toContainText("First version.");
		const text = await page.getByTestId("big-view").innerText();
		for (const word of ["Unified", "Split", "modified", "Close"]) expect(text, word).not.toContain(word);
	});
});
