import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LiveInfo } from "../../shared/protocol.ts";
import { PUSH_API, type PushList } from "../../shared/push.ts";
import {
	type AccessKey,
	AUD,
	claims,
	EMAIL,
	HOSTNAME,
	type Jwks,
	makeKey,
	sign,
	startJwks,
	TEAM,
} from "../support/access-jwt.ts";
import { writeChatSession } from "../support/chat-session.ts";
import { watchFrames } from "../support/frames.ts";
import { pollUntil } from "../support/poll.ts";
import { newReceiver, type Receiver } from "../support/push-receiver.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type ScriptedTurn, type StubScripted, startScriptedStub } from "../support/stub-scripted.ts";
import { connect, request } from "../support/ws.ts";

/**
 * Web Push (#629) against the real server and the real omp (the model a scripted provider: no model call), with a local stand-in
 * for the push service that keeps what it is sent, and a browser that reads a message as RFC 8291 says it is read. What is
 * held: who may subscribe and revoke (the token, the CSRF header, a page behind the tunnel), that a conversation that finishes or
 * asks is pushed to a device and one whose page is on screen is not, that nothing of what was said is in a message unless the
 * device chose it, and what the server keeps for itself. The rules of when are in `tests/unit/push-hub.test.ts`; the service
 * worker is `service-worker.test.ts`; the card of Settings is `tests/e2e/push-settings.spec.ts`.
 *
 * A push that must not happen is shown by one that must, sent in the same breath to another device (a "control"): the hub chooses
 * who is told before it sends to anyone, so when the control's has come, the others' would have.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-push-"));
const settingsFile = join(root, "remote.json");
const dist = join(root, "dist");
const GOOD = { enabled: true, hostname: HOSTNAME, team: TEAM, aud: AUD, emails: [EMAIL] };
const PUBLIC = join(import.meta.dirname, "../../web/public");

let server: TestServer;
let backend: StubScripted;
let jwks: Jwks;
let key: AccessKey;
let service: Bun.Server<undefined>;
/** What the stand-in push service was sent, in order, and what it answers. */
const received: { path: string; headers: Headers; body: Uint8Array }[] = [];
let answer = 201;
/** A saved conversation with a title of its own. */
let file = "";

const RUN = "Run echo hi";
const script = (req: { text: string; tools: string[]; toolResults: number }): ScriptedTurn => {
	if (!req.tools.includes("bash")) return { text: "A title" };
	if (req.toolResults > 0) return { text: "Done." };
	if (req.text.includes(RUN)) return { call: { name: "bash", args: { command: "echo hi" } } };
	return { text: "Ok." };
};

beforeAll(async () => {
	key = await makeKey("kid-1");
	jwks = await startJwks([key]);
	backend = await startScriptedStub(script);
	service = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			received.push({
				path: new URL(req.url).pathname,
				headers: req.headers,
				body: new Uint8Array(await req.arrayBuffer()),
			});
			return new Response(null, { status: answer });
		},
	});
	// A built page's static files, as `vite build` copies them: the worker and the manifest are served to anyone.
	mkdirSync(join(dist, "assets"), { recursive: true });
	writeFileSync(
		join(dist, "index.html"),
		'<!doctype html>\n<html><head></head><body><div id="root"></div></body></html>\n',
	);
	for (const name of ["sw.js", "manifest.webmanifest"])
		writeFileSync(join(dist, name), readFileSync(join(PUBLIC, name)));
	writeFileSync(settingsFile, JSON.stringify(GOOD));
	server = await startTestServer(
		0,
		{
			OMP_WEBUI_PUSH_HOSTS: `http://127.0.0.1:${service.port}`,
			OMP_WEBUI_REMOTE_CONFIG: settingsFile,
			OMP_WEBUI_ACCESS_CERTS_URL: jwks.url,
			OMP_WEBUI_DIST: dist,
		},
		{ login: false },
	);
	writeFileSync(
		join(server.agentDir, "models.yml"),
		`providers:\n  omlx:\n    baseUrl: ${backend.url}\n    api: openai-completions\n    apiKey: ${backend.apiKey}\n    discovery:\n      type: openai-models-list\n`,
	);
	writeFileSync(
		join(server.agentDir, "config.yml"),
		[
			"modelRoles:",
			...["default", "smol", "slow", "tiny", "commit"].map((r) => `  ${r}: omlx/stub-model`),
			"spelling:",
			"  autocomplete: ngram",
			"",
		].join("\n"),
	);
	file = writeChatSession(server.agentDir, {
		n: 95,
		title: "Push probe",
		cwd: server.work,
		turns: [{ prompt: "hi", reply: "ok" }],
	});
}, 120_000);

