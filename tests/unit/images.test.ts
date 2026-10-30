import { describe, expect, test } from "bun:test";
import { MAX_WS_MESSAGE_BYTES as SERVER_WS_MESSAGE_BYTES } from "../../shared/protocol.ts";
import {
	attachedBytes,
	base64Bytes,
	checkLimits,
	fitWithin,
	MAX_IMAGE_BYTES,
	MAX_IMAGE_EDGE,
	MAX_TOTAL_IMAGE_BYTES,
	needsResize,
	REENCODE_ABOVE_BYTES,
	refusalMessage,
} from "../../web/src/lib/images.ts";

const MB = 1024 * 1024;

test("the limits are the ones the server's WebSocket message limit is sized for", () => {
	expect(MAX_IMAGE_EDGE).toBe(2560);
	expect(REENCODE_ABOVE_BYTES).toBe(4 * MB);
	expect(MAX_IMAGE_BYTES).toBe(8 * MB);
	expect(MAX_TOTAL_IMAGE_BYTES).toBe(20 * MB);
});

test("a full message of images, base64-encoded, still fits the server's limit with room for text", () => {
	const encoded = Math.ceil(MAX_TOTAL_IMAGE_BYTES / 3) * 4;
	expect(encoded).toBeLessThan(SERVER_WS_MESSAGE_BYTES - 4 * MB);
});

describe("fitWithin", () => {
	test("leaves images inside the limit alone, and never upscales", () => {
		expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
		expect(fitWithin(MAX_IMAGE_EDGE, 100)).toEqual({ width: MAX_IMAGE_EDGE, height: 100 });
	});

	test("scales the longest side down to the limit, keeping the aspect ratio", () => {
		expect(fitWithin(5120, 2880)).toEqual({ width: 2560, height: 1440 });
		expect(fitWithin(2880, 5120)).toEqual({ width: 1440, height: 2560 });
		// 2000 * 2560 / 3000 = 1706.67
		expect(fitWithin(3000, 2000)).toEqual({ width: 2560, height: 1707 });
	});

	test("a sliver stays at least one pixel tall", () => {
		expect(fitWithin(100_000, 10)).toEqual({ width: 2560, height: 1 });
	});
});

test("an image needs processing when it is too wide, too tall or too heavy", () => {
	expect(needsResize(2560, 1440, 4 * MB)).toBe(false);
	expect(needsResize(2561, 100, 1000)).toBe(true);
	expect(needsResize(100, 2561, 1000)).toBe(true);
	expect(needsResize(100, 100, 4 * MB + 1)).toBe(true);
});

describe("base64Bytes", () => {
	test("reads the decoded size off the text, padding included", () => {
		expect(base64Bytes("")).toBe(0);
		expect(base64Bytes("QQ==")).toBe(1);
		expect(base64Bytes("QUI=")).toBe(2);
		expect(base64Bytes("QUJD")).toBe(3);
	});

	test("agrees with real encodings of every length remainder", () => {
		for (const n of [1000, 1001, 1002, 1003]) {
			const bytes = crypto.getRandomValues(new Uint8Array(n));
			expect(base64Bytes(Buffer.from(bytes).toString("base64"))).toBe(n);
		}
	});
});

test("attachedBytes totals the images already in the composer", () => {
	const img = (n: number) => ({ data: Buffer.alloc(n).toString("base64") });
	expect(attachedBytes([])).toBe(0);
	expect(attachedBytes([img(10), img(2000), img(31)])).toBe(2041);
});

describe("checkLimits", () => {
	test("one image may weigh up to the per-image limit, not a byte more", () => {
		expect(checkLimits("a.png", MAX_IMAGE_BYTES, 0)).toBeNull();
		expect(checkLimits("a.png", MAX_IMAGE_BYTES + 1, 0)).toEqual({
			reason: "tooLarge",
			name: "a.png",
			bytes: MAX_IMAGE_BYTES + 1,
			limit: MAX_IMAGE_BYTES,
		});
	});

	test("a message's images may weigh up to the total limit together, not a byte more", () => {
		expect(checkLimits("b.png", 8 * MB, 12 * MB)).toBeNull();
		expect(checkLimits("b.png", 1, MAX_TOTAL_IMAGE_BYTES)).toEqual({
			reason: "totalTooLarge",
			name: "b.png",
			total: MAX_TOTAL_IMAGE_BYTES + 1,
			limit: MAX_TOTAL_IMAGE_BYTES,
		});
	});

	test("an image that is too big on its own is reported as such, whatever the total", () => {
		expect(checkLimits("c.png", MAX_IMAGE_BYTES + 1, MAX_TOTAL_IMAGE_BYTES)?.reason).toBe("tooLarge");
	});
});

describe("refusalMessage", () => {
	test("names the file and gives sizes in MB", () => {
		expect(refusalMessage({ reason: "tooLarge", name: "big.png", bytes: 11.5 * MB, limit: 8 * MB })).toEqual({
			key: "chat.imageTooLarge",
			vars: { name: "big.png", size: "11.5 MB", limit: "8 MB" },
		});
		expect(refusalMessage({ reason: "totalTooLarge", name: "d.png", total: 21.04 * MB, limit: 20 * MB })).toEqual({
			key: "chat.imagesTooLarge",
			vars: { name: "d.png", total: "21 MB", limit: "20 MB" },
		});
	});
});
