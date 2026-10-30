import { dlopen, type Pointer, ptr } from "bun:ffi";

/** What a `ptr` of the libraries is, as Bun types it: an address that is handed back to them and never read here. */
type Handle = bigint | Pointer | null;

/** One accelerator's look. */
export interface GpuReading {
	name: string | null;
	cores: number | null;
	/** The accelerator's device utilisation, 0–100. */
	util: number;
}

/**
 * The GPU's utilisation on macOS, read from IOKit the way `ioreg` does but without starting it: every accelerator in the
 * I/O Registry (`IOAccelerator`: an Apple Silicon Mac has one; an Intel one has its integrated GPU and perhaps a discrete
 * or an external one) keeps a `PerformanceStatistics` dictionary, and in it `Device Utilization %` (Apple's, Intel's and
 * AMD's drivers) or, for some AMD drivers, `GPU Activity(%)`. No privileges are needed.
 *
 * Why not `ioreg -r -d 1 -w 0 -c IOAccelerator`: it serialises every property of the accelerator in the kernel, which is
 * 15 ms of CPU a time (measured, Apple M4 Pro, macOS 27) for one number; asking IOKit for the one property is 25 µs.
 * Looking every few seconds, that is the difference between 0.5 % of a core and nothing.
 *
 * Called from `host-gpu-worker.ts`, a thread of its own: IOKit is synchronous, and a driver that does not come back must
 * not hold the server's thread (`host-gpu-guard.ts` waits for it with a deadline).
 *
 * What is called is IOKit's and CoreFoundation's stable C API, with every object checked for the type it is read as before
 * it is read, and released after. A pointer is never dereferenced here, only handed back to the library that gave it.
 */

export interface GpuProbe {
	/** Every accelerator that reports a utilisation, one reading each; an empty list when none does. */
	read(): GpuReading[];
}

const IOKIT = "/System/Library/Frameworks/IOKit.framework/IOKit";
const CORE_FOUNDATION = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
const UTF8 = 0x08000100;
/** `kCFNumberSInt64Type`. */
const SINT64 = 4;
/** A GPU's name is a few words; this is room for far more. */
const NAME_BYTES = 256;

/** IOKit's and CoreFoundation's functions this reads with; null when this is not macOS or they cannot be loaded. */
function loadLibraries() {
	if (process.platform !== "darwin") return null;
	try {
		return {
			io: dlopen(IOKIT, {
				IOServiceMatching: { args: ["ptr"], returns: "ptr" },
				IOServiceGetMatchingServices: { args: ["u32", "ptr", "ptr"], returns: "i32" },
				IOIteratorNext: { args: ["u32"], returns: "u32" },
				IORegistryEntryCreateCFProperty: { args: ["u32", "ptr", "ptr", "u32"], returns: "ptr" },
				IOObjectRelease: { args: ["u32"], returns: "i32" },
			}).symbols,
			cf: dlopen(CORE_FOUNDATION, {
				CFStringCreateWithCString: { args: ["ptr", "ptr", "u32"], returns: "ptr" },
				CFDictionaryGetValue: { args: ["ptr", "ptr"], returns: "ptr" },
				CFNumberGetValue: { args: ["ptr", "i32", "ptr"], returns: "bool" },
				CFStringGetCString: { args: ["ptr", "ptr", "i64", "u32"], returns: "bool" },
				CFGetTypeID: { args: ["ptr"], returns: "u64" },
				CFDictionaryGetTypeID: { args: [], returns: "u64" },
				CFNumberGetTypeID: { args: [], returns: "u64" },
				CFStringGetTypeID: { args: [], returns: "u64" },
				CFRelease: { args: ["ptr"], returns: "void" },
			}).symbols,
		};
	} catch {
		return null;
	}
}

/** The probe, or null when this is not macOS or the frameworks cannot be loaded (no figure, then: not an error). */
export function openGpuProbe(): GpuProbe | null {
	const libraries = loadLibraries();
	if (!libraries) return null;
	const { io, cf } = libraries;
	/** The C strings handed to the library: held here, so that the collector cannot free one while the library reads it. */
	const held: Buffer[] = [];
	const cfString = (s: string) => {
		const bytes = Buffer.from(`${s}\0`);
		held.push(bytes);
		return cf.CFStringCreateWithCString(null, ptr(bytes), UTF8);
	};
	// CF strings kept for the life of the process: five small keys.
	const keys = {
		stats: cfString("PerformanceStatistics"),
		util: cfString("Device Utilization %"),
		activity: cfString("GPU Activity(%)"),
		model: cfString("model"),
		cores: cfString("gpu-core-count"),
	};
	const dictionary = cf.CFDictionaryGetTypeID();
	const number = cf.CFNumberGetTypeID();
	const string = cf.CFStringGetTypeID();
	const className = Buffer.from("IOAccelerator\0");
	const iterator = new Uint32Array(1);
	const out = new BigInt64Array(1);
	const name = Buffer.alloc(NAME_BYTES);

	/** `value` (not owned) as an integer; null when it is not a number. */
	const integer = (value: Handle): number | null =>
		value && cf.CFGetTypeID(value) === number && cf.CFNumberGetValue(value, SINT64, ptr(out)) ? Number(out[0]) : null;

	/** The property `key` of the registry entry `service` as a CF object the caller releases, or null. */
	const property = (service: number, key: Handle) => io.IORegistryEntryCreateCFProperty(service, key, null, 0);

	const reading = (service: number): GpuReading | null => {
		const stats = property(service, keys.stats);
		if (!stats) return null;
		let util: number | null = null;
		try {
			if (cf.CFGetTypeID(stats) !== dictionary) return null;
			util =
				integer(cf.CFDictionaryGetValue(stats, keys.util)) ?? integer(cf.CFDictionaryGetValue(stats, keys.activity));
		} finally {
			cf.CFRelease(stats);
		}
		if (util === null) return null;
		let label: string | null = null;
		const model = property(service, keys.model);
		if (model) {
			try {
				if (cf.CFGetTypeID(model) === string && cf.CFStringGetCString(model, ptr(name), NAME_BYTES, UTF8)) {
					label = name.toString("utf8", 0, name.indexOf(0)) || null;
				}
			} finally {
				cf.CFRelease(model);
			}
		}
		let cores: number | null = null;
		const count = property(service, keys.cores);
		if (count) {
			try {
				cores = integer(count);
			} finally {
				cf.CFRelease(count);
			}
		}
		return { name: label, cores, util: Math.min(100, Math.max(0, util)) };
	};

	return {
		read() {
			// The matching dictionary is consumed by the call that takes it.
			const matching = io.IOServiceMatching(ptr(className));
			if (!matching || io.IOServiceGetMatchingServices(0, matching, ptr(iterator)) !== 0) return [];
			const found = iterator[0] as number;
			const gpus: GpuReading[] = [];
			try {
				for (let service = io.IOIteratorNext(found); service !== 0; service = io.IOIteratorNext(found)) {
					try {
						const gpu = reading(service);
						if (gpu) gpus.push(gpu);
					} finally {
						io.IOObjectRelease(service);
					}
				}
			} finally {
				io.IOObjectRelease(found);
			}
			return gpus;
		},
	};
}
