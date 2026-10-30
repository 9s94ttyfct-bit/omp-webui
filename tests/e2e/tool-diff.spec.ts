import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_BUCKET, FIXTURE_CWD } from "../support/fixtures.ts";
import { expect, type Page, test } from "./fixtures.ts";

/** edit/write cards show omp's file path and diff instead of raw JSON (no model call: a hand-written session). */

const TITLE = "Tidy up the config loader";
const SESSION_ID = "01a00000-0000-7000-8000-00000000d7d7";

const stamp = (minute: number) => new Date(Date.UTC(2026, 0, 6, 11, minute)).toISOString();

const CONFIG_DIFF =
	" 60|\tprivate exited = false;\n 61|\tconst keep = 1;\n-62|\tprivate resolveReady!: () => void;\n+62|\tprivate resolveReady: () => void;\n+63|\tprivate extra = 2;\n 64|\n\n 120|\t};";
const CONFIG_INPUT = "[proj/server/config.ts#8689]\nPUT 61.=69:\n+\treadonly ready: Promise<void>;";
const SYNTAX_WARNING = "Syntax error: unexpected token at 10:3";
const PARSE_WARNING = "Warning: proj/utils.ts no longer parses after this edit. Fix it before continuing.";
const EDIT_ERROR = "Could not find anchor line 12 in proj/missing.ts";
const WRITTEN = '{\n\t"name": "notes"\n}\n';

interface Turn {
	prompt: string;
	tool: string;
	args: Record<string, unknown>;
	text: string[];
	details: unknown;
	isError?: boolean;
}

const TURNS: Turn[] = [
	{
		prompt: TITLE,
		tool: "edit",
		args: { i: "Applying withResolvers refactor", input: CONFIG_INPUT },
		text: ["[proj/server/config.ts#8689]\n60:\tprivate exited = false;"],
		details: { diff: CONFIG_DIFF, firstChangedLine: 62, op: "update", path: "/Users/x/proj/server/config.ts" },
	},
	{
		prompt: "Fix the utils helper",
		tool: "edit",
		args: { input: "[proj/utils.ts#1111]\nPUT 10:\n+\tfoo(" },
		text: [`[proj/utils.ts#1111]\n10:\tfoo(\n\nWarnings:\n${SYNTAX_WARNING}`, PARSE_WARNING],
		details: {
			diff: " 9|\tbar;\n-10|\tfoo();\n+10|\tfoo(",
			firstChangedLine: 10,
			op: "update",
			path: "/Users/x/proj/utils.ts",
		},
	},
	{
		prompt: "Edit a file that is not there",
		tool: "edit",
		args: { path: "proj/missing.ts", old_string: "a", new_string: "b" },
		text: [EDIT_ERROR],
		details: {},
		isError: true,
	},
	{
		prompt: "Write the notes file",
		tool: "write",
		args: { path: "proj/notes.json", content: WRITTEN, i: "Writing notes" },
		text: ["[proj/notes.json#4228]\nSuccessfully wrote 22 bytes to proj/notes.json"],
		details: { resolvedPath: "/Users/x/proj/notes.json" },
	},
	{
		prompt: "Rename across two files",
		tool: "edit",
		args: { input: "[proj/src/alpha.ts#1111]\nPUT 1:\n+new\n[proj/src/beta.ts#2222]\nPUT 1:\n+brand new" },
		text: ["[proj/src/alpha.ts#1111]\n1:\tnew\n[proj/src/beta.ts#2222]\n1:\tbrand new"],
		details: {
			diff: "-1|old\n+1|new\n+1|brand new",
			firstChangedLine: 1,
			perFileResults: [
				{ path: "/Users/x/proj/src/alpha.ts", diff: "-1|old\n+1|new", firstChangedLine: 1, op: "update" },
				{ path: "/Users/x/proj/src/beta.ts", diff: "+1|brand new", firstChangedLine: 1, op: "create" },
			],
		},
	},
];

