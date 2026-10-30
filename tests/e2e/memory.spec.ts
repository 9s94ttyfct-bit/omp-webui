import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import AxeBuilder from "@axe-core/playwright";
import type { MemoryOverview } from "../../shared/memory.ts";
import { en } from "../../web/src/i18n/memory.ts";
import { en as shell } from "../../web/src/i18n/shell.ts";
import { zh } from "../../web/src/i18n/zh-CN/memory.ts";
import { withYaml } from "../support/config-yml.ts";
import { writeSimpleSession } from "../support/fixtures.ts";
import { boxOf } from "../support/geometry.ts";
import { bankPath, seedBank, storedContent } from "../support/mnemopi-seed-node.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The Memory page (#616): omp's long-term memory, listed, searched, read, rewritten, added to, retired and deleted. The
 * store is a Mnemopi database of the tables omp 18.12.6 makes, in the agent directory of this test's own server (an
 * isolated HOME in the temp folder): nothing here reads or writes a real `~/.omp`. omp is not asked to use it
 * (`memory.backend` is its default, off): the page shows it as it is and says so. No model is called.
 */

const agentDir = () => process.env.OMPW_E2E_AGENT_DIR as string;
const root = () => process.env.OMPW_E2E_ROOT as string;

/** The id of a conversation this spec writes, as the page's list of conversations knows it (`writeSimpleSession`). */
const KNOWN_SESSION = "01a00000-0000-7000-8000-0000000099b7";
const APP = "app-1a2b3c";
const SITE = "site-4d5e6f";
const FILLER = 60;

/** A time `n` days before the seed's newest, so that the order the page lists in is the order of `n`. */
const day = (n: number) => new Date(Date.UTC(2026, 9, 20) - n * 86_400_000).toISOString();

const ZEBRA = "Always run the zebra build with the --strict flag.";
const SECRET = "sk-abcdefghijklmnopqrstuvwxyz0123456789";

/** `{name}` in a string of the app's words, filled in. */
const fill = (text: string, values: Record<string, string | number>): string =>
	text.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ""));

test.beforeAll(async ({ e2eServer: _server }) => {
	writeSimpleSession(agentDir(), 0xb7, "Zebra release prep");
	seedBank(agentDir(), "default", {
		working: [
			{
				id: "g-zebra",
				content: ZEBRA,
				source: "coding-agent-retain",
				timestamp: day(1),
				importance: 0.8,
				metadata: {
					session_id: KNOWN_SESSION,
					cwd: "/work/app",
					context: "Release prep taught us this.",
					tool: "retain",
				},
				embedded: true,
			},
			{
				id: "g-quokka",
				content: "Heron: the quokka cache is keyed by tenant.",
				source: "coding-agent-transcript",
				timestamp: day(2),
				metadata: { session_id: "ghost-session", cwd: "/work/app" },
			},
			{
				id: "g-tabs",
				content: "The person prefers tabs over spaces, in every project.",
				source: "coding-agent-learn",
				timestamp: day(5),
				metadata: { session_id: "ghost-session", cwd: "/work/app", tool: "learn", context: null },
			},
			{ id: "g-edit", content: "The staging url is staging.example.test.", timestamp: day(6) },
			{ id: "g-conflict", content: "Conflict seed text about the walrus.", timestamp: day(7) },
			{ id: "g-draft", content: "Draft seed text about the ibex.", timestamp: day(8) },
		],
		episodic: [
			{ id: "e-tabs", content: "Prefers tabs. (consolidated)", summaryOf: "g-tabs", timestamp: day(3) },
			{ id: "e-solo", content: "Solo consolidated fact about the narwhal.", summaryOf: "long-gone", timestamp: day(4) },
		],
		derivedFor: ["g-tabs"],
	});
	seedBank(agentDir(), APP, {
		working: [
			{ id: "p-pnpm", content: "The app uses pnpm, never npm.", timestamp: day(9), metadata: { cwd: "/work/app" } },
			{
				id: "p-old",
				content: "Old: deploy with capistrano.",
				timestamp: day(30),
				metadata: { cwd: "/work/app" },
				validUntil: "2026-01-01T00:00:00.000Z",
			},
		],
	});
	seedBank(agentDir(), SITE, {
		working: Array.from({ length: FILLER }, (_, i) => ({
			id: `f${String(i).padStart(2, "0")}`,
			content: `Filler note ${String(i).padStart(2, "0")} of the site.`,
			timestamp: day(40 + i),
			metadata: { cwd: "/work/site" },
		})),
	});
});

