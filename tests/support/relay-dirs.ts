import { rmSync } from "node:fs";
import { relayDirPath } from "../../server/omp/relay-client.ts";

/**
 * Relay directories a test run leaves behind. A data dir too deep for a socket path keeps its relays in a short
 * directory in /tmp (see `relayDirPath`), which no removal of the data dir reaches.
 */

const dataDirs = new Set<string>();

/** Remove `dataDir`'s relay directory, and whatever is left in it. */
export function removeRelayDir(dataDir: string): void {
	rmSync(relayDirPath(dataDir), { recursive: true, force: true });
}

/** A test used `dataDir` for a server or a pool: its relay directory is removed when the test run ends (see preload.ts). */
export function trackRelayDir(dataDir: string): void {
	dataDirs.add(dataDir);
}

/** Remove every relay directory a test has tracked: its servers and relays are gone by the end of the run. */
export function removeTrackedRelayDirs(): void {
	for (const dir of dataDirs) removeRelayDir(dir);
	dataDirs.clear();
}
