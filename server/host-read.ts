import { cpus, freemem, totalmem } from "node:os";
import type { Pressure } from "../shared/host.ts";
import type { GpuReading } from "./host-gpu.ts";
import { failureLog, type GpuOptions, guardedGpu } from "./host-gpu-guard.ts";
import {
	type CpuTimes,
	MAC_SYSCTL,
	type Meminfo,
	memoryUsedMac,
	type PsRow,
	parseMeminfo,
	parsePs,
	parseSysctl,
	pressureOf,
	sumCpuTimes,
} from "./host-parse.ts";
import { run } from "./omp/run.ts";

/** What one look at the computer reads. A part the platform has no figure for, or that failed this time, is null. */
export interface Reading {
	cpu: CpuTimes;
	/** Bytes in use, and all of it; null when the figure could not be read. */
	memUsed: number | null;
	memTotal: number;
	pressure: Pressure | null;
	/** Every accelerator that reports a utilisation; null when this platform has none to ask or the read failed. */
	gpus: GpuReading[] | null;
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

/** None of these commands takes longer than a few milliseconds; one that has not answered in this time is stuck. */
const READ_MS = 5_000;
/** The system's own tools, by path: a `PATH` the server inherited from a shell may name another `ps` first. */
const SYSCTL = "/usr/sbin/sysctl";
const PS = "/bin/ps";

const { failed, recovered } = failureLog();

async function ask(what: string, argv: string[]): Promise<string | null> {
	try {
		const out = await run(argv, { timeoutMs: READ_MS });
		// `sysctl` exits 1 when one of its names is unknown but still prints the others: its output is what is wanted.
		if (out.code !== 0 && out.stdout === "") throw new Error(out.stderr.trim() || `exit ${out.code}`);
		recovered(what);
		return out.stdout;
	} catch (e) {
		failed(what, e);
		return null;
	}
}

export interface SystemReaderOptions {
	platform?: string;
	gpu?: GpuOptions;
}

/**
 * The computer this server runs on. CPU time is Node's `os.cpus()` everywhere. macOS asks `sysctl` for memory and its
 * pressure (a process that costs a millisecond of CPU) and IOKit for the GPU's utilisation (`host-gpu.ts`, no process at
 * all, in a thread of its own: `host-gpu-guard.ts`): neither needs privileges. Linux reads `/proc/meminfo` and has no GPU figure (it is
 * left out); anything else has memory from `os` and nothing more.
 */
export function systemReader(options: SystemReaderOptions = {}): HostReader {
	const platform = options.platform ?? process.platform;
	const gpu = platform === "darwin" ? guardedGpu(options.gpu) : null;
	return {
		platform,
		close: () => gpu?.close(),
		async processes() {
			const out = await run([PS, "-A", "-o", "pid=,ppid=,time=,rss="], { timeoutMs: READ_MS });
			if (out.code !== 0) throw new Error(out.stderr.trim() || `ps exit ${out.code}`);
			return parsePs(out.stdout);
		},
		async read() {
			const cpu = sumCpuTimes(cpus());
			if (platform === "darwin") {
				const sysctl = await ask("sysctl", [SYSCTL, ...MAC_SYSCTL]);
				const values = sysctl === null ? null : parseSysctl(sysctl);
				const gpus = (await gpu?.read()) ?? null;
				return {
					cpu,
					memUsed: values ? memoryUsedMac(values) : null,
					memTotal: totalmem(),
					pressure: values ? pressureOf(values) : null,
					gpus,
				};
			}
			if (platform === "linux") {
				let meminfo: Meminfo | null = null;
				try {
					meminfo = parseMeminfo(await Bun.file("/proc/meminfo").text());
					recovered("meminfo");
				} catch (e) {
					failed("meminfo", e);
				}
				return {
					cpu,
					memUsed: meminfo?.used ?? null,
					memTotal: meminfo?.total ?? totalmem(),
					pressure: null,
					gpus: null,
				};
			}
			return { cpu, memUsed: totalmem() - freemem(), memTotal: totalmem(), pressure: null, gpus: null };
		},
	};
}