async function open(page: Page, lang = "en", theme?: "light" | "dark"): Promise<void> {
	await page.addInitScript(
		([l, t]) => {
			localStorage.setItem("ompw.lang", l as string);
			if (t) localStorage.setItem("ompw.theme", t);
		},
		[lang, theme],
	);
	await page.goto("/#/memory");
	await expect(page.getByTestId("memory-page")).toBeVisible();
	await expect(page.getByTestId("memory-list")).toBeVisible();
}

const rows = (page: Page) => page.getByTestId("memory-row");
const row = (page: Page, text: string) => rows(page).filter({ hasText: text });
const toast = (page: Page, text: string) => page.getByTestId("toast").filter({ hasText: text });
const detail = (page: Page) => page.getByTestId("memory-detail");

async function search(page: Page, text: string): Promise<void> {
	await page.getByTestId("memory-search").fill(text);
}

/** Open a memory by a word of its text, and wait for it to be in full. */
async function openMemory(page: Page, word: string, id: string): Promise<void> {
	await search(page, word);
	// The list is the answer to this search, not the one before it.
	await expect(row(page, word)).toHaveCount(1);
	await expect(rows(page)).toHaveCount(1);
	await row(page, word).click();
	await expect(detail(page)).toHaveAttribute("data-id", id);
}

const backups = (bank: string): string[] => {
	const dir = join(root(), "data", "memory-backups", bank);
	return existsSync(dir) ? readdirSync(dir) : [];
};

const sql = (bank: string): DatabaseSync => new DatabaseSync(bankPath(agentDir(), bank));

