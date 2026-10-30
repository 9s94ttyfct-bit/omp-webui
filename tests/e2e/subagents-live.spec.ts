import { FIXTURE, FIXTURE_FILES } from "../support/fixtures.ts";
import { boxOf, overlap } from "../support/geometry.ts";
import { sessionRow, startLive } from "../support/live.ts";
import { topTab } from "../support/panel.ts";
import { type Command, type Msg, type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { addTaskTurn, sessionWithSubagents } from "../support/subagent-fixtures.ts";
import { expect, type Locator, type Page, test } from "./fixtures.ts";

/**
 * Subagents while they run (no model call): omp's subagent frames are pushed to the page by hand and its
 * `get_subagent_messages` is answered by the spec. Running subagents come first in the Agents tab, the chat lists
 * what the agent waits on as jobs, and any subagent opens a live view of its whole transcript.
 */

type Frame = Record<string, unknown>;

const lifecycle = (id: string, status: string, extra: Frame = {}): Frame => ({
	type: "subagent_lifecycle",
	payload: { id, agent: "explore", agentSource: "bundled", index: 0, status, ...extra },
});
const progress = (id: string, p: Frame, extra: Frame = {}): Frame => ({
	type: "subagent_progress",
	payload: {
		index: 0,
		agent: "explore",
		agentSource: "bundled",
		task: id,
		progress: { id, status: "running", ...p },
		...extra,
	},
});
const event = (id: string, ev: Frame): Frame => ({ type: "subagent_event", payload: { id, event: ev } });

interface Probe {
	tap: SocketTap;
	liveId: string;
	frame(f: Frame): void;
}

/** Open a conversation of the spec's own with its process running (a `!command` needs no model). */
async function openProbe(
	page: Page,
	title: string,
	n: number,
	prepare: () => void = () => void sessionWithSubagents(n, title, {}),
): Promise<Probe> {
	prepare();
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, title, `subagent-probe-${n}`);
	return { tap, liveId, frame: (f) => tap.push({ t: "frame", liveId, frame: f } as Msg) };
}

