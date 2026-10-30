import { openSidebar, ownSession, startLive } from "../support/live.ts";
import { type Msg, type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { boxOf } from "../support/style.ts";
import { devices, expect, type Page, test } from "./fixtures.ts";

/**
 * Setting a goal with omp interviewing you first. No model is called: the interview's first message is answered
 * here and the model's proposal arrives as a pushed frame; the tool is registered with the real omp (that needs no
 * model), and omp's own `goal` answers are stubbed where a test needs a goal to exist.
 */

const PROPOSAL = {
	objective: "Make the tests run in under a second",
	acceptance_criteria: ["`bun test` exits 0", "A full run takes under a second"],
	token_budget: 150_000,
};

/** The model proposes: omp calls the host tool, and the server forwards the call. */
const propose = (tap: SocketTap, liveId: string, id = "h-1", args: unknown = PROPOSAL) =>
	tap.push({
		t: "frame",
		liveId,
		frame: { type: "host_tool_call", id, toolCallId: `t-${id}`, toolName: "propose_goal", arguments: args },
	});

/** What the page sent, in order, as short labels. */
const sentLog = (tap: SocketTap) =>
	tap.sent.flatMap((m): string[] => {
		if (m.t === "ui_response") return ["ui_response"];
		if (m.t !== "rpc" || !m.command) return [];
		const c = m.command;
		// Looking at the goal is what every page does when it opens a conversation.
		if (c.type === "goal") return c.op === "get" ? [] : [`goal ${c.op}`];
		if (c.type === "set_host_tools") return [Array.isArray(c.tools) && c.tools.length ? "tool on" : "tool off"];
		if (["prompt", "abort"].includes(String(c.type))) return [String(c.type)];
		return [];
	});

/** The answer the page gives omp for a host tool call: a `ui_response` carrying the call's result (shared/guided-goal.ts `hostResult`). */
interface HostResponse {
	id: string;
	isError?: boolean;
	result: { content: { text: string }[] };
}
const answerOf = (tap: SocketTap): Msg[] => tap.sent.filter((m) => m.t === "ui_response");
const responseOf = (m: Msg): HostResponse => m.response as HostResponse; // the page's own message
const resultText = (m: Msg): string =>
	responseOf(m)
		.result.content.map((c) => c.text)
		.join("\n");

async function interviewing(page: Page, title: string, n: number) {
	ownSession(n, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	// Starting the interview sends a message the model would answer; here nobody does.
	tap.answer("prompt", (c) =>
		String(c.message).startsWith("Help me define a goal") ? { ok: true, data: { agentInvoked: true } } : undefined,
	);
	tap.answer("goal", (c) => (c.op === "create" ? { ok: true, data: { goal: null } } : undefined));
	await page.goto("/");
	const liveId = await startLive(page, tap, title, `guided-${n}`);
	return { tap, liveId };
}

async function startInterview(page: Page, rough = "make the tests faster") {
	await page.getByTestId("open-goal").click();
	const field = page.getByTestId("goal-rough");
	await expect(field).toBeFocused();
	await field.fill(rough);
	await page.getByTestId("goal-guided-start").click();
	await expect(page.getByTestId("goal-guided-form")).toHaveCount(0);
	await expect(page.getByTestId("guided-bar")).toBeVisible();
}

test("a guided goal: the interview starts, the proposal is edited and confirmed, and only then is the goal created", async ({
	page,
}) => {
	const { tap, liveId } = await interviewing(page, "Guided goal probe", 0xe0);
	await startInterview(page);

	// The model gets its tool first and the request second; nothing is created yet.
	expect(sentLog(tap)).toEqual(["tool on", "prompt"]);
	expect(tap.commands("set_host_tools")[0].tools).toMatchObject([{ name: "propose_goal", loadMode: "essential" }]);
	const request = String(tap.commands("prompt")[0].message);
	expect(request).toContain("My rough idea: make the tests faster");
	expect(request).toContain("one focused question at a time");

	propose(tap, liveId);
	const card = page.getByTestId("ui-request");
	await expect(card).toHaveAttribute("data-method", "propose_goal");
	await expect(card).toContainText("Confirm the goal");
	// The bar gives way to the proposal.
	await expect(page.getByTestId("guided-bar")).toHaveCount(0);
	await expect(page.getByTestId("proposal-objective")).toHaveValue(PROPOSAL.objective);
	await expect(page.getByTestId("proposal-criteria")).toHaveValue(PROPOSAL.acceptance_criteria.join("\n"));
	await expect(page.getByTestId("proposal-budget")).toHaveValue("150000");
	expect(sentLog(tap)).toEqual(["tool on", "prompt"]);

	// The user changes all three before confirming.
	await page.getByTestId("proposal-objective").fill("Make the tests run in under half a second");
	await page.getByTestId("proposal-criteria").fill("`bun test` exits 0\nNo test is skipped");
	await page.getByTestId("proposal-budget").fill("200000");
	await page.getByTestId("proposal-start").click();

	await expect(card).toHaveCount(0);
	// The goal comes first, then the model hears, then the tool goes: the interview is over.
	await expect.poll(() => sentLog(tap).join(",")).toBe("tool on,prompt,goal create,ui_response,tool off");
	const create = tap.commands("goal").find((c) => c.op === "create");
	expect(create).toEqual({
		type: "goal",
		op: "create",
		objective:
			"Make the tests run in under half a second\n\nAcceptance criteria:\n- `bun test` exits 0\n- No test is skipped",
		token_budget: 200_000,
	});
	const [answer] = answerOf(tap);
	expect(responseOf(answer).id).toBe("h-1");
	expect(resultText(answer)).toContain("The user confirmed the goal");
	expect(resultText(answer)).toContain("Make the tests run in under half a second");
	await expect(page.getByTestId("guided-bar")).toHaveCount(0);

	// omp reports the goal it now has.
	tap.push({
		t: "frame",
		liveId,
		frame: {
			type: "goal_updated",
			goal: { id: "g1", objective: String(create?.objective), status: "active", tokenBudget: 200_000 },
		},
	});
	await expect(page.getByTestId("goal-bar")).toContainText("Make the tests run in under half a second");
});

test("cancelling the proposal declines it to the model and creates no goal", async ({ page }) => {
	const { tap, liveId } = await interviewing(page, "Guided cancel probe", 0xe1);
	await startInterview(page);
	propose(tap, liveId);
	await page.getByTestId("proposal-cancel").click();

	await expect(page.getByTestId("ui-request")).toHaveCount(0);
	await expect.poll(() => sentLog(tap).join(",")).toBe("tool on,prompt,ui_response,tool off");
	expect(resultText(answerOf(tap)[0])).toContain("cancelled goal setup");
	expect(tap.commands("goal").some((c) => c.op === "create")).toBe(false);
	await expect(page.getByTestId("guided-bar")).toHaveCount(0);
});

test("asking for changes sends the user's words to the model and the interview goes on", async ({ page }) => {
	const { tap, liveId } = await interviewing(page, "Guided revise probe", 0xe2);
	await startInterview(page);
	propose(tap, liveId);
	await page.getByTestId("proposal-changes").click();
	const feedback = page.getByTestId("proposal-feedback");
	await expect(feedback).toBeFocused();
	// Nothing to send until something is said.
	await expect(page.getByTestId("proposal-send")).toBeDisabled();
	await feedback.fill("Also require a time limit");
	await page.getByTestId("proposal-send").click();

	await expect(page.getByTestId("ui-request")).toHaveCount(0);
	expect(resultText(answerOf(tap)[0])).toContain("wants changes:\nAlso require a time limit");
	// Still an interview: the tool stays, and the bar is back until the model proposes again.
	expect(sentLog(tap)).toEqual(["tool on", "prompt", "ui_response"]);
	await expect(page.getByTestId("guided-bar")).toBeVisible();
	propose(tap, liveId, "h-2");
	await expect(page.getByTestId("proposal-objective")).toHaveValue(PROPOSAL.objective);
});

test("a goal omp refuses stays in the proposal, with what was typed", async ({ page }) => {
	const { tap, liveId } = await interviewing(page, "Guided refused probe", 0xe3);
	tap.answer("goal", (c) => (c.op === "create" ? { ok: false, error: "forced goal failure" } : undefined));
	await startInterview(page);
	propose(tap, liveId);
	await page.getByTestId("proposal-objective").fill("An objective I edited");
	await page.getByTestId("proposal-start").click();

	await expect(page.getByTestId("proposal-error")).toContainText("forced goal failure");
	await expect(page.getByTestId("proposal-objective")).toHaveValue("An objective I edited");
	// The model has heard nothing and the interview is not over.
	expect(sentLog(tap)).toEqual(["tool on", "prompt", "goal create"]);
	await expect(page.getByTestId("proposal-start")).toBeEnabled();
});

test("cancelling the interview takes the tool away and leaves no goal; a turn under way is stopped", async ({
	page,
}) => {
	const { tap, liveId } = await interviewing(page, "Guided bar probe", 0xe4);
	await startInterview(page);
	tap.push({ t: "frame", liveId, frame: { type: "agent_start" } });
	await expect(page.getByTestId("stop")).toBeVisible();
	await page.getByTestId("guided-cancel").click();

	await expect(page.getByTestId("guided-bar")).toHaveCount(0);
	expect(sentLog(tap)).toEqual(["tool on", "prompt", "tool off", "abort"]);
	expect(tap.commands("goal").some((c) => c.op === "create")).toBe(false);
});

test("Set it directly leaves the interview for the form that takes the objective", async ({ page }) => {
	const { tap } = await interviewing(page, "Guided direct probe", 0xe5);
	await startInterview(page);
	await page.getByTestId("guided-direct").click();

	await expect(page.getByTestId("guided-bar")).toHaveCount(0);
	await expect(page.getByTestId("goal-direct-form")).toBeVisible();
	expect(sentLog(tap)).toEqual(["tool on", "prompt", "tool off"]);
	await page.getByTestId("goal-objective").fill("Write the release notes");
	await page.getByTestId("goal-create").click();
	await expect.poll(() => tap.commands("goal").filter((c) => c.op === "create")).toHaveLength(1);
});

test("the interview can be skipped: the dialog's direct form creates the goal without asking anything", async ({
	page,
}) => {
	const { tap } = await interviewing(page, "Guided skip probe", 0xe6);
	await page.getByTestId("open-goal").click();
	await expect(page.getByTestId("goal-guided-form")).toBeVisible();
	await page.getByTestId("goal-direct-toggle").click();
	await page.getByTestId("goal-objective").fill("Write the release notes");
	await page.getByTestId("goal-budget").fill("75000");
	await page.getByTestId("goal-create").click();

	await expect.poll(() => tap.commands("goal").filter((c) => c.op === "create")).toHaveLength(1);
	expect(tap.commands("goal").find((c) => c.op === "create")).toEqual({
		type: "goal",
		op: "create",
		objective: "Write the release notes",
		token_budget: 75_000,
	});
	expect(sentLog(tap)).toEqual(["goal create"]);

	// And back: the dialog offers the interview again, on its first form each time it opens.
	await page.getByTestId("open-goal").click();
	await expect(page.getByTestId("goal-guided-form")).toBeVisible();
});

test("a conversation that already has a goal does not start another: the Goal control shows it and offers no interview", async ({
	page,
}) => {
	const { tap, liveId } = await interviewing(page, "Guided active probe", 0xe7);
	tap.push({
		t: "frame",
		liveId,
		frame: { type: "goal_updated", goal: { id: "g1", objective: "Ship it", status: "active" } },
	});
	await expect(page.getByTestId("goal-bar")).toBeVisible();
	await page.getByTestId("open-goal").click();
	await expect(page.getByTestId("goal-details")).toContainText("Ship it");
	await expect(page.getByTestId("goal-rough")).toHaveCount(0);
	// The palette entry goes to the same place: collapsed again, it opens the goal where the form would have been.
	await page.getByTestId("goal-toggle").click();
	await expect(page.getByTestId("goal-details")).toHaveCount(0);
	await page.keyboard.press("ControlOrMeta+K");
	await page.getByTestId("palette-input").fill("goal");
	await expect(page.getByTestId("palette-goal")).toContainText("Current goal");
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("goal-rough")).toHaveCount(0);
	await expect(page.getByTestId("goal-details")).toBeVisible();
	expect(sentLog(tap)).toEqual([]);
});

test("a proposal without an objective is sent back to the model as an error instead of waiting for the user", async ({
	page,
}) => {
	const { tap, liveId } = await interviewing(page, "Guided invalid probe", 0xe8);
	await startInterview(page);
	propose(tap, liveId, "h-bad", { objective: "  ", acceptance_criteria: [] });

	await expect.poll(() => answerOf(tap).length).toBe(1);
	expect(responseOf(answerOf(tap)[0])).toMatchObject({ id: "h-bad", isError: true });
	expect(resultText(answerOf(tap)[0])).toContain("non-empty objective");
	await expect(page.getByTestId("ui-request")).toHaveCount(0);
});

test("the shortcut and the palette open the goal dialog from a conversation", async ({ page }) => {
	await interviewing(page, "Guided entry probe", 0xe9);
	await page.keyboard.press("ControlOrMeta+Shift+G");
	await expect(page.getByTestId("goal-guided-form")).toBeVisible();
	await expect(page.getByTestId("goal-rough")).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("goal-guided-form")).toHaveCount(0);

	await page.keyboard.press("ControlOrMeta+K");
	await page.getByTestId("palette-input").fill("goal");
	await expect(page.getByTestId("palette-goal")).toBeVisible();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("goal-guided-form")).toBeVisible();
	await expect(page.getByTestId("goal-rough")).toBeFocused();
});

