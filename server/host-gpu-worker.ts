import { type GpuProbe, openGpuProbe } from "./host-gpu.ts";
import type { GpuReply, GpuRequest } from "./host-gpu-protocol.ts";

/**
 * The thread that looks at the GPU (#613). IOKit is called synchronously: a driver that does not come back would hold the
 * thread it was called on for good, and on the server's own thread that is every conversation. Here it holds this one,
 * which the server gives up on after a deadline and stops (`host-gpu-guard.ts`).
 *
 * The probe is opened on the first request, here, so that nothing of `bun:ffi` is loaded by the server itself. The compiled
 * app has this file as an entry point of its own (scripts/app.ts), reached by a relative URL as the family and the search
 * workers are.
 */

let probe: GpuProbe | null | undefined;

self.onmessage = (event: MessageEvent<GpuRequest>) => {
	const { id } = event.data;
	let reply: GpuReply;
	try {
		probe ??= openGpuProbe();
		reply = { id, ok: true, gpus: probe === null ? null : probe.read() };
	} catch (e) {
		reply = { id, ok: false, error: (e as Error).message ?? String(e) };
	}
	self.postMessage(reply);
};
