import { appendFileSync } from "node:fs";
import * as omp from "../support/omp-frames.ts";
import { topTab } from "../support/panel.ts";
import { lag, other, SIDES, type Side, show, startWorld, type World } from "../support/two-pages.ts";
import { expect, type Locator, type Page, test } from "./fixtures.ts";

/**
 * A page that opens a conversation while its main agent is inside a long tool call (a `task` that waits for its
 * subagents, a `wait` for a background one) with a subagent running (#598): the tool is shown as running (not as one
 * "still running when this conversation stopped"), the running subagent is in the Agents tab, and what omp prints when
 * the tool goes on and returns reaches the page — on the Mac app's window and through the tunnel, whichever page started
 * the turn, whether the page opened the conversation before the tool began, after, or lost its connection while it ran.
 */

let world: World;
test.beforeAll(async () => {
	world = await startWorld();
});
test.afterAll(async () => {
	await world?.stop();
});

type Tool = "task" | "wait";
const TOOLS: readonly Tool[] = ["task", "wait"];

/** The sort of tool call each makes: `task` runs the subagent itself, `wait` waits for one an earlier `task` left running. */
const CALL: Record<Tool, { id: string; arguments: unknown }> = {
	task: { id: "call_task", arguments: { tasks: [{ id: "Scout", assignment: "Look at the config files" }] } },
	wait: { id: "call_wait", arguments: { ids: ["Scout"] } },
};

const REPLY = "The scout found nothing odd";

/** The way a page reaches the server: next door, and across the world (what the page says on its socket leaves 250 ms late, see `lag`). */
const LINKS = [
	{ words: "", ms: 0 },
	{ words: " over a slow link", ms: 250 },
] as const;

/** Each conversation of the spec has a file of its own. */
let seeds = 40;
const nextSeed = () => seeds++;

/** omp's registry entry of a subagent that runs (`get_subagents`), as its lifecycle frame described it. */
const registered = (id: string, index: number, parentToolCallId: string) => ({
	id,
	agent: "explore",
	index,
	description: `probe ${id}`,
	assignment: `Work for ${id}`,
	parentToolCallId,
	status: "running",
	progress: { id, status: "running", toolCount: 3, durationMs: 4000, tokens: 150 },
});

/**
 * The turn the acting page started reaches the point a long tool is running: the model's message with the call is
 * written to the file (what a page that opens now reads), the tool has started and has not returned, and one subagent
 * runs. Returns what is needed to say more about the tool and to end it.
 */
async function intoTool(liveId: string, tool: Tool) {
	const call = CALL[tool];
	const callBlock = { type: "toolCall", id: call.id, name: tool, arguments: call.arguments };
	// The subagents belong to the `task` call, which is the tool itself or an earlier one that has returned.
	const parent = "call_task";
	let at = 1;
	if (tool === "wait") {
		const started = { id: parent, name: "task", arguments: { tasks: [{ id: "Scout", assignment: "Look" }] } };
		await world.emit(
			liveId,
			omp.messageStart("m1"),
			...omp.block("m1", "text", 0, ["I will send a scout and wait for it."]),
			omp.toolCall("m1", 1, started),
			omp.messageEnd(
				"m1",
				[
					{ type: "text", text: "I will send a scout and wait for it." },
					{ type: "toolCall", ...started },
				],
				"toolUse",
			),
			omp.toolStart(parent, "task", started.arguments),
			omp.subagentStarted("Scout", parent, 0, "Work for Scout"),
			omp.toolEnd(parent, "task", "Scout runs in the background."),
			omp.toolResultMessage("r1", parent, "task", "Scout runs in the background."),
		);
		at = 2;
	}
	const id = `m${at}`;
	await world.emit(
		liveId,
		omp.messageStart(id),
		...omp.block(id, "text", 0, ["Now I wait."]),
		omp.toolCall(id, 1, { id: call.id, name: tool, arguments: call.arguments }),
		omp.messageEnd(id, [{ type: "text", text: "Now I wait." }, callBlock], "toolUse"),
		omp.toolStart(call.id, tool, call.arguments),
	);
	if (tool === "task") await world.emit(liveId, omp.subagentStarted("Scout", call.id, 0, "Work for Scout"));
	await world.emit(liveId, omp.subagentProgress("Scout", 0, 3));
	const running = [registered("Scout", 0, tool === "task" ? call.id : parent)];
	await world.state(liveId, { subagents: running });
	return {
		/** A second subagent starts. */
		async startMapper() {
			const owner = tool === "task" ? call.id : parent;
			running.push(registered("Mapper", 1, owner));
			await world.state(liveId, { subagents: running });
			await world.emit(
				liveId,
				omp.subagentStarted("Mapper", owner, 1, "Work for Mapper"),
				omp.subagentProgress("Mapper", 1, 1),
			);
		},
		/** The tool prints more of what it has to say (all of it so far, as omp sends it). */
		async print(text: string) {
			await world.emit(liveId, omp.toolUpdate(call.id, tool, text));
		},
		/** The tool returns, every subagent is over, and the model writes its reply. */
		async end() {
			await world.state(liveId, { subagents: [] });
			await world.emit(
				liveId,
				...running.map((s) => omp.subagentEnded(s.id)),
				omp.toolEnd(call.id, tool, "All done."),
				omp.toolResultMessage(`r${at}`, call.id, tool, "All done."),
				omp.messageStart(`m${at + 1}`),
				...omp.block(`m${at + 1}`, "text", 0, [REPLY]),
				omp.messageEnd(`m${at + 1}`, [{ type: "text", text: REPLY }]),
			);
			await world.finish(liveId);
		},
	};
}