// ------------------------------------------------------------------ New chat

async function newChat(page: Page) {
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	tap.answer("prompt", (c) =>
		String(c.message).startsWith("Help me define a goal") ? { ok: true, data: { agentInvoked: true } } : undefined,
	);
	tap.answer("goal", (c) => (c.op === "create" ? { ok: true, data: { goal: null } } : undefined));
	await page.goto("/");
	// The footer's controls appear once the process for the folder is up.
	await expect(page.getByTestId("goal-mode")).toBeVisible({ timeout: 60_000 });
	return tap;
}

test("New chat's Goal toggle starts an interview from the message, and Skip interview makes it the goal", async ({
	page,
}) => {
	const tap = await newChat(page);
	const toggle = page.getByTestId("goal-mode");
	const composer = page.getByTestId("composer");
	await expect(toggle).toHaveAttribute("aria-pressed", "false");
	await expect(page.getByTestId("goal-direct")).toHaveCount(0);

	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-pressed", "true");
	await expect(composer).toHaveAttribute("placeholder", /A rough idea is enough/);
	await composer.fill("build a todo app");
	await page.getByTestId("send").click();
	// The chat opens on the interview.
	await expect(page.getByTestId("guided-bar")).toBeVisible({ timeout: 30_000 });
	expect(sentLog(tap)).toEqual(["tool on", "prompt"]);
	expect(String(tap.commands("prompt")[0].message)).toContain("My rough idea: build a todo app");
});

