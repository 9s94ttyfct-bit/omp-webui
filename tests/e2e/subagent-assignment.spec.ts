import { openSidebar, sessionRow, startLive } from "../support/live.ts";
import { type Command, type Msg, type SocketTap, tapSocket } from "../support/socket-tap.ts";
import {
	appendTaskTurn,
	CONTEXT,
	conversationRecords,
	type Entry,
	initRecords,
	LONG_TASK,
	promptOf,
	SHORT_TASK,
	SPAWNED_TEXT,
	TASK_ARGS,
	TASK_DETAILS,
	UNNAMED_ID,
	writeAssignedTranscript,
	writeLongAssignedTranscript,
} from "../support/subagent-assignment-fixtures.ts";
import { sessionWithSubagents, writeTranscript } from "../support/subagent-fixtures.ts";
import { expect, type Locator, type Page, test } from "./fixtures.ts";

/**
 * What a subagent was told, in both places that show a subagent: the task card in the conversation and the Agents tab,
 * and in the three states each has: while the subagent runs (injected frames), once it is over, and when the
 * conversation is opened again from its files (no process). No model call: the frames are pushed by hand and the files
 * are written in the shape omp writes them (see `subagent-assignment-fixtures.ts`).
 *
 * The task is shown as Markdown, cut when long, and copied as written; the context every subagent of the call shares is
 * a section of its own.
 */

type Frame = Record<string, unknown>;

const CALL = "call_assignment";

const lifecycle = (id: string, status: string, extra: Frame = {}): Frame => ({
	type: "subagent_lifecycle",
	payload: { id, agent: "explore", agentSource: "bundled", index: 0, status, ...extra },
});
/** omp's progress frame of a subagent: the rendered prompt as `task`, the trimmed one as `assignment`, in the payload and the record. */
const progress = (id: string, task: string, extra: Frame = {}): Frame => ({
	type: "subagent_progress",
	payload: {
		index: 0,
		agent: "explore",
		agentSource: "bundled",
		task: promptOf(task),
		assignment: task,
		parentToolCallId: CALL,
		progress: { id, status: "running", task: promptOf(task), assignment: task, durationMs: 3000 },
		...extra,
	},
});

const card = (page: Page) => page.locator('[data-testid="tool-card"][data-tool="task"]');

/** Open the card whether or not it is open already (a card whose call runs may open by itself). */
async function openCard(c: Locator): Promise<void> {
	const header = c.locator("button[aria-expanded]").first();
	if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
	await expect(header).toHaveAttribute("aria-expanded", "true");
}

const itemNames = (c: Locator) =>
	c.getByTestId("task-item").evaluateAll((els) => els.map((e) => e.getAttribute("data-name")));

const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

/** The text of an assignment view that is open: Markdown, cut when long, copyable; its context a section of its own. */
async function expectAlphaAssignment(page: Page, view: Locator): Promise<void> {
	const task = view.getByTestId("assignment-task");
	// Markdown, not the source: the heading is a heading and the code is code.
	await expect(task.getByRole("heading", { name: "Target" })).toBeVisible();
	await expect(task.locator("code", { hasText: "/tmp/alpha" })).toBeVisible();
	await expect(task).not.toContainText("# Target");

	// A task this long is cut: the last line is below the box until "Show more" opens it.
	const body = task.getByTestId("assignment-body");
	const last = task.getByText("ALPHA-ACCEPTANCE-MARKER");
	const clipped = async () => {
		const [box, mark] = await Promise.all([body.boundingBox(), last.boundingBox()]);
		return !!box && !!mark && mark.y >= box.y + box.height;
	};
	const more = task.getByTestId("assignment-more");
	await expect(more).toHaveText("Show more");
	await expect(more).toHaveAttribute("aria-expanded", "false");
	expect(await clipped()).toBe(true);
	await more.click();
	await expect(more).toHaveText("Show less");
	await expect(more).toHaveAttribute("aria-expanded", "true");
	await expect.poll(clipped).toBe(false);
	await more.click();
	await expect(more).toHaveText("Show more");
	await expect.poll(clipped).toBe(true);

	// It is copied as written, not as rendered.
	await task.getByRole("button", { name: "Copy task", exact: true }).click();
	await expect.poll(() => clipboard(page)).toBe(LONG_TASK);

	// The shared context stays closed until asked for, then it is Markdown too, and what it holds as HTML stays text.
	const context = view.getByTestId("assignment-context");
	const toggle = context.getByRole("button", { name: "Shared context", exact: true });
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await expect(context).not.toContainText("SHARED-CONTRACT-MARKER");
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
	await expect(context.getByRole("heading", { name: "Goal" })).toBeVisible();
	await expect(context.locator("code", { hasText: "src/parser.ts" })).toBeVisible();
	await expect(context.locator("li")).toHaveCount(2);
	await expect(context).toContainText("SHARED-CONTRACT-MARKER");
	await expect(context.locator("img")).toHaveCount(0);
	expect(await page.evaluate(() => Reflect.get(window, "__assignmentPwned"))).toBe(undefined);
	await context.getByRole("button", { name: "Copy shared context", exact: true }).click();
	await expect.poll(() => clipboard(page)).toBe(CONTEXT);
}

