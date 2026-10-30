import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WrongPasswordError } from "../../server/migrate/crypto.ts";
import {
	isSealed,
	SEALED_CHUNK,
	SEALED_MAGIC,
	SEALED_OVERHEAD,
	SealedError,
	SealedFile,
	SealedWriter,
	unlockSealed,
} from "../../server/migrate/sealed.ts";
import { ZipReader, ZipWriter } from "../../server/migrate/zip.ts";

/**
 * The container that "encrypt the whole file" puts the archive in (`server/migrate/sealed.ts`): a header and the zip cut
 * in chunks, each sealed with AES-256-GCM. These cover the container itself: round trips at every chunk boundary,
 * reading by position, that nothing readable is in the file, and every way a file can be changed (a byte of any chunk or
 * of the header, a cut, an addition, chunks moved or repeated), which must be refused and never read as data.
 * They use the cheapest scrypt the reader accepts; what the exporter uses is checked in `migrate-whole.test.ts`.
 */

const FAST = { N: 1 << 10 };
const PASSWORD = "correct horse battery";
const FULL = SEALED_CHUNK + SEALED_OVERHEAD;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

let dir: string;
let seq = 0;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "ompw-sealed-"));
});
afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});
const fresh = () => join(dir, `s${seq++}.ompw`);

/** `data` written the way a zip writer does: from the start, in pieces of whatever size comes. */
async function seal(path: string, data: Uint8Array, piece = 7_919): Promise<void> {
	const w = await SealedWriter.create(path, PASSWORD, FAST);
	for (let at = 0; at < data.length; at += piece) {
		const part = data.subarray(at, at + piece);
		await w.write(part, 0, part.length, at);
	}
	await w.sync();
	await w.close();
}

async function open(path: string, password = PASSWORD): Promise<SealedFile> {
	return SealedFile.open(path, await unlockSealed(path, password));
}

async function readAll(f: SealedFile, piece = 50_000): Promise<Buffer> {
	const out = Buffer.alloc(f.size);
	for (let at = 0; at < f.size; ) {
		const { bytesRead } = await f.read(out, at, Math.min(piece, f.size - at), at);
		if (bytesRead === 0) throw new Error(`the file ended at ${at} of ${f.size}`);
		at += bytesRead;
	}
	return out;
}

const headerEnd = (file: Buffer): number => SEALED_MAGIC.length + 4 + file.readUInt32BE(SEALED_MAGIC.length);

/** What opening and reading everything does to a file that was changed: the error it ends in, or null when it all went through. */
async function outcome(path: string): Promise<string | null> {
	try {
		const f = await open(path);
		try {
			await f.authenticateAll();
			await readAll(f);
		} finally {
			await f.close();
		}
		return null;
	} catch (e) {
		if (e instanceof SealedError) return e.code;
		if (e instanceof WrongPasswordError) return "wrong-password";
		throw e;
	}
}

function mutated(source: string, change: (bytes: Buffer) => Buffer | undefined): string {
	const bytes = Buffer.from(readFileSync(source));
	const out = change(bytes) ?? bytes;
	const path = fresh();
	writeFileSync(path, out);
	return path;
}

const SIZES = [0, 1, 17, SEALED_CHUNK - 1, SEALED_CHUNK, SEALED_CHUNK + 1, 3 * SEALED_CHUNK, 3 * SEALED_CHUNK + 17];

