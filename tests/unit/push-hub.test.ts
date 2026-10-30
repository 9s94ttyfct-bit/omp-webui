import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PushHub, type PushHubDeps } from "../../server/push/hub.ts";
import type { LiveInfo } from "../../shared/protocol.ts";
import { PUSH_API, PUSH_PRESENCE_TTL_MS, type PushList } from "../../shared/push.ts";
import { newReceiver, type Receiver } from "../support/push-receiver.ts";
import { tempDir } from "../support/temp-dirs.ts";

/**
 * When a device is pushed to, and what it is sent. The push service is a stand-in that keeps what it was asked and answers as
 * the test says; the browser is `newReceiver()`, which reads the message as RFC 8291 says a browser does.
 */

interface Sent {
	url: string;
	headers: Record<string, string>;
	body: Uint8Array;
	redirect: RequestRedirect | undefined;
}

const tmp = () => tempDir("ompw-push-hub-");
const origin = "https://fcm.googleapis.com/fcm/send";

/** What the pool says of a process: working, or not, or waiting for an answer. */
const info = (liveId: string, over: Partial<LiveInfo> = {}): LiveInfo =>
	({
		liveId,
		pid: 1,
		cwd: "/work",
		sessionFile: `/sessions/${liveId}.jsonl`,
		sessionId: liveId,
		args: [],
		startedAt: 0,
		streaming: false,
		exited: false,
		subscribers: 0,
		pausedAt: null,
		mode: "full",
		...over,
	}) as LiveInfo;

let clock = 1_000_000;
let notify = true;
let storedLang: string | null = null;
let remoteOn = false;
let lives: LiveInfo[] = [];
let sent: Sent[] = [];
let answer = 201;
let previews = new Map<string, string>();

async function open(over: Partial<PushHubDeps> = {}): Promise<PushHub> {
	return PushHub.open({
		dataDir: tmp(),
		lives: () => lives,
		named: async (file) => ({
			title: `Title of ${file.split("/").pop()?.replace(".jsonl", "")}`,
			preview: "first prompt",
		}),
		prefs: () => ({ notify, lang: storedLang }),
		preview: (liveId, kind) => previews.get(`${liveId}:${kind}`) ?? null,
		remoteOn: () => remoteOn,
		now: () => clock,
		titleWaitMs: 50,
		fetch: async (url, init) => {
			const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
			sent.push({ url, headers, body: new Uint8Array(init.body as Uint8Array), redirect: init.redirect });
			return new Response(null, { status: answer });
		},
		...over,
	});
}

beforeEach(() => {
	clock = 1_000_000;
	notify = true;
	storedLang = null;
	remoteOn = false;
	lives = [];
	sent = [];
	answer = 201;
	previews = new Map();
});

let n = 0;
/** A device subscribes as a page's request does; the receiver is its browser. */
async function subscribe(
	hub: PushHub,
	over: { device?: string; preview?: boolean; lang?: string; remote?: boolean; endpoint?: string } = {},
): Promise<{ receiver: Receiver; device: string; id: string }> {
	n++;
	const receiver = newReceiver();
	const device = over.device ?? `device-${String(n).padStart(20, "0")}`;
	const res = await hub.handle(
		new Request(`http://x${PUSH_API}/subscribe`, {
			method: "POST",
			body: JSON.stringify({
				subscription: { endpoint: over.endpoint ?? `${origin}/${device}`, keys: receiver.keys },
				device,
				label: "iPhone · Safari (app)",
				...(over.lang ? { lang: over.lang } : {}),
				preview: over.preview === true,
			}),
		}),
		new URL(`http://x${PUSH_API}/subscribe`),
		{ remote: over.remote === true },
	);
	expect(res.status).toBe(200);
	const made: { id: string } = await res.json();
	return { receiver, device, id: made.id };
}

/** One conversation's run ends: it was working, and now it is not. */
async function finish(hub: PushHub, liveId = "c1"): Promise<void> {
	hub.note(info(liveId, { streaming: true }));
	hub.note(info(liveId, { streaming: false }));
	await hub.idle();
}

