import AxeBuilder from "@axe-core/playwright";
import {
	type ExportRequest,
	type ExportStatus,
	type ImportStatus,
	MIGRATE_API,
	MIGRATE_DATA_CATEGORIES,
	MIGRATE_MIN_PASSWORD,
	type MigratePlan,
	type MigrateState,
	migrateHeldCategories,
} from "../../shared/migrate.ts";
import { en as errorsEn } from "../../web/src/i18n/errors.ts";
import { en } from "../../web/src/i18n/migrate.ts";
import { zh } from "../../web/src/i18n/zh-CN/migrate.ts";
import { estimateStrength } from "../../web/src/lib/password-strength.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * Settings › Move to another computer. The server's `/api/migrate/*` routes are answered by a small stand-in that keeps
 * the state the real ones keep (the round trip through two real servers is a test of its own), so that every state of the
 * card can be reached without writing an archive. The page's strings and requests are the real ones.
 */

const MB = 1024 * 1024;
const GB = 1024 * MB;

interface Call {
	method: string;
	path: string;
	body: unknown;
}

interface Fake {
	plan: MigratePlan;
	state: MigrateState;
	calls: Call[];
	/** What an apply is answered with, in turn; the last one stays. */
	applyAnswers: { status: number; json: unknown }[];
	/** What an unlock is answered with, in turn; the last one stays. */
	unlockAnswers: { status: number; json: unknown }[];
}

const PLAN: MigratePlan = {
	host: "jdoe-mac",
	home: "/Users/jdoe",
	ompVersion: "18.12.0",
	serverVersion: "1.0.0",
	categories: [
		{ id: "conversations", files: 412, bytes: Math.round(1.5 * GB) },
		{ id: "history", files: 3, bytes: 5 * MB },
		{ id: "memories", files: 9, bytes: 40 * 1024 },
		{ id: "settings", files: 6, bytes: 12 * 1024 },
		{ id: "customization", files: 31, bytes: 300 * 1024 },
		{ id: "plugins", files: 120, bytes: 18 * MB },
		{ id: "webui", files: 7, bytes: 1536 },
		{ id: "credentials", files: 4, bytes: 9000 },
	],
	totalFiles: 588,
	totalBytes: Math.round(1.5 * GB) + 23 * MB,
	leftOut: [
		{ path: "~/.omp/agent/cache/models.json", reason: "cache", bytes: 2048 },
		{ path: "~/.omp/agent/stats.db", reason: "rebuilt", bytes: 4 * MB },
		{ path: "~/.omp/agent/terminal-sessions", reason: "machine", bytes: 0 },
		{ path: "~/.omp/agent/auth.json", reason: "secret", bytes: 900 },
	],
	secretFiles: [{ path: "~/.omp/agent/mcp.json", values: 2, category: "settings" }],
	sessionDirs: ["/Users/jdoe/work/.sessions"],
	profiles: ["work"],
	busy: false,
};

const FILE = { name: "omp-webui-migration-jdoe-mac-2026-10-21.ompw", bytes: 5 * MB };

function exportStatus(over: Partial<ExportStatus>): ExportStatus {
	return {
		state: "running",
		credentials: false,
		wholeFile: false,
		categories: [...MIGRATE_DATA_CATEGORIES],
		progress: {
			phase: "copy",
			doneBytes: 50 * MB,
			totalBytes: 100 * MB,
			doneFiles: 10,
			totalFiles: 20,
			current: "~/.omp/agent/sessions/a.jsonl",
		},
		skipped: [],
		startedAt: Date.now(),
		...over,
	};
}

const PREVIEW_STATUS: ImportStatus = {
	state: "ready",
	name: FILE.name,
	received: FILE.bytes,
	size: FILE.bytes,
	progress: { phase: "verify", doneBytes: 0, totalBytes: 0, doneFiles: 0, totalFiles: 0, current: "" },
	startedAt: Date.now(),
	preview: {
		format: 1,
		source: {
			host: "old-mac",
			user: "jdoe",
			home: "/Users/jdoe",
			ompVersion: "18.12.0",
			serverVersion: "1.0.0",
			createdAt: "2026-10-20T08:00:00.000Z",
		},
		home: "/Users/me",
		categories: [
			{ id: "conversations", files: 10, bytes: 3 * MB, added: 6, same: 3, differs: 1 },
			{ id: "settings", files: 2, bytes: 4096, added: 0, same: 1, differs: 1 },
		],
		conversations: { total: 10, added: 6, same: 3, differs: 1 },
		credentials: true,
		held: [...MIGRATE_DATA_CATEGORIES, "credentials"],
		encryption: "logins",
		leftOut: [{ path: "~/.omp/agent/stats.db", reason: "rebuilt", bytes: 4 * MB }],
		skipped: [],
		warnings: [{ code: "homeDiffers", params: { from: "/Users/jdoe", to: "/Users/me" } }],
	},
};

/** An archive that is encrypted as a whole, uploaded and waiting for its password: nothing of it is known yet. */
const LOCKED_STATUS: ImportStatus = { ...PREVIEW_STATUS, state: "locked", preview: undefined };

/** What the same file shows once it is opened: it is encrypted as a whole, so its logins need no password of their own. */
const WHOLE_PREVIEW = {
	...(PREVIEW_STATUS.preview as NonNullable<ImportStatus["preview"]>),
	encryption: "whole",
} as const;

const DONE_STATUS: ImportStatus = {
	...PREVIEW_STATUS,
	state: "done",
	preview: undefined,
	summary: {
		mode: "merge",
		backup: "/Users/me/.omp-webui/migration-backups/20261021-101500",
		conversations: { added: 6, kept: 3, updated: 1, replaced: 0 },
		files: { added: 6, kept: 3, replaced: 0, merged: 1, skipped: 0 },
		rewrittenFolders: 7,
		missingFolders: ["/Users/me/work/old-project"],
		missingFolderCount: 3,
		oldMachine: [
			{ file: "~/.omp/agent/mcp.json", key: "servers.tools.command", value: "/Users/jdoe/bin/tool", why: "home" },
			{ file: "~/.omp/agent/mcp.json", key: "servers.other.command", value: "/opt/gone/tool", why: "missing" },
		],
		oldMachineCount: 2,
		credentials: { restored: true, providers: 2, files: 3 },
		notes: [
			{ code: "remoteOff", params: {} },
			{ code: "banksRenamed", params: { count: 4 } },
			{ code: "someFutureNote", params: {} } as never,
		],
	},
};

