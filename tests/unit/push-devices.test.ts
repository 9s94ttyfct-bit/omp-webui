import { describe, expect, test } from "bun:test";
import { createECDH } from "node:crypto";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { b64u, generateVapidKey } from "../../server/push/crypto.ts";
import { DEVICES_FILE, DeviceError, type NewDevice, PushDevices } from "../../server/push/devices.ts";
import { allowedEndpoint, extraOrigins } from "../../server/push/endpoint.ts";
import { loadVapid, VAPID_FILE } from "../../server/push/vapid.ts";
import { MAX_PUSH_DEVICES } from "../../shared/push.ts";
import { tempDir } from "../support/temp-dirs.ts";

/** What the server keeps of the devices and of its own key: for its user alone, and nothing a page can make it send to. */

/** A directory of its own, removed when the tests end. */
const dir = () => tempDir("ompw-push-devices-");

const keys = () => {
	const receiver = createECDH("prime256v1");
	receiver.generateKeys();
	return {
		p256dh: b64u.encode(new Uint8Array(receiver.getPublicKey())),
		auth: b64u.encode(crypto.getRandomValues(new Uint8Array(16))),
	};
};
let n = 0;
const device = (over: Partial<NewDevice> = {}): NewDevice => {
	n++;
	return {
		device: `device-${String(n).padStart(20, "0")}`,
		endpoint: `https://fcm.googleapis.com/fcm/send/abc${n}`,
		...keys(),
		label: "iPhone · Safari (app)",
		lang: "en",
		preview: false,
		remote: false,
		...over,
	};
};
const mode = (path: string) => statSync(path).mode & 0o777;

describe("which endpoints are sent to", () => {
	test("the browsers' own push services, over https on their own port", () => {
		for (const ok of [
			"https://fcm.googleapis.com/fcm/send/abc",
			"https://android.googleapis.com/gcm/send/abc",
			"https://updates.push.services.mozilla.com/wpush/v2/abc",
			"https://web.push.apple.com/QXYZ",
			"https://wns2-par02p.notify.windows.com/w/?token=abc",
		]) {
			expect(allowedEndpoint(ok)).toBe(true);
		}
	});

	test("nothing that would make this computer fetch an address of its own network (SSRF)", () => {
		for (const bad of [
			"http://169.254.169.254/latest/meta-data/",
			"https://127.0.0.1/push",
			"https://localhost/push",
			"https://192.168.1.1/",
			"http://fcm.googleapis.com/fcm/send/abc",
			"https://fcm.googleapis.com:8443/fcm/send/abc",
			"https://fcm.googleapis.com.evil.example/fcm/send/abc",
			"https://evilfcm.googleapis.com.example/",
			"https://notfcm.googleapis.com@evil.example/",
			"https://user:pass@fcm.googleapis.com/fcm/send/abc",
			"https://evil.example/?https://fcm.googleapis.com/",
			"https://googleapis.com/fcm",
			"ftp://fcm.googleapis.com/x",
			"file:///etc/passwd",
			"javascript:alert(1)",
			"//fcm.googleapis.com/x",
			"",
			42,
			null,
			undefined,
			`https://fcm.googleapis.com/${"a".repeat(2100)}`,
		]) {
			expect(allowedEndpoint(bad)).toBe(false);
		}
	});

	test("another service is named by the person who runs the server, as an origin, and by nobody else", () => {
		const extra = extraOrigins(
			"http://127.0.0.1:8123, https://push.example.com, nonsense, ftp://x, https://u:p@h.example",
		);
		expect(extra).toEqual(["http://127.0.0.1:8123", "https://push.example.com"]);
		expect(allowedEndpoint("http://127.0.0.1:8123/push/abc", extra)).toBe(true);
		expect(allowedEndpoint("https://push.example.com/abc", extra)).toBe(true);
		// An origin is the whole of scheme, host and port.
		expect(allowedEndpoint("http://127.0.0.1:8124/push/abc", extra)).toBe(false);
		expect(allowedEndpoint("http://127.0.0.1:8123@evil.example/", extra)).toBe(false);
		expect(allowedEndpoint("http://127.0.0.1:8123/push/abc")).toBe(false);
	});
});

describe("the key", () => {
	test("is made once, for its user alone, and is the same key the next time", async () => {
		const data = dir();
		const first = await loadVapid(data);
		expect(mode(join(data, VAPID_FILE))).toBe(0o600);
		const again = await loadVapid(data);
		expect(again.publicKey).toBe(first.publicKey);
	});

	test("a file with looser permissions is closed, and one that cannot be read is replaced by a new key", async () => {
		const data = dir();
		const first = await loadVapid(data);
		chmodSync(join(data, VAPID_FILE), 0o644);
		expect((await loadVapid(data)).publicKey).toBe(first.publicKey);
		expect(mode(join(data, VAPID_FILE))).toBe(0o600);
		writeFileSync(join(data, VAPID_FILE), '{"v":1,"jwk":{"kty":"EC"');
		const warn = console.warn;
		console.warn = () => {};
		try {
			const replaced = await loadVapid(data);
			expect(replaced.publicKey).not.toBe(first.publicKey);
			expect(mode(join(data, VAPID_FILE))).toBe(0o600);
			expect((await loadVapid(data)).publicKey).toBe(replaced.publicKey);
		} finally {
			console.warn = warn;
		}
	});

	test.skipIf(process.getuid?.() === 0)(
		"a file that cannot be read for want of permission is no reason to make a new key: loading fails and the key stays",
		async () => {
			const data = dir();
			const first = await loadVapid(data);
			chmodSync(join(data, VAPID_FILE), 0o000);
			try {
				await expect(loadVapid(data)).rejects.toMatchObject({ code: "EACCES" });
			} finally {
				chmodSync(join(data, VAPID_FILE), 0o600);
			}
			expect((await loadVapid(data)).publicKey).toBe(first.publicKey);
		},
	);
});