const ask = async (hub: PushHub, liveId = "c1") => {
	hub.note(info(liveId, { streaming: true }));
	hub.note(info(liveId, { streaming: true, asking: true }));
	await hub.idle();
};

describe("what a device is sent", () => {
	test("a run that ended: the conversation's title and two words, encrypted for that device alone, with the sender's identity", async () => {
		const hub = await open();
		const a = await subscribe(hub);
		const b = await subscribe(hub);
		await finish(hub);
		expect(sent).toHaveLength(2);
		const toA = sent.find((s) => s.url.endsWith(a.device));
		const toB = sent.find((s) => s.url.endsWith(b.device));
		if (!toA || !toB) throw new Error("a device was not sent to");
		expect(toA.headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
		expect(toA.headers["content-encoding"]).toBe("aes128gcm");
		expect(Number(toA.headers.ttl)).toBeGreaterThan(0);
		expect(toA.headers.urgency).toBe("normal");
		expect(toA.headers.topic).toMatch(/^[\w-]{1,32}$/);
		// A push service that redirects is not followed.
		expect(toA.redirect).toBe("manual");
		expect(a.receiver.payload(toA.body)).toEqual({
			v: 1,
			kind: "finished",
			liveId: "c1",
			file: "/sessions/c1.jsonl",
			title: "Title of c1",
			body: "Finished",
		});
		// Each device's message can be read with its own keys and with nobody else's.
		expect(() => a.receiver.read(toB.body)).toThrow();
		expect(b.receiver.payload(toB.body).body).toBe("Finished");
	});

	test("nothing of what was said is in it by default: not the prompt, not the reply, not the question", async () => {
		const hub = await open();
		const a = await subscribe(hub);
		previews.set("c1:asking", "Allow tool: bash rm -rf /secret");
		previews.set("c1:finished", "The database password is hunter2");
		await ask(hub);
		await finish(hub, "c2");
		expect(sent).toHaveLength(2);
		for (const s of sent) {
			const text = a.receiver.read(s.body).text;
			expect(text).not.toContain("hunter2");
			expect(text).not.toContain("rm -rf");
			expect(text).not.toContain("first prompt");
			expect(Object.keys(JSON.parse(text)).sort()).toEqual(["body", "file", "kind", "liveId", "title", "v"]);
		}
	});

	test("the device that opted in to a preview gets one line more, and another device still does not", async () => {
		const hub = await open();
		const opted = await subscribe(hub, { preview: true });
		const other = await subscribe(hub);
		previews.set("c1:finished", "All done: 3 files changed");
		await finish(hub);
		const toOpted = sent.find((s) => s.url.endsWith(opted.device));
		const toOther = sent.find((s) => s.url.endsWith(other.device));
		expect(opted.receiver.payload(toOpted?.body ?? new Uint8Array()).body).toBe("Finished — All done: 3 files changed");
		expect(other.receiver.payload(toOther?.body ?? new Uint8Array()).body).toBe("Finished");
	});

	test("a preview that is not there leaves the plain words", async () => {
		const hub = await open();
		const a = await subscribe(hub, { preview: true });
		await finish(hub);
		expect(a.receiver.payload(sent[0].body).body).toBe("Finished");
	});

	test("an approval or a question: asked for urgently, with the words that say so", async () => {
		const hub = await open();
		const a = await subscribe(hub);
		await ask(hub);
		expect(sent).toHaveLength(1);
		expect(sent[0].headers.urgency).toBe("high");
		expect(a.receiver.payload(sent[0].body)).toMatchObject({ kind: "asking", body: "Needs your input", liveId: "c1" });
	});

	test("the words are in the language the person saved, else the one the device had when it subscribed", async () => {
		const hub = await open();
		const zh = await subscribe(hub, { lang: "zh-CN" });
		await finish(hub);
		expect(zh.receiver.payload(sent[0].body).body).toBe("已完成");
		sent = [];
		storedLang = "en";
		await finish(hub, "c2");
		expect(zh.receiver.payload(sent[0].body).body).toBe("Finished");
	});

	test("a conversation that has no file is named as a new one, and a title that is slow does not hold the notification back", async () => {
		const slow = await open({ named: () => new Promise(() => {}) });
		const a = await subscribe(slow);
		slow.note(info("c1", { streaming: true, sessionFile: null }));
		slow.note(info("c1", { streaming: false, sessionFile: null }));
		await slow.idle();
		expect(a.receiver.payload(sent[0].body)).toMatchObject({ title: "New conversation", file: null });
		sent = [];
		slow.note(info("c2", { streaming: true }));
		slow.note(info("c2", { streaming: false }));
		await slow.idle();
		expect(a.receiver.payload(sent[0].body).title).toBe("Untitled session");
	});

	test("a title too long for a notification is cut, and so is a path too long for one message", async () => {
		const hub = await open({ named: async () => ({ title: "t".repeat(5000) }) });
		const a = await subscribe(hub);
		hub.note(info("c1", { streaming: true, sessionFile: `/${"p".repeat(6000)}.jsonl` }));
		hub.note(info("c1", { streaming: false, sessionFile: `/${"p".repeat(6000)}.jsonl` }));
		await hub.idle();
		const payload = a.receiver.payload(sent[0].body);
		expect((payload.title as string).length).toBeLessThanOrEqual(120);
		expect(payload.file).toBeNull();
		expect(payload.liveId).toBe("c1");
	});
});

describe("when a device is pushed to", () => {
	test("a process that is first seen asking is news; one first seen finished is not (there was no run to end)", async () => {
		const hub = await open();
		await subscribe(hub);
		hub.note(info("late", { streaming: false }));
		await hub.idle();
		expect(sent).toHaveLength(0);
		hub.note(info("new-asking", { streaming: true, asking: true }));
		await hub.idle();
		expect(sent).toHaveLength(1);
	});

	test("a process that was working when the hub began is compared with what it was then", async () => {
		lives = [info("c1", { streaming: true })];
		const hub = await open();
		await subscribe(hub);
		hub.note(info("c1", { streaming: false }));
		await hub.idle();
		expect(sent).toHaveLength(1);
	});

	test("a goal's run between two turns is not over; a process that ends, or dies, says nothing", async () => {
		const hub = await open();
		await subscribe(hub);
		hub.note(info("c1", { streaming: true }));
		hub.note(info("c1", { streaming: false, continuing: true }));
		await hub.idle();
		expect(sent).toHaveLength(0);
		hub.note(info("c1", { streaming: false, exited: true }));
		await hub.idle();
		expect(sent).toHaveLength(0);
	});

	test("nobody is sent anything while Settings has notifications off, and one turned off while a title is waited for is not either", async () => {
		const hub = await open();
		await subscribe(hub);
		notify = false;
		await finish(hub);
		expect(sent).toHaveLength(0);
		notify = true;
		const slow = await open({
			named: async () => {
				notify = false;
				return { title: "x" };
			},
		});
		await subscribe(slow);
		await finish(slow, "c2");
		expect(sent).toHaveLength(0);
	});

	test("a device with a page on screen is not pushed to; another device is", async () => {
		const hub = await open();
		const watching = await subscribe(hub);
		const away = await subscribe(hub);
		hub.presence({}, watching.device, true);
		await finish(hub);
		expect(sent.map((s) => s.url)).toEqual([`${origin}/${away.device}`]);
	});

	test("a page in use on another conversation or another page does not keep its device from being told; one that shows the conversation does", async () => {
		const hub = await open();
		const a = await subscribe(hub);
		const page = {};
		// c1 is on screen, by its process and by its file, and so is not pushed; a finished c2 and c3 are, with the page on other things.
		hub.presence(page, a.device, true, { liveId: "c1", file: "/sessions/c1.jsonl" });
		await finish(hub, "c1");
		expect(sent).toHaveLength(0);
		await finish(hub, "c2");
		expect(sent).toHaveLength(1);
		hub.presence(page, a.device, true, null);
		await finish(hub, "c1");
		expect(sent).toHaveLength(2);
		// The file alone is a match: a view that named only the saved conversation.
		hub.presence(page, a.device, true, { liveId: null, file: "/sessions/c4.jsonl" });
		await finish(hub, "c4");
		expect(sent).toHaveLength(2);
		// Asking is the same: nothing for the conversation on screen, a push for another.
		await ask(hub, "c4");
		expect(sent).toHaveLength(2);
		await ask(hub, "c5");
		expect(sent).toHaveLength(3);
	});

	test("a device with two pages is not pushed a conversation either of them shows; a page that says nothing of what it shows counts as showing all", async () => {
		const hub = await open();
		const a = await subscribe(hub);
		const one = {};
		const two = {};
		hub.presence(one, a.device, true, null);
		hub.presence(two, a.device, true, { liveId: "c1", file: null });
		await finish(hub, "c1");
		expect(sent).toHaveLength(0);
		await finish(hub, "c2");
		expect(sent).toHaveLength(1);
		// A page of a build from before this said only that it was on screen: whatever finishes, somebody is looking.
		sent = [];
		hub.presence(one, a.device, true);
		await finish(hub, "c6");
		expect(sent).toHaveLength(0);
		// It says what it shows now: the old say-so does not outlive it.
		hub.presence(one, a.device, true, null);
		await finish(hub, "c7");
		expect(sent).toHaveLength(1);
	});

	test("a page's say-so is believed for as long as it is renewed, and no longer", async () => {
		const hub = await open();
		const a = await subscribe(hub);
		const page = {};
		hub.presence(page, a.device, true);
		clock += PUSH_PRESENCE_TTL_MS - 1000;
		await finish(hub);
		expect(sent).toHaveLength(0);
		hub.presence(page, a.device, true);
		clock += PUSH_PRESENCE_TTL_MS - 1000;
		await finish(hub, "c2");
		expect(sent).toHaveLength(0);
		clock += 2000;
		await finish(hub, "c3");
		expect(sent).toHaveLength(1);
	});

	test("a page that says it is hidden, or whose socket closed, is not on screen; a second page of the device still is", async () => {
		const hub = await open();
		const a = await subscribe(hub);
		const one = {};
		const two = {};
		hub.presence(one, a.device, true);
		hub.presence(two, a.device, true);
		hub.presence(one, a.device, false);
		await finish(hub);
		expect(sent).toHaveLength(0);
		hub.dropOwner(two);
		await finish(hub, "c2");
		expect(sent).toHaveLength(1);
		sent = [];
		hub.presence(one, a.device, true);
		hub.dropOwner(one);
		await finish(hub, "c3");
		expect(sent).toHaveLength(1);
	});

	test("a name that is no device's is not kept", async () => {
		const hub = await open();
		const a = await subscribe(hub);
		hub.presence({}, "short", true);
		hub.presence({}, "x/y/../z..........", true);
		await finish(hub);
		expect(sent).toHaveLength(1);
		expect(a.device).toBeTruthy();
	});

	test("a device that came in through the tunnel is pushed to only while remote access is on", async () => {
		const hub = await open();
		const viaTunnel = await subscribe(hub, { remote: true });
		const here = await subscribe(hub);
		await finish(hub);
		expect(sent.map((s) => s.url)).toEqual([`${origin}/${here.device}`]);
		sent = [];
		remoteOn = true;
		await finish(hub, "c2");
		expect(sent.map((s) => s.url).sort()).toEqual([`${origin}/${viaTunnel.device}`, `${origin}/${here.device}`].sort());
	});

	test("a revoked device is sent nothing", async () => {
		const hub = await open();
		const a = await subscribe(hub);
		const res = await hub.handle(
			new Request(`http://x${PUSH_API}/revoke`, { method: "POST", body: JSON.stringify({ id: a.id }) }),
			new URL(`http://x${PUSH_API}/revoke`),
			{ remote: false },
		);
		expect(await res.json()).toEqual({ removed: true });
		await finish(hub);
		expect(sent).toHaveLength(0);
	});

	test("nobody subscribed: nothing is built and nothing is asked of the titles", async () => {
		let asked = 0;
		const hub = await open({
			named: async () => {
				asked++;
				return null;
			},
		});
		await finish(hub);
		expect(asked).toBe(0);
		expect(sent).toHaveLength(0);
	});
});

describe("what the push service answers", () => {
	test("a device it says is gone (404, 410) is forgotten", async () => {
		for (const status of [404, 410]) {
			const hub = await open();
			await subscribe(hub);
			answer = status;
			await finish(hub);
			expect(hub.size).toBe(0);
		}
	});

	test("any other refusal leaves the device and is not tried again", async () => {
		const warn = console.warn;
		const said: string[] = [];
		console.warn = (line: string) => said.push(line);
		try {
			const hub = await open();
			await subscribe(hub);
			answer = 503;
			await finish(hub);
			expect(hub.size).toBe(1);
			expect(sent).toHaveLength(1);
			await finish(hub, "c2");
			// Said once, and without the device's address.
			expect(said).toHaveLength(1);
			expect(said[0]).not.toContain("device-");
			expect(said[0]).toContain("503");
		} finally {
			console.warn = warn;
		}
	});

	test("a service that does not answer leaves the device, and the next notification still goes", async () => {
		const warn = console.warn;
		console.warn = () => {};
		try {
			let fail = true;
			const hub = await open({
				fetch: async (url, init) => {
					if (fail) throw new Error("connection refused");
					sent.push({ url, headers: {}, body: new Uint8Array(init.body as Uint8Array), redirect: init.redirect });
					return new Response(null, { status: 201 });
				},
			});
			await subscribe(hub);
			await finish(hub);
			expect(hub.size).toBe(1);
			fail = false;
			await finish(hub, "c2");
			expect(sent).toHaveLength(1);
		} finally {
			console.warn = warn;
		}
	});

	test("the last send is kept for the list", async () => {
		const hub = await open();
		await subscribe(hub);
		await finish(hub);
		const res = await hub.handle(new Request(`http://x${PUSH_API}`), new URL(`http://x${PUSH_API}`), { remote: false });
		const list: PushList = await res.json();
		expect(list.devices[0].lastSentAt).toBe(clock);
	});
});

describe("the requests", () => {
	const call = (hub: PushHub, path: string, body?: unknown, method = "POST", remote = false) =>
		hub.handle(
			new Request(`http://x${path}`, {
				method,
				...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
			}),
			new URL(`http://x${path}`),
			{ remote },
		);

	test("the list has the key to subscribe with and the devices, and never an endpoint or a key of one", async () => {
		const hub = await open();
		const a = await subscribe(hub, { device: "d".repeat(24) });
		const res = await call(hub, PUSH_API, undefined, "GET");
		const text = await res.text();
		const list: PushList = JSON.parse(text);
		expect(list.publicKey).toBe(hub.publicKey);
		expect(list.devices).toHaveLength(1);
		expect(list.devices[0]).toMatchObject({
			id: a.id,
			label: "iPhone · Safari (app)",
			preview: false,
			lastSentAt: null,
		});
		expect(text).not.toContain("fcm.googleapis.com");
		expect(text).not.toContain(a.receiver.keys.p256dh);
		expect(text).not.toContain(a.receiver.keys.auth);
		expect(text).not.toContain("d".repeat(24));
		expect(res.headers.get("cache-control")).toBe("no-store");
	});

	test("an endpoint that is not a push service's, keys that are none and a device name that is none are refused", async () => {
		const hub = await open();
		const k = newReceiver().keys;
		const base = { subscription: { endpoint: `${origin}/x`, keys: k }, device: "d".repeat(24) };
		const refused = async (body: unknown) => (await call(hub, `${PUSH_API}/subscribe`, body)).status;
		expect(await refused({ ...base, subscription: { endpoint: "http://169.254.169.254/x", keys: k } })).toBe(400);
		expect(await refused({ ...base, subscription: { endpoint: "https://evil.example/x", keys: k } })).toBe(400);
		expect(await refused({ ...base, subscription: { endpoint: `${origin}/x`, keys: { ...k, p256dh: "AAAA" } } })).toBe(
			400,
		);
		expect(await refused({ ...base, subscription: { endpoint: `${origin}/x`, keys: { ...k, auth: "AAAA" } } })).toBe(
			400,
		);
		expect(await refused({ ...base, subscription: { endpoint: `${origin}/x` } })).toBe(400);
		expect(await refused({ ...base, device: "no" })).toBe(400);
		expect(await refused({ ...base, device: "bad/name/........." })).toBe(400);
		expect(await refused({ device: base.device })).toBe(400);
		expect(await refused("not json")).toBe(400);
		expect(await refused([1, 2])).toBe(400);
		expect(hub.size).toBe(0);
		expect(await refused(base)).toBe(200);
	});

	test("a point that is not on the curve is refused when the subscription is made", async () => {
		const hub = await open();
		const k = newReceiver().keys;
		const off = Buffer.alloc(65, 7);
		off[0] = 4;
		const res = await call(hub, `${PUSH_API}/subscribe`, {
			subscription: { endpoint: `${origin}/x`, keys: { p256dh: off.toString("base64url"), auth: k.auth } },
			device: "d".repeat(24),
		});
		expect(res.status).toBe(400);
		expect(hub.size).toBe(0);
	});

	test("a request too large is refused, and so is the wrong method", async () => {
		const hub = await open();
		expect((await call(hub, `${PUSH_API}/subscribe`, "x".repeat(9000))).status).toBe(413);
		expect((await call(hub, `${PUSH_API}/subscribe`, undefined, "GET")).status).toBe(405);
		expect((await call(hub, PUSH_API, {}, "POST")).status).toBe(405);
		expect((await call(hub, `${PUSH_API}/nothing`, {})).status).toBe(404);
	});

	test("a page takes its own device off by the name it gave it; revoke names the server's id; revoke-all takes every one", async () => {
		const hub = await open();
		const a = await subscribe(hub, { device: "a".repeat(24) });
		const b = await subscribe(hub, { device: "b".repeat(24) });
		await subscribe(hub, { device: "c".repeat(24) });
		expect(await (await call(hub, `${PUSH_API}/unsubscribe`, { device: "a".repeat(24) })).json()).toEqual({
			removed: true,
		});
		expect(await (await call(hub, `${PUSH_API}/unsubscribe`, { device: "a".repeat(24) })).json()).toEqual({
			removed: false,
		});
		// The page's own name is no revoke's id, and the id is no unsubscribe's name.
		expect(await (await call(hub, `${PUSH_API}/revoke`, { id: "b".repeat(24) })).json()).toEqual({ removed: false });
		expect(await (await call(hub, `${PUSH_API}/unsubscribe`, { device: b.id })).json()).toEqual({ removed: false });
		expect(await (await call(hub, `${PUSH_API}/revoke`, { id: b.id })).json()).toEqual({ removed: true });
		expect(await (await call(hub, `${PUSH_API}/revoke-all`, {})).json()).toEqual({ removed: 1 });
		expect(hub.size).toBe(0);
		expect(a.id).not.toBe(b.id);
	});

	test("the preview switch is per device and changes what that device is sent next", async () => {
		const hub = await open();
		const a = await subscribe(hub);
		previews.set("c1:finished", "the end of the reply");
		expect((await call(hub, `${PUSH_API}/preview`, { id: a.id, preview: true })).status).toBe(200);
		await finish(hub);
		expect(a.receiver.payload(sent[0].body).body).toBe("Finished — the end of the reply");
		expect((await call(hub, `${PUSH_API}/preview`, { id: "nobody", preview: true })).status).toBe(404);
		expect((await call(hub, `${PUSH_API}/preview`, { id: a.id })).status).toBe(400);
	});

	test("the test notification goes to the one device, whatever is on screen, in its words, and says whether the service took it", async () => {
		const hub = await open();
		const a = await subscribe(hub, { lang: "zh-CN" });
		const other = await subscribe(hub);
		hub.presence({}, a.device, true);
		const res = await call(hub, `${PUSH_API}/test`, { id: a.id });
		expect(await res.json()).toEqual({ ok: true, status: 201 });
		expect(sent).toHaveLength(1);
		expect(sent[0].url).toBe(`${origin}/${a.device}`);
		expect(a.receiver.payload(sent[0].body)).toMatchObject({
			kind: "test",
			liveId: null,
			file: null,
			title: "推送已开启",
		});
		expect(other.device).toBeTruthy();
		// Another test within the cooldown is refused, with how long to wait, and nothing is sent for it.
		const early = await call(hub, `${PUSH_API}/test`, { id: a.id });
		expect(early.status).toBe(429);
		expect(Number(early.headers.get("retry-after"))).toBeGreaterThan(0);
		expect(sent).toHaveLength(1);
		// Another device has a cooldown of its own.
		expect((await call(hub, `${PUSH_API}/test`, { id: other.id })).status).toBe(200);
		clock += 5000;
		answer = 410;
		expect(await (await call(hub, `${PUSH_API}/test`, { id: a.id })).json()).toEqual({ ok: false, status: 410 });
		expect((await call(hub, `${PUSH_API}/test`, { id: a.id })).status).toBe(404);
	});

	test("a request whose length says it is too large is refused before its body is read", async () => {
		const hub = await open();
		const res = await hub.handle(
			new Request(`http://x${PUSH_API}/revoke-all`, {
				method: "POST",
				headers: { "content-length": String(1024 * 1024) },
				body: "{}",
			}),
			new URL(`http://x${PUSH_API}/revoke-all`),
			{ remote: false },
		);
		expect(res.status).toBe(413);
	});

	test("a conversation with no saved title is named by the placeholder: no word of the first prompt goes out", async () => {
		const hub = await open({ named: async () => ({ title: null, preview: "my password is hunter2" }) });
		const a = await subscribe(hub);
		await finish(hub);
		const plain = a.receiver.read(sent[0].body).text;
		expect(plain).not.toContain("hunter2");
		expect(a.receiver.payload(sent[0].body).title).toBe("Untitled session");
	});

	test("a device that subscribes again is the same device, and the label is cleaned", async () => {
		const hub = await open();
		const first = await subscribe(hub, { device: "d".repeat(24) });
		const receiver = newReceiver();
		const res = await call(hub, `${PUSH_API}/subscribe`, {
			subscription: { endpoint: `${origin}/again`, keys: receiver.keys },
			device: "d".repeat(24),
			label: "  Mac\n\u0007·  Chrome  ",
		});
		const again: { id: string } = await res.json();
		expect(again.id).toBe(first.id);
		const list: PushList = await (await call(hub, PUSH_API, undefined, "GET")).json();
		expect(list.devices).toHaveLength(1);
		expect(list.devices[0].label).toBe("Mac · Chrome");
	});
});

describe("the key", () => {
	test("a second hub on the same data dir has the same key and the same devices", async () => {
		const dataDir = tmp();
		const one = await open({ dataDir });
		const a = await subscribe(one);
		const two = await open({ dataDir });
		expect(two.publicKey).toBe(one.publicKey);
		expect(two.size).toBe(1);
		expect(a.id).toBeTruthy();
		const text = readFileSync(join(dataDir, "push-devices.json"), "utf8");
		expect(text).toContain(one.publicKey);
	});
});
