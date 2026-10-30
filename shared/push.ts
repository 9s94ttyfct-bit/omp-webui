import type { NoticeLang } from "./attention.ts";
import { isRecord } from "./guards.ts";

/**
 * Web Push (#629): a notification that reaches a phone or a computer whose page is closed. The server sends it to the
 * push service of the browser's maker (Apple, Google, Mozilla, Microsoft), which holds it until the device is on; a small
 * service worker (`web/public/sw.js`) shows it. What the page and the server say to each other about it is here.
 *
 * What a person turns on is a *device*: one browser profile, or one home-screen app, with the subscription its browser made.
 * The server keeps the list (`server/push/devices.ts`), Settings shows it with a way to revoke each, and a conversation is not
 * pushed to a device whose page is in use and shows that conversation: the page says so over the socket (`presence`).
 */

/** `GET /api/push` lists, `POST /api/push/{subscribe,unsubscribe,revoke-all,preview,test}` change. */
export const PUSH_API = "/api/push";

/** How often a page that is in use says so, and how long the server believes it without hearing again. */
export const PUSH_HEARTBEAT_MS = 25_000;
export const PUSH_PRESENCE_TTL_MS = 70_000;

/** The most devices that may be subscribed at once: an upper bound on what the data dir holds, not a number anyone reaches. */
export const MAX_PUSH_DEVICES = 16;

/** What a browser names itself with to the server: made by the page, never shown. */
export const PUSH_DEVICE_ID = /^[A-Za-z0-9_-]{16,64}$/;

/** The longest a device's name, a notification's title and its preview may be (characters). */
export const PUSH_LABEL_MAX = 60;
export const PUSH_TITLE_MAX = 120;
export const PUSH_PREVIEW_MAX = 120;

/** A device as Settings lists it. The subscription itself (the endpoint, the keys) never leaves the server. */
export interface PushDevice {
	/** The server's name for it: what a revoke names. Not the page's own device id. */
	id: string;
	label: string;
	createdAt: number;
	/** When a push to it last went through, null when none has. */
	lastSentAt: number | null;
	/** Its notifications carry a line of what was said (the question that waits, the start of the last reply), not only the conversation's title. */
	preview: boolean;
}

/** `GET /api/push`: the key a browser subscribes with, and every device. */
export interface PushList {
	/** The server's VAPID public key (uncompressed P-256 point, base64url): the `applicationServerKey` of `subscribe`. */
	publicKey: string;
	devices: PushDevice[];
}

/** The body of `POST /api/push/subscribe`: what `PushSubscription.toJSON()` holds, and what the device says of itself. */
export interface PushSubscribeBody {
	subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
	/** The page's own random name for this device: how a page that is on screen is told from one that is not. */
	device: string;
	/** What to call it in the list (see `deviceLabel`). */
	label?: string;
	/** The interface language of the page: the words of its notifications when the person saved none. */
	lang?: string;
	preview?: boolean;
}

/** What the server answers a subscribe with. */
export interface PushSubscribed {
	id: string;
}

/** What the test notification of Settings says (the words of the conversations' notifications are `NOTICE_TEXT`). */
export const TEST_TEXT: Record<NoticeLang, { title: string; body: string }> = {
	en: { title: "Push is on", body: "This device will be told when a conversation needs you." },
	"zh-CN": { title: "推送已开启", body: "对话需要你时，这台设备会收到通知。" },
};

/** What `POST /api/push/test` answers: whether the push service took the message, and what it said (an HTTP status; 0: no answer). */
export interface PushTested {
	ok: boolean;
	status: number;
}

/**
 * What a notification is made of, as the service worker reads it once the browser has decrypted it. Minimal by design: which
 * conversation, what to call it, the two words that say why. `body` is a line of the conversation itself only for a device
 * that asked for previews. `liveId` and `file` name what a click opens (a conversation that has a file is opened by it).
 */
export interface PushPayload {
	v: 1;
	kind: "asking" | "finished" | "test";
	liveId: string | null;
	file: string | null;
	title: string;
	body: string;
}

export const isPushPayload = (v: unknown): v is PushPayload =>
	isRecord(v) &&
	v.v === 1 &&
	(v.kind === "asking" || v.kind === "finished" || v.kind === "test") &&
	typeof v.title === "string" &&
	typeof v.body === "string" &&
	(v.liveId === null || typeof v.liveId === "string") &&
	(v.file === null || typeof v.file === "string");

/**
 * The page address a click on a notification opens, in the form `hashOf` of the page's store writes for a conversation: by
 * its file when it has one (it outlives the process), else by its process. The service worker has its own copy of this
 * (it is not built with the page); `tests/unit/service-worker.test.ts` holds the two to the same answers.
 */
export function openHash(p: Pick<PushPayload, "liveId" | "file">): string {
	if (p.file) return `#/s/${encodeURIComponent(p.file)}`;
	if (p.liveId) return `#/live/${p.liveId}`;
	return "#/";
}

/** A device's name, made safe to keep and to show: printable characters, one line, at most `PUSH_LABEL_MAX`. */
export function cleanLabel(raw: unknown): string {
	if (typeof raw !== "string") return "";
	return raw
		.replace(/[\p{Cc}\u2028\u2029]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, PUSH_LABEL_MAX);
}

/**
 * What to call the device a user agent is: the kind of device and the browser, as much as the user agent string says.
 * `touch`: how many touch points it has (an iPad that asks for desktop sites says it is a Mac); `app`: it runs as a
 * home-screen app (`navigator.standalone`, or a display mode of standalone).
 */
export function deviceLabel(userAgent: string, touch = 0, app = false): string {
	const device = /iPhone/.test(userAgent)
		? "iPhone"
		: /iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && touch > 1)
			? "iPad"
			: /Android/.test(userAgent)
				? "Android"
				: /Macintosh/.test(userAgent)
					? "Mac"
					: /Windows/.test(userAgent)
						? "Windows"
						: /Linux|X11/.test(userAgent)
							? "Linux"
							: "";
	const browser = /Edg(e|A|iOS)?\//.test(userAgent)
		? "Edge"
		: /Firefox\/|FxiOS\//.test(userAgent)
			? "Firefox"
			: /OPR\/|Opera/.test(userAgent)
				? "Opera"
				: /Chrome\/|CriOS\//.test(userAgent)
					? "Chrome"
					: /Safari\//.test(userAgent)
						? "Safari"
						: "";
	const name = [device, browser].filter(Boolean).join(" · ") || "Browser";
	return app ? `${name} (app)` : name;
}