test("New chat with the interview skipped sets the message as the goal at once", async ({ page }) => {
	const tap = await newChat(page);
	await page.getByTestId("goal-mode").click();
	const skip = page.getByTestId("goal-direct");
	await skip.click();
	await expect(skip).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByTestId("composer")).toHaveAttribute("placeholder", /starts working on it right away/);
	await page.getByTestId("composer").fill("Write the release notes");
	await page.getByTestId("send").click();

	await expect.poll(() => tap.commands("goal").filter((c) => c.op === "create")).toHaveLength(1);
	expect(tap.commands("goal").find((c) => c.op === "create")).toEqual({
		type: "goal",
		op: "create",
		objective: "Write the release notes",
	});
	expect(sentLog(tap)).toEqual(["goal create"]);
	await expect(page.getByTestId("guided-bar")).toHaveCount(0);
});

test("the shortcut turns on New chat's goal mode and puts the cursor in the message", async ({ page }) => {
	await newChat(page);
	await expect(page.getByTestId("goal-mode")).toHaveAttribute("aria-pressed", "false");
	await page.keyboard.press("ControlOrMeta+Shift+G");
	await expect(page.getByTestId("goal-mode")).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByTestId("composer")).toBeFocused();
});

// ------------------------------------------------------------------ one interview at a time, and how it ends

