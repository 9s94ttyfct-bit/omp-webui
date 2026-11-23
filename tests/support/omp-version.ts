import { execFileSync } from "node:child_process";
import { compareVersions, parseVersion } from "../../shared/omp-install.ts";

let installed: string | undefined;

/**
 * Whether the omp the tests run (`OMP_BIN`, else `omp`) is `version` or later; false when its version cannot be read. Asked
 * of omp once, when first needed.
 */
export function ompAtLeast(version: string): boolean {
	if (installed === undefined) {
		try {
			installed = execFileSync(process.env.OMP_BIN ?? "omp", ["--version"], { encoding: "utf8" }).trim();
		} catch {
			installed = "";
		}
	}
	return parseVersion(installed) !== null && compareVersions(installed, version) >= 0;
}

/**
 * omp 19.1.0 runs the tools it does not give the model at the top level as commands in `bash` (`<tool> -j '<json>'`); before
 * it, as `xd://<tool>` devices a `write` calls with its arguments as the content.
 */
export const runsToolCommands = (): boolean => ompAtLeast("19.1.0");

/** A call of the mounted tool `tool` with `args`, the way the omp the tests run takes one: a command, or a device's `write`. */
export function mountedCall(tool: string, args: unknown): { name: string; args: Record<string, unknown> } {
	const json = JSON.stringify(args);
	return runsToolCommands()
		? { name: "bash", args: { command: `${tool} -j '${json.replaceAll("'", "'\\''")}'` } }
		: { name: "write", args: { path: `xd://${tool}`, content: json } };
}
