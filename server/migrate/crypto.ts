import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";

/**
 * The logins in an archive are encrypted with a key made from the person's password, and nothing else of the archive is
 * (unless the whole file is encrypted: `sealed.ts`, which shares this file's key derivation): AES-256-GCM (it also tells
 * a wrong key from a damaged file), a key from scrypt over a random salt, a random nonce for each encryption. The file is
 * `MAGIC | header length (u32) | header JSON | ciphertext | tag`; the header (the parameters of the key and the nonce)
 * is authenticated as the additional data, so changing the cost parameters in a stolen file does nothing but make
 * decryption fail.
 */

const MAGIC = Buffer.from("OMPWENC1");
const scryptAsync = promisify(scrypt) as (
	password: string | Buffer,
	salt: Buffer,
	keylen: number,
	options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** scrypt's cost (OWASP's N=2^17 for r=8, p=1): 128 MiB and about half a second, for a password that may be eight characters. */
export const COST = { N: 1 << 17, r: 8, p: 1 } as const;
/** The most a file's parameters may ask for (256 MiB): a file that asks for more is damaged or hostile. */
const MAX_N = 1 << 18;

/** What scrypt needs to make a key again: its cost and the salt (base64). */
export interface KdfParams {
	N: number;
	r: number;
	p: number;
	salt: string;
}

/** A fresh salt for a new key. */
export const newSalt = (): string => randomBytes(16).toString("base64");

/** Whether `h` asks for scrypt parameters this version makes and is willing to spend: a hostile file's cost is never obeyed. */
export function kdfAcceptable(h: { N?: unknown; r?: unknown; p?: unknown }): boolean {
	return (
		typeof h.N === "number" &&
		Number.isInteger(h.N) &&
		h.N >= 1 << 10 &&
		h.N <= MAX_N &&
		(h.N & (h.N - 1)) === 0 &&
		h.r === COST.r &&
		h.p === COST.p
	);
}

/** `length` bytes from `password` (NFKC-normalised, so the same text typed on another keyboard layout of the same characters opens it). */
export async function deriveKey(password: string, params: KdfParams, length = 32): Promise<Buffer> {
	return scryptAsync(password.normalize("NFKC"), Buffer.from(params.salt, "base64"), length, {
		N: params.N,
		r: params.r,
		p: params.p,
		maxmem: 256 * params.N * params.r + (1 << 20),
	});
}

export class WrongPasswordError extends Error {
	constructor() {
		super("The password is wrong, or the encrypted part is damaged");
	}
}

interface Header {
	v: 1;
	alg: "aes-256-gcm";
	kdf: "scrypt";
	N: number;
	r: number;
	p: number;
	salt: string;
	nonce: string;
}

/** `plain` encrypted under `password`. */
export async function encrypt(plain: Uint8Array, password: string): Promise<Buffer> {
	const header: Header = {
		v: 1,
		alg: "aes-256-gcm",
		kdf: "scrypt",
		...COST,
		salt: newSalt(),
		nonce: randomBytes(12).toString("base64"),
	};
	const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
	const cipher = createCipheriv("aes-256-gcm", await deriveKey(password, header), Buffer.from(header.nonce, "base64"));
	cipher.setAAD(headerBytes);
	const body = Buffer.concat([cipher.update(plain), cipher.final()]);
	const length = Buffer.alloc(4);
	length.writeUInt32BE(headerBytes.length);
	return Buffer.concat([MAGIC, length, headerBytes, body, cipher.getAuthTag()]);
}

/** What `encrypt` made, decrypted; `WrongPasswordError` when the password is not the one it was made with (or the data was changed). */
export async function decrypt(sealed: Uint8Array, password: string): Promise<Buffer> {
	const buf = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
	if (buf.length < MAGIC.length + 4 + 16 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
		throw new Error("This is not an encrypted part of an omp-webui archive");
	}
	const headerLength = buf.readUInt32BE(MAGIC.length);
	const headerEnd = MAGIC.length + 4 + headerLength;
	if (headerLength > 4096 || headerEnd + 16 > buf.length) throw new Error("The encrypted part is cut off");
	const headerBytes = buf.subarray(MAGIC.length + 4, headerEnd);
	const header = JSON.parse(headerBytes.toString("utf8")) as Header;
	if (header.v !== 1 || header.alg !== "aes-256-gcm" || header.kdf !== "scrypt" || !kdfAcceptable(header)) {
		throw new Error("The encrypted part uses parameters this version does not know");
	}
	const decipher = createDecipheriv(
		"aes-256-gcm",
		await deriveKey(password, header),
		Buffer.from(header.nonce, "base64"),
	);
	decipher.setAAD(headerBytes);
	decipher.setAuthTag(buf.subarray(buf.length - 16));
	try {
		return Buffer.concat([decipher.update(buf.subarray(headerEnd, buf.length - 16)), decipher.final()]);
	} catch {
		throw new WrongPasswordError();
	}
}
