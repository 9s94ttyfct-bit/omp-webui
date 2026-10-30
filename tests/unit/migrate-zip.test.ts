import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { ZipError, type ZipErrorCode, ZipReader, ZipWriter } from "../../server/migrate/zip.ts";

/**
 * The migration archive is a ZIP written as a stream and read by random access. These cover the container itself:
 * round trips, ZIP64 (forced by a tiny threshold, and by the entry count), every way a file can be damaged, and
 * interop with the Info-ZIP tools that ship with macOS, which is what a user would reach for if an import went wrong.
 */

const UNZIP = "/usr/bin/unzip";
const ZIP = "/usr/bin/zip";
const unzipTest = test.skipIf(!existsSync(UNZIP));
const zipTest = test.skipIf(!existsSync(UNZIP) || !existsSync(ZIP));

let dir: string;
let seq = 0;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "ompw-zip-"));
});
afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

function fresh(ext = ".ompw"): string {
	return join(dir, `a${seq++}${ext}`);
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function drain(it: AsyncIterable<Uint8Array>): Promise<Buffer> {
	const parts: Uint8Array[] = [];
	for await (const c of it) parts.push(c);
	return Buffer.concat(parts);
}

async function codeOf(p: Promise<unknown>): Promise<ZipErrorCode | `other:${string}`> {
	try {
		await p;
	} catch (err) {
		return err instanceof ZipError ? err.code : `other:${String(err)}`;
	}
	throw new Error("expected a rejection");
}

async function* chunked(data: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
	for (let i = 0; i < data.length; i += size) yield data.subarray(i, i + size);
}

async function build(
	entries: [string, Uint8Array, Record<string, unknown>?][],
	zip64At?: number,
	path = fresh(),
): Promise<string> {
	const w = await ZipWriter.create(path, { zip64At });
	for (const [name, data, opts] of entries) await w.add(name, data, opts);
	await w.finish();
	return path;
}

function unzip(args: string[]): { status: number | null; out: Buffer; err: string } {
	const r = Bun.spawnSync([UNZIP, ...args]);
	return { status: r.exitCode, out: Buffer.from(r.stdout), err: Buffer.from(r.stderr).toString() };
}

/** Positions of a 32-bit signature inside a file, for locating records to damage. */
function findAll(buf: Buffer, sig: number): number[] {
	const out: number[] = [];
	const needle = Buffer.alloc(4);
	needle.writeUInt32LE(sig);
	for (let i = buf.indexOf(needle); i >= 0; i = buf.indexOf(needle, i + 1)) out.push(i);
	return out;
}

describe("round trip", () => {
	test("small, empty, binary and unicode-named entries keep bytes, checksums, mode and time", async () => {
		const bin = randomBytes(5000);
		const text = Buffer.from("hello archive\n".repeat(50));
		const mtime = Date.UTC(2024, 5, 15, 12, 30, 44);
		const path = fresh();
		const w = await ZipWriter.create(path);
		const written = [
			await w.add("empty.txt", new Uint8Array(0), { mtimeMs: mtime }),
			await w.add("dir/text.txt", text, { mtimeMs: mtime, mode: 0o600 }),
			await w.add("bin.dat", bin, { mtimeMs: mtime, mode: 0o755 }),
			await w.add("会话/日志 ✓.jsonl", Buffer.from('{"a":"é"}\n'), { mtimeMs: mtime }),
		];
		const done = await w.finish();
		expect(done.entries).toBe(4);
		expect(done.bytes).toBe(statSync(path).size);

		expect(written[0]).toMatchObject({ name: "empty.txt", size: 0, sha256: sha(new Uint8Array(0)), crc32: 0 });
		expect(written[1]?.sha256).toBe(sha(text));
		expect(written[1]?.crc32).toBe(crc32(text));
		expect(written[2]?.size).toBe(5000);

		const r = await ZipReader.open(path);
		try {
			expect(r.entries.map((e) => e.name)).toEqual(["empty.txt", "dir/text.txt", "bin.dat", "会话/日志 ✓.jsonl"]);
			for (const e of r.entries) {
				expect(e.mtimeMs).toBe(mtime);
				expect(e.method).toBe(8);
			}
			expect(r.entry("dir/text.txt")?.mode).toBe(0o600);
			expect(r.entry("bin.dat")?.mode).toBe(0o755);
			expect(r.entry("empty.txt")?.mode).toBe(0o644);
			expect(r.entry("nope")).toBeUndefined();
			expect(r.entry("bin.dat")?.crc32).toBe(written[2]?.crc32 ?? -1);
			expect(r.entry("dir/text.txt")?.compressedSize).toBe(written[1]?.compressedSize ?? -1);
			expect(r.entry("dir/text.txt")?.compressedSize).toBeLessThan(text.length);

			expect(Buffer.from(await r.bytes("bin.dat")).equals(bin)).toBe(true);
			expect(Buffer.from(await r.bytes("dir/text.txt")).equals(text)).toBe(true);
			expect((await r.bytes("empty.txt")).length).toBe(0);
			expect(Buffer.from(await r.bytes("会话/日志 ✓.jsonl")).toString()).toBe('{"a":"é"}\n');
			expect((await drain(r.stream("bin.dat"))).length).toBe(5000);
			expect(() => r.stream("missing")).toThrow();
		} finally {
			await r.close();
		}
	});

	test("compress:false stores the bytes as they are", async () => {
		const data = Buffer.from("x".repeat(10_000));
		const path = await build([["s.txt", data, { compress: false }]]);
		const r = await ZipReader.open(path);
		try {
			const e = r.entry("s.txt");
			expect(e?.method).toBe(0);
			expect(e?.compressedSize).toBe(10_000);
			expect(Buffer.from(await r.bytes("s.txt")).equals(data)).toBe(true);
		} finally {
			await r.close();
		}
	});

	test("sources may be buffers, async iterables or web streams; chunks and progress are reported", async () => {
		const data = randomBytes(2_500_000);
		const path = fresh();
		const w = await ZipWriter.create(path);
		const seen: number[] = [];
		await w.add("gen", chunked(data, 100_000), { onBytes: (n) => seen.push(n) });
		const rs = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(data.subarray(0, 1000));
				c.enqueue(data.subarray(1000));
				c.close();
			},
		});
		await w.add("web", rs, { compress: false });
		await w.finish();
		expect(seen.at(-1)).toBe(2_500_000);
		expect(seen.length).toBe(25);
		expect(seen).toEqual([...seen].sort((a, b) => a - b));
		const r = await ZipReader.open(path);
		try {
			expect(sha(await r.bytes("gen"))).toBe(sha(data));
			expect(sha(await r.bytes("web"))).toBe(sha(data));
			// A 1 MiB-plus chunk handed to the writer is split, and reads never come back bigger than 1 MiB.
			for await (const c of r.stream("web")) expect(c.length).toBeLessThanOrEqual(1024 * 1024);
		} finally {
			await r.close();
		}
	});

	test("DOS time rounds to two seconds, clamps to its range, and reads back as UTC", async () => {
		const path = await build([
			["odd", Buffer.from("a"), { mtimeMs: Date.UTC(2020, 0, 2, 3, 4, 5) }],
			["early", Buffer.from("a"), { mtimeMs: 0 }],
			["late", Buffer.from("a"), { mtimeMs: Date.UTC(2300, 0, 1) }],
		]);
		const r = await ZipReader.open(path);
		try {
			expect(r.entry("odd")?.mtimeMs).toBe(Date.UTC(2020, 0, 2, 3, 4, 6));
			expect(r.entry("early")?.mtimeMs).toBe(Date.UTC(1980, 0, 1));
			expect(r.entry("late")?.mtimeMs).toBe(Date.UTC(2107, 11, 31, 23, 59, 58));
		} finally {
			await r.close();
		}
	});

	test("an archive with a trailing comment still opens", async () => {
		const path = await build([["a.txt", Buffer.from("alpha")]]);
		const raw = readFileSync(path);
		const comment = Buffer.from("made elsewhere, with a comment containing PK\x05\x06 bytes");
		raw.writeUInt16LE(comment.length, raw.length - 2);
		writeFileSync(path, Buffer.concat([raw, comment]));
		const r = await ZipReader.open(path);
		try {
			expect(Buffer.from(await r.bytes("a.txt")).toString()).toBe("alpha");
		} finally {
			await r.close();
		}
	});
});