/** Open the goal dialog on its direct form and set `objective` by hand. */
async function setDirectly(page: Page, objective: string) {
	await page.getByTestId("open-goal").click();
	await page.getByTestId("goal-direct-toggle").click();
	await page.getByTestId("goal-objective").fill(objective);
	await page.getByTestId("goal-create").click();
}

test("a goal set directly while the interview is open ends it: the tool goes and the bar with it", async ({ page }) => {
	const { tap } = await interviewing(page, "Guided supersede probe", 0xc4);
	await startInterview(page);
	await setDirectly(page, "Write the release notes");

	await expect(page.getByTestId("guided-bar")).toHaveCount(0);
	// The goal first, then the tool goes: a refused goal would leave the interview as it was.
	await expect.poll(() => sentLog(tap).join(",")).toBe("tool on,prompt,goal create,tool off");
	await expect(page.getByTestId("goal-direct-form")).toHaveCount(0);
});

test("a goal set directly while a proposal waits answers the proposal, so the model does not wait for it", async ({
	page,
}) => {
	const { tap, liveId } = await interviewing(page, "Guided replaced probe", 0xc5);
	await startInterview(page);
	propose(tap, liveId);
	await expect(page.getByTestId("ui-request")).toHaveAttribute("data-method", "propose_goal");
	await setDirectly(page, "Write the release notes");

	await expect(page.getByTestId("ui-request")).toHaveCount(0);
	await expect.poll(() => sentLog(tap).join(",")).toBe("tool on,prompt,goal create,ui_response,tool off");
	const [answer] = answerOf(tap);
	expect(responseOf(answer).id).toBe("h-1");
	expect(resultText(answer)).toContain("set a goal directly instead");
	expect(resultText(answer)).toContain("Write the release notes");
});

