import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_BUCKET, FIXTURE_CWD } from "../support/fixtures.ts";
import { ownSession, startLive } from "../support/live.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { costPerToken } from "../support/stream-cost.ts";
import { expect, test } from "./fixtures.ts";

/**
 * A reply streams token by token, a frame each. What a token costs the page must not depend on how many
 * conversations the sidebar lists: it was 17 ms with a thousand of them and 2.5 ms with five, because every row
 * rendered again for every token. The two are measured in one page, in one run, so the machine does not matter.
 */

const BULK = 500;
const FRAMES = 200;
let bucket: string;
const bulk: string[] = [];

test.beforeAll(() => {
	bucket = join(process.env.OMPW_E2E_AGENT_DIR as string, "sessions", FIXTURE_BUCKET);
	mkdirSync(bucket, { recursive: true });
	const at = (minute: number) => new Date(Date.UTC(2026, 0, 6, 0, minute)).toISOString();
	for (let i = 0; i < BULK; i++) {
		const hex = i.toString(16).padStart(4, "0");
		const id = `01a00000-0000-7000-8000-0000000c${hex}`;
		const file = join(bucket, `2026-01-06T00-${String(i % 60).padStart(2, "0")}-00-000Z_${id}.jsonl`);
		const message = (n: number, parentId: string | null, role: string, text: string) => ({
			type: "message",
			id: `c${hex}${n}`,
			parentId,
			timestamp: at(i % 60),
			message: { role, content: [{ type: "text", text }], ...(role === "user" ? { attribution: "user" } : {}) },
		});
		const lines = [
			{ type: "session", version: 3, id, timestamp: at(0), cwd: FIXTURE_CWD },
			message(1, null, "user", `Bulk conversation ${i}?`),
			message(2, `c${hex}1`, "assistant", `Bulk conversation ${i}.`),
		];
		writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
		bulk.push(file);
	}
});
test.afterAll(() => {
	for (const f of bulk) rmSync(f, { force: true });
});

test("a streamed token costs the page the same with hundreds of conversations listed as with one", async ({ page }) => {
	// The sidebar's filter is fuzzy (#644): the title carries a token no other conversation's letters spell, and the
	// filter names it, so the list is this conversation alone.
	const token = "zqxj";
	const title = `Stream cost probe ${token}`;
	ownSession(0x82, title);
	// Auto-titling would send a prompt to the model when the pushed reply ends.
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const rows = page.locator('[data-testid="session-item"]');
	// The sidebar draws only the rows in view: how many conversations it lists is how tall its list is (a row is ~32 px).
	const listed = () => page.getByTestId("session-list").evaluate((el) => el.scrollHeight / 32);
	await expect.poll(listed, { timeout: 60_000 }).toBeGreaterThan(BULK);
	const liveId = await startLive(page, tap, title, "stream-cost-probe");

	await costPerToken(page, tap, liveId, 60);
	const withList = await costPerToken(page, tap, liveId, FRAMES);
	await page.getByTestId("session-filter").fill(token);
	await expect(rows).toHaveCount(1);
	const alone = await costPerToken(page, tap, liveId, FRAMES);
	await page.getByTestId("session-filter").fill("");
	await expect.poll(listed).toBeGreaterThan(BULK);
	const listedAgain = await costPerToken(page, tap, liveId, FRAMES);

	console.log(`ms per token: ${withList.toFixed(2)} / ${listedAgain.toFixed(2)} listed, ${alone.toFixed(2)} alone`);
	expect(Math.min(withList, listedAgain)).toBeLessThan(alone * 2 + 1);
});
