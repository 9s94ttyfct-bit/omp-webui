import { boxOf } from "../support/geometry.ts";
import { openSidebar, ownSession, startLive } from "../support/live.ts";
import { rpcState } from "../support/rpc-state.ts";
import { type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The TUI's TODO panel on the web: a strip next to the goal bar with the progress and the task in progress (a click
 * opens the list), a row for omp's reminder to finish the list, and counts and blocker reasons in the Todos tab. The
 * list arrives the way omp reports it, in `get_state`, which the page asks for again when the todo tool has run;
 * the frames are pushed through the socket tap, so no model call is made.
 */

interface Task {
	content: string;
	status: string;
	blocker?: string;
}
const research = {
	name: "Research",
	tasks: [
		{ content: "Read the docs", status: "completed" },
		{ content: "Try the API", status: "abandoned" },
	],
};
const build = (tasks: Task[]) => ({ name: "Build", tasks });
const WORKING = build([
	{ content: "Write the parser", status: "in_progress" },
	{ content: "Wire the strip", status: "pending" },
	{ content: "Deploy", status: "blocked", blocker: "waiting for the credentials" },
]);

interface Running {
	tap: SocketTap;
	frame: (f: Record<string, unknown>) => void;
	/** Answer `get_state` with this list, and make the page ask the way it does when the todo tool has run. */
	setTodos: (phases: unknown[]) => void;
}

async function open(page: Page, n: number, probe: string): Promise<Running> {
	const title = `Todo strip probe ${probe}`;
	ownSession(n, title);
	// Auto-titling would send a prompt to the model when a pushed turn ends.
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	await openSidebar(page);
	const liveId = await startLive(page, tap, title, `todo-probe-${probe}`);
	const frame = (f: Record<string, unknown>) => tap.push({ t: "frame", liveId, frame: f });
	const setTodos = (phases: unknown[]) => {
		tap.answer("get_state", () => ({ ok: true, data: rpcState({ todoPhases: phases }) }));
		frame({ type: "tool_execution_end", toolCallId: `todo-${Math.random()}`, toolName: "todo", result: {} });
	};
	return { tap, frame, setTodos };
}

test("a strip shows how far the list is and the task in progress; a click opens the whole list with its blockers", async ({
	page,
}) => {
	const { setTodos } = await open(page, 0x30, "a");
	await expect(page.getByTestId("todo-strip")).toHaveCount(0);
	setTodos([research, WORKING]);

	const strip = page.getByTestId("todo-strip");
	await expect(strip).toBeVisible();
	await expect(strip.getByTestId("todo-progress")).toHaveText("2/5");
	await expect(strip.getByTestId("todo-current")).toHaveText("Write the parser");
	await expect(strip.getByTestId("todo-current")).toHaveAttribute("data-status", "in_progress");
	await expect(strip.getByTestId("todo-phase-name")).toHaveText("Build");
	await expect(strip.getByTestId("todo-blocked-badge")).toHaveText("1 blocked");
	// The list is a click away, not in the way.
	await expect(strip.getByTestId("todo-expanded")).toHaveCount(0);
	const toggle = strip.getByTestId("todo-toggle");
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-expanded", "true");

	const list = strip.getByTestId("todo-expanded");
	await expect(list.getByTestId("todo-summary")).toHaveText("2 of 5 done");
	await expect(list.getByTestId("todo-phase")).toHaveCount(2);
	await expect(list.getByTestId("todo-phase-count")).toHaveText(["2/2", "0/3"]);
	await expect(list.getByTestId("todo-task")).toHaveCount(5);
	const deploy = list.getByTestId("todo-task").filter({ hasText: "Deploy" });
	await expect(deploy).toHaveAttribute("data-status", "blocked");
	await expect(deploy.getByTestId("todo-blocker")).toHaveText("Blocked: waiting for the credentials");
	await toggle.click();
	await expect(strip.getByTestId("todo-expanded")).toHaveCount(0);
});

test("the strip follows the list as the todo tool changes it, and shows a blocked task when nothing else is open", async ({
	page,
}) => {
	const { setTodos } = await open(page, 0x31, "b");
	setTodos([research, WORKING]);
	const strip = page.getByTestId("todo-strip");
	await expect(strip.getByTestId("todo-progress")).toHaveText("2/5");

	setTodos([
		research,
		build([
			{ content: "Write the parser", status: "completed" },
			{ content: "Wire the strip", status: "in_progress" },
			{ content: "Deploy", status: "blocked", blocker: "waiting for the credentials" },
		]),
	]);
	await expect(strip.getByTestId("todo-progress")).toHaveText("3/5");
	await expect(strip.getByTestId("todo-current")).toHaveText("Wire the strip");

	setTodos([
		research,
		build([
			{ content: "Write the parser", status: "completed" },
			{ content: "Wire the strip", status: "completed" },
			{ content: "Deploy", status: "blocked", blocker: "waiting for the credentials" },
		]),
	]);
	await expect(strip.getByTestId("todo-progress")).toHaveText("4/5");
	await expect(strip.getByTestId("todo-current")).toHaveText("Deploy");
	await expect(strip.getByTestId("todo-current")).toHaveAttribute("data-status", "blocked");
});

