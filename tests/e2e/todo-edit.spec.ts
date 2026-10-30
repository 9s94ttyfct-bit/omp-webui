import { openSidebar, ownSession, startLive } from "../support/live.ts";
import { topTab } from "../support/panel.ts";
import { type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { expect, type Locator, type Page, test } from "./fixtures.ts";

/**
 * Editing the todo list from the web UI, against the real omp and no model call: the state icon, the task and phase
 * menus, the fields and the Markdown dialog change the list, and the list shown is the one omp reports afterwards
 * (`get_state`), which applies its own rule that one task is in progress. Failures are patched in at the HTTP edge.
 */

interface Task {
	content: string;
	status: string;
	blocker?: string;
}
interface Phase {
	name: string;
	tasks: Task[];
}

/**
 * The list omp last reported to the page. A read the page makes by itself is refused while the conversation is paused
 * (`todos_changed` asks for one after every edit, and it can land after the editor's own read): such a reply has no state.
 */
const reported = (tap: SocketTap): Phase[] => {
	const last = tap
		.replies("get_state")
		.findLast((r) => Array.isArray((r as { todoPhases?: unknown } | undefined)?.todoPhases));
	return (last as { todoPhases?: Phase[] } | undefined)?.todoPhases ?? [];
};

async function open(page: Page, n: number, probe: string) {
	const title = `Todo edit probe ${probe}`;
	ownSession(n, title);
	// Auto-titling would send a prompt to the model when a turn ends.
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	await openSidebar(page);
	const liveId = await startLive(page, tap, title, `todo-edit-${probe}`);
	await page.getByTestId("toggle-panel").click();
	await topTab(page, /^Todos/).click();
	return { tap, liveId, panel: page.getByRole("tabpanel", { name: /Todos/ }) };
}

const taskRow = (panel: Locator, text: string) => panel.getByTestId("todo-task").filter({ hasText: text });
const phaseOf = (panel: Locator, name: string) =>
	panel.getByTestId("todo-phase").filter({ has: panel.page().getByText(name, { exact: true }) });

/** Type into the field that is open and press Enter. */
async function enter(panel: Locator, label: string, text: string) {
	const field = panel.getByTestId("todo-entry").getByLabel(label);
	await field.fill(text);
	await field.press("Enter");
}

test("a list is built and changed with the state icon, the menus and the fields, and omp's list is what shows", async ({
	page,
}) => {
	const { tap, panel } = await open(page, 0x7a, "a");
	await expect(panel.getByText("No todos")).toBeVisible();
	await expect(page.getByTestId("todo-strip")).toHaveCount(0);

	// The empty state starts a list: omp's default phase takes the task, and omp makes the first one in progress.
	await panel.getByTestId("todo-add-task").click();
	await enter(panel, "New task", "Write the parser");
	await expect(panel.getByTestId("todo-task")).toHaveCount(1);
	await expect(taskRow(panel, "Write the parser")).toHaveAttribute("data-status", "in_progress");
	expect(reported(tap)).toEqual([{ name: "Todos", tasks: [{ content: "Write the parser", status: "in_progress" }] }]);

	await panel.getByTestId("todo-add-task").click();
	await enter(panel, "New task", "Wire the strip");
	await expect(taskRow(panel, "Wire the strip")).toHaveAttribute("data-status", "pending");

	// A new phase, and a task added to it from its menu.
	await panel.getByTestId("todo-add-phase").click();
	await enter(panel, "Phase name", "Ship");
	await expect(panel.getByTestId("todo-phase")).toHaveCount(2);
	await phaseOf(panel, "Ship").getByTestId("todo-phase-menu").click();
	await page.getByTestId("todo-phase-add-task").click();
	await enter(panel, "New task", "Deploy");
	await expect(phaseOf(panel, "Ship").getByTestId("todo-task")).toHaveCount(1);

	// The state icon finishes a task; omp keeps the other one in progress.
	await taskRow(panel, "Wire the strip").getByTestId("todo-status-button").click();
	await expect(taskRow(panel, "Wire the strip")).toHaveAttribute("data-status", "completed");
	await expect(taskRow(panel, "Wire the strip").getByTestId("todo-status-button")).toHaveAccessibleName(
		"Reopen: Wire the strip",
	);

	// Blocked asks what it is blocked on.
	await taskRow(panel, "Deploy").getByTestId("todo-task-menu").click();
	await page.getByTestId("todo-set-blocked").click();
	await enter(panel, "What is it blocked on? (optional)", "the credentials");
	await expect(taskRow(panel, "Deploy")).toHaveAttribute("data-status", "blocked");
	await expect(taskRow(panel, "Deploy").getByTestId("todo-blocker")).toHaveText("Blocked: the credentials");

	// Text edit, then order.
	await taskRow(panel, "Write the parser").getByTestId("todo-task-menu").click();
	await page.getByTestId("todo-edit-text").click();
	await enter(panel, "Task text", "Write the parser v2");
	await expect(taskRow(panel, "Write the parser v2")).toBeVisible();
	await taskRow(panel, "Write the parser v2").getByTestId("todo-task-menu").click();
	await page.getByTestId("todo-move-down").click();
	await expect(phaseOf(panel, "Todos").getByTestId("todo-task-text")).toHaveText([
		"Wire the strip",
		"Write the parser v2",
	]);

	expect(reported(tap)).toEqual([
		{
			name: "Todos",
			tasks: [
				{ content: "Wire the strip", status: "completed" },
				{ content: "Write the parser v2", status: "in_progress" },
			],
		},
		{ name: "Ship", tasks: [{ content: "Deploy", status: "blocked", blocker: "the credentials" }] },
	]);

	// The strip above the composer offers the same edits. It is not drawn while a pane shows the Todos tab, so the pane is folded.
	await page.getByTestId("pane-fold-top").click();
	const strip = page.getByTestId("todo-strip");
	await expect(strip.getByTestId("todo-progress")).toHaveText("1/3");
	await strip.getByTestId("todo-toggle").click();
	await strip
		.getByTestId("todo-expanded")
		.locator('[data-testid="todo-task"]', { hasText: "Wire the strip" })
		.getByTestId("todo-status-button")
		.click();
	await expect(strip.getByTestId("todo-progress")).toHaveText("0/3");
	await page.getByTestId("pane-fold-top").click();
	await expect(strip).toHaveCount(0);
	await expect(taskRow(panel, "Wire the strip")).toHaveAttribute("data-status", "pending");

	// Removing a task, and a phase.
	await taskRow(panel, "Wire the strip").getByTestId("todo-task-menu").click();
	await page.getByTestId("todo-remove-task").click();
	await expect(panel.getByTestId("todo-task")).toHaveCount(2);
	await phaseOf(panel, "Ship").getByTestId("todo-phase-menu").click();
	await page.getByTestId("todo-phase-remove").click();
	await expect(panel.getByTestId("todo-phase")).toHaveCount(1);
	expect(reported(tap)).toEqual([
		{ name: "Todos", tasks: [{ content: "Write the parser v2", status: "in_progress" }] },
	]);
});

test("Escape closes a field without a change; an empty one is not saved", async ({ page }) => {
	const { tap, panel } = await open(page, 0x7b, "b");
	await panel.getByTestId("todo-add-task").click();
	const field = panel.getByTestId("todo-entry").getByLabel("New task");
	await expect(field).toBeFocused();
	await field.press("Enter");
	await expect(field).toBeVisible();
	await field.press("Escape");
	await expect(panel.getByTestId("todo-entry")).toHaveCount(0);
	// Escape stayed with the field: the panel itself is still open.
	await expect(page.getByTestId("right-panel")).toBeVisible();
	expect(tap.replies("get_state").some((s) => ((s as { todoPhases?: unknown[] }).todoPhases ?? []).length > 0)).toBe(
		false,
	);
	await expect(panel.getByText("No todos")).toBeVisible();
});

test("the Markdown dialog shows the list as omp writes it, applies an edit, and shows omp's error for a line it cannot read", async ({
	page,
}) => {
	const { tap, panel } = await open(page, 0x7c, "c");
	await panel.getByTestId("todo-edit-markdown").click();
	const area = page.getByTestId("todo-markdown");
	await expect(area).toHaveValue("");
	await area.fill("# Docs\n- [x] Write\n- [ ] Review\n- [!] Publish <!-- blocker: legal -->\n");
	await page.getByTestId("todo-markdown-save").click();
	await expect(area).toHaveCount(0);
	await expect(panel.getByTestId("todo-task")).toHaveCount(3);
	await expect(taskRow(panel, "Review")).toHaveAttribute("data-status", "in_progress");
	await expect(taskRow(panel, "Publish").getByTestId("todo-blocker")).toHaveText("Blocked: legal");

	// What the dialog shows now is the list as omp reports it, in omp's own format.
	await panel.getByTestId("todo-edit-markdown").click();
	await expect(area).toHaveValue("# Docs\n- [x] Write\n- [/] Review\n- [!] Publish <!-- blocker: legal -->\n");
	await area.fill("# Docs\n- [?] odd\nnot a task\n");
	await page.getByTestId("todo-markdown-save").click();
	const error = page.getByTestId("todo-markdown-error");
	await expect(error).toContainText('unknown status marker "[?]"');
	await expect(error).toContainText('unrecognized syntax "not a task"');
	await expect(area).toBeVisible();
	await page.getByRole("button", { name: "Cancel" }).click();
	await expect(area).toHaveCount(0);
	expect(reported(tap)[0].tasks.map((t) => t.content)).toEqual(["Write", "Review", "Publish"]);
});

test("a paused conversation takes an edit and stays paused", async ({ page }) => {
	const { tap, panel } = await open(page, 0x7a + 0x10, "d");
	await panel.getByTestId("todo-add-task").click();
	await enter(panel, "New task", "Frozen task");
	await expect(taskRow(panel, "Frozen task")).toHaveAttribute("data-status", "in_progress");

	// The pause button shows while omp is doing something: a command that takes a while.
	const composer = page.getByTestId("composer");
	await composer.fill("!/bin/sleep 12");
	await composer.press("Enter");
	await page.getByTestId("pause").click();
	await expect(page.getByTestId("paused-banner")).toBeVisible();
	await taskRow(panel, "Frozen task").getByTestId("todo-status-button").click();
	await expect(taskRow(panel, "Frozen task")).toHaveAttribute("data-status", "completed");
	await expect(page.getByTestId("paused-banner")).toBeVisible();
	expect(reported(tap)[0].tasks).toEqual([{ content: "Frozen task", status: "completed" }]);
	await page.getByTestId("paused-banner").getByRole("button", { name: "Resume" }).click();
	await expect(page.getByTestId("paused-banner")).toHaveCount(0);
});

test("a change that fails is said and leaves the list as it was", async ({ page }) => {
	const { panel } = await open(page, 0x7a + 0x11, "e");
	await panel.getByTestId("todo-add-task").click();
	await enter(panel, "New task", "Keep me");
	await expect(taskRow(panel, "Keep me")).toHaveAttribute("data-status", "in_progress");

	await page.route("**/api/controls/todos", (route) =>
		route.fulfill({ status: 422, json: { error: "Could not parse the list: nope" } }),
	);
	await taskRow(panel, "Keep me").getByTestId("todo-status-button").click();
	await expect(page.getByTestId("toast")).toContainText(
		"Couldn’t change the todo list: Could not parse the list: nope",
	);
	await expect(taskRow(panel, "Keep me")).toHaveAttribute("data-status", "in_progress");
	await expect(taskRow(panel, "Keep me").getByTestId("todo-status-button")).toBeEnabled();
});

test("a field closes when the list moves on beneath it, instead of landing its text on another task", async ({
	page,
}) => {
	const { tap, liveId, panel } = await open(page, 0x7a + 0x12, "f");
	await panel.getByTestId("todo-add-task").click();
	await enter(panel, "New task", "Keep me");
	await expect(taskRow(panel, "Keep me")).toBeVisible();

	await taskRow(panel, "Keep me").getByTestId("todo-task-menu").click();
	await page.getByTestId("todo-edit-text").click();
	await expect(panel.getByTestId("todo-entry").getByLabel("Task text")).toHaveValue("Keep me");

	// The model rewrites the list (the page asks for it again when the todo tool has run).
	tap.answer("get_state", () => ({
		ok: true,
		data: { todoPhases: [{ name: "Todos", tasks: [{ content: "Something else", status: "in_progress" }] }] },
	}));
	tap.push({
		t: "frame",
		liveId,
		frame: { type: "tool_execution_end", toolCallId: "todo-x", toolName: "todo", result: {} },
	});
	await expect(taskRow(panel, "Something else")).toBeVisible();
	await expect(panel.getByTestId("todo-entry")).toHaveCount(0);
});