/** One session of five turns, each a prompt, one tool call, its result and an answer (too short to fold). */
function writeSession(agentDir: string): string {
	const dir = join(agentDir, "sessions", FIXTURE_BUCKET);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `2026-01-06T11-00-00-000Z_${SESSION_ID}.jsonl`);
	const entries: Record<string, unknown>[] = [
		{ type: "session", version: 3, id: SESSION_ID, timestamp: stamp(0), cwd: FIXTURE_CWD },
	];
	let parent: string | null = null;
	let n = 0;
	const push = (minute: number, message: Record<string, unknown>) => {
		const id = `d7${(++n).toString(16).padStart(6, "0")}`;
		entries.push({
			type: "message",
			id,
			parentId: parent,
			timestamp: stamp(minute),
			message: { ...message, timestamp: Date.parse(stamp(minute)) },
		});
		parent = id;
	};
	for (const [i, turn] of TURNS.entries()) {
		const minute = 1 + i * 4;
		const toolCallId = `toolu_diff_${i}`;
		const assistant = { provider: "anthropic", model: "claude-haiku-5-5" };
		push(minute, { role: "user", content: [{ type: "text", text: turn.prompt }], attribution: "user" });
		push(minute + 1, {
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name: turn.tool, arguments: turn.args }],
			stopReason: "toolUse",
			...assistant,
		});
		push(minute + 2, {
			role: "toolResult",
			toolCallId,
			toolName: turn.tool,
			content: turn.text.map((text) => ({ type: "text", text })),
			details: turn.details,
			isError: turn.isError ?? false,
		});
		push(minute + 3, {
			role: "assistant",
			content: [{ type: "text", text: `Finished step ${i + 1}.` }],
			stopReason: "stop",
			...assistant,
		});
	}
	writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
	return file;
}

/** What `color: <value>` computes to in this page. */
const cssColor = (page: Page, value: string) =>
	page.evaluate((v) => {
		const probe = document.createElement("i");
		probe.style.color = v;
		document.body.append(probe);
		const color = getComputedStyle(probe).color;
		probe.remove();
		return color;
	}, value);

async function openSession(page: Page) {
	await page.goto("/");
	await page.getByRole("complementary").getByText(TITLE).click();
	await expect(page.getByText("Finished step 5.")).toBeVisible();
}

/** The card whose header names `text` (a file name, or the tool's first words). */
const card = (page: Page, text: string) => page.getByTestId("tool-card").filter({ hasText: text });

let file = "";
test.beforeAll(() => {
	file = writeSession(process.env.OMPW_E2E_AGENT_DIR as string);
});
test.afterAll(() => {
	rmSync(file, { force: true });
});

test("an edit card names the file and its line counts, and expands to a tinted diff with a line gutter", async ({
	page,
}) => {
	await openSession(page);
	const edit = card(page, "config.ts");
	const header = edit.getByRole("button").first();
	await expect(header.getByTestId("tool-path")).toHaveText("/Users/x/proj/server/config.ts");
	await expect(header).toContainText("config.ts");
	await expect(header).toContainText("+2");
	await expect(header).toContainText("−1");
	// The intent stays, dimmed, next to the file.
	await expect(header).toContainText("Applying withResolvers refactor");
	await expect(edit.getByTestId("diff-view")).toHaveCount(0);

	await header.click();
	await expect(header).toHaveAttribute("aria-expanded", "true");
	const view = edit.getByTestId("diff-view");
	await expect(view).toBeVisible();
	await expect(view.getByTestId("diff-row")).toHaveCount(7);
	const added = view.locator('[data-testid="diff-row"][data-change="add"]');
	const removed = view.locator('[data-testid="diff-row"][data-change="del"]');
	await expect(added).toHaveCount(2);
	await expect(removed).toHaveCount(1);
	// Line numbers and the sign are text in the gutter, so colour is not the only cue.
	await expect(removed.getByTestId("diff-gutter")).toHaveText("62-");
	await expect(added.getByTestId("diff-gutter")).toHaveText(["62+", "63+"]);
	await expect(removed).toContainText("private resolveReady!: () => void;");
	await expect(view.getByTestId("diff-gap")).toHaveCount(1);
	// Tinted with the success / danger tokens.
	await expect(added.first()).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
	await expect(removed).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
	await expect(view.locator('[data-change="ctx"]').first()).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

	// The raw JSON is behind the toggle.
	await expect(edit.getByText("PUT 61.=69")).toHaveCount(0);
	const toggle = edit.getByTestId("tool-raw-toggle");
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
	await expect(edit.getByText('"input"')).toBeVisible();
	await expect(edit.getByText("PUT 61.=69")).toBeVisible();
	await toggle.click();
	await expect(edit.getByText('"input"')).toHaveCount(0);
});