/** An import that stopped halfway: what it had written is in its backup. */
const FAILED_STATUS: ImportStatus = {
	...PREVIEW_STATUS,
	state: "failed",
	preview: undefined,
	error: { message: "The file is damaged or incomplete. Nothing was changed.", code: "migrateCorrupt" },
	backup: "/Users/me/.omp-webui/migration-backups/2026-10-21T10-15-00-000Z",
};

async function fakeMigrate(page: Page, over: Partial<MigrateState> = {}): Promise<Fake> {
	const fake: Fake = {
		plan: PLAN,
		state: { export: null, import: null, ...over },
		calls: [],
		applyAnswers: [{ status: 200, json: DONE_STATUS }],
		unlockAnswers: [{ status: 200, json: { ...PREVIEW_STATUS, preview: WHOLE_PREVIEW } }],
	};
	await page.route(/\/api\/migrate\//, async (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname;
		let body: unknown;
		try {
			body = req.method() === "POST" ? req.postDataJSON() : undefined;
		} catch {
			body = undefined;
		}
		fake.calls.push({ method: req.method(), path, body });
		if (req.method() === "GET" && path === MIGRATE_API.plan) return route.fulfill({ json: fake.plan });
		if (req.method() === "GET" && path === MIGRATE_API.state) return route.fulfill({ json: fake.state });
		if (req.method() === "GET" && path === MIGRATE_API.exportFile) {
			return route.fulfill({
				body: "archive",
				headers: {
					"content-disposition": `attachment; filename="${FILE.name}"`,
					"content-type": "application/octet-stream",
				},
			});
		}
		if (req.method() !== "POST") return route.fulfill({ status: 405, json: { error: "Method not allowed" } });
		if (path === MIGRATE_API.export) {
			fake.state = {
				...fake.state,
				export: exportStatus({
					state: "done",
					file: FILE,
					skipped: [{ path: "~/x/y.json", error: "EACCES" }],
					categories: migrateHeldCategories({
						credentials: (body as ExportRequest).credentials === true,
						categories: (body as ExportRequest).categories,
					}),
				}),
			};
			return route.fulfill({ json: fake.state.export });
		}
		if (path === MIGRATE_API.exportDiscard) {
			fake.state = { ...fake.state, export: null };
			return route.fulfill({ json: {} });
		}
		if (path === MIGRATE_API.importRestore) {
			fake.state = { ...fake.state, import: { ...(fake.state.import as ImportStatus), restored: true } };
			return route.fulfill({ json: fake.state.import });
		}
		if (path === MIGRATE_API.importDiscard) {
			fake.state = { ...fake.state, import: null };
			return route.fulfill({ json: {} });
		}
		if (path === MIGRATE_API.importUnlock) {
			const answer =
				fake.unlockAnswers.length > 1
					? (fake.unlockAnswers.shift() as Fake["applyAnswers"][number])
					: fake.unlockAnswers[0];
			if (answer.status === 200) fake.state = { ...fake.state, import: answer.json as ImportStatus };
			return route.fulfill({ status: answer.status, json: answer.json });
		}
		if (path === MIGRATE_API.importApply) {
			const answer =
				fake.applyAnswers.length > 1
					? (fake.applyAnswers.shift() as Fake["applyAnswers"][number])
					: fake.applyAnswers[0];
			if (answer.status === 200) fake.state = { ...fake.state, import: answer.json as ImportStatus };
			return route.fulfill({ status: answer.status, json: answer.json });
		}
		return route.fulfill({ status: 404, json: { error: "No such route" } });
	});
	return fake;
}

async function openSettings(page: Page, lang = "en", theme = "light") {
	await page.addInitScript(
		([l, m]) => {
			localStorage.setItem("ompw.lang", l);
			localStorage.setItem("ompw.theme", m);
		},
		[lang, theme],
	);
	await page.goto("/#/settings/app");
}

const card = (page: Page) => page.getByTestId("migrate-settings");
const calls = (fake: Fake, method: string, path: string) =>
	fake.calls.filter((c) => c.method === method && c.path === path);

test("the card shows what an export holds, with sizes, and the left-out list names a reason for each", async ({
	page,
}) => {
	const fake = await fakeMigrate(page);
	await openSettings(page);
	await expect(card(page).getByRole("heading", { name: en.title, level: 2 })).toBeVisible();
	await expect(card(page)).toContainText(en.notEncrypted);

	const conversations = page.getByTestId("migrate-cat-conversations");
	await expect(conversations).toContainText(en.catConversations);
	await expect(conversations).toContainText("412");
	await expect(conversations).toContainText("1.5 GB");
	await expect(page.getByTestId("migrate-cat-webui")).toContainText("1.5 KB");
	await expect(page.getByTestId("migrate-plan-totals")).toContainText("Files: 588");
	await expect(page.getByTestId("migrate-profiles")).toContainText("work");
	await expect(page.getByTestId("migrate-session-dirs")).toContainText("/Users/jdoe/work/.sessions");

	// Left out: closed until asked for, each item with a short reason and its size.
	const leftOut = page.getByTestId("migrate-left-out");
	await expect(leftOut).not.toHaveAttribute("open", "");
	await expect(leftOut.locator("summary")).toContainText("Not included (4)");
	await leftOut.locator("summary").click();
	const items = page.getByTestId("migrate-left-out-item");
	await expect(items).toHaveCount(4);
	await expect(items.nth(0)).toContainText("~/.omp/agent/cache/models.json");
	await expect(items.nth(0)).toContainText(en.reasonCache);
	await expect(items.nth(0)).toContainText("2 KB");
	await expect(items.nth(1)).toContainText(en.reasonRebuilt);
	await expect(items.nth(1)).toContainText("4 MB");
	await expect(items.nth(3)).toContainText(en.reasonSecret);

	// Logins off: the secret values that are left blank are said.
	await expect(page.getByTestId("migrate-secrets-blank")).toContainText("in ~/.omp/agent/mcp.json (values: 2)");

	// Logins on: those files go into the encrypted part, so they are no longer left out.
	await page.getByTestId("migrate-creds").click();
	await expect(leftOut.locator("summary")).toContainText("Not included (3)");
	await expect(items).toHaveCount(3);
	await expect(page.getByTestId("migrate-secret-files")).toContainText("~/.omp/agent/mcp.json");
	await expect(page.getByTestId("migrate-secrets-blank")).toHaveCount(0);

	expect(calls(fake, "GET", MIGRATE_API.plan)).not.toHaveLength(0);
});

