import { bunMeetsMinimum, MIN_BUN } from "./bun-version.ts";

// First import of the server: an older Bun fails later, at a module that is not the cause, and only from its second start
// (see `bun-version.ts`), so it is refused here, naming the Bun that is needed.
if (typeof Bun !== "undefined" && !bunMeetsMinimum(Bun.version)) {
	console.error(
		`omp-webui needs Bun ${MIN_BUN} or newer to run from source; this is Bun ${Bun.version}. Update it with \`bun upgrade\`, or use the packaged app.`,
	);
	process.exit(1);
}
