import type { GpuReading } from "./host-gpu.ts";

/**
 * What the server and the thread that looks at the GPU say to each other (`host-gpu-guard.ts`, `host-gpu-worker.ts`). Types
 * only: the server imports no code of the probe (nor `bun:ffi`), which is the worker's.
 */

/** A look at the accelerators is wanted. */
export interface GpuRequest {
	id: number;
}

export type GpuReply =
	/** The look: every accelerator that reports a utilisation (possibly none), or null when there is no probe on this computer. */
	| { id: number; ok: true; gpus: GpuReading[] | null }
	/** The probe threw: the thread is there and says so (a native fault is no exception, and says nothing). */
	| { id: number; ok: false; error: string };
