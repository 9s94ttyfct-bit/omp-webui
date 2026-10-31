/**
 * The little of PNG the icon script needs (`scripts/icons.ts`), with nothing but node:zlib: read an 8-bit RGB or RGBA
 * image, resample it, write it back. Pure arithmetic on doubles, so the same master gives the same pixels on every
 * machine; the compressed bytes may differ with the zlib a runtime ships, the pixels do not.
 */
import { deflateSync, inflateSync } from "node:zlib";

/** Pixels as straight (not premultiplied) RGBA, 4 bytes each, row by row. */
export interface Rgba {
	width: number;
	height: number;
	data: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Decode an 8-bit, non-interlaced RGB (colour type 2) or RGBA (6) PNG; anything else is refused. */
export function decodePng(png: Uint8Array): Rgba {
	const buf = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
	if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
	let width = 0;
	let height = 0;
	let channels = 0;
	const idat: Buffer[] = [];
	for (let at = 8; at < buf.length; ) {
		const length = buf.readUInt32BE(at);
		const type = buf.toString("latin1", at + 4, at + 8);
		const data = buf.subarray(at + 8, at + 8 + length);
		if (type === "IHDR") {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			const [depth, colour, , , interlace] = data.subarray(8, 13);
			if (depth !== 8 || (colour !== 2 && colour !== 6) || interlace !== 0)
				throw new Error(`only 8-bit non-interlaced RGB or RGBA PNGs are read (depth ${depth}, colour type ${colour})`);
			channels = colour === 6 ? 4 : 3;
		} else if (type === "IDAT") idat.push(data);
		else if (type === "IEND") break;
		at += 12 + length;
	}
	if (!channels) throw new Error("PNG without IHDR");
	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * channels;
	const rows = new Uint8Array(stride * height);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)];
		const src = y * (stride + 1) + 1;
		const row = y * stride;
		for (let x = 0; x < stride; x++) {
			const a = x >= channels ? rows[row + x - channels] : 0;
			const b = y > 0 ? rows[row - stride + x] : 0;
			const c = x >= channels && y > 0 ? rows[row - stride + x - channels] : 0;
			rows[row + x] = (raw[src + x] + predict(filter, a, b, c)) & 0xff;
		}
	}
	if (channels === 4) return { width, height, data: rows };
	const data = new Uint8Array(width * height * 4);
	for (let i = 0, j = 0; i < rows.length; i += 3, j += 4) {
		data[j] = rows[i];
		data[j + 1] = rows[i + 1];
		data[j + 2] = rows[i + 2];
		data[j + 3] = 255;
	}
	return { width, height, data };
}

/** What a PNG filter adds back to a byte: `a` left of it, `b` above, `c` above left. */
function predict(filter: number, a: number, b: number, c: number): number {
	switch (filter) {
		case 0:
			return 0;
		case 1:
			return a;
		case 2:
			return b;
		case 3:
			return (a + b) >> 1;
		case 4: {
			const p = a + b - c;
			const pa = Math.abs(p - a);
			const pb = Math.abs(p - b);
			const pc = Math.abs(p - c);
			return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
		}
		default:
			throw new Error(`unknown PNG filter ${filter}`);
	}
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

function chunk(type: string, data: Uint8Array): Buffer {
	const out = Buffer.alloc(12 + data.length);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, "latin1");
	out.set(data, 8);
	let crc = 0xffffffff;
	for (let i = 4; i < 8 + data.length; i++) crc = CRC_TABLE[(crc ^ out[i]) & 0xff] ^ (crc >>> 8);
	out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
	return out;
}

/**
 * Encode as an 8-bit PNG: RGBA, or RGB when `opaque` (every alpha must then be 255). Each row takes the filter whose
 * output has the smallest sum of absolute values (the usual heuristic), and zlib compresses at level 9.
 */
export function encodePng(img: Rgba, { opaque = false } = {}): Buffer {
	const channels = opaque ? 3 : 4;
	const stride = img.width * channels;
	const rows = new Uint8Array(stride * img.height);
	for (let i = 0, j = 0; i < img.data.length; i += 4, j += channels) {
		if (opaque && img.data[i + 3] !== 255) throw new Error("an opaque PNG was asked for, but a pixel is not opaque");
		for (let k = 0; k < channels; k++) rows[j + k] = img.data[i + k];
	}
	const raw = new Uint8Array((stride + 1) * img.height);
	const candidate = new Uint8Array(stride);
	for (let y = 0; y < img.height; y++) {
		const row = y * stride;
		let best = Number.POSITIVE_INFINITY;
		for (let filter = 0; filter <= 4; filter++) {
			let cost = 0;
			for (let x = 0; x < stride; x++) {
				const a = x >= channels ? rows[row + x - channels] : 0;
				const b = y > 0 ? rows[row - stride + x] : 0;
				const c = x >= channels && y > 0 ? rows[row - stride + x - channels] : 0;
				const v = (rows[row + x] - predict(filter, a, b, c)) & 0xff;
				candidate[x] = v;
				cost += v < 128 ? v : 256 - v;
			}
			if (cost < best) {
				best = cost;
				raw[y * (stride + 1)] = filter;
				raw.set(candidate, y * (stride + 1) + 1);
			}
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(img.width, 0);
	ihdr.writeUInt32BE(img.height, 4);
	ihdr.set([8, opaque ? 2 : 6, 0, 0, 0], 8);
	return Buffer.concat([
		SIGNATURE,
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 9 })),
		chunk("IEND", new Uint8Array()),
	]);
}

