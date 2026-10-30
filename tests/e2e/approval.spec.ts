import { ownSession, sessionRow, startLive } from "../support/live.ts";
import { type Msg, type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The permission mode (how much omp asks before it runs a tool) on the main screen. The switching needs no model:
 * the process behind the page is the real omp, which takes its mode from an overlay file the server rewrites. That a
 * running omp then applies it is checked with a model at the end (and in tests/contract/approval.test.ts).
 */

const WORK = () => process.env.OMPW_E2E_WORK as string;

/** What the default for new conversations is, and putting it back for the specs after. */
const api = (page: Page) => page.request;
test.afterEach(async ({ page }) => {
	await api(page).post("/api/approval", { data: { mode: null }, headers: { "x-omp-webui": "1" } });
});

async function newChat(page: Page): Promise<SocketTap> {
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), WORK());
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	await expect(page.getByTestId("approval-picker")).toBeVisible({ timeout: 60_000 });
	return tap;
}

const picker = (page: Page) => page.getByTestId("approval-picker");
const modeChanges = (tap: SocketTap): Msg[] => tap.sent.filter((m) => m.t === "approval_mode");

async function choose(page: Page, mode: "always-ask" | "always-ask-cached" | "write" | "yolo") {
	await picker(page).click();
	await page.getByTestId(`approval-${mode}`).click();
	await expect(picker(page)).toHaveAttribute("data-mode", mode);
}

test("New chat shows the permission mode as a compact switcher, and Auto-approve looks different", async ({ page }) => {
	const tap = await newChat(page);
	// The test omp has no mode configured, so this is omp's own default.
	await expect(picker(page)).toHaveAttribute("data-mode", "yolo");
	await expect(picker(page)).toContainText("Auto-approve");
	await expect(picker(page)).toHaveClass(/text-warning/);

	await picker(page).click();
	const menu = page.getByTestId("approval-menu");
	await expect(menu).toBeVisible();
	await expect(menu.getByRole("menuitemradio")).toHaveCount(4);
	await expect(page.getByTestId("approval-yolo")).toHaveAttribute("aria-checked", "true");
	await expect(page.getByTestId("approval-yolo")).toHaveClass(/text-warning/);
	await expect(page.getByTestId("approval-always-ask")).toContainText("Ask every time");
	await expect(page.getByTestId("approval-always-ask-cached")).toContainText("Ask and remember");
	await expect(page.getByTestId("approval-write")).toContainText("Ask for commands");
	await page.keyboard.press("Escape");
	await expect(menu).toHaveCount(0);

	await choose(page, "always-ask");
	await expect(picker(page)).toContainText("Ask every time");
	// The warning colour is for the mode that never asks.
	await expect(picker(page)).not.toHaveClass(/text-warning/);
	expect(modeChanges(tap)).toHaveLength(1);
	expect(modeChanges(tap)[0]).toMatchObject({ mode: "always-ask" });
});

test("Ask and remember, omp's fourth mode, is offered and chosen like the others, and omp takes it", async ({
	page,
}) => {
	const tap = await newChat(page);
	await choose(page, "always-ask-cached");
	await expect(picker(page)).toContainText("Ask and remember");
	await expect(picker(page)).not.toHaveClass(/text-warning/);
	expect(modeChanges(tap)).toHaveLength(1);
	expect(modeChanges(tap)[0]).toMatchObject({ mode: "always-ask-cached" });
	// The server answered with the live process in that mode: nothing was refused, and omp took the overlay.
	await expect
		.poll(async () =>
			((await (await api(page).get("/api/lives")).json()) as { approvalMode?: string }[]).some(
				(l) => l.approvalMode === "always-ask-cached",
			),
		)
		.toBe(true);

	// It is a default to pick in Settings too.
	await page.goto("/#/settings/safety");
	await expect(page.getByTestId("approval-settings")).toContainText("Ask and remember");
	await page.getByTestId("approval-default-always-ask-cached").check();
	await expect.poll(async () => (await (await api(page).get("/api/approval")).json()).mode).toBe("always-ask-cached");
});

