import type { PlatformId } from "../../shared/platform.ts";
import { platformIdOf } from "./capabilities.ts";
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

/**
 * The system's own name for itself (`process.platform`), for what records it or downloads for it (an export's manifest,
 * omp's build target): a BSD is served by Linux's adapter, but its name stays its own.
 */
export const osName: NodeJS.Platform = process.platform;

export { capabilities, platformIdOf } from "./capabilities.ts";
export type { Platform, SystemDeps } from "./types.ts";
