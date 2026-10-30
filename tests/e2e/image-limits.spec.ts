import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type * as Images from "../../web/src/lib/images.ts";
import { expect, test } from "./fixtures.ts";

/**
 * `prepareImage` / `prepareImages` in a real browser: decoding, canvas re-encoding and the limits.
 * The module is bundled with bun and injected into a page (CSP bypassed for that injection only),
 * so the spec does not depend on how the composer wires it. No model call.
 */

declare const __images: typeof Images;

interface Make {
	/** A PNG file; `noise` makes it incompressible (heavy), otherwise it is a plain gradient (light). */
	png(width: number, height: number, noise: boolean): Promise<File>;
	/** A file of zero bytes the browser cannot decode as an image. */
	bytes(size: number, type: string, name: string): File;
	/** The pixel size of an attachment `prepareImage` returned. */
	size(result: { mimeType: string; data: string }): Promise<{ width: number; height: number }>;
}
declare const __make: Make;

const MB = 1024 * 1024;

const MAKE = `
window.__make = {
	async png(width, height, noise) {
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const g = canvas.getContext("2d");
		if (noise) {
			const px = g.createImageData(width, height);
			for (let i = 0; i < px.data.length; i += 65536) crypto.getRandomValues(px.data.subarray(i, i + 65536));
			for (let i = 3; i < px.data.length; i += 4) px.data[i] = 255;
			g.putImageData(px, 0, 0);
		} else {
			const fill = g.createLinearGradient(0, 0, width, 0);
			fill.addColorStop(0, "#3b82f6");
			fill.addColorStop(1, "#ec4899");
			g.fillStyle = fill;
			g.fillRect(0, 0, width, height);
		}
		const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
		return new File([blob], width + "x" + height + ".png", { type: "image/png" });
	},
	bytes(size, type, name) {
		return new File([new Uint8Array(size)], name, { type });
	},
	async size(result) {
		const bitmap = await createImageBitmap(await (await fetch("data:" + result.mimeType + ";base64," + result.data)).blob());
		return { width: bitmap.width, height: bitmap.height };
	},
};
`;

test.use({ bypassCSP: true });

let bundle = "";
test.beforeAll(() => {
	const dir = mkdtempSync(join(tmpdir(), "ompw-images-"));
	try {
		const entry = join(dir, "entry.ts");
		const source = resolve("web/src/lib/images.ts");
		writeFileSync(
			entry,
			`import * as images from ${JSON.stringify(source)};\nObject.assign(window, { __images: images });\n`,
		);
		bundle = execFileSync("bun", ["build", entry, "--target=browser"], { encoding: "utf8" });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test.beforeEach(async ({ page }) => {
	await page.goto("/");
	await page.addScriptTag({ type: "module", content: bundle });
	await page.addScriptTag({ content: MAKE });
	await page.waitForFunction(() => "__images" in window);
});

test("a small image is attached exactly as it was", async ({ page }) => {
	const r = await page.evaluate(async () => {
		const file = await __make.png(200, 100, false);
		const out = await __images.prepareImage(file, 0);
		const original = btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer())));
		return { out, same: "data" in out && out.data === original, size: file.size };
	});
	expect(r.same).toBe(true);
	expect(r.out).toMatchObject({ name: "200x100.png", mimeType: "image/png", resized: false, bytes: r.size });
});

test("an image wider than 2560 px is scaled down and re-encoded as JPEG", async ({ page }) => {
	const r = await page.evaluate(async () => {
		const out = await __images.prepareImage(await __make.png(3000, 1500, false), 0);
		if ("reason" in out) return { out };
		return { out: { ...out, data: "" }, dims: await __make.size(out) };
	});
	expect(r.out).toMatchObject({ resized: true, mimeType: "image/jpeg" });
	expect(r.dims).toEqual({ width: 2560, height: 1280 });
});

test("an image over 4 MB is re-encoded smaller even when its pixels already fit", async ({ page }) => {
	const r = await page.evaluate(async () => {
		const file = await __make.png(1800, 1800, true);
		const out = await __images.prepareImage(file, 0);
		return {
			before: file.size,
			refused: "reason" in out,
			resized: "resized" in out && out.resized,
			mimeType: "mimeType" in out ? out.mimeType : "",
			bytes: "bytes" in out ? out.bytes : -1,
		};
	});
	expect(r.before).toBeGreaterThan(4 * MB);
	expect(r).toMatchObject({ refused: false, resized: true, mimeType: "image/jpeg" });
	expect(r.bytes).toBeLessThanOrEqual(4 * MB);
});

test("an undecodable image over 8 MB is refused; over 64 MB it is refused without decoding", async ({ page }) => {
	const r = await page.evaluate(async () => ({
		big: await __images.prepareImage(__make.bytes(9 * 1024 * 1024, "image/png", "big.png"), 0),
		huge: await __images.prepareImage(__make.bytes(65 * 1024 * 1024, "image/png", "huge.png"), 0),
	}));
	expect(r.big).toEqual({ reason: "tooLarge", name: "big.png", bytes: 9 * MB, limit: 8 * MB });
	expect(r.huge).toEqual({ reason: "tooLarge", name: "huge.png", bytes: 65 * MB, limit: 8 * MB });
});

test("a small file the browser cannot decode is still attached as it is", async ({ page }) => {
	const out = await page.evaluate(() => __images.prepareImage(__make.bytes(1000, "image/heic", "photo.heic"), 0));
	expect(out).toMatchObject({ name: "photo.heic", mimeType: "image/heic", resized: false, bytes: 1000 });
});

test("a message's images are held to the total, counting what is already attached", async ({ page }) => {
	const r = await page.evaluate(async () => {
		const png = (n: number) => __make.bytes(7 * 1024 * 1024, "image/png", `img${n}.png`);
		const files = [__make.bytes(10, "text/plain", "notes.txt"), png(1), png(2), png(3)];
		const batch = await __images.prepareImages(files, 0);
		const second = await __images.prepareImages([png(4)], 14 * 1024 * 1024);
		return {
			accepted: batch.images.map((i) => i.name),
			refused: batch.refused,
			alreadyAttached: second.refused,
		};
	});
	// Seven MB each: two fit under the 20 MB total, the third would make 21; the text file is skipped silently.
	expect(r.accepted).toEqual(["img1.png", "img2.png"]);
	expect(r.refused).toEqual([{ reason: "totalTooLarge", name: "img3.png", total: 21 * MB, limit: 20 * MB }]);
	expect(r.alreadyAttached).toEqual([{ reason: "totalTooLarge", name: "img4.png", total: 21 * MB, limit: 20 * MB }]);
});
