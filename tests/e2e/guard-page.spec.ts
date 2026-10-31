import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { GUARD_LOG_DIR, GUARD_LOG_FILE, type GuardDecision, newDecisionId } from "../../shared/guard.ts";
import { DEFAULT_POLICY, DEFAULT_POLICY_VERSION } from "../../shared/guard-policy.ts";
import { en } from "../../web/src/i18n/guard.ts";
import { zh } from "../../web/src/i18n/zh-CN/guard.ts";
import { writeFakeOmp } from "../support/fake-omp.ts";
import { FIXTURE_CWD } from "../support/fixtures.ts";
import { choose, readOptions } from "../support/select.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { removeTrackedTempDirs, tempDir } from "../support/temp-dirs.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The Guard page (#638), as the person sees it: the decisions in a list of their own (scrolled, filtered, followed live),
 * the policy (a threshold per kind of call, the reviewer's rules with Restore default and the "default changed" notice) and
 * the benchmark (run with the classifier, run with a fake reviewer, cancel, the person's own cases), in both languages, on a
 * phone and in the light and dark themes. The server is this spec's own, with a fake omp: its models are listed by the fake
 * and its print mode (what the benchmark asks its reviewer through) answers deny to a message that names `rm -rf` and allow
 * to every other. No model is called and the benchmark runs nothing. Decisions are written to the file the gates append to.
 */

let s: TestServer;
let reviewLog = "";
const TOTAL = 120;
const POST = { "x-omp-webui": "1", "content-type": "application/json" };

const guardFile = () => join(s.root, "guard.json");
const logFile = () => join(s.root, "data", GUARD_LOG_DIR, GUARD_LOG_FILE);
const kept = () => JSON.parse(readFileSync(guardFile(), "utf8")) as Record<string, unknown>;
const reviewed = (): number =>
	existsSync(reviewLog) ? readFileSync(reviewLog, "utf8").split("\n").filter(Boolean).length : 0;

/** A request to this spec's server, as the page of this computer makes it. */
async function api(path: string, body?: unknown): Promise<unknown> {
	const res = await fetch(`${s.url}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: { "x-omp-webui-token": s.accessToken, ...(body === undefined ? {} : POST) },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	expect(res.status, `${path}`).toBe(200);
	return res.json();
}

const pad = (n: number) => String(n).padStart(3, "0");
let seq = 0;

/** A decision as a gate writes it. */
function decision(over: Partial<GuardDecision> = {}): GuardDecision {
	const at = Date.now() + ++seq;
	return {
		id: newDecisionId(at),
		at,
		session: "01a00000-0000-7000-8000-000000638999",
		file: "",
		agent: "main",
		subagent: false,
		toolCallId: "",
		tool: "bash",
		kinds: ["delete_outside"],
		cwd: FIXTURE_CWD,
		intent: "",
		detail: "rm -rf /tmp/x",
		mode: "reviewer",
		verdict: "allow",
		by: "reviewer",
		reason: "Looks routine.",
		model: "fake/reviewer-a",
		tried: ["fake/reviewer-a"],
		ms: 900,
		...over,
	};
}

/** Write decisions to the file the gates append to: the server hears of them within a second. */
function decided(...ds: GuardDecision[]): void {
	mkdirSync(dirname(logFile()), { recursive: true });
	appendFileSync(logFile(), `${ds.map((d) => JSON.stringify(d)).join("\n")}\n`);
}

/** How many of the seeded decisions are of each outcome: by `i % 4` (0 reviewer denied, 1 reviewer allowed, 2 you allowed, 3 classifier blocked). */
const SEEDED = { blocked: TOTAL / 2, allowed: TOTAL / 4, asked: TOTAL / 4, classifier: TOTAL / 4 };

test.beforeAll(async () => {
	const dir = tempDir("ompw-guard-page-");
	reviewLog = join(dir, "review.jsonl");
	const fake = writeFakeOmp(dir, {
		models: [
			{ provider: "fake", id: "reviewer-a", cost: { output: 1 } },
			{ provider: "fake", id: "reviewer-b", cost: { output: 2 } },
		],
		review: { log: reviewLog, delayMs: 150, deny: ["rm -rf", "rmtree", "rmSync", "-delete", "xargs rm"] },
	});
	s = await startTestServer(0, { OMP_BIN: fake }, { login: false });
	// The first decision is the oldest: `cmd-001`.
	const seeded: GuardDecision[] = [];
	for (let i = 1; i <= TOTAL; i++) {
		const kind = i % 4;
		seeded.push(
			decision({
				detail: `rm -rf /tmp/cmd-${pad(i)}`,
				reason: `reason-${pad(i)}`,
				...(kind === 0 ? { verdict: "deny", by: "reviewer" } : {}),
				...(kind === 1 ? { verdict: "allow", by: "reviewer" } : {}),
				...(kind === 2 ? { verdict: "allow", by: "person", model: undefined, tried: undefined } : {}),
				...(kind === 3 ? { verdict: "deny", by: "classifier", model: undefined, tried: undefined } : {}),
			}),
		);
	}
	decided(...seeded);
});

test.afterAll(async () => {
	await s?.stop();
	removeTrackedTempDirs();
});

// Every test starts from the same settings: the reviewer decides, nothing tuned.
test.beforeEach(async () => {
	await api("/api/guard", { mode: "reviewer", reviewer: "fake/reviewer-a", askWhenUnavailable: true });
	await api("/api/guard/rules", {
		policy: null,
		thresholds: Object.fromEntries(
			["delete_outside", "write_outside", "discard", "osascript", "privilege", "force_push", "protected"].map((k) => [
				k,
				null,
			]),
		),
		cases: [],
	});
});

async function openGuard(
	page: Page,
	opts: { lang?: "en" | "zh-CN"; theme?: "light" | "dark"; tab?: "decisions" | "policy" | "bench" } = {},
): Promise<void> {
	await page.addInitScript(
		([lang, theme]) => {
			localStorage.setItem("ompw.lang", lang);
			localStorage.setItem("ompw.autoTitle", "off");
			if (theme) localStorage.setItem("ompw.theme", theme);
		},
		[opts.lang ?? "en", opts.theme ?? ""],
	);
	await page.goto(`${s.url}/?token=${s.accessToken}`);
	await page.evaluate(() => {
		location.hash = "#/guard";
	});
	await expect(page.getByTestId("guard-page")).toBeVisible();
	if (opts.tab && opts.tab !== "decisions") await page.getByTestId(`guard-tab-${opts.tab}`).click();
}

const rows = (page: Page) => page.getByTestId("guard-log-row");
const list = (page: Page) => page.getByTestId("guard-log-list");
const fill = (text: string, values: Record<string, string | number>): string =>
	text.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ""));

/** Scroll the list to its end until `match` is on screen: pages arrive as the end comes into view. */
async function scrollTo(page: Page, text: string): Promise<void> {
	await expect
		.poll(
			async () => {
				await list(page).evaluate((el) => {
					el.scrollTop = el.scrollHeight;
				});
				return rows(page).filter({ hasText: text }).count();
			},
			{ timeout: 30_000 },
		)
		.toBe(1);
}

// ------------------------------------------------------------------ Settings keeps a link and a line

test("Settings › Safety has a link and a short summary of where the guard stands, and no log", async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	await page.goto(`${s.url}/?token=${s.accessToken}`);
	await page.evaluate(() => {
		location.hash = "#/settings/safety";
	});
	await expect(page.getByTestId("guard-settings")).toBeVisible();
	await expect(page.getByTestId("guard-log")).toHaveCount(0);
	const summary = page.getByTestId("guard-summary-line");
	await expect(summary.locator("dt")).toHaveText([
		en.settingsSummaryDecisions,
		en.settingsSummaryRules,
		en.settingsSummaryChanged,
	]);
	await expect(summary.locator("dd")).toHaveText([
		fill(en.settingsSummaryDecisionsCount, { count: TOTAL }),
		en.settingsPolicyDefault,
		"0",
	]);
	await page.getByTestId("guard-open-page").click();
	await expect(page.getByTestId("guard-page")).toBeVisible();
	await expect(page).toHaveURL(/#\/guard$/);
});

// ------------------------------------------------------------------ the decisions

test.describe("the decisions", () => {
	test("are a list of their own: lazy, newest first, drawn a window at a time and read a page at a time as it is scrolled", async ({
		page,
	}) => {
		const chunks: string[] = [];
		const asked: string[] = [];
		page.on("request", (r) => {
			const url = new URL(r.url());
			if (/\/(GuardPage|GuardPolicy|GuardBench)-.*\.js$/.test(url.pathname))
				chunks.push(url.pathname.split("/").pop() ?? "");
			if (url.pathname === "/api/guard/log") asked.push(url.search);
		});
		await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
		await page.goto(`${s.url}/?token=${s.accessToken}`);
		// Not loaded, not read, until the page is opened; and the other tabs' code is not loaded until they are.
		expect(chunks).toEqual([]);
		await page.evaluate(() => {
			location.hash = "#/guard";
		});
		await expect(page.getByTestId("guard-log")).toBeVisible();
		expect(chunks.filter((c) => c.startsWith("GuardPage"))).toHaveLength(1);
		expect(chunks.filter((c) => c.startsWith("GuardPolicy") || c.startsWith("GuardBench"))).toEqual([]);

		await expect(page.getByTestId("guard-log-count")).toHaveText(fill(en.decCount, { total: TOTAL }));
		// Newest first, and only a window of them is drawn.
		await expect(rows(page).first()).toContainText(`cmd-${pad(TOTAL)}`);
		expect(await rows(page).count()).toBeLessThan(40);
		// One page asked for, not the whole log.
		expect(asked.filter((q) => q.includes("limit=50")).length).toBeGreaterThan(0);
		expect(asked.some((q) => q.includes("before="))).toBe(false);

		// To the oldest: the next pages are asked for as the end comes into view.
		await scrollTo(page, "cmd-001");
		expect(asked.some((q) => q.includes("before="))).toBe(true);
		expect(await rows(page).count()).toBeLessThan(40);
		// A row says what it is: time, the command, the verdict, who decided it and why.
		const oldest = rows(page).filter({ hasText: "cmd-001" });
		await expect(oldest.getByTestId("guard-log-command")).toContainText("rm -rf /tmp/cmd-001");
		await expect(oldest.locator("time")).toHaveAttribute("datetime", /^\d{4}-/);
		await expect(oldest).toContainText("reason-001");
		await expect(oldest.getByTestId("guard-log-by")).toHaveText(en.byReviewer);
		await expect(oldest.getByTestId("guard-log-chip")).toHaveText(en.chipAllowed);
	});

	test("are filtered by outcome, by who decided and by words, and say how many match", async ({ page }) => {
		await openGuard(page);
		const count = page.getByTestId("guard-log-count");
		await choose(page.getByTestId("guard-filter-outcome"), "blocked");
		await expect(count).toHaveText(fill(en.decCountFiltered, { matched: SEEDED.blocked, total: TOTAL }));
		await expect(rows(page).first()).toBeVisible();
		for (const outcome of await rows(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-outcome")))) {
			expect(["denied", "guardRefused", "youDenied", "unavailable"]).toContain(outcome);
		}
		await choose(page.getByTestId("guard-filter-outcome"), "asked");
		await expect(count).toHaveText(fill(en.decCountFiltered, { matched: SEEDED.asked, total: TOTAL }));
		for (const by of await rows(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-by"))))
			expect(by).toBe("person");

		await choose(page.getByTestId("guard-filter-outcome"), "");
		await choose(page.getByTestId("guard-filter-by"), "classifier");
		await expect(count).toHaveText(fill(en.decCountFiltered, { matched: SEEDED.classifier, total: TOTAL }));
		for (const by of await rows(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-by"))))
			expect(by).toBe("classifier");
		// Both at once: nothing the classifier decided was allowed.
		await choose(page.getByTestId("guard-filter-outcome"), "allowed");
		await expect(page.getByTestId("guard-log-nomatch")).toHaveText(en.decNoMatch);

		await choose(page.getByTestId("guard-filter-outcome"), "");
		await choose(page.getByTestId("guard-filter-by"), "");
		await page.getByTestId("guard-filter-text").fill("cmd-077");
		await expect(count).toHaveText(fill(en.decCountFiltered, { matched: 1, total: TOTAL }));
		await expect(rows(page)).toHaveCount(1);
		await expect(rows(page).first()).toContainText("reason-077");
		// The reason is searched too, and what matches nothing says so.
		await page.getByTestId("guard-filter-text").fill("reason-0");
		// reason-001 to reason-099: the ones from 100 on do not start with it.
		await expect(count).toHaveText(fill(en.decCountFiltered, { matched: 99, total: TOTAL }));
		await page.getByTestId("guard-filter-text").fill("zzz-nothing-has-this");
		await expect(page.getByTestId("guard-log-nomatch")).toBeVisible();
	});

	test("follow a decision made while the page is open to the top, when it matches the filters", async ({ page }) => {
		await openGuard(page);
		await expect(rows(page).first()).toContainText(`cmd-${pad(TOTAL)}`);
		const tag = `LIVE-${Date.now()}`;
		decided(decision({ detail: `rm -rf /tmp/${tag}`, reason: tag, verdict: "deny", by: "classifier" }));
		await expect(rows(page).first()).toContainText(tag, { timeout: 15_000 });
		await expect(rows(page).first().getByTestId("guard-log-chip")).toHaveText(en.chipGuardRefused);
		// With a filter it does not match, it is not added; the count stays what the filter says.
		await choose(page.getByTestId("guard-filter-outcome"), "allowed");
		await expect(page.getByTestId("guard-log-count")).toHaveText(
			fill(en.decCountFiltered, { matched: SEEDED.allowed, total: TOTAL + 1 }),
		);
		const other = `LIVE2-${Date.now()}`;
		decided(decision({ detail: `rm -rf /tmp/${other}`, reason: other, verdict: "deny", by: "classifier" }));
		await expect(page.getByTestId("guard-log-count")).toHaveText(
			fill(en.decCountFiltered, { matched: SEEDED.allowed, total: TOTAL + 2 }),
		);
		await expect(rows(page).filter({ hasText: other })).toHaveCount(0);
	});

	test("show the exact call behind a button, as text", async ({ page }) => {
		const tag = `CALL-${Date.now()}`;
		decided(decision({ detail: `echo '<img src=x onerror=alert(1)>' # ${tag}`, reason: tag, kinds: ["privilege"] }));
		await openGuard(page);
		const row = rows(page).filter({ hasText: tag });
		await row.getByTestId("guard-log-call-toggle").click();
		await expect(row.getByTestId("guard-log-call")).toContainText("<img src=x onerror=alert(1)>");
		await expect(row.locator("img")).toHaveCount(0);
	});
});

// ------------------------------------------------------------------ the policy

test.describe("the policy", () => {
	test("a kind is set to Allow, Ask or Block at once and kept in guard.json; what must always be looked at cannot be Allow", async ({
		page,
	}) => {
		await openGuard(page, { tab: "policy" });
		const kind = page.getByTestId("guard-threshold-delete_outside");
		await expect(kind).toHaveAttribute("data-value", "ask");
		// Allow is asked about first: the shipped harmful cases are tried with it (from the classifier, nothing run), and what
		// would then run unasked is said. Nothing is kept until it is confirmed.
		const confirm = page.getByTestId("guard-allow-confirm");
		const preview = async (risk: string): Promise<number> =>
			(
				(await api("/api/guard/bench/preview", { thresholds: { [risk]: "allow" } })) as {
					preview: { after: number };
				}
			).preview.after;
		await page.getByTestId("guard-threshold-delete_outside-allow").locator("xpath=..").click();
		await expect(confirm).toHaveAttribute("data-kind", "delete_outside");
		await expect(confirm).toHaveAttribute("data-state", "tried");
		const asked = await preview("delete_outside");
		expect(asked).toBeGreaterThan(0);
		await expect(confirm.getByTestId("guard-allow-confirm-count")).toHaveText(
			fill(en.allowConfirmBody, { count: asked, now: 0 }),
		);
		const found = await new AxeBuilder({ page }).include('[data-testid="guard-allow-confirm"]').analyze();
		expect(found.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
		expect((kept().thresholds as Record<string, string> | undefined)?.delete_outside).toBeUndefined();
		await page.getByTestId("guard-allow-confirm-no").click();
		await expect(confirm).toHaveCount(0);
		await expect(kind).toHaveAttribute("data-value", "ask");
		expect((kept().thresholds as Record<string, string> | undefined)?.delete_outside).toBeUndefined();
		// The radio is visually hidden inside its label (the label is what is touched), so the label is clicked.
		await page.getByTestId("guard-threshold-delete_outside-block").locator("xpath=..").click();
		await expect(kind).toHaveAttribute("data-value", "block");
		await expect(page.getByTestId("guard-policy-status")).toHaveAttribute("data-state", "saved");
		await expect.poll(() => (kept().thresholds as Record<string, string> | undefined)?.delete_outside).toBe("block");
		await page.getByTestId("guard-threshold-write_outside-allow").locator("xpath=..").click();
		await expect(confirm).toHaveAttribute("data-kind", "write_outside");
		await expect(confirm).toHaveAttribute("data-state", "tried");
		const writes = await preview("write_outside");
		await expect(confirm.getByTestId("guard-allow-confirm-count")).toHaveText(
			fill(en.allowConfirmBody, { count: writes, now: 0 }),
		);
		await page.getByTestId("guard-allow-confirm-no").click();
		await expect(confirm).toHaveCount(0);
		await expect(page.getByTestId("guard-threshold-write_outside")).toHaveAttribute("data-value", "ask");
		expect((kept().thresholds as Record<string, string> | undefined)?.write_outside).toBeUndefined();
		await page.getByTestId("guard-threshold-write_outside-allow").locator("xpath=..").click();
		await page.getByTestId("guard-allow-confirm-yes").click();
		await expect.poll(() => (kept().thresholds as Record<string, string> | undefined)?.write_outside).toBe("allow");
		// The kinds with a floor: Allow is there and cannot be chosen, and the page says why in words, not only in a tooltip.
		for (const floored of ["protected", "unreadable", "mass_delete"]) {
			await expect(page.getByTestId(`guard-threshold-${floored}-allow`)).toBeDisabled();
			await expect(page.getByTestId(`guard-threshold-${floored}-allow`)).toHaveAccessibleDescription(en.thFloor);
			await expect(page.getByTestId(`guard-threshold-${floored}-floor`)).toBeVisible();
			await expect(page.getByTestId(`guard-threshold-${floored}-block`)).toBeEnabled();
		}
		await expect(page.getByTestId("guard-threshold-write_outside-floor")).toHaveCount(0);
		// Kept: a reload shows the same, and the Settings line counts the two.
		await page.reload();
		await page.getByTestId("guard-tab-policy").click();
		await expect(page.getByTestId("guard-threshold-delete_outside")).toHaveAttribute("data-value", "block");
		await expect(page.getByTestId("guard-threshold-write_outside")).toHaveAttribute("data-value", "allow");
		// Back to the default, all at once.
		await page.getByTestId("guard-thresholds-reset").click();
		await expect(page.getByTestId("guard-threshold-delete_outside")).toHaveAttribute("data-value", "ask");
		await expect.poll(() => kept().thresholds).toBeUndefined();
	});

	test("the reviewer's rules start as the readable default, are edited and kept, and Restore default brings it back", async ({
		page,
	}) => {
		await openGuard(page, { tab: "policy" });
		const text = page.getByTestId("guard-policy-text");
		await expect(page.getByTestId("guard-policy-state")).toHaveAttribute("data-status", "default");
		await expect(text).toHaveValue(DEFAULT_POLICY);
		await expect(page.getByTestId("guard-policy-save")).toBeDisabled();
		// The plain rules the issue names are in what the person reads.
		await expect(text).toHaveValue(/Writing or creating files in a folder outside the project[^\n]*: allow\./);
		await expect(text).toHaveValue(/Deleting files outside the project[^\n]*: block\./);

		const mine = "Reading anything: allow.\nDeleting in ~/Documents: block.\nEverything else: allow.";
		await text.fill(mine);
		await expect(page.getByTestId("guard-policy-save")).toBeEnabled();
		await page.getByTestId("guard-policy-save").click();
		await expect(page.getByTestId("guard-policy-status")).toHaveAttribute("data-state", "saved");
		await expect(page.getByTestId("guard-policy-state")).toHaveAttribute("data-status", "custom");
		expect((kept().policy as { text: string; basedOn: number }).text).toBe(mine);
		expect((kept().policy as { basedOn: number }).basedOn).toBe(DEFAULT_POLICY_VERSION);
		await page.reload();
		await page.getByTestId("guard-tab-policy").click();
		await expect(page.getByTestId("guard-policy-text")).toHaveValue(mine);

		// Nothing is not a policy: said, and not saved.
		await page.getByTestId("guard-policy-text").fill("   ");
		await expect(page.getByTestId("guard-policy-problem")).toHaveText(en.polProblemEmpty);
		await expect(page.getByTestId("guard-policy-save")).toBeDisabled();
		await page.getByTestId("guard-policy-text").fill(mine);

		// Restore asks first; keeping the text leaves it alone; restoring puts the default back and out of the file.
		await page.getByTestId("guard-policy-restore").click();
		await expect(page.getByTestId("guard-policy-confirm")).toBeVisible();
		await page.getByTestId("guard-policy-restore-no").click();
		await expect(page.getByTestId("guard-policy-text")).toHaveValue(mine);
		await page.getByTestId("guard-policy-restore").click();
		await page.getByTestId("guard-policy-restore-yes").click();
		await expect(page.getByTestId("guard-policy-text")).toHaveValue(DEFAULT_POLICY);
		await expect(page.getByTestId("guard-policy-state")).toHaveAttribute("data-status", "default");
		await expect.poll(() => kept().policy).toBeUndefined();
	});

	test("when the default has changed since the person's rules were made the page says so, shows the new default and lets them keep theirs", async ({
		page,
	}) => {
		// Rules made from an older default: only a server's own write can say so (basedOn is the version they started from).
		await api("/api/guard/rules", { policy: { text: "Old rules: block everything.", basedOn: 0 } });
		await openGuard(page, { tab: "policy" });
		const banner = page.getByTestId("guard-policy-outdated");
		await expect(banner).toBeVisible();
		await expect(page.getByTestId("guard-policy-state")).toHaveAttribute("data-status", "outdated");
		await expect(banner).toContainText(fill(en.polDefaultChangedBody, { based: 0, version: DEFAULT_POLICY_VERSION }));
		// Their text was not touched.
		await expect(page.getByTestId("guard-policy-text")).toHaveValue("Old rules: block everything.");
		await page.getByTestId("guard-policy-show-new").click();
		await expect(page.getByTestId("guard-policy-new-default")).toContainText("Mass deletion and overwriting");
		// The Settings line says it too.
		await page.getByTestId("guard-page-settings").click();
		await expect(page.getByTestId("guard-settings")).toBeVisible();
		await expect(page.getByTestId("guard-summary-line")).toContainText(en.settingsPolicyOutdated);
		await page.getByTestId("guard-open-page").click();
		await expect(page.getByTestId("guard-page")).toBeVisible();
		await page.getByTestId("guard-tab-policy").click();
		await page.getByTestId("guard-policy-keep").click();
		await expect(banner).toHaveCount(0);
		await expect(page.getByTestId("guard-policy-state")).toHaveAttribute("data-status", "custom");
		await expect(page.getByTestId("guard-policy-text")).toHaveValue("Old rules: block everything.");
		expect(kept().policy).toMatchObject({ text: "Old rules: block everything.", basedOn: DEFAULT_POLICY_VERSION });
	});
});

// ------------------------------------------------------------------ the benchmark

test.describe("the benchmark", () => {
	test("runs with the classifier, shows expected, got and by whom for each case, the summary, and what would change a slipped one", async ({
		page,
	}) => {
		await api("/api/guard/rules", { thresholds: { delete_outside: "allow", discard: "block" } });
		await openGuard(page, { tab: "bench" });
		const before = reviewed();
		await expect(page.getByTestId("bench-case").first()).toBeVisible();
		await page.getByTestId("bench-run").click();
		await expect(page.getByTestId("bench-status")).toHaveAttribute("data-state", "done", { timeout: 30_000 });
		expect(reviewed()).toBe(before);
		const summary = page.getByTestId("bench-summary-line");
		await expect(summary).toContainText("Stopped");
		// What the settings stop by themselves: git clean (discard is Block), by the classifier.
		const clean = page.locator('[data-testid="bench-case"][data-id="git_clean_outside"]');
		await expect(clean).toHaveAttribute("data-outcome", "blocked");
		await expect(clean.getByTestId("bench-by")).toContainText(en.byClassifier);
		await expect(clean.getByTestId("bench-got")).toContainText(en.benchOutBlocked);
		await expect(clean).toContainText(en.benchExpectHarmful);
		// A slipped harmful case (deleting is Allow): says so, and names the setting that would stop it, with a button.
		const slipped = page.locator('[data-testid="bench-case"][data-id="rm_folder"]');
		await expect(slipped).toHaveAttribute("data-outcome", "allowed");
		await expect(slipped).toHaveAttribute("data-ok", "false");
		await expect(page.getByTestId("bench-slipped")).toBeVisible();
		await expect(slipped.getByTestId("bench-suggestions")).toContainText(
			fill(en.sugThreshold, { category: en.catName_delete_outside, to: en.thBlock }),
		);
		// Ordinary work runs.
		await expect(page.locator('[data-testid="bench-case"][data-id="ls"]')).toHaveAttribute("data-ok", "true");
		// Flagged and left to the reviewer: neither stopped nor let through.
		await expect(page.locator('[data-testid="bench-case"][data-id="curl_sh"]')).toHaveAttribute(
			"data-outcome",
			"flagged",
		);
		await expect(page.getByTestId("bench-undecided")).toBeVisible();

		// Apply the suggestion, run again: it is stopped now, and the setting is kept.
		await slipped.getByTestId("bench-apply").click();
		await expect.poll(() => (kept().thresholds as Record<string, string>).delete_outside).toBe("block");
		await page.getByTestId("bench-run").click();
		await expect(page.locator('[data-testid="bench-case"][data-id="rm_folder"]')).toHaveAttribute(
			"data-outcome",
			"blocked",
		);
		await expect(page.locator('[data-testid="bench-case"][data-id="rm_folder"]').getByTestId("bench-by")).toContainText(
			en.byClassifier,
		);
	});

	test("runs with the fake reviewer for what the settings leave to it, and nothing is run", async ({ page }) => {
		await openGuard(page, { tab: "bench" });
		const before = reviewed();
		const marker = join(s.home, "Documents");
		await page.getByTestId("bench-run-reviewer").click();
		await expect(page.getByTestId("bench-status")).toHaveAttribute("data-state", "running");
		await expect(page.getByTestId("bench-cancel")).toBeVisible();
		await expect(page.getByTestId("bench-status")).toHaveAttribute("data-state", "done", { timeout: 90_000 });
		await expect(page.getByTestId("bench-cancel")).toHaveCount(0);
		expect(reviewed()).toBeGreaterThan(before);
		const denied = page.locator('[data-testid="bench-case"][data-id="rm_folder"]');
		await expect(denied).toHaveAttribute("data-outcome", "blocked");
		await expect(denied.getByTestId("bench-by")).toContainText(en.byReviewer);
		await expect(denied.getByTestId("bench-by")).toContainText("fake/reviewer-a");
		await expect(denied.getByTestId("bench-reason")).toContainText("fake reviewer denies");
		// A harmless case flagged and allowed by the reviewer.
		await expect(page.locator('[data-testid="bench-case"][data-id="copy_downloads"]')).toHaveAttribute(
			"data-outcome",
			"allowed",
		);
		await expect(page.getByTestId("bench-undecided")).toHaveCount(0);
		await expect(page.getByTestId("bench-summary-line")).toContainText("Stopped");
		// Nothing of what the cases name exists.
		expect(existsSync(marker)).toBe(false);
	});

	test("can be cancelled while the reviewer is being asked", async ({ page }) => {
		await openGuard(page, { tab: "bench" });
		await page.getByTestId("bench-run-reviewer").click();
		await expect(page.getByTestId("bench-status")).toHaveAttribute("data-state", "running");
		await page.getByTestId("bench-cancel").click();
		await expect(page.getByTestId("bench-status")).toHaveAttribute("data-state", "cancelled", { timeout: 30_000 });
		await expect(page.getByTestId("bench-run")).toBeEnabled();
		await expect(page.getByTestId("bench-status")).toContainText(en.benchCancelled);
	});

	test("without Reviewer mode there is no reviewer run: the button is off and the page says why", async ({ page }) => {
		await api("/api/guard", { mode: "ask" });
		await openGuard(page, { tab: "bench" });
		await expect(page.getByTestId("bench-run-reviewer")).toBeDisabled();
		await expect(page.getByTestId("bench-reviewer-note")).toHaveText(en.benchNoReviewer);
	});

	test("the person's own cases are added, judged with the rest, and removed", async ({ page }) => {
		await openGuard(page, { tab: "bench" });
		await page.getByTestId("bench-own-name").fill("my wipe");
		await choose(page.getByTestId("bench-own-expect"), "harmful");
		await page.getByTestId("bench-own-command").fill("find ~/Music -name '*.mp3' -delete");
		await page.getByTestId("bench-own-add").click();
		await expect(page.getByTestId("bench-own-item")).toHaveCount(1);
		await expect.poll(() => (kept().cases as unknown[] | undefined)?.length).toBe(1);
		await page.getByTestId("bench-run").click();
		await expect(page.getByTestId("bench-status")).toHaveAttribute("data-state", "done", { timeout: 30_000 });
		const mine = page.locator('[data-testid="bench-case"][data-id^="u-"]');
		await expect(mine).toHaveCount(1);
		await expect(mine).toContainText("my wipe");
		await expect(mine).toContainText("find ~/Music");
		await expect(mine.getByTestId("bench-got")).toBeVisible();
		await page.getByTestId("bench-own-item").getByRole("button").click();
		await expect(page.getByTestId("bench-own-item")).toHaveCount(0);
		await expect.poll(() => kept().cases).toBeUndefined();
	});

	test("a harmless case the reviewer stopped is only ever suggested Allow for a kind no shipped harmful case carries, and it is applied after the question", async ({
		page,
	}) => {
		await openGuard(page, { tab: "bench" });
		await page.getByTestId("bench-own-name").fill("my global install");
		await choose(page.getByTestId("bench-own-expect"), "harmless");
		// The fake reviewer denies a message that names `rm -rf`, as a comment does.
		await page.getByTestId("bench-own-command").fill("npm install -g left-pad # rm -rf");
		await page.getByTestId("bench-own-add").click();
		await expect(page.getByTestId("bench-own-item")).toHaveCount(1);
		await page.getByTestId("bench-run-reviewer").click();
		await expect(page.getByTestId("bench-status")).toHaveAttribute("data-state", "done", { timeout: 90_000 });
		const mine = page.locator('[data-testid="bench-case"][data-id^="u-"]');
		await expect(mine).toHaveAttribute("data-outcome", "blocked");
		const suggestions = mine.getByTestId("bench-suggestions");
		await expect(suggestions).toContainText(
			fill(en.sugThreshold, { category: en.catName_global_install, to: en.thAllow }),
		);
		await mine.getByTestId("bench-apply").click();
		// The question comes first, with the classifier-only benchmark's count; nothing is changed yet.
		const confirm = mine.getByTestId("guard-allow-confirm");
		await expect(confirm).toHaveAttribute("data-kind", "global_install");
		await expect(confirm).toHaveAttribute("data-state", "tried");
		await expect(confirm.getByTestId("guard-allow-confirm-count")).toHaveText(
			fill(en.allowConfirmBody, { count: 0, now: 0 }),
		);
		expect(kept().thresholds).toBeUndefined();
		await confirm.getByTestId("guard-allow-confirm-no").click();
		await expect(confirm).toHaveCount(0);
		expect(kept().thresholds).toBeUndefined();
		await mine.getByTestId("bench-apply").click();
		await mine.getByTestId("guard-allow-confirm-yes").click();
		await expect.poll(() => (kept().thresholds as Record<string, string>).global_install).toBe("allow");
		// No other kind was suggested to be Allow: the ones a harmful case carries are not offered.
		await expect(suggestions).not.toContainText(
			fill(en.sugThreshold, { category: en.catName_delete_outside, to: en.thAllow }),
		);
		await expect(suggestions).not.toContainText(
			fill(en.sugThreshold, { category: en.catName_write_outside, to: en.thAllow }),
		);
	});
});

// ------------------------------------------------------------------ the remote page

test("on a page that came through the tunnel the Guard page says so and asks for nothing", async ({ page }) => {
	const asked: string[] = [];
	page.on("request", (r) => {
		if (new URL(r.url()).pathname.startsWith("/api/guard")) asked.push(r.url());
	});
	await page.route("**/api/meta", async (route) => {
		const real = await (await route.fetch()).json();
		return route.fulfill({ json: { ...real, remote: true } });
	});
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	await page.goto(`${s.url}/?token=${s.accessToken}`);
	await page.evaluate(() => {
		location.hash = "#/guard";
	});
	await expect(page.getByTestId("guard-page-remote")).toContainText(en.pageRemoteTitle);
	await expect(page.getByTestId("guard-tab-decisions")).toHaveCount(0);
	expect(asked).toEqual([]);
});

// ------------------------------------------------------------------ the words, a phone, the themes

for (const [lang, words] of [
	["en", en],
	["zh-CN", zh],
] as const) {
	test(`${lang}: every tab is in the page's language, and passes axe in the light and the dark theme`, async ({
		page,
	}) => {
		for (const theme of ["light", "dark"] as const) {
			await page.addInitScript(
				([l, t]) => {
					localStorage.setItem("ompw.lang", l);
					localStorage.setItem("ompw.theme", t);
				},
				[lang, theme],
			);
			await openGuard(page, { lang, theme });
			await expect(page.getByRole("heading", { level: 1 })).toHaveText(words.pageTitle);
			await expect(page.getByTestId("guard-tab-decisions")).toHaveText(words.tabDecisions);
			await expect(page.getByTestId("guard-tab-policy")).toHaveText(words.tabPolicy);
			await expect(page.getByTestId("guard-tab-bench")).toHaveText(words.tabBench);
			await expect(rows(page).first()).toBeVisible();
			await rows(page).first().getByTestId("guard-log-call-toggle").click();
			expect((await readOptions(page.getByTestId("guard-filter-by"))).map((o) => o.text)).toContain(words.byClassifier);
			let found = await new AxeBuilder({ page }).include('[data-testid="guard-page"]').analyze();
			expect(found.violations.map((v) => `${theme} decisions ${v.id}: ${v.help}`)).toEqual([]);

			await page.getByTestId("guard-tab-policy").click();
			await expect(page.getByTestId("guard-policy-text")).toBeVisible();
			await expect(page.getByTestId("guard-policy-save")).toHaveText(words.polSave);
			await expect(page.getByTestId("guard-policy-restore")).toHaveText(words.polRestore);
			await expect(page.getByTestId("guard-threshold-delete_outside")).toContainText(words.catName_delete_outside);
			await expect(page.getByTestId("guard-threshold-delete_outside-block")).toBeAttached();
			found = await new AxeBuilder({ page }).include('[data-testid="guard-page"]').analyze();
			expect(found.violations.map((v) => `${theme} policy ${v.id}: ${v.help}`)).toEqual([]);

			// The question before an Allow, in the page's language and in this theme.
			await page.getByTestId("guard-threshold-write_outside-allow").locator("xpath=..").click();
			await expect(page.getByTestId("guard-allow-confirm")).toHaveAttribute("data-state", "tried");
			await expect(page.getByTestId("guard-allow-confirm-yes")).toHaveText(words.allowConfirmYes);
			await expect(page.getByTestId("guard-allow-confirm-no")).toHaveText(words.allowConfirmNo);
			found = await new AxeBuilder({ page }).include('[data-testid="guard-page"]').analyze();
			expect(found.violations.map((v) => `${theme} allow question ${v.id}: ${v.help}`)).toEqual([]);
			await page.getByTestId("guard-allow-confirm-no").click();
			await expect(page.getByTestId("guard-allow-confirm")).toHaveCount(0);

			await page.getByTestId("guard-tab-bench").click();
			await expect(page.getByTestId("bench-run")).toHaveText(words.benchRun);
			await page.getByTestId("bench-run").click();
			await expect(page.getByTestId("bench-status")).toHaveAttribute("data-state", "done", { timeout: 30_000 });
			await expect(page.locator('[data-testid="bench-case"][data-id="rm_folder"]')).toContainText(words.case_rm_folder);
			await expect(page.getByTestId("bench-summary-line")).toContainText(lang === "en" ? "Stopped" : "拦下");
			found = await new AxeBuilder({ page }).include('[data-testid="guard-page"]').analyze();
			expect(found.violations.map((v) => `${theme} bench ${v.id}: ${v.help}`)).toEqual([]);
			if (lang === "zh-CN") {
				const all = await page.getByTestId("guard-page").innerText();
				expect(all).not.toContain("会话");
				expect(all).not.toMatch(/Guard dangerous|Reviewer model/);
			}
		}
	});
}

test.describe("on a phone", () => {
	test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

	test("every tab fits the width, the list scrolls inside the page and the controls can be tapped", async ({
		page,
	}) => {
		await openGuard(page);
		const fits = async (what: string) => {
			const wide = await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
			);
			expect(wide, `${what}: sideways scroll`).toBeLessThanOrEqual(0);
			const inner = await page.getByTestId("guard-page").evaluate((el) => el.scrollWidth - el.clientWidth);
			expect(inner, `${what}: the page is wider than its box`).toBeLessThanOrEqual(0);
		};
		await expect(rows(page).first()).toBeVisible();
		await fits("decisions");
		// The list scrolls by itself: its own box, not the page, and it keeps its filters in sight.
		const box = (await list(page).boundingBox()) as { x: number; width: number; height: number };
		expect(box.x + box.width).toBeLessThanOrEqual(390);
		expect(box.height).toBeGreaterThan(150);
		await list(page).evaluate((el) => {
			el.scrollTop = 400;
		});
		await expect(page.getByTestId("guard-filter-text")).toBeInViewport();
		await page.getByTestId("guard-filter-text").fill("cmd-050");
		await expect(rows(page)).toHaveCount(1);
		const target = await page.getByTestId("guard-tab-policy").boundingBox();
		expect((target as { height: number }).height).toBeGreaterThanOrEqual(24);
		await page.getByTestId("guard-tab-policy").tap();
		await expect(page.getByTestId("guard-policy-text")).toBeVisible();
		await fits("policy");
		await page.getByTestId("guard-threshold-write_outside-allow").locator("xpath=..").tap();
		await expect(page.getByTestId("guard-allow-confirm")).toHaveAttribute("data-state", "tried");
		await fits("policy with the question");
		await expect(page.getByTestId("guard-allow-confirm-yes")).toBeInViewport();
		await page.getByTestId("guard-allow-confirm-no").tap();
		await expect(page.getByTestId("guard-allow-confirm")).toHaveCount(0);
		await page.getByTestId("guard-tab-bench").tap();
		await expect(page.getByTestId("bench-run")).toBeVisible();
		await fits("benchmark");
		await page.getByTestId("bench-run").tap();
		await expect(page.getByTestId("bench-status")).toHaveAttribute("data-state", "done", { timeout: 30_000 });
		await fits("benchmark after a run");
		const found = await new AxeBuilder({ page }).include('[data-testid="guard-page"]').analyze();
		expect(found.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
	});
});
