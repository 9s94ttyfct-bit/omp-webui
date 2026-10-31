/**
 * Renders every icon the repo ships from the one master, `macos/icon.png` (1024 px: the shape on Apple's 824 px grid,
 * a dark plate with a vertical gradient, transparent around it). There is no vector source: the master is the source.
 *
 *   bun scripts/icons.ts           write web/public/*.png from the master
 *   bun scripts/icons.ts --check   exit 1 when a committed icon is not what the master renders to
 *
 * The macOS app's iconset (`scripts/app.ts`) is rendered by `renderIcon` too, at build time. Pure arithmetic on the
 * master's pixels (`scripts/lib/png.ts`), no image tool: the same pixels on every machine.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodePng, encodePng, type Rgba, resample } from "./lib/png.ts";

const root = join(import.meta.dir, "..");
export const MASTER = join(root, "macos", "icon.png");

/**
 * - `plate`: the master as it is (the plate and its transparent margin), scaled.
 * - `full-bleed`: opaque, the plate's gradient carried out to the edges and the art scaled up into the middle; for a
 *   maskable icon (the art inside the safe zone, a circle of 40 % of the width) and an Apple touch icon (iOS rounds
 *   the corners itself, and fills what is transparent with black).
 * - `cut-out`: the art without the plate, on transparency (the favicon and the sidebar's logo).
 */
export type IconKind = "plate" | "full-bleed" | "cut-out";

export interface IconSpec {
	/** Under `web/public`. */
	file: string;
	size: number;
	kind: IconKind;
}

export const WEB_ICONS: readonly IconSpec[] = [
	{ file: "favicon.png", size: 128, kind: "cut-out" },
	{ file: "apple-touch-icon.png", size: 180, kind: "full-bleed" },
	{ file: "icon-192.png", size: 192, kind: "plate" },
	{ file: "icon-512.png", size: 512, kind: "plate" },
	{ file: "icon-maskable-512.png", size: 512, kind: "full-bleed" },
];

/**
 * The master's pixels the full-bleed icons are made of: a centred square of this side. The art's farthest pixel is
 * 361 px from the centre: 39 % of this, inside a maskable icon's safe zone (a circle of 40 % of the width).
 */
const FULL_BLEED_CROP = 920;
/** The master's pixels the cut-out is made of: a centred square just wider than the art (721 px). */
const CUT_OUT_CROP = 736;
/**
 * The cut-out's matte: a pixel as far from the plate as `KEY_SOLID` (the largest difference in a channel, 0–255) is
 * art, one within `KEY_CLEAR` is plate, and between the two it is partly both (an edge, a glow).
 */
const KEY_CLEAR = 1.5;
const KEY_SOLID = 8;
/**
 * Plate-coloured spots inside the art smaller than this (in master pixels) are art: the terminal's title bar is about
 * the plate's grey. The gaps between the ribbon and the terminal, which are the plate, are 1 220 px and larger.
 */
const MAX_SPOT_PX = 800;

/** The master and the colour of its plate at each row: a vertical gradient, read from its top and bottom edges. */
export interface Master {
	image: Rgba;
	plateAt(y: number): [number, number, number];
}

/** The master, checked: 1024 px, a transparent corner (an opaque one would show as a frame in the Dock), a plate whose sides are its gradient. */
export function readMaster(png: Uint8Array = readFileSync(MASTER)): Master {
	const image = decodePng(png);
	if (image.width !== 1024 || image.height !== 1024) throw new Error("macos/icon.png is not 1024×1024");
	if (image.data[3] !== 0) throw new Error("macos/icon.png has an opaque corner: it would show a frame");
	const px = (x: number, y: number) => image.data.subarray((y * 1024 + x) * 4, (y * 1024 + x) * 4 + 4);
	// The plate's top and bottom rows, in the middle column (the art does not reach the edges of the plate).
	let top = 0;
	while (top < 1024 && px(512, top)[3] !== 255) top++;
	let bottom = 1023;
	while (bottom > top && px(512, bottom)[3] !== 255) bottom--;
	const from = px(512, top);
	const to = px(512, bottom);
	const plateAt = (y: number): [number, number, number] => {
		const t = Math.min(1, Math.max(0, (y - top) / (bottom - top)));
		return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t];
	};
	// The full-bleed and cut-out icons are made from that model of the plate: it has to be the plate.
	const left = top + 2;
	for (let y = 384; y < 640; y++) {
		const c = px(left, y);
		const p = plateAt(y);
		if (c[3] !== 255 || [0, 1, 2].some((k) => Math.abs(c[k] - p[k]) > 2))
			throw new Error(
				`macos/icon.png: the plate at (${left}, ${y}) is not the vertical gradient of its top and bottom edges: the full-bleed and cut-out icons cannot be derived from it`,
			);
	}
	return { image, plateAt };
}

