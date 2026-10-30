import { expect, test } from "bun:test";
import { join } from "node:path";
import { isUsageLimitError } from "../../shared/retry.ts";
import { pollUntil } from "../support/poll.ts";
import { usageResetWaitFixture } from "../support/usage-reset-wait.ts";

const fixture = usageResetWaitFixture();
const { api, waitState, configYml, ompConfigGet, ompConfigSet, conversation } = fixture;

/**
 * A running omp applies a changed config.yml or overlay after a debounce, and macOS delivers file events with a delay
 * of its own, on a busy machine too; there is nothing to observe it by, so a test that changes a setting and then
 * relies on it gives omp this long first.
 */
const reloaded = () => Bun.sleep(1500);

test("the setting is omp's own retry.waitForUsageReset: shown from omp, changed as `omp config set`, and a change made in the terminal shows too", async () => {
	expect(await waitState()).toEqual({ omp: false, session: null });
	expect((await api("/api/usage-reset-wait", { enabled: "yes" })).status).toBe(400);
	expect((await api("/api/usage-reset-wait", {})).status).toBe(400);

	const changed = await api("/api/usage-reset-wait", { enabled: true });
	expect(await changed.json()).toEqual({ omp: true, session: null });
	// The very file and value `omp config` uses; nothing of the app's own is written.
	expect(configYml()).toMatch(/retry:\n(?:\s+\w+: .*\n)*\s+waitForUsageReset: true/);
	expect(await ompConfigGet("retry.waitForUsageReset")).toBe("true");

	await ompConfigSet("retry.waitForUsageReset", "false");
	expect(await waitState()).toEqual({ omp: false, session: null });
});

test("a conversation's own choice is kept by its session file; files outside the sessions dir and odd values are refused", async () => {
	const chat = await conversation();
	try {
		const file = await chat.start();
		const chosen = await api("/api/usage-reset-wait/session", { file, enabled: true });
		expect(chosen.status).toBe(200);
		expect(await chosen.json()).toEqual({ omp: false, session: true });
		expect(await waitState(file)).toEqual({ omp: false, session: true });
		// The process holding the conversation was told through its overlay, which the announce carries.
		await pollUntil(async () => (await chat.listing())?.usageResetWait === true, "the process to say it waits");

		const cleared = await api("/api/usage-reset-wait/session", { file, enabled: null });
		expect(await cleared.json()).toEqual({ omp: false, session: null });
		await pollUntil(async () => (await chat.listing())?.usageResetWait === undefined, "the choice to be cleared");

		for (const bad of ["/etc/hosts", join(fixture.server.root, "elsewhere.jsonl"), 7, null]) {
			expect((await api("/api/usage-reset-wait/session", { file: bad, enabled: true })).status).toBe(404);
		}
		expect((await api("/api/usage-reset-wait/session", { file, enabled: "yes" })).status).toBe(400);
		expect((await api("/api/usage-reset-wait/session", { file })).status).toBe(400);
		expect((await api(`/api/usage-reset-wait?file=${encodeURIComponent("/etc/hosts")}`)).status).toBe(404);
	} finally {
		chat.close();
	}
}, 60_000);

test("a conversation's own choice beats omp's setting: on waits although omp's is off, off fails the turn although omp's is on", async () => {
	const chat = await conversation();
	try {
		const file = await chat.start();

		// omp's setting is off, the conversation's own choice is on.
		await api("/api/usage-reset-wait", { enabled: false });
		await api("/api/usage-reset-wait/session", { file, enabled: true });
		await reloaded();
		fixture.backend.limitUntil = Date.now() + 6000;
		const waiting = chat.next("auto_retry_start");
		await chat.prompt("own choice on");
		expect(isUsageLimitError((await waiting).errorId)).toBe(true);
		const done = await chat.next("auto_retry_end");
		expect(done.success).toBe(true);

		// omp's setting is on, the conversation's own choice is off: the turn fails at once, omp's own fail-fast.
		await api("/api/usage-reset-wait", { enabled: true });
		await api("/api/usage-reset-wait/session", { file, enabled: false });
		await reloaded();
		fixture.backend.limitUntil = Date.now() + 6000;
		const failed = chat.next("auto_retry_end");
		await chat.prompt("own choice off");
		const end = await failed;
		expect(end.success).toBe(false);
		expect(String(end.finalError)).toContain("retry.maxDelayMs");
		expect((await chat.listing())?.retry).toBeUndefined();
		await api("/api/usage-reset-wait/session", { file, enabled: null });
		await api("/api/usage-reset-wait", { enabled: false });
	} finally {
		chat.close();
	}
}, 90_000);
