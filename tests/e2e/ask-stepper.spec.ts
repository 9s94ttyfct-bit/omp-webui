import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { openSidebar, ownSession, startLive } from "../support/live.ts";
import { type SocketTap, tapSocket } from "../support/socket-tap.ts";
import {
	type Browser,
	type BrowserContext,
	devices,
	expect,
	type Locator,
	type Page,
	test,
	webkit,
} from "./fixtures.ts";

/**
 * A request with several questions is asked one at a time (#588): a step counter, the question with its choices, Back and
 * Next, and on the last step Submit over a short review. Nothing in the chat scrolls the page: the window holds the app,
 * a tall request scrolls inside its card or the bottom block, and a page that was scrolled anyway comes back when the
 * request ends. The requests arrive as pushed frames, so no model is called.
 */

interface Win {
	name: string;
	/** WebKit is the engine of the macOS app and of every iPhone and iPad. */
	engine: "chromium" | "webkit";
	viewport?: { width: number; height: number };
	device?: string;
}

/** The four sizes of the issue. */
const SIZES: Win[] = [
	{ name: "desktop 1400×900", engine: "chromium", viewport: { width: 1400, height: 900 } },
	{ name: "window 1024×640", engine: "chromium", viewport: { width: 1024, height: 640 } },
	{ name: "iPad", engine: "webkit", device: "iPad (gen 11)" },
	{ name: "iPhone", engine: "webkit", device: "iPhone 15" },
];
/** The macOS app is WebKit; zoomed in (⌘+), its window is this many CSS pixels high. */
const ZOOMED_APP: Win = { name: "macOS app zoomed", engine: "webkit", viewport: { width: 1024, height: 400 } };

let sessions = 0;

interface Chat {
	page: Page;
	tap: SocketTap;
	liveId: string;
	frame: (f: Record<string, unknown>) => void;
	close: () => Promise<void>;
}

interface Use {
	browser: Browser;
	e2eServer: { url: string };
	workerStorageState: string;
}

interface Look {
	lang?: "en" | "zh-CN";
	theme?: "light" | "dark";
}

/** A conversation open in `win`, its omp running, with a transcript long enough to scroll (and scrolled to its end). */
async function open(use: Use, win: Win, look: Look = {}): Promise<Chat> {
	const own = win.engine === "webkit" ? await webkit.launch({ channel: undefined }) : null;
	const options = {
		baseURL: use.e2eServer.url,
		storageState: use.workerStorageState,
		locale: look.lang === "zh-CN" ? "zh-CN" : "en-US",
	};
	let context: BrowserContext;
	if (win.device) {
		const { defaultBrowserType: _browser, ...device } = devices[win.device];
		context = await (own ?? use.browser).newContext({ ...device, ...options });
	} else {
		context = await (own ?? use.browser).newContext({ ...options, viewport: win.viewport });
	}
	const page = await context.newPage();
	const n = ++sessions;
	const title = `Ask stepper ${n}`;
	ownSession(0x5a00 + n, title);
	await page.addInitScript(
		([lang, theme]) => {
			localStorage.setItem("ompw.autoTitle", "off");
			if (lang) localStorage.setItem("ompw.lang", lang);
			if (theme) localStorage.setItem("ompw.theme", theme);
		},
		[look.lang ?? "", look.theme ?? ""],
	);
	const tap = await tapSocket(page);
	await page.goto("/");
	await openSidebar(page);
	const liveId = await startLive(page, tap, title, `ask-stepper-${n}`);
	const composer = page.getByTestId("composer");
	for (const i of [1, 2]) {
		await composer.fill(`!seq 1 100; echo long-${i}`);
		await composer.press("Enter");
		await expect(page.getByTestId("transcript")).toContainText(`long-${i}`);
	}
	return {
		page,
		tap,
		liveId,
		frame: (frame) => tap.push({ t: "frame", liveId, frame }),
		close: async () => {
			await context.close();
			await own?.close();
		},
	};
}