/** Beta's assignment: a short task, never cut. */
async function expectBetaAssignment(view: Locator): Promise<void> {
	const task = view.getByTestId("assignment-task");
	await expect(task).toContainText("BETA-TASK-MARKER");
	await expect(task.locator("code", { hasText: "docs/parser.md" })).toBeVisible();
	await expect(task.getByTestId("assignment-more")).toHaveCount(0);
}

/** What the card shows of its subagents once open: each named, with its agent, opening to its assignment. */
async function expectCardItems(page: Page, c: Locator, names: (string | null)[]): Promise<void> {
	const items = c.getByTestId("task-item");
	await expect(items).toHaveCount(3);
	// The call's arguments say the same again as JSON: they are behind the toggle, not under the rows.
	const raw = c.locator("pre", { hasText: '"tasks"' });
	await expect(raw).toHaveCount(0);
	const rawToggle = c.getByTestId("tool-raw-toggle");
	await rawToggle.click();
	await expect(raw).toHaveCount(1);
	await expect(c.getByText("Arguments", { exact: true })).toBeVisible();
	await rawToggle.click();
	await expect(raw).toHaveCount(0);
	await expect.poll(() => itemNames(c)).toEqual(names);
	await expect(items.nth(0)).toContainText("explore");
	await expect(items.nth(0)).toContainText("Worktree `/tmp/alpha`");

	// Closed until asked for; the first is the long one.
	await expect(c.getByTestId("assignment")).toHaveCount(0);
	const first = items.nth(0).locator("button[aria-expanded]").first();
	await first.click();
	await expect(first).toHaveAttribute("aria-expanded", "true");
	await expectAlphaAssignment(page, items.nth(0));

	await items.nth(1).locator("button[aria-expanded]").first().click();
	await expectBetaAssignment(items.nth(1));
	// Each opens by itself.
	await expect(c.getByTestId("assignment")).toHaveCount(2);
	await first.click();
	await expect(c.getByTestId("assignment")).toHaveCount(1);
}

async function openProbe(page: Page, title: string, n: number, prepare?: () => void) {
	(prepare ?? (() => void sessionWithSubagents(n, title, {})))();
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, title, `assignment-probe-${n}`);
	return { tap, liveId, frame: (f: Frame) => tap.push({ t: "frame", liveId, frame: f } as Msg) };
}

test.beforeEach(async ({ context }) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
});

