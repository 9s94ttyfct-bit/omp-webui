import { viewportOf } from "../support/geometry.ts";
import { openSidebar, ownSession, startLive } from "../support/live.ts";
import { rpcState } from "../support/rpc-state.ts";
import { type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { devices, expect, type Page, test, webkit } from "./fixtures.ts";

/**
 * A tool approval on an iPhone: every choice is on the screen, nothing stands over it, a finger can hit it and the tap
 * answers. Measured in WebKit with Playwright's device descriptors (touch, the phone's screen and pixel ratio), with the
 * todo strip above the composer and a stack of toasts up, and with the keyboard up. Taps are real touches at the centre
 * of a control, with no retry and no check of what is under the finger, so a toast or the composer in the way is a
 * failed tap, as it is for a person. The prompts arrive as pushed frames: no model is called.
 *
 * Playwright's WebKit has no on-screen keyboard, so it is modelled the two ways browsers have it: the window shrinks to
 * what the keyboard leaves (Chrome on Android, the layout viewport), and the way iOS Safari does it: the page keeps its
 * size and only the visual viewport shrinks and pans (`visualViewport`, replaced by a stand-in that does that).
 */

const PHONES = ["iPhone SE", "iPhone SE (3rd gen)", "iPhone 15", "iPhone 15 Pro Max"] as const;
/** On their side: the window is about 340 to 380 px high, with nothing else on it than the header, the request and the message box. */
const LANDSCAPE = ["iPhone 15 landscape", "iPhone SE (3rd gen) landscape", "iPhone 15 Pro Max landscape"] as const;
/** iOS's portrait keyboard with its suggestion bar. */
const KEYBOARD = 291;
/** iOS's keyboard on a phone held on its side: about 60% of its window. */
const LANDSCAPE_KEYBOARD = 200;
/** The same on an iPad held on its side: the window is what is above it. */
const IPAD_KEYBOARD = 350;
/** What a finger needs to hit a control (Apple's guideline). */
const FINGER = 44;
/** WebKit lays out in device pixels: 44px comes back as 43.99998. */
const PIXEL = 0.01;

let sessions = 0;

interface Phone {
	page: Page;
	tap: SocketTap;
	liveId: string;
	/** Push a frame to the page as omp's own. */
	frame: (f: Record<string, unknown>) => void;
}

/** A conversation open in WebKit on `name`, its omp running. `stand-in`: iOS's visual viewport, set to a keyboard by `keyboard`. */
async function openPhone(
	use: { e2eServer: { url: string }; workerStorageState: string },
	name: (typeof PHONES)[number] | (typeof LANDSCAPE)[number] | "iPad (gen 11) landscape",
	options: { iosKeyboard?: boolean } = {},
): Promise<{ phone: Phone; close: () => Promise<void> }> {
	const { defaultBrowserType: _browser, ...device } = devices[name];
	// The config's `channel: "chrome"` belongs to Chromium; WebKit launches without one.
	const browser = await webkit.launch({ channel: undefined });
	const context = await browser.newContext({
		...device,
		baseURL: use.e2eServer.url,
		storageState: use.workerStorageState,
		locale: "en-US",
	});
	const page = await context.newPage();
	const title = `Approval on ${name} ${++sessions}`;
	ownSession(0x5810 + sessions, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	if (options.iosKeyboard) {
		// iOS Safari keeps `innerHeight` and shrinks (and pans) only the visual viewport while the keyboard is up.
		await page.addInitScript(() => {
			const vv = Object.assign(new EventTarget(), {
				width: innerWidth,
				height: innerHeight,
				offsetTop: 0,
				offsetLeft: 0,
				pageTop: 0,
				pageLeft: 0,
				scale: 1,
			});
			Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
			Object.defineProperty(window, "__keyboard", {
				value: (px: number) => {
					vv.height = innerHeight - px;
					vv.offsetTop = px;
					vv.dispatchEvent(new Event("resize"));
				},
			});
		});
	}
	const tap = await tapSocket(page);
	await page.goto("/");
	await openSidebar(page);
	const liveId = await startLive(page, tap, title, `approval-phone-${sessions}`);
	expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "a touch screen").toBe(true);
	return {
		phone: { page, tap, liveId, frame: (frame) => tap.push({ t: "frame", liveId, frame }) },
		close: () => browser.close(),
	};
}

/** The todo list with a task in progress, so that its strip stands above the composer. */
async function withTodoStrip({ page, tap, frame }: Phone) {
	tap.answer("get_state", () => ({
		ok: true,
		data: rpcState({
			todoPhases: [
				{
					name: "Build",
					tasks: [
						{ content: "Write the parser", status: "in_progress" },
						{ content: "Deploy", status: "pending" },
					],
				},
			],
		}),
	}));
	frame({ type: "tool_execution_end", toolCallId: "todo-1", toolName: "todo", result: {} });
	await expect(page.getByTestId("todo-strip")).toBeVisible();
}

/** Five toasts, each of three lines: the most the stack holds. Two are on the screen, the other three wait. */
async function withToasts({ page, frame }: Phone) {
	for (let i = 0; i < 5; i++)
		frame({
			type: "extension_ui_request",
			id: `toast-${i}`,
			method: "notify",
			message: `Command ${i} failed: exit code 1\nstderr: something broke while running the build step number ${i}`,
			notifyType: i % 2 ? "warning" : "error",
		});
	await expect(page.getByTestId("toast")).toHaveCount(2);
	await expect(page.getByTestId("toasts-queued")).toHaveText("3 more waiting");
}

/** What omp sends for a tool it would run. */
function bashApproval({ frame }: Phone) {
	frame({
		type: "extension_ui_request",
		id: "ap-bash",
		method: "select",
		title: "Allow tool: bash\nCommand: echo hi",
		options: ["Approve", "Approve bash for this session", "Deny"],
	});
}

/** What omp 18.12.3 sends in Ask and remember (see approval.spec.ts): six choices, three of them with a long folder. */
function readApproval({ frame }: Phone) {
	const folder = `/Users/someone/projects/${"deeply-nested-folder-name/".repeat(4)}src`;
	frame({
		type: "extension_ui_request",
		id: "ap-read",
		method: "select",
		title: `Allow tool: read\nReason: target not yet approved\nFolder: ${folder} — 1 entry (0 folders, 1 file)\n  - hello.txt`,
		options: [
			`Approve Directory: ${folder}`,
			"Approve File",
			`Always Approve Directory: ${folder}`,
			"Always Approve File",
			"Approve Once",
			"Deny",
		],
	});
}

/** Where on the screen a person can see: the visual viewport (what the keyboard leaves of the page). */
const visible = (page: Page) =>
	page.evaluate(() => {
		const vv = window.visualViewport;
		return { top: vv?.offsetTop ?? 0, bottom: (vv?.offsetTop ?? 0) + (vv?.height ?? innerHeight) };
	});

/**
 * The controls of the open request, in order, each as a person would find it: the first `unscrolled` of them must be
 * under a finger as the request opens, the rest are scrolled to in the card (a card taller than the room it has carries
 * a scroll of its own). A control is fine when what is at the centre of its box is the control itself, the whole box is
 * on the visible screen, and the box is a finger's.
 */
async function expectTappable(page: Page, names: (string | RegExp)[], unscrolled: number, finger = FINGER) {
	const card = page.getByTestId("ui-request");
	const buttons = card.getByRole("button");
	await expect(buttons).toHaveCount(names.length);
	for (const [i, name] of names.entries()) {
		const button = buttons.nth(i);
		await expect(button).toContainText(name);
		if (i >= unscrolled) await button.scrollIntoViewIfNeeded();
		const seen = await visible(page);
		const found = await button.evaluate((el) => {
			const r = el.getBoundingClientRect();
			const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
			return {
				y: r.y,
				bottom: r.bottom,
				width: r.width,
				height: r.height,
				hit: hit === el || el.contains(hit) ? "itself" : `${hit?.tagName ?? "nothing"} ${hit?.className ?? ""}`,
			};
		});
		expect(found.hit, `what is at the centre of "${name}"`).toBe("itself");
		expect(found.y, `"${name}" starts on the screen`).toBeGreaterThanOrEqual(seen.top);
		expect(found.bottom, `"${name}" ends on the screen`).toBeLessThanOrEqual(seen.bottom);
		expect(found.height, `"${name}" height`).toBeGreaterThanOrEqual(finger - PIXEL);
		expect(found.width, `"${name}" width`).toBeGreaterThanOrEqual(finger - PIXEL);
	}
}

/** A finger on the centre of the control called `name`, nothing else: what omp is told is what was tapped. */
async function tapChoice({ page, tap }: Phone, name: string | RegExp, value: string, id: string) {
	const button = page.getByTestId("ui-request").getByRole("button", { name, exact: true });
	await button.scrollIntoViewIfNeeded();
	const box = await button.boundingBox();
	if (!box) throw new Error(`${name} is not on the screen`);
	await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
	await expect(page.getByTestId("ui-request")).toHaveCount(0);
	expect(tap.sent.findLast((m) => m.t === "ui_response")?.response).toEqual({ id, value });
}

/**
 * The toast stack ends above the card, which the toasts would otherwise cover. The stack follows the card's top through a
 * ResizeObserver, in the browser's next rendering step after the card appears: both are measured at once, until it has.
 */
async function expectToastsAboveCard(page: Page) {
	await expect
		.poll(
			() =>
				page.evaluate(() => {
					const region = document.querySelector<HTMLElement>("[data-toast-region]");
					const card = document.querySelector('[data-testid="ui-request"]');
					if (!region || !card) return "the stack or the card is not on the screen";
					// A stack put away (no toast fits above the card) is over nothing.
					if (region.dataset.crowded === "true") return "above";
					const below = region.getBoundingClientRect().bottom - card.getBoundingClientRect().top;
					return below <= 1 ? "above" : `the toasts' bottom ${below}px under the card's top`;
				}),
			{ message: "the toasts' bottom" },
		)
		.toBe("above");
}

const CHOICES = ["Approve", "Approve bash for this session", "Deny", "Cancel"];
const READ_CHOICES = [
	/^Approve Directory/,
	"Approve File",
	/^Always Approve Directory/,
	"Always Approve File",
	"Approve Once",
	"Deny",
	"Cancel",
];

for (const name of PHONES) {
	test.describe(name, () => {
		test("with the todo strip and a stack of toasts, every choice is under a finger and approving answers omp", async ({
			e2eServer,
			workerStorageState,
		}) => {
			const { phone, close } = await openPhone({ e2eServer, workerStorageState }, name);
			try {
				await withTodoStrip(phone);
				await withToasts(phone);
				bashApproval(phone);
				await expect(phone.page.getByTestId("ui-request")).toBeVisible();
				await expectToastsAboveCard(phone.page);
				await expectTappable(phone.page, CHOICES, 3);
				await tapChoice(phone, "Approve", "Approve", "ap-bash");
			} finally {
				await close();
			}
		});

		test("a prompt taller than the screen keeps the composer on it and scrolls inside itself to every choice", async ({
			e2eServer,
			workerStorageState,
		}) => {
			const { phone, close } = await openPhone({ e2eServer, workerStorageState }, name);
			try {
				await withTodoStrip(phone);
				await withToasts(phone);
				readApproval(phone);
				await expect(phone.page.getByTestId("ui-request")).toBeVisible();
				await expectToastsAboveCard(phone.page);
				const composer = await phone.page.getByTestId("composer").boundingBox();
				expect(composer && composer.y + composer.height <= viewportOf(phone.page).height).toBe(true);
				await expectTappable(phone.page, READ_CHOICES, 0);
				await tapChoice(phone, "Deny", "Deny", "ap-read");
			} finally {
				await close();
			}
		});

		test("with the keyboard up (the window shrinks to what it leaves), the choices are still on the screen", async ({
			e2eServer,
			workerStorageState,
		}) => {
			const { phone, close } = await openPhone({ e2eServer, workerStorageState }, name);
			try {
				await withTodoStrip(phone);
				bashApproval(phone);
				await expect(phone.page.getByTestId("ui-request")).toBeVisible();
				// Text in the composer: the request does not take the keyboard from it.
				await phone.page.getByTestId("composer").fill("a message in the making");
				const size = viewportOf(phone.page);
				await phone.page.setViewportSize({ width: size.width, height: size.height - KEYBOARD });
				await expectTappable(phone.page, CHOICES, 0);
				await tapChoice(phone, "Approve bash for this session", "Approve bash for this session", "ap-bash");
			} finally {
				await close();
			}
		});

		test("with the keyboard up the way iOS has it (the page keeps its size, the visual viewport shrinks), the choices are on what shows", async ({
			e2eServer,
			workerStorageState,
		}) => {
			const { phone, close } = await openPhone({ e2eServer, workerStorageState }, name, { iosKeyboard: true });
			try {
				await withTodoStrip(phone);
				bashApproval(phone);
				await expect(phone.page.getByTestId("ui-request")).toBeVisible();
				await phone.page.getByTestId("composer").fill("a message in the making");
				await phone.page.evaluate(
					(px) => (window as unknown as { __keyboard: (n: number) => void }).__keyboard(px),
					KEYBOARD,
				);
				// The block above the keyboard takes no more than the keyboard leaves: composer and card both on what shows.
				const seen = await visible(phone.page);
				const composer = await phone.page.getByTestId("composer").boundingBox();
				expect(
					composer && composer.y >= seen.top && composer.y + composer.height <= seen.bottom,
					"composer on what shows",
				).toBe(true);
				await expectTappable(phone.page, CHOICES, 0);
				await tapChoice(phone, "Deny", "Deny", "ap-bash");
			} finally {
				await close();
			}
		});

		test("the buttons of a confirmation are a finger's size too", async ({ e2eServer, workerStorageState }) => {
			const { phone, close } = await openPhone({ e2eServer, workerStorageState }, name);
			try {
				await withTodoStrip(phone);
				phone.frame({ type: "extension_ui_request", id: "confirm-1", method: "confirm", title: "Run the migration?" });
				await expect(phone.page.getByTestId("ui-request")).toBeVisible();
				await expectTappable(phone.page, ["Deny", "Allow"], 2);
			} finally {
				await close();
			}
		});
	});
}

/** The request is on the screen whole: nothing of it is behind a scroll of its own. */
const whole = (page: Page) => page.getByTestId("ui-request").evaluate((el) => el.scrollHeight <= el.clientHeight + 1);

/** The block under the transcript has not been scrolled: what is on the screen is what the request opened with. */
const unscrolled = (page: Page) =>
	page.evaluate(() =>
		[...document.querySelectorAll("[data-chat-bottom], [data-testid=ui-request]")].every((el) => el.scrollTop === 0),
	);

for (const name of LANDSCAPE) {
	test.describe(name, () => {
		test("a phone on its side: the choices are under a finger at once, with the todo strip and the toasts up", async ({
			e2eServer,
			workerStorageState,
		}) => {
			const { phone, close } = await openPhone({ e2eServer, workerStorageState }, name);
			try {
				await withTodoStrip(phone);
				await withToasts(phone);
				bashApproval(phone);
				await expect(phone.page.getByTestId("ui-request")).toBeVisible();
				await expectToastsAboveCard(phone.page);
				// The strip gives way to the request while it waits, and is back once it is answered.
				await expect(phone.page.getByTestId("todo-strip")).toBeHidden();
				// All four, none of them scrolled to: Approve, Approve for the session, Deny and Cancel.
				await expectTappable(phone.page, CHOICES, CHOICES.length);
				expect(await unscrolled(phone.page), "nothing was scrolled").toBe(true);
				expect(await whole(phone.page), "the request is whole").toBe(true);
				await tapChoice(phone, "Deny", "Deny", "ap-bash");
				await expect(phone.page.getByTestId("todo-strip")).toBeVisible();
			} finally {
				await close();
			}
		});

		test("a long command is read in a box of its own and does not push the choices off the screen", async ({
			e2eServer,
			workerStorageState,
		}) => {
			const { phone, close } = await openPhone({ e2eServer, workerStorageState }, name);
			try {
				phone.frame({
					type: "extension_ui_request",
					id: "ap-long",
					method: "select",
					title: `Allow tool: bash\nCommand: ${Array.from({ length: 30 }, (_, i) => `echo step ${i}`).join("\n")}`,
					options: ["Approve", "Approve bash for this session", "Deny"],
				});
				await expect(phone.page.getByTestId("ui-request")).toBeVisible();
				await expectTappable(phone.page, CHOICES, CHOICES.length);
				// The command itself is still there to read, and says there is more of it.
				await expect(phone.page.getByTestId("approval-more")).toBeVisible();
				await tapChoice(phone, "Approve", "Approve", "ap-long");
			} finally {
				await close();
			}
		});

		test("side by side, a long folder wraps inside its choice and does not run into the next", async ({
			e2eServer,
			workerStorageState,
		}) => {
			const { phone, close } = await openPhone({ e2eServer, workerStorageState }, name);
			try {
				readApproval(phone);
				await expect(phone.page.getByTestId("ui-request")).toBeVisible();
				const spilled = await phone.page
					.getByTestId("ui-request")
					.getByRole("button")
					.evaluateAll((all) =>
						all.filter((el) => el.scrollWidth > el.clientWidth).map((el) => el.textContent?.slice(0, 30)),
					);
				expect(spilled).toEqual([]);
			} finally {
				await close();
			}
		});
	});
}

test.describe("iPad (gen 11) on its side with the keyboard up", () => {
	test("the choices are on what shows at once, next to the message being typed", async ({
		e2eServer,
		workerStorageState,
	}) => {
		const { phone, close } = await openPhone({ e2eServer, workerStorageState }, "iPad (gen 11) landscape", {
			iosKeyboard: true,
		});
		try {
			await withTodoStrip(phone);
			bashApproval(phone);
			await expect(phone.page.getByTestId("ui-request")).toBeVisible();
			await phone.page.getByTestId("composer").fill("a message in the making");
			await phone.page.evaluate(
				(px) => (window as unknown as { __keyboard: (n: number) => void }).__keyboard(px),
				IPAD_KEYBOARD,
			);
			const seen = await visible(phone.page);
			const composer = await phone.page.getByTestId("composer").boundingBox();
			expect(
				composer && composer.y >= seen.top && composer.y + composer.height <= seen.bottom,
				"composer on what shows",
			).toBe(true);
			await expectTappable(phone.page, CHOICES, CHOICES.length);
			expect(await unscrolled(phone.page), "nothing was scrolled").toBe(true);
			expect(await whole(phone.page), "the request is whole").toBe(true);
			await tapChoice(phone, "Approve", "Approve", "ap-bash");
		} finally {
			await close();
		}
	});
});

test.describe("iPhone 15 on its side with the keyboard up, a request that asks for text", () => {
	test("the field and its buttons are on what shows, and the message box waits until the field is left", async ({
		e2eServer,
		workerStorageState,
	}) => {
		const { phone, close } = await openPhone({ e2eServer, workerStorageState }, "iPhone 15 landscape", {
			iosKeyboard: true,
		});
		try {
			const { page } = phone;
			await withTodoStrip(phone);
			phone.frame({ type: "extension_ui_request", id: "in-1", method: "input", title: "Branch name?" });
			const card = page.getByTestId("ui-request");
			await expect(card).toBeVisible();
			const field = card.getByRole("textbox");
			const box = await field.boundingBox();
			if (!box) throw new Error("the field is not on the screen");
			await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
			await expect(field).toBeFocused();
			await page.evaluate(
				(px) => (window as unknown as { __keyboard: (n: number) => void }).__keyboard(px),
				LANDSCAPE_KEYBOARD,
			);
			// The message box gives its room to the field the keyboard is on.
			await expect(page.getByTestId("composer")).toBeHidden();
			await expectTappable(page, ["Cancel", "Submit"], 2);
			expect(await whole(page), "the request is whole").toBe(true);
			const seen = await visible(page);
			const now = await field.boundingBox();
			expect(now && now.y >= seen.top && now.y + now.height <= seen.bottom, "the field is on what shows").toBe(true);
			const hit = await field.evaluate((el) => {
				const r = el.getBoundingClientRect();
				return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el;
			});
			expect(hit, "what is at the centre of the field").toBe(true);
			// Typing goes where the finger put it, and Submit answers.
			await page.keyboard.type("feature/x");
			await tapChoice(phone, "Submit", "feature/x", "in-1");
			// The request is answered: the message box is back.
			await expect(page.getByTestId("composer")).toBeVisible();
		} finally {
			await close();
		}
	});
});

test.describe("iPhone 15 on its side, a command running", () => {
	test("its Stop stays on the screen next to the request, which keeps its choices", async ({
		e2eServer,
		workerStorageState,
	}) => {
		const { phone, close } = await openPhone({ e2eServer, workerStorageState }, "iPhone 15 landscape");
		try {
			const { page } = phone;
			const composer = page.getByTestId("composer");
			await composer.fill("!sleep 25");
			await composer.press("Enter");
			const stop = page.getByTestId("pending-stop");
			await expect(stop).toBeVisible();
			bashApproval(phone);
			await expect(page.getByTestId("ui-request")).toBeVisible();
			// What the short window puts away is not what stops a command: Stop is still under a finger.
			await expect(stop).toBeVisible();
			const at = await stop.boundingBox();
			if (!at) throw new Error("Stop is not on the screen");
			const hit = await stop.evaluate((el) => {
				const r = el.getBoundingClientRect();
				const found = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
				return found === el || el.contains(found);
			});
			expect(hit, "what is at the centre of Stop").toBe(true);
			await expectTappable(page, CHOICES, CHOICES.length);
			await page.touchscreen.tap(at.x + at.width / 2, at.y + at.height / 2);
			await expect(page.getByTestId("pending-command")).toHaveCount(0);
		} finally {
			await close();
		}
	});
});

test.describe("iPhone SE, with a request too tall for the toasts to share the screen with", () => {
	test("the toast stack is put away (and its clocks stopped), and takes no taps meant for the strip below it", async ({
		e2eServer,
		workerStorageState,
	}) => {
		const { phone, close } = await openPhone({ e2eServer, workerStorageState }, "iPhone SE");
		try {
			const { page } = phone;
			await withTodoStrip(phone);
			await withToasts(phone);
			readApproval(phone);
			await expect(page.getByTestId("ui-request")).toBeVisible();
			const stack = page.locator("[data-toast-region]");
			await expect(stack).toHaveAttribute("data-crowded", "true");
			// The toasts are put away, not gone: unseen, taking no taps, and said to be waiting to those who hear the page.
			await expect(page.getByTestId("toast").first()).toHaveCSS("visibility", "hidden");
			await expect(page.getByTestId("toasts-waiting")).toHaveText(/waiting behind the request: 5/);
			// Across the strip's toggle and its panel button, what is under a finger is the strip.
			for (const id of ["todo-toggle", "todo-open-panel"]) {
				const target = page.getByTestId(id);
				if (!(await target.count())) continue;
				const box = await target.boundingBox();
				if (!box) continue;
				for (const fx of [0.2, 0.5, 0.8]) {
					const hit = await page.evaluate(
						([x, y]) => Boolean(document.elementFromPoint(x, y)?.closest("[data-toast-region]")),
						[box.x + box.width * fx, box.y + box.height / 2],
					);
					expect(hit, `a toast over ${id} at ${fx}`).toBe(false);
				}
			}
			// Nothing was seen, so nothing ran out: 9 s is the longest a toast lives, and all five are there.
			await page.waitForTimeout(9500);
			await expect(page.getByTestId("toast")).toHaveCount(2);
			await expect(page.getByTestId("toasts-waiting")).toHaveText(/waiting behind the request: 5/);
			// The request is answered: the toasts come back, and stay long enough to be read.
			await tapChoice(phone, "Deny", "Deny", "ap-read");
			await expect(stack).not.toHaveAttribute("data-crowded", "true");
			await expect(page.getByTestId("toast").first()).toHaveCSS("visibility", "visible");
			await expect(page.getByTestId("toasts-waiting")).toHaveCount(0);
			await expect(page.getByTestId("toast")).toHaveCount(2);
			await expect(page.getByTestId("toasts-queued")).toHaveText("3 more waiting");
		} finally {
			await close();
		}
	});
});

/** What the toast stack holds in a window a phone on its side leaves it, with nothing waiting on the person. */
for (const name of LANDSCAPE) {
	test.describe(`${name}, no request open`, () => {
		test("toasts of one, two and three lines are shown, and a toast goes by itself in its 9 s", async ({
			e2eServer,
			workerStorageState,
		}) => {
			const { phone, close } = await openPhone({ e2eServer, workerStorageState }, name);
			try {
				const { page } = phone;
				// The strip makes the block as tall as it gets with nothing waiting.
				await withTodoStrip(phone);
				const stack = page.locator("[data-toast-region]");
				for (const lines of [1, 2, 3]) {
					phone.frame({
						type: "extension_ui_request",
						id: `lines-${lines}`,
						method: "notify",
						message: Array.from({ length: lines }, (_, i) => `Send failed, line ${i + 1}`).join("\n"),
						notifyType: "warning",
					});
					const toast = page.getByTestId("toast");
					await expect(toast).toHaveCount(1);
					await expect(toast).toBeVisible();
					await expect(stack).not.toHaveAttribute("data-crowded", "true");
					await expect(page.getByTestId("toasts-waiting")).toHaveCount(0);
					// Its top is in the stack, where it can be read (a third line may scroll, as it does on a desktop).
					const box = await toast.boundingBox();
					const room = await stack.boundingBox();
					expect(
						box && room && box.y >= room.y && box.y < room.y + room.height,
						`a ${lines}-line toast is in the stack`,
					).toBe(true);
					// A finger hits it, and its Dismiss takes it away.
					const dismiss = toast.getByTestId("toast-dismiss");
					const at = await dismiss.boundingBox();
					if (!at) throw new Error("no Dismiss on screen");
					await page.touchscreen.tap(at.x + at.width / 2, at.y + at.height / 2);
					await expect(toast).toHaveCount(0);
				}
				// An error lives 9 s: it is there, and gone by 12.
				phone.frame({
					type: "extension_ui_request",
					id: "goes",
					method: "notify",
					message: "Send failed",
					notifyType: "error",
				});
				await expect(page.getByTestId("toast")).toBeVisible();
				await expect(page.getByTestId("toast")).toHaveCount(0, { timeout: 12_000 });
			} finally {
				await close();
			}
		});
	});
}

/** A desktop window: a mouse, and a stack of toasts that reaches the card only at its right edge. */
async function openDesktop(page: Page, width: number, height: number): Promise<Phone> {
	const title = `Approval on a desktop ${++sessions}`;
	ownSession(0x5810 + sessions, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.setViewportSize({ width, height });
	await page.goto("/");
	// Below 900px the sidebar is a drawer behind a button.
	await openSidebar(page);
	const liveId = await startLive(page, tap, title, `approval-desktop-${sessions}`);
	expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "a mouse").toBe(false);
	return { page, tap, liveId, frame: (frame) => tap.push({ t: "frame", liveId, frame }) };
}

test.describe("a desktop window", () => {
	for (const [width, height] of [
		[1400, 900],
		[1024, 640],
	] as const)
		test(`${width}×${height}: the toasts stand above the approval and the composer, and under the transcript's top`, async ({
			page,
		}) => {
			const phone = await openDesktop(page, width, height);
			await withToasts(phone);
			bashApproval(phone);
			await expect(page.getByTestId("ui-request")).toBeVisible();
			await expectToastsAboveCard(page);
			const stack = await page.locator("[data-toast-region]").boundingBox();
			const composer = await page.getByTestId("composer").boundingBox();
			const transcript = await page.getByTestId("transcript").boundingBox();
			if (!stack || !composer || !transcript) throw new Error("the stack, composer or transcript is not on the screen");
			expect(stack.y + stack.height, "the toasts' bottom").toBeLessThanOrEqual(composer.y + 1);
			// The box reaches 8px over the transcript's top at most: its toasts start under it, clear of the header's buttons.
			expect(stack.y, "the toasts' top").toBeGreaterThanOrEqual(transcript.y - 9);
		});

	test("a narrow window, where the stack does reach the middle of the card, keeps it above the card", async ({
		page,
	}) => {
		const phone = await openDesktop(page, 600, 800);
		await withToasts(phone);
		bashApproval(phone);
		await expect(page.getByTestId("ui-request")).toBeVisible();
		await expectToastsAboveCard(page);
		// A mouse needs no finger: the choices are the size they are on a desktop.
		await expectTappable(page, CHOICES, 3, 0);
	});
});