const card = (page: Page, tool: Tool): Locator => page.locator(`[data-testid="tool-card"][data-tool="${tool}"]`).last();
const subagent = (page: Page, id: string): Locator =>
	page.locator(`[data-testid="subagent-item"][data-agent-id="${id}"]`);

/** The marks of a conversation that stopped inside a tool. */
const STOPPED_MARKS = ["interrupted-note", "tool-interrupted", "resume-button"];

/** Notes in the page each mark of a stopped conversation that gets on screen, however briefly (see `neverStopped`). */
function noteStoppedMarks(marks: string[]): void {
	const seen = new Set<string>();
	window.stoppedMarksSeen = seen;
	const look = () => {
		for (const m of marks) if (document.querySelector(`[data-testid="${m}"]`)) seen.add(m);
	};
	new MutationObserver(look).observe(document, { subtree: true, childList: true, attributes: true });
	look();
}

/** From now on the page notes the marks of a stopped conversation. */
async function watchForStopped(page: Page): Promise<void> {
	await page.evaluate(noteStoppedMarks, STOPPED_MARKS);
}

/** From the first moment of the next document the page loads (a reload), it notes them. */
async function watchFromLoad(page: Page): Promise<void> {
	await page.context().addInitScript(noteStoppedMarks, STOPPED_MARKS);
}

/** The page showed none of the marks of a stopped conversation since `watchForStopped`. */
async function neverStopped(page: Page): Promise<void> {
	expect(await page.evaluate(() => [...(window.stoppedMarksSeen ?? [])])).toEqual([]);
}

declare global {
	interface Window {
		stoppedMarksSeen?: Set<string>;
	}
}

/** What a page shows while the tool runs and the scout works. */
async function expectRunning(page: Page, tool: Tool): Promise<void> {
	// The conversation is running: Stop is offered, and nothing says it stopped.
	await expect(page.getByTestId("stop")).toBeVisible();
	await expect(card(page, tool)).toBeVisible();
	await expect(card(page, tool).locator("svg.animate-spin")).toBeVisible();
	await expect(card(page, tool).getByTestId("tool-interrupted")).toHaveCount(0);
	await expect(page.getByTestId("interrupted-note")).toHaveCount(0);
	await expect(page.getByTestId("resume-button")).toHaveCount(0);
	await showAgents(page);
	await expect(subagent(page, "Scout")).toHaveAttribute("data-running", "true");
}

