import { event, lifecycle, openGraph } from "../support/agent-graph-seed.ts";
import { ownSession, startLive } from "../support/live.ts";
import {
	agentEnd,
	agentStart,
	block,
	goalUpdated,
	messageEnd,
	messageStart,
	toolCall,
	toolEnd,
	toolStart,
} from "../support/omp-frames.ts";
import { choose } from "../support/select.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * Live animations (v0.15.0): off by default; turned on in Settings › Appearance, a shimmer over the reply being written, a
 * bar on a running tool card, a burst when the turn ends well, particles along the agent graph's lines; none under the
 * system's reduced motion. Once the agent is idle nothing is left: no running animation and no animation frame asked for
 * over two seconds (`requestAnimationFrame` is counted from before the page's own scripts run). Frames are pushed over the
 * page's socket: no model is called.
 */

declare global {
	interface Window {
		/** How many times the page asked for an animation frame. */
		rafCalls: number;
	}
}

/** Count every `requestAnimationFrame` of the page, from before its scripts run. */
async function countFrames(page: Page): Promise<void> {
	await page.addInitScript(() => {
		window.rafCalls = 0;
		const ask = window.requestAnimationFrame.bind(window);
		window.requestAnimationFrame = (cb) => {
			window.rafCalls++;
			return ask(cb);
		};
	});
}

/** Over `ms` of idle: how many animation frames the page asked for, and the animations that were running at the end. */
async function idleFor(page: Page, ms: number): Promise<{ frames: number; running: string[] }> {
	const before = await page.evaluate(() => window.rafCalls);
	// The count is the page's own: what it drew before it went idle asked for frames.
	expect(before).toBeGreaterThan(0);
	await page.waitForTimeout(ms);
	return page.evaluate((b) => {
		const running = document
			.getAnimations()
			.filter((a) => a.playState !== "finished")
			.map((a) => {
				const el = (a.effect as KeyframeEffect | null)?.target;
				return `${a.constructor.name}:${(a as CSSAnimation).animationName ?? ""}:${el instanceof Element ? el.className : ""}`;
			});
		return { frames: window.rafCalls - b, running };
	}, before);
}

const assistant = (page: Page) => page.getByTestId("msg-assistant");

/**
 * One turn: a reply that writes text and calls `bash`, the tool runs, then a reply that ends the turn. The fake omp writes
 * nothing to the conversation's file, and the page takes a reply omp ended as saved once it has read the file again (which
 * a `message_end` asks for): the reply that calls the tool is not ended, as in `tool-timer.spec.ts`, and the last one ends
 * with the turn, in one go, after its text was seen.
 */
async function runTurn(
	page: Page,
	frame: (f: Record<string, unknown>) => void,
	n: string,
	during: { writing: () => Promise<void>; tool: () => Promise<void> },
): Promise<void> {
	frame(agentStart());
	frame(messageStart(`m-${n}-1`));
	for (const f of block(`m-${n}-1`, "text", 0, ["Looking ", "at it"])) frame(f);
	await expect(assistant(page).last()).toContainText("Looking at it");
	await during.writing();
	const call = { id: `tc-${n}`, name: "bash", arguments: { command: "sleep 5" } };
	frame(toolCall(`m-${n}-1`, 1, call));
	frame(toolStart(call.id, "bash", call.arguments));
	await expect(page.locator('[data-testid="tool-card"][data-tool="bash"]').last()).toBeVisible();
	await during.tool();
	frame(toolEnd(call.id, "bash", "done"));
	frame(messageStart(`m-${n}-2`));
	for (const f of block(`m-${n}-2`, "text", 0, ["All ", "done."])) frame(f);
	await expect(assistant(page).last()).toContainText("All done.");
	frame(messageEnd(`m-${n}-2`, [{ type: "text", text: "All done." }]));
	frame(agentEnd());
	await expect(page.getByTestId("stop")).toHaveCount(0);
}

async function chat(page: Page, n: number, title: string) {
	ownSession(n, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, title, `motion-probe-${n.toString(16)}`);
	return (f: Record<string, unknown>) => tap.push({ t: "frame", liveId, frame: f });
}

test("off by default: Settings shows it off, and a turn draws no animation of its own", async ({ page }) => {
	await page.goto("/#/settings/look");
	await expect(page.getByTestId("animations")).not.toBeChecked();
	await expect(page.getByTestId("animation-intensity")).toHaveAttribute("data-value", "normal");
	await expect(page.getByTestId("animations-reduced")).toHaveCount(0);

	const frame = await chat(page, 0xa0, "Motion off probe");
	const none = async () => {
		await expect(page.locator("[data-motion]")).toHaveCount(0);
		await expect(page.locator(".live-shimmer, .live-progress, .graph-particle")).toHaveCount(0);
	};
	await runTurn(page, frame, "off", { writing: none, tool: none });
	await page.waitForTimeout(300);
	await expect(page.getByTestId("live-celebration")).toHaveCount(0);
	await none();
});

test("on: a shimmer while the model writes, a bar on the running tool, a burst at the end, then nothing moves; a goal's burst", async ({
	page,
}) => {
	await countFrames(page);
	// Turned on in Settings, as a person would, at the lively intensity: kept here and on the server.
	await page.goto("/#/settings/look");
	await page.getByTestId("animations").check();
	await choose(page.getByTestId("animation-intensity"), "lively");
	await expect.poll(() => page.evaluate(() => localStorage.getItem("ompw.animations"))).toBe("on");
	await expect.poll(() => page.evaluate(() => localStorage.getItem("ompw.animationIntensity"))).toBe("lively");

	const frame = await chat(page, 0xa1, "Motion on probe");
	await runTurn(page, frame, "on", {
		writing: async () => {
			const shimmer = assistant(page).last().getByTestId("live-shimmer");
			await expect(shimmer).toHaveAttribute("data-motion", "lively");
			// The turn's running figures shimmer too.
			await expect(page.getByTestId("turn-stats-live").getByTestId("live-shimmer")).toHaveCount(1);
			const names = await shimmer.evaluate((el) =>
				el.getAnimations({ subtree: true }).map((a) => (a as CSSAnimation).animationName),
			);
			expect(names).toEqual(["live-sweep"]);
		},
		tool: async () => {
			const card = page.locator('[data-testid="tool-card"][data-tool="bash"]').last();
			await expect(card.getByTestId("live-tool-progress")).toHaveCount(1);
		},
	});
	// The tool is done: its bar is gone.
	await expect(page.getByTestId("live-tool-progress")).toHaveCount(0);
	const burst = page.getByTestId("live-celebration");
	await expect(burst).toHaveAttribute("data-kind", "turn");
	await expect(burst).toHaveAttribute("data-motion", "lively");
	expect(await burst.evaluate((el) => el.getAnimations({ subtree: true }).length)).toBeGreaterThan(10);
	// It lasts a moment, and goes.
	await expect(burst).toHaveCount(0, { timeout: 5000 });
	await expect(page.locator("[data-motion]")).toHaveCount(0);

	// Idle: nothing is animated and no frame is asked for.
	const idle = await idleFor(page, 2000);
	expect(idle.running).toEqual([]);
	expect(idle.frames).toBe(0);

	// A goal that omp marks complete while the page watches: a bigger burst, of its own kind.
	const goal = { id: "g-motion", objective: "Ship it", status: "active" };
	frame(goalUpdated(goal));
	await expect(page.getByTestId("live-celebration")).toHaveCount(0);
	frame(goalUpdated({ ...goal, status: "complete" }));
	await expect(burst).toHaveAttribute("data-kind", "goal");
	expect(await burst.evaluate((el) => el.getAnimations({ subtree: true }).length)).toBeGreaterThan(30);
	await expect(burst).toHaveCount(0, { timeout: 5000 });
});

test("the system's reduced motion turns them off, and Settings says so", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.addInitScript(() => localStorage.setItem("ompw.animations", "on"));
	await page.goto("/#/settings/look");
	await expect(page.getByTestId("animations")).toBeChecked();
	await expect(page.getByTestId("animations-reduced")).toBeVisible();

	const frame = await chat(page, 0xa2, "Motion reduced probe");
	const none = async () => {
		await expect(page.locator("[data-motion]")).toHaveCount(0);
	};
	await runTurn(page, frame, "reduced", { writing: none, tool: none });
	await page.waitForTimeout(300);
	await expect(page.getByTestId("live-celebration")).toHaveCount(0);

	// The system lets motion through again: the next turn has it.
	await page.emulateMedia({ reducedMotion: "no-preference" });
	await runTurn(page, frame, "again", {
		writing: async () => {
			await expect(assistant(page).last().getByTestId("live-shimmer")).toHaveAttribute("data-motion", "normal");
		},
		tool: async () => {
			await expect(page.getByTestId("live-tool-progress")).toHaveCount(1);
		},
	});
	await expect(page.getByTestId("live-celebration")).toHaveAttribute("data-kind", "turn");
});