test("a refused direct goal leaves the interview open", async ({ page }) => {
	const { tap } = await interviewing(page, "Guided kept probe", 0xc6);
	tap.answer("goal", (c) => (c.op === "create" ? { ok: false, error: "forced goal failure" } : undefined));
	await startInterview(page);
	await setDirectly(page, "Write the release notes");

	await expect(page.getByTestId("toast").filter({ hasText: "forced goal failure" })).toBeVisible();
	await expect(page.getByTestId("guided-bar")).toBeVisible();
	expect(sentLog(tap)).toEqual(["tool on", "prompt", "goal create"]);
});

test("a second interview is refused while one is open: nothing is sent and the first goes on", async ({ page }) => {
	const { tap } = await interviewing(page, "Guided twice probe", 0xc7);
	await startInterview(page);
	await page.getByTestId("open-goal").click();
	await page.getByTestId("goal-rough").fill("something else");
	await page.getByTestId("goal-guided-start").click();

	await expect(page.getByTestId("toast").filter({ hasText: "already open" })).toBeVisible();
	expect(sentLog(tap)).toEqual(["tool on", "prompt"]);
	await expect(page.getByTestId("guided-bar")).toBeVisible();
});

test("cancelling an interview that still waits behind a running turn takes it out of the queue and leaves the turn alone", async ({
	page,
}) => {
	const { tap, liveId } = await interviewing(page, "Guided queued probe", 0xcc);
	// Another turn is running when the interview is asked for: it goes in omp's queue.
	tap.push({ t: "frame", liveId, frame: { type: "agent_start" } });
	await expect(page.getByTestId("stop")).toBeVisible();
	tap.answer("remove_queued_message", () => ({ ok: true, data: { removed: true } }));
	await startInterview(page);
	expect(tap.commands("prompt")[0]).toMatchObject({ streamingBehavior: "followUp" });
	const queued = String(tap.commands("prompt")[0].message);
	tap.push({ t: "frame", liveId, frame: { type: "queue_update", steering: [], followUp: [queued] } });

	await page.getByTestId("guided-cancel").click();
	await expect(page.getByTestId("guided-bar")).toHaveCount(0);
	expect(tap.commands("remove_queued_message")).toEqual([
		{ type: "remove_queued_message", message: queued, queue: "followUp" },
	]);
	// The turn that was running is not the interview's, and goes on.
	expect(tap.commands("abort")).toEqual([]);
	expect(sentLog(tap)).toEqual(["tool on", "prompt", "tool off"]);
	await expect(page.getByTestId("stop")).toBeVisible();
});

