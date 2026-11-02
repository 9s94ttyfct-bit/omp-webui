import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LivePool } from "../../server/live.ts";
import { ApprovalStore, ProcessOverlay, sessionKey } from "../../server/omp/approval.ts";
import { type ParkedRecord, ParkedStore } from "../../server/omp/parked.ts";
import { writeFakeHostOmp } from "../support/fake-host-omp.ts";
import { fakeConfig } from "../support/fake-omp.ts";
import { removeScratch } from "../support/scratch.ts";
import { setTempDir } from "../support/tmp.ts";

/**
 * How a conversation's omp is pointed at the built-in browser (docs/agents/browser.md): its overlay names the
 * conversation's own CDP endpoint (`browser.cdpUrl`) and always turns omp's relay to the person's Chrome off
 * (`browser.relay: false`, and `PI_BROWSER_RELAY=0` in its environment); the endpoint follows the conversation through a
 * new session, a move and a new server.
 */

const dirs: string[] = [];
const pools: LivePool[] = [];
const scratch = () => {
	const dir = mkdtempSync(join(tmpdir(), "ompw-browser-wiring-"));
	dirs.push(dir);
	return dir;
};
afterEach(async () => {
	for (const pool of pools.splice(0)) await pool.shutdown();
	for (const d of dirs.splice(0)) removeScratch(d);
});
// Other files' servers sweep the shared temp dir for overlay folders of servers that are gone.
const sharedTmp = process.env.TMPDIR;
let ownTmp = "";
beforeAll(() => {
	ownTmp = mkdtempSync(join(tmpdir(), "ompw-browser-wiring-tmp-"));
	setTempDir(ownTmp);
});
afterAll(() => {
	if (sharedTmp === undefined) delete process.env.TMPDIR;
	else setTempDir(sharedTmp);
	removeScratch(ownTmp);
});

const browserIn = (file: string): Record<string, unknown> | undefined =>
	(Bun.YAML.parse(readFileSync(file, "utf8")) as { browser?: Record<string, unknown> } | null)?.browser;

async function until(condition: () => boolean): Promise<void> {
	const deadline = performance.now() + 10_000;
	while (!condition()) {
		if (performance.now() > deadline) throw new Error("the condition never held");
		await Bun.sleep(5);
	}
}

test("every overlay turns the relay off, and names the conversation's endpoint only when it has one", async () => {
	const file = join(scratch(), "L1.yml");
	const overlay = new ProcessOverlay(file, null, 0);
	expect(browserIn(file)).toEqual({ relay: false });

	await overlay.setBrowser("http://127.0.0.1:4321/browser-cdp/tok-aaaaaaaaaaaaaaaa");
	expect(overlay.browser).toBe("http://127.0.0.1:4321/browser-cdp/tok-aaaaaaaaaaaaaaaa");
	expect(browserIn(file)).toEqual({ cdpUrl: "http://127.0.0.1:4321/browser-cdp/tok-aaaaaaaaaaaaaaaa", relay: false });

	await overlay.setBrowser(null);
	expect(browserIn(file)).toEqual({ relay: false });
});

test("an overlay made for a new or a resumed process starts with the endpoint it is given", async () => {
	const store = new ApprovalStore("omp", scratch(), 0);
	const url = "http://127.0.0.1:1/browser-cdp/tok-bbbbbbbbbbbbbbbb";
	const made = await store.create("L1", null, null, null, [], undefined, [], null, null, null, url);
	expect(browserIn(made.file)).toEqual({ cdpUrl: url, relay: false });
	made.remove();
	const restored = store.restore(join(scratch(), "L2.yml"), null, null, null, [], {}, [], null, null, null, url);
	expect(restored.browser).toBe(url);
	expect(browserIn(restored.file)).toEqual({ cdpUrl: url, relay: false });
});

test("a paused conversation's record keeps its endpoint; one that is not a URL is none", () => {
	const store = new ParkedStore(scratch());
	const base: ParkedRecord = {
		version: 2,
		liveId: "L1",
		omp: { pid: 1, identity: "a" },
		relay: { pid: 2, identity: "b" },
		socket: "/tmp/x.sock",
		owner: null,
		cwd: "/",
		args: [],
		env: {},
		mode: "full",
		startedAt: 0,
		pausedAt: 1,
		sessionFile: null,
		sessionId: null,
		streaming: false,
		overlay: { file: "/tmp/L1.yml", mode: null, browserCdpUrl: "http://127.0.0.1:1/browser-cdp/tok-cccccccccccccccc" },
		interviewing: false,
		pendingUI: [],
		descendants: [],
	};
	store.save(base);
	store.save({
		...base,
		liveId: "L2",
		pausedAt: 2,
		overlay: { file: "/tmp/L2.yml", mode: null, browserCdpUrl: 7 as unknown as string },
	});
	const [first, second] = store.list();
	expect(first.overlay?.browserCdpUrl).toBe("http://127.0.0.1:1/browser-cdp/tok-cccccccccccccccc");
	expect(second.overlay?.browserCdpUrl).toBeNull();
});