test("particles run along the agent graph's lines, and stop when nothing moves", async ({ page }) => {
	await countFrames(page);
	await page.addInitScript(() => localStorage.setItem("ompw.animations", "on"));
	const { running, frame } = await openGraph(page, 0xa3, "Motion graph probe");
	const particles = page.locator('[data-testid="graph-particles"] [data-testid="graph-particle"]');
	await expect(particles).toHaveCount(0);

	for (const id of ["Lead", "Helper"]) running.add(id);
	frame(lifecycle("Lead", "started", { parentToolCallId: "call_1" }));
	frame(lifecycle("Helper", "started", { index: 1, parentToolCallId: "call_1" }));
	// An assignment goes down each new spawn line (two particles each, at the normal intensity).
	await expect(page.locator('[data-testid="graph-particle"][data-kind="spawn"]').first()).toBeAttached();
	frame(
		event("Lead", {
			type: "tool_execution_start",
			toolCallId: "w1",
			toolName: "write",
			args: { path: "agent://Helper", content: "Take the docs folder." },
		}),
	);
	await expect(page.locator('[data-testid="graph-particle"][data-kind="message"]').first()).toBeAttached();
	// Each runs on a Web Animation of its transform, and is gone when it arrives.
	const props = await page
		.locator('[data-testid="graph-particle"]')
		.first()
		.evaluate((el) =>
			el.getAnimations().flatMap((a) => Object.keys((a.effect as KeyframeEffect).getKeyframes()[0] ?? {})),
		);
	expect(props).toEqual(expect.arrayContaining(["transform", "opacity"]));
	await expect(particles).toHaveCount(0, { timeout: 5000 });

	// Both finish well: their results go back up the spawn lines.
	for (const id of ["Lead", "Helper"]) {
		running.delete(id);
		frame(lifecycle(id, "completed"));
	}
	await expect(page.locator('[data-testid="graph-particle"][data-kind="result"]').first()).toBeAttached();
	await expect(particles).toHaveCount(0, { timeout: 5000 });

	const idle = await idleFor(page, 2000);
	expect(idle.running).toEqual([]);
	expect(idle.frames).toBe(0);
});