/** What omp's `ask` sends for three questions: a single choice with a recommendation, a multiple choice, and one to answer in words. */
const QUESTIONS = [
	{
		id: "layout",
		header: "Layout",
		question: "How should the sidebar behave on a narrow window?",
		recommended: 0,
		options: [
			{ label: "Collapse to a rail", description: "Icons only, the page keeps its whole width." },
			{
				label: "Slide over the page",
				description: "A drawer that covers the page while it is open and closes when a chat is chosen.",
			},
			{ label: "Stay open", description: "The page gets what is left, which may be very little on a phone." },
			{ label: "Hide completely", description: "Only a button brings it back." },
		],
	},
	{
		id: "checks",
		header: "Checks",
		question: "Which checks should run before the release?",
		multi: true,
		options: [
			{ label: "Unit tests", description: "The whole suite, about a minute." },
			{ label: "Lint", description: "Formatting, the type scale, personal data." },
			{ label: "Browser tests", description: "Playwright, desktop and phone, about ten minutes." },
		],
	},
	{
		id: "name",
		header: "Name",
		question: "What should the release be called?",
		options: [
			{ label: "Aurora", description: "After the light, for a release that fixes what was dark." },
			{ label: "Basalt", description: "Plain and heavy, for a release that changes little." },
			{ label: "Cirrus", description: "Light and high, for a release that removes more than it adds." },
			{ label: "Dune", description: "Shifting, for a release that moves a lot of code." },
		],
	},
];

const ask = (id: string, questions: unknown[] = QUESTIONS) => ({
	type: "extension_ui_request",
	method: "ask",
	id,
	questions,
});

const card = (page: Page) => page.getByTestId("ui-request");
const step = (page: Page) => page.getByTestId("ask-step");
const responses = (tap: SocketTap) => tap.sent.filter((m) => m.t === "ui_response").map((m) => m.response);

/** What a person sees of the page's frame, and how far the transcript is from its end. */
interface Frame {
	documentTop: number;
	bodyTop: number;
	rootTop: number;
	shellTop: number;
	documentOverflow: number;
	titleTop: number;
	titleBottom: number;
	height: number;
	fromEnd: number;
}

async function frameOf(page: Page): Promise<Frame> {
	return page.evaluate(() => {
		const root = document.scrollingElement as HTMLElement;
		const shell = document.querySelector(".app-shell") as HTMLElement;
		const title = (document.querySelector("[data-testid=chat-title]") as HTMLElement).getBoundingClientRect();
		const transcript = document.querySelector("[data-testid=transcript]") as HTMLElement;
		return {
			documentTop: root.scrollTop,
			bodyTop: document.body.scrollTop,
			rootTop: document.getElementById("root")?.scrollTop ?? 0,
			shellTop: shell.scrollTop,
			documentOverflow: root.scrollHeight - innerHeight,
			titleTop: title.top,
			titleBottom: title.bottom,
			height: innerHeight,
			fromEnd: transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight,
		};
	});
}

/** The page is where the window put it: nothing scrolled, the chat's header on the screen. */
async function expectStill(page: Page, what: string): Promise<Frame> {
	const f = await frameOf(page);
	const scrolled = { documentTop: f.documentTop, bodyTop: f.bodyTop, rootTop: f.rootTop, shellTop: f.shellTop };
	expect(scrolled, `${what}: nothing of the app's frame is scrolled`).toEqual({
		documentTop: 0,
		bodyTop: 0,
		rootTop: 0,
		shellTop: 0,
	});
	expect(f.documentOverflow, `${what}: the page is no taller than the window`).toBeLessThanOrEqual(0);
	expect(f.titleTop, `${what}: the chat's header is on the screen`).toBeGreaterThanOrEqual(0);
	expect(f.titleBottom, `${what}: the chat's header is on the screen`).toBeLessThanOrEqual(f.height);
	return f;
}

/** The answers of the three questions, as omp is told. */
const ANSWERS = [
	{ id: "layout", selectedOptions: ["Slide over the page"] },
	{ id: "checks", selectedOptions: ["Unit tests", "Lint"] },
	{ id: "name", selectedOptions: [], customInput: "Northern Lights" },
];

const radio = (page: Page, label: string) => card(page).getByRole("radio", { name: new RegExp(`^${label}`) });
const checkbox = (page: Page, label: string) => card(page).getByRole("checkbox", { name: new RegExp(`^${label}`) });
const button = (page: Page, name: string | RegExp) =>
	card(page).getByRole("button", { name, exact: typeof name === "string" });

