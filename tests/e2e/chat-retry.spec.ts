import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import { FIXTURE_BUCKET, FIXTURE_CWD } from "../support/fixtures.ts";
import { ownSession, startLive } from "../support/live.ts";
import { type Msg, tapSocket } from "../support/socket-tap.ts";
import { expect, test } from "./fixtures.ts";

/**
 * omp retries failed turns and compacts a full context by itself. The page shows both, offers Retry on a failed
 * turn, and shows a failure that a retry got past as a note. The frames omp sends for these are pushed through
 * the socket tap, so no model call is made.
 */

const stamp = (minute: number) => new Date(Date.UTC(2026, 0, 8, 10, minute)).toISOString();

interface Recovery {
	kind: "auto-retry";
	status: "recovered";
	attempt: number;
	recovery: string;
	note: string;
}

/** A conversation whose last assistant message failed (or failed and was recovered), for a spec to open. */
function writeSession(
	agentDir: string,
	id: string,
	prompt: string,
	recovery?: Recovery,
): { file: string; failedId: string } {
	const dir = join(agentDir, "sessions", FIXTURE_BUCKET);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `2026-01-08T10-00-00-000Z_${id}.jsonl`);
	const failedId = `r${id.slice(-4)}0002`;
	const entries: Record<string, unknown>[] = [
		{ type: "session", version: 3, id, timestamp: stamp(0), cwd: FIXTURE_CWD },
		{
			type: "message",
			id: `r${id.slice(-4)}0001`,
			parentId: null,
			timestamp: stamp(1),
			message: {
				role: "user",
				content: [{ type: "text", text: prompt }],
				attribution: "user",
				timestamp: Date.parse(stamp(1)),
			},
		},
		{
			type: "message",
			id: failedId,
			parentId: `r${id.slice(-4)}0001`,
			timestamp: stamp(2),
			message: {
				role: "assistant",
				content: [],
				provider: "anthropic",
				model: "claude-haiku-5-5",
				stopReason: "error",
				errorMessage: "429 rate_limit_error: This request would exceed your rate limit.",
				...(recovery ? { retryRecovery: recovery } : {}),
				timestamp: Date.parse(stamp(2)),
			},
		},
	];
	if (recovery) {
		entries.push({
			type: "message",
			id: `r${id.slice(-4)}0003`,
			parentId: failedId,
			timestamp: stamp(3),
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Found it: the cache key is stale." }],
				provider: "anthropic",
				model: "claude-haiku-5-5",
				stopReason: "stop",
				timestamp: Date.parse(stamp(3)),
			},
		});
	}
	writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
	return { file, failedId };
}