test("logins are off by default; turning them on asks for a password twice, and Export waits until it is good", async ({
	page,
}) => {
	const fake = await fakeMigrate(page);
	await openSettings(page);
	const creds = page.getByTestId("migrate-creds");
	const exportButton = page.getByTestId("migrate-export");
	await expect(creds).toHaveAttribute("aria-checked", "false");
	await expect(page.getByTestId("migrate-password")).toHaveCount(0);
	await expect(exportButton).toBeEnabled();

	await creds.click();
	await expect(creds).toHaveAttribute("aria-checked", "true");
	const password = page.getByTestId("migrate-password");
	const confirm = page.getByTestId("migrate-password-confirm");
	await expect(password).toHaveAttribute("type", "password");
	await expect(password).toHaveAttribute("autocomplete", "new-password");
	await expect(confirm).toHaveAttribute("type", "password");
	await expect(password).toHaveAttribute("minlength", String(MIGRATE_MIN_PASSWORD));
	await expect(exportButton).toBeDisabled();

	// Too short.
	await password.fill("short");
	await expect(page.getByTestId("migrate-password-problem")).toContainText(
		`at least ${MIGRATE_MIN_PASSWORD} characters`,
	);
	await expect(exportButton).toBeDisabled();

	// Long enough, not repeated, then repeated differently.
	await password.fill("correct horse battery");
	await expect(page.getByTestId("migrate-password-problem")).toHaveCount(0);
	await expect(exportButton).toBeDisabled();
	await confirm.fill("correct horse");
	await expect(page.getByTestId("migrate-password-confirm-problem")).toContainText(en.passwordMismatch);
	await expect(exportButton).toBeDisabled();

	await confirm.fill("correct horse battery");
	await expect(page.getByTestId("migrate-password-confirm-problem")).toHaveCount(0);
	await expect(exportButton).toBeEnabled();

	// Off again: the passwords are not needed, and the fields go.
	await creds.click();
	await expect(password).toHaveCount(0);
	await expect(exportButton).toBeEnabled();

	// The request says what was chosen: with logins on, the password goes along.
	await creds.click();
	await password.fill("correct horse battery");
	await confirm.fill("correct horse battery");
	await exportButton.click();
	await expect(page.getByTestId("migrate-export-done")).toBeVisible();
	expect(calls(fake, "POST", MIGRATE_API.export)[0].body).toEqual({
		credentials: true,
		wholeFile: true,
		password: "correct horse battery",
		categories: [...MIGRATE_DATA_CATEGORIES],
	});
});

test("encrypting the whole file: off by default, it follows the logins until it is decided, and either one asks for the password", async ({
	page,
}) => {
	const fake = await fakeMigrate(page);
	await openSettings(page);
	const creds = page.getByTestId("migrate-creds");
	const whole = page.getByTestId("migrate-whole");
	const password = page.getByTestId("migrate-password");
	const confirm = page.getByTestId("migrate-password-confirm");
	const exportButton = page.getByTestId("migrate-export");
	await expect(whole).toHaveAttribute("aria-checked", "false");
	await expect(card(page)).toContainText(en.wholeHint);

	// Logins on: a password is being set anyway, so the whole file is encrypted with it (said, and the person's to undo).
	await creds.click();
	await expect(whole).toHaveAttribute("aria-checked", "true");
	await creds.click();
	await expect(whole).toHaveAttribute("aria-checked", "false");
	await expect(password).toHaveCount(0);

	// Whole file alone: no logins, but the password is asked.
	await whole.click();
	await expect(creds).toHaveAttribute("aria-checked", "false");
	await expect(password).toBeVisible();
	await expect(exportButton).toBeDisabled();
	await password.fill("correct horse battery");
	await confirm.fill("correct horse battery");
	await expect(exportButton).toBeEnabled();
	// The secret values left blank are still said: the logins are not in it.
	await expect(page.getByTestId("migrate-secrets-blank")).toBeVisible();
	await exportButton.click();
	await expect(page.getByTestId("migrate-export-done")).toBeVisible();
	expect(calls(fake, "POST", MIGRATE_API.export)[0].body).toEqual({
		credentials: false,
		wholeFile: true,
		password: "correct horse battery",
		categories: [...MIGRATE_DATA_CATEGORIES],
	});

	// A new export is a new form: the whole file is off again. Once the person decides (on, then off), the logins no longer
	// move it: logins on, whole file off is the logins-only archive of before.
	await page.getByTestId("migrate-export-finish").click();
	await expect(whole).toHaveAttribute("aria-checked", "false");
	await whole.click();
	await whole.click();
	await expect(whole).toHaveAttribute("aria-checked", "false");
	await creds.click();
	await expect(whole).toHaveAttribute("aria-checked", "false");
	await expect(password).toBeVisible();
	await password.fill("correct horse battery");
	await confirm.fill("correct horse battery");
	await exportButton.click();
	await expect(page.getByTestId("migrate-export-done")).toBeVisible();
	expect(calls(fake, "POST", MIGRATE_API.export)[1].body).toEqual({
		credentials: true,
		wholeFile: false,
		password: "correct horse battery",
		categories: [...MIGRATE_DATA_CATEGORIES],
	});
});