describe("streaming", () => {
	// Proof that nothing is buffered whole: while the source is still producing, the bytes already sit in the file.
	test("a 40 MiB entry streams from a generator with bounded memory and reads back identically", async () => {
		const random = randomBytes(1024 * 1024);
		const repeat = Buffer.alloc(1024 * 1024, "omp-webui ");
		const total = 40;
		const path = fresh();
		const w = await ZipWriter.create(path);
		const hash = createHash("sha256");
		let produced = 0;
		const sizes: number[] = [];
		async function* source(): AsyncGenerator<Uint8Array> {
			for (let i = 0; i < total; i++) {
				const chunk = i % 2 === 0 ? random : repeat;
				hash.update(chunk);
				produced += chunk.length;
				yield chunk;
				peak = Math.max(peak, process.memoryUsage().rss);
				if (i === total / 2) sizes.push(statSync(path).size);
			}
		}
		Bun.gc(true);
		const before = process.memoryUsage().rss;
		let peak = before;
		const written = await w.add("big.bin", source());
		await w.finish();
		expect(produced).toBe(total * 1024 * 1024);
		expect(written.size).toBe(total * 1024 * 1024);
		expect(written.sha256).toBe(hash.digest("hex"));
		// Half of the random megabytes are already on disk when the source is half way through.
		expect(sizes[0]).toBeGreaterThan(8 * 1024 * 1024);
		expect(peak - before).toBeLessThan(150 * 1024 * 1024);

		const r = await ZipReader.open(path);
		try {
			const back = createHash("sha256");
			let n = 0;
			for await (const c of r.stream("big.bin")) {
				expect(c.length).toBeLessThanOrEqual(1024 * 1024);
				back.update(c);
				n += c.length;
			}
			expect(n).toBe(total * 1024 * 1024);
			expect(back.digest("hex")).toBe(written.sha256);
		} finally {
			await r.close();
		}
	}, 60_000);

	test("several streams on one reader can be in flight at once", async () => {
		const blobs = [randomBytes(3_000_000), Buffer.alloc(3_000_000, "ab"), randomBytes(1_200_000)];
		const path = await build(
			blobs.map((b, i) => [`e${i}`, b, { compress: i !== 2 }] as [string, Uint8Array, Record<string, unknown>]),
		);
		const r = await ZipReader.open(path);
		try {
			const results = await Promise.all(blobs.flatMap((_, i) => [drain(r.stream(`e${i}`)), drain(r.stream(`e${i}`))]));
			for (const [k, got] of results.entries()) expect(sha(got)).toBe(sha(blobs[k >> 1] as Buffer));
		} finally {
			await r.close();
		}
	});

	test("bytes refuses an entry bigger than maxBytes", async () => {
		const path = await build([["a", Buffer.alloc(1000, 1)]]);
		const r = await ZipReader.open(path);
		try {
			expect(await codeOf(r.bytes("a", 10))).toBe("corrupt");
			expect((await r.bytes("a", 1000)).length).toBe(1000);
		} finally {
			await r.close();
		}
	});

	test("an aborted read stops with 'aborted'", async () => {
		const path = await build([["a", randomBytes(3_000_000), { compress: false }]]);
		const r = await ZipReader.open(path);
		try {
			const ac = new AbortController();
			const p = (async () => {
				for await (const _ of r.stream("a", { signal: ac.signal })) ac.abort();
			})();
			expect(await codeOf(p)).toBe("aborted");
		} finally {
			await r.close();
		}
	});
});

