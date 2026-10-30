import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The agent directories of offline processes (`<data dir>/offline-agent/<revision>`, one for each configuration an
 * offline process was started with), as a test looks at them. A revision is a digest, so which one a test wants is
 * the newest: the one the last plan used.
 */

const REVISION = /^[0-9a-f]{16}$/;

/** Every revision directory under `root`, newest use first. */
export function offlineAgents(root: string): string[] {
	return readdirSync(root)
		.filter((name) => REVISION.test(name))
		.map((name) => join(root, name))
		.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

/** The directory the newest offline process was started in. */
export function newestOfflineAgent(root: string): string {
	const [newest] = offlineAgents(root);
	if (!newest) throw new Error(`no offline agent directory under ${root}`);
	return newest;
}
