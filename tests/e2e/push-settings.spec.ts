import { PREF, type PrefsSnapshot, PUSH_DEVICE_KEY } from "../../shared/prefs.ts";
import type { PushList } from "../../shared/push.ts";
import { newReceiver } from "../support/push-receiver.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Locator, type Page, test } from "./fixtures.ts";

/**
 * Settings › Notifications when this page is closed (#629), against the real server. What a browser gives the page (a service
 * worker that can be registered, a push manager that subscribes, `Notification`) is a stand-in that makes real P-256 keys, so the
 * server checks a real subscription; the endpoint is a Firebase one it accepts, and nothing is ever sent to it: "Send a test" is
 * answered in the browser (`page.route`), and every test ends with no device on the server. The service worker itself is
 * `tests/unit/service-worker.test.ts`, and the sending `tests/contract/push.test.ts`.
 */

declare global {
	interface Window {
		__push: { asked: number; registered: string[]; subscribed: number; unsubscribed: number };
	}
}

interface Browser {
	/** What `Notification.permission` is when the page opens (it is kept across reloads, as a browser keeps it). */
	permission?: "default" | "granted" | "denied";
	/** What the person answers when the browser asks. */
	answer?: "granted" | "denied";
	/** The page runs as a Home Screen app (`navigator.standalone`). */
	standalone?: boolean;
	/** No service worker and no push manager: a browser that has neither. */
	without?: boolean;
}

/** Before `page.goto`: the push parts of a browser, as stand-ins that keep what they were asked. */
async function pushBrowser(page: Page, o: Browser = {}) {
	await page.addInitScript(
		([initial, answer, standalone, without]) => {
			if (standalone) Object.defineProperty(navigator, "standalone", { value: true, configurable: true });
			if (without) {
				Reflect.deleteProperty(Navigator.prototype, "serviceWorker");
				Reflect.deleteProperty(window, "PushManager");
				return;
			}
			const PERMISSION = "e2e-push-permission";
			const SUBSCRIPTION = "e2e-push-subscription";
			const state = { asked: 0, registered: [] as string[], subscribed: 0, unsubscribed: 0 };
			window.__push = state;
			const b64u = (bytes: ArrayBuffer | Uint8Array): string =>
				btoa(String.fromCharCode(...new Uint8Array(bytes)))
					.replaceAll("+", "-")
					.replaceAll("/", "_")
					.replaceAll("=", "");
			const fromB64u = (text: string): Uint8Array =>
				Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
			interface Kept {
				endpoint: string;
				p256dh: string;
				auth: string;
				key: string;
			}
			const subscriptionOf = (kept: Kept) => ({
				endpoint: kept.endpoint,
				options: { applicationServerKey: fromB64u(kept.key).buffer },
				toJSON: () => ({ endpoint: kept.endpoint, keys: { p256dh: kept.p256dh, auth: kept.auth } }),
				unsubscribe: async () => {
					localStorage.removeItem(SUBSCRIPTION);
					state.unsubscribed++;
					return true;
				},
			});
			const registration = {
				pushManager: {
					getSubscription: async () => {
						const raw = localStorage.getItem(SUBSCRIPTION);
						return raw === null ? null : subscriptionOf(JSON.parse(raw) as Kept);
					},
					subscribe: async (options: { applicationServerKey: Uint8Array }) => {
						state.subscribed++;
						const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
						const kept: Kept = {
							endpoint: `https://fcm.googleapis.com/fcm/send/e2e-${crypto.randomUUID()}`,
							p256dh: b64u(await crypto.subtle.exportKey("raw", pair.publicKey)),
							auth: b64u(crypto.getRandomValues(new Uint8Array(16))),
							key: b64u(options.applicationServerKey),
						};
						localStorage.setItem(SUBSCRIPTION, JSON.stringify(kept));
						return subscriptionOf(kept);
					},
				},
			};
			Object.defineProperty(navigator, "serviceWorker", {
				configurable: true,
				value: {
					register: async (url: string, options: { scope: string }) => {
						state.registered.push(`${url} ${options.scope}`);
						return registration;
					},
					ready: Promise.resolve(registration),
					getRegistration: async () => registration,
					addEventListener: () => {},
					removeEventListener: () => {},
				},
			});
			Object.defineProperty(window, "PushManager", { configurable: true, value: class PushManager {} });
			const current = () => localStorage.getItem(PERMISSION) ?? initial;
			class StubNotification {
				static get permission() {
					return current();
				}
				static requestPermission = async () => {
					state.asked++;
					if (current() === "default") localStorage.setItem(PERMISSION, answer);
					return current();
				};
				close() {}
			}
			Object.defineProperty(window, "Notification", { configurable: true, value: StubNotification });
		},
		[o.permission ?? "default", o.answer ?? "granted", o.standalone ?? false, o.without ?? false] as const,
	);
}

