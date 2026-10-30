import { createDecipheriv, createECDH, hkdfSync } from "node:crypto";
import { b64u } from "../../server/push/crypto.ts";

/**
 * The browser's side of Web Push, for the tests: a subscription's keys and what reads the message that was sent to it. Written
 * from RFC 8291 section 3 and RFC 8188 with `node:crypto` and none of the server's own code (only the base64url alphabet is
 * shared), so that a message nothing but our own code could read fails here as it would in a browser.
 */

/** What a message holds once read: the plaintext, and what the header of the message said. */
export interface Received {
	recordSize: number;
	idLength: number;
	/** The padding delimiter that ended the record: 2 for the last (and only) record. */
	delimiter: number;
	text: string;
	senderPublic: Uint8Array;
}

/** The plaintext of `body`, a push message encrypted for the receiver with this private key, public key and authentication secret. */
export function receive(
	body: Uint8Array,
	receiverPrivate: Uint8Array,
	receiverPublic: Uint8Array,
	auth: Uint8Array,
): Received {
	const salt = body.slice(0, 16);
	const recordSize = new DataView(body.buffer, body.byteOffset).getUint32(16);
	const idLength = body[20];
	const senderPublic = body.slice(21, 21 + idLength);
	const record = body.slice(21 + idLength);
	const ecdh = createECDH("prime256v1");
	ecdh.setPrivateKey(Buffer.from(receiverPrivate));
	const shared = ecdh.computeSecret(Buffer.from(senderPublic));
	const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), receiverPublic, senderPublic]);
	const ikm = Buffer.from(hkdfSync("sha256", shared, auth, keyInfo, 32));
	const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
	const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
	const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
	decipher.setAuthTag(Buffer.from(record.slice(record.length - 16)));
	const plain = Buffer.concat([decipher.update(record.slice(0, record.length - 16)), decipher.final()]);
	// The record ends with 0x02 after the text, and zeros after that (RFC 8188 section 2).
	let end = plain.length;
	while (end > 0 && plain[end - 1] === 0) end--;
	return {
		recordSize,
		idLength,
		delimiter: plain[end - 1],
		text: plain.subarray(0, end - 1).toString("utf8"),
		senderPublic,
	};
}

/** A browser's subscription keys, as `PushSubscription.toJSON()` has them, and the means to read what is sent to them. */
export interface Receiver {
	/** What the page posts: the uncompressed point and the 16-octet secret, base64url. */
	keys: { p256dh: string; auth: string };
	/** The text of a message sent to these keys (JSON for a notification). */
	read(body: Uint8Array): Received;
	/** A notification sent to these keys, as an object. */
	payload(body: Uint8Array): Record<string, unknown>;
}

export function newReceiver(): Receiver {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	const publicKey = new Uint8Array(ecdh.getPublicKey());
	const privateKey = new Uint8Array(ecdh.getPrivateKey());
	const auth = crypto.getRandomValues(new Uint8Array(16));
	const read = (body: Uint8Array) => receive(body, privateKey, publicKey, auth);
	return {
		keys: { p256dh: b64u.encode(publicKey), auth: b64u.encode(auth) },
		read,
		payload: (body) => JSON.parse(read(body).text) as Record<string, unknown>,
	};
}