test("omp's reminder shows as a row until the turn it asked for ends", async ({ page }) => {
	const { frame, setTodos } = await open(page, 0x32, "c");
	setTodos([research, WORKING]);
	await expect(page.getByTestId("todo-strip")).toBeVisible();
	await expect(page.getByTestId("todo-reminder")).toHaveCount(0);

	frame({ type: "agent_start" });
	frame({
		type: "todo_reminder",
		todos: [
			{ content: "Write the parser", status: "in_progress" },
			{ content: "Wire the strip", status: "pending" },
		],
		attempt: 1,
		maxAttempts: 3,
	});
	const reminder = page.getByTestId("todo-reminder");
	await expect(reminder).toHaveText("2 incomplete todos - reminder 1/3");
	await expect(reminder).toHaveAttribute("title", "Write the parser\nWire the strip");
	// The stop that was reminded is not the end; the turn it asked for runs.
	frame({ type: "agent_end", isTerminal: false });
	frame({ type: "agent_start" });
	await expect(reminder).toBeVisible();
	frame({ type: "agent_end", isTerminal: true });
	await expect(reminder).toHaveCount(0);
	// The list itself stays: it is not finished.
	await expect(page.getByTestId("todo-progress")).toHaveText("2/5");

	// One todo left is said in the singular.
	frame({ type: "agent_start" });
	frame({
		type: "todo_reminder",
		todos: [{ content: "Deploy", status: "blocked" }],
		attempt: 2,
		maxAttempts: 3,
	});
	await expect(reminder).toHaveText("1 incomplete todo - reminder 2/3");
});

test("a finished list shows All done while its turn runs, then goes; omp clearing it takes it away", async ({
	page,
}) => {
	const { tap, frame, setTodos } = await open(page, 0x33, "d");
	const finished = [research, build([{ content: "Write the parser", status: "completed" }])];
	frame({ type: "agent_start" });
	setTodos(finished);
	const strip = page.getByTestId("todo-strip");
	await expect(strip.getByTestId("todo-current")).toHaveText("All done");
	await expect(strip.getByTestId("todo-progress")).toHaveText("3/3");
	frame({ type: "agent_end", isTerminal: true });
	await expect(strip).toHaveCount(0);

	// omp clears a finished list after a while (`todo_auto_clear`) and then reports none.
	frame({ type: "agent_start" });
	await expect(strip).toBeVisible();
	tap.answer("get_state", () => ({ ok: true, data: rpcState({ todoPhases: [] }) }));
	frame({ type: "todo_auto_clear" });
	await expect(strip).toHaveCount(0);
});

test("the Todos tab shows the counts and the reason a task is blocked, and the strip opens it", async ({ page }) => {
	const { setTodos } = await open(page, 0x34, "e");
	setTodos([research, WORKING]);
	await page.getByTestId("todo-open-panel").click();

	await expect(page.getByTestId("right-panel")).toBeVisible();
	// A pane shows it (the lower one, as the panel opens): the strip is not above the composer then.
	const tab = page.getByRole("tab", { name: /^Todos/, selected: true });
	await expect(tab).toBeVisible();
	await expect(tab).toHaveAccessibleName("Todos 2/5");
	const panel = page.getByRole("tabpanel", { name: /Todos/ });
	await expect(panel.getByTestId("todo-summary")).toHaveText("2 of 5 done");
	await expect(panel.getByTestId("todo-blocked-count")).toHaveText("· 1 blocked");
	await expect(panel.getByTestId("todo-phase-count")).toHaveText(["2/2", "0/3"]);
	await expect(panel.getByTestId("todo-blocker")).toHaveText("Blocked: waiting for the credentials");
	// A finished task is struck through; the state is also said in words for a screen reader.
	const done = panel.getByTestId("todo-task").filter({ hasText: "Read the docs" });
	await expect(done).toHaveAttribute("data-status", "completed");
	await expect(done).toContainText("(Done)");
});

test.describe("phone", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("the strip fits the screen and its toggle is a target a finger can hit", async ({ page }) => {
		const { setTodos } = await open(page, 0x35, "f");
		setTodos([research, WORKING]);
		const strip = page.getByTestId("todo-strip");
		await expect(strip).toBeVisible();
		const box = await boxOf(strip);
		expect(box.x).toBeGreaterThanOrEqual(0);
		expect(box.x + box.width).toBeLessThanOrEqual(390);
		expect((await boxOf(page.getByTestId("todo-toggle"))).height).toBeGreaterThanOrEqual(24);
		await strip.getByTestId("todo-toggle").click();
		await expect(strip.getByTestId("todo-expanded")).toBeVisible();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no sideways scroll").toBe(
			true,
		);
	});
});