/**
 * Tab until the focus is not on a radio. The next stop out of a group of radios with none chosen is the browser's own:
 * the field after the group, and now and then (Chromium on a loaded machine, with the first radio focused and the page
 * in the state the test had already checked) the group's next radio, where a second Tab leaves it. A person presses Tab
 * again; the test asks where the focus is, not how many presses it took.
 */
async function tabOutOfRadios(page: Page): Promise<void> {
	for (let presses = 0; presses < 5; presses++) {
		await page.keyboard.press("Tab");
		const onRadio = await page.evaluate(() => {
			const at = document.activeElement;
			return at instanceof HTMLInputElement && at.type === "radio";
		});
		if (!onRadio) return;
	}
}

/** The centre of the control is on the screen and is what a pointer or a finger there hits: nothing scrolled, nothing over it. */
async function expectHittable(control: Locator, what: string): Promise<void> {
	const seen = await control.evaluate((el) => {
		const r = el.getBoundingClientRect();
		const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
		return { onScreen: r.top >= 0 && r.bottom <= innerHeight, hit: at === el || el.contains(at) };
	});
	expect(seen, what).toEqual({ onScreen: true, hit: true });
}

for (const win of SIZES) {
	test.describe(win.name, () => {
		test("three questions are asked one at a time, the page stays where it is, and the answers go in order", async ({
			browser,
			e2eServer,
			workerStorageState,
		}) => {
			const chat = await open({ browser, e2eServer, workerStorageState }, win);
			const { page } = chat;
			try {
				const before = await expectStill(page, "before the request");
				expect(before.fromEnd, "the transcript is at its end").toBeLessThanOrEqual(1);

				chat.frame(ask("ask-3"));
				await expect(card(page)).toBeVisible();
				// The first of three, with its choices; nothing of the others.
				await expect(step(page)).toHaveText("1 / 3");
				await expect(card(page).getByRole("group", { name: /How should the sidebar behave/ })).toBeVisible();
				await expect(card(page).getByRole("radio")).toHaveCount(4);
				await expect(card(page).getByText("Which checks should run")).toHaveCount(0);
				await expect(card(page).getByText("What should the release be called")).toHaveCount(0);
				await expect(radio(page, "Collapse to a rail")).toBeChecked();
				await expect(card(page).getByText("Icons only, the page keeps its whole width.")).toBeVisible();
				await expect(button(page, "Next")).toBeVisible();
				await expect(button(page, "Back")).toHaveCount(0);
				await expect(button(page, /^Submit/)).toHaveCount(0);
				await expectStill(page, "asking, step 1");
				// The buttons are in reach whatever the question's height: no scrolling in the card to find them.
				await expectHittable(button(page, "Next"), "Next, on the first step");
				// Skip all is the whole request's: what Skip would mean on a step of three is this question's.
				await expectHittable(button(page, "Skip all"), "Skip all, on the first step");
				await expect(button(page, "Skip")).toHaveCount(0);

				await radio(page, "Slide over the page").check();
				await button(page, "Next").click();
				await expect(step(page)).toHaveText("2 / 3");
				await expect(card(page).getByRole("group", { name: /Which checks should run/ })).toBeVisible();
				await expect(card(page).getByRole("checkbox")).toHaveCount(3);
				await expect(card(page).getByText("How should the sidebar behave")).toHaveCount(0);
				await checkbox(page, "Unit tests").check();
				await checkbox(page, "Lint").check();
				await expectStill(page, "asking, step 2");

				// Back keeps what was chosen.
				await button(page, "Back").click();
				await expect(step(page)).toHaveText("1 / 3");
				await expect(radio(page, "Slide over the page")).toBeChecked();
				await button(page, "Next").click();
				await expect(checkbox(page, "Unit tests")).toBeChecked();
				await expect(checkbox(page, "Lint")).toBeChecked();
				await button(page, "Next").click();

				// The last step: Submit over a short review of all three, the third still unanswered.
				await expect(step(page)).toHaveText("3 / 3");
				await expect(button(page, "Next")).toHaveCount(0);
				await expect(button(page, "Submit answers")).toBeVisible();
				const review = page.getByTestId("ask-review");
				await expect(review.getByRole("listitem")).toHaveCount(3);
				await expect(review.getByRole("listitem").nth(0)).toContainText("Slide over the page");
				await expect(review.getByRole("listitem").nth(1)).toContainText("Unit tests, Lint");
				await expect(review.getByRole("listitem").nth(2)).toContainText("No answer");
				await card(page)
					.getByRole("textbox", { name: /Other answer for: What should the release be called/ })
					.fill("Northern Lights");
				await expect(review.getByRole("listitem").nth(2)).toContainText("Northern Lights");
				await expectStill(page, "asking, step 3");
				// A screen reader hears the review with Submit.
				await expect(button(page, "Submit answers")).toHaveAccessibleDescription(
					/Slide over the page.*Unit tests, Lint.*Northern Lights/,
				);
				await expectHittable(button(page, "Submit answers"), "Submit answers, on the last step");
				await expectHittable(button(page, "Back"), "Back, on the last step");

				expect(responses(chat.tap), "nothing is sent before Submit").toHaveLength(0);
				await button(page, "Submit answers").click();
				await expect(card(page)).toHaveCount(0);
				expect(responses(chat.tap)).toEqual([{ id: "ask-3", answers: ANSWERS }]);

				// The header and the transcript are where they were.
				const after = await expectStill(page, "after the answer");
				expect(after.fromEnd, "the transcript is at its end again").toBeLessThanOrEqual(1);
				await expect(page.getByTestId("composer")).toBeFocused();
			} finally {
				await chat.close();
			}
		});
	});
}

