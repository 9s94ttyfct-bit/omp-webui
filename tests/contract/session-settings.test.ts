import { afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveInfo } from "../../shared/protocol.ts";
import { pollUntil } from "../support/poll.ts";
import { type UsageConversation, usageResetWaitFixture } from "../support/usage-reset-wait.ts";
import { connect, request } from "../support/ws.ts";

/**
 * The session controls omp cannot report (auto-retry, cache warming), against the real server and omp: what the panel
 * shows is what the process uses. omp's RPC sets them and never reads them back (`get_state` has neither), so the
 * server works the value out — what the process was told, else what its configuration says — and every claim here is
 * checked against what omp does: it retries a refused request (a stub provider answers a usage limit) when its auto-retry
 * is on, and ends the turn at the first failure when it is off.
 */

const fixture = usageResetWaitFixture();
const { api, configYml, ompConfigSet, conversation } = fixture;
type Chat = UsageConversation;

let original = "";
beforeAll(() => {
	original = configYml();
});
afterEach(() => writeFileSync(join(fixture.server.agentDir, "config.yml"), original));

/** What the page is told omp's configuration says for the conversation's process. */
const configured = async (chat: Chat) => (await api("/api/controls/settings", { live: chat.liveId })).json();

/**
 * Whether the process retries a request the provider refuses, as it is now. The provider refuses the next one for a
 * moment, and after that refused request omp either announces its retry (auto-retry on) or ends the turn (off): the
 * frames come in that order, so whichever of the two comes first says which it is, with no window to guess at. A turn
 * that retries is let end, so that the conversation is idle again. omp reads a changed config.yml or overlay after a
 * debounce, which the callers wait for first (`reloaded`).
 */
async function retries(chat: Chat): Promise<boolean> {
	fixture.backend.limitUntil = Date.now() + 1200;
	const announced = chat.next("auto_retry_start");
	const ended = chat.next("agent_end");
	await chat.prompt("probe");
	const retried = await Promise.race([announced.then(() => true), ended.then(() => false)]);
	if (retried) await ended;
	return retried;
}

/**
 * Wait until these conversations' omp have taken the change of config.yml that was just made. omp reloads a changed
 * file after a debounce and announces nothing, but what it reports in `get_state` follows the file: a setting changed
 * after the others, which no conversation has been held at, shows in a process only with the reload that carries the
 * others too.
 */
async function reloaded(...chats: Chat[]): Promise<void> {
	await ompConfigSet("steeringMode", "all");
	for (const chat of chats) {
		await pollUntil(
			async () =>
				(
					await request<{ steeringMode?: string }>(chat.ws, {
						t: "rpc",
						liveId: chat.liveId,
						command: { type: "get_state" },
					})
				).steeringMode === "all",
			`${chat.liveId} to reload config.yml`,
		);
	}
}

/** The overlay file of the conversation's process: the server's own `--config`, last on its command line. */
function overlayOf(chat: Chat): string {
	const tmp = fixture.server.tmpDir;
	const dir = readdirSync(tmp).find(
		(name) => name.startsWith("ompw-live-") && existsSync(join(tmp, name, `${chat.liveId}.yml`)),
	);
	expect(dir).toBeDefined();
	return join(tmp, dir as string, `${chat.liveId}.yml`);
}

test("a conversation that was told nothing uses omp's defaults, which is what its omp does", async () => {
	const chat = await conversation();
	try {
		await chat.start();
		expect(await configured(chat)).toEqual({ autoRetry: "on", cacheWarming: "idle" });
		expect(await retries(chat)).toBe(true);
	} finally {
		chat.close();
	}
}, 60_000);

test("omp's global config is what a conversation uses: a conversation started after it changed", async () => {
	await ompConfigSet("retry.enabled", "false");
	await ompConfigSet("providers.cacheWarming", "streaming");
	const chat = await conversation();
	try {
		await chat.start();
		expect(await configured(chat)).toEqual({ autoRetry: "off", cacheWarming: "streaming" });
		expect(await retries(chat)).toBe(false);
	} finally {
		chat.close();
	}
}, 60_000);

test("the folder's own config is over the global one, as omp reads it", async () => {
	await ompConfigSet("retry.enabled", "false");
	await ompConfigSet("providers.cacheWarming", "streaming");
	const folder = join(fixture.server.root, "project-config");
	mkdirSync(join(folder, ".omp"), { recursive: true });
	writeFileSync(join(folder, ".omp", "config.yml"), "retry:\n  enabled: true\nproviders:\n  cacheWarming: off\n");
	const chat = await conversation(folder);
	try {
		await chat.start();
		expect(await configured(chat)).toEqual({ autoRetry: "on", cacheWarming: "off" });
		expect(await retries(chat)).toBe(true);
	} finally {
		chat.close();
	}
}, 60_000);