describe("zip64", () => {
	test("more than 65534 entries are written and read by name", async () => {
		const path = fresh();
		const w = await ZipWriter.create(path);
		const n = 70_000;
		for (let i = 0; i < n; i++)
			await w.add(`d${i % 100}/f${i}.txt`, Buffer.from(`entry ${i}`), { compress: i % 2 === 0 });
		expect(await w.finish()).toMatchObject({ entries: n });
		const raw = readFileSync(path);
		expect(findAll(raw, 0x07064b50).length).toBe(1);
		const r = await ZipReader.open(path);
		try {
			expect(r.entries.length).toBe(n);
			for (const i of [0, 1, 65_534, 65_535, 65_536, 69_999]) {
				expect(Buffer.from(await r.bytes(`d${i % 100}/f${i}.txt`)).toString()).toBe(`entry ${i}`);
			}
		} finally {
			await r.close();
		}
		if (existsSync(UNZIP)) {
			expect(unzip(["-t", path]).status).toBe(0);
			expect(unzip(["-p", path, "d7/f69907.txt"]).out.toString()).toBe("entry 69907");
		}
	}, 120_000);

	test("a tiny threshold forces zip64 sizes, offsets and end records; the reader reads all of it", async () => {
		const big = randomBytes(5000);
		const mid = Buffer.from("m".repeat(1500));
		const path = fresh();
		const w = await ZipWriter.create(path, { zip64At: 1024 });
		await w.add("small", Buffer.from("tiny"));
		await w.add("big", big);
		await w.add("streamed", chunked(mid, 400), { compress: false });
		await w.add("after", Buffer.from("past the offset threshold"));
		await w.finish();
		const raw = readFileSync(path);
		expect(findAll(raw, 0x06064b50).length).toBe(1);
		expect(findAll(raw, 0x07064b50).length).toBe(1);
		const r = await ZipReader.open(path);
		try {
			expect(r.entry("big")?.size).toBe(5000);
			expect(r.entry("streamed")?.size).toBe(1500);
			expect(r.entry("after")?.offset).toBeGreaterThan(1024);
			expect(Buffer.from(await r.bytes("big")).equals(big)).toBe(true);
			expect(Buffer.from(await r.bytes("streamed")).equals(mid)).toBe(true);
			expect(Buffer.from(await r.bytes("small")).toString()).toBe("tiny");
			expect(Buffer.from(await r.bytes("after")).toString()).toBe("past the offset threshold");
		} finally {
			await r.close();
		}
	});

	unzipTest("unzip -t and unzip -p accept normal and zip64 archives", async () => {
		const big = randomBytes(5000);
		const text = Buffer.from("line\n".repeat(400));
		const entries: [string, Uint8Array, Record<string, unknown>?][] = [
			["plain.txt", text],
			["sub/stored.bin", big, { compress: false }],
			["empty", new Uint8Array(0)],
		];
		const normal = await build(entries);
		const forced = await build(entries, 1024);
		for (const path of [normal, forced]) {
			const t = unzip(["-t", path]);
			expect(t.err).toBe("");
			expect(t.status).toBe(0);
			expect(t.out.toString()).toContain("No errors detected");
			expect(unzip(["-p", path, "plain.txt"]).out.equals(text)).toBe(true);
			expect(unzip(["-p", path, "sub/stored.bin"]).out.equals(big)).toBe(true);
			expect(unzip(["-p", path, "empty"]).out.length).toBe(0);
		}
		// A streamed entry is zip64-declared even though it is small; unzip must cope with that too.
		const streamed = fresh();
		const sw = await ZipWriter.create(streamed);
		await sw.add("s.txt", chunked(text, 333));
		await sw.finish();
		expect(unzip(["-t", streamed]).status).toBe(0);
		expect(unzip(["-p", streamed, "s.txt"]).out.equals(text)).toBe(true);
	});
});