test.describe("desktop 1400×900", () => {
	const win = SIZES[0];

	test("the keyboard walks the steps: Enter on a choice moves on, and the last Enter only reaches Submit", async ({
		browser,
		e2eServer,
		workerStorageState,
	}) => {
		const chat = await open({ browser, e2eServer, workerStorageState }, win);
		const { page } = chat;
		try {
			chat.frame(ask("ask-keys"));
			await expect(card(page)).toBeFocused();
			// The first Tab reaches the chosen radio of the first question (the recommended one).
			await page.keyboard.press("Tab");
			await expect(radio(page, "Collapse to a rail")).toBeFocused();
			await page.keyboard.press("ArrowDown");
			await expect(radio(page, "Slide over the page")).toBeChecked();
			await page.keyboard.press("Enter");
			await expect(step(page)).toHaveText("2 / 3");
			// The new question has the keyboard: its first choice, ready for Space and Enter.
			await expect(checkbox(page, "Unit tests")).toBeFocused();
			await page.keyboard.press("Space");
			await page.keyboard.press("Tab");
			await page.keyboard.press("Space");
			await expect(checkbox(page, "Unit tests")).toBeChecked();
			await expect(checkbox(page, "Lint")).toBeChecked();
			await page.keyboard.press("Enter");
			await expect(step(page)).toHaveText("3 / 3");
			await expect(radio(page, "Aurora")).toBeFocused();
			// Leave the four radios (none chosen) for Other. Words there, then Enter: on the last step it reaches Submit, it
			// does not send.
			await tabOutOfRadios(page);
			await expect(card(page).getByRole("textbox", { name: /Other answer for/ })).toBeFocused();
			await page.keyboard.type("Northern Lights");
			await page.keyboard.press("Enter");
			await expect(button(page, "Submit answers")).toBeFocused();
			expect(responses(chat.tap)).toHaveLength(0);
			await page.keyboard.press("Enter");
			await expect(card(page)).toHaveCount(0);
			expect(responses(chat.tap)).toEqual([{ id: "ask-keys", answers: ANSWERS }]);
			await expect(page.getByTestId("composer")).toBeFocused();
			await expectStill(page, "after the keyboard");
		} finally {
			await chat.close();
		}
	});

	test("the steps, the review and the buttons are in Chinese, light and dark", async ({
		browser,
		e2eServer,
		workerStorageState,
	}) => {
		const chat = await open({ browser, e2eServer, workerStorageState }, win, { lang: "zh-CN", theme: "dark" });
		const { page } = chat;
		try {
			chat.frame(ask("ask-zh"));
			await expect(step(page)).toHaveText("1 / 3");
			await expect(button(page, "下一步")).toBeVisible();
			await expect(button(page, "全部跳过")).toBeVisible();
			await button(page, "下一步").click();
			await expect(button(page, "上一步")).toBeVisible();
			await button(page, "下一步").click();
			await expect(button(page, "提交回答")).toBeVisible();
			await expect(page.getByTestId("ask-review")).toContainText("未回答");
			await expect(page.getByTestId("ask-review")).toContainText("你的回答");
			await button(page, "提交回答").click();
			await expect(card(page)).toHaveCount(0);
		} finally {
			await chat.close();
		}
	});

	test("a request with one question looks as it did: every choice at once, no steps", async ({
		browser,
		e2eServer,
		workerStorageState,
	}) => {
		const chat = await open({ browser, e2eServer, workerStorageState }, win);
		const { page } = chat;
		try {
			chat.frame(ask("ask-1", [QUESTIONS[0]]));
			await expect(card(page)).toBeVisible();
			await expect(card(page).getByRole("radio")).toHaveCount(4);
			await expect(step(page)).toHaveCount(0);
			await expect(button(page, "Next")).toHaveCount(0);
			await expect(button(page, "Back")).toHaveCount(0);
			await expect(page.getByTestId("ask-review")).toHaveCount(0);
			await expect(button(page, "Skip")).toBeVisible();
			// With one question there is nothing to be mistaken for: it is Skip, as it always was.
			await expect(button(page, "Skip all")).toHaveCount(0);
			await radio(page, "Stay open").check();
			await button(page, "Submit answers").click();
			await expect(card(page)).toHaveCount(0);
			expect(responses(chat.tap)).toEqual([
				{ id: "ask-1", answers: [{ id: "layout", selectedOptions: ["Stay open"] }] },
			]);
			await expectStill(page, "after one question");
		} finally {
			await chat.close();
		}
	});

	test("the option the agent recommends says so, and only that one (#735)", async ({
		browser,
		e2eServer,
		workerStorageState,
	}) => {
		const chat = await open({ browser, e2eServer, workerStorageState }, win);
		const { page } = chat;
		try {
			// Not the first option: the mark follows `recommended`, not the order.
			chat.frame(ask("ask-rec", [{ ...QUESTIONS[0], recommended: 1 }]));
			await expect(card(page)).toBeVisible();
			await expect(radio(page, "Slide over the page")).toBeChecked();
			const marks = card(page)
				.locator("label")
				.filter({ hasText: /recommended/ });
			await expect(marks).toHaveCount(1);
			await expect(marks).toContainText("Slide over the page");
		} finally {
			await chat.close();
		}
	});

	test("a tall question scrolls inside its card: the page does not move and the last choice can be picked", async ({
		browser,
		e2eServer,
		workerStorageState,
	}) => {
		const chat = await open({ browser, e2eServer, workerStorageState }, win);
		const { page } = chat;
		try {
			const tall = {
				id: "tall",
				question: "Which of these twenty?",
				options: Array.from({ length: 20 }, (_, i) => ({
					label: `Choice ${i + 1}`,
					description: `A description of choice ${i + 1}, long enough to take two lines on a narrow card, and then some more words after it.`,
				})),
			};
			chat.frame(ask("ask-tall", [tall, QUESTIONS[1]]));
			await expect(card(page)).toBeVisible();
			const inside = await card(page).evaluate((el) => ({
				scrolls: el.scrollHeight > el.clientHeight,
				top: el.scrollTop,
			}));
			expect(inside.scrolls, "the card has more than it shows").toBe(true);
			await radio(page, "Choice 20").check();
			await expectStill(page, "the last choice picked");
			await button(page, "Next").click();
			await expect(step(page)).toHaveText("2 / 2");
			await expectStill(page, "the second question");
			// The next question is read from its top, not from where the first was scrolled to.
			expect(await card(page).evaluate((el) => el.scrollTop)).toBe(0);
		} finally {
			await chat.close();
		}
	});

	test("a page that was scrolled anyway is back at the top when the request ends", async ({
		browser,
		e2eServer,
		workerStorageState,
	}) => {
		const chat = await open({ browser, e2eServer, workerStorageState }, win);
		const { page } = chat;
		try {
			chat.frame(ask("ask-back", [QUESTIONS[0]]));
			await expect(card(page)).toBeVisible();
			// Whatever made it: the page is given room to scroll, and is scrolled.
			await page.evaluate(() => {
				document.body.style.minHeight = "3000px";
				document.documentElement.scrollTo(0, 240);
			});
			expect(await page.evaluate(() => document.scrollingElement?.scrollTop)).toBeGreaterThan(0);
			await button(page, "Submit answers").click();
			await expect(card(page)).toHaveCount(0);
			await page.evaluate(() => {
				document.body.style.minHeight = "";
			});
			expect(await page.evaluate(() => document.scrollingElement?.scrollTop)).toBe(0);
		} finally {
			await chat.close();
		}
	});
});