describe("a sealed file round-trips", () => {
	for (const size of SIZES) {
		test(`${size} bytes: the same bytes come back, and the file is the chunks plus a header`, async () => {
			const data = randomBytes(size);
			const path = fresh();
			await seal(path, data);
			const f = await open(path);
			expect(f.size).toBe(size);
			expect(sha(await readAll(f))).toBe(sha(data));
			await f.authenticateAll();
			await f.close();
			const file = readFileSync(path);
			const chunks = Math.max(1, Math.ceil(size / SEALED_CHUNK));
			expect(file.length).toBe(headerEnd(file) + size + chunks * SEALED_OVERHEAD);
		});
	}

	test("random ranges, across chunk borders and to the end, are the bytes at those positions", async () => {
		const data = randomBytes(5 * SEALED_CHUNK + 123);
		const path = fresh();
		await seal(path, data);
		const f = await open(path);
		for (let i = 0; i < 300; i++) {
			const position = Math.floor(Math.random() * data.length);
			const length = 1 + Math.floor(Math.random() * 3 * SEALED_CHUNK);
			const buf = Buffer.alloc(length);
			const { bytesRead } = await f.read(buf, 0, length, position);
			const want = data.subarray(position, position + length);
			expect(bytesRead).toBe(want.length);
			expect(buf.subarray(0, bytesRead).equals(want)).toBe(true);
		}
		// At and past the end there is nothing.
		expect((await f.read(Buffer.alloc(10), 0, 10, data.length)).bytesRead).toBe(0);
		await f.close();
	});

	test("nothing readable is in the file, and it does not start like a zip", async () => {
		const marker = Buffer.from("PLAIN-MARKER-conversation-text-".repeat(2000));
		const path = fresh();
		await seal(path, marker);
		const file = readFileSync(path);
		expect(file.includes("PLAIN-MARKER")).toBe(false);
		expect(file.includes(PASSWORD)).toBe(false);
		expect(file.subarray(0, 8).toString()).toBe("OMPWENC2");
		expect(await isSealed(path)).toBe(true);
		const zip = fresh();
		const w = await ZipWriter.create(zip);
		await w.add("a", Buffer.from("x"));
		await w.finish();
		expect(await isSealed(zip)).toBe(false);
	});

	test("two files of the same bytes and password are different from end to end (a fresh salt and nonces)", async () => {
		const data = randomBytes(1000);
		const a = fresh();
		const b = fresh();
		await seal(a, data);
		await seal(b, data);
		const [x, y] = [readFileSync(a), readFileSync(b)];
		expect(x.subarray(headerEnd(x)).equals(y.subarray(headerEnd(y)))).toBe(false);
	});
});

describe("the password", () => {
	test("a wrong one is told as a wrong password, before any chunk is read", async () => {
		const path = fresh();
		await seal(path, randomBytes(100_000));
		await expect(unlockSealed(path, "not the password")).rejects.toBeInstanceOf(WrongPasswordError);
		await expect(unlockSealed(path, PASSWORD.toUpperCase())).rejects.toBeInstanceOf(WrongPasswordError);
	});

	test("the same text in another Unicode form opens it (NFKC), as it does for the logins", async () => {
		const path = fresh();
		const w = await SealedWriter.create(path, "caf\u00e9-passw0rd", FAST);
		await w.write(Buffer.from("hello"), 0, 5, 0);
		await w.sync();
		await w.close();
		await expect(unlockSealed(path, "cafe\u0301-passw0rd")).resolves.toBeTruthy();
	});

	test("a file that is not sealed, or is cut inside its header, is not mistaken for one", async () => {
		const path = fresh();
		writeFileSync(path, "PK\x03\x04 not sealed");
		expect(await isSealed(path)).toBe(false);
		await expect(unlockSealed(path, PASSWORD)).rejects.toBeInstanceOf(SealedError);
		const sealed = fresh();
		await seal(sealed, randomBytes(100));
		const cut = mutated(sealed, (b) => b.subarray(0, 30));
		await expect(unlockSealed(cut, PASSWORD)).rejects.toBeInstanceOf(SealedError);
	});
});