/** A pool on a scripted omp, with a browser whose endpoint for a conversation is `<origin>/browser-cdp<file>`. */
function setup() {
	const dir = scratch();
	const log = join(dir, "log");
	writeFileSync(log, "");
	const bin = writeFakeHostOmp(dir, log);
	const pool = new LivePool(fakeConfig(dir, bin), null, null, new ApprovalStore(bin, dir, 0));
	pools.push(pool);
	const browser = {
		origin: "http://127.0.0.1:1111",
		installed: true,
		off: false,
		moves: [] as [string, string][],
		cdpUrlFor: async (owner: string | null) =>
			browser.off ? false : browser.installed && owner !== null ? `${browser.origin}/browser-cdp${owner}` : null,
		moved: async (from: string, to: string) => {
			browser.moves.push([from, to]);
		},
	};
	pool.browser = browser;
	const sessionFile = join(dir, "session.jsonl");
	writeFileSync(sessionFile, "");
	/** The conversation as the server names it (its real path). */
	const key = sessionKey(sessionFile);
	const logged = () =>
		readFileSync(log, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as { argv?: string[]; browserRelay?: string | null });
	/** The overlay file the (first) process was given, last on its command line. */
	const overlayFile = () =>
		logged()
			.find((l) => l.argv)
			?.argv?.at(-1) as string;
	return { dir, pool, browser, sessionFile, key, logged, overlayFile };
}

test("omp runs with the relay off in its environment", async () => {
	const { pool, sessionFile, logged } = setup();
	await pool.open({ kind: "resume", sessionFile }, async () => tmpdir());
	expect(logged().find((l) => l.argv)?.browserRelay).toBe("0");
});

test("a conversation's overlay names its endpoint, and a new session gets the new session's", async () => {
	const { pool, browser, sessionFile, key, overlayFile } = setup();
	const live = await pool.open({ kind: "resume", sessionFile }, async () => tmpdir());
	const overlay = overlayFile();
	expect(browserIn(overlay)).toEqual({ cdpUrl: `${browser.origin}/browser-cdp${key}`, relay: false });

	await live.rpc({ type: "new_session" });
	const next = live.info.sessionFile as string;
	expect(next).not.toBe(key);
	await until(() => browserIn(overlay)?.cdpUrl === `${browser.origin}/browser-cdp${next}`);
	// A new conversation: the pages of the one before stay its own.
	expect(browser.moves).toEqual([]);
});

test("a conversation moved to another file takes its pages along", async () => {
	const { pool, browser, sessionFile, key, dir } = setup();
	const live = await pool.open({ kind: "resume", sessionFile }, async () => tmpdir());
	const moved = join(dir, "elsewhere.jsonl");
	// omp's `/move` takes the file along: the old one is gone.
	renameSync(sessionFile, moved);
	await live.rpc({ type: "prompt", message: `/move ${moved}` });
	await live.refreshState();
	await until(() => browser.moves.length > 0);
	expect(browser.moves).toEqual([[key, sessionKey(moved)]]);
});

test("the endpoints are written again when the server learns its address or the browser is installed", async () => {
	const { pool, browser, sessionFile, key, overlayFile } = setup();
	browser.installed = false;
	await pool.open({ kind: "resume", sessionFile }, async () => tmpdir());
	expect(browserIn(overlayFile())).toEqual({ relay: false });

	browser.installed = true;
	browser.origin = "http://127.0.0.1:2222";
	await pool.syncBrowser();
	expect(browserIn(overlayFile())).toEqual({ cdpUrl: `http://127.0.0.1:2222/browser-cdp${key}`, relay: false });
});

test("a browser turned off turns omp's browser tool off, a new chat's from its first turn, until it is turned on", async () => {
	const { pool, browser, sessionFile, key, overlayFile, logged } = setup();
	browser.off = true;
	await pool.open({ kind: "new", cwd: tmpdir() }, async () => null);
	const fresh = overlayFile();
	expect(browserIn(fresh)).toEqual({ enabled: false, relay: false });

	await pool.open({ kind: "resume", sessionFile }, async () => tmpdir());
	const resumed = logged()
		.filter((l) => l.argv)
		.at(-1)
		?.argv?.at(-1) as string;
	expect(resumed).not.toBe(fresh);
	expect(browserIn(resumed)).toEqual({ enabled: false, relay: false });

	browser.off = false;
	await pool.syncBrowser();
	expect(browserIn(resumed)).toEqual({ cdpUrl: `${browser.origin}/browser-cdp${key}`, relay: false });
	expect(browserIn(fresh)?.enabled).toBeUndefined();
});

test("a paused conversation's record keeps a browser turned off", () => {
	const store = new ParkedStore(scratch());
	store.save({
		version: 2,
		liveId: "L1",
		omp: { pid: 1, identity: "a" },
		relay: { pid: 2, identity: "b" },
		socket: "/tmp/x.sock",
		owner: null,
		cwd: "/",
		args: [],
		env: {},
		mode: "full",
		startedAt: 0,
		pausedAt: 1,
		sessionFile: null,
		sessionId: null,
		streaming: false,
		overlay: { file: "/tmp/L1.yml", mode: null, browserCdpUrl: false },
		interviewing: false,
		pendingUI: [],
		descendants: [],
	});
	expect(store.list()[0].overlay?.browserCdpUrl).toBe(false);
});