test.describe(ZOOMED_APP.name, () => {
	test("in a window this short (the macOS app zoomed in) the app's frame never scrolls, asking or answered", async ({
		browser,
		e2eServer,
		workerStorageState,
	}) => {
		const chat = await open({ browser, e2eServer, workerStorageState }, ZOOMED_APP);
		const { page } = chat;
		try {
			await expectStill(page, "before the request");
			chat.frame(ask("ask-zoom"));
			await expect(card(page)).toBeVisible();
			await expectStill(page, "asking");
			// Each choice a keyboard or a finger reaches is brought into view by the browser: it must not move the app.
			const next = button(page, /^(Next|Submit)/);
			for (let i = 0; i < 3; i++) {
				await page.keyboard.press("Tab");
				await expectStill(page, `tab ${i + 1}`);
			}
			await radio(page, "Collapse to a rail").focus();
			await expectStill(page, "a choice focused");
			await next.click();
			await expectStill(page, "step 2");
			await next.click();
			await expectStill(page, "step 3");
			await button(page, "Submit answers").click();
			await expect(card(page)).toHaveCount(0);
			await expectStill(page, "answered");
			expect(responses(chat.tap)).toHaveLength(1);
		} finally {
			await chat.close();
		}
	});
});

/**
 * The app's frame does not scroll (#588), so a window too short for the whole sidebar (the macOS app zoomed in, a laptop
 * with the dock open) gets a sidebar that scrolls inside itself: every item is reached by Tab, which brings it on to the
 * screen, and by the wheel, down to the foot.
 */
