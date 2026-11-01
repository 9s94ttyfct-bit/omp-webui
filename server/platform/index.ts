import type { PlatformId } from "../../shared/platform.ts";
import { createDarwin } from "./darwin.ts";
import { createLinux } from "./linux.ts";
import { systemDeps } from "./system.ts";
import type { Platform, SystemDeps } from "./types.ts";
import { createWin32 } from "./win32.ts";

/**
 * The operating system, as the server asks it (see `types.ts`). One module per system: `darwin.ts` and `linux.ts` (with
 * what they share in `posix.ts`) and `win32.ts`. Everything outside `server/platform/` asks `platform`, and consults
 * `platform.capabilities` where a feature is not there on every system; scripts/check-platform.ts keeps it that way.
 */

const CREATE: Record<PlatformId, (deps: SystemDeps) => Platform> = {
	darwin: createDarwin,
	linux: createLinux,
	win32: createWin32,
};

/** `process.platform` as an adapter's name: a POSIX system without one of its own (a BSD) gets Linux's. */
export function platformIdOf(name: string): PlatformId {
	return name === "darwin" || name === "win32" ? name : "linux";
}

const made: Partial<Record<PlatformId, Platform>> = {};

/**
 * The adapter of `id` over `deps` (the real system for whatever a test does not hand in). Adapters over the real system
 * are made once each: a test that asks for another system's adapter reads that system's rules (its capabilities, its
 * argument lists), and runs its commands only where it calls them.
 */
export function platformFor(id: PlatformId, deps?: Partial<SystemDeps>): Platform {
	if (deps) return CREATE[id]({ ...systemDeps, ...deps });
	made[id] ??= CREATE[id](systemDeps);
	return made[id];
}

/** The system this server runs on. */
export const platform: Platform = platformFor(platformIdOf(process.platform));

export type { Platform, SystemDeps } from "./types.ts";