test.describe
	.serial("the Memory page", () => {
		test("lists what omp remembers, says that omp is not using it, and loads more on request", async ({ page }) => {
			await open(page);
			await expect(page.getByRole("heading", { level: 1 })).toHaveText(en.title);
			// omp's backend is off: the store is shown as it is, and the page says omp is not using it.
			await expect(page.getByTestId("memory-not-used")).toContainText("off");
			// Notes and consolidated ones: five notes and two consolidated in the shared bank, one in the app's, and the site's filler.
			// The conversation excerpt is not among them until its kind is asked for.
			const total = 5 + 2 + 1 + FILLER;
			await expect(page.getByTestId("memory-count-shown")).toHaveText(fill(en.countOf, { shown: 50, total }));
			await expect(rows(page)).toHaveCount(50);
			await expect(row(page, "quokka")).toHaveCount(0);
			await expect(page.getByTestId("memory-kind-conversation")).toContainText("1");
			await expect(page.getByTestId("memory-kind-note")).toHaveAttribute("aria-pressed", "true");
			await expect(page.getByTestId("memory-kind-conversation")).toHaveAttribute("aria-pressed", "false");
			// The retired one (valid_until in the past) is not listed either.
			await expect(row(page, "capistrano")).toHaveCount(0);
			await page.getByTestId("memory-more").click();
			await expect(page.getByTestId("memory-count-shown")).toHaveText(fill(en.countOf, { shown: total, total }));
			await expect(rows(page)).toHaveCount(total);
			await expect(page.getByTestId("memory-more")).toHaveCount(0);
		});

		test("the sidebar's Memory opens the page, and its address is #/memory", async ({ page }) => {
			await page.goto("/");
			await page.getByRole("button", { name: shell.sidebarNavMemory, exact: true }).click();
			await expect(page.getByTestId("memory-page")).toBeVisible();
			expect(new URL(page.url()).hash).toBe("#/memory");
		});

		test("kinds, scope and project narrow the list, the last kind stays on, retired ones come with their switch", async ({
			page,
		}) => {
			await open(page);
			// Conversations: asked for, and marked as such.
			await page.getByTestId("memory-kind-conversation").click();
			await expect(row(page, "quokka")).toHaveAttribute("data-kind", "conversation");
			// Only that kind: the other two off, and the last one cannot be turned off.
			await page.getByTestId("memory-kind-note").click();
			await page.getByTestId("memory-kind-consolidated").click();
			await expect(rows(page)).toHaveCount(1);
			await page.getByTestId("memory-kind-conversation").click();
			await expect(page.getByTestId("memory-kind-conversation")).toHaveAttribute("aria-pressed", "true");
			await expect(rows(page)).toHaveCount(1);
			await page.getByTestId("memory-kind-note").click();
			await page.getByTestId("memory-kind-consolidated").click();

			// One project: its notes only, with the retired one only when asked for.
			await page.getByTestId("memory-scope-project").click();
			await page.getByTestId("memory-project").selectOption({ label: "app" });
			await expect(row(page, "pnpm")).toHaveCount(1);
			await expect(row(page, "capistrano")).toHaveCount(0);
			await page.getByTestId("memory-show-retired").click();
			await expect(row(page, "capistrano")).toHaveCount(1);
			await expect(row(page, "capistrano")).toContainText(en.retiredBadge);

			// The global ones.
			await page.getByTestId("memory-scope-global").click();
			await expect(row(page, "zebra")).toContainText(en.globalBadge);
			await expect(row(page, "pnpm")).toHaveCount(0);
		});

		test("search finds a memory by its text, its reason and its id, and an empty answer says so", async ({ page }) => {
			await open(page);
			await search(page, "zebra");
			await expect(rows(page)).toHaveCount(1);
			await expect(rows(page).first()).toContainText(ZEBRA);
			// Its reason (said by the agent that saved it), not in its text.
			await search(page, "Release prep taught");
			await expect(row(page, "zebra")).toHaveCount(1);
			// A conversation excerpt, by its id: hidden by the kinds until they include it.
			await search(page, "g-quokka");
			await expect(page.getByTestId("memory-empty")).toBeVisible();
			await page.getByTestId("memory-kind-conversation").click();
			await expect(rows(page)).toHaveCount(1);
			await search(page, "");
			await expect(rows(page).first()).toBeVisible();
		});

		test("a memory opens in full with where it came from, and links to its conversation when that is one of yours", async ({
			page,
		}) => {
			await open(page);
			await openMemory(page, "zebra", "g-zebra");
			await expect(page.getByTestId("memory-text")).toHaveText(ZEBRA);
			await expect(page.locator('[data-field="where"]')).toHaveText(en.fieldWhereGlobal);
			await expect(page.locator('[data-field="origin"]')).toHaveText(en.originRetain);
			await expect(page.locator('[data-field="reason"]')).toHaveText("Release prep taught us this.");
			await expect(page.locator('[data-field="folder"]')).toContainText("/work/app");
			await expect(page.locator('[data-field="importance"]')).toHaveText("0.8");
			const link = page.getByTestId("memory-open-conversation");
			await expect(link).toContainText("Zebra release prep");
			await link.click();
			await expect(page.getByTestId("memory-page")).toHaveCount(0);
			expect(new URL(page.url()).hash).toMatch(/^#\/s\//);

			// Back on the page it is as it was left: the search, the memory that was open, and a place to go on from.
			await open(page);
			await expect(page.getByTestId("memory-search")).toHaveValue("zebra");
			await expect(detail(page)).toHaveAttribute("data-id", "g-zebra");

			// One of a conversation this list does not hold: the id, and no link.
			await openMemory(page, "tabs over spaces", "g-tabs");
			await expect(page.locator('[data-field="conversation"]')).toHaveText(
				fill(en.conversationGone, { id: "ghost-session" }),
			);
			await expect(page.getByTestId("memory-open-conversation")).toHaveCount(0);
			await expect(page.locator('[data-field="origin"]')).toHaveText(en.originLearn);
			// Its consolidated copy is one click away.
			await expect(page.locator('[data-field="consolidated-into"]')).toContainText("e-tabs");
			await page.getByTestId("memory-open-related").click();
			await expect(detail(page)).toHaveAttribute("data-id", "e-tabs");
			await expect(page.locator('[data-field="made-from"]')).toContainText("g-tabs");
		});

		test("editing saves what was typed after a copy of the store, warns about a secret, and keeps an unsaved edit", async ({
			page,
		}) => {
			await open(page);
			await openMemory(page, "staging url", "g-edit");
			await page.getByTestId("memory-edit").click();
			const text = page.getByTestId("memory-text-input");
			await expect(text).toHaveValue("The staging url is staging.example.test.");

			// A secret is warned of, and saving it is a choice: Save waits for the person to say it is meant.
			await text.fill(`token ${SECRET}`);
			await expect(page.getByTestId("memory-secret-warning")).toBeVisible();
			await expect(page.getByTestId("memory-save")).toBeDisabled();
			await page.getByTestId("memory-secret-ack").check();
			await expect(page.getByTestId("memory-save")).toBeEnabled();
			// Over the limit: the count turns, and saving is off.
			await text.fill("x".repeat(64_001));
			await expect(page.getByTestId("memory-save")).toBeDisabled();
			await text.fill("The staging url is staging.example.test (changed).");
			await expect(page.getByTestId("memory-secret-warning")).toHaveCount(0);
			await expect(page.getByTestId("memory-count")).toContainText("50");

			// What was typed stays with the memory when another one is looked at.
			await page.getByTestId("memory-search").fill("");
			await row(page, "zebra").click();
			await expect(detail(page)).toHaveAttribute("data-id", "g-zebra");
			await expect(row(page, "staging url")).toContainText(en.unsaved);
			await row(page, "staging url").click();
			await expect(page.getByTestId("memory-text-input")).toHaveValue(
				"The staging url is staging.example.test (changed).",
			);

			await page.getByTestId("memory-save").click();
			await expect(toast(page, en.saved)).toBeVisible();
			await expect(page.getByTestId("memory-text")).toHaveText("The staging url is staging.example.test (changed).");
			expect(storedContent(agentDir(), "default", "g-edit")).toBe("The staging url is staging.example.test (changed).");
			// The copy of the store that was made before the change.
			expect(backups("default").length).toBeGreaterThan(0);
		});

		test("an edit over a memory that changed meanwhile is kept, shown beside what is stored now, and saves on the second try", async ({
			page,
		}) => {
			await open(page);
			await openMemory(page, "walrus", "g-conflict");
			await page.getByTestId("memory-edit").click();
			await page.getByTestId("memory-text-input").fill("My version about the walrus.");

			// omp consolidates or rewrites it while the page is open.
			const db = sql("default");
			db.prepare("UPDATE working_memory SET content = ? WHERE id = 'g-conflict'").run(
				"omp's own rewrite about the walrus.",
			);
			db.close();

			await page.getByTestId("memory-save").click();
			const conflict = page.getByTestId("memory-conflict");
			await expect(conflict).toBeVisible();
			await expect(conflict).toContainText("omp's own rewrite about the walrus.");
			await expect(page.getByTestId("memory-text-input")).toHaveValue("My version about the walrus.");
			expect(storedContent(agentDir(), "default", "g-conflict")).toBe("omp's own rewrite about the walrus.");

			// Saving is not offered until a choice is made: the edit is kept ("keep mine") or dropped ("use the current text").
			await expect(page.getByTestId("memory-save")).toBeDisabled();
			await page.getByTestId("memory-keep-mine").click();
			await expect(conflict).toHaveCount(0);
			await page.getByTestId("memory-save").click();
			await expect(toast(page, en.saved)).toBeVisible();
			expect(storedContent(agentDir(), "default", "g-conflict")).toBe("My version about the walrus.");
		});

		test("an edit that was left (another memory looked at, or the page refreshed) and comes back over a memory that changed meanwhile is a conflict, never an overwrite", async ({
			page,
		}) => {
			await open(page);
			await openMemory(page, "ibex", "g-draft");
			await page.getByTestId("memory-edit").click();
			await page.getByTestId("memory-text-input").fill("My draft about the ibex.");
			// Leave it for another memory; omp rewrites the first one meanwhile.
			await search(page, "");
			await row(page, "zebra").click();
			await expect(detail(page)).toHaveAttribute("data-id", "g-zebra");
			const db = sql("default");
			db.prepare("UPDATE working_memory SET content = ? WHERE id = 'g-draft'").run("omp's rewrite about the ibex.");
			db.close();
			// Back to it: the memory is read again, and the draft that is put back is not saved over what is there.
			await row(page, "ibex").click();
			await expect(detail(page)).toHaveAttribute("data-id", "g-draft");
			await expect(page.getByTestId("memory-text-input")).toHaveValue("My draft about the ibex.");
			await expect(page.getByTestId("memory-conflict")).toContainText("omp's rewrite about the ibex.");
			await expect(page.getByTestId("memory-save")).toBeDisabled();
			expect(storedContent(agentDir(), "default", "g-draft")).toBe("omp's rewrite about the ibex.");
			// The same after a Refresh, which reads the memory again too.
			await page.getByTestId("memory-refresh").click();
			await expect(page.getByTestId("memory-conflict")).toBeVisible();
			// "Use the current text" drops the edit and keeps what omp wrote.
			await page.getByTestId("memory-use-current").click();
			await expect(page.getByTestId("memory-text")).toHaveText("omp's rewrite about the ibex.");
			expect(storedContent(agentDir(), "default", "g-draft")).toBe("omp's rewrite about the ibex.");
		});

		test("deleting asks first (Cancel and Escape keep it), says what it takes with it, and can retire the consolidated copy", async ({
			page,
		}) => {
			await open(page);
			await openMemory(page, "tabs over spaces", "g-tabs");
			await page.getByTestId("memory-delete").click();
			const dialog = page.getByTestId("memory-delete-dialog");
			await expect(dialog).toBeVisible();
			await expect(dialog).toContainText("The person prefers tabs over spaces");
			await expect(dialog).toContainText(en.deleteConsolidated);
			// Enter on a dialog that deletes must not be a delete: Cancel holds the focus.
			await expect(page.getByTestId("memory-delete-cancel")).toBeFocused();
			await page.keyboard.press("Escape");
			await expect(dialog).toHaveCount(0);
			expect(storedContent(agentDir(), "default", "g-tabs")).not.toBeNull();

			await page.getByTestId("memory-delete").click();
			await page.getByTestId("memory-delete-cancel").click();
			await expect(dialog).toHaveCount(0);
			expect(storedContent(agentDir(), "default", "g-tabs")).not.toBeNull();

			await page.getByTestId("memory-delete").click();
			await page.getByTestId("memory-delete-also-retire").check();
			await page.getByTestId("memory-delete-confirm").click();
			await expect(toast(page, en.deleted)).toBeVisible();
			await expect(dialog).toHaveCount(0);
			expect(storedContent(agentDir(), "default", "g-tabs")).toBeNull();
			await expect(row(page, "tabs over spaces")).toHaveCount(0);
			// What omp made of it is retired, not deleted: it is still there for whoever turns the switch on.
			const copy = await (await page.request.get("/api/memory/item?bank=default&id=e-tabs")).json();
			expect(copy.item.retired).toBe(true);
			expect(backups("default").length).toBeGreaterThan(0);
		});

		test("a consolidated memory can only be retired and brought back", async ({ page }) => {
			await open(page);
			await openMemory(page, "narwhal", "e-solo");
			await expect(page.getByTestId("memory-readonly-note")).toHaveText(en.notEditableConsolidated);
			await expect(page.getByTestId("memory-edit")).toHaveCount(0);
			await expect(page.getByTestId("memory-delete")).toHaveCount(0);
			await expect(page.locator('[data-field="made-from"]')).toHaveText(fill(en.madeFromGone, { id: "long-gone" }));

			await page.getByTestId("memory-retire").click();
			await expect(toast(page, en.retired)).toBeVisible();
			await expect(page.getByTestId("memory-retired-note")).toBeVisible();
			await expect(rows(page)).toHaveCount(0);
			await page.getByTestId("memory-show-retired").click();
			await expect(rows(page)).toHaveCount(1);
			await expect(rows(page).first()).toContainText(en.retiredBadge);
			await page.getByTestId("memory-restore").click();
			await expect(toast(page, en.restored)).toBeVisible();
			await expect(page.getByTestId("memory-retired-note")).toHaveCount(0);
			await expect(rows(page).first()).not.toContainText(en.retiredBadge);
		});

		test("adding: under omp's per-project scoping there is no global memory to add, a project's is added and shown", async ({
			page,
		}) => {
			await open(page);
			await page.getByTestId("memory-add").click();
			const dialog = page.getByTestId("memory-add-dialog");
			await expect(dialog).toBeVisible();
			await expect(page.getByTestId("memory-add-global")).toBeDisabled();
			await expect(dialog).toContainText(en.addGlobalNo);
			await expect(page.getByTestId("memory-add-project")).toBeChecked();
			await page.getByTestId("memory-add-bank").selectOption({ label: "site" });
			await expect(page.getByTestId("memory-add-submit")).toBeDisabled();
			await page.getByTestId("memory-add-text").fill(`Remember the aardvark tariff ${SECRET}`);
			await expect(dialog.getByRole("status")).toContainText(en.secretWarning);
			await page.getByTestId("memory-add-text").fill("Remember the aardvark tariff.");
			await page.getByTestId("memory-add-context").fill("Typed on the Memory page.");
			await page.getByTestId("memory-add-submit").click();
			await expect(toast(page, en.added)).toBeVisible();
			await expect(page.getByTestId("memory-text")).toHaveText("Remember the aardvark tariff.");
			await expect(page.locator('[data-field="origin"]')).toHaveText(en.originWeb);
			await expect(page.locator('[data-field="reason"]')).toHaveText("Typed on the Memory page.");
			const db = sql(SITE);
			const added = db
				.prepare("SELECT source, content, metadata_json FROM working_memory WHERE content LIKE '%aardvark%'")
				.all() as { source: string; content: string; metadata_json: string }[];
			db.close();
			expect(added).toHaveLength(1);
			expect(added[0]?.source).toBe("omp-webui");
			expect(JSON.parse(added[0]?.metadata_json ?? "{}")).toMatchObject({
				context: "Typed on the Memory page.",
				cwd: "/work/site",
			});
		});

		test("adding a global memory works once omp's scoping is global", async ({ page }) => {
			const config = join(agentDir(), "config.yml");
			const before = readFileSync(config, "utf8");
			writeFileSync(config, withYaml(before, "mnemopi:\n  scoping: global"));
			try {
				await open(page);
				await page.getByTestId("memory-add").click();
				await expect(page.getByTestId("memory-add-global")).toBeEnabled();
				await expect(page.getByTestId("memory-add-global")).toBeChecked();
				await page.getByTestId("memory-add-text").fill("Remember the okapi rule.");
				// The answer, not the toast that follows it. A toast lives 4.5 s and the page is busy while the store is
				// written: under a machine running several specs at once the assertion could poll before the toast was put up
				// and again after it was taken down, and see neither. The request's own answer is the fact under test; the
				// toast is then looked for once the page has settled.
				const answered = page.waitForResponse(
					(r) => new URL(r.url()).pathname === "/api/memory/add" && r.request().method() === "POST",
				);
				await page.getByTestId("memory-add-submit").click();
				expect((await answered).status()).toBe(200);
				// The toast as well, once the answer is in: it is put up after the dialog closes, not instead of the answer.
				await expect(toast(page, en.added)).toBeVisible();
				await expect(page.locator('[data-field="where"]')).toHaveText(en.fieldWhereGlobal);
				const db = sql("default");
				const added = db.prepare("SELECT source FROM working_memory WHERE content LIKE '%okapi%'").all() as {
					source: string;
				}[];
				db.close();
				expect(added).toEqual([{ source: "omp-webui" }]);
			} finally {
				writeFileSync(config, before);
			}
		});

		test("on a narrow screen the list and the memory take turns, with a way back that returns to the row", async ({
			page,
		}) => {
			await page.setViewportSize({ width: 600, height: 900 });
			await open(page);
			await row(page, "pnpm").click();
			await expect(detail(page)).toHaveAttribute("data-id", "p-pnpm");
			await expect(page.getByTestId("memory-search")).toHaveCount(0);
			// Focus comes along to the memory: the list that held it is gone.
			await expect(page.getByRole("heading", { level: 2 })).toBeFocused();
			await page.getByTestId("memory-back").click();
			await expect(page.getByTestId("memory-search")).toBeVisible();
			await expect(row(page, "pnpm")).toBeFocused();
			// No sideways scroll on a phone.
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
		});

		test("on a page that came through the tunnel it says so and asks the server for nothing", async ({ page }) => {
			const asked: string[] = [];
			page.on("request", (r) => {
				if (new URL(r.url()).pathname.startsWith("/api/memory")) asked.push(r.url());
			});
			await page.route("**/api/meta", async (route) => {
				const res = await route.fetch();
				await route.fulfill({ response: res, json: { ...(await res.json()), remote: true } });
			});
			await page.goto("/#/memory");
			await expect(page.getByTestId("memory-remote")).toContainText(en.remoteTitle);
			await expect(page.getByTestId("memory-remote")).toContainText(en.remoteHint);
			await expect(page.getByTestId("memory-search")).toHaveCount(0);
			await page.waitForTimeout(500);
			expect(asked).toEqual([]);
		});

		test("with no store yet the page gives the command that turns memory on, to copy, and Add is disabled, with its reason on the page", async ({
			page,
			context,
		}) => {
			await context.grantPermissions(["clipboard-read", "clipboard-write"]);
			await page.route("**/api/memory", (route) =>
				route.fulfill({
					json: {
						backend: "off",
						scoping: null,
						settingsKnown: true,
						present: false,
						dbPath: "/nowhere/memory.db",
						unsupported: null,
						banks: [],
						hiddenBanks: 0,
						canAddGlobal: false,
					},
				}),
			);
			await page.goto("/#/memory");
			await expect(page.getByTestId("memory-none")).toBeVisible();
			// One thing said once: there is no store, and how memory is turned on. Nothing about omp "not using this store".
			await expect(page.getByTestId("memory-none")).toContainText(en.noneTitle);
			await expect(page.getByTestId("memory-none-hint")).toHaveText(en.noneHint);
			await expect(page.getByTestId("memory-not-used")).toHaveCount(0);
			const command = "omp config set memory.backend mnemopi";
			await expect(page.getByTestId("memory-enable-command")).toHaveText(command);
			await page.getByTestId("memory-enable").getByRole("button", { name: /^Copy/ }).click();
			expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(command);

			// Add cannot be pressed: really disabled (not only dimmed), and the reason is on the page, not in a tooltip.
			const add = page.getByTestId("memory-add");
			await expect(add).toBeDisabled();
			await expect(add).toHaveAccessibleDescription(en.addNoStore);
			await expect(page.getByTestId("memory-add-why")).toHaveText(en.addNoStore);
			await expect(page.getByTestId("memory-add-why")).toBeVisible();
			await add.click({ force: true });
			await expect(page.getByTestId("memory-add-dialog")).toHaveCount(0);

			// On a phone the reason fits the screen under the buttons, and the command box has the page's own margins
			// (24 px, as the header and the notices have), not the few pixels the text box's width left it.
			await page.setViewportSize({ width: 390, height: 844 });
			const why = await boxOf(page.getByTestId("memory-add-why"));
			expect(why.x).toBeGreaterThanOrEqual(0);
			expect(why.x + why.width).toBeLessThanOrEqual(390);
			expect(why.y, "under the buttons").toBeGreaterThan((await boxOf(add)).y + (await boxOf(add)).height - 1);
			const box = await boxOf(page.getByTestId("memory-enable-command").locator("xpath=.."));
			expect(box.x, "the command box's left margin").toBeGreaterThanOrEqual(20);
			expect(390 - (box.x + box.width), "the command box's right margin").toBeGreaterThanOrEqual(20);
		});

		/** The overview of a computer where omp has not made its store yet, with `backend` as omp's `memory.backend`. */
		const noStore = (backend: string | null): MemoryOverview => ({
			backend,
			scoping: null,
			settingsKnown: backend !== null,
			present: false,
			dbPath: "/nowhere/memory.db",
			unsupported: null,
			banks: [],
			hiddenBanks: 0,
			canAddGlobal: false,
		});

		test("with no store yet, what the page says agrees with omp's memory setting: on, another backend, or not known", async ({
			page,
		}) => {
			let overview = noStore("mnemopi");
			await page.route("**/api/memory", (route) => route.fulfill({ json: overview }));
			const why = page.getByTestId("memory-add-why");
			const hint = page.getByTestId("memory-none-hint");

			// Memory is on: the store is made when omp first saves something. Nothing to turn on, and no warning.
			await page.goto("/#/memory");
			await expect(page.getByTestId("memory-none")).toContainText(en.noneTitle);
			await expect(hint).toHaveText(en.noneOnHint);
			await expect(page.getByTestId("memory-enable")).toHaveCount(0);
			await expect(why).toHaveText(en.addNoStoreYet);
			await expect(page.getByTestId("memory-add")).toBeDisabled();
			await expect(page.getByTestId("memory-settings-unknown")).toHaveCount(0);
			await expect(page.getByTestId("memory-not-used")).toHaveCount(0);

			// Another backend: it is named, and the command switches omp to the memory this page shows.
			overview = noStore("local");
			await page.reload();
			await expect(hint).toHaveText(fill(en.noneOtherHint, { backend: "local" }));
			await expect(page.getByTestId("memory-enable-command")).toBeVisible();
			await expect(why).toHaveText(en.addNoStore);
			await expect(page.getByTestId("memory-not-used")).toHaveCount(0);

			// omp's settings could not be read: the notice says so of a store that is not there, not of one "shown".
			overview = noStore(null);
			await page.reload();
			await expect(page.getByTestId("memory-settings-unknown")).toHaveText(en.settingsUnknownNoStore);
			await expect(hint).toHaveText(en.noneHint);
			await expect(why).toHaveText(en.addNoStore);
			await expect(page.getByTestId("memory-not-used")).toHaveCount(0);

			// In Chinese, the same one thing.
			overview = noStore("off");
			await page.evaluate(() => localStorage.setItem("ompw.lang", "zh-CN"));
			await page.reload();
			await expect(page.getByTestId("memory-none")).toContainText(zh.noneTitle);
			await expect(hint).toHaveText(zh.noneHint);
			await expect(why).toHaveText(zh.addNoStore);
			await expect(page.getByTestId("memory-not-used")).toHaveCount(0);
		});

		test("it is in Chinese, with 对话 and not 会话", async ({ page }) => {
			await open(page, "zh-CN");
			await expect(page.getByRole("heading", { level: 1 })).toHaveText(zh.title);
			await expect(page.getByTestId("memory-add")).toContainText(zh.add);
			await expect(page.getByTestId("memory-kind-conversation")).toContainText(zh.kindConversation);
			await expect(page.getByTestId("memory-not-used")).toContainText("off");
			await expect(page.getByTestId("memory-not-used")).toContainText(fill(zh.notUsed, { backend: "off" }));
			await row(page, "zebra").click();
			await expect(page.locator('[data-field="where"]')).toHaveText(zh.fieldWhereGlobal);
			await expect(page.locator('[data-field="origin"]')).toHaveText(zh.originRetain);
			const text = await page.getByTestId("memory-page").innerText();
			expect(text).not.toContain("会话");
			expect(text).not.toMatch(/Memory page|Include retired|Show more/);
		});

		for (const theme of ["light", "dark"] as const) {
			test(`the page has no accessibility violation in the ${theme} theme, with a memory open, its editor and the add dialog`, async ({
				page,
			}) => {
				const violations = async (scope: string) =>
					(await new AxeBuilder({ page }).include(scope).analyze()).violations.map((v) => `${v.id}: ${v.help}`);
				await open(page, "en", theme);
				await openMemory(page, "pnpm", "p-pnpm");
				expect(await violations('[data-testid="memory-page"]')).toEqual([]);
				await page.getByTestId("memory-edit").click();
				await page.getByTestId("memory-text-input").fill(`secret ${SECRET}`);
				await expect(page.getByTestId("memory-secret-warning")).toBeVisible();
				expect(await violations('[data-testid="memory-page"]')).toEqual([]);
				await page.getByTestId("memory-add").click();
				await expect(page.getByTestId("memory-add-dialog")).toBeVisible();
				// Contrast is measured on what is painted: a dialog still fading in (0.18 s) is a blend of itself and the page.
				await expect(page.getByRole("dialog")).toHaveCSS("opacity", "1");
				expect(await violations('[role="dialog"]')).toEqual([]);
			});
		}
	});