const SHORT_SIDEBAR: Win[] = [400, 320].flatMap((height) =>
	(["chromium", "webkit"] as const).map((engine) => ({
		name: `${engine} 1100×${height}`,
		engine,
		viewport: { width: 1100, height },
	})),
);

for (const win of SHORT_SIDEBAR) {
	test.describe(`sidebar, ${win.name}`, () => {
		test("scrolls inside itself: Tab brings each item on to the screen and the wheel reaches the foot", async ({
			browser,
			e2eServer,
			workerStorageState,
		}) => {
			const chat = await open({ browser, e2eServer, workerStorageState }, win);
			const { page } = chat;
			try {
				const sidebar = page.locator("aside", { has: page.getByTestId("session-list") });
				await expectStill(page, "before");
				// What is focused in the sidebar, and whether a person can see it: on the window and in the sidebar's own box.
				const focused = () =>
					sidebar.evaluate((el) => {
						const at = document.activeElement as HTMLElement | null;
						if (!at || !el.contains(at)) return null;
						const r = at.getBoundingClientRect();
						const box = el.getBoundingClientRect();
						return {
							name: at.dataset.testid || at.getAttribute("aria-label") || (at.textContent ?? "").trim().slice(0, 40),
							shown:
								r.height > 0 &&
								r.top >= 0 &&
								r.bottom <= innerHeight &&
								r.top >= box.top - 1 &&
								r.bottom <= box.bottom + 1,
						};
					});
				// Tab reaches buttons in Chromium; WebKit's own default leaves them out (only fields and selects), so there the
				// wheel below is the way, as it is for a finger.
				if (win.engine === "chromium") {
					await sidebar.getByTestId("new-chat").focus();
					const walked: string[] = [];
					const hidden: string[] = [];
					// Tab stops on each conversation of the list twice (its row, then its menu), and the list holds whatever the
					// specs before this one left on the worker's server: the walk is bounded by that, with room for the rest.
					const listed: unknown[] = await (await page.request.get("/api/sessions")).json();
					for (let i = 0; i < 2 * listed.length + 100; i++) {
						const now = await focused();
						if (!now) break;
						walked.push(now.name);
						if (!now.shown) hidden.push(now.name);
						await page.keyboard.press("Tab");
					}
					expect(hidden, "every item Tab reaches is on the screen").toEqual([]);
					// The last page of the sidebar's foot (Send feedback is in Settings since #660) and the line under it.
					for (const wanted of ["nav-guard", "remote-indicator"])
						expect(walked.includes(wanted), `Tab reaches ${wanted}`).toBe(true);
					await expectStill(page, "after the Tab walk");
				}

				// The wheel, over the sidebar's own controls (over the session list it scrolls the list first): from the top to the
				// foot (the versions line, under the last control) and back.
				await sidebar.getByTestId("new-chat").hover();
				await page.mouse.wheel(0, 4000);
				await expect(sidebar.getByTestId("remote-indicator")).toBeInViewport({ ratio: 1 });
				await expect(sidebar.getByTestId("app-versions")).toBeInViewport({ ratio: 1 });
				await expect(sidebar.getByTestId("nav-guard")).toBeInViewport({ ratio: 1 });
				await sidebar.getByTestId("nav-guard").hover();
				await page.mouse.wheel(0, -4000);
				await expect(sidebar.getByTestId("new-chat")).toBeInViewport({ ratio: 1 });
				await expectStill(page, "after the wheel");
			} finally {
				await chat.close();
			}
		});
	});
}

