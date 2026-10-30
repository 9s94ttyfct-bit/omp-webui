import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type Browser, type BrowserContext, expect, type Page } from "@playwright/test";
import type { LiveListing } from "../../shared/protocol.ts";
import { AUD, claims, EMAIL, makeKey, sign, startJwks, TEAM } from "./access-jwt.ts";
import { ACCESS_COOKIE, type AccessTunnel, startAccessTunnel } from "./access-tunnel.ts";
import { writeChatSession } from "./chat-session.ts";
import { sessionRow } from "./live.ts";
import { endAllLives } from "./lives.ts";
import type { Frame } from "./omp-frames.ts";
import { startTestServer, type TestServer } from "./server.ts";
import { writeSyncOmp } from "./sync-omp-bin.ts";
import { connect, request } from "./ws.ts";

/**
 * The app as a person has it on two screens: the Mac app's own window (a page of the server at `server.url`) and a page
 * through Cloudflare Access (the stand-in for the tunnel, `access-tunnel.ts`, and a signed Access session), both on one
 * server whose omp is a stand-in a test conducts (`sync-omp.ts`). Nothing is faked in either page or in the server; a
 * test drives each page as a person does and says what omp does with `conduct`.
 */

const HOSTNAME = "omp.example.com";

/** The two pages, named by where they came in. */
export interface Sides {
	local: Page;
	remote: Page;
}

export type Side = keyof Sides;

/** The other one. */
export const other = (side: Side): Side => (side === "local" ? "remote" : "local");

export const SIDES: readonly Side[] = ["local", "remote"];

/** The page shows the conversation `title`, opened from the list as a person opens one. */
export async function show(page: Page, title: string): Promise<void> {
	await sessionRow(page, title).click();
	await expect(page.getByTestId("composer")).toBeVisible();
}

/**
 * Both pages show the conversation `title` (a seeded one, `n`), and a turn runs on it, begun by a message `starter`'s page
 * sent: resolves with the process, once both pages show the message (omp has taken it up).
 */
export async function runningTurn(world: World, browser: Browser, n: number, title: string, starter: Side) {
	const file = world.seed(n, title);
	const pages = await world.open(browser);
	await show(pages.local, title);
	await show(pages.remote, title);
	await pages[starter].getByTestId("composer").fill(`Begin ${title}`);
	await pages[starter].getByTestId("composer").press("Enter");
	const liveId = await world.turnOf(file);
	for (const side of SIDES) await expect(pages[side].getByText(`Begin ${title}`)).toBeVisible();
	return { pages, liveId, file };
}

/** What the init script of a page (see `World.open`) leaves in it, for `World.disconnect`. */
declare global {
	interface Window {
		ompwSockets: {
			hold(on: boolean): void;
			cut(): void;
			lag(ms: number): void;
			slow(on: boolean): void;
			release(): void;
		};
	}
}

/**
 * What the page says on its socket takes `ms` longer to leave from now on (the way across the world to a tunnel's edge):
 * a conversation's file, read over HTTP, arrives well before what a chain of socket requests brings (find the process,
 * attach, read its state), as it does for a page that is far from its server.
 */
export async function lag(page: Page, ms: number): Promise<void> {
	await page.evaluate((ms) => window.ompwSockets.lag(ms), ms);
}

/** What the server's omp was sent, in order (`FAKE_OMP_LOG`): one command per entry. */
export type Received = Record<string, unknown> & { type: string };

export interface World {
	server: TestServer;
	tunnel: AccessTunnel;
	/** Both pages, in contexts of their own (the origins differ, so nothing but the server is shared), looking at nothing yet. */
	open(browser: Browser): Promise<Sides & { close(options?: { keepProcesses?: boolean }): Promise<void> }>;
	/** A conversation of the spec's own, in the server's work folder; returns its file. */
	seed(n: number, title: string, turns?: { prompt: string; reply: string }[]): string;
	/** The id of the process that runs the conversation of `file` (waits for it to start). */
	liveOf(file: string): Promise<string>;
	/** The id of the process that runs the conversation of `file` once omp has taken a turn (the message a page sent has reached it: what the test says next comes after it). */
	turnOf(file: string): Promise<string>;
	/** The id of the process that is working on a turn (waits for one to start): what a new chat's first message makes of its process. */
	newLive(): Promise<string>;
	/** Every process the server holds. */
	lives(): Promise<LiveListing[]>;
	/** Print frames, as omp does; the server hears them like any other. */
	emit(liveId: string, ...frames: Frame[]): Promise<void>;
	/** Change what omp's `get_state` says (`todoPhases`, `contextUsage`, `subagents`…). */
	state(liveId: string, patch: Record<string, unknown>): Promise<void>;
	/** The turn ends as omp ends it; a queued message becomes the next turn. */
	finish(liveId: string): Promise<void>;
	/** From now on this conversation's omp takes no abort command (it answers none and ends nothing), as a process that hangs does. */
	deaf(liveId: string): Promise<void>;
	/**
	 * The page's connection to the server goes away (a laptop that sleeps, a network that changes) and stays away until
	 * `reconnect`, so that what happens meanwhile is missed; the page connects again by itself then. The remote page loses
	 * the way through the tunnel; the local page's sockets are closed and its new ones refused.
	 */
	disconnect(side: Side, pages: Sides): Promise<void>;
	/** The way is open again: the page that was disconnected connects again by itself. */
	reconnect(side: Side, pages: Sides): Promise<void>;
	/**
	 * The page's next connection to the server (the one a reload makes) is slow to be made: the page is loaded and
	 * shows what the server's files say, and knows nothing of what omp does, until `endDelay`. Call before the reload.
	 */
	delayConnection(side: Side, pages: Sides): Promise<void>;
	/** The connection of the page that `delayConnection` held is made. */
	endDelay(side: Side, pages: Sides): Promise<void>;
	/** The commands omp has received from the pages (not the conductor's own) since the pages were last opened. */
	received(): Received[];
	/** The server ends and starts again as the app does when it is quit and opened (a conversation waiting out a usage limit stays; the rest end). */
	restart(): Promise<void>;
	stop(): Promise<void>;
}

