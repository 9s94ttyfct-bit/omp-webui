import { heapStats } from "bun:jsc";
import { memberPieces, rememberIds } from "../../server/family-document.ts";

/**
 * What a worker thread (the family worker is one) still holds of a conversation's text after it has read its entries, as
 * `tests/unit/family-document.test.ts` asks it: the text is read, scanned the two ways the family worker scans it, and
 * dropped; then, three times, the thread takes a turn of its event loop, collects, and says how much external memory
 * (a file's text is one string of it) it holds above what it held before.
 *
 * With `holdIds` the ids `rememberIds` read stay in a set that is still held while the thread is measured, as the ids of
 * a file the client holds are until the family's body is built.
 */

declare const self: Worker;

self.onmessage = async (event: MessageEvent<{ file: string; holdIds: boolean }>) => {
	const { file, holdIds } = event.data;
	const ids = new Set<string>();
	const scan = async () => {
		const text = await Bun.file(file).text();
		rememberIds(text, holdIds ? ids : new Set());
		let length = 0;
		for (const piece of memberPieces(file, text, new Set(), { file, tag: "t", subagents: [], advisors: [] }, "t"))
			length += piece.length;
		return length;
	};
	Bun.gc(true);
	const before = heapStats().extraMemorySize;
	await scan();
	const held: number[] = [];
	for (let turn = 0; turn < 3; turn++) {
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		Bun.gc(true);
		held.push(heapStats().extraMemorySize - before);
	}
	self.postMessage({ held, ids: ids.size });
};
