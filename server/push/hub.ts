import { createHash } from "node:crypto";
import {
	type AttentionKind,
	attentionOf,
	conversationTitle,
	factsOf,
	isLookingAt,
	NOTICE_TEXT,
	noticeLang,
	type Shown,
	type WorkFacts,
} from "../../shared/attention.ts";
import { isRecord } from "../../shared/guards.ts";
import { LANGS } from "../../shared/prefs.ts";
import type { LiveInfo } from "../../shared/protocol.ts";
import {
	cleanLabel,
	PUSH_API,
	PUSH_DEVICE_ID,
	PUSH_PRESENCE_TTL_MS,
	PUSH_TITLE_MAX,
	type PushList,
	type PushPayload,
	type PushSubscribed,
	type PushTested,
	TEST_TEXT,
} from "../../shared/push.ts";
import {
	encryptMessage,
	KeyError,
	MAX_PLAINTEXT,
	type VapidKey,
	vapidAuthorization,
	verifiedReceiver,
} from "./crypto.ts";
import { DeviceError, type DeviceRecord, PushDevices } from "./devices.ts";
import { allowedEndpoint, extraOrigins } from "./endpoint.ts";
import { loadVapid } from "./vapid.ts";

/**
 * Web Push (#629): the notification of a conversation that needs somebody, for a device whose page is not on screen.
 *
 * The decision is the page's and the macOS app's (`shared/attention.ts`): a process that started to wait for an answer, or
 * whose run ended; an error or a usage limit ends a turn (and so is "finished"), as it does for them. It is made here from
 * what the pool announces (`note`), compared with what was known of the process before, like `ShellEvents` does; each page
 * says over its socket whether it is on screen (`presence`), and a device that has one on screen is not pushed to.
 *
 * What goes out is the least that tells: the conversation's title, two words that say why, and what a click opens, encrypted
 * for the one browser (`crypto.ts`): the push service of Apple, Google or Mozilla carries it and cannot read it. A device
 * that opted in to a preview also gets one line of what was asked or said (`Live.previewText`).
 */

/** The longest a title is waited for: a notification is worth more than its words. */
const TITLE_WAIT_MS = 1500;
/** How long the push service gets to take a message. */
const SEND_TIMEOUT_MS = 10_000;
/** How long a push service holds a message for a device that is off (seconds): an old "finished" is still news for a while. */
const TTL_SECONDS = 6 * 60 * 60;
/** The body of a request is a subscription: a few hundred bytes. */
const BODY_MAX = 8 * 1024;
/** The least time between two test notifications to one device: a page that holds the token cannot make a phone buzz in a loop. */
const TEST_COOLDOWN_MS = 5000;
/** The contact a push service may ask about this sender (RFC 8292); `OMP_WEBUI_PUSH_SUBJECT` names a person's own. */
const DEFAULT_SUBJECT = "mailto:omp-webui@example.com";
/** The message is padded to a multiple of this many octets, so that its length says less of the title. */
const PAD = 128;

export interface PushHubDeps {
	dataDir: string;
	/** The processes the server holds now. */
	lives: () => Iterable<LiveInfo>;
	/** The saved title and first prompt of a conversation's file, null when it has none. */
	named: (file: string) => Promise<{ title?: string | null; preview?: string | null } | null>;
	/** What the person chose: notifications on (the master switch of the page's, the app's and these), and the language they saved. */
	prefs: () => { notify: boolean; lang: string | null };
	/** A line of what a conversation asks or says, for a device that opted in to one. */
	preview: (liveId: string, kind: AttentionKind) => string | null;
	/** Whether remote access is on: a device that subscribed through the tunnel is pushed to only while it is. */
	remoteOn: () => boolean;
	/** The push service is spoken to with this (tests give one that is a local stand-in). */
	fetch?: (url: string, init: RequestInit) => Promise<Response>;
	now?: () => number;
	/** Endpoint origins besides the browsers' own push services (`OMP_WEBUI_PUSH_HOSTS`). */
	extraOrigins?: readonly string[];
	subject?: string;
	titleWaitMs?: number;
	sendTimeoutMs?: number;
}

/** Who asks: a request through the tunnel is a remote one (its devices stop while remote access is off). */
export interface PushRequest {
	remote: boolean;
}

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json", "cache-control": "no-store" },
	});
const fail = (error: string, status = 400) => json({ error }, status);

/** The hub that `server/main.ts` uses: the settings of the person's own environment applied. */
export function openPushHub(
	deps: Omit<PushHubDeps, "extraOrigins" | "subject"> & Partial<PushHubDeps>,
): Promise<PushHub> {
	return PushHub.open({
		...deps,
		extraOrigins: deps.extraOrigins ?? extraOrigins(process.env.OMP_WEBUI_PUSH_HOSTS),
		subject: deps.subject ?? (process.env.OMP_WEBUI_PUSH_SUBJECT || DEFAULT_SUBJECT),
	});
}

