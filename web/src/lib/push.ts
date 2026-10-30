import {
	cleanLabel,
	deviceLabel,
	PUSH_API,
	type PushList,
	type PushSubscribeBody,
	type PushSubscribed,
	type PushTested,
} from "@shared/push.ts";
import { useLang } from "../i18n/index.ts";
import { ApiError } from "./api.ts";
import { setNotifications } from "./attention.ts";
import { pushDevice, rememberPushDevice } from "./push-presence.ts";
import { inShell } from "./shell-notify.ts";

/**
 * Turning Web Push on and off for this browser, and the devices the server notifies (Settings › Notifications when this page is
 * closed). Imported only by that card's chunk; what runs on every page is `push-presence.ts`.
 */

/** Why this browser cannot be notified when no page is open, or that it can. */
export type PushSupport = "ok" | "macApp" | "needsHttps" | "needsApp" | "unsupported";

/** Whether this page runs as an iPhone or iPad home-screen app (`navigator.standalone` is Safari's own flag). */
const standalone = (): boolean =>
	(navigator as Navigator & { standalone?: boolean }).standalone === true ||
	matchMedia("(display-mode: standalone)").matches;

/** An iPhone or iPad, one that asks for desktop sites (an iPad says it is a Mac) included. */
const onApple = (): boolean =>
	/iPhone|iPad|iPod/.test(navigator.userAgent) ||
	(/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

export function pushSupport(): PushSupport {
	// The macOS app's web view has no service workers; the app shows notifications itself.
	if (inShell()) return "macApp";
	if (!window.isSecureContext) return "needsHttps";
	if ("serviceWorker" in navigator && "PushManager" in window && "Notification" in window) return "ok";
	// Safari on an iPhone or iPad offers push to a Home Screen app only: in a tab the objects are not there.
	return onApple() && !standalone() ? "needsApp" : "unsupported";
}

/** The server refused or failed: its sentence, for the page to show. */
async function request<T>(path: string, body?: unknown): Promise<T> {
	const res = await fetch(path, {
		method: body === undefined ? "GET" : "POST",
		headers: body === undefined ? undefined : { "content-type": "application/json", "x-omp-webui": "1" },
		body: body === undefined ? undefined : JSON.stringify(body),
		cache: "no-store",
	});
	const answer: { error?: unknown; code?: string } = await res.json().catch(() => ({}));
	if (res.ok) return answer as T;
	throw new ApiError(typeof answer.error === "string" ? answer.error : res.statusText, res.status, answer.code);
}

export const pushApi = {
	list: () => request<PushList>(PUSH_API),
	subscribe: (body: PushSubscribeBody) => request<PushSubscribed>(`${PUSH_API}/subscribe`, body),
	unsubscribe: (device: string) => request<{ removed: boolean }>(`${PUSH_API}/unsubscribe`, { device }),
	revoke: (id: string) => request<{ removed: boolean }>(`${PUSH_API}/revoke`, { id }),
	revokeAll: () => request<{ removed: number }>(`${PUSH_API}/revoke-all`, {}),
	preview: (id: string, preview: boolean) => request<{ ok: boolean }>(`${PUSH_API}/preview`, { id, preview }),
	test: (id: string) => request<PushTested>(`${PUSH_API}/test`, { id }),
};

/** The notifications of this site were refused by the person (or by the system). */
export class PushBlocked extends Error {}

/** The bytes of a base64url string. */
function bytesOf(text: string): Uint8Array {
	const padded = text
		.replaceAll("-", "+")
		.replaceAll("_", "/")
		.padEnd(Math.ceil(text.length / 4) * 4, "=");
	return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

const sameBytes = (a: ArrayBuffer | null, b: Uint8Array): boolean =>
	a !== null && a.byteLength === b.length && new Uint8Array(a).every((v, i) => v === b[i]);

/** A name this browser gives itself: 24 random hex digits, kept in the browser, and what presence says (`PUSH_DEVICE_ID`). */
const newDeviceName = (): string =>
	Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Turn Web Push on for this browser: ask permission (from the click that called this: iOS refuses to ask otherwise), register the
 * service worker, subscribe against the server's key, tell the server, and turn the notification setting on (the server pushes only
 * while Settings has notifications on). Throws `PushBlocked` when the person says no.
 */
export async function enablePush(preview = false): Promise<void> {
	const permission =
		Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
	if (permission !== "granted") throw new PushBlocked(permission);
	const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
	await navigator.serviceWorker.ready;
	const { publicKey } = await pushApi.list();
	const key = bytesOf(publicKey);
	let subscription = await registration.pushManager.getSubscription();
	// A subscription made against another key (the server's key was made again) is no use: no push service takes its messages.
	if (subscription && !sameBytes(subscription.options.applicationServerKey, key)) {
		await subscription.unsubscribe();
		subscription = null;
	}
	subscription ??= await registration.pushManager.subscribe({
		userVisibleOnly: true,
		applicationServerKey: key as BufferSource,
	});
	const json = subscription.toJSON();
	if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error("The browser gave no subscription");
	const device = pushDevice()?.device ?? newDeviceName();
	const made = await pushApi.subscribe({
		subscription: { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } },
		device,
		label: cleanLabel(deviceLabel(navigator.userAgent, navigator.maxTouchPoints, standalone())),
		lang: useLang.getState().lang,
		preview,
	});
	rememberPushDevice({ device, id: made.id });
	await setNotifications(true);
}

/** The browser's own subscription, ended. */
async function dropSubscription(): Promise<void> {
	if (!("serviceWorker" in navigator)) return;
	const registration = await navigator.serviceWorker.getRegistration("/");
	await (await registration?.pushManager.getSubscription())?.unsubscribe();
}

/** Turn Web Push off for this browser: the server forgets the device and the browser its subscription. */
export async function disablePush(): Promise<void> {
	const ref = pushDevice();
	if (ref) await pushApi.unsubscribe(ref.device);
	await dropSubscription();
	rememberPushDevice(null);
}

/** Take one device off the server's list; this browser's own subscription goes with it when it is this browser's. */
export async function revokeDevice(id: string): Promise<void> {
	await pushApi.revoke(id);
	if (pushDevice()?.id === id) {
		await dropSubscription();
		rememberPushDevice(null);
	}
}

/** Take every device off the list, this browser's included. */
export async function revokeAllDevices(): Promise<void> {
	await pushApi.revokeAll();
	await dropSubscription();
	rememberPushDevice(null);
}