test.describe("on the task card", () => {
	test("while its call runs and when it returns: each subagent opens to its task and the shared context", async ({
		page,
	}) => {
		const { frame } = await openProbe(page, "Assignment card live", 0xa1);
		frame({
			type: "message_start",
			messageId: "m-assignment",
			message: { role: "assistant", content: [{ type: "toolCall", id: CALL, name: "task", arguments: TASK_ARGS }] },
		});
		frame({ type: "tool_execution_start", toolCallId: CALL, toolName: "task", args: TASK_ARGS });
		const c = card(page);
		await expect(c).toHaveCount(1);
		await openCard(c);
		// The call names two of its subagents; the third gets its id from omp when the call returns.
		await expectCardItems(page, c, ["Alpha", "Beta", null]);
		await expect(c.getByTestId("task-item").nth(2)).toContainText("Subagent 3");

		frame({
			type: "tool_execution_end",
			toolCallId: CALL,
			toolName: "task",
			isError: false,
			result: { content: [{ type: "text", text: SPAWNED_TEXT }], details: TASK_DETAILS },
		});
		await expect(c.getByTestId("task-item").nth(2)).toContainText(UNNAMED_ID);
		await expect.poll(() => itemNames(c)).toEqual(["Alpha", "Beta", UNNAMED_ID]);
		// What was open stays open: a subagent opened by hand keeps its card open when the call ends.
		await expect(c.locator("button[aria-expanded]").first()).toHaveAttribute("aria-expanded", "true");
		await expect(c.getByTestId("assignment")).toHaveCount(1);
	});

	test("a running task card that nobody read in folds when its call returns, like any tool card", async ({ page }) => {
		const { frame } = await openProbe(page, "Assignment card untouched", 0xa9);
		frame({
			type: "message_start",
			messageId: "m-untouched",
			message: { role: "assistant", content: [{ type: "toolCall", id: CALL, name: "task", arguments: TASK_ARGS }] },
		});
		frame({ type: "tool_execution_start", toolCallId: CALL, toolName: "task", args: TASK_ARGS });
		const c = card(page);
		const header = c.locator("button[aria-expanded]").first();
		await expect(header).toHaveAttribute("aria-expanded", "true");
		await expect(c.getByTestId("task-item")).toHaveCount(3);
		await expect(c.locator("pre", { hasText: '"tasks"' })).toHaveCount(0);
		frame({
			type: "tool_execution_end",
			toolCallId: CALL,
			toolName: "task",
			isError: false,
			result: { content: [{ type: "text", text: SPAWNED_TEXT }], details: TASK_DETAILS },
		});
		await expect(header).toHaveAttribute("aria-expanded", "false");
		await expect(c.getByTestId("task-item")).toHaveCount(0);
	});

	test("after a reload, from the session file: the same subagents with the same text", async ({ page }) => {
		const title = "Assignment card file";
		const own = sessionWithSubagents(0xa2, title, {});
		appendTaskTurn(own, 0xa2, CALL);
		await page.goto("/");
		await sessionRow(page, title).click();
		await expect(card(page)).toHaveCount(1);
		await openCard(card(page));
		await expectCardItems(page, card(page), ["Alpha", "Beta", UNNAMED_ID]);

		await page.reload();
		await sessionRow(page, title).click();
		await expect(card(page)).toHaveCount(1);
		await openCard(card(page));
		await expectCardItems(page, card(page), ["Alpha", "Beta", UNNAMED_ID]);
	});
});