describe("the devices", () => {
	test("are kept for their user alone, and what is kept is read again", async () => {
		const data = dir();
		const key = await generateVapidKey();
		const store = new PushDevices(data, key.publicKey);
		const record = store.upsert(device(), 1000);
		expect(mode(join(data, DEVICES_FILE))).toBe(0o600);
		const reread = new PushDevices(data, key.publicKey);
		expect(reread.get(record.id)).toMatchObject({ id: record.id, endpoint: record.endpoint, createdAt: 1000 });
	});

	test("what is listed carries neither the endpoint nor the keys", async () => {
		const key = await generateVapidKey();
		const store = new PushDevices(dir(), key.publicKey);
		const record = store.upsert(device(), 5);
		const listed = JSON.stringify(store.list());
		expect(listed).not.toContain(record.endpoint);
		expect(listed).not.toContain(record.p256dh);
		expect(listed).not.toContain(record.auth);
		expect(store.list()).toEqual([
			{ id: record.id, label: record.label, createdAt: 5, lastSentAt: null, preview: false },
		]);
	});

	test("a device that subscribes again is the same device, with the id and the date it had", async () => {
		const key = await generateVapidKey();
		const store = new PushDevices(dir(), key.publicKey);
		const first = store.upsert(device({ device: "d".repeat(20) }), 10);
		const second = store.upsert(device({ device: "d".repeat(20), preview: true }), 99);
		expect(store.size).toBe(1);
		expect(second.id).toBe(first.id);
		expect(second.createdAt).toBe(10);
		expect(second.preview).toBe(true);
		// The same endpoint under another device name is the same subscription, too: one record, never two to send to.
		store.upsert(device({ device: "e".repeat(20), endpoint: second.endpoint }), 100);
		expect(store.size).toBe(1);
	});

	test(`at most ${MAX_PUSH_DEVICES}: the next is refused with a conflict, and a known one still goes through`, async () => {
		const key = await generateVapidKey();
		const store = new PushDevices(dir(), key.publicKey);
		const made = Array.from({ length: MAX_PUSH_DEVICES }, () => store.upsert(device(), 1));
		expect(() => store.upsert(device(), 2)).toThrow(DeviceError);
		try {
			store.upsert(device(), 2);
		} catch (e) {
			expect((e as DeviceError).status).toBe(409);
		}
		expect(store.upsert({ ...device(), device: made[0].device }, 3).id).toBe(made[0].id);
	});

	test("revoke takes one away, revoke-all every one, and a name nobody has is no revoke", async () => {
		const data = dir();
		const key = await generateVapidKey();
		const store = new PushDevices(data, key.publicKey);
		const a = store.upsert(device(), 1);
		const b = store.upsert(device(), 1);
		expect(store.remove("nobody")).toBe(false);
		expect(store.remove(a.id)).toBe(true);
		expect(store.get(a.id)).toBeUndefined();
		expect(store.removeAll()).toBe(1);
		expect(store.get(b.id)).toBeUndefined();
		expect(store.removeAll()).toBe(0);
		expect(new PushDevices(data, key.publicKey).size).toBe(0);
	});

	test("the last send is noted to the minute: a conversation that talks a lot does not write the file each time", async () => {
		const data = dir();
		const key = await generateVapidKey();
		const store = new PushDevices(data, key.publicKey);
		const record = store.upsert(device(), 1);
		store.sent(record.id, 100_000);
		expect(store.get(record.id)?.lastSentAt).toBe(100_000);
		store.sent(record.id, 100_000 + 30_000);
		expect(store.get(record.id)?.lastSentAt).toBe(100_000);
		store.sent(record.id, 100_000 + 61_000);
		expect(store.get(record.id)?.lastSentAt).toBe(161_000);
	});

	test("what was subscribed with another key is not read: no push service would take a message for it", async () => {
		const data = dir();
		const old = await generateVapidKey();
		new PushDevices(data, old.publicKey).upsert(device(), 1);
		const fresh = await generateVapidKey();
		expect(new PushDevices(data, fresh.publicKey).size).toBe(0);
		expect(new PushDevices(data, old.publicKey).size).toBe(1);
	});

	test("a file edited by hand is read for what is good in it: an endpoint that is not a push service's, keys cut short, a name that is none", async () => {
		const data = dir();
		const key = await generateVapidKey();
		const good = new PushDevices(data, key.publicKey).upsert(device(), 1);
		const file = join(data, DEVICES_FILE);
		const stored = JSON.parse(readFileSync(file, "utf8"));
		const k = keys();
		stored.devices.push(
			{ ...good, id: "evil-endpoint-1", device: "x".repeat(20), endpoint: "http://169.254.169.254/latest" },
			{
				...good,
				id: "short-keys-1",
				device: "y".repeat(20),
				endpoint: "https://fcm.googleapis.com/fcm/send/z",
				p256dh: "AAAA",
				auth: k.auth,
			},
			{ ...good, id: "bad name", device: "z".repeat(20), endpoint: "https://fcm.googleapis.com/fcm/send/q" },
			"not a record",
			null,
		);
		writeFileSync(file, JSON.stringify(stored));
		const store = new PushDevices(data, key.publicKey);
		expect(store.all().map((d) => d.id)).toEqual([good.id]);
		writeFileSync(file, "{ not json");
		expect(new PushDevices(data, key.publicKey).size).toBe(0);
	});
});
