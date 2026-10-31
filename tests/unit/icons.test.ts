import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderWebIcons, WEB_ICONS } from "../../scripts/icons.ts";
import { decodePng, encodePng, type Rgba, resample } from "../../scripts/lib/png.ts";

/**
 * Every icon the web UI ships is rendered from the one master, `macos/icon.png`, by `scripts/icons.ts` (#14): a new
 * master, or a change to how a size is made, shows here until the icons are rendered again.
 */

const PUBLIC = join(import.meta.dir, "..", "..", "web", "public");
const rendered = renderWebIcons();
const committed = (file: string) => decodePng(readFileSync(join(PUBLIC, file)));
const alphaAt = (img: Rgba, x: number, y: number) => img.data[(y * img.width + x) * 4 + 3];

describe("the web icons", () => {
	test("each is what the master renders to, pixel for pixel (`bun scripts/icons.ts` writes them)", () => {
		for (const { spec, image } of rendered) {
			const png = committed(spec.file);
			expect([spec.file, png.width, png.height]).toEqual([spec.file, spec.size, spec.size]);
			expect(Buffer.from(png.data).equals(Buffer.from(image.data))).toBe(true);
		}
	});

	test("each has the transparency of its kind: the plate's corners clear, a full-bleed icon opaque, the cut-out clear around the art", () => {
		for (const spec of WEB_ICONS) {
			const png = committed(spec.file);
			const last = spec.size - 1;
			const corners = [alphaAt(png, 0, 0), alphaAt(png, last, 0), alphaAt(png, 0, last), alphaAt(png, last, last)];
			const centre = alphaAt(png, spec.size >> 1, spec.size >> 1);
			if (spec.kind === "full-bleed") {
				// Saved without an alpha channel: iOS would fill a transparent pixel with black.
				expect(readFileSync(join(PUBLIC, spec.file))[25]).toBe(2);
				expect(png.data.every((v, i) => i % 4 !== 3 || v === 255)).toBe(true);
			} else {
				expect(readFileSync(join(PUBLIC, spec.file))[25]).toBe(6);
				expect(corners).toEqual([0, 0, 0, 0]);
				expect(centre).toBe(255);
			}
		}
	});

	test("the maskable icon keeps its art inside the safe zone (a circle of 40 % of the width): outside it is the plate", () => {
		const png = committed("icon-maskable-512.png");
		let art = 0;
		for (let y = 0; y < 512; y++)
			for (let x = 0; x < 512; x++) {
				if (Math.hypot(x + 0.5 - 256, y + 0.5 - 256) <= 0.4 * 512) continue;
				const i = (y * 512 + x) * 4;
				// The plate is a dark grey (each channel under 50); the ribbon and its glow are bright blue.
				if (Math.max(png.data[i], png.data[i + 1], png.data[i + 2]) > 60) art++;
			}
		expect(art).toBe(0);
	});

	test("the manifest names the icons the script renders", () => {
		const manifest = JSON.parse(readFileSync(join(PUBLIC, "manifest.webmanifest"), "utf8")) as {
			icons: { src: string }[];
		};
		const files = new Set(WEB_ICONS.map((i) => i.file));
		for (const icon of manifest.icons) expect(files.has(icon.src.slice(1))).toBe(true);
	});
});

describe("png", () => {
	test("encode then decode gives the same pixels, with and without alpha", () => {
		const img: Rgba = { width: 3, height: 2, data: new Uint8Array(24) };
		for (let i = 0; i < img.data.length; i++) img.data[i] = (i * 37) % 256;
		expect(decodePng(encodePng(img)).data).toEqual(img.data);
		for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
		const rgb = encodePng(img, { opaque: true });
		expect(rgb[25]).toBe(2);
		expect(decodePng(rgb).data).toEqual(img.data);
		img.data[3] = 254;
		expect(() => encodePng(img, { opaque: true })).toThrow("not opaque");
	});

	test("resampling a flat colour keeps it, and a transparent pixel's colour does not bleed into its neighbours", () => {
		const img: Rgba = { width: 32, height: 32, data: new Uint8Array(32 * 32 * 4) };
		for (let i = 0; i < img.data.length; i += 4)
			img.data.set(i < img.data.length / 2 ? [200, 100, 50, 255] : [255, 255, 255, 0], i);
		const out = resample(img, { x: 0, y: 0, size: 32 }, 16);
		const at = (x: number, y: number) => Array.from(out.data.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4));
		// Inside the top half: the colour itself, opaque; inside the bottom: transparent. Where the kernel reaches past the
		// image's edge or across the line between the halves: the same colour, partly clear (premultiplied, it is not paled).
		expect(at(8, 3)).toEqual([200, 100, 50, 255]);
		expect(at(8, 12)[3]).toBe(0);
		expect(at(8, 0)[3]).toBeLessThan(255);
		expect(at(8, 8)[3]).toBeGreaterThan(0);
		for (let i = 0; i < out.data.length; i += 4)
			if (out.data[i + 3] > 0) expect(Array.from(out.data.subarray(i, i + 3))).toEqual([200, 100, 50]);
	});

	test("refuses what it does not read", () => {
		expect(() => decodePng(new Uint8Array(16))).toThrow("not a PNG");
	});
});
