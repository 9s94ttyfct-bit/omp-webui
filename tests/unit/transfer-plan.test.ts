import { describe, expect, test } from "bun:test";
import { TRANSFER_LIMITS } from "../../shared/transfer.ts";
import {
	backoffMs,
	type Conflict,
	checkBatch,
	conflictPlan,
	isFinished,
	isRetryable,
	joinPath,
	nextPiece,
	parentPath,
	pieceCount,
	progressOf,
	replaceable,
	retryAfterMs,
	targetFolder,
	typedPath,
} from "../../web/src/lib/transfer-plan.ts";

/**
 * What the page decides about an upload before it sends anything and between its requests (`lib/transfer-plan.ts`): how a
 * file is cut into pieces, when a failed piece is sent again, what a batch may hold and what each answer of the conflict
 * dialog does.
 */

const MiB = 1024 * 1024;

describe("pieces", () => {
	test("a file of at most one piece is one request, an empty file too", () => {
		expect(pieceCount(0)).toBe(1);
		expect(pieceCount(1)).toBe(1);
		expect(pieceCount(TRANSFER_LIMITS.pieceBytes)).toBe(1);
		expect(pieceCount(TRANSFER_LIMITS.pieceBytes + 1)).toBe(2);
		expect(pieceCount(20 * MiB)).toBe(3);
	});

	test("the next piece begins where the server stopped and ends at a piece or at the file's end", () => {
		const size = 20 * MiB;
		expect(nextPiece(0, size)).toEqual({ offset: 0, end: 8 * MiB });
		expect(nextPiece(8 * MiB, size)).toEqual({ offset: 8 * MiB, end: 16 * MiB });
		expect(nextPiece(16 * MiB, size)).toEqual({ offset: 16 * MiB, end: size });
		expect(nextPiece(0, 0)).toEqual({ offset: 0, end: 0 });
	});

	test("an offset the server reports past the file or below nothing is held to the file", () => {
		expect(nextPiece(99, 10)).toEqual({ offset: 10, end: 10 });
		expect(nextPiece(-5, 10)).toEqual({ offset: 0, end: 10 });
		expect(nextPiece(3, 10, 4)).toEqual({ offset: 3, end: 7 });
	});
});