test("a goal set directly takes the waiting interview out of the queue too", async ({ page }) => {
	const { tap, liveId } = await interviewing(page, "Guided queued direct probe", 0xcd);
	tap.push({ t: "frame", liveId, frame: { type: "agent_start" } });
	await expect(page.getByTestId("stop")).toBeVisible();
	tap.answer("remove_queued_message", () => ({ ok: true, data: { removed: true } }));
	await startInterview(page);
	const queued = String(tap.commands("prompt")[0].message);
	tap.push({ t: "frame", liveId, frame: { type: "queue_update", steering: [], followUp: [queued] } });
	await setDirectly(page, "Write the release notes");

	await expect(page.getByTestId("guided-bar")).toHaveCount(0);
	await expect.poll(() => tap.commands("remove_queued_message")).toHaveLength(1);
	expect(tap.commands("abort")).toEqual([]);
});

test("New chat: an interview whose first message fails to send leaves nothing open, and sending again works", async ({
	page,
}) => {
	const tap = await newChat(page);
	let tries = 0;
	tap.answer("prompt", (c) =>
		String(c.message).startsWith("Help me define a goal")
			? ++tries === 1
				? { ok: false, error: "forced send failure" }
				: { ok: true, data: { agentInvoked: true } }
			: undefined,
	);
	await page.getByTestId("goal-mode").click();
	await page.getByTestId("composer").fill("build a todo app");
	await page.getByTestId("send").click();

	// The interview never started: the tool is taken away again and the draft is still here.
	await expect.poll(() => sentLog(tap).join(",")).toBe("tool on,prompt,tool off");
	await expect(page.getByTestId("composer")).toHaveValue("build a todo app");
	await expect(page.getByTestId("guided-bar")).toHaveCount(0);

	// That failure is not an interview in progress: the second send is not refused as a second one.
	await page.getByTestId("send").click();
	await expect(page.getByTestId("guided-bar")).toBeVisible({ timeout: 30_000 });
	expect(sentLog(tap)).toEqual(["tool on", "prompt", "tool off", "tool on", "prompt"]);
});

