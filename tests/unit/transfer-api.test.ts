import { describe, expect, test } from "bun:test";
import { ERROR_HEADER, TRANSFER_LIMITS } from "../../shared/transfer.ts";
import { en } from "../../web/src/i18n/files.ts";
import { registerStrings } from "../../web/src/i18n/index.ts";
import {
	downloadUrl,
	failureOf,
	type PieceParams,
	type Reply,
	stateUrl,
	TransferError,
	type Transport,
	UploadBatch,
	type UploadRow,
	uploadOne,
	uploadUrl,
} from "../../web/src/lib/transfer-api.ts";
import { describeFailure, leftOutCount, leftOutText } from "../../web/src/lib/transfer-words.ts";

registerStrings("files", en);

/**
 * The upload engine against a server that is made up (`lib/transfer-api.ts`): begin, pieces, where the upload stands,
 * sending again, starting over, cancelling, the batch of three at a time and the question about files that are there.
 */

const MiB = 1024 * 1024;
const scope = { live: "live 1", file: null };
const noSleep = () => Promise.resolve();

const json = (status: number, body: unknown, extra: Partial<Reply> = {}): Reply => ({
	status,
	text: JSON.stringify(body),
	code: null,
	retryAfterMs: 0,
	...extra,
});
const saved = (name: string, bytes: number) => ({
	done: true,
	path: name,
	name,
	bytes,
	sha256: "0".repeat(64),
	replaced: false,
});
const fail = (status: number, code: string, extra: Record<string, unknown> = {}) =>
	json(status, { error: `sentence for ${code}`, code, ...extra });

/** What the page asked of the server, in order. */
interface Seen {
	params: PieceParams;
	bytes: number;
}

/** A server that answers each request with the next of `answers` (a function is asked); `state` answers `upload/state`. */
function fake(
	answers: (Reply | ((params: PieceParams, bytes: number) => Reply))[],
	state: (id: string) => Reply = () => fail(404, "gone"),
) {
	const seen: Seen[] = [];
	const cancelled: string[] = [];
	const asked: string[] = [];
	let at = 0;
	const transport: Transport = {
		async piece(_scope, params, body, signal, onBytes) {
			if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
			seen.push({ params, bytes: body.size });
			onBytes(body.size);
			const next = answers[at++] ?? fail(500, "write");
			return typeof next === "function" ? next(params, body.size) : next;
		},
		async state(id) {
			asked.push(id);
			return state(id);
		},
		async cancel(id) {
			cancelled.push(id);
		},
	};
	return { transport, seen, cancelled, asked };
}

const blob = (size: number) => new Blob([new Uint8Array(size)]);
const item = (size: number, name = "report.bin", dir = "") => ({ file: blob(size), dir, name, size });
const signal = () => new AbortController().signal;

describe("addresses", () => {
	test("a download names the conversation and the path, encoded", () => {
		expect(downloadUrl(scope, "a b/c&d.txt")).toBe("/api/folder/download?live=live%201&path=a%20b%2Fc%26d.txt");
		expect(downloadUrl({ live: null, file: "/x/y.jsonl" }, "")).toBe("/api/folder/download?file=%2Fx%2Fy.jsonl&path=");
	});

	test("a piece carries the folder, name and whole size; the id and offset only after the first", () => {
		expect(uploadUrl(scope, { dir: "src/lib", name: "a b.ts", size: 12 })).toBe(
			"/api/folder/upload?live=live%201&dir=src%2Flib&name=a%20b.ts&size=12",
		);
		expect(uploadUrl(scope, { dir: "", name: "x", size: 20, id: "u1", offset: 8, exists: "keep" })).toBe(
			"/api/folder/upload?live=live%201&dir=&name=x&size=20&id=u1&offset=8&exists=keep",
		);
		expect(uploadUrl(scope, { dir: "", name: "x", size: 3, replace: "etag/1" })).toContain("&replace=etag%2F1");
		expect(stateUrl("a b")).toBe("/api/folder/upload/state?id=a%20b");
	});
});

