import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { patchReplies } from "../support/state-patch.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The usage meter beside New chat's folder is a chunk of its own: the first page load, which has no model yet, has no
 * use for it, and the three files that load fetches stay under their budget (`scripts/check-entry-size.ts`). It is
 * fetched once the warm-up process exists, and a chunk that is gone is a toast, not the Reload screen. No model call;
 * usage data is stubbed.
 */

const gone = { status: 404, contentType: "text/plain", body: "Not found" };
const QUOTA_CHUNK = /\/assets\/Quota-[^/]+\.js$/;

/** One provider with half of its 5-hour window left. */
const REPORT = [
	{
		provider: "anthropic",
		limits: [
			{
				id: "anthropic:5h",
				label: "Claude 5 Hour",
				window: { resetsAt: Date.now() + 2 * 3_600_000 },
				amount: { remainingFraction: 0.5, unit: "percent" },
				status: "ok",
			},
		],
	},
];

/** omp only reports its provider after a model call: say it, so the meter has one before any. */
async function newChatWithProvider(page: Page, cwd = process.env.OMPW_E2E_WORK as string) {
	await page.route("**/api/usage**", (route) => route.fulfill({ json: REPORT }));
	await patchReplies(page, {
		get_state: (data) => {
			const state = typeof data === "object" && data !== null ? data : {};
			const model = "model" in state && typeof state.model === "object" ? state.model : {};
			return { ...state, model: { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", ...model, provider: "anthropic" } };
		},
	});
	await page.addInitScript((folder) => localStorage.setItem("ompw.cwd", folder), cwd);
}

test("the page is served without the usage meter's chunk; it is fetched once the warm process exists, and the meter shows", async ({
	page,
	request,
}) => {
	// What the page names for the browser to fetch before it runs (its script and preloads) has no meter in it.
	const html = await (await request.get("/")).text();
	expect(html).toContain('type="module"');
	expect(html).not.toContain("/assets/Quota-");

	const fetched: string[] = [];
	page.on("request", (r) => {
		if (r.resourceType() === "script" && QUOTA_CHUNK.test(r.url())) fetched.push(r.url());
	});
	await newChatWithProvider(page);
	await page.goto("/");
	await expect(page.getByTestId("quota").getByTestId("quota-figure")).toHaveText("50% left", { timeout: 60_000 });
	expect(fetched).toHaveLength(1);
});

test("a long folder path leaves the meter on the folder's row, at desktop and phone widths", async ({ page }) => {
	const deep = join(
		process.env.OMPW_E2E_WORK as string,
		"a-folder-whose-name-goes-on-and-on-for-a-good-while",
		"and-a-subfolder-below-it-that-keeps-going-as-well",
		"project",
	);
	mkdirSync(deep, { recursive: true });
	await newChatWithProvider(page, deep);
	await page.goto("/");
	const meter = page.getByTestId("quota");
	await expect(meter).toBeVisible({ timeout: 60_000 });
	for (const size of [
		{ width: 1280, height: 800 },
		{ width: 390, height: 844 },
	]) {
		await page.setViewportSize(size);
		// The page lays out for the new width in the browser's next rendering step (the sidebar becomes a drawer below 900px,
		// on a media query's change event): the folder and the meter are measured together, after a frame, until they have.
		await expect
			.poll(
				() =>
					page.evaluate(async (width) => {
						await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
						const folder = document.querySelector('[data-testid="cwd-picker"]')?.getBoundingClientRect();
						const pill = document.querySelector('[data-testid="quota"]')?.getBoundingClientRect();
						if (!folder || !pill) return "the folder or the meter is not on the screen";
						// Beside the folder, not wrapped under it, and on the screen.
						if (pill.y >= folder.bottom) return `under the folder: ${pill.y} ≥ ${folder.bottom}`;
						if (pill.right > width) return `off the screen: ${pill.right} > ${width}`;
						return "beside";
					}, size.width),
				{ message: `${size.width}px` },
			)
			.toBe("beside");
	}
});

test("a missing usage meter is contained: a toast, the new chat page stays, without the meter", async ({ page }) => {
	// A reload for a missing chunk was just made (see `reloadOnce`): this failure is the one that is shown.
	await page.addInitScript(() => sessionStorage.setItem("ompw.chunkReloadAt", String(Date.now())));
	await page.route(QUOTA_CHUNK, (route) => route.fulfill(gone));
	await newChatWithProvider(page);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
	await expect(page.getByTestId("toast").filter({ hasText: /usage meter couldn't load/ })).toBeVisible({
		timeout: 30_000,
	});
	await expect(page.getByTestId("error-screen")).toHaveCount(0);
	await expect(page.getByTestId("quota")).toHaveCount(0);
	await expect(page.getByTestId("composer")).toBeVisible();
});