test("a mode that only a newer omp has is shown as omp names it, in the switcher and in Settings, and picking one of ours replaces it", async ({
	page,
}) => {
	// The server says what a newer omp's setting looks like to it: no mode of ours, omp's own named.
	const named = (info: Record<string, unknown>) => {
		const { approvalMode: _own, ...rest } = info;
		return { ...rest, approvalOmp: "paranoid" };
	};
	const tap = await tapSocket(page);
	tap.rewrite((msg, request) => {
		if (msg.t === "reply" && request?.t === "open" && msg.ok)
			return { ...msg, data: named(msg.data as Record<string, unknown>) };
		if (msg.t === "live" && (msg.info as Record<string, unknown>).approvalMode === "yolo")
			return { ...msg, info: named(msg.info as Record<string, unknown>) };
		return msg;
	});
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), WORK());
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	await page.goto("/");
	await expect(picker(page)).toBeVisible({ timeout: 60_000 });
	await expect(picker(page)).toHaveAttribute("data-mode", "paranoid");
	await expect(picker(page)).toContainText("omp's setting: paranoid");

	await picker(page).click();
	for (const id of ["always-ask", "always-ask-cached", "write", "yolo"])
		await expect(page.getByTestId(`approval-${id}`)).toHaveAttribute("aria-checked", "false");
	await page.getByTestId("approval-write").click();
	await expect(picker(page)).toHaveAttribute("data-mode", "write");
	await expect(picker(page)).toContainText("Ask for commands");
});

test("the shortcut opens the switcher from the message box, and the keyboard picks the mode and gives the cursor back", async ({
	page,
}) => {
	await newChat(page);
	await page.getByTestId("composer").click();
	await page.keyboard.press("ControlOrMeta+Shift+A");
	await expect(page.getByTestId("approval-menu")).toBeVisible();
	// Home goes to the first item, "Ask every time", wherever the pointer happens to rest on the menu.
	await page.keyboard.press("Home");
	await page.keyboard.press("Enter");
	await expect(picker(page)).toHaveAttribute("data-mode", "always-ask");
	await expect(page.getByTestId("composer")).toBeFocused();

	// The same key closes it again.
	await page.keyboard.press("ControlOrMeta+Shift+A");
	await expect(page.getByTestId("approval-menu")).toBeVisible();
	await page.keyboard.press("ControlOrMeta+Shift+A");
	await expect(page.getByTestId("approval-menu")).toHaveCount(0);
	await expect(page.getByTestId("composer")).toBeFocused();
});

test("the shortcut is listed with the others", async ({ page }) => {
	await newChat(page);
	await page.keyboard.press("?");
	const list = page.getByTestId("shortcuts");
	await expect(list).toContainText("Change the permission mode");
	await expect(list).toContainText("Set a goal");
	// It is a page of Settings now, so going back to the conversation is Back, not an Escape.
	await page.goBack();
	await expect(page.getByTestId("composer")).toBeVisible();
});

test("New chat keeps the mode picked here when the folder changes and omp starts again", async ({ page }) => {
	const tap = await newChat(page);
	await choose(page, "always-ask");

	await page.getByTestId("cwd-picker").click();
	await page.getByTestId("dir-up").click();
	await page.getByRole("button", { name: "Use this folder" }).click();
	// A second process for the new folder, started in the picked mode: the switcher shows it, nothing was reset.
	await expect.poll(() => tap.sent.filter((m) => m.t === "open").length).toBe(2);
	const opens = tap.sent.filter((m) => m.t === "open");
	expect(opens[1].target).toMatchObject({ kind: "new", approvalMode: "always-ask" });
	await expect(picker(page)).toHaveAttribute("data-mode", "always-ask");
});

test("a conversation's switcher changes its own mode, and says so when omp is in the middle of a turn", async ({
	page,
}) => {
	ownSession(0xea, "Permission chat probe");
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, "Permission chat probe", "permission-chat-probe");
	await expect(picker(page)).toHaveAttribute("data-mode", "yolo");

	// Idle: nothing to say about when it applies.
	await choose(page, "write");
	expect(modeChanges(tap)[0]).toMatchObject({ liveId, mode: "write" });
	await expect(page.getByTestId("toast")).toHaveCount(0);

	// Mid-turn it applies from omp's next tool call, and the toast says that.
	tap.push({ t: "frame", liveId, frame: { type: "agent_start" } });
	await expect(page.getByTestId("stop")).toBeVisible();
	await choose(page, "always-ask");
	await expect(page.getByTestId("toast").filter({ hasText: "applies from the next tool call" })).toBeVisible();
	expect(modeChanges(tap)).toHaveLength(2);
});

test("a mode the server refuses is reported and the switcher goes back to the mode in force", async ({ page }) => {
	// The server answers the change with an error, as it would for a process that is gone.
	await page.routeWebSocket(/\/ws$/, (ws) => {
		const server = ws.connectToServer();
		ws.onMessage((raw) => {
			const msg = JSON.parse(String(raw));
			if (msg.t === "approval_mode")
				ws.send(JSON.stringify({ t: "reply", req: msg.req, ok: false, error: "forced refusal" }));
			else server.send(raw);
		});
		server.onMessage((raw) => ws.send(raw));
	});
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), WORK());
	await page.goto("/");
	await expect(picker(page)).toBeVisible({ timeout: 60_000 });
	await picker(page).click();
	await page.getByTestId("approval-always-ask").click();
	await expect(page.getByTestId("toast").filter({ hasText: "forced refusal" })).toBeVisible();
	await expect(picker(page)).toHaveAttribute("data-mode", "yolo");
});