/**
 * Pictures for the feature's notes (`OMPW_SHOTS=<dir>`): the request open, its last step, and the page after the answer,
 * in the sizes that matter, light and dark, English and Chinese. Not an assertion: nothing runs without the variable.
 */
const shots = process.env.OMPW_SHOTS;
const SHOT_SIZES: Win[] = [SIZES[0], SIZES[3], ZOOMED_APP];
test.describe("pictures", () => {
	test.skip(!shots, "OMPW_SHOTS is not set");
	for (const win of SHOT_SIZES) {
		for (const theme of ["light", "dark"] as const) {
			for (const lang of ["en", "zh-CN"] as const) {
				if (win === ZOOMED_APP && (lang === "zh-CN" || theme === "dark")) continue;
				test(`${win.name} ${theme} ${lang}`, async ({ browser, e2eServer, workerStorageState }) => {
					const chat = await open({ browser, e2eServer, workerStorageState }, win, { lang, theme });
					const { page } = chat;
					const name = `${win.name.replace(/[^a-z0-9]+/gi, "-")}-${theme}-${lang}`;
					const shoot = async (what: string) => {
						const path = join(shots as string, `${what}-${name}.png`);
						mkdirSync(dirname(path), { recursive: true });
						await page.screenshot({ path });
					};
					try {
						chat.frame(ask("ask-shot"));
						await expect(card(page)).toBeVisible();
						await page.waitForTimeout(400);
						await shoot("asking");
						// Before: one card with every question. After: the steps, up to the review.
						const next = card(page).getByRole("button", { name: /^(Next|下一步)$/ });
						while ((await next.count()) > 0) {
							await next.click();
							await page.waitForTimeout(200);
						}
						await shoot("last");
						await card(page)
							.getByRole("button", { name: /^(Submit answers|提交回答)$/ })
							.click();
						await expect(card(page)).toHaveCount(0);
						await page.waitForTimeout(300);
						await shoot("answered");
					} finally {
						await chat.close();
					}
				});
			}
		}
	}
	for (const win of SHORT_SIDEBAR.filter((w) => w.engine === "webkit")) {
		test(`sidebar ${win.name}`, async ({ browser, e2eServer, workerStorageState }) => {
			const chat = await open({ browser, e2eServer, workerStorageState }, win);
			const { page } = chat;
			const sidebar = page.locator("aside", { has: page.getByTestId("session-list") });
			const name = win.name.replace(/[^a-z0-9]+/gi, "-");
			try {
				mkdirSync(shots as string, { recursive: true });
				await page.screenshot({ path: join(shots as string, `sidebar-top-${name}.png`) });
				await sidebar.getByTestId("new-chat").hover();
				await page.mouse.wheel(0, 4000);
				await expect(sidebar.getByTestId("app-versions")).toBeInViewport({ ratio: 1 });
				await page.screenshot({ path: join(shots as string, `sidebar-foot-${name}.png`) });
			} finally {
				await chat.close();
			}
		});
	}
});