const card = (page: Page) => page.getByTestId("push-settings");
const enable = (page: Page) => page.getByTestId("push-enable");
const rows = (page: Page) => page.getByTestId("push-device");
const status = (page: Page) => page.getByTestId("push-status");

const api = (page: Page, path: string, data?: unknown) =>
	data === undefined
		? page.request.get(path)
		: page.request.post(path, { data, headers: { "x-omp-webui": "1", "content-type": "application/json" } });
const devices = async (page: Page) => ((await (await api(page, "/api/push")).json()) as PushList).devices;

/** A switch that changes when the server has answered, not at the click: `check()` would insist on the change at once. */
const turnOn = async (switchOf: Locator) => {
	await switchOf.click();
	await expect(switchOf).toBeChecked();
};
const turnOff = async (switchOf: Locator) => {
	await switchOf.click();
	await expect(switchOf).not.toBeChecked();
};

/** The page of Settings, and the card in front once it has loaded the list. */
async function openCard(page: Page) {
	await page.goto("/#/settings/chats");
	await expect(card(page)).toBeVisible();
	await expect(page.getByTestId("push-none").or(page.getByTestId("push-devices"))).toBeVisible();
}

test.afterEach(async ({ page }) => {
	// No device and no notification setting is left on the worker's server, whatever the test did: nothing may ever be pushed to
	// the endpoints made here.
	await api(page, "/api/push/revoke-all", {});
	await api(page, "/api/prefs", { changes: { [PREF.notify]: null } });
});

test("a browser with no service worker is told it cannot be notified, and nothing offers to", async ({ page }) => {
	await pushBrowser(page, { without: true });
	await page.goto("/#/settings/chats");
	await expect(card(page)).toBeVisible();
	const why = page.getByTestId("push-unsupported");
	await expect(why).toHaveAttribute("data-why", "unsupported");
	await expect(why).toContainText("cannot receive notifications when the page is closed");
	await expect(enable(page)).toHaveCount(0);
	await expect(page.getByTestId("push-none")).toBeVisible();
});

test.describe("an iPhone", () => {
	test.use({
		userAgent:
			"Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
	});

	test("in a Safari tab is told to add the page to the Home Screen first", async ({ page }) => {
		await pushBrowser(page, { without: true });
		await page.goto("/#/settings/chats");
		const why = page.getByTestId("push-unsupported");
		await expect(why).toHaveAttribute("data-why", "needsApp");
		await expect(why).toContainText("Add to Home Screen");
		await expect(enable(page)).toHaveCount(0);
	});

	test("in the Home Screen app can turn it on, and the device is named for what it is", async ({ page }) => {
		await pushBrowser(page, { standalone: true });
		await openCard(page);
		await turnOn(enable(page));
		await expect(rows(page)).toHaveCount(1);
		await expect(rows(page).getByText("iPhone · Safari (app)")).toBeVisible();
		expect((await devices(page)).map((d) => d.label)).toEqual(["iPhone · Safari (app)"]);
	});
});