test("what a process was told is its own, over the files: every page is told, and the files are not changed", async () => {
	const chat = await conversation();
	try {
		await chat.start();
		expect(chat.infos.at(-1)?.sessionSettings).toBeUndefined();
		await request(chat.ws, { t: "rpc", liveId: chat.liveId, command: { type: "set_auto_retry", enabled: false } });
		await request(chat.ws, {
			t: "rpc",
			liveId: chat.liveId,
			command: { type: "set_cache_warming", mode: "streaming" },
		});
		const told = { autoRetry: "off", cacheWarming: "streaming" };
		await pollUntil(async () => (await chat.listing())?.sessionSettings?.cacheWarming === "streaming", "the choice");
		expect((await chat.listing())?.sessionSettings).toEqual(told);
		// The page that chose is told with the rest of the info, and so is a page that comes to the conversation later.
		expect(chat.infos.at(-1)?.sessionSettings).toEqual(told);
		const later = await connect(fixture.server);
		try {
			expect((await request<LiveInfo>(later, { t: "attach", liveId: chat.liveId })).sessionSettings).toEqual(told);
		} finally {
			later.close();
		}
		// The files say what they said, and nothing was written; the process uses what it was told.
		expect(await configured(chat)).toEqual({ autoRetry: "on", cacheWarming: "idle" });
		expect(configYml()).toBe(original);
		expect(await retries(chat)).toBe(false);

		// A mode omp refuses is not recorded as the process's own.
		await expect(
			request(chat.ws, { t: "rpc", liveId: chat.liveId, command: { type: "set_cache_warming", mode: "always" } }),
		).rejects.toThrow();
		expect((await chat.listing())?.sessionSettings).toEqual(told);
	} finally {
		chat.close();
	}
}, 90_000);

test("a default made in one conversation is what the next one starts with; the open ones are held at what they have", async () => {
	const origin = await conversation();
	const bystander = await conversation();
	try {
		await origin.start();
		await bystander.start();
		const star = (setting: string, value: string) =>
			api("/api/controls/default", { live: origin.liveId, setting, value });
		expect((await star("autoRetry", "off")).status).toBe(200);
		expect((await star("cacheWarming", "streaming")).status).toBe(200);
		expect(configYml()).toMatch(/retry:\n(?:\s+\w+: .*\n)*\s+enabled: false/);
		expect(configYml()).toMatch(/cacheWarming: streaming/);

		// The conversation it was made in was told nothing, so it follows the config it changed; the other was held at what it
		// had (its overlay) and says so, whatever the global config is.
		expect(await configured(origin)).toEqual({ autoRetry: "off", cacheWarming: "streaming" });
		expect(await configured(bystander)).toEqual({ autoRetry: "on", cacheWarming: "idle" });
		await reloaded(origin, bystander);
		expect(await retries(origin)).toBe(false);
		expect(await retries(bystander)).toBe(true);

		const next = await conversation();
		try {
			await next.start();
			expect(await configured(next)).toEqual({ autoRetry: "off", cacheWarming: "streaming" });
		} finally {
			next.close();
		}
	} finally {
		origin.close();
		bystander.close();
	}
}, 120_000);

test("the panel still reads a conversation whose overlay file is gone: omp's files for what it was not held at, and the server's memory for what it was", async () => {
	// A cleaner of the temp dir, a sweep of another server: the file the process was started with is no longer there, and
	// asking omp to read it as one of its `--config` files fails ("Config overlay not found"), which blanked the panel (#600).
	const origin = await conversation();
	const bystander = await conversation();
	try {
		await origin.start();
		await bystander.start();
		// A default made in the origin holds the bystander at what it has (auto-retry on, which its overlay now says); the
		// origin follows the config it changed.
		expect(
			(await api("/api/controls/default", { live: origin.liveId, setting: "autoRetry", value: "off" })).status,
		).toBe(200);
		expect(await configured(origin)).toEqual({ autoRetry: "off", cacheWarming: "idle" });
		expect(await configured(bystander)).toEqual({ autoRetry: "on", cacheWarming: "idle" });

		rmSync(overlayOf(bystander));
		rmSync(overlayOf(origin));
		// What a process is held at is the server's to say; the rest is omp's files', read without the overlay.
		expect(await configured(origin)).toEqual({ autoRetry: "off", cacheWarming: "idle" });
		expect(await configured(bystander)).toEqual({ autoRetry: "on", cacheWarming: "idle" });
		expect((await bystander.listing())?.exited).toBe(false);
	} finally {
		origin.close();
		bystander.close();
	}
}, 120_000);

test("the panel's request names a running conversation", async () => {
	for (const body of [{}, { live: "L-no-such-process" }, { live: 7 }]) {
		const res = await api("/api/controls/settings", body);
		expect(res.status).toBe(404);
	}
	expect(
		(
			await fetch(`${fixture.server.url}/api/controls/settings`, {
				headers: { "x-omp-webui-token": fixture.server.accessToken },
			})
		).status,
	).toBe(405);
});
