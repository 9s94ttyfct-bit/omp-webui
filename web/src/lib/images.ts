import "../i18n/later.ts";
import type { MessageKey, Vars } from "../i18n/index.ts";

/**
 * Image attachments travel base64-encoded inside one WebSocket message, which the server caps at 32 MiB.
 * Big pictures are shrunk in the browser first; what still doesn't fit is refused with a reason the
 * user can act on, instead of an oversized message dropping the connection.
 */

const MB = 1024 * 1024;
/** The longest side, in pixels, an attachment keeps; larger images are scaled down to it. */
export const MAX_IMAGE_EDGE = 2560;
/** Images heavier than this are re-encoded even when their pixels already fit. */
export const REENCODE_ABOVE_BYTES = 4 * MB;
/** The most one image may weigh once processed. */
export const MAX_IMAGE_BYTES = 8 * MB;
/**
 * The most all of a message's images may weigh together. Base64 is 4/3 of the raw size, so 20 MiB of
 * images is about 26.7 MiB of the server's 32 MiB message limit, leaving room for the text and the JSON.
 */
export const MAX_TOTAL_IMAGE_BYTES = 20 * MB;
/** Files above this are refused undecoded: browsers can run out of memory decoding them. */
export const MAX_SOURCE_BYTES = 64 * MB;

export type ImageRefusal =
	/** One image is over the per-image limit (or too big to even try shrinking). */
	| { reason: "tooLarge"; name: string; bytes: number; limit: number }
	/** The message's images would together pass the total limit. */
	| { reason: "totalTooLarge"; name: string; total: number; limit: number };

export interface PreparedImage {
	name: string;
	mimeType: string;
	/** Base64, without a `data:` prefix. */
	data: string;
	/** Decoded size. */
	bytes: number;
	/** Scaled down or re-encoded because the original was too big as it was. */
	resized: boolean;
}

/** Decoded size of base64 text. */
export function base64Bytes(b64: string): number {
	const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
	return Math.floor((b64.length * 3) / 4) - padding;
}

/** What the composer's current attachments already weigh, to pass as `usedBytes` when adding more. */
export function attachedBytes(images: readonly { data: string }[]): number {
	return images.reduce((sum, img) => sum + base64Bytes(img.data), 0);
}

/** `width` × `height` scaled down, never up, so the longer side is at most `edge`. */
export function fitWithin(width: number, height: number, edge = MAX_IMAGE_EDGE): { width: number; height: number } {
	const scale = Math.min(1, edge / Math.max(width, height));
	return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Whether an image has to be re-encoded: too many pixels along a side, or too many bytes. */
export function needsResize(width: number, height: number, bytes: number): boolean {
	return Math.max(width, height) > MAX_IMAGE_EDGE || bytes > REENCODE_ABOVE_BYTES;
}

/** Whether an already-processed image of `bytes` may join attachments weighing `usedBytes`; null when it may. */
export function checkLimits(name: string, bytes: number, usedBytes: number): ImageRefusal | null {
	if (bytes > MAX_IMAGE_BYTES) return { reason: "tooLarge", name, bytes, limit: MAX_IMAGE_BYTES };
	if (usedBytes + bytes > MAX_TOTAL_IMAGE_BYTES) {
		return { reason: "totalTooLarge", name, total: usedBytes + bytes, limit: MAX_TOTAL_IMAGE_BYTES };
	}
	return null;
}

const mb = (bytes: number) => `${Number((bytes / MB).toFixed(1))} MB`;

/** The toast for a refusal: `toast("error", t(key, vars))`. */
export function refusalMessage(r: ImageRefusal): { key: MessageKey; vars: Vars } {
	return r.reason === "tooLarge"
		? { key: "chat.imageTooLarge", vars: { name: r.name, size: mb(r.bytes), limit: mb(r.limit) } }
		: { key: "chat.imagesTooLarge", vars: { name: r.name, total: mb(r.total), limit: mb(r.limit) } };
}

/** Each retry is smaller than the last; the first that comes in under REENCODE_ABOVE_BYTES wins. */
const ATTEMPTS = [
	{ scale: 1, quality: 0.9 },
	{ scale: 1, quality: 0.75 },
	{ scale: 0.75, quality: 0.75 },
	{ scale: 0.5, quality: 0.7 },
];

/**
 * Re-encode as JPEG at no more than MAX_IMAGE_EDGE. JPEG has no alpha, so transparent pixels are
 * flattened onto white first (they would come out black otherwise).
 */
async function shrink(bitmap: ImageBitmap): Promise<Blob | null> {
	const fit = fitWithin(bitmap.width, bitmap.height);
	const canvas = document.createElement("canvas");
	const ctx = canvas.getContext("2d");
	if (!ctx) return null;
	let out: Blob | null = null;
	for (const { scale, quality } of ATTEMPTS) {
		canvas.width = Math.max(1, Math.round(fit.width * scale));
		canvas.height = Math.max(1, Math.round(fit.height * scale));
		ctx.fillStyle = "#fff";
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		const encoded = Promise.withResolvers<Blob | null>();
		canvas.toBlob(encoded.resolve, "image/jpeg", quality);
		out = await encoded.promise;
		if (!out || out.size <= REENCODE_ABOVE_BYTES) break;
	}
	return out;
}

/** A blob's bytes as base64 without a `data:` prefix: what an image attachment holds. */
export async function toBase64(blob: Blob): Promise<string> {
	const read = Promise.withResolvers<string>();
	const reader = new FileReader();
	reader.onload = () => read.resolve(String(reader.result).replace(/^[^,]*,/, ""));
	reader.onerror = () => read.reject(reader.error);
	reader.readAsDataURL(blob);
	return read.promise;
}

/**
 * Turn a picked, pasted or dropped image file into an attachment: scaled down and re-encoded when its
 * pixels or its bytes are over the limits, passed through untouched otherwise. Resolves to the refusal
 * when the result still can't join the message (`usedBytes` is what its other images already weigh).
 * A file the browser can't decode is attached as it is when small enough, since omp's model may read it.
 */
export async function prepareImage(file: File, usedBytes: number): Promise<PreparedImage | ImageRefusal> {
	const name = file.name || "image";
	if (file.size > MAX_SOURCE_BYTES) return { reason: "tooLarge", name, bytes: file.size, limit: MAX_IMAGE_BYTES };
	let blob: Blob = file;
	let resized = false;
	const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => null);
	if (bitmap) {
		try {
			if (needsResize(bitmap.width, bitmap.height, file.size)) {
				const shrunk = await shrink(bitmap);
				if (shrunk) {
					blob = shrunk;
					resized = true;
				}
			}
		} finally {
			bitmap.close();
		}
	}
	const refusal = checkLimits(name, blob.size, usedBytes);
	if (refusal) return refusal;
	return { name, mimeType: blob.type || file.type, data: await toBase64(blob), bytes: blob.size, resized };
}

/** `prepareImage` for every image among `files`, in order, each counted against the ones accepted before it. */
export async function prepareImages(
	files: Iterable<File>,
	usedBytes: number,
): Promise<{ images: PreparedImage[]; refused: ImageRefusal[] }> {
	const images: PreparedImage[] = [];
	const refused: ImageRefusal[] = [];
	let used = usedBytes;
	for (const file of files) {
		if (!file.type.startsWith("image/")) continue;
		const result = await prepareImage(file, used);
		if ("reason" in result) {
			refused.push(result);
		} else {
			images.push(result);
			used += result.bytes;
		}
	}
	return { images, refused };
}
