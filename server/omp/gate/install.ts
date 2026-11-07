import { join } from "node:path";
import { installFiles } from "../extension-files.ts";
import { source } from "../source-macro.ts" with { type: "macro" };

/**
 * Put the gate (`extension.ts`) where omp can read it: omp loads an extension from a file, and the compiled server holds
 * its sources inside itself. The files are written under `<data dir>/gate/` in the layout they have in the source tree,
 * so the gate's imports resolve the same way in both. A file is written again only when it differs (an update changes
 * it; a process started before keeps the copy it loaded).
 */
const FILES: Readonly<Record<string, string>> = {
	"server/omp/gate/extension.ts": source("server/omp/gate/extension.ts"),
	"server/omp/gate/review.ts": source("server/omp/gate/review.ts"),
	"shared/remote-risk.ts": source("shared/remote-risk.ts"),
	"shared/risk-confirm.ts": source("shared/risk-confirm.ts"),
	"shared/guard.ts": source("shared/guard.ts"),
	"shared/guard-policy.ts": source("shared/guard-policy.ts"),
	"shared/advisor.ts": source("shared/advisor.ts"),
};

/** The folder the gate lives in, and the file omp is given (`--extension`). */
export function gatePaths(dataDir: string): { dir: string; extension: string } {
	const dir = join(dataDir, "gate");
	return { dir, extension: join(dir, "server/omp/gate/extension.ts") };
}

/** Write the gate's files under `dataDir`; the answer is the extension's path. Throws when they cannot be written. */
export function installGate(dataDir: string): string {
	const { dir, extension } = gatePaths(dataDir);
	installFiles(dir, FILES);
	return extension;
}
