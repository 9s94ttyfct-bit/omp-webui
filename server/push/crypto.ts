/**
 * What Web Push puts on the wire, with the platform's WebCrypto and nothing else (no library):
 *
 * - the message, encrypted for one browser as RFC 8291 says (the `aes128gcm` coding of RFC 8188, one record): the push
 *   service that carries it, and whoever sits on the path to it, see only what it cannot read;
 * - the sender's identity, a VAPID token (RFC 8292): an ES256 JWT that tells the push service who sends, so that it
 *   will take the message and only this server can send to a subscription made with its key.
 *
 * `tests/unit/push-crypto.test.ts` holds the first to the RFC's own example (every byte of it) and to a receiver that is
 * written from the RFC with another implementation (`node:crypto`).
 */
import { isRecord } from "../../shared/guards.ts";

const ENCODER = new TextEncoder();
const EC = { name: "ECDH", namedCurve: "P-256" } as const;

/** The record size the message states: all of it is one record, and a push service takes at most 4096 octets of body. */
export const RECORD_SIZE = 4096;
/** The header in front of the ciphertext: salt (16), record size (4), key id length (1), the sender's public key (65). */
const HEADER = 16 + 4 + 1 + 65;
/** The most plaintext one message holds: the body (4096) less the header, the padding delimiter (1) and the AEAD tag (16). */
export const MAX_PLAINTEXT = RECORD_SIZE - HEADER - 1 - 16;

export const b64u = {
	encode: (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url"),
	/** The bytes of a base64url string; null for anything that is not one (the alphabet is checked, padding is refused). */
	decode(text: string): Uint8Array | null {
		if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
		return new Uint8Array(Buffer.from(text, "base64url"));
	},
};

/** What a browser gives of its subscription: its ECDH public key (65 octets, uncompressed) and its authentication secret (16). */
export interface Receiver {
	p256dh: Uint8Array;
	auth: Uint8Array;
}

/** Why a subscription's keys cannot be used: a `Receiver` is made only of keys that can. */
export class KeyError extends Error {}

/** The receiver `p256dh` and `auth` (base64url, as `PushSubscription.toJSON()` has them) name; throws `KeyError` for keys that are none. */
export function receiverOf(p256dh: unknown, auth: unknown): Receiver {
	const key = typeof p256dh === "string" ? b64u.decode(p256dh) : null;
	const secret = typeof auth === "string" ? b64u.decode(auth) : null;
	if (key === null || key.length !== 65 || key[0] !== 4) {
		throw new KeyError("p256dh is not an uncompressed P-256 public key");
	}
	if (secret === null || secret.length !== 16) throw new KeyError("auth is not a 16-octet secret");
	return { p256dh: key, auth: secret };
}

/**
 * `receiverOf`, and the point is checked to lie on the P-256 curve (RFC 8291 section 7): importing it is what checks. A
 * subscription whose key is no point is refused here, when it is made, and not when the first message is to be sent.
 */
export async function verifiedReceiver(p256dh: unknown, auth: unknown): Promise<Receiver> {
	const receiver = receiverOf(p256dh, auth);
	await importPoint(receiver.p256dh);
	return receiver;
}

const importPoint = (point: Uint8Array): Promise<CryptoKey> =>
	crypto.subtle.importKey("raw", point as BufferSource, EC, false, []).catch(() => {
		throw new KeyError("p256dh is not a point on the P-256 curve");
	});

const bytes = (...parts: Uint8Array[]): Uint8Array => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
};

/** HKDF-SHA-256 (RFC 5869) of `ikm` with `salt` and `info`, `bits` long. */
async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, bits: number): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
	const out = await crypto.subtle.deriveBits(
		{ name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource },
		key,
		bits,
	);
	return new Uint8Array(out);
}

export interface EncryptOptions {
	/** The message is padded with zeros to a multiple of this many octets (1: not padded) so that its length says less. */
	padTo?: number;
	/** Fixed salt and sender key: for the RFC's example only. A message is always made with new ones. */
	salt?: Uint8Array;
	sender?: CryptoKeyPair;
}

/**
 * `plaintext` encrypted for `to`, as the body of a push message (header and one record), RFC 8291 section 3.4:
 *
 *   ecdh = ECDH(sender private, receiver public)
 *   ikm  = HKDF(salt: auth, ikm: ecdh, info: "WebPush: info" 0x00 receiver-public sender-public, 32 octets)
 *   cek  = HKDF(salt, ikm, "Content-Encoding: aes128gcm" 0x00, 16 octets)   nonce = HKDF(salt, ikm, "Content-Encoding: nonce" 0x00, 12)
 *   body = salt || 4096 || 65 || sender-public || AES-128-GCM(cek, nonce, plaintext || 0x02 || zeros)
 */
