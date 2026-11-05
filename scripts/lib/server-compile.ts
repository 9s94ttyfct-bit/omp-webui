import { join } from "node:path";

/**
 * The workers the server starts by URLs relative to its own modules (`new Worker(new URL("./family-worker.ts", import.meta.url))`):
 * a compiled program has no files beside it to start them from, so each has to be an entry point of its own. A worker that is
 * missing here is found missing only when the program built without it starts it (tests/unit/server-compile.test.ts checks the list
 * against the server's `new Worker` calls).
 */
export const SERVER_WORKERS = ["family-worker.ts", "search-index-worker.ts", "host-gpu-worker.ts"] as const;

/**
 * The `bun build` command that compiles the server into one program, the same for every package: `entry` (server/main.ts in the
 * macOS app, server/launcher.ts in the Windows and Linux launchers) with the server's workers, for `target`, written to `outfile`;
 * `flags` are the package's own (its icon, its version). Run it from a staging folder: `bun build --compile` leaves a
 * `.*.bun-build` temp file in its cwd.
 */
export function serverCompileArgv(
	root: string,
	opts: { entry: string; target: string; outfile: string; flags?: readonly string[] },
): string[] {
	return [
		"bun",
		"build",
		"--compile",
		"--minify",
		`--target=${opts.target}`,
		...(opts.flags ?? []),
		join(root, "server", opts.entry),
		...SERVER_WORKERS.map((worker) => join(root, "server", worker)),
		"--outfile",
		opts.outfile,
	];
}
