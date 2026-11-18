import type { MetadataOps } from "./types.ts";

/**
 * A file's extended attributes and ACL copied onto another with `copyfile(3)` through libSystem (`COPYFILE_XATTR |
 * COPYFILE_ACL`: not its data, mode, owner or times, which the caller sets). `bun:ffi` is loaded on the first copy, not when
 * the adapter is: what reads the adapter without running on macOS never loads it.
 */

const LIBSYSTEM = "/usr/lib/libSystem.B.dylib";
const COPYFILE_ACL = 1 << 0;
const COPYFILE_XATTR = 1 << 2;

type CopyFile = (from: unknown, to: unknown, state: null, flags: number) => number;

export function macMetadata(): MetadataOps {
	let lib: Promise<{ copyfile: CopyFile; ptr: (a: ArrayBufferView) => unknown }> | undefined;
	const cString = (s: string) => Buffer.from(`${s}\0`, "utf8");
	return {
		async copyExtras(from, to) {
			lib ??= import("bun:ffi").then(({ dlopen, ptr }) => ({
				copyfile: dlopen(LIBSYSTEM, {
					copyfile: { args: ["ptr", "ptr", "ptr", "u32"], returns: "i32" },
				}).symbols.copyfile as CopyFile,
				ptr: ptr as (a: ArrayBufferView) => unknown,
			}));
			const { copyfile, ptr } = await lib;
			const a = cString(from);
			const b = cString(to);
			if (copyfile(ptr(a), ptr(b), null, COPYFILE_ACL | COPYFILE_XATTR) !== 0)
				throw new Error("copyfile of the extended attributes failed");
		},
	};
}