afterAll(async () => {
	await server?.stop();
	await backend?.stop();
	service?.stop(true);
	jwks?.stop();
	rmSync(root, { recursive: true, force: true });
});

const authed = () => ({
	"x-omp-webui-token": server.accessToken,
	"x-omp-webui": "1",
	"content-type": "application/json",
});
const post = (path: string, body: unknown, headers: Record<string, string> = authed()) =>
	fetch(`${server.url}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
const list = async (): Promise<PushList> => (await fetch(`${server.url}${PUSH_API}`, { headers: authed() })).json();
const choose = async (changes: Record<string, string | null>) => {
	expect((await post("/api/prefs", { changes })).status).toBe(200);
};
const revoke = async (...devices: Device[]) => {
	for (const d of devices) expect((await post(`${PUSH_API}/revoke`, { id: d.id })).status).toBe(200);
};

/** Nothing comes of a push that is not to be sent, so nothing says it was not: this is how long it is given to come. */
const quiet = () => Bun.sleep(2500);

let n = 0;
const pushEndpoint = () => `http://127.0.0.1:${service.port}/push/${++n}`;

interface Device {
	receiver: Receiver;
	device: string;
	id: string;
	path: string;
}
/** A browser subscribes: its keys, a name of its own, an endpoint of the stand-in service. */
async function subscribe(
	over: Record<string, unknown> = {},
	headers: Record<string, string> = authed(),
): Promise<Device> {
	const receiver = newReceiver();
	const device = `device-${String(++n).padStart(20, "0")}`;
	const endpoint = pushEndpoint();
	const res = await post(
		`${PUSH_API}/subscribe`,
		{ subscription: { endpoint, keys: receiver.keys }, device, label: "iPhone · Safari (app)", lang: "en", ...over },
		headers,
	);
	expect(res.status).toBe(200);
	const made: { id: string } = await res.json();
	return { receiver, device, id: made.id, path: new URL(endpoint).pathname };
}

/** The messages the stand-in service was sent for `path` since `from`. */
const to = (path: string, from = 0) => received.slice(from).filter((r) => r.path === path);

/** A conversation of the person's own on a new process, ready to be asked `message`. */
async function conversation(message: string, mode?: "always-ask") {
	const ws = await connect(server);
	const live = await request<LiveInfo>(ws, {
		t: "open",
		target: { kind: "new", cwd: server.work, ...(mode ? { approvalMode: mode } : {}) },
	});
	const frames = watchFrames(ws, live.liveId);
	/** Asks it once more and returns when the turn has ended. */
	const run = async () => {
		const ended = frames.after("agent_end");
		await request(ws, { t: "rpc", liveId: live.liveId, command: { type: "prompt", message } });
		await ended;
	};
	return {
		ws,
		live,
		frames,
		run,
		close: async () => {
			await request(ws, { t: "close", liveId: live.liveId });
			ws.close();
		},
	};
}

describe("who may subscribe", () => {
	test("the list, subscribe and revoke want the token, and a change wants the CSRF header, as every other route", async () => {
		expect((await fetch(`${server.url}${PUSH_API}`)).status).toBe(401);
		expect((await post(`${PUSH_API}/subscribe`, {}, { "content-type": "application/json" })).status).toBe(401);
		const noCsrf = { "x-omp-webui-token": server.accessToken, "content-type": "application/json" };
		expect((await post(`${PUSH_API}/subscribe`, {}, noCsrf)).status).toBe(403);
		expect((await post(`${PUSH_API}/revoke-all`, {}, noCsrf)).status).toBe(403);
		const fresh = await list();
		expect(fresh.devices).toEqual([]);
		expect(fresh.publicKey).toMatch(/^[\w-]{87}$/);
	});

	test("the service worker and the manifest are served to anyone, not cached by the browser, with the right types", async () => {
		const sw = await fetch(`${server.url}/sw.js`);
		expect(sw.status).toBe(200);
		expect(sw.headers.get("content-type")).toContain("javascript");
		expect(sw.headers.get("cache-control")).toBe("no-cache");
		expect(await sw.text()).toBe(readFileSync(join(PUBLIC, "sw.js"), "utf8"));
		const manifest = await fetch(`${server.url}/manifest.webmanifest`);
		expect(manifest.status).toBe(200);
		expect(manifest.headers.get("content-type")).toContain("json");
		expect(JSON.parse(await manifest.text()).start_url).toBe("/");
	});

	test("an endpoint that is not a push service's is refused: this computer is not made to fetch what a page names", async () => {
		const from = received.length;
		const keys = newReceiver().keys;
		for (const endpoint of [
			"http://169.254.169.254/latest/meta-data",
			"http://127.0.0.1:1/x",
			"https://evil.example/push",
			"file:///etc/passwd",
			"https://fcm.googleapis.com.evil.example/x",
		]) {
			const res = await post(`${PUSH_API}/subscribe`, { subscription: { endpoint, keys }, device: "z".repeat(24) });
			expect(res.status, endpoint).toBe(400);
		}
		expect((await list()).devices).toEqual([]);
		// Nothing was fetched on the way.
		expect(received.length).toBe(from);
	});

	test("the key and the devices are kept for their user alone, and the list never carries an endpoint or a key", async () => {
		const d = await subscribe({ device: "k".repeat(24) });
		for (const name of ["push-vapid.json", "push-devices.json"]) {
			expect(statSync(join(server.root, "data", name)).mode & 0o777, name).toBe(0o600);
		}
		const text = await (await fetch(`${server.url}${PUSH_API}`, { headers: authed() })).text();
		expect(text).not.toContain("/push/");
		expect(text).not.toContain(d.receiver.keys.p256dh);
		expect(text).not.toContain(d.receiver.keys.auth);
		expect(text).not.toContain("k".repeat(24));
		expect(readFileSync(join(server.root, "data", "push-devices.json"), "utf8")).toContain(d.receiver.keys.p256dh);
		await revoke(d);
	});
});

describe("a page that is not this computer's", () => {
	const now = () => Math.floor(Date.now() / 1000);
	/** What Cloudflare's tunnel sends: the public hostname as Host, the Access token in a header, the app's cookie. */
	const tunnel = async (): Promise<Record<string, string>> => ({
		host: HOSTNAME,
		origin: `https://${HOSTNAME}`,
		"cf-access-jwt-assertion": await sign(key, claims(now())),
		cookie: `ompw_token=${server.accessToken}`,
		"x-omp-webui": "1",
		"content-type": "application/json",
	});
	const tunnelList = async () => fetch(`${server.url}${PUSH_API}`, { headers: await tunnel(), redirect: "manual" });

	test("a phone through the tunnel may subscribe, list and revoke: push is not one of the routes only this computer has", async () => {
		const headers = await tunnel();
		const d = await subscribe({}, headers);
		const res = await fetch(`${server.url}${PUSH_API}`, { headers, redirect: "manual" });
		expect(res.status).toBe(200);
		const seen: PushList = await res.json();
		expect(seen.devices.map((x) => x.id)).toContain(d.id);
		const gone = await fetch(`${server.url}${PUSH_API}/revoke`, {
			method: "POST",
			headers,
			body: JSON.stringify({ id: d.id }),
		});
		expect(gone.status).toBe(200);
		// Without the Access token it is not let in at all.
		const anonymous = { ...headers };
		delete anonymous["cf-access-jwt-assertion"];
		expect((await fetch(`${server.url}${PUSH_API}`, { headers: anonymous, redirect: "manual" })).status).not.toBe(200);
	});

	test("a device that subscribed through the tunnel is pushed to only while remote access is on", async () => {
		await choose({ "ompw.notify": "on", "ompw.lang": "en" });
		const behindTunnel = await subscribe({}, await tunnel());
		const control = await subscribe();
		const from = received.length;
		const c = await conversation("hello");
		await c.run();
		await pollUntil(
			() => to(behindTunnel.path, from).length === 1 && to(control.path, from).length === 1,
			"the pushes while remote access is on",
		);

		// Remote access turned off: the device is kept, and told nothing, while a device of this computer still is.
		writeFileSync(settingsFile, JSON.stringify({ ...GOOD, enabled: false }));
		await pollUntil(async () => (await tunnelList()).status !== 200, "remote access to be refused");
		await c.run();
		await pollUntil(() => to(control.path, from).length === 2, "the push to the device of this computer");
		expect(to(behindTunnel.path, from)).toHaveLength(1);

		// And it is told again once remote access is on.
		writeFileSync(settingsFile, JSON.stringify(GOOD));
		await pollUntil(async () => (await tunnelList()).status === 200, "remote access to be let in again");
		await c.run();
		await pollUntil(() => to(behindTunnel.path, from).length === 2, "the push once remote access is on again");
		await c.close();
		await revoke(behindTunnel, control);
	}, 120_000);
});

describe("a conversation that needs somebody", () => {
	test("a turn that ends is pushed to a device, encrypted for it, with the sender's identity and nothing of what was said", async () => {
		await choose({ "ompw.notify": "on", "ompw.lang": "en" });
		const d = await subscribe();
		const other = await subscribe();
		const from = received.length;
		const c = await conversation("my password is hunter2, please say ok");
		await c.run();
		await pollUntil(
			() => to(d.path, from).length > 0 && to(other.path, from).length > 0,
			"the pushes of a finished turn",
		);
		const sent = to(d.path, from)[0];
		const { publicKey } = await list();
		expect(sent.headers.get("content-encoding")).toBe("aes128gcm");
		expect(Number(sent.headers.get("ttl"))).toBeGreaterThan(0);
		const auth = sent.headers.get("authorization") ?? "";
		const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(auth);
		if (!match) throw new Error(`not a VAPID header: ${auth}`);
		expect(match[4]).toBe(publicKey);
		const claimsOf = JSON.parse(Buffer.from(match[2], "base64url").toString());
		expect(claimsOf.aud).toBe(`http://127.0.0.1:${service.port}`);
		// The token is signed with the key the list gave the browser.
		const pub = await crypto.subtle.importKey(
			"raw",
			Buffer.from(publicKey, "base64url"),
			{ name: "ECDSA", namedCurve: "P-256" },
			false,
			["verify"],
		);
		const signed = await crypto.subtle.verify(
			{ name: "ECDSA", hash: "SHA-256" },
			pub,
			Buffer.from(match[3], "base64url"),
			new TextEncoder().encode(`${match[1]}.${match[2]}`),
		);
		expect(signed).toBe(true);
		// What the browser reads: the conversation, why, and nothing else.
		const read = d.receiver.read(sent.body);
		expect(read.text).not.toContain("hunter2");
		expect(read.text).not.toContain("Ok.");
		const payload = d.receiver.payload(sent.body);
		expect(Object.keys(payload).sort()).toEqual(["body", "file", "kind", "liveId", "title", "v"]);
		expect(payload).toMatchObject({ v: 1, kind: "finished", liveId: c.live.liveId, body: "Finished" });
		expect(typeof payload.title).toBe("string");
		// Another device cannot read it.
		expect(() => other.receiver.read(sent.body)).toThrow();
		await c.close();
		await revoke(d, other);
	}, 120_000);

	test("a page of the device that is on screen holds its push back; one that says it is hidden, or is gone, does not", async () => {
		await choose({ "ompw.notify": "on", "ompw.lang": "en" });
		const d = await subscribe();
		const control = await subscribe();
		const from = received.length;
		const page = await connect(server);
		page.send(JSON.stringify({ t: "presence", device: d.device, visible: true }));
		// Messages of one socket are taken in order: when a reply comes, the server has had the presence before it.
		await request(page, { t: "list_lives" });
		const c = await conversation("hello");
		await c.run();
		await pollUntil(() => to(control.path, from).length === 1, "the push of the device that has no page on screen");
		expect(to(d.path, from)).toHaveLength(0);

		page.send(JSON.stringify({ t: "presence", device: d.device, visible: false }));
		await request(page, { t: "list_lives" });
		await c.run();
		await pollUntil(() => to(d.path, from).length === 1, "the push once the page says it is hidden");

		// A page that closes is not on screen either.
		page.send(JSON.stringify({ t: "presence", device: d.device, visible: true }));
		await request(page, { t: "list_lives" });
		page.close();
		await c.run();
		await pollUntil(() => to(d.path, from).length >= 2, "the push once the page is gone");
		await c.close();
		await revoke(d, control);
	}, 120_000);

	test("a page in use holds back the push of the conversation it shows only: on another conversation or page it does not (#655)", async () => {
		await choose({ "ompw.notify": "on", "ompw.lang": "en" });
		const d = await subscribe();
		const control = await subscribe();
		const from = received.length;
		const page = await connect(server);
		const c = await conversation("hello");
		const say = async (shown?: { liveId: string | null; file: string | null }) => {
			page.send(JSON.stringify({ t: "presence", device: d.device, visible: true, ...shown }));
			await request(page, { t: "list_lives" });
		};
		/** One more turn; `control` has no page, so its push says the decision about `d` was made. */
		const turn = async (pushes: number) => {
			await c.run();
			await pollUntil(
				() => to(control.path, from).length === pushes,
				`the push of turn ${pushes} to the device with no page`,
			);
		};

		// The page is in use and shows this conversation: nothing is pushed to it.
		await say({ liveId: c.live.liveId, file: null });
		await turn(1);
		expect(to(d.path, from)).toHaveLength(0);

		// It is in use and shows no conversation (another page), or another one: the reply is pushed.
		await say({ liveId: null, file: null });
		await turn(2);
		await pollUntil(() => to(d.path, from).length === 1, "the push while the page shows no conversation");
		await say({ liveId: "somebody-else", file: "/elsewhere.jsonl" });
		await turn(3);
		await pollUntil(() => to(d.path, from).length === 2, "the push while the page shows another conversation");

		// A page that says nothing of what it shows (one from before this was said) holds back everything.
		await say();
		await turn(4);
		expect(to(d.path, from)).toHaveLength(2);
		page.close();
		await c.close();
		await revoke(d, control);
	}, 120_000);

	test("an approval that waits is pushed as asking, and a device that chose a preview is told a line of what it asks", async () => {
		await choose({ "ompw.notify": "on", "ompw.lang": "zh-CN" });
		const plain = await subscribe();
		const wants = await subscribe({ preview: true });
		const from = received.length;
		const c = await conversation(RUN, "always-ask");
		const asked = c.frames.next((f) => f.type === "extension_ui_request" && f.method === "select");
		await request(c.ws, { t: "rpc", liveId: c.live.liveId, command: { type: "prompt", message: RUN } });
		const approval = await asked;
		await pollUntil(
			() => to(plain.path, from).length > 0 && to(wants.path, from).length > 0,
			"the pushes of an approval",
		);
		const a = plain.receiver.payload(to(plain.path, from)[0].body);
		expect(a).toMatchObject({ kind: "asking", body: "需要你的输入", liveId: c.live.liveId });
		const b = wants.receiver.payload(to(wants.path, from)[0].body);
		expect(b.kind).toBe("asking");
		expect(String(b.body).startsWith("需要你的输入 — ")).toBe(true);
		expect(Array.from(String(b.body)).length).toBeLessThanOrEqual(135);
		expect(to(plain.path, from)[0].headers.get("urgency")).toBe("high");
		const deny = (approval.options as string[]).find((o) => /^Deny/i.test(o));
		const ended = c.frames.after("agent_end");
		c.ws.send(JSON.stringify({ t: "ui_response", liveId: c.live.liveId, response: { id: approval.id, value: deny } }));
		await ended;
		await c.close();
		await revoke(plain, wants);
	}, 120_000);

	test("the preview a device chose is the last reply of the turn; it can be switched off again", async () => {
		await choose({ "ompw.notify": "on", "ompw.lang": "en" });
		const d = await subscribe();
		expect((await post(`${PUSH_API}/preview`, { id: d.id, preview: true })).status).toBe(200);
		expect((await list()).devices.find((x) => x.id === d.id)?.preview).toBe(true);
		const from = received.length;
		const c = await conversation("hello");
		await c.run();
		await pollUntil(() => to(d.path, from).length === 1, "the push of a turn");
		expect(d.receiver.payload(to(d.path, from)[0].body).body).toBe("Finished — Ok.");
		expect((await post(`${PUSH_API}/preview`, { id: d.id, preview: false })).status).toBe(200);
		await c.run();
		await pollUntil(() => to(d.path, from).length === 2, "the second push");
		expect(d.receiver.payload(to(d.path, from)[1].body).body).toBe("Finished");
		await c.close();
		await revoke(d);
	}, 120_000);

	test("a saved conversation is named by its title, and a click on it is by its file; the saved language wins over the device's", async () => {
		await choose({ "ompw.notify": "on", "ompw.lang": "en" });
		const d = await subscribe({ lang: "zh-CN" });
		const from = received.length;
		const ws = await connect(server);
		const live = await request<LiveInfo>(ws, {
			t: "open",
			target: { kind: "resume", sessionFile: file, model: "omlx/stub-model" },
		});
		const frames = watchFrames(ws, live.liveId);
		const ask = async (message: string) => {
			const ended = frames.after("agent_end");
			await request(ws, { t: "rpc", liveId: live.liveId, command: { type: "prompt", message } });
			await ended;
		};
		await ask("one");
		await pollUntil(() => to(d.path, from).length === 1, "the push of a resumed conversation");
		expect(d.receiver.payload(to(d.path, from)[0].body)).toMatchObject({
			title: "Push probe",
			file: live.sessionFile,
			liveId: live.liveId,
			body: "Finished",
		});
		// With none saved, the device's own language is the words.
		await choose({ "ompw.lang": null });
		await ask("two");
		await pollUntil(() => to(d.path, from).length === 2, "the second push");
		expect(d.receiver.payload(to(d.path, from)[1].body).body).toBe("已完成");
		await request(ws, { t: "close", liveId: live.liveId });
		ws.close();
		await revoke(d);
	}, 120_000);

	test("nothing is sent while Settings has notifications off, and a conversation that ran meanwhile is not told of afterwards", async () => {
		await choose({ "ompw.notify": "off", "ompw.lang": "en" });
		const d = await subscribe();
		const from = received.length;
		const quietOne = await conversation("hello");
		await quietOne.run();
		await quiet();
		expect(to(d.path, from)).toHaveLength(0);
		await choose({ "ompw.notify": "on" });
		const loud = await conversation("hello");
		await loud.run();
		await pollUntil(() => to(d.path, from).length === 1, "the push of the conversation that ran with notifications on");
		expect(d.receiver.payload(to(d.path, from)[0].body)).toMatchObject({ liveId: loud.live.liveId });
		await quietOne.close();
		await loud.close();
		await revoke(d);
	}, 120_000);
});

describe("what the push service says", () => {
	test("the test notification reaches the device whatever is on screen, and says what the service answered", async () => {
		const d = await subscribe({ lang: "zh-CN" });
		await choose({ "ompw.lang": null });
		const from = received.length;
		const page = await connect(server);
		page.send(JSON.stringify({ t: "presence", device: d.device, visible: true }));
		await request(page, { t: "list_lives" });
		const res = await post(`${PUSH_API}/test`, { id: d.id });
		expect(await res.json()).toEqual({ ok: true, status: 201 });
		expect(d.receiver.payload(to(d.path, from)[0].body)).toMatchObject({
			kind: "test",
			liveId: null,
			file: null,
			title: "推送已开启",
		});
		// A second test to the same device at once is refused with a message, and sends nothing.
		const sentBefore = received.length;
		const again = await post(`${PUSH_API}/test`, { id: d.id });
		expect(again.status).toBe(429);
		expect(Number(again.headers.get("retry-after"))).toBeGreaterThan(0);
		expect((await again.json()).error).toContain("wait a few seconds");
		expect(received.length).toBe(sentBefore);
		page.close();

		// Each device has a cooldown of its own: these are tried once each.
		const down = await subscribe();
		const gone = await subscribe();
		answer = 503;
		try {
			expect(await (await post(`${PUSH_API}/test`, { id: down.id })).json()).toEqual({ ok: false, status: 503 });
			// A service that is down is no reason to forget the device.
			expect((await list()).devices.map((x) => x.id)).toContain(down.id);
			answer = 410;
			expect(await (await post(`${PUSH_API}/test`, { id: gone.id })).json()).toEqual({ ok: false, status: 410 });
		} finally {
			answer = 201;
		}
		// The browser withdrew the subscription: the device is gone from the list.
		expect((await list()).devices.map((x) => x.id)).not.toContain(gone.id);
		expect((await post(`${PUSH_API}/test`, { id: gone.id })).status).toBe(404);
		await revoke(d, down);
	}, 60_000);

	test("revoke takes a device off, and a revoked one is sent nothing; revoke-all takes every device", async () => {
		await choose({ "ompw.notify": "on", "ompw.lang": "en" });
		const a = await subscribe();
		const b = await subscribe();
		const c = await subscribe();
		await revoke(a);
		const from = received.length;
		const talk = await conversation("hello");
		await talk.run();
		await pollUntil(
			() => to(b.path, from).length === 1 && to(c.path, from).length === 1,
			"the pushes to the devices that are left",
		);
		expect(to(a.path, from)).toHaveLength(0);
		expect(await (await post(`${PUSH_API}/revoke-all`, {})).json()).toEqual({ removed: 2 });
		expect((await list()).devices).toEqual([]);
		const after = received.length;
		await talk.run();
		await quiet();
		expect(received.length).toBe(after);
		await talk.close();
	}, 120_000);
});