describe("reading a failure", () => {
	test("the code and the sentence come from the body, what else it carries with them", () => {
		const e = failureOf(fail(413, "tooLarge", { limit: 5 }));
		expect(e).toBeInstanceOf(TransferError);
		expect([e.code, e.status, e.message, e.limit]).toEqual(["tooLarge", 413, "sentence for tooLarge", 5]);
		const taken = failureOf(
			fail(409, "exists", {
				suggestion: "a (2).txt",
				existing: { size: 1, modified: 2, etag: "e", replaceable: true },
			}),
		);
		expect(taken.suggestion).toBe("a (2).txt");
		expect(taken.existing).toEqual({ size: 1, modified: 2, etag: "e", replaceable: true });
		expect(failureOf(fail(409, "offset", { received: 8 })).received).toBe(8);
	});

	test("a HEAD has no body: the code is in the header", () => {
		const e = failureOf({ status: 403, text: "", code: "hidden", retryAfterMs: 0 });
		expect([e.code, e.status, e.message]).toEqual(["hidden", 403, "HTTP 403"]);
		expect(ERROR_HEADER).toBe("x-omp-webui-error");
	});

	test("a code the page does not know, and an answer that is none of the server's, are `failed`", () => {
		expect(failureOf(fail(400, "somethingNew")).code).toBe("failed");
		expect(failureOf(fail(400, "somethingNew")).message).toBe("sentence for somethingNew");
		expect(failureOf({ status: 502, text: "<html>Bad gateway</html>", code: null, retryAfterMs: 0 })).toMatchObject({
			code: "failed",
			message: "HTTP 502",
		});
		expect(failureOf({ status: 0, text: "", code: null, retryAfterMs: 0 }).message).toBe("The connection failed");
	});

	test("the words are the page's own for a code, the server's sentence for another", () => {
		expect(describeFailure(failureOf(fail(403, "secret")), ".env")).toBe(
			"“.env” looks like a secret (a key or credentials), so it is not transferred.",
		);
		expect(describeFailure(failureOf(fail(413, "tooLarge", { limit: 2 * MiB })), "big.iso")).toBe(
			"“big.iso” is too large: a file can be 2.1 MB at most.",
		);
		expect(describeFailure(failureOf(fail(413, "tooMany", { limit: 5000 })), "")).toBe("Too many files: 5000 at most.");
		expect(describeFailure(failureOf(fail(400, "somethingNew")), "x")).toBe("sentence for somethingNew");
		expect(describeFailure(failureOf({ status: 0, text: "", code: null, retryAfterMs: 0 }), "x")).toBe(
			"The connection to the computer failed.",
		);
	});

	test("what a ZIP leaves out, in a sentence", () => {
		const none = { secret: 0, links: 0, special: 0, name: 0, hidden: 0 };
		expect(leftOutCount(none)).toBe(0);
		const some = { ...none, secret: 2, hidden: 5 };
		expect(leftOutCount(some)).toBe(7);
		expect(leftOutText(some, "en")).toBe("2 that look like secrets & 5 hidden");
	});
});