/** The Agents tab of the page, opened. */
async function showAgents(page: Page): Promise<void> {
	if (!(await page.getByTestId("panel-pane-top").isVisible())) await page.getByTestId("toggle-panel").click();
	await topTab(page, /^Agents/).click();
}

/** What a page shows once the tool has returned and the model has answered. */
async function expectEnded(page: Page, tool: Tool, subagents: string[] = ["Scout"]): Promise<void> {
	await expect(page.getByText(REPLY)).toBeVisible();
	await expect(page.getByTestId("stop")).toHaveCount(0);
	await expect(card(page, tool).locator("svg.animate-spin")).toHaveCount(0);
	await expect(card(page, tool).getByTestId("tool-interrupted")).toHaveCount(0);
	await expect(page.getByTestId("interrupted-note")).toHaveCount(0);
	for (const id of subagents) await expect(subagent(page, id)).toHaveAttribute("data-running", "false");
}

async function send(page: Page, text: string): Promise<void> {
	await page.getByTestId("composer").fill(text);
	await page.getByTestId("composer").press("Enter");
}

for (const tool of TOOLS) {
	for (const acting of SIDES) {
		const watching: Side = other(acting);

		for (const link of LINKS) {
			test(`the ${watching} page that opens the conversation${link.words} while the ${acting} page's turn is inside a ${tool} call with a subagent running shows the tool and the subagent running, and what follows`, async ({
				browser,
			}) => {
				const title = `Opened inside ${tool} from ${watching}${link.words}`;
				const file = world.seed(nextSeed(), title);
				const pages = await world.open(browser);
				try {
					await show(pages[acting], title);
					await send(pages[acting], `Send a scout (${title})`);
					const liveId = await world.turnOf(file);
					const inTool = await intoTool(liveId, tool);
					await expectRunning(pages[acting], tool);
					// This page was on New chat all along: it opens the conversation from the list, mid-tool, and never
					// shows the conversation as stopped, not even for the moment it takes to find the process.
					await lag(pages[watching], link.ms);
					await watchForStopped(pages[watching]);
					await show(pages[watching], title);
					await expectRunning(pages[watching], tool);
					await neverStopped(pages[watching]);
					// What the tool prints from here on reaches it, though it missed how the tool started.
					await inTool.print("Waiting on Scout: 12 s");
					for (const side of SIDES) await expect(card(pages[side], tool)).toContainText("Waiting on Scout: 12 s");
					await inTool.end();
					for (const side of SIDES) await expectEnded(pages[side], tool);
				} finally {
					await pages.close();
				}
			});
		}

		test(`the ${watching} page that already shows the conversation when the ${acting} page's turn goes into a ${tool} call shows the tool and the subagent running, and what follows`, async ({
			browser,
		}) => {
			const title = `Open before ${tool} from ${watching}`;
			const file = world.seed(nextSeed(), title);
			const pages = await world.open(browser);
			try {
				// Both show the conversation as saved: nothing runs it yet.
				await show(pages[watching], title);
				await show(pages[acting], title);
				await send(pages[acting], `Send a scout (${title})`);
				const liveId = await world.turnOf(file);
				await watchForStopped(pages[watching]);
				const inTool = await intoTool(liveId, tool);
				for (const side of SIDES) await expectRunning(pages[side], tool);
				await neverStopped(pages[watching]);
				await inTool.print("Waiting on Scout: 12 s");
				for (const side of SIDES) await expect(card(pages[side], tool)).toContainText("Waiting on Scout: 12 s");
				await inTool.end();
				for (const side of SIDES) await expectEnded(pages[side], tool);
			} finally {
				await pages.close();
			}
		});

		test(`the ${watching} page that loses its connection while the ${acting} page's turn is inside a ${tool} call shows the tool, both subagents and what follows once it is connected again`, async ({
			browser,
		}) => {
			const title = `Away inside ${tool} from ${watching}`;
			const file = world.seed(nextSeed(), title);
			const pages = await world.open(browser);
			try {
				await show(pages[watching], title);
				await show(pages[acting], title);
				await send(pages[acting], `Send a scout (${title})`);
				const liveId = await world.turnOf(file);
				const inTool = await intoTool(liveId, tool);
				for (const side of SIDES) await expectRunning(pages[side], tool);
				// The page is away while a second subagent starts and the tool prints: it missed both.
				await world.disconnect(watching, pages);
				await inTool.startMapper();
				await inTool.print("Waiting on Scout and Mapper");
				await expect(card(pages[acting], tool)).toContainText("Waiting on Scout and Mapper");
				await watchForStopped(pages[watching]);
				await world.reconnect(watching, pages);
				await expect(subagent(pages[watching], "Mapper")).toHaveAttribute("data-running", "true", { timeout: 40_000 });
				await expect(subagent(pages[watching], "Scout")).toHaveAttribute("data-running", "true");
				await expectRunning(pages[watching], tool);
				await neverStopped(pages[watching]);
				await inTool.print("Waiting on Mapper");
				for (const side of SIDES) await expect(card(pages[side], tool)).toContainText("Waiting on Mapper");
				await inTool.end();
				for (const side of SIDES) await expectEnded(pages[side], tool, ["Scout", "Mapper"]);
			} finally {
				await world.reconnect("remote", pages);
				await world.reconnect("local", pages);
				await pages.close();
			}
		});
	}
}

