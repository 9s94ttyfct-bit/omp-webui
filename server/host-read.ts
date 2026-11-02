import { cpus, totalmem } from "node:os";
import type { Pressure } from "../shared/host.ts";
import type { GpuReading } from "./host-gpu.ts";
import { failureLog, type GpuOptions, guardedGpu } from "./host-gpu-guard.ts";
import { type CpuTimes, type PsRow, sumCpuTimes } from "./host-parse.ts";
import { type Platform, platform as system } from "./platform/index.ts";
import type { HostMemory } from "./platform/types.ts";

/** What one look at the computer reads. A part the platform has no figure for, or that failed this time, is null. */
export interface Reading {
	cpu: CpuTimes;
	/** Bytes in use, and all of it; null when the figure could not be read. */
	memUsed: number | null;
	memTotal: number;
	pressure: Pressure | null;
	/** Every accelerator that reports a utilisation; null when this platform has none to ask or the read failed. */
	gpus: GpuReading[] | null;
	/** The whole computer's power draw in watts (macOS: the SMC's `PSTR`); null where it has none or the read failed. */
	power: number | null;
}

/** Where the sampler gets its figures: the computer's own (`systemReader`), or a stand-in for a test. */
export interface HostReader {
	readonly platform: string;
	read(): Promise<Reading>;
	/** A listing of every process on the computer (`ps`); rejects when it cannot be had. */
	processes(): Promise<PsRow[]>;
	/** Stop what the reader started (the GPU's thread). */
	close?(): void;
}

const { failed, recovered } = failureLog();

export interface SystemReaderOptions {
	platform?: Platform;
	gpu?: GpuOptions;
}

/**
 * The computer this server runs on. CPU time is Node's `os.cpus()` everywhere; memory is the platform's (`HostOps.memory`:
 * macOS asks `sysctl` for memory and its pressure, a process that costs a millisecond of CPU; Linux reads `/proc/meminfo`;
 * Windows has `os`'s figure), and the GPU's utilisation is IOKit's where the platform has it (`capabilities.gpuLoad`:
 * `host-gpu.ts`, no process at all, in a thread of its own: `host-gpu-guard.ts`). None of it needs privileges.
 */
export function systemReader(options: SystemReaderOptions = {}): HostReader {
	const platform = options.platform ?? system;
	const gpu = platform.capabilities.gpuLoad ? guardedGpu(options.gpu) : null;
	return {
		platform: platform.id,
		close: () => gpu?.close(),
		processes: platform.host.processes,
		async read() {
			const cpu = sumCpuTimes(cpus());
			let memory: HostMemory = { used: null, total: totalmem(), pressure: null };
			try {
				memory = await platform.host.memory();
				recovered(platform.host.memorySource);
			} catch (e) {
				failed(platform.host.memorySource, e);
			}
			const gpus = (await gpu?.read()) ?? null;
			const power = gpu?.power() ?? null;
			return { cpu, memUsed: memory.used, memTotal: memory.total, pressure: memory.pressure, gpus, power };
		},
	};
}