describe("uploading one file", () => {
	test("a small file is one request that finishes it", async () => {
		const { transport, seen } = fake([json(200, saved("report.bin", 10))]);
		const got = await uploadOne(scope, item(10), { signal: signal() }, transport);
		expect(got.name).toBe("report.bin");
		expect(seen).toHaveLength(1);
		expect(seen[0]?.params).toEqual({ dir: "", name: "report.bin", size: 10 });
		expect(seen[0]?.bytes).toBe(10);
	});

	test("a big file goes in pieces: begin without an id, then the id and the offset the server gave", async () => {
		const size = 20 * MiB;
		const { transport, seen } = fake([
			json(202, { id: "u1", received: 8 * MiB, size }),
			json(202, { id: "u1", received: 16 * MiB, size }),
			json(200, saved("report.bin", size)),
		]);
		const progress: number[] = [];
		await uploadOne(scope, item(size), { signal: signal(), onProgress: (n) => progress.push(n) }, transport);
		expect(seen.map((s) => [s.params.id, s.params.offset, s.bytes])).toEqual([
			[undefined, undefined, 8 * MiB],
			["u1", 8 * MiB, 8 * MiB],
			["u1", 16 * MiB, 4 * MiB],
		]);
		expect(progress.at(-1)).toBe(size);
		expect(progress).toEqual([...progress].sort((a, b) => a - b));
	});

	test("a piece that fails is asked about and sent again from where the server holds the file", async () => {
		const size = 20 * MiB;
		const { transport, seen, asked } = fake(
			[
				json(202, { id: "u1", received: 8 * MiB, size }),
				fail(503, "busy"),
				json(202, { id: "u1", received: 16 * MiB, size }),
				json(200, saved("report.bin", size)),
			],
			// The piece that failed had arrived after all: the server holds 16 MiB.
			() => json(200, { id: "u1", received: 16 * MiB, size }),
		);
		await uploadOne(scope, item(size), { signal: signal(), sleep: noSleep }, transport);
		expect(asked).toEqual(["u1"]);
		expect(seen.map((s) => s.params.offset)).toEqual([undefined, 8 * MiB, 16 * MiB, 16 * MiB]);
	});

	test("a failure to connect is tried again, five tries in all, then it is the failure", async () => {
		const down: Reply = { status: 0, text: "", code: null, retryAfterMs: 0 };
		const { transport, seen } = fake([down, down, down, down, down, json(200, saved("report.bin", 10))]);
		const waits: number[] = [];
		const error = await uploadOne(
			scope,
			item(10),
			{ signal: signal(), sleep: async (ms) => void waits.push(ms) },
			transport,
		).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(TransferError);
		expect((error as TransferError).status).toBe(0);
		expect(seen).toHaveLength(5);
		expect(waits).toEqual([500, 1000, 2000, 4000]);
	});

	test("a busy server's Retry-After is waited for", async () => {
		const busy = fail(429, "busy");
		busy.retryAfterMs = 7000;
		const { transport } = fake([busy, json(200, saved("report.bin", 10))]);
		const waits: number[] = [];
		await uploadOne(scope, item(10), { signal: signal(), sleep: async (ms) => void waits.push(ms) }, transport);
		expect(waits).toEqual([7000]);
	});

	test("a refusal is not tried again", async () => {
		const { transport, seen } = fake([fail(403, "secret")]);
		const error = await uploadOne(scope, item(10, ".env"), { signal: signal(), sleep: noSleep }, transport).catch(
			(e: unknown) => e,
		);
		expect((error as TransferError).code).toBe("secret");
		expect(seen).toHaveLength(1);
	});

	test("an upload the server lost begins again from the start, once", async () => {
		const size = 12 * MiB;
		const { transport, seen } = fake([
			json(202, { id: "u1", received: 8 * MiB, size }),
			fail(404, "gone"),
			json(202, { id: "u2", received: 8 * MiB, size }),
			json(200, saved("report.bin", size)),
		]);
		await uploadOne(scope, item(size), { signal: signal(), sleep: noSleep }, transport);
		expect(seen.map((s) => [s.params.id, s.params.offset])).toEqual([
			[undefined, undefined],
			["u1", 8 * MiB],
			[undefined, undefined],
			["u2", 8 * MiB],
		]);

		const twice = fake([
			json(202, { id: "u1", received: 8 * MiB, size }),
			fail(404, "gone"),
			json(202, { id: "u2", received: 8 * MiB, size }),
			fail(404, "gone"),
		]);
		const error = await uploadOne(scope, item(size), { signal: signal(), sleep: noSleep }, twice.transport).catch(
			(e: unknown) => e,
		);
		expect((error as TransferError).code).toBe("gone");
	});

	test("an upload that is gone when asked about starts over too", async () => {
		const size = 12 * MiB;
		const { transport, seen } = fake(
			[
				json(202, { id: "u1", received: 8 * MiB, size }),
				fail(500, "write"),
				json(202, { id: "u2", received: 8 * MiB, size }),
				json(200, saved("report.bin", size)),
			],
			() => fail(404, "gone"),
		);
		await uploadOne(scope, item(size), { signal: signal(), sleep: noSleep }, transport);
		expect(seen.map((s) => s.params.id)).toEqual([undefined, "u1", undefined, "u2"]);
	});

	test("a piece out of step goes on from what the server says it holds", async () => {
		const size = 20 * MiB;
		const { transport, seen } = fake([
			json(202, { id: "u1", received: 8 * MiB, size }),
			fail(409, "offset", { received: 12 * MiB }),
			json(200, saved("report.bin", size)),
		]);
		await uploadOne(scope, item(size), { signal: signal(), sleep: noSleep }, transport);
		expect(seen.map((s) => s.params.offset)).toEqual([undefined, 8 * MiB, 12 * MiB]);
	});

	test("a file that is there is a conflict that carries what is there; keep and replace send the words", async () => {
		const existing = { size: 5, modified: 9, etag: "tag", replaceable: true };
		const taken = fake([fail(409, "exists", { suggestion: "report (2).bin", existing })]);
		const error = (await uploadOne(scope, item(10), { signal: signal() }, taken.transport).catch(
			(e: unknown) => e,
		)) as TransferError;
		expect(error.code).toBe("exists");
		expect(error.existing).toEqual(existing);

		const keep = fake([json(200, saved("report (2).bin", 10))]);
		await uploadOne(scope, item(10), { signal: signal(), exists: "keep" }, keep.transport);
		expect(keep.seen[0]?.params.exists).toBe("keep");
		const replace = fake([json(200, { ...saved("report.bin", 10), replaced: true })]);
		await uploadOne(scope, item(10), { signal: signal(), replace: "tag" }, replace.transport);
		expect(replace.seen[0]?.params.replace).toBe("tag");
	});

	test("cancelling stops it and tells the server to throw away what arrived", async () => {
		const size = 20 * MiB;
		const control = new AbortController();
		const { transport, cancelled } = fake([
			json(202, { id: "u1", received: 8 * MiB, size }),
			() => {
				control.abort();
				throw new DOMException("Cancelled", "AbortError");
			},
		]);
		const error = await uploadOne(scope, item(size), { signal: control.signal }, transport).catch((e: unknown) => e);
		expect((error as DOMException).name).toBe("AbortError");
		expect(cancelled).toEqual(["u1"]);
	});

	test("cancelling before the server has given an id has nothing to cancel there", async () => {
		const control = new AbortController();
		control.abort();
		const { transport, cancelled, seen } = fake([]);
		const error = await uploadOne(scope, item(10), { signal: control.signal }, transport).catch((e: unknown) => e);
		expect((error as DOMException).name).toBe("AbortError");
		expect(cancelled).toEqual([]);
		expect(seen).toEqual([]);
	});
});

