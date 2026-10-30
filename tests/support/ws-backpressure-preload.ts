/**
 * Preloaded into the server by the long-run harness (`--ws-limit`): Bun drops a message `ws.send` is given while the
 * socket already holds `backpressureLimit` bytes (16 MiB by default), so one big reply (the whole of a long session)
 * makes the server lose every reply and frame behind it. With a limit above any message, what is left to measure is the
 * page: the harness can then look at the client's own cost on a conversation as long as a real one.
 */
const serve = Bun.serve.bind(Bun);
// biome-ignore lint/suspicious/noExplicitAny: the options of whatever the server passes on, unchanged except for one field
(Bun as any).serve = (options: any) =>
	serve({
		...options,
		websocket: { ...options.websocket, backpressureLimit: 1 << 30, closeOnBackpressureLimit: false },
	});
