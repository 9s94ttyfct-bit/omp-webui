import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { FIXTURE_BUCKET, FIXTURE_CWD, writeSimpleSession } from "../support/fixtures.ts";
import { topTab } from "../support/panel.ts";
import { expect, test } from "./fixtures.ts";

/**
 * The open conversation is downloaded with every branch file of it (megabytes, for a long one). Writes anywhere else
 * must not download it again; a branch joining it must.
 */

let agentDir: string;
test.beforeAll(() => {
	agentDir = process.env.OMPW_E2E_AGENT_DIR as string;
});
const row = (title: string) => `[data-testid="session-item"]:has-text("${title}")`;
let created: string[] = [];
test.afterEach(() => {
	for (const f of created) rmSync(f, { force: true });
	created = [];
});

const stamp = (minute: number) => new Date(Date.UTC(2026, 0, 7, 3, minute)).toISOString();
const entry = (id: string, parentId: string | null, role: "user" | "assistant", text: string, minute: number) => ({
	type: "message",
	id,
	parentId,
	timestamp: stamp(minute),
	message: {
		role,
		content: [{ type: "text", text }],
		...(role === "user"
			? { attribution: "user" }
			: { provider: "anthropic", model: "claude-haiku-5-5", stopReason: "stop" }),
		timestamp: Date.parse(stamp(minute)),
	},
});

/** A branch of `parent` (a session `writeSimpleSession(…, n, …)` made): its two entries, then a prompt of its own. */
function writeBranch(parent: string, parentN: number, n: number, title: string): string {
	const hex = n.toString(16).padStart(2, "0");
	const parentHex = parentN.toString(16).padStart(2, "0");
	const id = `01a00000-0000-7000-8000-0000000098${hex}`;
	const file = join(agentDir, "sessions", FIXTURE_BUCKET, `2026-01-07T01-${hex}-00-000Z_${id}.jsonl`);
	const lines = [
		{ type: "session", version: 3, id, timestamp: stamp(10), cwd: FIXTURE_CWD, parentSession: parent },
		entry(`s${parentHex}000001`, null, "user", `${title}?`, 1),
		entry(`s${parentHex}000002`, `s${parentHex}000001`, "assistant", `${title}.`, 2),
		entry(`b${hex}000003`, `s${parentHex}000002`, "user", "A question only the branch has", 3),
	];
	writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	return file;
}

test("writes to other conversations do not download the open one again; a branch joining it does", async ({ page }) => {
	const parent = writeSimpleSession(agentDir, 0x70, "Family parent");
	const other = writeSimpleSession(agentDir, 0x71, "Family bystander");
	created.push(parent, other);

	const requests: string[] = [];
	page.on("request", (r) => {
		const { pathname } = new URL(r.url());
		if (pathname === "/api/family" || pathname === "/api/sessions") requests.push(pathname);
	});
	const count = (path: string) => requests.filter((p) => p === path).length;

	await page.goto("/");
	await page.locator(row("Family parent")).click();
	await expect(page.getByTestId("chat-title")).toHaveText("Family parent");
	await expect(page.getByTestId("transcript").getByText("Family parent.", { exact: true })).toBeVisible();
	await sleep(1500);
	const families = count("/api/family");
	expect(families).toBeGreaterThan(0);

	// Another conversation is written to, five times: the session list follows, the open conversation stays.
	const lists = count("/api/sessions");
	for (let i = 0; i < 5; i++) {
		appendFileSync(other, `${JSON.stringify(entry(`s71a0000${i}`, "s71000002", "assistant", `More ${i}`, 20 + i))}\n`);
		await sleep(900);
	}
	await expect.poll(() => count("/api/sessions")).toBeGreaterThan(lists);
	await sleep(2000);
	expect(count("/api/family")).toBe(families);

	// A branch of the open conversation appears: now it is fetched again, and the branch is listed.
	const branch = writeBranch(parent, 0x70, 0x72, "Family parent");
	created.push(branch);
	await expect.poll(() => count("/api/family")).toBe(families + 1);
	await page.getByTestId("toggle-panel").click();
	await topTab(page, /Branches/).click();
	await expect(page.getByTestId("branch-list").locator("li")).toHaveCount(2);

	// Writing to the branch, a member of the family, is fetched again too.
	const before = count("/api/family");
	appendFileSync(branch, `${JSON.stringify(entry("b72000004", "b72000003", "assistant", "Its answer", 4))}\n`);
	await expect.poll(() => count("/api/family"), { timeout: 15_000 }).toBe(before + 1);
});
