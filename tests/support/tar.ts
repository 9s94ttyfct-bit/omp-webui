/**
 * A tar made by hand, entry by entry, for what a sender that is not omp-webui's own could send to `remote_copy`'s unpacker
 * (`server/remote-run/tar.ts`): names with `..`, links that lead out, hard links, devices. ustar headers, no pax.
 */
export interface CraftedEntry {
	name: string;
	/** The ustar type: `0` a file (the default), `1` a hard link, `2` a link, `3` a device, `5` a folder. */
	type?: string;
	body?: string;
	link?: string;
}

export function craftTar(entries: readonly CraftedEntry[]): Uint8Array<ArrayBuffer> {
	const blocks: Uint8Array[] = [];
	const enc = new TextEncoder();
	for (const e of entries) {
		const body = enc.encode(e.body ?? "");
		const h = new Uint8Array(512);
		const put = (at: number, text: string) => h.set(enc.encode(text), at);
		put(0, e.name);
		put(100, "0000644\0");
		put(108, "0000000\0");
		put(116, "0000000\0");
		put(124, `${body.length.toString(8).padStart(11, "0")}\0`);
		put(136, "00000000000\0");
		put(148, "        ");
		put(156, e.type ?? "0");
		put(157, e.link ?? "");
		put(257, "ustar\0");
		put(263, "00");
		let sum = 0;
		for (const b of h) sum += b;
		put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
		blocks.push(h, body, new Uint8Array((512 - (body.length % 512)) % 512));
	}
	blocks.push(new Uint8Array(1024));
	return new Uint8Array(Buffer.concat(blocks));
}