test("a failed turn offers Retry; a retry shows its countdown with Cancel; a recovered failure becomes a note", async ({
	page,
}) => {
	const prompt = "Retry probe: trace the flaky test";
	const { file, failedId } = writeSession(
		process.env.OMPW_E2E_AGENT_DIR as string,
		"01a00000-0000-7000-8000-00000000e8e8",
		prompt,
	);
	try {
		await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
		const tap = await tapSocket(page);
		tap.answer("prompt", (c) => (c.message === "/retry" ? { ok: true, data: { agentInvoked: true } } : undefined));
		await page.goto("/");
		await page.getByRole("complementary").getByText(prompt).click();

		const error = page.getByTestId("assistant-error");
		await expect(error).toContainText("429 rate_limit_error");
		await error.getByTestId("retry-button").click();
		await expect.poll(() => tap.commands("prompt").map((c) => c.message)).toEqual(["/retry"]);
		const prompted = tap.sent.findLast((m) => m.t === "rpc" && m.command?.type === "prompt");
		if (typeof prompted?.liveId !== "string") throw new Error("no process was started for the retry");
		const frame = (f: Record<string, unknown>) => tap.push({ t: "frame", liveId: prompted.liveId, frame: f });

		// omp backs off: the countdown, with a Cancel; the error offers no second Retry meanwhile.
		frame({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 60_000,
			errorMessage: "429 rate_limit_error",
		});
		const status = page.getByTestId("retry-status");
		await expect(status).toContainText(/Retrying 1\/3 in (59|60)s/);
		await expect(page.getByTestId("retry-button")).toHaveCount(0);
		await status.getByTestId("retry-cancel").click();
		await expect.poll(() => tap.commands("abort_retry").length).toBe(1);
		frame({ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" });
		await expect(status).toContainText("Retry cancelled");
		await expect(status.getByTestId("retry-cancel")).toHaveCount(0);
		await expect(page.getByTestId("retry-button")).toBeVisible();

		// A later attempt gets through: the failure it left behind is a one-line note, not a red box.
		frame({ type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 100, errorMessage: "429 rate_limit_error" });
		await expect(status).toContainText(/Retrying 2\/3/);
		frame({
			type: "auto_retry_end",
			success: true,
			attempt: 2,
			retryErrors: [
				{
					entryId: failedId,
					persistenceKey: "k",
					note: "rate-limited; retried",
					retryRecovery: {
						kind: "auto-retry",
						status: "recovered",
						attempt: 2,
						recovery: "plain",
						note: "rate-limited; retried",
					},
				},
			],
		});
		await expect(status).toHaveCount(0);
		await expect(error).toHaveCount(0);
		const note = page.getByTestId("retry-recovered");
		await expect(note).toContainText("Recovered after 2 retries");
		await note.getByRole("button").click();
		await expect(note).toContainText("429 rate_limit_error");
	} finally {
		rmSync(file, { force: true });
	}
});

test("a failure a retry got past, saved in the conversation, is a note and not an error", async ({ page }) => {
	const prompt = "Retry probe: find the stale cache key";
	const { file } = writeSession(
		process.env.OMPW_E2E_AGENT_DIR as string,
		"01a00000-0000-7000-8000-00000000e9e9",
		prompt,
		{ kind: "auto-retry", status: "recovered", attempt: 1, recovery: "plain", note: "rate-limited; retried" },
	);
	try {
		await page.goto("/");
		await page.getByRole("complementary").getByText(prompt).click();
		await expect(page.getByText("Found it: the cache key is stale.")).toBeVisible();
		await expect(page.getByTestId("retry-recovered")).toContainText("Recovered after 1 retry");
		await expect(page.getByTestId("assistant-error")).toHaveCount(0);
		await expect(page.getByTestId("retry-button")).toHaveCount(0);
	} finally {
		rmSync(file, { force: true });
	}
});

/** omp's answer to a read of the whole conversation, as it is once a retry got past the failed turn: that entry marked in place. */
function recoveredIn(msg: Msg, failedId: string): Msg {
	const data = msg.data;
	if (!isRecord(data) || !Array.isArray(data.entries)) return msg;
	const entries = data.entries.map((e: unknown) =>
		isRecord(e) && e.id === failedId && isRecord(e.message)
			? {
					...e,
					message: {
						...e.message,
						retryRecovery: {
							kind: "auto-retry",
							status: "recovered",
							attempt: 1,
							recovery: "plain",
							note: "rate-limited; retried",
						},
					},
				}
			: e,
	);
	return { ...msg, data: { ...data, entries } };
}

test("a page that was away reads what omp rewrote meanwhile: a failure a retry got past is a note once the connection is back", async ({
	page,
}) => {
	const prompt = "Retry probe: resync after a dropped connection";
	const { file, failedId } = writeSession(
		process.env.OMPW_E2E_AGENT_DIR as string,
		"01a00000-0000-7000-8000-00000000eaea",
		prompt,
	);
	try {
		await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
		const tap = await tapSocket(page);
		await page.goto("/");
		await page.getByRole("complementary").getByText(prompt).click();
		const error = page.getByTestId("assistant-error");
		await expect(error).toContainText("429 rate_limit_error");
		// omp runs on the conversation (a `!command` needs no model), and the page holds its entries.
		const composer = page.getByTestId("composer");
		await composer.fill("!echo resync-probe");
		await composer.press("Enter");
		await expect(page.getByText("resync-probe", { exact: true })).toBeVisible({ timeout: 30_000 });

		// While the page is away omp's retry gets through and marks the failed entry in place. Of everything the page can
		// ask afterwards only a read of the whole conversation shows that: `since` the last entry brings what was added.
		tap.rewrite((msg, request) =>
			msg.t === "reply" && request?.command?.type === "get_entries" && request.command.since === undefined
				? recoveredIn(msg, failedId)
				: msg,
		);
		tap.drop();
		await expect(page.getByTestId("retry-recovered")).toContainText("Recovered after 1 retry", { timeout: 30_000 });
		await expect(error).toHaveCount(0);
		await expect(page.getByTestId("retry-button")).toHaveCount(0);
	} finally {
		rmSync(file, { force: true });
	}
});

test("compaction shows its action from its first frame to its last", async ({ page }) => {
	ownSession(0xda, "Compaction status probe");
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, "Compaction status probe", "compaction-status-probe");
	const frame = (f: Record<string, unknown>) => tap.push({ t: "frame", liveId, frame: f });

	const status = page.getByTestId("retry-status");
	await expect(status).toHaveCount(0);
	frame({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
	await expect(status).toContainText("Compacting the conversation");
	// A compaction that worked ends with its result; without one omp says the compaction failed.
	frame({
		type: "auto_compaction_end",
		action: "context-full",
		aborted: false,
		willRetry: false,
		result: { summary: "s", firstKeptEntryId: "e1", tokensBefore: 1000 },
	});
	await expect(status).toHaveCount(0);
});
