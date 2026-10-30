import { afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import { pollUntil } from "../support/poll.ts";
import { usageResetWaitFixture } from "../support/usage-reset-wait.ts";

/**
 * "Compact at" against the real server and omp: where omp compacts by itself is omp's own two settings
 * (`compaction.thresholdPercent` and `compaction.thresholdTokens`), so what the page changes is read back with omp's own
 * `omp config get`, and a conversation's own point is a line in the process's `--config` overlay, which omp reloads by
 * itself — read back here by running `omp config get` the way that process reads its configuration (its agent directory
 * and its `--config` files), which is what the panel does.
 *
 * No model call is made and no threshold is reached: the point is a setting, and omp reads it at each check.
 */

const fixture = usageResetWaitFixture();
const { api, configYml, ompConfigGet, ompConfigSet, conversation } = fixture;

let original = "";
beforeAll(() => {
	original = configYml();
});
// Each test starts from the configuration the fixture wrote: the server's own directory goes with the fixture.
afterEach(() => writeFileSync(join(fixture.server.agentDir, "config.yml"), original));

/** omp's own point as its configuration has it: `-1` in both settings is omp's reserve-based default. */
const pointState = async (file?: string): Promise<{ omp: Record<string, number> | null; session: unknown }> =>
	(await api(`/api/compact-at${file === undefined ? "" : `?file=${encodeURIComponent(file)}`}`)).json();

/** The overlay file of the conversation's process: the server's own `--config`, last on its command line. */
function overlayOf(liveId: string): string {
	const dir = readdirSync(fixture.server.tmpDir).find(
		(name) => name.startsWith("ompw-live-") && existsSync(join(fixture.server.tmpDir, name, `${liveId}.yml`)),
	);
	expect(dir).toBeDefined();
	return join(fixture.server.tmpDir, dir as string, `${liveId}.yml`);
}

/** What the overlay says of `compaction`, as YAML reads it; undefined where it says nothing of it. */
function overlayCompaction(liveId: string): Record<string, unknown> | undefined {
	const parsed: unknown = Bun.YAML.parse(readFileSync(overlayOf(liveId), "utf8"));
	return isRecord(parsed) && isRecord(parsed.compaction) ? parsed.compaction : undefined;
}

test("omp's own point is shown as omp's configuration has it, changed as `omp config set` does, and a change in the terminal shows too", async () => {
	expect(await pointState()).toEqual({ omp: { percent: -1, tokens: -1 }, session: null });
	// A share below the one this page offers, both at once, a count as text: none of them is a point it can set.
	for (const at of [{ percent: 20 }, { percent: 70, tokens: 40_000 }, { tokens: "40000" }, { tokens: -1 }, 85]) {
		expect((await api("/api/compact-at", { at })).status, JSON.stringify(at)).toBe(400);
	}
	expect((await api("/api/compact-at", {})).status).toBe(400);

	const share = await api("/api/compact-at", { at: { percent: 70 } });
	expect(share.status).toBe(200);
	expect(await share.json()).toEqual({ omp: { percent: 70, tokens: -1 }, session: null });
	// omp's own file and its own key: the terminal sees it, and nothing of the app's own is written beside it.
	expect(await ompConfigGet("compaction.thresholdPercent")).toBe("70");
	// The other is -1 rather than left as it was: omp takes a positive count over a share, so a leftover count would win.
	expect(await ompConfigGet("compaction.thresholdTokens")).toBe("-1");

	// A count, made through the same route, replaces the share the same way.
	const count = await api("/api/compact-at", { at: { tokens: 40_000 } });
	expect(await count.json()).toEqual({ omp: { percent: -1, tokens: 40_000 }, session: null });
	expect(await ompConfigGet("compaction.thresholdTokens")).toBe("40000");
	expect(await ompConfigGet("compaction.thresholdPercent")).toBe("-1");

	// A change made in the terminal reaches the page once omp's config file is written (the server re-reads it).
	await ompConfigSet("compaction.thresholdPercent", "65");
	await pollUntil(
		async () => (await pointState()).omp?.percent === 65,
		"omp's own point to be read again after the terminal changed it",
	);

	// Default is omp's own again: both settings reset.
	expect((await (await api("/api/compact-at", { at: null })).json()).omp).toEqual({ percent: -1, tokens: -1 });
	expect(await ompConfigGet("compaction.thresholdPercent")).toBe("-1");
	expect(await ompConfigGet("compaction.thresholdTokens")).toBe("-1");
}, 90_000);

test("a conversation's own point reaches its process through the overlay, and omp reads it back", async () => {
	const chat = await conversation();
	try {
		const file = await chat.start();
		const overlay = overlayOf(chat.liveId);
		// A point omp's configuration has none of: the conversation's overlay says it, and nothing else is written.
		const before = configYml();

		const share = await api("/api/compact-at/session", { file, at: { percent: 70 } });
		expect(share.status).toBe(200);
		expect(await share.json()).toEqual({ omp: { percent: -1, tokens: -1 }, session: { percent: 70 } });
		// The process's own `--config` carries it as YAML numbers, which is what omp reads (a string is not a number).
		expect(overlayCompaction(chat.liveId)).toEqual({ thresholdPercent: 70, thresholdTokens: -1 });
		expect(readFileSync(overlay, "utf8")).toContain("compaction:");
		expect(configYml()).toBe(before);
		// Every page is told what the process was set to, as `LiveInfo.compactAt`.
		await pollUntil(async () => (await chat.listing())?.compactAt !== undefined, "the process to say its point");
		expect((await chat.listing())?.compactAt).toEqual({ percent: 70 });

		// What the panel reads for the conversation is the point it chose.
		expect(await pointState(file)).toEqual({ omp: { percent: -1, tokens: -1 }, session: { percent: 70 } });

		// A count replaces it, one line for the other as omp's own settings do.
		const count = await api("/api/compact-at/session", { file, at: { tokens: 40_000 } });
		expect(await count.json()).toEqual({ omp: { percent: -1, tokens: -1 }, session: { tokens: 40_000 } });
		expect(overlayCompaction(chat.liveId)).toEqual({ thresholdPercent: -1, thresholdTokens: 40_000 });
		await pollUntil(async () => {
			const said = (await chat.listing())?.compactAt;
			return said !== undefined && "tokens" in said;
		}, "the process to say its count");

		// Default: the conversation follows omp's configuration again, and the overlay says nothing of the point.
		const cleared = await api("/api/compact-at/session", { file, at: null });
		expect(await cleared.json()).toEqual({ omp: { percent: -1, tokens: -1 }, session: null });
		expect(overlayCompaction(chat.liveId)).toBeUndefined();
		await pollUntil(async () => (await chat.listing())?.compactAt === undefined, "the point to be cleared");
		expect(await pointState(file)).toEqual({ omp: { percent: -1, tokens: -1 }, session: null });

		// Files that are not conversations, and points this page cannot set, are refused.
		for (const bad of ["/etc/hosts", join(fixture.server.root, "elsewhere.jsonl"), 7, null]) {
			expect((await api("/api/compact-at/session", { file: bad, at: { percent: 70 } })).status).toBe(404);
		}
		expect((await api("/api/compact-at/session", { file, at: { percent: 20 } })).status).toBe(400);
		expect((await api("/api/compact-at/session", { file })).status).toBe(400);
		expect((await api(`/api/compact-at?file=${encodeURIComponent("/etc/hosts")}`)).status).toBe(404);
	} finally {
		chat.close();
	}
}, 90_000);