export class PushHub {
	/** What was last known of each process that runs: what the next announcement is compared with. */
	private readonly known = new Map<string, WorkFacts>();
	/**
	 * The pages that say they are in use, by the socket each one is: the device it is, when it last said so, and which conversation
	 * it shows (undefined: a page that does not say, which counts as showing every conversation).
	 */
	private readonly pages = new Map<object, { device: string; at: number; shown: Shown | null | undefined }>();
	/** Notifications are built one after the other: two of one conversation (asks, then finishes) keep their order. */
	private queue: Promise<void> = Promise.resolve();
	/** What the push services refused, said once each (never the address of a device). */
	private readonly said = new Set<string>();
	/** When each device was last sent a test, by the server's id for it: the cooldown of `POST /api/push/test`. */
	private readonly testedAt = new Map<string, number>();
	private readonly now: () => number;
	private readonly speak: (url: string, init: RequestInit) => Promise<Response>;

	private constructor(
		private readonly deps: PushHubDeps,
		private readonly key: VapidKey,
		private readonly devices: PushDevices,
	) {
		this.now = deps.now ?? Date.now;
		this.speak = deps.fetch ?? ((url, init) => fetch(url, init));
		// A process that was never announced has a baseline now: its next change is news, what it is now is not.
		for (const info of deps.lives()) if (!info.exited) this.known.set(info.liveId, factsOf(info));
	}

	static async open(deps: PushHubDeps): Promise<PushHub> {
		const key = await loadVapid(deps.dataDir);
		return new PushHub(deps, key, new PushDevices(deps.dataDir, key.publicKey, deps.extraOrigins ?? []));
	}

	/** Resolves when every notification the pool's announcements so far led to has been sent or given up on (for tests). */
	idle(): Promise<void> {
		return this.queue;
	}

	get publicKey(): string {
		return this.key.publicKey;
	}

	/** How many devices have push on. */
	get size(): number {
		return this.devices.size;
	}

	/** A process was announced (see `LivePool.onAnnounce`): what it did since the last time is what devices are told. */
	note(info: LiveInfo): void {
		if (info.exited) {
			this.known.delete(info.liveId);
			return;
		}
		const now = factsOf(info);
		const kinds = attentionOf(this.known.get(info.liveId), now);
		this.known.set(info.liveId, now);
		if (this.devices.size === 0) return;
		for (const kind of kinds) this.queue = this.queue.then(() => this.attention(info, kind)).catch(report);
	}

	/**
	 * A page says whether it is in use (its tab shown and its window focused), and which conversation it shows: `shown`, null for
	 * none, undefined for a page that does not say. The device is the page's own name for itself (`PUSH_DEVICE_ID`).
	 */
	presence(owner: object, device: string, visible: boolean, shown?: Shown | null): void {
		if (!PUSH_DEVICE_ID.test(device)) return;
		if (visible) this.pages.set(owner, { device, at: this.now(), shown });
		else this.pages.delete(owner);
	}

	/** The page behind `owner` is gone (its socket closed): it is on no screen. */
	dropOwner(owner: object): void {
		this.pages.delete(owner);
	}

	/**
	 * Whether somebody is looking at `info` on `device`: a page of it was said, not longer ago than `PUSH_PRESENCE_TTL_MS`, to be in use
	 * and to show that conversation (`isLookingAt`). A device whose page is in use on another conversation or another page is pushed to.
	 */
	private looking(device: string, info: Pick<LiveInfo, "liveId" | "sessionFile">): boolean {
		const horizon = this.now() - PUSH_PRESENCE_TTL_MS;
		for (const [owner, page] of this.pages) {
			if (page.at < horizon) this.pages.delete(owner);
			else if (page.device === device) {
				const conversation = { liveId: info.liveId, file: info.sessionFile };
				if (page.shown === undefined || isLookingAt(true, page.shown, conversation)) return true;
			}
		}
		return false;
	}