describe("a changed file is refused", () => {
	let source: string;
	let data: Buffer;
	beforeAll(async () => {
		data = randomBytes(3 * SEALED_CHUNK + 17);
		source = fresh();
		await seal(source, data);
	});

	test("the untouched file passes the same check (so the failures below are the change)", async () => {
		expect(await outcome(source)).toBeNull();
	});

	test("one byte of any chunk, ciphertext or tag, first or last: tampered", async () => {
		const file = readFileSync(source);
		const end = headerEnd(file);
		const chunks = Math.ceil((file.length - end) / FULL);
		expect(chunks).toBe(4);
		for (let i = 0; i < chunks; i++) {
			const start = end + i * FULL;
			const stop = Math.min(start + FULL, file.length);
			for (const at of [start, start + 3, Math.floor((start + stop) / 2), stop - 17, stop - 1]) {
				const path = mutated(source, (b) => {
					b[at] ^= 0x01;
					return b;
				});
				expect(await outcome(path), `chunk ${i}, byte ${at}`).toBe("tampered");
			}
		}
	});

	test("any byte of the header: refused, as a wrong password, as tampered, or as a header this version does not know", async () => {
		const file = readFileSync(source);
		const end = headerEnd(file);
		for (let at = 0; at < end; at++) {
			const path = mutated(source, (b) => {
				b[at] ^= 0x01;
				return b;
			});
			const result = await outcome(path);
			expect(result, `header byte ${at}`).not.toBeNull();
		}
	});

	test("the file cut at a chunk border, in the middle of a chunk, or to the header alone: refused", async () => {
		const file = readFileSync(source);
		const end = headerEnd(file);
		for (const length of [end + 3 * FULL, end + 2 * FULL, end + FULL + 5, end + 3 * FULL + 5, end + 15, end, end - 1]) {
			expect(await outcome(mutated(source, (b) => b.subarray(0, length))), `cut to ${length}`).not.toBeNull();
		}
		// Taking the last chunk off must fail on the flag of the new last one, not only on its length.
		expect(await outcome(mutated(source, (b) => b.subarray(0, end + 3 * FULL)))).toBe("tampered");
	});

	test("bytes added at the end, or a whole extra chunk copied from the file: refused", async () => {
		const file = readFileSync(source);
		const end = headerEnd(file);
		expect(await outcome(mutated(source, (b) => Buffer.concat([b, Buffer.from([0])])))).not.toBeNull();
		expect(await outcome(mutated(source, (b) => Buffer.concat([b, randomBytes(100)])))).not.toBeNull();
		expect(
			await outcome(mutated(source, (b) => Buffer.concat([b, b.subarray(end, end + FULL)]))),
			"chunk 0 repeated at the end",
		).toBe("tampered");
	});

	test("chunks swapped, or one repeated over another: refused (the number of a chunk is part of its seal)", async () => {
		const file = readFileSync(source);
		const end = headerEnd(file);
		const at = (i: number) => end + i * FULL;
		const swapped = mutated(source, (b) => {
			const a = Buffer.from(b.subarray(at(0), at(1)));
			a.copy(b, at(1));
			return b;
		});
		expect(await outcome(swapped)).toBe("tampered");
		const exchanged = mutated(source, (b) => {
			const first = Buffer.from(b.subarray(at(0), at(1)));
			const second = Buffer.from(b.subarray(at(1), at(2)));
			second.copy(b, at(0));
			first.copy(b, at(1));
			return b;
		});
		expect(await outcome(exchanged)).toBe("tampered");
	});

	test("a chunk of another file made with the same password is refused (the header is part of its seal)", async () => {
		const other = fresh();
		await seal(other, data);
		const o = readFileSync(other);
		const end = headerEnd(o);
		const path = mutated(source, (b) => {
			o.copy(b, headerEnd(b) + FULL, end + FULL, end + 2 * FULL);
			return b;
		});
		expect(await outcome(path)).toBe("tampered");
	});

	test("the reader never hands out a byte of a chunk that failed", async () => {
		const file = readFileSync(source);
		const end = headerEnd(file);
		const path = mutated(source, (b) => {
			b[end + FULL + 50] ^= 0x80;
			return b;
		});
		const f = await open(path);
		const buf = Buffer.alloc(SEALED_CHUNK);
		await expect(f.read(buf, 0, SEALED_CHUNK, SEALED_CHUNK)).rejects.toBeInstanceOf(SealedError);
		// The chunks before and after it are still good.
		expect((await f.read(buf, 0, 100, 0)).bytesRead).toBe(100);
		await f.close();
	});
});

