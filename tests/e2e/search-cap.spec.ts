import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_BUCKET } from "../support/fixtures.ts";
import { appReady } from "../support/live.ts";
import { expect, type Page, test } from "./fixtures.ts";

/** Palette search: hits are capped per conversation, "N more" expands one inline, archived hits are tagged (no model call). */

let agentDir: string;
test.beforeAll(() => {
	agentDir = process.env.OMPW_E2E_AGENT_DIR as string;
});
const WORD = "kumquat";
const ARCHIVED_WORD = "persimmon";

/** A conversation of one user message per entry of `texts`; `n` (0xe8–0xef) makes the file and its entry ids unique. */
function writeConversation(n: number, texts: string[]): string {
	const hex = n.toString(16);
	const id = `01a00000-0000-7000-8000-0000000088${hex}`;
	const dir = join(agentDir, "sessions", FIXTURE_BUCKET);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `2026-01-08T00-${hex}-00-000Z_${id}.jsonl`);
	const stamp = new Date(Date.UTC(2026, 0, 8, 0, n)).toISOString();
	const lines: unknown[] = [{ type: "session", version: 3, id, timestamp: stamp, cwd: "/tmp/ompw-fixture-project" }];
	texts.forEach((text, i) => {
		lines.push({
			type: "message",
			id: `c${hex}${String(i).padStart(4, "0")}`,
			parentId: i ? `c${hex}${String(i - 1).padStart(4, "0")}` : null,
			timestamp: stamp,
			message: { role: "user", content: [{ type: "text", text }] },
		});
	});
	writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	const at = Date.now() / 1000 + n;
	utimesSync(file, at, at);
	return file;
}

async function openPalette(page: Page, query: string) {
	await page.goto("/");
	await appReady(page);
	await page.keyboard.press("ControlOrMeta+k");
	await page.getByTestId("palette-input").fill(query);
}

test("a busy conversation shows 3 hits and '9 more', which expands inline; a quiet one still appears", async ({
	page,
}) => {
	const busy = writeConversation(
		0xe8,
		Array.from({ length: 12 }, (_, i) => `${WORD} busy message number ${i}`),
	);
	const quiet = writeConversation(0xe9, [`The ${WORD} in the quiet conversation`]);
	try {
		await openPalette(page, WORD);
		const hits = page.getByTestId("search-hit");
		await expect(hits.filter({ hasText: "the quiet conversation" })).toHaveCount(1, { timeout: 15_000 });
		await expect(hits.filter({ hasText: "busy message" })).toHaveCount(3);
		const more = page.getByTestId("search-more");
		await expect(more).toHaveCount(1);
		await expect(more).toHaveText("9 more in this conversation");

		await more.click();
		await expect(hits.filter({ hasText: "busy message" })).toHaveCount(12);
		await expect(more).toHaveCount(0);
		await expect(hits.filter({ hasText: "the quiet conversation" })).toHaveCount(1);
		// Expanding does not close the palette.
		await expect(page.getByTestId("palette-input")).toBeVisible();

		// A new query starts over with capped hits.
		await page.getByTestId("palette-input").fill(`${WORD} busy`);
		await expect(hits).toHaveCount(3);
		await expect(more).toHaveText("9 more in this conversation");
	} finally {
		rmSync(busy, { force: true });
		rmSync(quiet, { force: true });
	}
});

test("the 'more' row is reachable and selectable from the keyboard", async ({ page }) => {
	const busy = writeConversation(
		0xea,
		Array.from({ length: 5 }, (_, i) => `${WORD} keyboard message ${i}`),
	);
	try {
		await openPalette(page, WORD);
		const hits = page.getByTestId("search-hit");
		await expect(hits.filter({ hasText: "keyboard message" })).toHaveCount(3, { timeout: 15_000 });
		await expect(page.getByTestId("search-more")).toHaveText("2 more in this conversation");
		const more = page.getByTestId("search-more");
		// The row is the one item after the third hit: step down until it is highlighted.
		for (let i = 0; i < 20 && (await more.getAttribute("data-selected")) !== "true"; i++) {
			await page.keyboard.press("ArrowDown");
		}
		await expect(more).toHaveAttribute("data-selected", "true");
		await page.keyboard.press("Enter");
		await expect(hits.filter({ hasText: "keyboard message" })).toHaveCount(5);
		await expect(more).toHaveCount(0);
	} finally {
		rmSync(busy, { force: true });
	}
});

test("hits and title matches of an archived conversation carry an Archived tag; others do not", async ({ page }) => {
	const archived = writeConversation(0xeb, [`${ARCHIVED_WORD} in an archived conversation`]);
	const active = writeConversation(0xec, [`${ARCHIVED_WORD} in a live conversation`]);
	try {
		const res = await page.request.post("/api/archive", {
			data: { files: [archived], archived: true },
			headers: { "x-omp-webui": "1" },
		});
		expect(res.ok()).toBe(true);
		// The store reads the archived list on load.
		await openPalette(page, ARCHIVED_WORD);
		const hits = page.getByTestId("search-hit");
		const archivedHit = hits.filter({ hasText: "in an archived conversation" });
		const liveHit = hits.filter({ hasText: "in a live conversation" });
		await expect(archivedHit).toHaveCount(1, { timeout: 15_000 });
		await expect(liveHit).toHaveCount(1);
		await expect(archivedHit.getByTestId("palette-archived")).toHaveText("Archived");
		await expect(liveHit.getByTestId("palette-archived")).toHaveCount(0);
		// Every row of the archived conversation (its title match too, when the list has one) is tagged.
		const rows = page.getByRole("option").filter({ hasText: "in an archived conversation" });
		const count = await rows.count();
		expect(count).toBeGreaterThan(0);
		await expect(rows.getByTestId("palette-archived")).toHaveCount(count);
	} finally {
		await page.request.post("/api/archive", {
			data: { files: [archived], archived: false },
			headers: { "x-omp-webui": "1" },
		});
		rmSync(archived, { force: true });
		rmSync(active, { force: true });
	}
});