/** Catmull-Rom: a cubic (no transcendental functions, so the same doubles everywhere), sharp without much ringing. */
function cubic(x: number): number {
	const t = Math.abs(x);
	if (t < 1) return 1.5 * t * t * t - 2.5 * t * t + 1;
	if (t < 2) return -0.5 * t * t * t + 2.5 * t * t - 4 * t + 2;
	return 0;
}

/**
 * For each of `to` output pixels along one axis of `length` source pixels: the first source pixel it reads and the
 * weights of the ones from there. The weights sum to 1 over the kernel's whole width; the part of it past the source's
 * edges is transparent and left out.
 */
function contributions(
	to: number,
	scale: number,
	offset: number,
	length: number,
): { first: number; weights: Float64Array }[] {
	// Shrinking widens the kernel by the factor, so every source pixel counts (an area average, filtered); enlarging keeps it.
	const stretch = Math.max(1, 1 / scale);
	const support = 2 * stretch;
	return Array.from({ length: to }, (_, i) => {
		const centre = (i + 0.5) / scale + offset - 0.5;
		const lo = Math.ceil(centre - support);
		const hi = Math.floor(centre + support);
		let sum = 0;
		for (let j = lo; j <= hi; j++) sum += cubic((j - centre) / stretch);
		const first = Math.max(0, lo);
		const weights = new Float64Array(Math.max(0, Math.min(length - 1, hi) - first + 1));
		for (let k = 0; k < weights.length; k++) weights[k] = cubic((first + k - centre) / stretch) / sum;
		return { first, weights };
	});
}

/**
 * The square `[x, y, x + size, y + size)` of `src` (it may reach past its edges: what is outside is transparent) scaled
 * to `out` × `out`. Filtered in premultiplied alpha, so a transparent pixel's colour does not bleed into the edge.
 */
export function resample(src: Rgba, crop: { x: number; y: number; size: number }, out: number): Rgba {
	const scale = out / crop.size;
	const pre = new Float64Array(src.width * src.height * 4);
	for (let i = 0; i < src.data.length; i += 4) {
		const a = src.data[i + 3] / 255;
		pre[i] = src.data[i] * a;
		pre[i + 1] = src.data[i + 1] * a;
		pre[i + 2] = src.data[i + 2] * a;
		pre[i + 3] = src.data[i + 3];
	}
	// Horizontal pass: src rows → `out` columns.
	const cols = contributions(out, scale, crop.x, src.width);
	const mid = new Float64Array(out * src.height * 4);
	for (let y = 0; y < src.height; y++) {
		for (let x = 0; x < out; x++) {
			const { first, weights } = cols[x];
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			for (let k = 0; k < weights.length; k++) {
				const p = (y * src.width + first + k) * 4;
				const w = weights[k];
				r += pre[p] * w;
				g += pre[p + 1] * w;
				b += pre[p + 2] * w;
				a += pre[p + 3] * w;
			}
			const q = (y * out + x) * 4;
			mid[q] = r;
			mid[q + 1] = g;
			mid[q + 2] = b;
			mid[q + 3] = a;
		}
	}
	// Vertical pass, then back to straight alpha.
	const rows = contributions(out, scale, crop.y, src.height);
	const data = new Uint8Array(out * out * 4);
	for (let y = 0; y < out; y++) {
		const { first, weights } = rows[y];
		for (let x = 0; x < out; x++) {
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			for (let k = 0; k < weights.length; k++) {
				const p = ((first + k) * out + x) * 4;
				const w = weights[k];
				r += mid[p] * w;
				g += mid[p + 1] * w;
				b += mid[p + 2] * w;
				a += mid[p + 3] * w;
			}
			const q = (y * out + x) * 4;
			const alpha = Math.min(255, Math.max(0, Math.round(a)));
			if (alpha === 0) continue;
			const unpremultiply = 255 / a;
			data[q] = Math.min(255, Math.max(0, Math.round(r * unpremultiply)));
			data[q + 1] = Math.min(255, Math.max(0, Math.round(g * unpremultiply)));
			data[q + 2] = Math.min(255, Math.max(0, Math.round(b * unpremultiply)));
			data[q + 3] = alpha;
		}
	}
	return { width: out, height: out, data };
}