test("every kind of data is ticked at first, each with its size; what is unticked leaves the request, the total and the secret-value note", async ({
	page,
}) => {
	const fake = await fakeMigrate(page);
	await openSettings(page);
	await expect(page.getByTestId("migrate-pick-hint")).toContainText(en.pickHint);
	for (const id of MIGRATE_DATA_CATEGORIES) await expect(page.getByTestId(`migrate-pick-${id}`)).toBeChecked();
	await expect(page.getByTestId("migrate-cat-memories")).toContainText("40 KB");
	// The logins stay opt-in, with their own switch: the row says where it stands.
	await expect(page.getByTestId("migrate-pick-credentials")).toContainText(en.pickLoginsOff);
	await expect(page.getByTestId("migrate-creds")).toHaveAttribute("aria-checked", "false");
	await expect(page.getByTestId("migrate-plan-totals")).toContainText("Files: 588");
	await expect(page.getByTestId("migrate-session-dirs")).toBeVisible();
	await expect(page.getByTestId("migrate-secrets-blank")).toBeVisible();

	// Conversations out: the total drops by their files, and so do the folders that belong to them.
	await page.getByTestId("migrate-pick-conversations").uncheck();
	await expect(page.getByTestId("migrate-plan-totals")).toContainText("Files: 176");
	await expect(page.getByTestId("migrate-session-dirs")).toHaveCount(0);
	// Settings out: the secret values of its files are not in the file either, so nothing is said of them.
	await page.getByTestId("migrate-pick-settings").uncheck();
	await expect(page.getByTestId("migrate-plan-totals")).toContainText("Files: 170");
	await expect(page.getByTestId("migrate-secrets-blank")).toHaveCount(0);
	await page.getByTestId("migrate-pick-settings").check();
	await expect(page.getByTestId("migrate-secrets-blank")).toBeVisible();

	await page.getByTestId("migrate-export").click();
	await expect(page.getByTestId("migrate-export-done")).toBeVisible();
	expect(calls(fake, "POST", MIGRATE_API.export)[0].body).toEqual({
		credentials: false,
		wholeFile: false,
		categories: ["history", "memories", "settings", "customization", "plugins", "webui"],
	});
	// The finished export says what the file holds.
	const holds = page.getByTestId("migrate-export-holds");
	await expect(holds).toContainText(en.catHistory);
	await expect(holds).toContainText(en.catWebui);
	await expect(holds).not.toContainText(en.catConversations);
	await expect(holds).not.toContainText(en.catCredentials);

	// A new export is a new form: everything is ticked again.
	await page.getByTestId("migrate-export-finish").click();
	for (const id of MIGRATE_DATA_CATEGORIES) await expect(page.getByTestId(`migrate-pick-${id}`)).toBeChecked();
});

test("with nothing ticked Export waits and says why; the logins alone are enough", async ({ page }) => {
	const fake = await fakeMigrate(page);
	await openSettings(page);
	const exportButton = page.getByTestId("migrate-export");
	for (const id of MIGRATE_DATA_CATEGORIES) await page.getByTestId(`migrate-pick-${id}`).uncheck();
	await expect(exportButton).toBeDisabled();
	await expect(page.getByTestId("migrate-pick-nothing")).toContainText(en.pickNothing);
	await page.getByTestId("migrate-pick-memories").check();
	await expect(exportButton).toBeEnabled();
	await expect(page.getByTestId("migrate-pick-nothing")).toHaveCount(0);
	await page.getByTestId("migrate-pick-memories").uncheck();
	await expect(exportButton).toBeDisabled();

	await page.getByTestId("migrate-creds").click();
	await expect(page.getByTestId("migrate-pick-credentials")).toContainText(en.pickLoginsOn);
	await expect(page.getByTestId("migrate-pick-nothing")).toHaveCount(0);
	await page.getByTestId("migrate-password").fill("correct horse battery");
	await page.getByTestId("migrate-password-confirm").fill("correct horse battery");
	await expect(exportButton).toBeEnabled();
	await exportButton.click();
	await expect(page.getByTestId("migrate-export-done")).toBeVisible();
	expect(calls(fake, "POST", MIGRATE_API.export)[0].body).toEqual({
		credentials: true,
		wholeFile: true,
		password: "correct horse battery",
		categories: [],
	});
	await expect(page.getByTestId("migrate-export-holds")).toContainText(en.catCredentials);
	await expect(page.getByTestId("migrate-export-holds")).not.toContainText(en.catMemories);
});

test("an export that was encrypted as a whole says the password is needed to import it", async ({ page }) => {
	// An export that is done (the page found it when it opened): what its status says is what the page shows.
	await fakeMigrate(page, { export: exportStatus({ state: "done", file: FILE, wholeFile: true }) });
	await openSettings(page);
	await expect(page.getByTestId("migrate-export-encrypted")).toContainText(en.exportDoneEncrypted);
});

test("an export that was not encrypted as a whole does not say so", async ({ page }) => {
	await fakeMigrate(page, { export: exportStatus({ state: "done", file: FILE }) });
	await openSettings(page);
	await expect(page.getByTestId("migrate-export-done")).toBeVisible();
	await expect(page.getByTestId("migrate-export-encrypted")).toHaveCount(0);
});