export async function startWorld(): Promise<World> {
	const root = mkdtempSync(join(tmpdir(), "ompw-livesync-"));
	const key = await makeKey("livesync-key");
	const jwks = await startJwks([key]);
	const jwt = await sign(key, claims(Math.floor(Date.now() / 1000), { exp: Math.floor(Date.now() / 1000) + 3600 }));
	const settings = join(root, "remote.json");
	// A remote.json as an earlier version wrote it, which asked for every tool while a remote page was open: that
	// switch is gone, and the key is read and ignored (a page through the tunnel changes nothing about a conversation).
	writeFileSync(
		settings,
		JSON.stringify({ enabled: true, hostname: HOSTNAME, team: TEAM, aud: AUD, emails: [EMAIL], askWhileRemote: true }),
	);
	const log = join(root, "omp.log");
	writeFileSync(log, "");
	const server = await startTestServer(
		0,
		{
			OMP_BIN: writeSyncOmp(root),
			FAKE_OMP_LOG: log,
			OMP_WEBUI_REMOTE_CONFIG: settings,
			OMP_WEBUI_ACCESS_CERTS_URL: jwks.url,
		},
		{ login: false },
	);
	const tunnel = await startAccessTunnel(Number(new URL(server.url).port), { hostname: HOSTNAME });
	let ws = await connect(server);
	/** How much of the log the pages that are open now did not write: `received` starts there. */
	let logFrom = 0;
	const logged = (): { in: Received }[] =>
		readFileSync(log, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));

	const lives = () => request<LiveListing[]>(ws, { t: "list_lives" });
	const world: World = {
		server,
		tunnel,
		async open(browser) {
			logFrom = logged().length;
			const contexts: BrowserContext[] = [];
			const pageIn = async (url: string, cookies: Parameters<BrowserContext["addCookies"]>[0]): Promise<Page> => {
				const context = await browser.newContext();
				contexts.push(context);
				await context.addCookies(cookies);
				// A page's sockets can be cut, refused and slowed from the test (`disconnect`, `lag`): the app's own are made as ever.
				await context.addInitScript(() => {
					const Native = window.WebSocket;
					const made: WebSocket[] = [];
					// Kept for the tab: a reload finds the way as it was left (`disconnect` / `lag` before it).
					const kept = (key: string): string | null => {
						try {
							return sessionStorage.getItem(key);
						} catch {
							return null;
						}
					};
					const keep = (key: string, value: string | null) => {
						try {
							if (value === null) sessionStorage.removeItem(key);
							else sessionStorage.setItem(key, value);
						} catch {
							// no storage on this document: the way is as it was made, for this document only
						}
					};
					let held = kept("ompwHold") === "1";
					let late = Number(kept("ompwLag") ?? 0);
					// A socket made while the way is slow is open for the browser and silent for the page: what happens on it
					// (its opening, what the server sends) reaches the page only when `release` is called.
					let slow = kept("ompwSlow") === "1";
					const parked: (() => void)[] = [];
					Object.assign(window, {
						ompwSockets: {
							hold: (on: boolean) => {
								held = on;
								keep("ompwHold", on ? "1" : null);
							},
							cut: () => {
								for (const s of made) s.close();
							},
							lag: (ms: number) => {
								late = ms;
								keep("ompwLag", ms > 0 ? String(ms) : null);
							},
							slow: (on: boolean) => {
								slow = on;
								keep("ompwSlow", on ? "1" : null);
							},
							release: () => {
								slow = false;
								keep("ompwSlow", null);
								for (const deliver of parked.splice(0)) deliver();
							},
						},
					});
					window.WebSocket = class extends Native {
						constructor(url: string | URL, protocols?: string | string[]) {
							super(held ? "ws://127.0.0.1:9/ws" : url, protocols);
							made.push(this);
							const slowAtBirth = slow;
							for (const type of ["open", "message", "error", "close"] as const) {
								let handler: ((e: Event) => void) | null = null;
								Object.defineProperty(this, `on${type}`, {
									configurable: true,
									get: () => handler,
									set: (fn: ((e: Event) => void) | null) => {
										handler = fn;
									},
								});
								this.addEventListener(type, (e) => {
									const deliver = () => handler?.call(this, e);
									if (slowAtBirth && (slow || parked.length > 0)) parked.push(deliver);
									else deliver();
								});
							}
						}

						override send(data: Parameters<WebSocket["send"]>[0]): void {
							if (late > 0) setTimeout(() => super.send(data), late);
							else super.send(data);
						}
					};
				});
				await context.addInitScript((cwd) => {
					localStorage.setItem("ompw.cwd", cwd);
					localStorage.setItem("ompw.autoTitle", "off");
				}, server.work);
				const page = await context.newPage();
				await page.goto(url);
				// New chat's omp is up and has said which model it runs: what is typed now is not lost to a page still loading.
				await expect(page.getByTestId("model-picker")).toContainText("Opus 5.5");
				return page;
			};
			const local = await pageIn(`${server.url}/?token=${server.accessToken}`, []);
			const remote = await pageIn(tunnel.url, [{ name: ACCESS_COOKIE, value: jwt, url: tunnel.url, httpOnly: true }]);
			// What a test leaves running ends with its pages: the next one finds the server without a process for its conversation.
			const close = async (options: { keepProcesses?: boolean } = {}) => {
				await Promise.all(contexts.map((c) => c.close()));
				if (!options.keepProcesses) await endAllLives(server);
			};
			return { local, remote, close };
		},
		seed(n, title, turns = [{ prompt: "hello", reply: "hi" }]) {
			return writeChatSession(server.agentDir, { n, title, cwd: server.work, turns });
		},
		async liveOf(file) {
			const name = basename(file);
			return await waitFor(
				() => lives().then((l) => l.find((p) => !p.exited && p.sessionFile?.endsWith(name))?.liveId),
				`a process for ${name}`,
			);
		},
		async turnOf(file) {
			const name = basename(file);
			return await waitFor(
				() => lives().then((l) => l.find((p) => !p.exited && p.streaming && p.sessionFile?.endsWith(name))?.liveId),
				`a turn on ${name}`,
			);
		},
		async newLive() {
			return await waitFor(() => lives().then((l) => l.find((p) => !p.exited && p.streaming)?.liveId), "a turn");
		},
		lives,
		async emit(liveId, ...frames) {
			await request(ws, { t: "rpc", liveId, command: { type: "sync_emit", frames } });
		},
		async state(liveId, patch) {
			await request(ws, { t: "rpc", liveId, command: { type: "sync_state", patch } });
		},
		async finish(liveId) {
			await request(ws, { t: "rpc", liveId, command: { type: "sync_finish" } });
		},
		async deaf(liveId) {
			await request(ws, { t: "rpc", liveId, command: { type: "sync_deaf" } });
		},
		received() {
			return logged()
				.slice(logFrom)
				.map((l) => l.in)
				.filter((c) => !c.type.startsWith("sync_"));
		},
		async disconnect(side, pages) {
			if (side === "remote") {
				tunnel.holdUpgrades = true;
				tunnel.drop();
				return;
			}
			await pages.local.evaluate(() => {
				window.ompwSockets.hold(true);
				window.ompwSockets.cut();
			});
		},
		async reconnect(side, pages) {
			if (side === "remote") {
				tunnel.holdUpgrades = false;
				return;
			}
			await pages.local.evaluate(() => {
				window.ompwSockets.hold(false);
			});
		},
		async delayConnection(side, pages) {
			await pages[side].evaluate(() => window.ompwSockets.slow(true));
		},
		async endDelay(side, pages) {
			await pages[side].evaluate(() => window.ompwSockets.release());
		},
		async restart() {
			ws.close();
			await server.restart();
			ws = await connect(server);
		},
		async stop() {
			ws.close();
			await tunnel.stop();
			await server.stop();
			jwks.stop();
			rmSync(root, { recursive: true, force: true });
		},
	};
	return world;
}

/** What `look` finds, polled for up to 30 s; throws saying what was waited for. */
async function waitFor<T>(look: () => Promise<T | undefined>, what: string): Promise<T> {
	for (let i = 0; i < 300; i++) {
		const found = await look();
		if (found !== undefined) return found;
		await sleep(100);
	}
	throw new Error(`waited for ${what}`);
}
