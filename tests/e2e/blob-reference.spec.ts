import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_BUCKET, FIXTURE_CWD } from "../support/fixtures.ts";
import { expect, test } from "./fixtures.ts";

/**
 * A saved image block `blob:sha256:../meta` became the address `/api/blob/../meta`, which the browser resolves to
 * `/api/meta` before the server sees it: Regenerate and Edit fetched whatever same-origin address a session file named,
 * and sent the answer to the model as the prompt's image. Only a sha256 is a stored image (no model call).
 */

const ts = (min: number) => new Date(Date.UTC(2026, 0, 16, 10, min)).toISOString();
const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function writeSession(agentDir: string, reference: string): { file: string; title: string } {
	const bucket = join(agentDir, "sessions", FIXTURE_BUCKET);
	mkdirSync(bucket, { recursive: true });
	const id = "01a00000-0000-7000-8000-00000000e3e3";
	const title = "Blob reference fixture";
	const file = join(bucket, `2026-01-16T10-00-00-000Z_${id}.jsonl`);
	const slot: Record<string, unknown> = { type: "title", v: 1, title, source: "user", updatedAt: ts(0), pad: "" };
	slot.pad = " ".repeat(Math.max(0, 255 - Buffer.byteLength(JSON.stringify(slot))));
	const entries = [
		{
			type: "message",
			id: "b1",
			parentId: null,
			timestamp: ts(1),
			message: {
				role: "user",
				content: [
					{ type: "text", text: "look at this" },
					{ type: "image", data: reference, mimeType: "image/png" },
				],
				attribution: "user",
				timestamp: 1,
			},
		},
		{
			type: "message",
			id: "b2",
			parentId: "b1",
			timestamp: ts(2),
			message: {
				role: "assistant",
				content: [{ type: "text", text: "I looked." }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-haiku-5-5",
				usage,
				stopReason: "stop",
				timestamp: 2,
			},
		},
	];
	const header = { type: "session", version: 3, id, timestamp: ts(0), cwd: FIXTURE_CWD };
	writeFileSync(file, `${JSON.stringify(slot)}\n${[header, ...entries].map((e) => JSON.stringify(e)).join("\n")}\n`);
	return { file, title };
}

for (const reference of [
	"blob:sha256:../meta",
	"blob:sha256:../session?file=/etc/hosts",
	`blob:sha256:${"ab".repeat(32)}/../meta`,
]) {
	test(`Regenerate on a prompt whose image is "${reference}" requests no address of the page's own API`, async ({
		page,
	}) => {
		const { file, title } = writeSession(process.env.OMPW_E2E_AGENT_DIR as string, reference);
		await page.goto(`/#/s/${encodeURIComponent(file)}`);
		await expect(page.getByTestId("chat-title")).toHaveText(title);
		await expect(page.getByTestId("msg-assistant").filter({ hasText: "I looked." })).toBeVisible();

		const after: string[] = [];
		page.on("request", (r) => after.push(new URL(r.url()).pathname));
		await page.getByRole("button", { name: "Regenerate" }).first().click();

		await expect(page.getByTestId("toast").filter({ hasText: "not a stored image" })).toBeVisible();
		await page.waitForTimeout(500);
		// Nothing was asked of /api/meta, /api/session or /api/blob: the reference was refused before any address was made.
		expect(after.filter((path) => /^\/api\/(meta|session|blob)\b/.test(path))).toEqual([]);
	});
}