test("a screen reader hears one changed line as one line, and more as lines", async ({ page }) => {
	await openSession(page);
	const header = (text: string) => card(page, text).getByRole("button").first();
	await expect(header("utils.ts")).toContainText("1 line added");
	await expect(header("utils.ts")).toContainText("1 line removed");
	await expect(header("config.ts")).toContainText("2 lines added");
	await expect(header("config.ts")).toContainText("1 line removed");
});

test("a warning in the output text stays visible next to the diff", async ({ page }) => {
	await openSession(page);
	const edit = card(page, "utils.ts");
	await edit.getByRole("button").first().click();
	await expect(edit.getByTestId("diff-view")).toBeVisible();
	const warnings = edit.getByTestId("tool-warnings");
	await expect(warnings).toBeVisible();
	await expect(warnings).toContainText(SYNTAX_WARNING);
	await expect(warnings).toContainText(PARSE_WARNING);
	// Without warnings there is no box (the first card has none).
	await card(page, "config.ts").getByRole("button").first().click();
	await expect(card(page, "config.ts").getByTestId("tool-warnings")).toHaveCount(0);
});

test("a failed edit falls back to the plain layout with the error in red", async ({ page }) => {
	await openSession(page);
	const edit = card(page, "missing.ts");
	const header = edit.getByRole("button").first();
	await expect(header.getByTestId("tool-path")).toHaveText("proj/missing.ts");
	await expect(header.getByLabel("Failed")).toBeVisible();
	await header.click();
	await expect(edit.getByTestId("diff-view")).toHaveCount(0);
	await expect(edit.getByTestId("tool-raw-toggle")).toHaveCount(0);
	await expect(edit.getByText("Arguments", { exact: true })).toBeVisible();
	const error = edit.locator("pre", { hasText: EDIT_ERROR });
	await expect(error).toBeVisible();
	await expect(error).toHaveCSS("color", await cssColor(page, "var(--danger)"));
});

test("a write card shows its path and the written content as a numbered, untinted listing", async ({ page }) => {
	await openSession(page);
	const write = card(page, "notes.json");
	const header = write.getByRole("button").first();
	await expect(header.getByTestId("tool-path")).toHaveText("/Users/x/proj/notes.json");
	await expect(header).toContainText("Writing notes");
	await header.click();
	const rows = write.getByTestId("diff-row");
	await expect(rows).toHaveCount(3);
	await expect(write.getByTestId("diff-gutter")).toHaveText(["1", "2", "3"]);
	await expect(rows.nth(1)).toContainText('"name": "notes"');
	// Overwritten or new, nothing here is known to be added: no tinted rows.
	await expect(write.locator('[data-change="add"]')).toHaveCount(0);
	await expect(write.locator('[data-change="del"]')).toHaveCount(0);
	await expect(write).toContainText("Successfully wrote 22 bytes");
	// The toggle's own label ("Show raw arguments") is not the heading.
	await expect(write.getByText("Arguments", { exact: true })).toHaveCount(0);
	await write.getByTestId("tool-raw-toggle").click();
	await expect(write.getByText("Arguments", { exact: true })).toBeVisible();
	await expect(write.getByText('"content"')).toBeVisible();
});

test("a multi-file edit labels each file and adds +N more to the header", async ({ page }) => {
	await openSession(page);
	const edit = card(page, "alpha.ts");
	const header = edit.getByRole("button").first();
	await expect(header.getByTestId("tool-path")).toHaveText("/Users/x/proj/src/alpha.ts");
	await expect(header).toContainText("+1 more");
	await expect(header).toContainText("+2");
	await expect(header).toContainText("−1");
	await header.click();
	const views = edit.getByTestId("diff-view");
	await expect(views).toHaveCount(2);
	await expect(views.nth(0).getByTestId("tool-path")).toHaveText("/Users/x/proj/src/alpha.ts");
	await expect(views.nth(1).getByTestId("tool-path")).toHaveText("/Users/x/proj/src/beta.ts");
	await expect(views.nth(1)).toContainText("new file");
	await expect(views.nth(0).getByTestId("diff-row")).toHaveCount(2);
	await expect(views.nth(1).locator('[data-change="add"]')).toHaveCount(1);
});