describe("damage", () => {
	/** Where an entry's compressed bytes begin, read from its local header. */
	async function dataStart(path: string, name: string): Promise<number> {
		const r = await ZipReader.open(path);
		const e = r.entry(name);
		await r.close();
		const raw = readFileSync(path);
		return (e?.offset ?? 0) + 30 + raw.readUInt16LE((e?.offset ?? 0) + 26) + raw.readUInt16LE((e?.offset ?? 0) + 28);
	}

	for (const compress of [true, false]) {
		test(`a flipped byte inside ${compress ? "deflated" : "stored"} data is corrupt on stream`, async () => {
			const data = randomBytes(30_000);
			const path = await build([["a", data, { compress }]]);
			const start = await dataStart(path, "a");
			const raw = readFileSync(path);
			raw[start + 15_000] = (raw[start + 15_000] ?? 0) ^ 0xff;
			writeFileSync(path, raw);
			const r = await ZipReader.open(path);
			try {
				expect(await codeOf(drain(r.stream("a")))).toBe("corrupt");
				expect(await codeOf(r.bytes("a"))).toBe("corrupt");
			} finally {
				await r.close();
			}
		});
	}

	test("compressed data that stops early is corrupt", async () => {
		const path = await build([["a", Buffer.from("compressible ".repeat(5000))]]);
		const raw = readFileSync(path);
		const cd = findAll(raw, 0x02014b50)[0] ?? 0;
		raw.writeUInt32LE(raw.readUInt32LE(cd + 20) - 8, cd + 20);
		writeFileSync(path, raw);
		const r = await ZipReader.open(path);
		try {
			expect(await codeOf(drain(r.stream("a")))).toBe("corrupt");
		} finally {
			await r.close();
		}
	});

	test("data that is not deflate at all is corrupt", async () => {
		const path = await build([["a", Buffer.alloc(2000, 0x41), { compress: false }]]);
		const raw = readFileSync(path);
		const cd = findAll(raw, 0x02014b50)[0] ?? 0;
		raw.writeUInt16LE(8, cd + 10);
		writeFileSync(path, raw);
		const r = await ZipReader.open(path);
		try {
			expect(await codeOf(drain(r.stream("a")))).toBe("corrupt");
		} finally {
			await r.close();
		}
	});

	test("a wrong recorded size or checksum is corrupt", async () => {
		for (const field of [16, 24]) {
			const path = await build([["a", Buffer.from("some bytes here")]]);
			const raw = readFileSync(path);
			const cd = findAll(raw, 0x02014b50)[0] ?? 0;
			raw.writeUInt32LE(raw.readUInt32LE(cd + field) + 1, cd + field);
			writeFileSync(path, raw);
			const r = await ZipReader.open(path);
			try {
				expect(await codeOf(drain(r.stream("a")))).toBe("corrupt");
			} finally {
				await r.close();
			}
		}
	});

	test("a truncated, garbage or empty file does not open as an archive", async () => {
		const good = await build([
			["a", randomBytes(20_000)],
			["b", Buffer.from("bee")],
		]);
		const raw = readFileSync(good);
		for (const keep of [raw.length - 1, raw.length - 30, Math.floor(raw.length / 2), 21, 4]) {
			const p = fresh();
			writeFileSync(p, raw.subarray(0, keep));
			expect(await codeOf(ZipReader.open(p))).toBe("corrupt");
		}
		const garbage = fresh();
		writeFileSync(garbage, randomBytes(3000));
		expect(await codeOf(ZipReader.open(garbage))).toBe("corrupt");
		const empty = fresh();
		writeFileSync(empty, "");
		expect(await codeOf(ZipReader.open(empty))).toBe("corrupt");
		const t = fresh();
		writeFileSync(t, raw);
		truncateSync(t, raw.length - 22);
		expect(await codeOf(ZipReader.open(t))).toBe("corrupt");
	});

	test("an end record that points at the wrong directory is corrupt", async () => {
		const good = await build([
			["a", randomBytes(2000)],
			["b", Buffer.from("bee")],
		]);
		const raw = readFileSync(good);
		const eocd = raw.length - 22;
		for (const delta of [3, -3, 0x7fffff]) {
			const bad = Buffer.from(raw);
			bad.writeUInt32LE(raw.readUInt32LE(eocd + 16) + delta, eocd + 16);
			const p = fresh();
			writeFileSync(p, bad);
			expect(await codeOf(ZipReader.open(p))).toBe("corrupt");
		}
		const bad = Buffer.from(raw);
		bad.writeUInt16LE(9, eocd + 10);
		const p = fresh();
		writeFileSync(p, bad);
		expect(await codeOf(ZipReader.open(p))).toBe("corrupt");
	});

	test("a zip64 locator that points at the wrong record is corrupt", async () => {
		const good = await build([["a", randomBytes(2000)]], 1024);
		const raw = readFileSync(good);
		const loc = findAll(raw, 0x07064b50)[0] ?? 0;
		const bad = Buffer.from(raw);
		bad.writeBigUInt64LE(raw.readBigUInt64LE(loc + 8) + 4n, loc + 8);
		const p = fresh();
		writeFileSync(p, bad);
		expect(await codeOf(ZipReader.open(p))).toBe("corrupt");
	});

	test("encryption, other methods and multi-disk archives are unsupported", async () => {
		const good = await build([["a", Buffer.from("secret")]]);
		const raw = readFileSync(good);
		const cd = findAll(raw, 0x02014b50)[0] ?? 0;
		const eocd = raw.length - 22;

		const encrypted = Buffer.from(raw);
		encrypted.writeUInt16LE(encrypted.readUInt16LE(cd + 8) | 1, cd + 8);
		const method = Buffer.from(raw);
		method.writeUInt16LE(14, cd + 10);
		const disks = Buffer.from(raw);
		disks.writeUInt16LE(1, eocd + 4);
		for (const bad of [encrypted, method, disks]) {
			const p = fresh();
			writeFileSync(p, bad);
			expect(await codeOf(ZipReader.open(p))).toBe("unsupported");
		}
	});
});