test("the password's strength is shown as it is typed: a word and a meter, what makes it weak, a passphrase to use, and announced politely", async ({
	page,
}) => {
	await fakeMigrate(page);
	await openSettings(page);
	await page.getByTestId("migrate-whole").click();
	const password = page.getByTestId("migrate-password");
	const hint = page.getByTestId("migrate-strength");
	// Nothing before anything is typed.
	await expect(hint).toHaveCount(0);

	await password.fill("password1");
	await expect(hint).toBeVisible();
	await expect(hint).toHaveAttribute("data-score", "0");
	await expect(page.getByTestId("migrate-strength-label")).toContainText("Password strength: very weak");
	await expect(page.getByTestId("migrate-strength-reasons")).toContainText(en.reasonCommon);
	// The hint is what describes the field to a screen reader, and the live region is polite and not read per key.
	const described = await password.getAttribute("aria-describedby");
	expect(described).toContain((await hint.getAttribute("id")) as string);
	await expect(page.getByTestId("migrate-strength-spoken")).toHaveAttribute("aria-live", "polite");
	await expect(page.getByTestId("migrate-strength-spoken")).toContainText("very weak", { timeout: 5000 });

	// The floor of eight characters is still the floor: the message for it is there beside the hint.
	await password.fill("abc");
	await expect(page.getByTestId("migrate-password-problem")).toContainText(
		`at least ${MIGRATE_MIN_PASSWORD} characters`,
	);
	await expect(page.getByTestId("migrate-strength-reasons")).toContainText(en.reasonShort);

	// A weak one gets a passphrase to use instead; using it fills both fields.
	await password.fill("qwerty123456");
	await expect(page.getByTestId("migrate-strength-reasons")).toContainText(en.reasonKeyboard);
	const suggestion = page.getByTestId("migrate-strength-suggest").locator("code");
	const phrase = (await suggestion.textContent()) as string;
	expect(phrase.split("-").length).toBeGreaterThanOrEqual(4);
	await page.getByTestId("migrate-strength-use").click();
	await expect(password).toHaveValue(phrase);
	await expect(page.getByTestId("migrate-password-confirm")).toHaveValue(phrase);
	await expect(hint).toHaveAttribute("data-score", "4");
	await expect(page.getByTestId("migrate-strength-label")).toContainText("very strong");
	// A strong one has no complaint and no suggestion.
	await expect(page.getByTestId("migrate-strength-suggest")).toHaveCount(0);
	await expect(page.getByTestId("migrate-export")).toBeEnabled();

	// The hint is on the password that is chosen, not on the one that confirms it.
	await expect(
		page.getByTestId("migrate-password-confirm").locator("xpath=..").getByTestId("migrate-strength"),
	).toHaveCount(0);
});