const items = (page: Page) => page.getByTestId("subagent-item");
const order = (page: Page) => items(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-agent-id")));

test("running subagents come first in the Agents tab, the newest start first, with a live clock", async ({ page }) => {
	const title = "Order probe";
	const { frame } = await openProbe(page, title, 0xb2, () => sessionWithSubagents(0xb2, title, { Finished: [10] }));
	await page.getByTestId("toggle-panel").click();
	await expect.poll(() => order(page)).toEqual(["Finished"]);
	await expect(items(page).first()).toHaveAttribute("data-running", "false");

	// omp says how long each has run: that fixes which started last, whatever order the frames came in.
	frame(lifecycle("Older", "started", { description: "First job" }));
	frame(progress("Older", { durationMs: 60_000 }));
	frame(lifecycle("Newer", "started", { description: "Second job", index: 1 }));
	frame(progress("Newer", { durationMs: 5000 }, { index: 1 }));
	await expect.poll(() => order(page)).toEqual(["Newer", "Older", "Finished"]);
	await expect(items(page).nth(0)).toHaveAttribute("data-running", "true");
	await expect(items(page).nth(1)).toHaveAttribute("data-running", "true");
	await expect(items(page).nth(2)).toHaveAttribute("data-running", "false");
	// The tab counts how many of them run.
	await expect(topTab(page, "Agents 2/3")).toBeVisible();

	// A running row has a live clock that keeps counting; a finished one has none.
	const clock = items(page).first().getByTestId("subagent-elapsed");
	await expect(clock).toHaveText(/^\d+s$/);
	const before = await clock.innerText();
	await expect.poll(() => clock.innerText()).not.toBe(before);
	await expect(items(page).nth(2).getByTestId("subagent-elapsed")).toHaveCount(0);

	// When the newer one ends it drops below the one that still runs, into the finished ones' usual order.
	frame(lifecycle("Newer", "completed", { index: 1 }));
	await expect.poll(() => order(page)).toEqual(["Older", "Finished", "Newer"]);
	await expect(items(page).first()).toHaveAttribute("data-running", "true");
	await expect(topTab(page, "Agents 1/3")).toBeVisible();
});

test("the Agents list keeps its order while progress keeps arriving (#640)", async ({ page }) => {
	const title = "Order stability probe";
	const { tap, frame } = await openProbe(page, title, 0xc1);
	await page.getByTestId("toggle-panel").click();

	// Three subagents started as one batch, a few milliseconds apart. omp reports how long each has run, which is what
	// decides the order: the newest start is the shortest elapsed time and it is on top.
	const names = ["Beta", "Alpha", "Gamma"];
	const elapsed: Record<string, number> = { Beta: 995, Alpha: 1000, Gamma: 1005 };
	for (const [i, id] of names.entries()) frame(lifecycle(id, "started", { index: i, description: `${id} work` }));
	for (const [i, id] of names.entries()) frame(progress(id, { durationMs: elapsed[id], index: i }));
	await expect(items(page)).toHaveCount(3);
	// The three in the order the first numbers gave them, whatever that is: the rest of the test must not change it.
	const start = await order(page);
	expect([...start].sort()).toEqual(["Alpha", "Beta", "Gamma"]);

	// Progress keeps coming, one subagent at a time, each frame reporting an elapsed time that has drifted by a few
	// milliseconds from the true one, as omp's own rounding and the moment each frame arrives make it. Read afresh from
	// every frame, the starts would trade places from round to round; the rows must not move at all.
	const drift: Record<string, number[]> = {
		Beta: [10, -8, 6, -6, 9],
		Alpha: [-5, 3, -9, 8, -7],
		Gamma: [-8, 9, -7, 10, -9],
	};
	for (const round of [0, 1, 2, 3, 4]) {
		for (const [i, id] of names.entries()) {
			frame(
				progress(id, {
					durationMs: elapsed[id] + (drift[id] as number[])[round] + round,
					lastIntent: `Round ${round + 1}`,
					index: i,
				}),
			);
			// After every single frame, not only after a whole round: one subagent's progress must not move another either.
			await expect.poll(() => order(page)).toEqual(start);
		}
		// The rows did redraw with the progress just sent.
		await expect(items(page).nth(0)).toContainText(`Round ${round + 1}`);
		await expect(items(page).nth(2)).toContainText(`Round ${round + 1}`);
	}

	// The registry is read again (a reconnecting page asks): its elapsed times are new and imply other starts. The rows
	// keep the places they were drawn in.
	tap.answer("get_subagents", () => ({
		ok: true,
		data: {
			subagents: [
				{ id: "Alpha", status: "running", progress: { id: "Alpha", status: "running", durationMs: 900 } },
				{ id: "Gamma", status: "running", progress: { id: "Gamma", status: "running", durationMs: 100 } },
				{ id: "Beta", status: "running", progress: { id: "Beta", status: "running", durationMs: 500 } },
			],
		},
	}));
	tap.drop();
	await expect.poll(() => order(page)).toEqual(start);
	await expect(items(page)).toHaveCount(3);
	for (const row of await items(page).all()) await expect(row).toHaveAttribute("data-running", "true");
});

test("while subagents run the chat lists them as jobs: kind, model, name, description, progress and elapsed", async ({
	page,
}) => {
	const { frame } = await openProbe(page, "Jobs probe", 0xb3);
	const block = page.getByTestId("jobs-block");
	await expect(block).toHaveCount(0);

	for (let i = 1; i <= 5; i++) {
		const named = { index: i, parentToolCallId: "call_jobs" };
		frame(lifecycle(`Job${i}`, "started", { ...named, description: `Description ${i}` }));
		frame(
			progress(
				`Job${i}`,
				{ durationMs: i * 10_000, completionPercent: i * 10, resolvedModel: "claude-haiku-5-5", toolCount: i },
				named,
			),
		);
	}
	await expect(block).toBeVisible();
	await expect(block).toContainText("Waiting on 5 jobs");

	// Collapsed to three rows, running first with the newest start on top.
	const rows = block.getByTestId("job-row");
	await expect(rows).toHaveCount(3);
	await expect(rows.first()).toHaveAttribute("data-agent-id", "Job1");
	await expect(block.getByTestId("jobs-more")).toContainText("2 more");

	const first = rows.first();
	await expect(first.getByTestId("job-kind")).toHaveText("task");
	await expect(first).toContainText("claude-haiku-5-5");
	await expect(first).toContainText("Job1");
	await expect(first).toContainText("Description 1");
	await expect(first).toContainText("10%");
	await expect(first.getByTestId("job-elapsed")).toHaveText(/^\d+s$/);
	const clock = first.getByTestId("job-elapsed");
	const before = await clock.innerText();
	await expect.poll(() => clock.innerText()).not.toBe(before);

	await block.getByTestId("jobs-more").click();
	await expect(rows).toHaveCount(5);
	await expect(block.getByTestId("jobs-more")).toContainText("Show fewer");
	await block.getByTestId("jobs-more").click();
	await expect(rows).toHaveCount(3);
	await block.getByTestId("jobs-more").click();

	// Progress frames update the rows as they arrive.
	frame(
		progress("Job1", { durationMs: 12_000, completionPercent: 55, resolvedModel: "claude-haiku-5-5" }, { index: 1 }),
	);
	await expect(rows.first()).toContainText("55%");

	// A job that ends stays beside the others until all of them are done.
	frame(lifecycle("Job5", "completed", { index: 5, parentToolCallId: "call_jobs" }));
	await expect(block).toContainText("Waiting on 4 of 5 jobs");
	await expect(rows).toHaveCount(5);
	await expect(rows.last()).toHaveAttribute("data-agent-id", "Job5");

	// A row opens that subagent's live view in the side panel.
	await rows.nth(1).click();
	await expect(page.getByTestId("right-panel")).toBeVisible();
	await expect(page.getByTestId("subagent-detail")).toContainText("Job2");

	for (let i = 1; i <= 4; i++) frame(lifecycle(`Job${i}`, "completed", { index: i, parentToolCallId: "call_jobs" }));
	await expect(block).toHaveCount(0);
});

test("an expanded jobs block on a phone scrolls inside a bounded height and leaves the conversation and composer in view", async ({
	page,
}) => {
	// The sidebar is a drawer on a phone, so the conversation is opened first and the screen shrinks after.
	const { frame } = await openProbe(page, "Phone jobs probe", 0xbe);
	await page.setViewportSize({ width: 375, height: 667 });
	// The drawer opens over the chat when the screen narrows.
	await page.getByRole("complementary").getByRole("button", { name: "Hide sidebar" }).click();
	for (let i = 1; i <= 14; i++) {
		const named = { index: i, parentToolCallId: "call_phone" };
		frame(lifecycle(`Job${i}`, "started", { ...named, description: `Description ${i}` }));
		frame(progress(`Job${i}`, { durationMs: i * 1000, completionPercent: i }, named));
	}
	const block = page.getByTestId("jobs-block");
	await expect(block).toContainText("Waiting on 14 jobs");
	await block.getByTestId("jobs-more").click();
	await expect(block.getByTestId("job-row")).toHaveCount(14);

	const box = async (id: string) => {
		const b = await page.getByTestId(id).boundingBox();
		if (!b) throw new Error(`${id} has no box`);
		return b;
	};
	const jobs = await box("jobs-block");
	expect(jobs.height).toBeLessThanOrEqual(667 * 0.35 + 1);
	const rows = block.getByTestId("jobs-rows");
	expect(await rows.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
	expect((await box("transcript")).height).toBeGreaterThan(120);
	const composer = await box("composer");
	expect(composer.y).toBeGreaterThanOrEqual(0);
	expect(composer.y + composer.height).toBeLessThanOrEqual(667);
	// The last row is reachable by scrolling the block, and the "show fewer" control stays in view.
	await rows.evaluate((el) => {
		el.scrollTop = el.scrollHeight;
	});
	await expect(block.getByTestId("job-row").last()).toBeInViewport();
	await expect(block.getByTestId("jobs-more")).toBeInViewport();
});

test.describe("the live view of one subagent", () => {
	const TITLE = "Live view probe";
	const at = (n: number) => 1_800_000_000_000 + n;
	const text = (t: string) => [{ type: "text", text: t }];
	const assistant = (content: unknown[], timestamp: number) => ({
		role: "assistant",
		content,
		provider: "anthropic",
		model: "claude-haiku-5-5",
		timestamp,
	});
	const entry = (id: string, message: Frame) => ({
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-01-07T01:00:00.000Z",
		message,
	});
	/** Each record takes 100 bytes of the pretend transcript file, so offsets are easy to read. */
	const BYTES = 100;

	/** Answer `get_subagent_messages` from a transcript the spec grows; every command it receives is kept. */
	function serveTranscript(tap: SocketTap, records: unknown[], failures: string[] = []) {
		const asked: Command[] = [];
		tap.answer("get_subagent_messages", (c) => {
			asked.push(c);
			// The first reads fail the way the socket or omp can fail (see `failures`), before any is answered.
			const failure = failures.shift();
			if (failure !== undefined) return { ok: false, error: failure };
			const from = Math.min(Number(c.fromByte ?? 0), records.length * BYTES);
			return {
				ok: true,
				data: {
					sessionFile: "/virtual/Scout.jsonl",
					fromByte: from,
					nextByte: records.length * BYTES,
					reset: false,
					// A transcript is a chain: each record's parent is the one before it.
					entries: records
						.map((r, i) => ({ ...(r as Frame), parentId: i ? (records[i - 1] as Frame).id : null }))
						.slice(from / BYTES),
					messages: [],
				},
			};
		});
		return asked;
	}

	async function open(page: Page, n: number, own: { failures?: string[]; onDisk?: boolean } = {}) {
		// Every test has a conversation of its own, found by its title.
		const title = `${TITLE} ${n.toString(16)}`;
		const probe = await openProbe(page, title, n, () =>
			sessionWithSubagents(n, title, own.onDisk ? { Scout: [5] } : {}),
		);
		const records: unknown[] = [
			entry("u1", { role: "user", content: text("Find the config files"), attribution: "user", timestamp: at(1) }),
			entry(
				"a1",
				assistant(
					[
						...text("I will search the tree."),
						{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } },
					],
					at(2),
				),
			),
			entry("r1", {
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "bash",
				content: text("src\ndocs"),
				isError: false,
				timestamp: at(3),
			}),
		];
		const asked = serveTranscript(probe.tap, records, own.failures);
		probe.frame(lifecycle("Scout", "started", { description: "Find config files", parentToolCallId: "call_scout" }));
		probe.frame(
			progress("Scout", { durationMs: 3000, resolvedModel: "claude-haiku-5-5" }, { parentToolCallId: "call_scout" }),
		);
		await page.getByTestId("toggle-panel").click();
		await items(page).first().click();
		return { ...probe, records, asked, detail: page.getByTestId("subagent-detail") };
	}

	test("shows what the subagent has done so far, reading the transcript on from where it stopped", async ({ page }) => {
		const { detail, asked, records, frame } = await open(page, 0xb4);
		await expect(detail).toContainText("Find the config files");
		await expect(detail).toContainText("I will search the tree.");
		expect(asked[0]).toMatchObject({ subagentId: "Scout", fromByte: 0 });

		// New records arrive while it runs: the next read starts where the last one ended.
		records.push(entry("a2", assistant(text("Found two config files."), at(10))));
		frame(event("Scout", { type: "message_end", message: assistant(text("Found two config files."), at(10)) }));
		await expect(detail).toContainText("Found two config files.");
		const offsets = asked.map((c) => Number(c.fromByte));
		expect(offsets).toContain(3 * BYTES);
		expect(offsets.every((o) => o % BYTES === 0)).toBe(true);
		expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
	});

	test("streams the message being written: thinking, text, and a tool with its live output", async ({ page }) => {
		const { detail, records, frame } = await open(page, 0xb5);
		const live = (content: unknown[]) => assistant(content, at(20));
		const thinking = { type: "thinking", thinking: "Considering the glob patterns" };
		const said = { type: "text", text: "Checking the config folder" };
		const call = { type: "toolCall", id: "tc2", name: "bash", arguments: { command: "ls -R config" } };

		frame(event("Scout", { type: "message_start", message: live([]) }));
		frame(
			event("Scout", {
				type: "message_update",
				assistantMessageEvent: { type: "thinking_delta", partial: live([thinking]) },
			}),
		);
		await expect(detail.getByTestId("thinking")).toContainText("Considering the glob patterns");

		frame(
			event("Scout", {
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", partial: live([thinking, said]) },
			}),
		);
		await expect(detail).toContainText("Checking the config folder");

		// The tool starts and prints: its output shows as it comes, last lines first in view.
		frame(
			event("Scout", {
				type: "message_update",
				assistantMessageEvent: { type: "toolcall_end", partial: live([thinking, said, call]) },
			}),
		);
		frame(
			event("Scout", {
				type: "tool_execution_start",
				toolCallId: "tc2",
				toolName: "bash",
				args: call.arguments,
				intent: "List the config files",
			}),
		);
		const running = detail.getByTestId("subagent-running-tool");
		await expect(running).toHaveCount(1);
		await expect(running).toContainText("bash");
		await expect(running).toContainText("List the config files");
		frame(
			event("Scout", {
				type: "tool_execution_update",
				toolCallId: "tc2",
				partialResult: { content: text("a.conf\nb.conf") },
			}),
		);
		await expect(running.getByTestId("subagent-tool-output")).toContainText("b.conf");
		frame(
			event("Scout", {
				type: "tool_execution_update",
				toolCallId: "tc2",
				partialResult: { content: text("a.conf\nb.conf\nc.conf") },
			}),
		);
		await expect(running.getByTestId("subagent-tool-output")).toContainText("c.conf");

		// The tool ends and the message is written to the transcript: nothing shows twice, nothing is left running.
		const done = live([thinking, said, call]);
		records.push(
			entry("a3", done),
			entry("r3", {
				role: "toolResult",
				toolCallId: "tc2",
				toolName: "bash",
				content: text("a.conf\nb.conf\nc.conf"),
				isError: false,
				timestamp: at(21),
			}),
		);
		frame(
			event("Scout", {
				type: "tool_execution_end",
				toolCallId: "tc2",
				result: { content: text("a.conf\nb.conf\nc.conf") },
			}),
		);
		frame(event("Scout", { type: "message_end", message: done }));
		await expect(running).toHaveCount(0);
		await expect(detail.getByText("Checking the config folder")).toHaveCount(1);
		await expect(detail.getByTestId("thinking")).toHaveCount(1);
	});

	test("follows the bottom as it grows, until you scroll up", async ({ page }) => {
		const { detail, records, frame } = await open(page, 0xb6);
		for (let i = 0; i < 25; i++) {
			records.push(
				entry(
					`bulk${i}`,
					assistant(text(`Paragraph ${i}. ${"The quick brown fox jumps over the lazy dog. ".repeat(8)}`), at(100 + i)),
				),
			);
		}
		frame(event("Scout", { type: "message_end", message: assistant(text("Paragraph 24"), at(124)) }));
		const scroller = detail.getByTestId("subagent-scroll");
		const gap = () => scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
		await expect.poll(() => scroller.evaluate((el) => el.scrollHeight > el.clientHeight + 200)).toBe(true);
		await expect.poll(gap).toBeLessThan(5);

		// More output keeps the view at the end.
		const live = (t: string) => assistant(text(t), at(200));
		frame(event("Scout", { type: "message_start", message: live("") }));
		frame(
			event("Scout", {
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", partial: live(`Streaming ${"words ".repeat(300)}`) },
			}),
		);
		await expect(detail).toContainText("Streaming words");
		await expect.poll(gap).toBeLessThan(5);

		// Scrolled up to read, it stays where it is; Jump to latest brings the end back.
		await scroller.evaluate((el) => {
			el.scrollTop = 0;
		});
		// The scroll has been seen once the button for the end shows; only then does new content arrive.
		await expect(detail.getByRole("button", { name: "Jump to latest" })).toBeVisible();
		frame(
			event("Scout", {
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", partial: live(`Streaming ${"words ".repeat(600)}`) },
			}),
		);
		await expect.poll(() => scroller.evaluate((el) => el.scrollHeight)).toBeGreaterThan(1000);
		expect(await scroller.evaluate((el) => el.scrollTop)).toBeLessThan(40);
		await detail.getByRole("button", { name: "Jump to latest" }).click();
		await expect.poll(gap).toBeLessThan(5);
	});

	test("can be steered and stopped", async ({ page }) => {
		const { detail, tap, frame } = await open(page, 0xb7);
		tap.answer("steer_subagent", () => ({ ok: true, data: {} }));
		tap.answer("cancel_subagent", () => ({ ok: true, data: { cancelled: true } }));

		await detail.getByLabel("Message subagent").fill("Use the direct path");
		await detail.getByRole("button", { name: "Send to subagent" }).click();
		await expect.poll(() => tap.commands("steer_subagent").length).toBe(1);
		expect(tap.commands("steer_subagent")[0]).toMatchObject({ subagentId: "Scout", message: "Use the direct path" });
		await expect(detail.getByLabel("Message subagent")).toHaveValue("");

		await detail.getByRole("button", { name: "Stop Scout" }).click();
		await expect.poll(() => tap.commands("cancel_subagent").length).toBe(1);
		expect(tap.commands("cancel_subagent")[0]).toMatchObject({ subagentId: "Scout" });
		await expect(page.getByText("Subagent stopped")).toBeVisible();

		// Once it is over there is nothing left to steer or stop, and the view says it was aborted.
		frame(lifecycle("Scout", "aborted", { parentToolCallId: "call_scout" }));
		await expect(detail.getByLabel("Message subagent")).toHaveCount(0);
		await expect(detail.getByRole("button", { name: "Stop Scout" })).toHaveCount(0);
		await expect(detail.getByText("aborted")).toBeVisible();
	});

	test("a subagent that is over shows no running tools, however it ended", async ({ page }) => {
		const { detail, frame } = await open(page, 0xba);
		const running = detail.getByTestId("subagent-running-tool");
		frame(
			event("Scout", {
				type: "tool_execution_start",
				toolCallId: "tc7",
				toolName: "bash",
				args: { command: "sleep 99" },
			}),
		);
		await expect(running).toHaveCount(1);

		frame(lifecycle("Scout", "cancelled", { parentToolCallId: "call_scout" }));
		await expect(detail.getByTestId("subagent-running-tools")).toHaveCount(0);
		await expect(running).toHaveCount(0);
		// A tool frame that straggles in after the end does not bring the spinner back.
		frame(event("Scout", { type: "tool_execution_start", toolCallId: "tc8", toolName: "bash", args: {} }));
		await page.waitForTimeout(300);
		await expect(running).toHaveCount(0);
	});

	test("a subagent whose process exits shows no running tools", async ({ page }) => {
		const { detail, frame, liveId, tap } = await open(page, 0xbb);
		const running = detail.getByTestId("subagent-running-tool");
		frame(
			event("Scout", {
				type: "tool_execution_start",
				toolCallId: "tc7",
				toolName: "bash",
				args: { command: "sleep 99" },
			}),
		);
		await expect(running).toHaveCount(1);
		tap.push({ t: "live_exit", liveId, code: 1, stderr: "" });
		await expect(running).toHaveCount(0);
		await expect(detail.getByTestId("subagent-running-tools")).toHaveCount(0);
	});

	test("one lost connection does not move the view to reading the whole file; omp is asked again", async ({ page }) => {
		const fileReads: string[] = [];
		page.on("request", (r) => {
			if (r.url().includes("/api/session?") && decodeURIComponent(r.url()).includes("Scout.jsonl"))
				fileReads.push(r.url());
		});
		const { detail, asked, records, frame } = await open(page, 0xbc, { failures: ["Connection lost"], onDisk: true });
		// The failed read is asked again, and answered.
		await expect(detail).toContainText("Find the config files");
		expect(asked.length).toBeGreaterThanOrEqual(2);
		expect(asked.every((c) => c.subagentId === "Scout")).toBe(true);

		// It goes on reading through omp as the subagent writes, for as long as it runs.
		records.push(entry("a2", assistant(text("Found two config files."), at(10))));
		frame(event("Scout", { type: "message_end", message: assistant(text("Found two config files."), at(10)) }));
		await expect(detail).toContainText("Found two config files.");
		const reads = asked.length;
		await expect.poll(() => asked.length, { timeout: 8000 }).toBeGreaterThan(reads);
		expect(fileReads).toEqual([]);
	});

	test("omp not knowing the subagent sends the view to its transcript file", async ({ page }) => {
		const fileReads: string[] = [];
		page.on("request", (r) => {
			if (r.url().includes("/api/session?") && decodeURIComponent(r.url()).includes("Scout.jsonl"))
				fileReads.push(r.url());
		});
		const { detail } = await open(page, 0xbd, {
			failures: ["Unknown subagent or session file unavailable: Scout"],
			onDisk: true,
		});
		await expect.poll(() => fileReads.length).toBeGreaterThan(0);
		await expect(detail.getByTestId("subagent-scroll")).toBeVisible();
	});

	test("opens the subagents it started, and the way back", async ({ page }) => {
		const { detail, frame, tap } = await open(page, 0xb8);
		frame(lifecycle("Scout.Deep", "started", { index: 1, description: "Dig deeper", parentToolCallId: "call_deep" }));
		frame(progress("Scout.Deep", { durationMs: 1000 }, { index: 1, parentToolCallId: "call_deep" }));
		const children = detail.getByTestId("subagent-children");
		await expect(children).toBeVisible();
		await expect(children.getByTestId("subagent-child")).toHaveCount(1);
		await children.getByTestId("subagent-child").click();
		// Its transcript is read by its own id.
		await expect(detail).toHaveAttribute("data-agent-id", "Scout.Deep");
		await expect
			.poll(() => tap.commands("get_subagent_messages").some((c) => c.subagentId === "Scout.Deep"))
			.toBe(true);
		await detail.getByTestId("subagent-parent").click();
		await expect(detail).toHaveAttribute("data-agent-id", "Scout");
		await expect(detail.getByTestId("subagent-children")).toBeVisible();
	});
});

test("the task card opens its subagent's view, and the Agents list from a batch", async ({ page }) => {
	await page.goto("/");
	await page.locator(`[data-testid="session-item"][data-file$="${FIXTURE_FILES.gamma}"]`).click();
	const card = page.locator('[data-testid="tool-card"][data-tool="task"]');
	await card.getByRole("button", { name: "View subagents →" }).click();
	await expect(page.getByTestId("right-panel")).toBeVisible();
	await expect(page.getByTestId("subagent-detail")).toContainText(FIXTURE.subagentId);
	await expect(page.getByTestId("subagent-detail")).toContainText(FIXTURE.subagentReply);
});

test("a task card of a running conversation finds its subagents by the tool call that started them", async ({
	page,
}) => {
	const title = "Task card probe";
	const { frame } = await openProbe(page, title, 0xb9, () => {
		const own = sessionWithSubagents(0xb9, title, {});
		addTaskTurn(own, 0xb9, "call_cards", ["Alpha", "Beta"]);
	});
	await expect(sessionRow(page, title)).toHaveCount(1);
	frame(lifecycle("Alpha", "started", { description: "Alpha work", parentToolCallId: "call_cards" }));
	frame(lifecycle("Beta", "started", { index: 1, description: "Beta work", parentToolCallId: "call_cards" }));
	frame(lifecycle("Other", "started", { index: 2, description: "Not ours", parentToolCallId: "call_elsewhere" }));
	const card = page.locator('[data-testid="tool-card"][data-tool="task"]');
	await card.getByRole("button", { name: "View subagents →" }).click();
	// Two subagents belong to the card: the Agents list opens, not one of them.
	await expect(page.getByTestId("right-panel")).toBeVisible();
	await expect(items(page)).toHaveCount(3);
	await expect(page.getByTestId("subagent-detail")).toHaveCount(0);
});

test("a subagent that vanishes from omp's registry while the socket is down is shown as ended, not as completed (#366)", async ({
	page,
}) => {
	const { tap, frame } = await openProbe(page, "Vanish probe", 0xe6);
	await page.getByTestId("toggle-panel").click();
	frame(lifecycle("Scout", "started", { description: "Looks around" }));
	await expect(items(page)).toHaveCount(1);
	await expect(items(page).first()).toHaveAttribute("data-running", "true");

	// The connection drops; omp's registry no longer lists the subagent when the page asks again, and its end frame was never seen.
	tap.answer("get_subagents", () => ({ ok: true, data: { subagents: [] } }));
	tap.drop();
	await expect(items(page).first()).toHaveAttribute("data-running", "false");
	// Over, with a word that says nothing is known of how it ended: not the check mark of a completed one.
	await expect(items(page).first().getByLabel("ended")).toBeVisible();
	await expect(items(page).first().getByLabel("Completed")).toHaveCount(0);
});

test("a running subagent is stopped from the Agents list or from its task card, and only that one ends (#455)", async ({
	page,
}) => {
	const title = "Stop probe";
	const { tap, frame } = await openProbe(page, title, 0xf1, () => {
		addTaskTurn(sessionWithSubagents(0xf1, title, {}), 0xf1, "call_stop", ["Alpha", "Beta"]);
	});
	tap.answer("cancel_subagent", () => ({ ok: true, data: { cancelled: true } }));
	await expect(sessionRow(page, title)).toHaveCount(1);
	frame(lifecycle("Alpha", "started", { description: "Alpha work", parentToolCallId: "call_stop" }));
	frame(lifecycle("Beta", "started", { index: 1, description: "Beta work", parentToolCallId: "call_stop" }));
	await page.getByTestId("toggle-panel").click();
	const list = page.getByTestId("subagent-list");
	const card = page.locator('[data-testid="tool-card"][data-tool="task"]');
	const stops = (where: Locator) => where.getByRole("button", { name: /^Stop / });

	// Both places offer one Stop for each running subagent.
	await expect(stops(list)).toHaveCount(2);
	await expect(stops(card)).toHaveCount(2);

	// Stopping Beta in the list asks omp to stop Beta, and nothing else.
	await list.getByRole("button", { name: "Stop Beta" }).click();
	await expect.poll(() => tap.commands("cancel_subagent").length).toBe(1);
	expect(tap.commands("cancel_subagent")[0]).toMatchObject({ subagentId: "Beta" });
	await expect(page.getByText("Subagent stopped")).toBeVisible();

	// omp says Beta is aborted: its row says so and offers no Stop, here and on the card; Alpha still does.
	frame(lifecycle("Beta", "aborted", { index: 1, parentToolCallId: "call_stop" }));
	const beta = page.locator('[data-testid="subagent-item"][data-agent-id="Beta"]');
	await expect(beta).toHaveAttribute("data-running", "false");
	await expect(beta.getByLabel("aborted")).toBeVisible();
	await expect(list.getByRole("button", { name: "Stop Beta" })).toHaveCount(0);
	await expect(card.getByRole("button", { name: "Stop Beta" })).toHaveCount(0);
	await expect(stops(list)).toHaveCount(1);
	await expect(stops(card)).toHaveCount(1);
	await expect(page.locator('[data-testid="subagent-item"][data-agent-id="Alpha"]')).toHaveAttribute(
		"data-running",
		"true",
	);

	// The card's own Stop ends Alpha the same way.
	await card.getByRole("button", { name: "Stop Alpha" }).click();
	await expect.poll(() => tap.commands("cancel_subagent").length).toBe(2);
	expect(tap.commands("cancel_subagent")[1]).toMatchObject({ subagentId: "Alpha" });
	frame(lifecycle("Alpha", "aborted", { parentToolCallId: "call_stop" }));
	await expect(stops(list)).toHaveCount(0);
	await expect(stops(card)).toHaveCount(0);
});

test("a Stop that finds the subagent already over says so, and a Stop that fails says why (#455)", async ({ page }) => {
	const { tap, frame } = await openProbe(page, "Stop refused probe", 0xf2);
	await page.getByTestId("toggle-panel").click();
	frame(lifecycle("Scout", "started", { description: "Looks around" }));
	const stop = page.getByTestId("subagent-list").getByRole("button", { name: "Stop Scout" });
	tap.answer("cancel_subagent", () => ({ ok: true, data: { cancelled: false } }));
	await stop.click();
	await expect(page.getByText("Subagent was not running")).toBeVisible();

	// A failed stop gives the button back, so it can be tried again.
	tap.answer("cancel_subagent", () => ({ ok: false, error: "omp could not stop it" }));
	await stop.click();
	await expect(page.getByText("omp could not stop it")).toBeVisible();
	await expect(stop).toBeEnabled();
	expect(tap.commands("cancel_subagent")).toHaveLength(2);
});

for (const [name, size, n] of [
	["a tablet (the panel is a sheet)", { width: 900, height: 800 }, 0x5b],
	["a phone", { width: 390, height: 844 }, 0x5c],
] as const) {
	test(`on ${name} the toast a Stop raises does not cover the first row's Stop (#521)`, async ({ page }) => {
		const { tap, frame } = await openProbe(page, `Stop sheet probe ${n}`, n);
		// The sidebar is a drawer here, so the conversation is opened first and the screen shrinks after.
		await page.setViewportSize(size);
		await page.getByRole("complementary").getByRole("button", { name: "Hide sidebar" }).click();
		await page.getByTestId("toggle-panel").click();
		frame(lifecycle("Scout", "started", { description: "Looks around" }));
		const stop = page.getByTestId("subagent-list").getByRole("button", { name: "Stop Scout" });
		tap.answer("cancel_subagent", () => ({ ok: true, data: { cancelled: false } }));
		await stop.click();
		const toast = page.getByTestId("toast").filter({ hasText: "Subagent was not running" });
		await expect(toast).toBeVisible();
		expect(overlap(await boxOf(toast), await boxOf(stop)), "the toast over Stop").toBe(false);

		// Pressed again, the button answers: nothing is in the way.
		tap.answer("cancel_subagent", () => ({ ok: false, error: "omp could not stop it" }));
		await stop.click();
		await expect(page.getByText("omp could not stop it")).toBeVisible();
		expect(tap.commands("cancel_subagent")).toHaveLength(2);
		// Wherever the stack went, it is on screen.
		const stack = await boxOf(page.getByTestId("toast").first());
		expect(stack.x).toBeGreaterThanOrEqual(0);
		expect(stack.x + stack.width).toBeLessThanOrEqual(size.width);
		expect(stack.y + stack.height).toBeLessThanOrEqual(size.height);
	});
}

test("on a phone the toast of a failed steer covers neither the subagent's message box, its Send, nor its Stop (#546)", async ({
	page,
}) => {
	const { tap, frame } = await openProbe(page, "Steer sheet probe", 0x5d);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByRole("complementary").getByRole("button", { name: "Hide sidebar" }).click();
	await page.getByTestId("toggle-panel").click();
	frame(lifecycle("Scout", "started", { description: "Looks around" }));
	await items(page).first().click();
	const detail = page.getByTestId("subagent-detail");
	const input = detail.getByLabel("Message subagent");
	const send = detail.getByRole("button", { name: "Send to subagent" });
	const stop = detail.getByRole("button", { name: "Stop Scout" });
	tap.answer("steer_subagent", () => ({ ok: false, error: "omp could not steer it" }));
	await input.fill("Use the direct path");
	await send.click();
	const toast = page.getByTestId("toast").filter({ hasText: "omp could not steer it" });
	await expect(toast).toBeVisible();
	const box = await boxOf(toast);
	for (const [what, control] of [
		["message box", input],
		["Send", send],
		["Stop", stop],
	] as const)
		expect(overlap(box, await boxOf(control)), `the toast over the ${what}`).toBe(false);

	// Tried again while the toast is up: the button answers, and the typed text is still there to send.
	await expect(input).toHaveValue("Use the direct path");
	await send.click();
	await expect.poll(() => tap.commands("steer_subagent").length).toBe(2);
});

test("the Stop controls are in Chinese too, and are 24px or more on a phone (#455)", async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem("ompw.lang", "zh-CN"));
	const title = "Stop phone probe";
	const { frame } = await openProbe(page, title, 0xf3, () => {
		addTaskTurn(sessionWithSubagents(0xf3, title, {}), 0xf3, "call_phone", ["Alpha"]);
	});
	// The sidebar is a drawer on a phone, so the conversation is opened first and the screen shrinks after.
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByRole("complementary").getByRole("button", { name: "隐藏侧边栏" }).click();
	frame(lifecycle("Alpha", "started", { description: "Alpha work", parentToolCallId: "call_phone" }));
	const onCard = page
		.locator('[data-testid="tool-card"][data-tool="task"]')
		.getByRole("button", { name: "停止 Alpha" });
	await expect(onCard).toBeVisible();
	const cardBox = await onCard.boundingBox();
	expect(cardBox?.height).toBeGreaterThanOrEqual(24);

	await page.getByTestId("toggle-panel").click();
	const inList = page.getByTestId("subagent-list").getByRole("button", { name: "停止 Alpha" });
	await expect(inList).toBeVisible();
	const listBox = await inList.boundingBox();
	expect(listBox?.height).toBeGreaterThanOrEqual(24);
	expect(listBox?.width).toBeGreaterThanOrEqual(24);

	await items(page).first().click();
	const inDetail = page.getByTestId("subagent-detail").getByRole("button", { name: "停止 Alpha" });
	await expect(inDetail).toBeVisible();
	await expect(inDetail).toHaveText("停止");
	const detailBox = await inDetail.boundingBox();
	expect(detailBox?.height).toBeGreaterThanOrEqual(24);
});