test("turning it on asks permission, registers the worker, subscribes, lists this device, and says where the page stands", async ({
	page,
}) => {
	await pushBrowser(page);
	const tap = await tapSocket(page);
	await openCard(page);
	await expect(enable(page)).not.toBeChecked();
	await expect(page.getByTestId("push-state")).toHaveAttribute("data-on", "off");

	await turnOn(enable(page));
	await expect(enable(page)).toBeChecked();
	await expect(page.getByTestId("push-state")).toHaveAttribute("data-on", "on");
	await expect(rows(page)).toHaveCount(1);
	await expect(rows(page).getByText("This device")).toBeVisible();
	expect(await page.evaluate(() => window.__push)).toMatchObject({ asked: 1, registered: ["/sw.js /"], subscribed: 1 });

	// The server has one device, whose subscription it checked, and the page has its own name for it.
	const [mine] = await devices(page);
	expect(mine.preview).toBe(false);
	expect(mine.lastSentAt).toBeNull();
	const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), PUSH_DEVICE_KEY);
	expect(stored).toMatchObject({ id: mine.id });
	expect(stored.device).toMatch(/^[0-9a-f]{24}$/);
	// The notification setting went on with it: the server pushes only while it is on.
	await expect
		.poll(async () => ((await (await api(page, "/api/prefs")).json()) as PrefsSnapshot).values[PREF.notify])
		.toBe("on");
	// The page is in use, and says so to the server, with what it shows (the Settings page: no conversation).
	await expect
		.poll(() => tap.sent.filter((m) => m.t === "presence"))
		.toContainEqual({ t: "presence", device: stored.device, visible: true, liveId: null, file: null });

	// A page opened later finds itself subscribed, with no second subscription made.
	await page.reload();
	await expect(card(page)).toBeVisible();
	await expect(enable(page)).toBeChecked();
	await expect(rows(page)).toHaveCount(1);
	expect(await page.evaluate(() => window.__push.subscribed)).toBe(0);
	expect(await devices(page)).toHaveLength(1);
});

test("turning it off takes the device off the server and ends the browser's own subscription", async ({ page }) => {
	await pushBrowser(page);
	await openCard(page);
	await turnOn(enable(page));
	await expect(rows(page)).toHaveCount(1);

	await turnOff(enable(page));
	await expect(enable(page)).not.toBeChecked();
	await expect(page.getByTestId("push-none")).toBeVisible();
	expect(await devices(page)).toEqual([]);
	expect(await page.evaluate((key) => localStorage.getItem(key), PUSH_DEVICE_KEY)).toBeNull();
	expect(await page.evaluate(() => window.__push.unsubscribed)).toBe(1);
});

test("a person who says no is told where to allow notifications, and a browser that has them blocked offers no switch to turn on", async ({
	page,
}) => {
	await pushBrowser(page, { answer: "denied" });
	await openCard(page);
	// `click`: `check()` would insist on the switch ending up on.
	await enable(page).click();
	await expect(page.getByTestId("push-error")).toContainText("Notifications are blocked for this site");
	await expect(enable(page)).not.toBeChecked();
	await expect(enable(page)).toBeDisabled();
	await expect(page.getByTestId("push-state")).toContainText("blocked");
	expect(await devices(page)).toEqual([]);

	// Blocked from the start: the same, before anything is tried.
	const blocked = await page.context().newPage();
	await pushBrowser(blocked, { permission: "denied" });
	await blocked.goto("/#/settings/chats");
	await expect(enable(blocked)).toBeDisabled();
	await expect(blocked.getByTestId("push-state")).toContainText("blocked");
});

test("the preview of a device is a switch of its own, kept by the server", async ({ page }) => {
	await pushBrowser(page);
	await openCard(page);
	await turnOn(enable(page));
	await expect(rows(page)).toHaveCount(1);
	const preview = rows(page).getByTestId("push-preview");
	await expect(preview).not.toBeChecked();
	await turnOn(preview);
	await expect(preview).toBeChecked();
	expect((await devices(page))[0].preview).toBe(true);
	await page.reload();
	await expect(rows(page).getByTestId("push-preview")).toBeChecked();
	await turnOff(rows(page).getByTestId("push-preview"));
	await expect(rows(page).getByTestId("push-preview")).not.toBeChecked();
	expect((await devices(page))[0].preview).toBe(false);
});