test("a strong password can be made: random, shown in clear with the plain warning, copied, and typing over it hides it again", async ({
	page,
	context,
}) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	const fake = await fakeMigrate(page);
	await openSettings(page);
	await page.getByTestId("migrate-whole").click();
	const password = page.getByTestId("migrate-password");
	await expect(password).toHaveAttribute("type", "password");
	await expect(page.getByTestId("migrate-password-made")).toHaveCount(0);

	await page.getByTestId("migrate-generate").click();
	await expect(password).toHaveAttribute("type", "text");
	const made = await password.inputValue();
	expect(made).toHaveLength(24);
	expect(made).not.toMatch(/[0OolI1|`'" ]/u);
	await expect(page.getByTestId("migrate-password-confirm")).toHaveValue(made);
	// The warning is plain: the file cannot be opened without it, and it is kept nowhere.
	await expect(page.getByTestId("migrate-password-made")).toContainText(en.madeNote);
	await expect(page.getByTestId("migrate-strength")).toHaveAttribute("data-score", "4");
	await expect(page.getByTestId("migrate-strength-suggest")).toHaveCount(0);
	await expect(page.getByTestId("migrate-export")).toBeEnabled();

	await page.getByTestId("migrate-password-copy").click();
	await expect(page.getByTestId("migrate-password-copy")).toContainText(en.copied);
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(made);

	// Another click makes another one.
	await page.getByTestId("migrate-generate").click();
	expect(await password.inputValue()).not.toBe(made);

	// Typing is the person's own again: hidden, no warning, and the confirmation no longer matches until it is typed.
	await password.fill("my own password");
	await expect(password).toHaveAttribute("type", "password");
	await expect(page.getByTestId("migrate-password-made")).toHaveCount(0);
	await expect(page.getByTestId("migrate-password-confirm-problem")).toBeVisible();
	expect(calls(fake, "POST", MIGRATE_API.export)).toHaveLength(0);
});

test("a file that is encrypted as a whole asks for its password before anything of it is shown, and a wrong one keeps it locked", async ({
	page,
}) => {
	const fake = await fakeMigrate(page, { import: LOCKED_STATUS });
	fake.unlockAnswers = [
		{ status: 400, json: { error: "Wrong password", code: "migrateFilePasswordWrong" } },
		{ status: 200, json: { ...PREVIEW_STATUS, preview: WHOLE_PREVIEW } },
	];
	await openSettings(page);
	const locked = page.getByTestId("migrate-locked");
	await expect(locked).toBeVisible();
	await expect(locked).toContainText(en.unlockTitle);
	await expect(locked).toContainText(en.unlockHint);
	await expect(page.getByTestId("migrate-preview")).toHaveCount(0);
	const field = page.getByTestId("migrate-unlock-password");
	await expect(field).toHaveAttribute("type", "password");
	await expect(field).toHaveAttribute("autocomplete", "off");
	// No strength hint where the password is only typed to open a file.
	await expect(page.getByTestId("migrate-strength")).toHaveCount(0);
	await expect(page.getByTestId("migrate-unlock")).toBeDisabled();

	await field.fill("not the password");
	await page.getByTestId("migrate-unlock").click();
	await expect(page.getByTestId("migrate-import-error")).toContainText(errorsEn.migrateFilePasswordWrong);
	await expect(locked).toBeVisible();
	await expect(field).toHaveValue("not the password");
	expect(calls(fake, "POST", MIGRATE_API.importUnlock)[0].body).toEqual({ password: "not the password" });

	await field.fill("correct horse battery");
	await page.getByTestId("migrate-unlock").click();
	await expect(page.getByTestId("migrate-preview")).toBeVisible();
	await expect(locked).toHaveCount(0);
	// Opened with the file's password, the logins need no second one: no field, a sentence, and the request has none.
	await expect(page.getByTestId("migrate-import-password")).toHaveCount(0);
	await expect(page.getByTestId("migrate-whole-note")).toContainText(en.encWhole);
	await expect(page.getByTestId("migrate-import")).toBeEnabled();
	await page.getByTestId("migrate-import").click();
	await expect(page.getByTestId("migrate-summary")).toBeVisible();
	expect(calls(fake, "POST", MIGRATE_API.importApply)[0].body).toEqual({ mode: "merge", credentials: true });
});

test("a locked file can be dropped for another one", async ({ page }) => {
	const fake = await fakeMigrate(page, { import: LOCKED_STATUS });
	await openSettings(page);
	await page.getByTestId("migrate-discard").click();
	await expect(page.getByTestId("migrate-locked")).toHaveCount(0);
	await expect(page.getByTestId("migrate-file")).toBeAttached();
	expect(calls(fake, "POST", MIGRATE_API.importDiscard)).toHaveLength(1);
});

test("a file that was changed on the way fails when it is opened, with the sentence for it and the way out", async ({
	page,
}) => {
	const fake = await fakeMigrate(page, { import: LOCKED_STATUS });
	fake.unlockAnswers = [
		{
			status: 200,
			json: {
				...LOCKED_STATUS,
				state: "failed",
				error: { message: "changed", code: "migrateTampered" },
			},
		},
	];
	await openSettings(page);
	await page.getByTestId("migrate-unlock-password").fill("correct horse battery");
	await page.getByTestId("migrate-unlock").click();
	await expect(page.getByTestId("migrate-import-failed")).toContainText(errorsEn.migrateTampered);
	await expect(page.getByTestId("migrate-import-retry")).toBeVisible();
	await expect(page.getByTestId("migrate-restore-backup")).toHaveCount(0);
});

test("an export that is done offers the file as a real download link, and Done discards the temporary archive", async ({
	page,
}) => {
	const fake = await fakeMigrate(page);
	await openSettings(page);
	await page.getByTestId("migrate-export").click();
	const done = page.getByTestId("migrate-export-done");
	await expect(done).toContainText(FILE.name);
	await expect(done).toContainText("5 MB");
	await expect(done).toContainText(en.skippedTitle.replace("{count}", "1"));
	expect(calls(fake, "POST", MIGRATE_API.export)[0].body).toEqual({
		credentials: false,
		wholeFile: false,
		categories: [...MIGRATE_DATA_CATEGORIES],
	});

	// A plain link the browser (or the macOS shell's download sheet) follows: not a fetch and a blob.
	const link = page.getByTestId("migrate-download");
	await expect(link).toHaveAttribute("href", MIGRATE_API.exportFile);
	await expect(link).toHaveAttribute("download", FILE.name);

	await page.getByTestId("migrate-export-finish").click();
	await expect(done).toHaveCount(0);
	await expect(page.getByTestId("migrate-export")).toBeVisible();
	expect(calls(fake, "POST", MIGRATE_API.exportDiscard)).toHaveLength(1);
});

test("while nothing runs the card asks for no state; while an export runs it does, and it stops when it ends", async ({
	page,
}) => {
	const fake = await fakeMigrate(page);
	const stateCalls = () => calls(fake, "GET", MIGRATE_API.state).length;
	await openSettings(page);
	await expect(page.getByTestId("migrate-plan")).toBeVisible();
	// The look at what is under way when the card opens.
	await expect.poll(stateCalls).toBeGreaterThan(0);
	const idle = stateCalls();
	await page.waitForTimeout(1500);
	expect(stateCalls()).toBe(idle);

	// An export that is running is followed.
	fake.state = { ...fake.state, export: exportStatus({}) };
	await page.reload();
	const bar = page.getByRole("progressbar", { name: en.exportProgress });
	await expect(bar).toBeVisible();
	await expect(bar).toHaveAttribute("aria-valuenow", "50");
	await expect(page.getByTestId("migrate-progress-text")).toContainText("50%");
	await expect(page.getByTestId("migrate-cancel")).toBeVisible();
	await expect.poll(stateCalls).toBeGreaterThan(idle + 1);

	// It ends: the card shows the file and stops asking.
	fake.state = { ...fake.state, export: exportStatus({ state: "done", file: FILE }) };
	await expect(page.getByTestId("migrate-export-done")).toBeVisible({ timeout: 5000 });
	const settled = stateCalls();
	await page.waitForTimeout(1500);
	expect(stateCalls()).toBe(settled);
});

test("an archive that has been checked is shown before anything is written; a wrong password keeps the preview", async ({
	page,
}) => {
	const fake = await fakeMigrate(page, { import: PREVIEW_STATUS });
	fake.applyAnswers = [
		{ status: 400, json: { error: "Wrong password", code: "migratePasswordWrong" } },
		{ status: 200, json: DONE_STATUS },
	];
	await openSettings(page);
	const preview = page.getByTestId("migrate-preview");
	await expect(preview).toBeVisible();
	const source = page.getByTestId("migrate-source");
	await expect(source).toContainText("old-mac");
	await expect(source).toContainText("jdoe");
	await expect(source).toContainText("/Users/jdoe");
	await expect(page.getByTestId("migrate-warnings")).toContainText("/Users/me");
	await expect(page.getByTestId("migrate-preview").getByTestId("migrate-cat-conversations")).toContainText("3 MB");
	await expect(page.getByTestId("migrate-conversations-line")).toContainText(
		"10 in all, 6 new here, 3 already here, 1 different",
	);
	await expect(preview.getByTestId("migrate-left-out")).toContainText("Not included (1)");

	// Merge is chosen at first, and the logins are restored with the password they were encrypted with.
	await expect(page.getByTestId("migrate-mode-merge")).toBeChecked();
	await expect(page.getByTestId("migrate-restore")).toBeChecked();
	await expect(page.getByTestId("migrate-import")).toBeDisabled();
	await page.getByTestId("migrate-mode-replace").check();
	await page.getByTestId("migrate-import-password").fill("not the password");
	await page.getByTestId("migrate-import").click();

	// Refused: the sentence is shown, and the preview, the mode and the field are as they were.
	await expect(page.getByTestId("migrate-import-error")).toContainText(errorsEn.migratePasswordWrong);
	await expect(preview).toBeVisible();
	await expect(page.getByTestId("migrate-mode-replace")).toBeChecked();
	await expect(page.getByTestId("migrate-import-password")).toHaveValue("not the password");
	expect(calls(fake, "POST", MIGRATE_API.importApply)[0].body).toEqual({
		mode: "replace",
		credentials: true,
		password: "not the password",
	});

	await page.getByTestId("migrate-import").click();
	const summary = page.getByTestId("migrate-summary");
	await expect(summary).toBeVisible();
	await expect(page.getByTestId("migrate-backup")).toHaveText("/Users/me/.omp-webui/migration-backups/20261021-101500");
	await expect(page.getByTestId("migrate-summary-conversations")).toContainText(
		"6 added, 3 kept, 1 updated, 0 replaced",
	);
	await expect(page.getByTestId("migrate-missing-folders")).toContainText("/Users/me/work/old-project");
	await expect(page.getByTestId("migrate-missing-folders")).toContainText("2 more");
	await expect(page.getByTestId("migrate-old-machine")).toContainText("~/.omp/agent/mcp.json");
	await expect(page.getByTestId("migrate-old-machine")).toContainText(en.whyHome);
	await expect(page.getByTestId("migrate-old-machine")).toContainText(en.whyMissing);
	await expect(page.getByTestId("migrate-summary-credentials")).toContainText("providers: 2, files: 3");
	// Notes by code; a code this page does not know is shown as it is.
	const notes = page.getByTestId("migrate-notes");
	await expect(notes).toContainText("Remote access settings came with the file and are switched off");
	await expect(notes).toContainText("Memory banks renamed for the folders' new paths: 4");
	await expect(notes).toContainText("someFutureNote");

	await page.getByTestId("migrate-close").click();
	await expect(summary).toHaveCount(0);
	await expect(page.getByTestId("migrate-file")).toBeAttached();
	expect(calls(fake, "POST", MIGRATE_API.importDiscard)).toHaveLength(1);
});

test("a whole file shows no note about what it holds", async ({ page }) => {
	await fakeMigrate(page, { import: PREVIEW_STATUS });
	await openSettings(page);
	await expect(page.getByTestId("migrate-preview")).toBeVisible();
	await expect(page.getByTestId("migrate-held-note")).toHaveCount(0);
});

test("a file that holds only some kinds of data says so", async ({ page }) => {
	const whole = PREVIEW_STATUS.preview as NonNullable<ImportStatus["preview"]>;
	await fakeMigrate(page, {
		import: { ...PREVIEW_STATUS, preview: { ...whole, credentials: false, held: ["conversations", "settings"] } },
	});
	await openSettings(page);
	const note = page.getByTestId("migrate-held-note");
	await expect(note).toContainText(en.catConversations);
	await expect(note).toContainText(en.catSettings);
	await expect(note).not.toContainText(en.catMemories);
	await expect(note).toContainText("left exactly as it is");
	const table = page.getByTestId("migrate-preview");
	await expect(table.getByTestId("migrate-cat-conversations")).toBeVisible();
	await expect(table.getByTestId("migrate-cat-memories")).toHaveCount(0);
});

test("the file picker takes .ompw files and can be reached from the keyboard", async ({ page }) => {
	await fakeMigrate(page);
	await openSettings(page);
	const input = page.getByTestId("migrate-file");
	await expect(input).toHaveAttribute("type", "file");
	await expect(input).toHaveAttribute("accept", ".ompw");
	await input.focus();
	await expect(input).toBeFocused();
});

test("Chinese: the card, the errors and the strings under them are the Chinese pack's", async ({ page }) => {
	await fakeMigrate(page);
	await openSettings(page, "zh-CN");
	await expect(card(page).getByRole("heading", { name: zh.title, level: 2 })).toBeVisible();
	await expect(card(page)).toContainText(zh.intro);
	await expect(card(page)).toContainText(zh.notEncrypted);
	await expect(page.getByTestId("migrate-cat-conversations")).toContainText(zh.catConversations);
	await expect(page.getByTestId("migrate-left-out")).toContainText("不包含（4）");
	await expect(card(page)).toContainText(zh.credSwitch);
	await expect(card(page)).toContainText(zh.chooseFile);
	await expect(card(page)).toContainText(zh.wholeSwitch);
	await expect(card(page)).toContainText(zh.wholeHint);
	await expect(card(page)).toContainText(zh.pickHint);
	await expect(page.getByTestId("migrate-pick-credentials")).toContainText(zh.pickLoginsOff);
});

for (const lang of ["en", "zh-CN"]) {
	for (const theme of ["light", "dark"]) {
		test(`the card is readable in ${lang} ${theme}, and its picture is kept`, async ({ page }, testInfo) => {
			await page.setViewportSize({ width: 1400, height: 2200 });
			await fakeMigrate(page);
			await openSettings(page, lang, theme);
			await expect(page.getByTestId("migrate-plan")).toBeVisible();
			await page.getByTestId("migrate-left-out").evaluate((el) => el.setAttribute("open", ""));
			await page.getByTestId("migrate-creds").click();
			await page.getByTestId("migrate-password").fill("short");
			await expect(page.getByTestId("migrate-strength")).toBeVisible();
			await card(page).scrollIntoViewIfNeeded();
			const { violations } = await new AxeBuilder({ page })
				.include('[data-testid="migrate-settings"]')
				.withRules([
					"color-contrast",
					"label",
					"aria-allowed-attr",
					"aria-valid-attr-value",
					"aria-progressbar-name",
					"scrollable-region-focusable",
					"nested-interactive",
					"td-headers-attr",
					"th-has-data-cells",
				])
				.analyze();
			expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
			const png = await card(page).screenshot({ animations: "disabled" });
			await testInfo.attach(`migrate-${lang}-${theme}`, { body: png, contentType: "image/png" });
		});
	}
}

for (const lang of ["en", "zh-CN"]) {
	for (const theme of ["light", "dark"]) {
		test(`the password's hint, a made password and the unlock form are readable in ${lang} ${theme}`, async ({
			page,
			context,
		}) => {
			await context.grantPermissions(["clipboard-read", "clipboard-write"]);
			await page.setViewportSize({ width: 1400, height: 2600 });
			const fake = await fakeMigrate(page);
			await openSettings(page, lang, theme);
			await expect(page.getByTestId("migrate-plan")).toBeVisible();
			const check = async () => {
				const { violations } = await new AxeBuilder({ page })
					.include('[data-testid="migrate-settings"]')
					.withRules(["color-contrast", "label", "aria-allowed-attr", "aria-valid-attr-value", "nested-interactive"])
					.analyze();
				expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
			};
			await page.getByTestId("migrate-whole").click();
			// One of each colour (red, amber, green): what the page shows is what the library says, whatever its tuning.
			const pack = lang === "en" ? en : zh;
			const typed = ["password1", "Summer2023!", "blue-table-river"];
			const tone = (p: string) => {
				const { score } = estimateStrength(p);
				return score <= 1 ? "red" : score === 2 ? "amber" : "green";
			};
			expect(typed.map(tone)).toEqual(["red", "amber", "green"]);
			for (const text of typed) {
				const score = estimateStrength(text).score;
				await page.getByTestId("migrate-password").fill(text);
				await expect(page.getByTestId("migrate-strength")).toBeVisible();
				await expect(page.getByTestId("migrate-strength-label")).toContainText(
					pack.strengthLabel.replace("{level}", pack[`strength${score}` as keyof typeof pack]),
				);
				await check();
			}
			await page.getByTestId("migrate-generate").click();
			await expect(page.getByTestId("migrate-password-made")).toContainText(pack.madeNote);
			await check();
			await expect(card(page)).not.toContainText("会话");

			// The unlock form, with a refusal showing.
			fake.state = { ...fake.state, import: LOCKED_STATUS };
			fake.unlockAnswers = [{ status: 400, json: { error: "x", code: "migrateFilePasswordWrong" } }];
			await page.reload();
			await expect(page.getByTestId("migrate-locked")).toContainText(pack.unlockTitle);
			await page.getByTestId("migrate-unlock-password").fill("not the password");
			await page.getByTestId("migrate-unlock").click();
			await expect(page.getByTestId("migrate-import-error")).toBeVisible();
			await check();
		});
	}
}