describe("a batch", () => {
	const items = (n: number, size = 10) =>
		Array.from({ length: n }, (_, i) => ({ file: blob(size), dir: "", name: `f${i}.txt`, size }));
	const states = (rows: UploadRow[]) => rows.map((r) => r.state);

	/** Let every promise that can settle without a timer settle (the fake server answers at once). */
	const flush = async () => {
		for (let i = 0; i < 50; i++) await Promise.resolve();
	};

	test("three files are sent at a time", async () => {
		let running = 0;
		let most = 0;
		const gates: (() => void)[] = [];
		const transport: Transport = {
			async piece(_s, params) {
				running++;
				most = Math.max(most, running);
				const { promise, resolve } = Promise.withResolvers<void>();
				gates.push(resolve);
				await promise;
				running--;
				return json(200, saved(params.name, params.size));
			},
			state: async () => fail(404, "gone"),
			cancel: async () => {},
		};
		const batch = new UploadBatch(scope, () => {}, { transport, sleep: noSleep });
		const done = batch.add(items(7));
		await flush();
		expect(running).toBe(3);
		// Open the gates a wave at a time, until every file has been through.
		for (let wave = 0; wave < 20 && running + gates.length > 0; wave++) {
			for (const open of gates.splice(0)) open();
			await flush();
		}
		await done;
		expect(most).toBe(3);
		expect(states(batch.rows)).toEqual(Array(7).fill("done"));
		expect(batch.busy).toBe(false);
	});

	test("a file whose name is taken is held until the others are done; Keep both then sends it under a free name", async () => {
		const existing = { size: 5, modified: 9, etag: "tag", replaceable: true };
		const { transport, seen } = fake([
			json(200, saved("f0.txt", 10)),
			fail(409, "exists", { suggestion: "f1 (2).txt", existing }),
			json(200, saved("f2.txt", 10)),
			// The held file again, asked to keep both.
			json(200, saved("f1 (2).txt", 10)),
		]);
		const batch = new UploadBatch(scope, () => {}, { transport, sleep: noSleep, concurrency: 1 });
		await batch.add(items(3));
		expect(states(batch.rows)).toEqual(["done", "held", "done"]);
		expect(batch.held().map((c) => c.key)).toEqual([1]);
		await batch.resolve("keep");
		expect(states(batch.rows)).toEqual(["done", "done", "done"]);
		expect(batch.rows[1]?.saved?.name).toBe("f1 (2).txt");
		expect(seen.at(-1)?.params.exists).toBe("keep");
		expect(batch.held()).toEqual([]);
	});

	test("Replace sends the etag; a file that changed meanwhile is left out with its reason", async () => {
		const existing = { size: 5, modified: 9, etag: "tag", replaceable: true };
		const { transport, seen } = fake([
			fail(409, "exists", { suggestion: "f0 (2).txt", existing }),
			fail(412, "changed"),
		]);
		const batch = new UploadBatch(scope, () => {}, { transport, sleep: noSleep });
		await batch.add(items(1));
		await batch.resolve("replace");
		expect(seen[1]?.params.replace).toBe("tag");
		expect(batch.rows[0]?.state).toBe("skipped");
		expect(batch.rows[0]?.error?.code).toBe("changed");
	});

	test("Skip leaves the held files out; one that cannot be replaced keeps its conflict as a failure", async () => {
		const there = (replaceableNow: boolean) => ({ size: 5, modified: 9, etag: "tag", replaceable: replaceableNow });
		const skip = fake([fail(409, "exists", { suggestion: "x", existing: there(true) })]);
		const a = new UploadBatch(scope, () => {}, { transport: skip.transport, sleep: noSleep });
		await a.add(items(1));
		await a.resolve("skip");
		expect(states(a.rows)).toEqual(["skipped"]);

		const program = fake([fail(409, "exists", { suggestion: "x", existing: there(false) })]);
		const b = new UploadBatch(scope, () => {}, { transport: program.transport, sleep: noSleep });
		await b.add(items(1));
		await b.resolve("replace");
		expect(states(b.rows)).toEqual(["failed"]);
		expect(b.rows[0]?.error?.code).toBe("exists");
		expect(program.seen).toHaveLength(1);
	});

	test("a failure of one file does not stop the others, and says its code", async () => {
		const { transport } = fake([fail(403, "secret"), json(200, saved("f1.txt", 10))]);
		const batch = new UploadBatch(scope, () => {}, { transport, sleep: noSleep, concurrency: 1 });
		await batch.add(items(2));
		expect(states(batch.rows)).toEqual(["failed", "done"]);
		expect(batch.rows[0]?.error).toMatchObject({ code: "secret", status: 403 });
	});

	test("a refusal that the setting was turned off stops the rest of the batch", async () => {
		const { transport, seen } = fake([fail(403, "uploadOff")]);
		const batch = new UploadBatch(scope, () => {}, { transport, sleep: noSleep, concurrency: 1 });
		await batch.add(items(4));
		expect(seen).toHaveLength(1);
		expect(states(batch.rows)).toEqual(["failed", "cancelled", "cancelled", "cancelled"]);
		expect(batch.halted?.code).toBe("uploadOff");
		expect(batch.busy).toBe(false);
	});

	test("cancel stops the files being sent and those that wait", async () => {
		const gates: (() => void)[] = [];
		const cancelled: string[] = [];
		const transport: Transport = {
			async piece(_s, params, _b, abort) {
				const { promise, resolve, reject } = Promise.withResolvers<void>();
				gates.push(resolve);
				abort.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
				await promise;
				return json(200, saved(params.name, params.size));
			},
			state: async () => fail(404, "gone"),
			cancel: async (id) => void cancelled.push(id),
		};
		const batch = new UploadBatch(scope, () => {}, { transport, sleep: noSleep });
		const done = batch.add(items(5));
		await flush();
		batch.cancel();
		await done;
		expect(states(batch.rows)).toEqual(Array(5).fill("cancelled"));
		expect(batch.busy).toBe(false);
	});

	test("progress is reported as the files go, and the end is reported at once", async () => {
		const { transport } = fake([json(200, saved("f0.txt", 10))]);
		const seen: UploadRow[][] = [];
		const batch = new UploadBatch(scope, (rows) => seen.push(rows), { transport, sleep: noSleep });
		await batch.add(items(1));
		expect(seen.at(-1)?.[0]?.state).toBe("done");
		expect(seen.some((rows) => rows[0]?.state === "sending")).toBe(true);
	});

	test("limits the page knows are the contract's", () => {
		expect(TRANSFER_LIMITS.uploadFiles).toBe(5000);
		expect(TRANSFER_LIMITS.pieceBytes).toBe(8 * MiB);
	});
});