for (const tool of TOOLS) {
	test(`a page that shows the conversation does not say it stopped when the turn is not streaming for a moment while its ${tool} call runs`, async ({
		browser,
	}) => {
		const title = `Not streaming inside ${tool}`;
		const file = world.seed(nextSeed(), title);
		const pages = await world.open(browser);
		try {
			for (const side of SIDES) await show(pages[side], title);
			await send(pages.local, `Send a scout (${title})`);
			const liveId = await world.turnOf(file);
			const inTool = await intoTool(liveId, tool);
			for (const side of SIDES) await expectRunning(pages[side], tool);
			for (const side of SIDES) await watchForStopped(pages[side]);
			// omp ends a turn while the tool of the step before still runs, as far as the page is told: the conversation is
			// not streaming, and the call has no saved result. What the page holds of the tool says it is not interrupted (#602).
			await world.emit(liveId, omp.agentEnd());
			for (const side of SIDES) {
				// The scout still works, so Stop stays offered for it (#642); what must not appear is the stopped state.
				await expect(pages[side].getByTestId("stop")).toHaveCount(1);
				await expect(card(pages[side], tool).locator("svg.animate-spin")).toBeVisible();
				await pages[side].waitForTimeout(500);
				await neverStopped(pages[side]);
			}
			await inTool.end();
			for (const side of SIDES) await expectEnded(pages[side], tool);
		} finally {
			await pages.close();
		}
	});
}

for (const tool of TOOLS) {
	test(`a process that ends inside a ${tool} call leaves the conversation stopped on both pages: the card is interrupted, not spinning, and Continue is offered`, async ({
		browser,
	}) => {
		const title = `Killed inside ${tool}`;
		const file = world.seed(nextSeed(), title);
		const pages = await world.open(browser);
		try {
			for (const side of SIDES) await show(pages[side], title);
			await send(pages.local, `Send a scout (${title})`);
			const liveId = await world.turnOf(file);
			await intoTool(liveId, tool);
			for (const side of SIDES) await expectRunning(pages[side], tool);
			// omp is killed while the tool runs (a crash, the OOM killer): nothing will answer the call.
			const pid = (await world.lives()).find((l) => l.liveId === liveId)?.pid;
			if (!pid) throw new Error("the process has no pid");
			process.kill(pid, "SIGKILL");
			for (const side of SIDES) {
				await expect(card(pages[side], tool).getByTestId("tool-interrupted")).toBeVisible({ timeout: 15_000 });
				await expect(card(pages[side], tool).locator("svg.animate-spin")).toHaveCount(0);
				await expect(pages[side].getByTestId("interrupted-note")).toBeVisible();
				await expect(pages[side].getByTestId("resume-button")).toBeVisible();
			}
		} finally {
			await pages.close();
		}
	});
}

/** The page's own wait to find out whether a process runs its conversation (`FIND_MS`, in the page's store). */
const FIND_MS = 10_000;

