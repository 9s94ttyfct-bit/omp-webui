import type { Job, Reply } from "../../server/search-index.ts";

/** A search index worker that answers a `flush` only after `PROGRESS_FOR_MS` of reporting progress every 100 ms. */
const PROGRESS_FOR_MS = 2000;
const coverage = { indexed: 1, total: 2 };
self.onmessage = (event: MessageEvent<Job>) => {
	const job = event.data;
	if (job.t !== "flush") return;
	const started = Date.now();
	const tick = setInterval(() => {
		if (Date.now() - started < PROGRESS_FOR_MS) {
			self.postMessage({ t: "progress", coverage } satisfies Reply);
			return;
		}
		clearInterval(tick);
		self.postMessage({
			t: "flushed",
			id: job.id,
			coverage: { indexed: 2, total: 2 },
			stats: { rows: 0, resets: 0, compactions: 0 },
		} satisfies Reply);
	}, 100);
};
