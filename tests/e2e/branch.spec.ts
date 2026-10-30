import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { FIXTURE_BUCKET, FIXTURE_CWD, writeSimpleSession } from "../support/fixtures.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * Edit, Regenerate and Fork move omp's process to a new session file; the open conversation follows it.
 * Everything but the Edit-with-a-reply case runs without the model.
 */

let agentDir: string;
test.beforeAll(() => {
	agentDir = process.env.OMPW_E2E_AGENT_DIR as string;
});
const row = (page: Page, title: string) => page.locator('[data-testid="session-item"]', { hasText: title });

/** Files a test created (sessions, blobs, branches), removed afterwards. */
let created: string[] = [];
test.afterEach(() => {
	for (const f of created) rmSync(f, { force: true });
	created = [];
});

/** The file the address bar names (`#/s/<file>`). */
const openFile = (page: Page) => decodeURIComponent(new URL(page.url()).hash.replace("#/s/", ""));

/**
 * Open `title` from the sidebar, start its omp process, leave for `elsewhere` and come back.
 * The process keeps running, but this view — like every sidebar entry — does not name it.
 */
async function openWithRunningProcess(page: Page, title: string, elsewhere: string) {
	await page.goto("/");
	await row(page, title).click();
	await expect(page.getByTestId("chat-title")).toHaveText(title);
	// A `!command` starts the conversation's omp process without calling the model.
	await page.getByTestId("composer").fill("!echo started-$((6*7))");
	await page.getByTestId("composer").press("Enter");
	await expect(page.getByText("started-42")).toBeVisible({ timeout: 30_000 });
	await row(page, elsewhere).click();
	await expect(page.getByTestId("chat-title")).toHaveText(elsewhere);
	await row(page, title).click();
	await expect(page.getByTestId("chat-title")).toHaveText(title);
}

test("forking a chat opened from the sidebar moves the view to the new file, and the next send stays on that process", async ({
	page,
}) => {
	const source = writeSimpleSession(agentDir, 0x62, "Fork source");
	created.push(source, writeSimpleSession(agentDir, 0x63, "Fork elsewhere"));
	await openWithRunningProcess(page, "Fork source", "Fork elsewhere");

	const prompt = page.getByTestId("msg-user").first();
	await prompt.hover();
	await prompt.getByRole("button", { name: "Fork into a new conversation" }).click();
	await expect(page.getByText("Branched into a new conversation")).toBeVisible();

	// The address now names the fork, which holds the prompt but not its reply.
	await expect.poll(() => page.url()).not.toContain(basename(source));
	const fork = openFile(page);
	created.push(fork);
	await expect(page.getByText("Fork source?")).toBeVisible();
	await expect(page.getByText("Fork source.", { exact: true })).toHaveCount(0);

	// The same process carries on there; nothing was resumed on the old file.
	await page.getByTestId("composer").fill("!echo after-fork-$((2*3))");
	await page.getByTestId("composer").press("Enter");
	await expect(page.getByText("after-fork-6")).toBeVisible({ timeout: 30_000 });
	const lives = (await (await page.request.get("/api/lives")).json()) as {
		sessionFile: string | null;
		exited: boolean;
	}[];
	const files = lives.filter((l) => !l.exited && l.sessionFile).map((l) => basename(l.sessionFile as string));
	expect(files.filter((f) => f === basename(source))).toEqual([]);
	expect(files.filter((f) => f === basename(fork))).toHaveLength(1);
});

test("Edit on a chat opened from the sidebar switches to the branch and sends the edited prompt (no model call)", async ({
	page,
}) => {
	const prompts = await recordPrompts(page);
	const source = writeSimpleSession(agentDir, 0x68, "Rewrite source");
	created.push(source, writeSimpleSession(agentDir, 0x69, "Rewrite elsewhere"));
	await openWithRunningProcess(page, "Rewrite source", "Rewrite elsewhere");

	const prompt = page.getByTestId("msg-user").first();
	await prompt.hover();
	await prompt.getByRole("button", { name: "Edit (creates a branch)" }).click();
	await page.getByLabel("Edit message").fill("Rewrite source, again");
	await page.getByRole("button", { name: "Send as new branch" }).click();

	// The branch replaces the open conversation: the old reply is gone from it...
	await expect.poll(() => page.url()).not.toContain(basename(source));
	created.push(openFile(page));
	await expect(page.getByText("Rewrite source.", { exact: true })).toHaveCount(0);
	// ...and omp was handed the edited prompt there (recorded instead of answered by a model).
	await expect.poll(() => prompts.map((p) => p.message)).toEqual(["Rewrite source, again"]);
});