describe("sending a piece again", () => {
	test("no answer, a body that stopped, a busy server and a failing one are tried again; the rest are not", () => {
		for (const status of [0, 408, 429, 500, 502, 503, 504]) expect(isRetryable(status)).toBe(true);
		for (const status of [400, 403, 404, 409, 412, 413, 415, 507]) expect(isRetryable(status)).toBe(false);
	});

	test("the wait doubles from half a second, never passes thirty, and honours what Retry-After asked", () => {
		expect([1, 2, 3, 4].map((n) => backoffMs(n))).toEqual([500, 1000, 2000, 4000]);
		expect(backoffMs(20)).toBe(30_000);
		expect(backoffMs(1, 7000)).toBe(7000);
		expect(backoffMs(1, 120_000)).toBe(30_000);
		expect(backoffMs(3, 100)).toBe(2000);
	});

	test("Retry-After is seconds; anything else is no wish", () => {
		expect(retryAfterMs("3")).toBe(3000);
		expect(retryAfterMs("0.5")).toBe(500);
		expect(retryAfterMs(null)).toBe(0);
		expect(retryAfterMs("")).toBe(0);
		expect(retryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT")).toBe(0);
		expect(retryAfterMs("-4")).toBe(0);
	});
});

describe("a batch", () => {
	const file = (size: number) => ({ size });

	test("a file over the limit is left out and the rest go", () => {
		const big = file(TRANSFER_LIMITS.uploadBytes + 1);
		const ok = file(10);
		const edge = file(TRANSFER_LIMITS.uploadBytes);
		const out = checkBatch([ok, big, edge]);
		expect(out.send).toEqual([ok, edge]);
		expect(out.tooLarge).toEqual([big]);
		expect(out.tooMany).toBe(false);
	});

	test("more files than one upload takes: nothing is sent", () => {
		const many = Array.from({ length: TRANSFER_LIMITS.uploadFiles + 1 }, () => file(1));
		expect(checkBatch(many)).toEqual({ send: [], tooLarge: [], tooMany: true });
		expect(checkBatch(many.slice(1)).tooMany).toBe(false);
	});
});

describe("the answer to files that are already there", () => {
	const there = (key: number, replaceableNow: boolean, etag = `e${key}`): Conflict => ({
		key,
		failure: { suggestion: `n (${key})`, existing: { size: 1, modified: 1, etag, replaceable: replaceableNow } },
	});

	test("keep both sends every file again, asking for a free name", () => {
		const plan = conflictPlan([there(1, true), there(2, false)], "keep");
		expect(plan.resend).toEqual([
			{ key: 1, exists: "keep" },
			{ key: 2, exists: "keep" },
		]);
		expect(plan.skipped).toEqual([]);
		expect(plan.refused).toEqual([]);
	});

	test("replace sends the files that may be replaced with the etag the server gave; the others keep their conflict", () => {
		const plan = conflictPlan([there(1, true, "abc"), there(2, false), there(3, true, "def")], "replace");
		expect(plan.resend).toEqual([
			{ key: 1, replace: "abc" },
			{ key: 3, replace: "def" },
		]);
		expect(plan.refused).toEqual([2]);
		expect(plan.skipped).toEqual([]);
	});

	test("skip sends nothing", () => {
		const plan = conflictPlan([there(1, true), there(2, false)], "skip");
		expect(plan).toEqual({ resend: [], skipped: [1, 2], refused: [] });
	});

	test("replace is offered for all, for some, or for none of them", () => {
		expect(replaceable([there(1, true), there(2, true)])).toBe("all");
		expect(replaceable([there(1, true), there(2, false)])).toBe("some");
		expect(replaceable([there(1, false)])).toBe("none");
		expect(replaceable([])).toBe("none");
	});
});

describe("paths", () => {
	test("parent and join", () => {
		expect(parentPath("a/b/c.txt")).toBe("a/b");
		expect(parentPath("c.txt")).toBe("");
		expect(joinPath("", "c.txt")).toBe("c.txt");
		expect(joinPath("a/b", "c.txt")).toBe("a/b/c.txt");
	});

	test("uploads go to the focused folder, the folder around a focused file, or the conversation's folder", () => {
		const folders = new Set(["src", "src/lib"]);
		const isFolder = (path: string) => folders.has(path);
		expect(targetFolder("src/lib", isFolder)).toBe("src/lib");
		expect(targetFolder("src/app.ts", isFolder)).toBe("src");
		expect(targetFolder("README.md", isFolder)).toBe("");
		expect(targetFolder(null, isFolder)).toBe("");
	});

	test("a typed path is relative to the conversation's folder and stays inside it", () => {
		expect(typedPath("dist")).toBe("dist");
		expect(typedPath("  dist/  ")).toBe("dist");
		expect(typedPath("./node_modules/zod")).toBe("node_modules/zod");
		expect(typedPath("a\\b")).toBe("a/b");
		expect(typedPath("")).toBeNull();
		expect(typedPath(".")).toBeNull();
		expect(typedPath("/etc/passwd")).toBeNull();
		expect(typedPath("~/.ssh")).toBeNull();
		expect(typedPath("../secret")).toBeNull();
		expect(typedPath("a/../../b")).toBeNull();
		expect(typedPath("a//b")).toBeNull();
	});
});

describe("how far an upload has got", () => {
	test("finished files count whole, the ones being sent by what has gone", () => {
		const rows = [
			{ state: "done" as const, size: 100, sent: 100 },
			{ state: "sending" as const, size: 100, sent: 40 },
			{ state: "waiting" as const, size: 50, sent: 0 },
			{ state: "failed" as const, size: 10, sent: 3 },
		];
		expect(progressOf(rows)).toEqual({ files: 4, done: 1, failed: 1, bytes: 260, sent: 143 });
	});

	test("no row is nothing", () => {
		expect(progressOf([])).toEqual({ files: 0, done: 0, failed: 0, bytes: 0, sent: 0 });
	});

	test("a row is finished once it is done, failed, left out or cancelled", () => {
		for (const state of ["done", "failed", "skipped", "cancelled"] as const) expect(isFinished(state)).toBe(true);
		for (const state of ["waiting", "sending", "held"] as const) expect(isFinished(state)).toBe(false);
	});
});
