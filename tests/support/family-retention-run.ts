/**
 * `bun tests/support/family-retention-run.ts <file> <holdIds: 1|0>`: runs `family-retention-worker.ts` on `<file>` in a
 * worker thread of this process, as the family worker is one, and prints what it measured as JSON.
 *
 * `tests/unit/family-document.test.ts` starts it with JavaScriptCore's concurrent JIT off (`BUN_JSC_useConcurrentJIT=0`),
 * which is a setting of the whole process: a compile still queued on a background thread keeps the scanning generator, and
 * through it the file's text, alive for a while after the scan, and on a loaded machine that was still the case when the
 * worker measured (#12: 4 failures in 1152 checks under 12 parallel copies, 0 in 1152 with the JIT compiling on the thread
 * that asks). That memory is let go once the compile has run; what the test is for is what is held for good.
 */
const [file, hold] = process.argv.slice(2);
const worker = new Worker(new URL("./family-retention-worker.ts", import.meta.url));
const reply = Promise.withResolvers<unknown>();
worker.onmessage = (event: MessageEvent) => reply.resolve(event.data);
worker.onerror = (event) => reply.reject(new Error(event.message));
worker.postMessage({ file, holdIds: hold === "1" });
try {
	console.log(JSON.stringify(await reply.promise));
} finally {
	worker.terminate();
}