describe("abort and misuse", () => {
	test("abort deletes the file, is idempotent, and the writer is unusable afterwards", async () => {
		const path = fresh();
		const w = await ZipWriter.create(path);
		await w.add("a", Buffer.from("one"));
		expect(existsSync(path)).toBe(true);
		await w.abort();
		expect(existsSync(path)).toBe(false);
		await w.abort();
		expect(await codeOf(w.add("b", Buffer.from("two")))).toBe("aborted");
		expect(await codeOf(w.finish())).toBe("aborted");
	});

	test("abort after finish is a no-op", async () => {
		const path = await build([["a", Buffer.from("one")]]);
		const w = await ZipWriter.create(fresh());
		await w.finish();
		await w.abort();
		expect(existsSync(path)).toBe(true);
	});

	test("an aborted signal stops the source mid-entry with 'aborted', and the file can then be removed", async () => {
		const path = fresh();
		const w = await ZipWriter.create(path);
		const ac = new AbortController();
		const cleaned = Promise.withResolvers<void>();
		let release: () => void = () => {};
		const stuck = new Promise<void>((r) => {
			release = r;
		});
		async function* source(): AsyncGenerator<Uint8Array> {
			try {
				yield randomBytes(100_000);
				ac.abort();
				// A source that never produces again must not keep the abort waiting.
				await stuck;
				yield randomBytes(10);
			} finally {
				cleaned.resolve();
			}
		}
		expect(await codeOf(w.add("a", source(), { signal: ac.signal }))).toBe("aborted");
		expect(await codeOf(w.add("b", Buffer.from("x")))).toBe("aborted");
		release();
		await w.abort();
		expect(existsSync(path)).toBe(false);
		await cleaned.promise;
	});

	test("an already aborted signal writes nothing and leaves the writer usable", async () => {
		const path = fresh();
		const w = await ZipWriter.create(path);
		const ac = new AbortController();
		ac.abort();
		expect(await codeOf(w.add("a", Buffer.from("x"), { signal: ac.signal }))).toBe("aborted");
		await w.add("b", Buffer.from("y"));
		await w.finish();
		const r = await ZipReader.open(path);
		try {
			expect(r.entries.map((e) => e.name)).toEqual(["b"]);
		} finally {
			await r.close();
		}
	});

	test("a source that fails takes its entry back out, rethrows the same error, and leaves the writer usable", async () => {
		const mtimeMs = Date.UTC(2024, 0, 2, 3, 4, 6);
		const before = Buffer.from("kept before");
		const after = Buffer.from("kept after");
		const chunk = randomBytes(1_500_000);
		const boom = new Error("file vanished under the read");
		let released = false;
		async function* source(): AsyncGenerator<Uint8Array> {
			try {
				yield chunk;
				yield chunk;
				throw boom;
			} finally {
				released = true;
			}
		}
		for (const compress of [true, false]) {
			const path = fresh();
			const w = await ZipWriter.create(path);
			await w.add("before", before, { mtimeMs });
			let caught: unknown;
			try {
				await w.add("doomed", source(), { mtimeMs, compress });
			} catch (err) {
				caught = err;
			}
			expect(caught).toBe(boom);
			expect(released).toBe(true);
			// The name is free again, and the entries around the failure are intact.
			const again = await w.add("doomed", Buffer.from("second try"), { mtimeMs });
			await w.add("after", after, { mtimeMs });
			const done = await w.finish();
			expect(done.entries).toBe(3);
			expect(done.bytes).toBe(statSync(path).size);

			const r = await ZipReader.open(path);
			try {
				expect(r.entries.map((e) => e.name)).toEqual(["before", "doomed", "after"]);
				expect(Buffer.from(await r.bytes("doomed")).toString()).toBe("second try");
				expect(r.entry("doomed")?.crc32).toBe(again.crc32);
				expect(Buffer.from(await r.bytes("after")).equals(after)).toBe(true);
			} finally {
				await r.close();
			}
			if (existsSync(UNZIP)) {
				expect(unzip(["-t", path]).status).toBe(0);
				expect(unzip(["-p", path, "doomed"]).out.toString()).toBe("second try");
			}

			// Nothing of the failed entry is left: the file is byte for byte what an archive without it would be.
			const clean = fresh();
			const c = await ZipWriter.create(clean);
			await c.add("before", before, { mtimeMs });
			await c.add("doomed", Buffer.from("second try"), { mtimeMs });
			await c.add("after", after, { mtimeMs });
			await c.finish();
			expect(readFileSync(path).equals(readFileSync(clean))).toBe(true);
		}
	});

	test("a failing web stream is rolled back the same way, and the dropped name is absent when it is not added again", async () => {
		const path = fresh();
		const w = await ZipWriter.create(path);
		const boom = new Error("stream broke");
		const failing = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(Buffer.from("some bytes"));
				c.error(boom);
			},
		});
		// c.error() with queued data drops that data, so the stream fails on its first read.
		let caught: unknown;
		try {
			await w.add("gone", failing);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBe(boom);
		await w.add("kept", Buffer.from("k"));
		await w.finish();
		const r = await ZipReader.open(path);
		try {
			expect(r.entries.map((e) => e.name)).toEqual(["kept"]);
			expect(r.entry("gone")).toBeUndefined();
		} finally {
			await r.close();
		}
		if (existsSync(UNZIP)) expect(unzip(["-t", path]).status).toBe(0);
	});

	test("an abort during a failing source still leaves the writer unusable", async () => {
		const w = await ZipWriter.create(fresh());
		const ac = new AbortController();
		async function* source(): AsyncGenerator<Uint8Array> {
			yield Buffer.from("x");
			ac.abort();
			throw new Error("secondary");
		}
		expect(await codeOf(w.add("a", source(), { signal: ac.signal }))).toBe("aborted");
		expect(await codeOf(w.add("b", Buffer.from("y")))).toBe("aborted");
		await w.abort();
	});

	test("add must not run concurrently", async () => {
		const w = await ZipWriter.create(fresh());
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		async function* slow(): AsyncGenerator<Uint8Array> {
			await gate;
			yield Buffer.from("late");
		}
		const first = w.add("a", slow());
		expect(await codeOf(w.add("b", Buffer.from("x")))).toMatch(/^other:Error: .*concurrently/);
		release();
		await first;
		await w.add("b", Buffer.from("x"));
		expect((await w.finish()).entries).toBe(2);
	});

	test("create refuses to overwrite an existing file and makes a private one", async () => {
		const path = fresh();
		writeFileSync(path, "precious");
		await expect(ZipWriter.create(path)).rejects.toThrow();
		expect(readFileSync(path, "utf8")).toBe("precious");
		const other = fresh();
		const w = await ZipWriter.create(other);
		await w.finish();
		expect(statSync(other).mode & 0o777).toBe(0o600);
	});

	test("entry names are validated", async () => {
		const w = await ZipWriter.create(fresh());
		const bad = ["", "/abs", "a/../b", "..", "../x", "a\\b", "a\0b", "dir/", "x/./..", "\ud800"];
		for (const name of bad) expect(await codeOf(w.add(name, Buffer.from("x")))).toBe("name");
		expect(await codeOf(w.add("a".repeat(70_000), Buffer.from("x")))).toBe("name");
		// A rejected name does not poison the writer; neither do dots that are not a parent segment.
		await w.add("ok/..name/.hidden/a..b", Buffer.from("x"));
		await w.add("dup", Buffer.from("1"));
		expect(await codeOf(w.add("dup", Buffer.from("2")))).toBe("name");
		expect((await w.finish()).entries).toBe(2);
	});
});

