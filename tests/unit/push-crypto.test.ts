import { describe, expect, test } from "bun:test";
import { createECDH } from "node:crypto";
import {
	b64u,
	encryptMessage,
	generateVapidKey,
	KeyError,
	MAX_PLAINTEXT,
	RECORD_SIZE,
	receiverOf,
	vapidAuthorization,
	vapidKeyOf,
	verifiedReceiver,
} from "../../server/push/crypto.ts";
import { receive } from "../support/push-receiver.ts";

/**
 * What Web Push puts on the wire. The first half is held to RFC 8291's own example (section 5, with the keys of its
 * appendix), byte for byte, and to a receiver that is written from the RFC with another implementation (`node:crypto`):
 * a message that only our own code can read would pass a test of our own code and be refused by every browser.
 */

const RFC = {
	plaintext: "When I grow up, I want to be a watermelon",
	auth: "BTBZMqHH6r4Tts7J_aSIgg",
	receiverPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
	receiverPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
	senderPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
	senderPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
	salt: "DGv6ra1nlYgDCS1FRnbzlw",
	/** The body of the RFC's example message (its line breaks removed). */
	body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

const bytes = (text: string): Uint8Array => {
	const out = b64u.decode(text);
	if (!out) throw new Error("not base64url");
	return out;
};

/** A P-256 key pair from the raw private scalar and the uncompressed public point, as the RFC prints them. */
async function pairOf(privateKey: string, publicKey: string): Promise<CryptoKeyPair> {
	const point = bytes(publicKey);
	const jwk = {
		kty: "EC",
		crv: "P-256",
		x: b64u.encode(point.slice(1, 33)),
		y: b64u.encode(point.slice(33, 65)),
	};
	const algorithm = { name: "ECDH", namedCurve: "P-256" };
	return {
		privateKey: await crypto.subtle.importKey("jwk", { ...jwk, d: privateKey }, algorithm, true, ["deriveBits"]),
		publicKey: await crypto.subtle.importKey("jwk", jwk, algorithm, true, []),
	};
}

describe("RFC 8291 message encryption", () => {
	test("the example of section 5 comes out byte for byte", async () => {
		const sender = await pairOf(RFC.senderPrivate, RFC.senderPublic);
		const body = await encryptMessage(
			new TextEncoder().encode(RFC.plaintext),
			{ p256dh: bytes(RFC.receiverPublic), auth: bytes(RFC.auth) },
			{ salt: bytes(RFC.salt), sender },
		);
		expect(b64u.encode(body)).toBe(RFC.body);
		// 86 octets of header, the 41 of the text, the delimiter and the 16 of the tag (the RFC's "145" is its known erratum).
		expect(body.length).toBe(144);
	});

	test("a receiver written from the RFC with node:crypto reads what a new message says, and nothing else is in it", async () => {
		const receiver = createECDH("prime256v1");
		receiver.generateKeys();
		const auth = crypto.getRandomValues(new Uint8Array(16));
		const body = await encryptMessage(
			new TextEncoder().encode('{"v":1,"title":"Fixing the build"}'),
			{ p256dh: new Uint8Array(receiver.getPublicKey()), auth },
			{ padTo: 128 },
		);
		const read = receive(body, new Uint8Array(receiver.getPrivateKey()), new Uint8Array(receiver.getPublicKey()), auth);
		expect(read.text).toBe('{"v":1,"title":"Fixing the build"}');
		expect(read.delimiter).toBe(2);
		expect(read.recordSize).toBe(RECORD_SIZE);
		expect(read.idLength).toBe(65);
		expect(read.senderPublic[0]).toBe(4);
	});

	test("a new message has a new salt and a new sender key every time", async () => {
		const receiver = createECDH("prime256v1");
		receiver.generateKeys();
		const to = { p256dh: new Uint8Array(receiver.getPublicKey()), auth: crypto.getRandomValues(new Uint8Array(16)) };
		const a = await encryptMessage(new TextEncoder().encode("x"), to);
		const b = await encryptMessage(new TextEncoder().encode("x"), to);
		expect(Buffer.from(a.slice(0, 16)).equals(Buffer.from(b.slice(0, 16)))).toBe(false);
		expect(Buffer.from(a.slice(21, 86)).equals(Buffer.from(b.slice(21, 86)))).toBe(false);
	});

	test("padding hides the length: messages of different texts fill the same number of octets", async () => {
		const receiver = createECDH("prime256v1");
		receiver.generateKeys();
		const to = { p256dh: new Uint8Array(receiver.getPublicKey()), auth: crypto.getRandomValues(new Uint8Array(16)) };
		const short = await encryptMessage(new TextEncoder().encode("a"), to, { padTo: 128 });
		const longer = await encryptMessage(new TextEncoder().encode("a".repeat(100)), to, { padTo: 128 });
		expect(short.length).toBe(longer.length);
		expect(short.length).toBe(86 + 128 + 16);
		// And it is still the text that comes out.
		const read = receive(longer, new Uint8Array(receiver.getPrivateKey()), to.p256dh, to.auth);
		expect(read.text).toBe("a".repeat(100));
	});

	test("a text that does not fit one record is refused, and the largest one that does is sent", async () => {
		const receiver = createECDH("prime256v1");
		receiver.generateKeys();
		const to = { p256dh: new Uint8Array(receiver.getPublicKey()), auth: crypto.getRandomValues(new Uint8Array(16)) };
		await expect(encryptMessage(new Uint8Array(MAX_PLAINTEXT + 1), to)).rejects.toThrow(RangeError);
		const full = await encryptMessage(new Uint8Array(MAX_PLAINTEXT).fill(97), to, { padTo: 4096 });
		// A push service is not required to take more than 4096 octets of body (RFC 8030 section 7.2).
		expect(full.length).toBeLessThanOrEqual(4096);
		expect(receive(full, new Uint8Array(receiver.getPrivateKey()), to.p256dh, to.auth).text).toBe(
			"a".repeat(MAX_PLAINTEXT),
		);
	});
});

describe("subscription keys", () => {
	const good = () => {
		const receiver = createECDH("prime256v1");
		receiver.generateKeys();
		return {
			p256dh: b64u.encode(new Uint8Array(receiver.getPublicKey())),
			auth: b64u.encode(crypto.getRandomValues(new Uint8Array(16))),
		};
	};

	test("a key and a secret of the right shape are taken", async () => {
		const k = good();
		expect(receiverOf(k.p256dh, k.auth).p256dh.length).toBe(65);
		expect((await verifiedReceiver(k.p256dh, k.auth)).auth.length).toBe(16);
	});

	test("what is not a key is refused: the wrong type, length, form, alphabet and padding", () => {
		const k = good();
		for (const bad of [undefined, null, 5, "", "AAAA", `${k.p256dh}A`, `${k.p256dh}==`, "not base64url!"]) {
			expect(() => receiverOf(bad, k.auth)).toThrow(KeyError);
		}
		// A compressed point (0x02 or 0x03 in front, 33 octets) is not the form a browser sends.
		expect(() => receiverOf(b64u.encode(new Uint8Array(33).fill(2)), k.auth)).toThrow(KeyError);
		for (const bad of [undefined, 7, "", b64u.encode(new Uint8Array(15)), b64u.encode(new Uint8Array(17))]) {
			expect(() => receiverOf(k.p256dh, bad)).toThrow(KeyError);
		}
	});

	test("a point that is not on the curve is refused (RFC 8291 section 7), when the subscription is made", async () => {
		const k = good();
		const off = new Uint8Array(65).fill(7);
		off[0] = 4;
		await expect(verifiedReceiver(b64u.encode(off), k.auth)).rejects.toThrow(KeyError);
		await expect(encryptMessage(new TextEncoder().encode("x"), { p256dh: off, auth: bytes(k.auth) })).rejects.toThrow(
			KeyError,
		);
	});
});

describe("VAPID", () => {
	test("the token is an ES256 JWT for the push service's origin that its public key verifies and that ends within a day", async () => {
		const key = await generateVapidKey();
		const now = Date.UTC(2026, 9, 25, 12, 0, 0);
		const header = await vapidAuthorization(
			key,
			"https://push.example.net/push/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV",
			"mailto:a@example.com",
			now,
		);
		const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
		if (!match) throw new Error(`not a VAPID header: ${header}`);
		const [, head, claims, signature, k] = match;
		expect(k).toBe(key.publicKey);
		expect(JSON.parse(Buffer.from(head, "base64url").toString())).toEqual({ typ: "JWT", alg: "ES256" });
		const payload = JSON.parse(Buffer.from(claims, "base64url").toString());
		expect(payload.aud).toBe("https://push.example.net");
		expect(payload.sub).toBe("mailto:a@example.com");
		expect(payload.exp).toBeGreaterThan(now / 1000);
		expect(payload.exp - now / 1000).toBeLessThanOrEqual(24 * 60 * 60);
		const point = bytes(key.publicKey);
		const pub = await crypto.subtle.importKey(
			"raw",
			point as BufferSource,
			{ name: "ECDSA", namedCurve: "P-256" },
			false,
			["verify"],
		);
		const raw = bytes(signature);
		// A JWS signature is the raw r || s of 64 octets, not DER.
		expect(raw.length).toBe(64);
		expect(
			await crypto.subtle.verify(
				{ name: "ECDSA", hash: "SHA-256" },
				pub,
				raw as BufferSource,
				new TextEncoder().encode(`${head}.${claims}`) as BufferSource,
			),
		).toBe(true);
	});

	test("the audience is the origin of the endpoint, port included", async () => {
		const key = await generateVapidKey();
		const header = await vapidAuthorization(key, "http://127.0.0.1:8123/push/abc", "mailto:a@example.com", Date.now());
		const claims = /t=[\w-]+\.([\w-]+)\./.exec(header)?.[1] ?? "";
		expect(JSON.parse(Buffer.from(claims, "base64url").toString()).aud).toBe("http://127.0.0.1:8123");
	});

	test("a key read from its file is the key that was kept, and a file that is not a key is none", async () => {
		const key = await generateVapidKey();
		const again = await vapidKeyOf(JSON.parse(JSON.stringify(key.jwk)));
		expect(again?.publicKey).toBe(key.publicKey);
		// A public half the file claims is not trusted: it is worked out from the key.
		const lying = await vapidKeyOf({ ...key.jwk, x: b64u.encode(new Uint8Array(32).fill(1)) });
		expect(lying === null || lying.publicKey !== key.publicKey).toBe(true);
		for (const bad of [
			null,
			"x",
			5,
			{},
			{ ...key.jwk, d: undefined },
			{ ...key.jwk, crv: "P-384" },
			{ ...key.jwk, kty: "RSA" },
			{ ...key.jwk, d: "AAAA" },
		]) {
			expect(await vapidKeyOf(bad)).toBeNull();
		}
	});
});