describe("writing", () => {
	test("a rollback across a chunk boundary seals the chunk again under a new nonce: no (key, nonce) is ever used twice", async () => {
		const path = fresh();
		const w = await SealedWriter.create(path, PASSWORD, FAST);
		const a = randomBytes(3 * SEALED_CHUNK + 4_000);
		for (let at = 0; at < a.length; at += 20_000) {
			const part = a.subarray(at, at + 20_000);
			await w.write(part, 0, part.length, at);
		}
		// What is on disk before the rollback: chunks 0..2 (3 is still held), and the nonce each was sealed under.
		const nonces = (file: Buffer, count: number) =>
			Array.from({ length: count }, (_, i) =>
				file.subarray(headerEnd(file) + i * FULL, headerEnd(file) + i * FULL + 12).toString("hex"),
			);
		const before = nonces(readFileSync(path), 3);
		// Back into chunk 1 (a byte of it is kept), then other bytes where the old ones were, all the way to the end.
		await w.truncate(SEALED_CHUNK + 777);
		const b = randomBytes(2 * SEALED_CHUNK + 5);
		await w.write(b, 0, b.length, SEALED_CHUNK + 777);
		await w.sync();
		await w.close();
		const file = readFileSync(path);
		const chunks = Math.ceil((file.length - headerEnd(file)) / FULL);
		const after = nonces(file, chunks);
		// Chunks 1 and 2 were sealed twice, with different bytes, and so under different nonces; chunk 0 was not touched.
		expect(after[0]).toBe(before[0]);
		expect(after[1]).not.toBe(before[1]);
		expect(after[2]).not.toBe(before[2]);
		// Every nonce that was ever on disk (the discarded ones too) differs from every other, but chunk 0's, which was kept.
		const everything = [...before, ...after];
		expect(new Set(everything).size).toBe(before.length + after.length - 1);
		// And the file is the bytes that stayed and the new ones.
		const f = await open(path);
		expect(sha(await readAll(f))).toBe(sha(Buffer.concat([a.subarray(0, SEALED_CHUNK + 777), b])));
		await f.close();
	});

	test("every chunk of a file has a nonce of its own, and two sealings of the same bytes differ", async () => {
		const path = fresh();
		await seal(path, Buffer.alloc(6 * SEALED_CHUNK));
		const file = readFileSync(path);
		const end = headerEnd(file);
		const seen = new Set<string>();
		for (let i = 0; i * FULL < file.length - end; i++) {
			seen.add(file.subarray(end + i * FULL, end + i * FULL + 12).toString("hex"));
		}
		expect(seen.size).toBe(6);
		// Six chunks of the same bytes, and no two alike on disk.
		const sealed = (i: number) => file.subarray(end + i * FULL + 12, end + (i + 1) * FULL).toString("hex");
		expect(sealed(0)).not.toBe(sealed(1));
	});

	test("a write that does not continue where the last one ended is refused: the file is written from start to end", async () => {
		const w = await SealedWriter.create(fresh(), PASSWORD, FAST);
		await w.write(Buffer.from("abc"), 0, 3, 0);
		await expect(w.write(Buffer.from("x"), 0, 1, 10)).rejects.toThrow();
		await w.close();
	});

	test("taking back what an entry wrote, to any position, then writing on, leaves exactly the bytes that stayed and the new ones", async () => {
		const a = randomBytes(3 * SEALED_CHUNK + 4_000);
		// Inside the held chunk, at a chunk border, inside a chunk already on disk, at 0, and at the very end.
		for (const keep of [
			a.length - 10,
			3 * SEALED_CHUNK,
			3 * SEALED_CHUNK + 1,
			2 * SEALED_CHUNK + 777,
			SEALED_CHUNK,
			1,
			0,
			a.length,
		]) {
			const path = fresh();
			const w = await SealedWriter.create(path, PASSWORD, FAST);
			for (let at = 0; at < a.length; at += 20_000) {
				const part = a.subarray(at, at + 20_000);
				await w.write(part, 0, part.length, at);
			}
			await w.truncate(keep);
			const b = randomBytes(2 * SEALED_CHUNK + 5);
			await w.write(b, 0, b.length, keep);
			await w.sync();
			await w.close();
			const want = Buffer.concat([a.subarray(0, keep), b]);
			const f = await open(path);
			expect(f.size, `keep ${keep}`).toBe(want.length);
			expect(sha(await readAll(f)), `keep ${keep}`).toBe(sha(want));
			await f.authenticateAll();
			await f.close();
		}
	});

	test("an archive that is nothing but the zip's end record seals, opens and reads", async () => {
		const path = fresh();
		const w = ZipWriter.createOn(await SealedWriter.create(path, PASSWORD, FAST), path);
		await w.finish();
		const f = await open(path);
		const zip = await ZipReader.from(f, f.size);
		expect(zip.entries).toEqual([]);
		await zip.close();
	});

	test("a file that already exists is never written over", async () => {
		const path = fresh();
		writeFileSync(path, "mine");
		await expect(SealedWriter.create(path, PASSWORD, FAST)).rejects.toThrow();
		expect(readFileSync(path, "utf8")).toBe("mine");
	});
});