/** The master over its plate carried out to every edge: opaque. */
function overPlate({ image, plateAt }: Master): Rgba {
	const data = new Uint8Array(image.data.length);
	for (let y = 0; y < image.height; y++) {
		const p = plateAt(y);
		for (let x = 0; x < image.width; x++) {
			const i = (y * image.width + x) * 4;
			const a = image.data[i + 3] / 255;
			for (let k = 0; k < 3; k++) data[i + k] = Math.round(image.data[i + k] * a + Math.round(p[k]) * (1 - a));
			data[i + 3] = 255;
		}
	}
	return { width: image.width, height: image.height, data };
}

/**
 * The art without the plate: what is the plate's colour is transparent, an edge partly so (its colour taken out of
 * the plate's), and a small plate-coloured spot inside the art (`MAX_SPOT_PX`) stays art.
 */
function cutOut(master: Master): Rgba {
	const opaque = overPlate(master);
	const { width, height } = opaque;
	const alpha = new Float64Array(width * height);
	for (let y = 0; y < height; y++) {
		const p = master.plateAt(y);
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4;
			const d = Math.max(...[0, 1, 2].map((k) => Math.abs(opaque.data[i + k] - p[k])));
			alpha[y * width + x] = Math.min(1, Math.max(0, (d - KEY_CLEAR) / (KEY_SOLID - KEY_CLEAR)));
		}
	}
	// The regions of pixels that are not wholly art (4-connected): a small one that does not touch the edge is art.
	const seen = new Uint8Array(width * height);
	for (let start = 0; start < alpha.length; start++) {
		if (seen[start] || alpha[start] === 1) continue;
		const region = [start];
		seen[start] = 1;
		let edge = false;
		for (let n = 0; n < region.length; n++) {
			const at = region[n];
			const x = at % width;
			const y = (at - x) / width;
			if (x === 0 || y === 0 || x === width - 1 || y === height - 1) edge = true;
			for (const next of [x > 0 ? at - 1 : -1, x < width - 1 ? at + 1 : -1, at - width, at + width]) {
				if (next < 0 || next >= alpha.length || seen[next] || alpha[next] === 1) continue;
				seen[next] = 1;
				region.push(next);
			}
		}
		if (!edge && region.length < MAX_SPOT_PX) for (const at of region) alpha[at] = 1;
	}
	const data = new Uint8Array(opaque.data.length);
	for (let y = 0; y < height; y++) {
		const p = master.plateAt(y);
		for (let x = 0; x < width; x++) {
			const a = alpha[y * width + x];
			if (a === 0) continue;
			const i = (y * width + x) * 4;
			for (let k = 0; k < 3; k++)
				data[i + k] = Math.min(255, Math.max(0, Math.round(p[k] + (opaque.data[i + k] - p[k]) / a)));
			data[i + 3] = Math.round(a * 255);
		}
	}
	return { width, height, data };
}

const centred = (size: number) => ({ x: (1024 - size) / 2, y: (1024 - size) / 2, size });

/** One icon of `size` px of `kind`, from the master read by `readMaster`. */
export function renderIcon(master: Master, size: number, kind: IconKind): Rgba {
	if (kind === "plate") return resample(master.image, centred(1024), size);
	if (kind === "full-bleed") return resample(overPlate(master), centred(FULL_BLEED_CROP), size);
	return resample(cutOut(master), centred(CUT_OUT_CROP), size);
}

/** Every web icon, encoded: RGB for the opaque ones (a full-bleed icon has no transparency to keep), RGBA for the rest. */
export function renderWebIcons(master = readMaster()): { spec: IconSpec; image: Rgba; png: Buffer }[] {
	return WEB_ICONS.map((spec) => {
		const image = renderIcon(master, spec.size, spec.kind);
		return { spec, image, png: encodePng(image, { opaque: spec.kind === "full-bleed" }) };
	});
}

if (import.meta.main) {
	const check = process.argv.includes("--check");
	let stale = 0;
	for (const { spec, image, png } of renderWebIcons()) {
		const file = join(root, "web", "public", spec.file);
		if (!check) {
			writeFileSync(file, png);
			console.log(`wrote web/public/${spec.file} (${spec.size} px, ${spec.kind}, ${png.length} bytes)`);
			continue;
		}
		const committed = decodePng(readFileSync(file));
		const same =
			committed.width === image.width &&
			committed.height === image.height &&
			Buffer.from(committed.data).equals(image.data);
		if (!same) stale++;
		console.log(`${same ? "ok" : "STALE"} web/public/${spec.file}`);
	}
	if (stale) {
		console.error(`${stale} icon(s) are not what macos/icon.png renders to: run \`bun scripts/icons.ts\`.`);
		process.exit(1);
	}
}