export async function encryptMessage(
	plaintext: Uint8Array,
	to: Receiver,
	options: EncryptOptions = {},
): Promise<Uint8Array> {
	if (plaintext.length > MAX_PLAINTEXT) throw new RangeError(`a push message holds at most ${MAX_PLAINTEXT} octets`);
	const padTo = Math.max(1, Math.floor(options.padTo ?? 1));
	const sender = options.sender ?? ((await crypto.subtle.generateKey(EC, true, ["deriveBits"])) as CryptoKeyPair);
	const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
	if (salt.length !== 16) throw new RangeError("the salt is 16 octets");
	const senderPublic = new Uint8Array((await crypto.subtle.exportKey("raw", sender.publicKey)) as ArrayBuffer);
	const receiver = await importPoint(to.p256dh);
	const ecdh = new Uint8Array(
		await crypto.subtle.deriveBits({ name: "ECDH", public: receiver }, sender.privateKey, 256),
	);
	const ikm = await hkdf(ecdh, to.auth, bytes(ENCODER.encode("WebPush: info\0"), to.p256dh, senderPublic), 256);
	const cek = await hkdf(ikm, salt, ENCODER.encode("Content-Encoding: aes128gcm\0"), 128);
	const nonce = await hkdf(ikm, salt, ENCODER.encode("Content-Encoding: nonce\0"), 96);
	// plaintext, the delimiter that says this is the last record (0x02), zeros: the whole of it a multiple of `padTo`, and in one record.
	const used = plaintext.length + 1;
	const record = new Uint8Array(Math.min(Math.ceil(used / padTo) * padTo, RECORD_SIZE - HEADER - 16));
	record.set(plaintext);
	record[plaintext.length] = 2;
	const key = await crypto.subtle.importKey("raw", cek as BufferSource, "AES-GCM", false, ["encrypt"]);
	const sealed = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv: nonce as BufferSource, tagLength: 128 },
			key,
			record as BufferSource,
		),
	);
	const header = new Uint8Array(HEADER);
	header.set(salt, 0);
	new DataView(header.buffer).setUint32(16, RECORD_SIZE);
	header[20] = senderPublic.length;
	header.set(senderPublic, 21);
	return bytes(header, sealed);
}

// ------------------------------------------------------------------ VAPID

/** The server's signing key (ECDSA, P-256): the JWK it is kept as and the public key a browser subscribes with. */
export interface VapidKey {
	/** The private key as a JWK (`d` included): what the key file holds. */
	jwk: JsonWebKey;
	/** The public key, uncompressed (65 octets), base64url: the `applicationServerKey`, and `k` of the header. */
	publicKey: string;
}

export async function generateVapidKey(): Promise<VapidKey> {
	const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
		"sign",
		"verify",
	])) as CryptoKeyPair;
	const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
	return {
		jwk,
		publicKey: b64u.encode(new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer)),
	};
}

/**
 * The key a JWK holds, or null when it is not a usable P-256 private key (a file edited by hand, one cut short): the public
 * key is worked out from `x` and `y`, never taken from what the file says.
 */
export async function vapidKeyOf(jwk: unknown): Promise<VapidKey | null> {
	if (!isRecord(jwk)) return null;
	const { kty, crv, x, y, d } = jwk;
	if (kty !== "EC" || crv !== "P-256" || typeof x !== "string" || typeof y !== "string" || typeof d !== "string")
		return null;
	const point = b64u.decode(x);
	const other = b64u.decode(y);
	if (point?.length !== 32 || other?.length !== 32) return null;
	try {
		await crypto.subtle.importKey(
			"jwk",
			{ kty, crv, x, y, d } as JsonWebKey,
			{ name: "ECDSA", namedCurve: "P-256" },
			false,
			["sign"],
		);
	} catch {
		return null;
	}
	return { jwk: { kty, crv, x, y, d } as JsonWebKey, publicKey: b64u.encode(bytes(new Uint8Array([4]), point, other)) };
}

/** How long a token lasts (RFC 8292: at most 24 hours). */
const TOKEN_SECONDS = 12 * 60 * 60;

/**
 * The `Authorization` header of a push to `endpoint`: `vapid t=<JWT>, k=<public key>` (RFC 8292 section 3). The token names the
 * push service's origin as audience, who to ask about this sender (`subject`: a `mailto:` or `https:` URL) and when it ends.
 */
export async function vapidAuthorization(
	key: VapidKey,
	endpoint: string,
	subject: string,
	nowMs: number,
): Promise<string> {
	const url = new URL(endpoint);
	const part = (v: unknown) => b64u.encode(ENCODER.encode(JSON.stringify(v)));
	const signing = `${part({ typ: "JWT", alg: "ES256" })}.${part({
		aud: url.origin,
		exp: Math.floor(nowMs / 1000) + TOKEN_SECONDS,
		sub: subject,
	})}`;
	const priv = await crypto.subtle.importKey("jwk", key.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
	// WebCrypto's ECDSA signature is the raw r || s a JWS wants (not DER).
	const signature = new Uint8Array(
		await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, ENCODER.encode(signing) as BufferSource),
	);
	return `vapid t=${signing}.${b64u.encode(signature)}, k=${key.publicKey}`;
}