for (const tool of TOOLS) {
	for (const starter of SIDES) {
		for (const reloader of SIDES) {
			test(`the ${reloader} page that is loaded again on the conversation while the ${starter} page's turn is inside a ${tool} call shows the tool and the subagent running from its first picture, and what follows`, async ({
				browser,
			}) => {
				const title = `Reloaded inside ${tool} on ${reloader} from ${starter}`;
				const file = world.seed(nextSeed(), title);
				const pages = await world.open(browser);
				try {
					for (const side of SIDES) await show(pages[side], title);
					await send(pages[starter], `Send a scout (${title})`);
					const liveId = await world.turnOf(file);
					const inTool = await intoTool(liveId, tool);
					for (const side of SIDES) await expectRunning(pages[side], tool);
					// The page is loaded again on the conversation's address, and its connection takes longer to make than
					// the conversation's file takes to read: the file is on screen before the page can know anything of omp.
					await world.delayConnection(reloader, pages);
					await watchFromLoad(pages[reloader]);
					await pages[reloader].reload();
					await expect(card(pages[reloader], tool)).toBeVisible();
					await expect(pages[reloader].getByText(`Send a scout (${title})`)).toBeVisible();
					await pages[reloader].waitForTimeout(500);
					await neverStopped(pages[reloader]);
					await world.endDelay(reloader, pages);
					await expectRunning(pages[reloader], tool);
					await neverStopped(pages[reloader]);
					await inTool.print("Waiting on Scout: 12 s");
					for (const side of SIDES) await expect(card(pages[side], tool)).toContainText("Waiting on Scout: 12 s");
					await inTool.end();
					for (const side of SIDES) await expectEnded(pages[side], tool);
				} finally {
					await pages.close();
				}
			});
		}
	}
}

test("a page loaded while the way to the server is out shows the conversation as running for a while, then as stopped, and as running again when the way is back", async ({
	browser,
}) => {
	const title = "Loaded with no way to the server";
	const file = world.seed(nextSeed(), title);
	const pages = await world.open(browser);
	try {
		await show(pages.local, title);
		await show(pages.remote, title);
		await send(pages.remote, `Send a scout (${title})`);
		const liveId = await world.turnOf(file);
		const inTool = await intoTool(liveId, "wait");
		for (const side of SIDES) await expectRunning(pages[side], "wait");
		await world.delayConnection("local", pages);
		await watchFromLoad(pages.local);
		// The page's own clock is the test's: how long the page waits is not waited for.
		await pages.local.clock.install();
		await pages.local.reload();
		// The conversation is on screen from the file, and the socket has not connected, nor will it yet.
		await expect(card(pages.local, "wait")).toBeVisible();
		await pages.local.clock.runFor(FIND_MS / 2);
		await expect(card(pages.local, "wait").locator("svg.animate-spin")).toBeVisible();
		await expect(pages.local.getByTestId("interrupted-note")).toHaveCount(0);
		// Long enough: nothing is known of a process, and the page says what the file says.
		await pages.local.clock.runFor(FIND_MS);
		await expect(pages.local.getByTestId("interrupted-note")).toBeVisible();
		await expect(card(pages.local, "wait").getByTestId("tool-interrupted")).toBeVisible();
		// The way is back: the page finds the process and shows what runs.
		await world.endDelay("local", pages);
		await expectRunning(pages.local, "wait");
		await inTool.end();
		for (const side of SIDES) await expectEnded(pages[side], "wait");
	} finally {
		await pages.close();
	}
});

/** What the card of each tool shows of its arguments, open, though the page may not have seen the tool start. */
const ARGUMENTS: Record<Tool, string> = { task: "Look at the config files", wait: '"ids"' };

/**
 * What a page shows of a conversation paused inside a tool call: omp is frozen, its subagent with it, and nothing says
 * either ended. The card says it is paused and has its arguments open, where it was a spinner that spun for nothing (#602).
 */