test.describe("in the Agents tab", () => {
	const item = (page: Page, id: string) => page.locator(`[data-testid="subagent-item"][data-agent-id="${id}"]`);
	const block = (page: Page) => page.getByTestId("subagent-detail").getByTestId("subagent-assignment");
	/** Open the assignment block of the view on screen. */
	async function openBlock(page: Page): Promise<Locator> {
		const b = block(page);
		await expect(b).toBeVisible();
		await b.locator("summary").click();
		await expect(b.getByTestId("assignment-task")).toBeVisible();
		return b;
	}

	const BYTES = 100;
	/** Answer `get_subagent_messages` from the records omp has written so far (the spec adds to them as the subagent goes on). */
	function serve(tap: SocketTap, records: Entry[]) {
		const asked: Command[] = [];
		tap.answer("get_subagent_messages", (c) => {
			asked.push(c);
			const from = Math.min(Number(c.fromByte ?? 0), records.length * BYTES);
			return {
				ok: true,
				data: {
					sessionFile: "/virtual/Alpha.jsonl",
					fromByte: from,
					nextByte: records.length * BYTES,
					reset: false,
					entries: records.slice(from / BYTES),
					messages: [],
				},
			};
		});
		return asked;
	}

	test("while it runs: the task from omp's frames at once, the context when its transcript has the record", async ({
		page,
	}) => {
		const { tap, frame } = await openProbe(page, "Assignment agent live", 0xa3);
		const records: Entry[] = [];
		serve(tap, records);
		frame(lifecycle("Alpha", "started", { description: "Alpha work", parentToolCallId: CALL }));
		frame(progress("Alpha", LONG_TASK));
		await page.getByTestId("toggle-panel").click();
		await item(page, "Alpha").click();

		// omp has written nothing yet: the frames carry the task, not the context.
		const b = await openBlock(page);
		await expect(b.getByTestId("assignment-task").getByRole("heading", { name: "Target" })).toBeVisible();
		await expect(b.getByTestId("assignment-context")).toHaveCount(0);

		// Its transcript gets its first records: the context comes, the task stays.
		records.push(...initRecords("Alpha", LONG_TASK, CONTEXT), ...conversationRecords("Alpha", LONG_TASK, "On it."));
		frame({
			type: "subagent_event",
			payload: {
				id: "Alpha",
				event: {
					type: "message_end",
					message: { role: "assistant", content: [{ type: "text", text: "On it." }], timestamp: 1 },
				},
			},
		});
		await expect(b.getByTestId("assignment-context")).toBeVisible({ timeout: 10_000 });
		await expectAlphaAssignment(page, b);
	});

	test("once it is over: the transcript still has the task and the shared context", async ({ page }) => {
		const { tap, frame } = await openProbe(page, "Assignment agent over", 0xa4);
		serve(tap, [...initRecords("Beta", SHORT_TASK, CONTEXT), ...conversationRecords("Beta", SHORT_TASK, "Done.")]);
		frame(lifecycle("Beta", "started", { description: "Beta work", parentToolCallId: CALL }));
		frame(progress("Beta", SHORT_TASK));
		frame(lifecycle("Beta", "completed", { parentToolCallId: CALL }));
		await page.getByTestId("toggle-panel").click();
		await expect(item(page, "Beta")).toHaveAttribute("data-running", "false");
		await item(page, "Beta").click();

		const b = await openBlock(page);
		await expectBetaAssignment(b);
		const context = b.getByTestId("assignment-context");
		await expect(context).toBeVisible();
		await context.getByRole("button", { name: "Shared context", exact: true }).click();
		await expect(context).toContainText("SHARED-CONTRACT-MARKER");
	});

	test("after a reload, from the transcript files: task and context, none where omp wrote none", async ({ page }) => {
		const title = "Assignment agent files";
		const own = sessionWithSubagents(0xa5, title, {});
		writeAssignedTranscript(own.transcript("Alpha"), "Alpha", LONG_TASK, CONTEXT);
		// A subagent given no context has only a task; one from before omp recorded `session_init` has neither.
		writeAssignedTranscript(own.transcript("Beta"), "Beta", SHORT_TASK, undefined);
		writeTranscript(own.transcript("Legacy"), [5]);

		const openAgents = async () => {
			await page.goto("/");
			await sessionRow(page, title).click();
			await page.getByTestId("toggle-panel").click();
		};
		await openAgents();
		await item(page, "Alpha").click();
		const b = await openBlock(page);
		await expectAlphaAssignment(page, b);

		await page.reload();
		await sessionRow(page, title).click();
		await page.getByTestId("toggle-panel").click();
		await item(page, "Beta").click();
		const beta = await openBlock(page);
		await expectBetaAssignment(beta);
		await expect(beta.getByTestId("assignment-context")).toHaveCount(0);

		await page.getByRole("button", { name: "Back to agents" }).click();
		await item(page, "Legacy").click();
		await expect(page.getByTestId("subagent-detail")).toContainText("Worked for 5");
		await expect(block(page)).toHaveCount(0);
	});

	test("the assignment stays pinned at the top while a long transcript is read, and opens in place", async ({
		page,
	}) => {
		const title = "Assignment agent pinned";
		const own = sessionWithSubagents(0xa6, title, {});
		writeLongAssignedTranscript(own.transcript("Alpha"), "Alpha", LONG_TASK, CONTEXT);
		await page.goto("/");
		await sessionRow(page, title).click();
		await page.getByTestId("toggle-panel").click();
		await item(page, "Alpha").click();

		const b = block(page);
		await expect(b).toBeVisible();
		// It is a header of the view, not a part of the transcript that scrolls with it.
		const scroller = page.getByTestId("subagent-scroll");
		expect(await b.evaluate((el) => Boolean(el.closest('[data-testid="subagent-scroll"]')))).toBe(false);

		// The transcript is long enough to scroll: that is the case the assignment has to survive.
		await expect.poll(() => scroller.evaluate((el) => el.scrollHeight > el.clientHeight + 100)).toBe(true);
		await scroller.evaluate((el) => {
			el.scrollTop = el.scrollHeight;
		});
		await expect(b).toBeInViewport();
		await expect(b).toBeVisible();

		// Collapsed it is one line: the word and the first line of the task.
		const summary = b.locator("summary");
		await expect(summary).toHaveText(/Assignment/);
		await expect(summary).toContainText("Worktree `/tmp/alpha`");
		await expect(b.getByTestId("assignment-task")).toHaveCount(0);

		// Opened in place, under the header, it shows the whole assignment.
		await summary.click();
		await expect(b.getByTestId("assignment-task")).toBeVisible();
		await expect(b.getByTestId("assignment-task").getByRole("heading", { name: "Target" })).toBeVisible();
		await expect(b.getByTestId("assignment-context")).toHaveCount(1);
		// It does not cover the transcript: the transcript is still there under it, and still scrolls.
		await expect(scroller).toBeVisible();
		expect(
			await b.evaluate((el) => {
				const sc = el.closest('[data-testid="subagent-detail"]')?.querySelector('[data-testid="subagent-scroll"]');
				if (!sc) return false;
				// The transcript starts below the header: the two do not overlap.
				return sc.getBoundingClientRect().top >= el.getBoundingClientRect().bottom - 1;
			}),
		).toBe(true);
	});

	test("on a phone the assignment is pinned too, and opens without taking the screen", async ({ page }) => {
		const title = "Assignment agent phone";
		const own = sessionWithSubagents(0xa7, title, {});
		writeLongAssignedTranscript(own.transcript("Alpha"), "Alpha", LONG_TASK, CONTEXT);
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto("/");
		// On a phone the sidebar is a drawer: it has to be opened to reach the conversation.
		await openSidebar(page);
		await sessionRow(page, title).click();
		// The panel is a sheet over the conversation on a phone.
		await page.getByTestId("toggle-panel").click();
		await item(page, "Alpha").click();

		const b = block(page);
		await expect(b).toBeVisible();
		const scroller = page.getByTestId("subagent-scroll");
		await expect.poll(() => scroller.evaluate((el) => el.scrollHeight > el.clientHeight + 100)).toBe(true);
		await scroller.evaluate((el) => {
			el.scrollTop = el.scrollHeight;
		});
		// Pinned: it is still on screen at the bottom of the transcript.
		await expect(b).toBeInViewport();

		// Opened, it takes at most a part of the screen: the transcript is still there under it.
		await b.locator("summary").click();
		await expect(b.getByTestId("assignment-task")).toBeVisible();
		const height = (await b.boundingBox())?.height ?? 0;
		expect(height).toBeLessThanOrEqual(844 * 0.5);
		await expect(scroller).toBeVisible();
	});

	/** Open Alpha, whose transcript is long, in the side panel of a conversation of its own, with the window at `size`. */
	async function openLongAlpha(page: Page, n: number, size: { width: number; height: number }) {
		const title = `Assignment agent long ${n.toString(16)}`;
		const own = sessionWithSubagents(n, title, {});
		writeLongAssignedTranscript(own.transcript("Alpha"), "Alpha", LONG_TASK, CONTEXT);
		await page.setViewportSize(size);
		await page.goto("/");
		// Below 900px the sidebar is a drawer: it has to be opened to reach the conversation.
		if (size.width <= 900) await openSidebar(page);
		await sessionRow(page, title).click();
		await page.getByTestId("toggle-panel").click();
		await item(page, "Alpha").click();
		const scroller = page.getByTestId("subagent-scroll");
		await expect.poll(() => scroller.evaluate((el) => el.scrollHeight > el.clientHeight + 100)).toBe(true);
		return scroller;
	}

	for (const [name, size, n] of [
		["a phone in landscape", { width: 667, height: 375 }, 0x4a],
		["a phone in portrait", { width: 375, height: 667 }, 0x4b],
	] as const) {
		test(`opened on ${name}, the assignment leaves the transcript room to read (#512)`, async ({ page }) => {
			const scroller = await openLongAlpha(page, n, size);
			const closed = (await scroller.boundingBox())?.height ?? 0;
			const b = block(page);
			await b.locator("summary").click();
			const task = b.getByTestId("assignment-task");
			await expect(task).toBeVisible();
			// The transcript keeps room for several lines, not one: the assignment gives way to it.
			await expect.poll(async () => (await scroller.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(96);
			const [head, body] = await Promise.all([b.boundingBox(), scroller.boundingBox()]);
			expect(body?.y ?? 0).toBeGreaterThanOrEqual((head?.y ?? 0) + (head?.height ?? 0) - 1);
			expect(body?.height ?? 0).toBeLessThanOrEqual(closed);
			// What does not fit is reached by scrolling: the last line of the task can be read.
			await task.getByTestId("assignment-more").click();
			const mark = task.getByText("ALPHA-ACCEPTANCE-MARKER");
			await mark.scrollIntoViewIfNeeded();
			await expect(mark).toBeInViewport({ ratio: 1 });
		});
	}

	test("opening or closing the assignment at the end of the transcript keeps the end in view (#513)", async ({
		page,
	}) => {
		const scroller = await openLongAlpha(page, 0x4c, { width: 1400, height: 900 });
		const last = scroller.getByText("WORK-STEP-39");
		const jump = page.getByRole("button", { name: "Jump to latest" });
		/** The last message is inside the scroller's box, not below its fold. */
		const lastShown = async () => {
			const [box, mark] = await Promise.all([scroller.boundingBox(), last.boundingBox()]);
			return !!box && !!mark && mark.y + mark.height <= box.y + box.height + 1;
		};
		await scroller.evaluate((el) => {
			el.scrollTop = el.scrollHeight;
		});
		await expect.poll(lastShown).toBe(true);
		await expect(jump).toHaveCount(0);

		const b = block(page);
		await b.locator("summary").click();
		await expect(b.getByTestId("assignment-task")).toBeVisible();
		await expect.poll(lastShown).toBe(true);
		await expect(jump).toHaveCount(0);

		await b.locator("summary").click();
		await expect(b.getByTestId("assignment-task")).toHaveCount(0);
		await expect.poll(lastShown).toBe(true);
		await expect(jump).toHaveCount(0);
	});

	test("opening the assignment while the reader is further up leaves the place they read at (#513)", async ({
		page,
	}) => {
		const scroller = await openLongAlpha(page, 0x4d, { width: 1400, height: 900 });
		const jump = page.getByRole("button", { name: "Jump to latest" });
		await scroller.evaluate((el) => {
			el.scrollTop = 300;
		});
		// Reading further up: Jump to latest says so, and nothing takes the reader back down.
		await expect(jump).toBeVisible();
		const b = block(page);
		await b.locator("summary").click();
		await expect(b.getByTestId("assignment-task")).toBeVisible();
		// Two frames later: whatever re-pins a view at its end has nothing to do with this one.
		await page.evaluate(async () => {
			for (let i = 0; i < 2; i++) {
				const { promise, resolve } = Promise.withResolvers<void>();
				requestAnimationFrame(() => resolve());
				await promise;
			}
		});
		expect(await scroller.evaluate((el) => el.scrollTop)).toBe(300);
		await expect(jump).toBeVisible();
	});
});