for (const lang of ["en", "zh-CN"]) {
	test(`the preview and the summary are readable in ${lang} dark`, async ({ page }) => {
		await page.setViewportSize({ width: 1400, height: 2600 });
		await fakeMigrate(page, { import: PREVIEW_STATUS });
		await openSettings(page, lang, "dark");
		await expect(page.getByTestId("migrate-preview")).toBeVisible();
		const check = async () => {
			const { violations } = await new AxeBuilder({ page })
				.include('[data-testid="migrate-settings"]')
				.withRules([
					"color-contrast",
					"label",
					"aria-allowed-attr",
					"scrollable-region-focusable",
					"aria-valid-attr-value",
				])
				.analyze();
			expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
		};
		await check();
		await page.getByTestId("migrate-import-password").fill("a password");
		await page.getByTestId("migrate-import").click();
		await expect(page.getByTestId("migrate-summary")).toBeVisible();
		await check();
	});
}

test("an import that failed halfway names its backup, and Restore puts back what it changed", async ({ page }) => {
	const fake = await fakeMigrate(page, { import: FAILED_STATUS });
	await openSettings(page);
	const failed = page.getByTestId("migrate-import-failed");
	await expect(failed).toBeVisible();
	await expect(failed).toContainText(errorsEn.migrateCorrupt);
	await expect(page.getByTestId("migrate-failed-backup")).toContainText(
		"/Users/me/.omp-webui/migration-backups/2026-10-21T10-15-00-000Z",
	);
	await expect(page.getByTestId("migrate-failed-backup")).toContainText(en.importFailedBackup);
	expect(calls(fake, "POST", MIGRATE_API.importRestore)).toHaveLength(0);
	await page.getByTestId("migrate-restore-backup").click();
	await expect(page.getByTestId("migrate-restored")).toHaveText(en.restored);
	await expect(page.getByTestId("migrate-restore-backup")).toHaveCount(0);
	expect(calls(fake, "POST", MIGRATE_API.importRestore)).toHaveLength(1);
	// What it offers instead is to choose the file again.
	await expect(page.getByTestId("migrate-import-retry")).toBeVisible();
});

