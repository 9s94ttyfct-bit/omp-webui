/**
 * A Windows icon file (`.ico`) of PNG images, one per size (Windows Vista and later read PNG entries of every size).
 * Layout: a 6-byte header, a 16-byte directory entry per image, then the images.
 */
export function encodeIco(images: readonly { size: number; png: Uint8Array }[]): Buffer {
	const header = Buffer.alloc(6 + 16 * images.length);
	header.writeUInt16LE(0, 0); // reserved
	header.writeUInt16LE(1, 2); // 1: an icon
	header.writeUInt16LE(images.length, 4);
	let offset = header.length;
	images.forEach(({ size, png }, i) => {
		if (size < 1 || size > 256) throw new Error(`An icon image is 1 to 256 px, not ${size}`);
		const entry = 6 + 16 * i;
		// 256 is written as 0: the field is a byte.
		header.writeUInt8(size === 256 ? 0 : size, entry);
		header.writeUInt8(size === 256 ? 0 : size, entry + 1);
		header.writeUInt8(0, entry + 2); // no palette
		header.writeUInt8(0, entry + 3); // reserved
		header.writeUInt16LE(1, entry + 4); // colour planes
		header.writeUInt16LE(32, entry + 6); // bits per pixel
		header.writeUInt32LE(png.length, entry + 8);
		header.writeUInt32LE(offset, entry + 12);
		offset += png.length;
	});
	return Buffer.concat([header, ...images.map((i) => Buffer.from(i.png))]);
}