test("editing a prompt of a chat opened from the sidebar switches to the branch and shows the edit and its reply", async ({
	page,
}) => {
	test.skip(!process.env.OMPW_E2E_HAS_TOKEN, "needs an Anthropic token (omp token anthropic)");
	const source = writeSimpleSession(agentDir, 0x64, "Edit source");
	created.push(source, writeSimpleSession(agentDir, 0x65, "Edit elsewhere"));
	await openWithRunningProcess(page, "Edit source", "Edit elsewhere");

	const prompt = page.getByTestId("msg-user").first();
	await prompt.hover();
	await prompt.getByRole("button", { name: "Edit (creates a branch)" }).click();
	await page.getByLabel("Edit message").fill("What is the capital of Italy? Reply with exactly one word.");
	await page.getByRole("button", { name: "Send as new branch" }).click();

	await expect.poll(() => page.url()).not.toContain(basename(source));
	created.push(openFile(page));
	await expect(page.getByTestId("msg-user").last()).toContainText("capital of Italy");
	await expect(page.getByTestId("msg-assistant").last()).toContainText("Rome", { timeout: 90_000 });
});

// ------------------------------------------------------------------ attachments survive Regenerate and Edit

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

/** A conversation whose first prompt carries an image that omp stored as a blob (`blob:sha256:…`). */
function imageSession(n: number, text: string): string {
	const hash = createHash("sha256").update(PNG).digest("hex");
	mkdirSync(join(agentDir, "blobs"), { recursive: true });
	const blob = join(agentDir, "blobs", hash);
	writeFileSync(blob, PNG);
	const hex = n.toString(16).padStart(2, "0");
	const id = `01a00000-0000-7000-8000-0000000097${hex}`;
	const file = join(agentDir, "sessions", FIXTURE_BUCKET, `2026-01-08T00-${hex}-00-000Z_${id}.jsonl`);
	const at = (min: number) => new Date(Date.UTC(2026, 0, 8, 10, min)).toISOString();
	const lines = [
		{ type: "session", version: 3, id, timestamp: at(0), cwd: FIXTURE_CWD },
		{
			type: "message",
			id: `i${hex}000001`,
			parentId: null,
			timestamp: at(1),
			message: {
				role: "user",
				content: [
					{ type: "text", text },
					{ type: "image", data: `blob:sha256:${hash}`, mimeType: "image/png" },
				],
				attribution: "user",
				timestamp: Date.parse(at(1)),
			},
		},
		{
			type: "message",
			id: `i${hex}000002`,
			parentId: `i${hex}000001`,
			timestamp: at(2),
			message: {
				role: "assistant",
				content: [{ type: "text", text: "A single dot." }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-haiku-5-5",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
				stopReason: "stop",
				timestamp: Date.parse(at(2)) + 500,
			},
		},
	];
	writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	created.push(file, blob);
	return file;
}

/** Stand-in for the model: `prompt` commands are recorded and acknowledged here, every other message reaches omp. */
async function recordPrompts(page: Page) {
	const prompts: { message: string; images?: unknown[] }[] = [];
	await page.routeWebSocket(/\/ws$/, (ws) => {
		const server = ws.connectToServer();
		ws.onMessage((raw) => {
			const msg = JSON.parse(String(raw));
			if (msg.t === "rpc" && msg.command?.type === "prompt") {
				prompts.push(msg.command);
				ws.send(JSON.stringify({ t: "reply", req: msg.req, ok: true, data: {} }));
				return;
			}
			server.send(raw);
		});
		server.onMessage((raw) => ws.send(raw));
	});
	return prompts;
}

const sent = { type: "image", data: PNG.toString("base64"), mimeType: "image/png" };

test("Edit resends the prompt's image with the edited text", async ({ page }) => {
	imageSession(0x70, "Edit this dot");
	const prompts = await recordPrompts(page);
	await page.goto("/");
	await row(page, "Edit this dot").click();
	const prompt = page.getByTestId("msg-user").first();
	await expect(prompt.getByRole("img", { name: "Attachment" })).toBeVisible();
	await prompt.hover();
	await prompt.getByRole("button", { name: "Edit (creates a branch)" }).click();
	await page.getByLabel("Edit message").fill("Edit this dot, again");
	await page.getByRole("button", { name: "Send as new branch" }).click();

	await expect.poll(() => prompts.length).toBe(1);
	expect(prompts[0].message).toBe("Edit this dot, again");
	expect(prompts[0].images).toEqual([sent]);
	created.push(openFile(page));
});

test("Regenerate resends the prompt's image with its text", async ({ page }) => {
	imageSession(0x71, "Regenerate this dot");
	const prompts = await recordPrompts(page);
	await page.goto("/");
	await row(page, "Regenerate this dot").click();
	await page.getByRole("button", { name: "Regenerate (new branch)" }).click();

	await expect.poll(() => prompts.length).toBe(1);
	expect(prompts[0].message).toBe("Regenerate this dot");
	expect(prompts[0].images).toEqual([sent]);
	created.push(openFile(page));
});