test("an import that failed before it wrote anything offers no Restore", async ({ page }) => {
	await fakeMigrate(page, { import: { ...FAILED_STATUS, backup: null } });
	await openSettings(page);
	await expect(page.getByTestId("migrate-import-failed")).toBeVisible();
	await expect(page.getByTestId("migrate-failed-backup")).toHaveCount(0);
	await expect(page.getByTestId("migrate-restore-backup")).toHaveCount(0);
});

for (const [lang, text] of [
	[
		"en",
		"There is not enough free room on this Mac: the file needs about 3 GB and 120 MB is free. Free some space before importing.",
	],
	["zh-CN", "这台 Mac 的可用空间不够：文件大约需要 3 GB，目前可用 120 MB。请先腾出空间再导入。"],
] as const) {
	test(`a file that would not fit says how much it needs and how much is free (${lang})`, async ({ page }) => {
		const preview = PREVIEW_STATUS.preview as NonNullable<ImportStatus["preview"]>;
		await fakeMigrate(page, {
			import: {
				...PREVIEW_STATUS,
				preview: { ...preview, warnings: [{ code: "diskLow", params: { need: 3 * GB, free: 120 * MB } }] },
			},
		});
		await openSettings(page, lang);
		await expect(page.getByTestId("migrate-warnings")).toContainText(text);
	});
}