test.describe("on a phone", () => {
	const { defaultBrowserType: _browser, ...pixel } = devices["Pixel 5"];
	test.use({ ...pixel, viewport: { width: 390, height: 844 } });

	test("the interview's bar gives its text the width and puts its buttons under it", async ({ page }) => {
		const title = "Guided goal phone probe";
		ownSession(0x6a01, title);
		await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
		const tap = await tapSocket(page);
		tap.answer("prompt", (c) =>
			String(c.message).startsWith("Help me define a goal") ? { ok: true, data: { agentInvoked: true } } : undefined,
		);
		await page.goto("/");
		await openSidebar(page);
		await startLive(page, tap, title, "guided-phone");
		// On a phone the goal is in the header's More menu.
		await page.getByTestId("chat-more").click();
		await page.getByTestId("chat-more-panel").getByTestId("open-goal").click();
		await page.getByTestId("goal-rough").fill("make the tests faster");
		await page.getByTestId("goal-guided-start").click();
		const bar = page.getByTestId("guided-bar");
		await expect(bar).toBeVisible();
		const text = await boxOf(bar.locator("p"));
		// Before: a column of about 120 px beside the two buttons, seven lines long.
		expect(text.width).toBeGreaterThan(220);
		expect((await boxOf(bar.getByTestId("guided-cancel"))).y).toBeGreaterThanOrEqual(text.y + text.height - 1);
	});

	test("the proposal's buttons stay inside its card, under what scrolls; editing clears a refusal", async ({
		page,
	}) => {
		const title = "Guided pinned probe";
		ownSession(0x7301, title);
		await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
		const tap = await tapSocket(page);
		tap.answer("prompt", (c) =>
			String(c.message).startsWith("Help me define a goal") ? { ok: true, data: { agentInvoked: true } } : undefined,
		);
		tap.answer("goal", (c) => (c.op === "create" ? { ok: false, error: "forced goal failure" } : undefined));
		// A short window, so that the card with a refusal in it is taller than it leaves.
		await page.setViewportSize({ width: 390, height: 640 });
		await page.goto("/");
		await openSidebar(page);
		const liveId = await startLive(page, tap, title, "guided-pinned");
		await page.getByTestId("chat-more").click();
		await page.getByTestId("chat-more-panel").getByTestId("open-goal").click();
		await page.getByTestId("goal-rough").fill("make the tests faster");
		await page.getByTestId("goal-guided-start").click();
		await expect(page.getByTestId("guided-bar")).toBeVisible();
		propose(tap, liveId);
		const start = page.getByTestId("proposal-start");
		await expect(start).toBeVisible();
		await start.click();
		await expect(page.getByTestId("proposal-error")).toContainText("forced goal failure");

		// Before: Start goal was half below the card's edge, reached by scrolling it, and the refusal was under the fold.
		const card = await boxOf(page.getByTestId("ui-request"));
		for (const shown of [start, page.getByTestId("proposal-error")]) {
			const box = await boxOf(shown);
			expect(box.y).toBeGreaterThanOrEqual(card.y);
			expect(box.y + box.height).toBeLessThanOrEqual(card.y + card.height + 1);
		}

		// Asking for changes (after the refusal, as it comes) opens its form above the pinned bar: the field and its Send are
		// on the screen without scrolling. Before, both were under the bar, with the Send row peeking out below it.
		await page.getByTestId("proposal-changes").click();
		await expect(page.getByTestId("proposal-feedback")).toBeFocused();
		await page.getByTestId("proposal-feedback").fill("Also require a time limit");
		for (const id of ["proposal-feedback", "proposal-send"]) {
			await expect
				.poll(
					async () => {
						const bar = await boxOf(page.getByTestId("proposal-bar"));
						const box = await boxOf(page.getByTestId(id));
						return box.y >= card.y && box.y + box.height <= bar.y + 1;
					},
					{ message: `${id} is above the pinned bar, in the card` },
				)
				.toBe(true);
		}

		// What the refusal said was about what was typed: typing something else takes it away.
		await page.getByTestId("proposal-objective").fill("Another objective");
		await expect(page.getByTestId("proposal-error")).toHaveCount(0);
	});
});
