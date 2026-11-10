import { isMacPhysical, type NetCounters, parseIfmib } from "../host-parse.ts";

/**
 * The byte counters of macOS's network interfaces, asked of the kernel with `sysctl(3)` through libSystem: no process is
 * started (a look is a few dozen system calls, about 30 µs on an M4 Pro), and none of it blocks, so it runs on the
 * server's own thread. The interfaces are numbered from 1 to `net.link.generic.system.ifcount`; each one's
 * `struct ifmibdata` (`net.link.generic.ifdata.<n>.general`) holds its name and its 64-bit byte counters, read by
 * `parseIfmib` (host-parse.ts, where the layout is). A number no interface has now (one that went away) is skipped.
 *
 * `bun:ffi` is loaded on the first look, not when the adapter is: what reads the adapter without running on macOS (Linux's
 * server, a test runner that is not Bun) never loads it.
 */

const LIBSYSTEM = "/usr/lib/libSystem.B.dylib";
const CTL_NET = 4;
const PF_LINK = 18;
const NETLINK_GENERIC = 0;
const IFMIB_SYSTEM = 1;
const IFMIB_IFCOUNT = 1;
const IFMIB_IFDATA = 2;
const IFDATA_GENERAL = 1;
/** Room for one `ifmibdata` (180 bytes on macOS 27) and more: a larger one fails the call rather than being cut. */
const IFMIB_ROOM = 512;

type Sysctl = (name: unknown, namelen: number, oldp: unknown, oldlenp: unknown, newp: null, newlen: number) => number;

/** What reads the counters of the `en` interfaces (`isMacPhysical`); it rejects when libSystem cannot be loaded or asked. */
export function macNetBytes(): () => Promise<NetCounters> {
	let lib: Promise<{ sysctl: Sysctl; ptr: (a: ArrayBufferView) => unknown }> | undefined;
	const count = new Uint32Array(1);
	const countMib = new Int32Array([CTL_NET, PF_LINK, NETLINK_GENERIC, IFMIB_SYSTEM, IFMIB_IFCOUNT]);
	const dataMib = new Int32Array([CTL_NET, PF_LINK, NETLINK_GENERIC, IFMIB_IFDATA, 0, IFDATA_GENERAL]);
	const data = new Uint8Array(IFMIB_ROOM);
	const len = new BigUint64Array(1);
	return async () => {
		lib ??= import("bun:ffi").then(({ dlopen, ptr }) => ({
			sysctl: dlopen(LIBSYSTEM, {
				sysctl: { args: ["ptr", "u32", "ptr", "ptr", "ptr", "u64"], returns: "i32" },
			}).symbols.sysctl as Sysctl,
			ptr: ptr as (a: ArrayBufferView) => unknown,
		}));
		const { sysctl, ptr } = await lib;
		len[0] = BigInt(count.byteLength);
		if (sysctl(ptr(countMib), countMib.length, ptr(count), ptr(len), null, 0) !== 0)
			throw new Error("sysctl net.link.generic.system.ifcount failed");
		const out = new Map<string, { rx: number; tx: number }>();
		for (let n = 1; n <= (count[0] as number); n++) {
			dataMib[4] = n;
			len[0] = BigInt(data.byteLength);
			if (sysctl(ptr(dataMib), dataMib.length, ptr(data), ptr(len), null, 0) !== 0) continue;
			const one = parseIfmib(data.subarray(0, Math.min(data.byteLength, Number(len[0]))));
			if (one && isMacPhysical(one.name)) out.set(one.name, { rx: one.rx, tx: one.tx });
		}
		return out;
	};
}