describe("archives made by other tools", () => {
	zipTest("a directory entry is listed with size 0 and does not break reading; unzip -t agrees both ways", async () => {
		const src = join(dir, `src${seq++}`);
		Bun.spawnSync(["mkdir", "-p", join(src, "sub", "inner")]);
		writeFileSync(join(src, "sub", "file.txt"), "from info-zip\n".repeat(100));
		writeFileSync(join(src, "sub", "inner", "x.bin"), randomBytes(4000));
		const path = fresh(".zip");
		const made = Bun.spawnSync([ZIP, "-q", "-r", path, "sub"], { cwd: src });
		expect(made.exitCode).toBe(0);

		const r = await ZipReader.open(path);
		try {
			const names = r.entries.map((e) => e.name).sort();
			expect(names).toEqual(["sub/", "sub/file.txt", "sub/inner/", "sub/inner/x.bin"]);
			for (const d of ["sub/", "sub/inner/"]) {
				expect(r.entry(d)?.size).toBe(0);
				expect((await r.bytes(d)).length).toBe(0);
				expect((await drain(r.stream(d))).length).toBe(0);
			}
			expect(Buffer.from(await r.bytes("sub/file.txt")).toString()).toBe("from info-zip\n".repeat(100));
			expect(sha(await r.bytes("sub/inner/x.bin"))).toBe(sha(readFileSync(join(src, "sub", "inner", "x.bin"))));
			expect(r.entry("sub/file.txt")?.mode).toBe(statSync(join(src, "sub", "file.txt")).mode & 0o777);
		} finally {
			await r.close();
		}
		expect(unzip(["-t", path]).status).toBe(0);
	});

	zipTest("an archive from /usr/bin/zip read through a pipe-created stored entry", async () => {
		const src = join(dir, `src${seq++}`);
		Bun.spawnSync(["mkdir", "-p", src]);
		const data = randomBytes(300_000);
		writeFileSync(join(src, "r.bin"), data);
		const path = fresh(".zip");
		expect(Bun.spawnSync([ZIP, "-q", "-0", path, "r.bin"], { cwd: src }).exitCode).toBe(0);
		const r = await ZipReader.open(path);
		try {
			expect(r.entry("r.bin")?.method).toBe(0);
			expect(sha(await r.bytes("r.bin"))).toBe(sha(data));
		} finally {
			await r.close();
		}
	});
});