test("a test notification says whether the push service took it, and what it refused with", async ({ page }) => {
	await pushBrowser(page);
	await openCard(page);
	await turnOn(enable(page));
	await expect(rows(page)).toHaveCount(1);

	let answer: { ok: boolean; status: number } | { error: string } = { ok: true, status: 201 };
	let code = 200;
	await page.route("**/api/push/test", (route) =>
		route.fulfill({ status: code, contentType: "application/json", body: JSON.stringify(answer) }),
	);
	await rows(page).getByTestId("push-test").click();
	await expect(status(page)).toHaveAttribute("data-state", "done");
	await expect(status(page)).toContainText("Sent");

	answer = { ok: false, status: 503 };
	await rows(page).getByTestId("push-test").click();
	await expect(page.getByTestId("push-error")).toContainText("The push service refused it (503).");

	answer = { ok: false, status: 410 };
	await rows(page).getByTestId("push-test").click();
	await expect(page.getByTestId("push-error")).toContainText("no longer known to its push service");

	// The server's cooldown: its sentence is English, and the page says it in its own language.
	code = 429;
	answer = { error: "A test was sent a moment ago; wait a few seconds and try again" };
	await rows(page).getByTestId("push-test").click();
	await expect(page.getByTestId("push-error")).toHaveText(
		"A test was sent a moment ago. Wait a few seconds and try again.",
	);
});

test("other devices are listed too; each can be revoked, and so can all", async ({ page }) => {
	await pushBrowser(page);
	// Two more browsers subscribed to this server, with keys of their own.
	for (const [i, label] of ["Pixel · Chrome", "Mac · Firefox"].entries()) {
		const res = await api(page, "/api/push/subscribe", {
			subscription: {
				endpoint: `https://fcm.googleapis.com/fcm/send/e2e-other-${i}`,
				keys: newReceiver().keys,
			},
			device: `e2e-other-device-${String(i).padStart(10, "0")}`,
			label,
			lang: "en",
		});
		expect(res.ok()).toBe(true);
	}
	await openCard(page);
	await expect(rows(page)).toHaveCount(2);
	await expect(rows(page).getByText("This device")).toHaveCount(0);
	await expect(enable(page)).not.toBeChecked();

	await rows(page).filter({ hasText: "Pixel · Chrome" }).getByTestId("push-revoke").click();
	await expect(rows(page)).toHaveCount(1);
	await expect(rows(page).first()).toContainText("Mac · Firefox");
	// One device is not "all": the button comes with two.
	await expect(page.getByTestId("push-revoke-all")).toHaveCount(0);

	await turnOn(enable(page));
	await expect(rows(page)).toHaveCount(2);
	await page.getByTestId("push-revoke-all").click();
	await expect(page.getByTestId("push-none")).toBeVisible();
	await expect(enable(page)).not.toBeChecked();
	expect(await devices(page)).toEqual([]);
	expect(await page.evaluate((key) => localStorage.getItem(key), PUSH_DEVICE_KEY)).toBeNull();
});

test("a device revoked from another page is no longer this page's: it finds out when it opens", async ({ page }) => {
	await pushBrowser(page);
	await openCard(page);
	await turnOn(enable(page));
	await expect(rows(page)).toHaveCount(1);
	await api(page, "/api/push/revoke-all", {});
	await page.reload();
	await expect(card(page)).toBeVisible();
	await expect(enable(page)).not.toBeChecked();
	await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), PUSH_DEVICE_KEY)).toBeNull();
});

test("in Chinese the card, its states and its answers are in Chinese", async ({ page }) => {
	await pushBrowser(page, { without: true });
	await page.goto("/#/settings/chats");
	await expect(card(page)).toBeVisible();
	try {
		// The language is on the Look page, the card on Chats.
		await page.locator('[data-testid="settings-page-tab"][data-page="look"]').click();
		await page.getByTestId("language").selectOption("zh-CN");
		await page.locator('[data-testid="settings-page-tab"][data-page="chats"]').click();
		await expect(card(page)).toContainText("页面关闭时的通知");
		await expect(page.getByTestId("push-unsupported")).toContainText("这个浏览器无法在页面关闭时接收通知。");
		await expect(page.getByTestId("push-none")).toHaveText("还没有设备。");
		await expect(card(page)).not.toContainText("Notifications when this page is closed");
	} finally {
		await page.locator('[data-testid="settings-page-tab"][data-page="look"]').click();
		await page.getByTestId("language").selectOption("en");
	}
});
