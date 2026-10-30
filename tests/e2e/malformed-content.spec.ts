import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_BUCKET, FIXTURE_CWD } from "../support/fixtures.ts";
import { conversation, SHAPES, stamp } from "../support/malformed-content.ts";
import { expect, test } from "./fixtures.ts";

/**
 * One bad line in a session file (a `null` in a message's content, a text block whose text is a number) replaced the
 * whole chat page with the Reload screen, for good: the line stays in the file. Every kind of malformed content opens
 * like any conversation, with what can be read of it shown and the messages around it as usual (no model call).
 */

function writeSession(agentDir: string, n: number, name: string): { file: string; title: string } {
	const bucket = join(agentDir, "sessions", FIXTURE_BUCKET);
	mkdirSync(bucket, { recursive: true });
	const hex = n.toString(16).padStart(4, "0");
	const id = `01a00000-0000-7000-8000-0000000b${hex}`;
	const title = `Malformed content ${n}: ${name}`;
	const file = join(bucket, `2026-01-18T10-00-${String(n).padStart(2, "0")}-000Z_${id}.jsonl`);
	const slot: Record<string, unknown> = { type: "title", v: 1, title, source: "user", updatedAt: stamp(0), pad: "" };
	slot.pad = " ".repeat(Math.max(0, 255 - Buffer.byteLength(JSON.stringify(slot))));
	const header = { type: "session", version: 3, id, timestamp: stamp(0), cwd: FIXTURE_CWD };
	const entries = conversation(SHAPES[name]);
	writeFileSync(file, `${JSON.stringify(slot)}\n${[header, ...entries].map((e) => JSON.stringify(e)).join("\n")}\n`);
	return { file, title };
}

Object.keys(SHAPES).forEach((name, i) => {
	test(`a conversation with ${name} opens, and the messages around it are as usual`, async ({ page }) => {
		const { file, title } = writeSession(process.env.OMPW_E2E_AGENT_DIR as string, i + 1, name);
		await page.goto(`/#/s/${encodeURIComponent(file)}`);
		await expect(page.getByTestId("chat-title")).toHaveText(title);
		await expect(page.getByTestId("msg-assistant").filter({ hasText: "second reply after" })).toBeVisible();
		await expect(page.getByText("second prompt")).toBeVisible();
		await expect(page.getByTestId("error-screen")).toHaveCount(0);
		await expect(page.getByTestId("message-failed")).toHaveCount(0);
		// The composer works: the page is the page.
		await page.getByTestId("composer").fill("still here");
		await expect(page.getByTestId("composer")).toHaveValue("still here");
	});
});

test("what can be read of a message with a bad block is shown, and the list and search keep working", async ({
	page,
}) => {
	const { file, title } = writeSession(process.env.OMPW_E2E_AGENT_DIR as string, 40, "null block");
	await page.goto(`/#/s/${encodeURIComponent(file)}`);
	await expect(page.getByTestId("chat-title")).toHaveText(title);
	await expect(page.getByTestId("msg-assistant").filter({ hasText: "visible text" })).toBeVisible();
	await page.reload();
	await expect(page.getByTestId("msg-assistant").filter({ hasText: "visible text" })).toBeVisible();
	await expect(page.locator('[data-testid="session-item"]', { hasText: title })).toHaveCount(1);
});