	private async attention(info: LiveInfo, kind: AttentionKind): Promise<void> {
		if (!this.deps.prefs().notify || this.devices.size === 0) return;
		const file = info.sessionFile;
		const named = file ? await within(this.deps.named(file), this.deps.titleWaitMs ?? TITLE_WAIT_MS) : null;
		// Asked again after the wait: the person may have turned notifications off, and a page may have come on screen.
		const { notify, lang: stored } = this.deps.prefs();
		if (!notify) return;
		const remoteOn = this.deps.remoteOn();
		const targets = this.devices.all().filter((d) => (!d.remote || remoteOn) && !this.looking(d.device, info));
		await Promise.allSettled(
			targets.map((device) => {
				const lang = noticeLang(stored, device.lang);
				const words = NOTICE_TEXT[lang][kind];
				const line = device.preview ? this.deps.preview(info.liveId, kind) : null;
				const payload: PushPayload = {
					v: 1,
					kind,
					liveId: info.liveId,
					file,
					// By the saved title only: with none, the placeholder says it is a conversation. The first prompt (`named.preview`) is
					// not used, so that no word of what was typed goes out in any push; a preview is a line of the dialog or of the reply.
					title: cut(conversationTitle(named ? { title: named.title } : null, file, lang), PUSH_TITLE_MAX),
					body: line ? `${words} — ${line}` : words,
				};
				return this.deliver(device, payload, kind === "asking" ? "high" : "normal");
			}),
		);
	}

	/** A notification to one device, to see that it arrives (Settings); whether anybody is looking at a page of it is not asked. */
	async test(id: string): Promise<PushTested | null> {
		const device = this.devices.get(id);
		if (!device) return null;
		const lang = noticeLang(this.deps.prefs().lang, device.lang);
		const { title, body } = TEST_TEXT[lang];
		const status = await this.deliver(device, { v: 1, kind: "test", liveId: null, file: null, title, body }, "high");
		return { ok: status >= 200 && status < 300, status };
	}

	/**
	 * The message encrypted for `device` and handed to its push service, with the sender's identity. Returns the HTTP status
	 * the service answered, 0 when it gave none (or the keys could not be used). A device the service says is gone (404, 410:
	 * the browser withdrew the subscription) is forgotten here; anything else is said once and not retried: a push is news
	 * for a while, and a service that is down is no reason to send a dozen of them when it is back.
	 */
	private async deliver(device: DeviceRecord, payload: PushPayload, urgency: "high" | "normal"): Promise<number> {
		const origin = new URL(device.endpoint).origin;
		let body: Uint8Array;
		let authorization: string;
		try {
			const plain = new TextEncoder().encode(JSON.stringify(fit(payload)));
			body = await encryptMessage(plain, this.devices.receiver(device), { padTo: PAD });
			authorization = await vapidAuthorization(
				this.key,
				device.endpoint,
				this.deps.subject ?? DEFAULT_SUBJECT,
				this.now(),
			);
		} catch (e) {
			// Keys that cannot be used are the browser's fault and last for as long as the subscription does.
			if (e instanceof KeyError) this.devices.remove(device.id);
			this.say(origin, `could not make the message (${(e as Error).message})`);
			return 0;
		}
		let res: Response;
		try {
			res = await this.speak(device.endpoint, {
				method: "POST",
				// A push service that redirects is not one this server was asked to send to.
				redirect: "manual",
				headers: {
					authorization,
					"content-encoding": "aes128gcm",
					"content-type": "application/octet-stream",
					ttl: String(TTL_SECONDS),
					urgency,
					// A newer message about one conversation replaces an older one that was not delivered yet.
					...(payload.liveId ? { topic: topicOf(payload.liveId) } : {}),
				},
				body: body as BodyInit,
				signal: AbortSignal.timeout(this.deps.sendTimeoutMs ?? SEND_TIMEOUT_MS),
			});
		} catch {
			this.say(origin, "no answer");
			return 0;
		}
		await res.body?.cancel().catch(() => {});
		if (res.status >= 200 && res.status < 300) this.devices.sent(device.id, this.now());
		else if (res.status === 404 || res.status === 410) this.devices.remove(device.id);
		else this.say(origin, `refused with ${res.status}`);
		return res.status;
	}

	private say(origin: string, what: string): void {
		const line = `${origin} ${what}`;
		if (this.said.has(line)) return;
		this.said.add(line);
		console.warn(`omp-webui: Web Push to ${line}`);
	}

	// ------------------------------------------------------------------ the routes