test("a conversation whose process ended comes back in the mode that was picked for it", async ({ page }) => {
	const title = "Permission resume probe";
	ownSession(0xeb, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	await startLive(page, tap, title, "permission-resume-probe");
	await choose(page, "always-ask");

	// Close its process from Settings, then open the conversation again.
	await page.getByRole("button", { name: /^Settings/ }).click();
	await page.locator('[data-testid="settings-page-tab"][data-page="app"]').click();
	const running = page.getByTestId("running-session").filter({ hasText: title });
	await expect(running).toHaveCount(1);
	await running.getByRole("button", { name: /^Close/ }).click();
	await expect(running).toHaveCount(0);
	await sessionRow(page, title).click();
	// No omp runs yet, and the switcher already shows the mode that was picked for the conversation.
	await expect(picker(page)).toHaveAttribute("data-mode", "always-ask", { timeout: 15_000 });
	// Choosing another is one click: it starts omp and sets it.
	await picker(page).click();
	await page.getByTestId("approval-write").click();
	await expect(picker(page)).toHaveAttribute("data-mode", "write", { timeout: 60_000 });
});

test("the default mode for new conversations is chosen in Settings and applies to the next new chat", async ({
	page,
}) => {
	await page.goto("/#/settings/safety");
	const section = page.getByTestId("approval-settings");
	await expect(section).toBeVisible();
	// By default it follows omp, and says what that is.
	await expect(page.getByTestId("approval-default-omp")).toBeChecked();
	await expect(section).toContainText("Same as omp's setting (Auto-approve)");
	await expect(section).toContainText("Ask every time");

	await page.getByTestId("approval-default-always-ask").check();
	await expect.poll(async () => (await (await api(page).get("/api/approval")).json()).mode).toBe("always-ask");

	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), WORK());
	await page.goto("/");
	await expect(picker(page)).toHaveAttribute("data-mode", "always-ask", { timeout: 60_000 });

	// Back to following omp.
	await page.goto("/#/settings/safety");
	await expect(page.getByTestId("approval-default-always-ask")).toBeChecked();
	await page.getByTestId("approval-default-omp").check();
	await expect.poll(async () => (await (await api(page).get("/api/approval")).json()).mode).toBeNull();
});

test("omp's approval prompt is laid out for deciding: the tool, what it would run, and a Deny that stands out", async ({
	page,
}) => {
	ownSession(0xec, "Permission prompt probe");
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, "Permission prompt probe", "permission-prompt-probe");
	tap.push({
		t: "frame",
		liveId,
		frame: {
			type: "extension_ui_request",
			id: "ap-1",
			method: "select",
			title: "Allow tool: bash\nCommand: echo hi",
			options: ["Approve", "Approve bash for this session", "Deny"],
		},
	});
	const prompt = page.getByTestId("ui-request");
	await expect(prompt).toHaveAttribute("data-approval", "true");
	await expect(prompt).toContainText("Allow tool: bash");
	await expect(page.getByTestId("approval-details")).toHaveText("Command: echo hi");
	await expect(prompt.getByRole("button", { name: "Deny" })).toHaveClass(/text-danger/);
	await expect(prompt.getByRole("button", { name: "Approve", exact: true })).not.toHaveClass(/text-danger/);

	await prompt.getByRole("button", { name: "Approve", exact: true }).click();
	await expect(prompt).toHaveCount(0);
	const answer = tap.sent.findLast((m) => m.t === "ui_response");
	expect(answer?.response).toEqual({ id: "ap-1", value: "Approve" });
});