async function expectPausedInTool(page: Page, tool: Tool): Promise<void> {
	await expect(page.getByTestId("paused-banner")).toBeVisible();
	await expect(card(page, tool)).toBeVisible();
	await expect(card(page, tool).getByTestId("tool-paused")).toBeVisible();
	await expect(card(page, tool).locator("svg.animate-spin")).toHaveCount(0);
	await expect(card(page, tool)).toContainText(ARGUMENTS[tool]);
	await expect(card(page, tool).getByTestId("tool-interrupted")).toHaveCount(0);
	await expect(page.getByTestId("interrupted-note")).toHaveCount(0);
	await showAgents(page);
	await expect(subagent(page, "Scout")).toHaveAttribute("data-running", "true");
}

for (const tool of TOOLS) {
	for (const starter of SIDES) {
		const opener: Side = other(starter);
		test(`the ${opener} page that opens a conversation the ${starter} page paused inside a ${tool} call shows the tool and the subagent as running`, async ({
			browser,
		}) => {
			const title = `Paused inside ${tool} from ${starter}`;
			const file = world.seed(nextSeed(), title);
			const pages = await world.open(browser);
			try {
				await show(pages[starter], title);
				await send(pages[starter], `Send a scout (${title})`);
				const liveId = await world.turnOf(file);
				const inTool = await intoTool(liveId, tool);
				await expectRunning(pages[starter], tool);
				await pages[starter].getByTestId("pause").click();
				await expectPausedInTool(pages[starter], tool);
				await show(pages[opener], title);
				await expectPausedInTool(pages[opener], tool);
				// Resumed from the page that was not there when it was paused: omp goes on, and both pages follow.
				await pages[opener].getByTestId("paused-resume").click();
				for (const side of SIDES) await expectRunning(pages[side], tool);
				await inTool.end();
				for (const side of SIDES) await expectEnded(pages[side], tool);
			} finally {
				await pages.close();
			}
		});

		test(`the pages that open a conversation paused inside a ${tool} call, after the server was restarted around it, show the tool and the subagent as running (${starter} page paused it)`, async ({
			browser,
		}) => {
			const title = `Paused inside ${tool} over a restart from ${starter}`;
			const file = world.seed(nextSeed(), title);
			const first = await world.open(browser);
			let liveId: string;
			let inTool: Awaited<ReturnType<typeof intoTool>>;
			try {
				await show(first[starter], title);
				await send(first[starter], `Send a scout (${title})`);
				liveId = await world.turnOf(file);
				inTool = await intoTool(liveId, tool);
				await expectRunning(first[starter], tool);
				await first[starter].getByTestId("pause").click();
				await expectPausedInTool(first[starter], tool);
			} finally {
				await first.close({ keepProcesses: true });
			}
			await world.restart();
			expect(await world.liveOf(file)).toBe(liveId);
			const pages = await world.open(browser);
			try {
				for (const side of SIDES) await show(pages[side], title);
				for (const side of SIDES) await expectPausedInTool(pages[side], tool);
				await pages[starter].getByTestId("paused-resume").click();
				for (const side of SIDES) await expectRunning(pages[side], tool);
				await inTool.end();
				for (const side of SIDES) await expectEnded(pages[side], tool);
			} finally {
				await pages.close();
			}
		});
	}
}

test("a conversation whose omp really stopped inside a tool call still says so, on both sides", async ({ browser }) => {
	const title = "Stopped inside a tool";
	const file = world.seed(nextSeed(), title);
	// The call was written and nothing answered it: omp was killed while the tool ran.
	appendFileSync(
		file,
		`${JSON.stringify({
			type: "message",
			id: "t0w",
			parentId: "t0r",
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call_wait", name: "wait", arguments: CALL.wait.arguments }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-opus-5-5",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		})}\n`,
	);
	const pages = await world.open(browser);
	try {
		for (const side of SIDES) {
			await show(pages[side], title);
			await expect(pages[side].getByTestId("interrupted-note")).toBeVisible();
			await expect(card(pages[side], "wait").getByTestId("tool-interrupted")).toBeVisible();
			await expect(pages[side].getByTestId("resume-button")).toBeVisible();
		}
	} finally {
		await pages.close();
	}
});