	/** `/api/push*`: the key and the devices, and what a page changes of them. Not local-only: phones come in through the tunnel. */
	async handle(req: Request, url: URL, who: PushRequest): Promise<Response> {
		const p = url.pathname;
		if (p === PUSH_API) {
			if (req.method !== "GET") return fail("GET required", 405);
			return json({ publicKey: this.key.publicKey, devices: this.devices.list() } satisfies PushList);
		}
		if (req.method !== "POST") return fail("POST required", 405);
		// Said by the request itself before a byte of it is read; a body with no length is checked once read.
		const declared = Number(req.headers.get("content-length"));
		if (Number.isFinite(declared) && declared > BODY_MAX) return fail("Request too large", 413);
		const text = await req.text();
		if (text.length > BODY_MAX) return fail("Request too large", 413);
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			return fail("Not JSON");
		}
		if (!isRecord(body)) return fail("An object is required");
		switch (p) {
			case `${PUSH_API}/subscribe`:
				return this.subscribe(body, who);
			case `${PUSH_API}/unsubscribe`: {
				// A page takes its own device off by the name it gave it.
				const device = typeof body.device === "string" ? body.device : "";
				const record = this.devices.all().find((d) => d.device === device);
				return json({ removed: record ? this.devices.remove(record.id) : false });
			}
			case `${PUSH_API}/revoke`:
				return json({ removed: typeof body.id === "string" && this.devices.remove(body.id) });
			case `${PUSH_API}/revoke-all`:
				return json({ removed: this.devices.removeAll() });
			case `${PUSH_API}/preview`:
				if (typeof body.id !== "string" || typeof body.preview !== "boolean")
					return fail("id and preview are required");
				return this.devices.setPreview(body.id, body.preview) ? json({ ok: true }) : fail("Unknown device", 404);
			case `${PUSH_API}/test`: {
				const id = typeof body.id === "string" ? body.id : "";
				if (!this.devices.get(id)) return fail("Unknown device", 404);
				const now = this.now();
				const last = this.testedAt.get(id);
				if (last !== undefined && now - last < TEST_COOLDOWN_MS) {
					const wait = fail("A test was sent a moment ago; wait a few seconds and try again", 429);
					wait.headers.set("retry-after", String(Math.ceil((TEST_COOLDOWN_MS - (now - last)) / 1000)));
					return wait;
				}
				for (const [other, at] of this.testedAt) if (now - at >= TEST_COOLDOWN_MS) this.testedAt.delete(other);
				this.testedAt.set(id, now);
				const tested = await this.test(id);
				return tested ? json(tested) : fail("Unknown device", 404);
			}
		}
		return fail("Not found", 404);
	}

	private async subscribe(body: Record<string, unknown>, who: PushRequest): Promise<Response> {
		const { subscription, device } = body;
		if (!isRecord(subscription) || !isRecord(subscription.keys)) return fail("subscription is required");
		if (!allowedEndpoint(subscription.endpoint, this.deps.extraOrigins)) {
			return fail("This push service is not one the server sends to");
		}
		if (typeof device !== "string" || !PUSH_DEVICE_ID.test(device)) return fail("device is not a device name");
		const { p256dh, auth } = subscription.keys;
		if (typeof p256dh !== "string" || typeof auth !== "string") return fail("The subscription has no keys");
		try {
			await verifiedReceiver(p256dh, auth);
		} catch (e) {
			if (e instanceof KeyError) return fail(e.message);
			throw e;
		}
		try {
			const record = this.devices.upsert(
				{
					device,
					endpoint: subscription.endpoint,
					p256dh,
					auth,
					label: cleanLabel(body.label) || "Browser",
					lang: LANGS.find((l) => l === body.lang) ?? null,
					preview: body.preview === true,
					remote: who.remote,
				},
				this.now(),
			);
			return json({ id: record.id } satisfies PushSubscribed);
		} catch (e) {
			if (e instanceof DeviceError) return fail(e.message, e.status);
			throw e;
		}
	}
}

/** `text` at most `max` characters, cut with an ellipsis. */
function cut(text: string, max: number): string {
	const chars = Array.from(text);
	return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/** `Topic` of a message: at most 32 characters of the URL-safe base64 alphabet, the same for the same conversation. */
const topicOf = (liveId: string): string => createHash("sha256").update(liveId).digest("base64url").slice(0, 32);

/** The payload as it fits one message: a path too long to hold is left out (a click opens the process), a title is cut. */
function fit(payload: PushPayload): PushPayload {
	const size = (p: PushPayload) => new TextEncoder().encode(JSON.stringify(p)).length;
	let out = payload;
	if (size(out) > MAX_PLAINTEXT) out = { ...out, file: null };
	if (size(out) > MAX_PLAINTEXT) out = { ...out, title: cut(out.title, 40), body: cut(out.body, 80) };
	return out;
}

/** `promise`, or null once `ms` have passed. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
	const { promise: out, resolve } = Promise.withResolvers<T | null>();
	const timer = setTimeout(resolve, ms, null);
	promise.then(resolve, () => resolve(null)).finally(() => clearTimeout(timer));
	return out;
}

function report(e: unknown): void {
	console.error(`omp-webui: could not tell the devices what a conversation needs: ${(e as Error).message}`);
}