test("Ask and remember's prompt offers its grants: a long folder path wraps inside the card on a phone, and Deny still stands out", async ({
	page,
}) => {
	ownSession(0xed, "Permission grant probe");
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, "Permission grant probe", "permission-grant-probe");
	// The sidebar is behind a button on a phone: the conversation is opened first, and the drawer the resize opens closed.
	await page.setViewportSize({ width: 390, height: 800 });
	await page.getByRole("button", { name: "Hide sidebar" }).click();
	const folder = `/Users/someone/projects/${"deeply-nested-folder-name/".repeat(4)}src`;
	tap.push({
		t: "frame",
		liveId,
		frame: {
			type: "extension_ui_request",
			id: "ap-cached",
			method: "select",
			// What omp 18.12.3 sends a host without its dialog in Ask and remember (tests/contract/approval-cached.test.ts).
			title: `Allow tool: read\nReason: target not yet approved\nFolder: ${folder} — 1 entry (0 folders, 1 file)\n  - hello.txt`,
			options: [
				`Approve Directory: ${folder}`,
				"Approve File",
				`Always Approve Directory: ${folder}`,
				"Always Approve File",
				"Approve Once",
				"Deny",
			],
		},
	});
	const prompt = page.getByTestId("ui-request");
	await expect(prompt).toHaveAttribute("data-approval", "true");
	await expect(prompt.getByRole("button")).toHaveCount(7); // six choices and Cancel
	await expect(prompt.getByRole("button", { name: "Deny" })).toHaveClass(/text-danger/);
	await expect(prompt.getByRole("button", { name: "Always Approve File" })).not.toHaveClass(/text-danger/);
	const box = await prompt.boundingBox();
	expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	// Nothing sticks out of a choice: the long path wraps inside its button.
	const wide = await prompt
		.getByRole("button", { name: /^Always Approve Directory/ })
		.evaluate((el) => el.scrollWidth > el.clientWidth);
	expect(wide).toBe(false);

	await prompt.getByRole("button", { name: "Approve Once" }).click();
	expect(tap.sent.findLast((m) => m.t === "ui_response")?.response).toEqual({ id: "ap-cached", value: "Approve Once" });
});

test("Settings names omp's own mode when it is one a newer omp added", async ({ page }) => {
	await page.route("**/api/approval", async (route) => {
		if (route.request().method() !== "GET") return route.continue();
		const real = await (await route.fetch()).json();
		return route.fulfill({ json: { ...real, omp: "paranoid" } });
	});
	await page.goto("/#/settings/safety");
	const section = page.getByTestId("approval-settings");
	await expect(section).toContainText("Same as omp's setting (paranoid)");
	await expect(page.getByTestId("approval-default-omp")).toBeChecked();
});

test("on a phone the switcher stays on the screen and keeps its name for assistive tools", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 800 });
	await newChat(page);
	const box = await picker(page).boundingBox();
	expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
	await expect(picker(page)).toHaveAccessibleName(/Permission mode: Auto-approve/);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await choose(page, "write");
	await expect(picker(page)).toHaveAccessibleName(/Permission mode: Ask for commands/);
});

// ------------------------------------------------------------------ with a model (Claude Haiku 5.5)

test.describe("with a model", () => {
	test.skip(!process.env.OMPW_E2E_HAS_TOKEN, "needs an Anthropic token (omp token anthropic)");

	test("Ask every time asks before a command, and Auto-approve switched on mid-conversation stops the asking", async ({
		page,
	}) => {
		await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), WORK());
		await page.goto("/");
		await expect(page.getByTestId("model-picker")).toContainText(/haiku/i, { timeout: 60_000 });
		await choose(page, "always-ask");

		await page.getByTestId("composer").fill("Run `echo first-run` with bash, then reply with the single word DONE.");
		await page.getByTestId("send").click();
		const prompt = page.getByTestId("ui-request");
		await expect(prompt).toHaveAttribute("data-approval", "true", { timeout: 90_000 });
		await expect(prompt).toContainText("bash");
		await expect(page.getByTestId("approval-details")).toContainText("echo first-run");
		await prompt.getByRole("button", { name: "Approve", exact: true }).click();
		await expect(page.locator('[data-testid="tool-card"][data-tool="bash"]')).toHaveCount(1, { timeout: 60_000 });
		await expect(page.getByTestId("stop")).toHaveCount(0, { timeout: 90_000 });

		// The conversation goes on in Auto-approve: the next command runs without a question.
		await choose(page, "yolo");
		await page.getByTestId("composer").fill("Run `echo second-run` with bash, then reply with the single word DONE.");
		await page.getByTestId("send").click();
		await expect(page.locator('[data-testid="tool-card"][data-tool="bash"]')).toHaveCount(2, { timeout: 90_000 });
		await expect(page.getByTestId("stop")).toHaveCount(0, { timeout: 90_000 });
		await expect(prompt).toHaveCount(0);

		// And back: asked again.
		await choose(page, "always-ask");
		await page.getByTestId("composer").fill("Run `echo third-run` with bash, then reply with the single word DONE.");
		await page.getByTestId("send").click();
		await expect(prompt).toHaveAttribute("data-approval", "true", { timeout: 90_000 });
		await expect(page.getByTestId("approval-details")).toContainText("echo third-run");
		await prompt.getByRole("button", { name: "Deny" }).click();
		await expect(page.getByTestId("stop")).toHaveCount(0, { timeout: 90_000 });
	});
});
