import { PREF, type PrefsSnapshot } from "../../shared/prefs.ts";
import { FIXTURE } from "../support/fixtures.ts";
import { sessionRow, startLive } from "../support/live.ts";
import { panelTab } from "../support/panel.ts";
import { type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { type Browser, expect, type Page, test } from "./fixtures.ts";

/**
 * The model for side questions is one choice of the app: made in one page's Ask tab, it is the one every other open page
 * shows, with no reload, and nothing is kept per conversation. The model list is replaced by a known one and the
 * conversation's side questions by records a spec writes (no model call).
 */

const MODELS = Array.from({ length: 4 }, (_, i) => ({ provider: "acme", id: `m-${i}`, name: `Acme model ${i}` }));

const stored = async (): Promise<string | null> => {
	const res = await fetch(`${process.env.OMPW_E2E_URL}/api/prefs`, {
		headers: { "x-omp-webui-token": process.env.OMPW_E2E_ACCESS_TOKEN as string },
	});
	const snapshot: PrefsSnapshot = await res.json();
	return snapshot.values[PREF.btwModel];
};

/**
 * A page on the Ask tab of a conversation. With `tap`, the conversation's own omp is started first (a `!command` makes no
 * model call): its side questions are what the page lists, and a conversation with no omp running lists none.
 */
async function askTab(page: Page, tap?: SocketTap): Promise<void> {
	await page.route("**/api/models*", (route) => route.fulfill({ json: MODELS }));
	if (tap) await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	await page.goto("/");
	if (tap) await startLive(page, tap, FIXTURE.gammaTitle, "btw-model-probe");
	else await sessionRow(page, FIXTURE.gammaTitle).click();
	await expect(page.getByTestId("chat-title")).toHaveText(FIXTURE.gammaTitle);
	await page.getByTestId("toggle-panel").click();
	await panelTab(page, /Ask|提问/).click();
	await expect(page.getByTestId("btw-model")).toBeVisible();
}

async function twoPages(browser: Browser): Promise<[Page, Page, () => Promise<void>]> {
	const a = await browser.newContext();
	const b = await browser.newContext();
	const pa = await a.newPage();
	const pb = await b.newPage();
	await askTab(pa);
	await askTab(pb);
	return [pa, pb, async () => void (await Promise.all([a.close(), b.close()]))];
}

test("the model chosen in one page's Ask tab is the one every other page shows, live, and the default is omp's", async ({
	browser,
}) => {
	const [a, b, close] = await twoPages(browser);
	try {
		for (const page of [a, b]) {
			await expect(page.getByTestId("btw-model")).toContainText("omp default");
			await expect(page.getByTestId("btw-model-note")).toHaveCount(0);
		}

		await a.getByTestId("btw-model").click();
		await a.getByRole("option", { name: /Acme model 2/ }).click();
		await expect(a.getByTestId("btw-model")).toContainText("Acme model 2");
		await expect(a.getByTestId("btw-model-note")).toContainText("separate omp process");
		// The other page, already open, shows it without a reload, and the note that says what that means.
		await expect(b.getByTestId("btw-model")).toContainText("Acme model 2");
		await expect(b.getByTestId("btw-model-note")).toBeVisible();
		await expect.poll(stored).toBe("acme/m-2");

		// And back, from the other side: omp's own choice again.
		await b.getByTestId("btw-model").click();
		await b.getByTestId("btw-model-blank").click();
		await expect(a.getByTestId("btw-model")).toContainText("omp default");
		await expect(a.getByTestId("btw-model-note")).toHaveCount(0);
		await expect.poll(stored).toBeNull();
	} finally {
		await close();
	}
});

test("a conversation opened after the choice shows it too: it is the app's, not the conversation's", async ({
	page,
}) => {
	await askTab(page);
	try {
		await page.getByTestId("btw-model").click();
		await page.getByRole("option", { name: /Acme model 1/ }).click();
		await expect.poll(stored).toBe("acme/m-1");
		// Another conversation, and a reload: the same choice.
		await page.reload();
		await sessionRow(page, FIXTURE.alphaTitle).click();
		await expect(page.getByTestId("chat-title")).toHaveText(FIXTURE.alphaTitle);
		if (!(await page.getByTestId("right-panel").isVisible())) await page.getByTestId("toggle-panel").click();
		await panelTab(page, /Ask/).click();
		await expect(page.getByTestId("btw-model")).toContainText("Acme model 1");
	} finally {
		await fetch(`${process.env.OMPW_E2E_URL}/api/prefs`, {
			method: "POST",
			headers: {
				"x-omp-webui-token": process.env.OMPW_E2E_ACCESS_TOKEN as string,
				"x-omp-webui": "1",
				"content-type": "application/json",
			},
			body: JSON.stringify({ changes: { [PREF.btwModel]: null } }),
		});
	}
});

test("each side question says which model answered, and an error says why", async ({ page }) => {
	const tap = await tapSocket(page);
	tap.answer("get_btw_history", () => ({
		ok: true,
		data: {
			records: [
				{
					id: "side-b",
					question: "Why did it fail?",
					answer: "",
					status: "error",
					error: "Model omlx/none not found",
					model: "omlx/none",
					createdAt: 3,
				},
				{ id: "side-a", question: "Why?", answer: "Because.", status: "complete", model: "acme/m-2", createdAt: 2 },
				{ id: "omp-own", question: "And?", answer: "Nothing.", status: "complete", createdAt: 1 },
			],
		},
	}));
	await askTab(page, tap);
	const records = page.getByTestId("btw-record");
	await expect(records).toHaveCount(3);
	await expect(records.nth(0).getByTestId("btw-turn-status")).toContainText("Model omlx/none not found");
	await expect(records.nth(0).getByTestId("btw-record-model")).toHaveText("Answered by omlx/none");
	await expect(records.nth(1).getByTestId("btw-record-model")).toHaveText("Answered by acme/m-2");
	// omp's own record names no model: nothing is claimed for it.
	await expect(records.nth(2).getByTestId("btw-record-model")).toHaveCount(0);
});

test("the model row and the label of an answer are in Chinese in the Chinese interface", async ({ page }) => {
	const tap = await tapSocket(page);
	tap.answer("get_btw_history", () => ({
		ok: true,
		data: {
			records: [
				{ id: "side-a", question: "Why?", answer: "Because.", status: "complete", model: "acme/m-2", createdAt: 2 },
			],
		},
	}));
	await page.addInitScript(() => localStorage.setItem("ompw.lang", "zh-CN"));
	try {
		await askTab(page, tap);
		await expect(page.getByTestId("btw-model")).toHaveAttribute("aria-label", /旁问使用的模型.*omp 默认/);
		await expect(page.getByTestId("btw-record-model")).toHaveText("回答的模型：acme/m-2");
	} finally {
		// The language was a choice of this page: the server's copy goes back to none, for the specs that follow.
		await fetch(`${process.env.OMPW_E2E_URL}/api/prefs`, {
			method: "POST",
			headers: {
				"x-omp-webui-token": process.env.OMPW_E2E_ACCESS_TOKEN as string,
				"x-omp-webui": "1",
				"content-type": "application/json",
			},
			body: JSON.stringify({ changes: { [PREF.lang]: null } }),
		});
	}
});