describe("a zip inside it", () => {
	async function* failingAfter(bytes: number): AsyncGenerator<Uint8Array> {
		for (let sent = 0; sent < bytes; sent += 30_000) yield randomBytes(30_000);
		throw new Error("the file vanished");
	}

	test("entries read back as they were written, and an entry whose source failed is taken out without harming the rest", async () => {
		const path = fresh();
		const a = randomBytes(300_000);
		const c = randomBytes(150_000);
		const writer = ZipWriter.createOn(await SealedWriter.create(path, PASSWORD, FAST), path);
		await writer.add("a.bin", a, { compress: false });
		await expect(writer.add("vanished.bin", failingAfter(4 * SEALED_CHUNK))).rejects.toThrow("the file vanished");
		await writer.add("c.txt", c);
		await writer.add("empty", Buffer.alloc(0));
		await writer.finish();
		const f = await open(path);
		const zip = await ZipReader.from(f, f.size);
		expect(zip.entries.map((e) => e.name)).toEqual(["a.bin", "c.txt", "empty"]);
		expect(sha(await zip.bytes("a.bin"))).toBe(sha(a));
		expect(sha(await zip.bytes("c.txt"))).toBe(sha(c));
		expect((await zip.bytes("empty")).length).toBe(0);
		await f.authenticateAll();
		await zip.close();
	});

	test("changing a byte inside an entry's data fails that entry's read, and nothing else's", async () => {
		const path = fresh();
		const writer = ZipWriter.createOn(await SealedWriter.create(path, PASSWORD, FAST), path);
		const big = randomBytes(5 * SEALED_CHUNK);
		await writer.add("one.bin", Buffer.from("small first entry"), { compress: false });
		await writer.add("big.bin", big, { compress: false });
		await writer.finish();
		const opened = await open(path);
		const zip = await ZipReader.from(opened, opened.size);
		const at = (zip.entry("big.bin")?.offset ?? 0) + 30 + 2 * SEALED_CHUNK;
		await zip.close();
		const file = readFileSync(path);
		const flipped = mutated(path, (b) => {
			b[headerEnd(file) + Math.floor(at / SEALED_CHUNK) * FULL + 9] ^= 0x01;
			return b;
		});
		const f = await open(flipped);
		const reader = await ZipReader.from(f, f.size);
		expect(Buffer.from(await reader.bytes("one.bin")).toString()).toBe("small first entry");
		await expect(reader.bytes("big.bin")).rejects.toMatchObject({ code: "tampered" });
		await reader.close();
	});

	test("a large entry streams through in flat memory", async () => {
		const path = fresh();
		const size = 192 * 1024 * 1024;
		const piece = randomBytes(1024 * 1024);
		const hash = createHash("sha256");
		async function* source(): AsyncGenerator<Uint8Array> {
			for (let sent = 0; sent < size; sent += piece.length) {
				// A copy of different bytes each time: the writer holds a piece after it was yielded.
				const next = Buffer.from(piece);
				next.writeUInt32LE(sent / piece.length, 0);
				hash.update(next);
				yield next;
			}
		}
		Bun.gc(true);
		const before = process.memoryUsage().rss;
		const writer = ZipWriter.createOn(await SealedWriter.create(path, PASSWORD, FAST), path);
		await writer.add("large.bin", source(), { compress: false });
		await writer.finish();
		const f = await open(path);
		const zip = await ZipReader.from(f, f.size);
		const back = createHash("sha256");
		let total = 0;
		for await (const chunk of zip.stream("large.bin")) {
			back.update(chunk);
			total += chunk.length;
		}
		await zip.close();
		expect(total).toBe(size);
		expect(back.digest("hex")).toBe(hash.digest("hex"));
		expect(statSync(path).size).toBeGreaterThan(size);
		// A copy of the entry anywhere (the writer's, the reader's, the chunk cache's) would be hundreds of megabytes.
		expect(process.memoryUsage().rss - before).toBeLessThan(120 * 1024 * 1024);
	}, 60_000);
});
